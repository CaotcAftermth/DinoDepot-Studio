import { useMemo, useState } from "react";
import { useProjectStore } from "../stores/projectStore";
import { mapList } from "../model/maps";
import {
  cleanSlateFileName,
  cleanSlateFor,
  newPlayer,
  type CleanSlate,
  type Player,
  playerLabel,
  type PlayersFile,
} from "../model/players";
import {
  applyProfileEdits,
  isValidEosId,
  packageForMap,
  profileFileNameFor,
  readProfileSummary,
  type ProfileEdits,
  type ProfileSummary,
} from "../model/profileData";
import { newId } from "../model/ids";
import {
  parseArkProfile,
  serializeArkProfile,
  type ArkProfile,
} from "../serializers/arkprofile";
import {
  base64ToBytes,
  bytesToBase64,
  profileStorageKey,
  storedProfileFor,
} from "../services/profileImport";
import { ipc, isTauri } from "../services/ipc";
import { readProfilePath } from "../services/profileFiles";
import { pickFile } from "../services/dialogs";
import { toast } from "./toast";
import { Badge, Button, Card, cx, Field, Input, Modal, Select } from "./ui";

/**
 * Builds a replacement `.arkprofile` for a player whose file was lost.
 *
 * This is scaffolding over genuinely uncharted ground: the format is only
 * partly understood, so nothing here writes a profile from nothing. It starts
 * from a real profile the game produced and rewrites the fields that are
 * mapped out, leaving every unmapped byte exactly as the game wrote it. That
 * is the difference between a file the server accepts and a plausible-looking
 * one it rejects — and it is why the template picker is step one rather than
 * an option.
 */

const PROFILE_FILTERS = [{ name: "ARK profile", extensions: ["arkprofile"] }];

interface Draft {
  accountName: string;
  characterName: string;
  playerDataId: string;
  eosId: string;
  tribeId: string;
  level: string;
  experience: string;
  engramPoints: string;
  explorerNotes: string;
  ascension: string;
  map: string;
  skillTrees: Record<string, { level: string; index: string }>;
  clearNetworkAddress: boolean;
}

function draftFromSummary(summary: ProfileSummary): Draft {
  return {
    accountName: summary.accountName,
    characterName: summary.characterName,
    playerDataId: summary.playerDataId,
    eosId: summary.eosId,
    tribeId: summary.tribeId,
    level: String(summary.level),
    // One decimal, and written back at the same precision — rounding harder
    // would show up as an edit to a field the admin never touched.
    experience: String(Math.round(summary.experience * 10) / 10),
    engramPoints: String(summary.engramPoints),
    explorerNotes: String(summary.explorerNotes),
    ascension: summary.ascension === null ? "" : String(summary.ascension),
    map: summary.map,
    skillTrees: Object.fromEntries(
      summary.skillTrees.map((t) => [
        t.name,
        { level: String(t.level), index: String(t.index) },
      ]),
    ),
    clearNetworkAddress: true,
  };
}

/** The draft as edits, so the preview and the write always agree. */
function editsFrom(draft: Draft, template: ProfileSummary): ProfileEdits {
  const targetPackage = packageForMap(draft.map);
  return {
    accountName: draft.accountName,
    characterName: draft.characterName,
    playerDataId: draft.playerDataId,
    eosId: isValidEosId(draft.eosId) ? draft.eosId : undefined,
    tribeId: draft.tribeId,
    extraLevel: Math.max(0, (Number(draft.level) || 1) - 1),
    experience: Number(draft.experience) || 0,
    engramPoints: Number(draft.engramPoints) || 0,
    explorerNotes: Number(draft.explorerNotes) || 0,
    // A rebuilt survivor gets their level but none of the template's
    // allocation — the player spends the points themselves in game.
    clearStatPoints: true,
    skillTrees: Object.fromEntries(
      Object.entries(draft.skillTrees).map(([name, v]) => [
        name,
        { level: Number(v.level) || 0, index: Number(v.index) || 0 },
      ]),
    ),
    // Only written when the template carries an ascension field at all; when
    // it does not, `applyProfileEdits` reports it as skipped rather than
    // inventing one.
    ascension: draft.ascension.trim() ? Number(draft.ascension) || 0 : undefined,
    // Only retarget when it actually differs — a no-op rewrite of the level
    // names is a change worth not making.
    mapPackage:
      targetPackage && targetPackage !== template.mapPackage ? targetPackage : undefined,
    clearNetworkAddress: draft.clearNetworkAddress,
  };
}

export function CreateProfileModal({
  playersFile,
  onClose,
  onCreated,
  onCleanSlates,
}: {
  playersFile: PlayersFile;
  onClose: () => void;
  /** Hands back the roster the generated profile belongs to. */
  onCreated: (players: Player[], playerId: string) => void;
  /** Hands back the clean-slate list after one is registered. */
  onCleanSlates: (slates: CleanSlate[]) => void;
}) {
  const players = playersFile.players;
  const dir = useProjectStore((s) => s.dir);
  const settings = useProjectStore((s) => s.settings);

  const [template, setTemplate] = useState<{
    profile: ArkProfile;
    summary: ProfileSummary;
    source: string;
  } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [targetId, setTargetId] = useState("new");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const withProfiles = players.filter((p) => p.profile && p.profile.fileName);
  const slates = playersFile.cleanSlates.filter((s) => s.fileName);

  /** Loads a registered clean slate as the template. */
  async function loadCleanSlate(map: string) {
    const slate = cleanSlateFor(playersFile, map);
    if (!slate || !dir) return;
    setLoading(true);
    try {
      const b64 = await ipc<string>("read_player_profile_b64", {
        dir,
        fileName: slate.fileName,
      });
      useTemplate(base64ToBytes(b64), `Clean slate · ${slate.map}`);
    } catch (e) {
      toast.error(`Could not read that clean slate: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }

  /** Registers a file on disk as the clean slate for its own map. */
  async function addCleanSlate() {
    const path = await pickFile(
      "Choose a fresh-spawn profile to keep as a clean slate",
      PROFILE_FILTERS,
    );
    if (!path || !dir) return;
    setLoading(true);
    try {
      const file = await readProfilePath(path);
      const summary = readProfileSummary(parseArkProfile(file.bytes));
      const map = summary.map || summary.mapPackage;
      if (!map) {
        toast.error("That profile does not say which map it came from");
        return;
      }
      if (summary.spentPoints > 0) {
        // Worth saying, not worth blocking: an admin may have reasons.
        toast.error(
          `Heads up: that profile has ${summary.spentPoints} stat points already spent`,
        );
      }
      const info = await ipc<{ fileName: string }>("store_player_profile_b64", {
        dir,
        playerId: cleanSlateFileName(map),
        contentB64: bytesToBase64(file.bytes),
      });
      onCleanSlates([
        ...playersFile.cleanSlates.filter(
          (s) => s.map.toLowerCase() !== map.toLowerCase(),
        ),
        { map, fileName: info.fileName, addedAt: new Date().toISOString(), summary },
      ]);
      useTemplate(file.bytes, `Clean slate · ${map}`);
      toast.success(`Clean slate saved for ${map}`);
    } catch (e) {
      toast.error(`Could not read that file: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }

  function useTemplate(bytes: Uint8Array, source: string) {
    try {
      const profile = parseArkProfile(bytes);
      const summary = readProfileSummary(profile);
      setTemplate({ profile, summary, source });
      setDraft(draftFromSummary(summary));
    } catch (e) {
      toast.error(
        `That file could not be read as a profile: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function loadFromRoster(playerId: string) {
    const player = players.find((p) => p.id === playerId);
    if (!player?.profile || !dir) return;
    setLoading(true);
    try {
      const b64 = await ipc<string>("read_player_profile_b64", {
        dir,
        fileName: player.profile.fileName,
      });
      useTemplate(base64ToBytes(b64), `${playerLabel(player)}'s stored profile`);
    } catch (e) {
      toast.error(`Could not read that profile: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadFromDisk() {
    const path = await pickFile("Choose a profile to use as the template", PROFILE_FILTERS);
    if (!path) return;
    setLoading(true);
    try {
      const file = await readProfilePath(path);
      useTemplate(file.bytes, file.fileName);
    } catch (e) {
      toast.error(`Could not read that file: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoading(false);
    }
  }

  const preview = useMemo(() => {
    if (!template || !draft) return null;
    return applyProfileEdits(template.profile, editsFrom(draft, template.summary));
  }, [template, draft]);

  const eosOk = Boolean(draft && isValidEosId(draft.eosId));
  const levelPoints = Math.max(0, (Number(draft?.level) || 1) - 1);
  /** How many note bits this map's profile actually has room for. */
  const noteCapacity = (template?.summary.noteCapacity ?? 0) * 32;
  const ascensionAvailable = template?.summary.ascension !== null;

  async function create() {
    if (!draft || !preview || !dir) return;
    setSaving(true);
    try {
      const bytes = serializeArkProfile(preview.profile);
      // Read back what was actually written rather than trusting the draft —
      // if an edit did not land, the roster must not claim it did.
      const summary = readProfileSummary(parseArkProfile(bytes));

      const target =
        players.find((p) => p.id === targetId) ??
        ({ ...newPlayer(newId()), gameName: draft.characterName } as Player);

      const info = await ipc<{ fileName: string }>("store_player_profile_b64", {
        dir,
        playerId: profileStorageKey(target, summary),
        contentB64: bytesToBase64(bytes),
      });

      // Replacing an existing player's profile can land on a different name,
      // which would leave the old file behind with nothing pointing at it.
      const superseded = target.profile?.fileName;
      if (superseded && superseded !== info.fileName) {
        await ipc("delete_player_profile", { dir, fileName: superseded }).catch(() => {
          /* the record moves on either way */
        });
      }

      const updated: Player = {
        ...target,
        accountName: target.accountName || summary.accountName,
        gameName: target.gameName || summary.characterName,
        playerId: target.playerId || summary.playerDataId,
        eosId: target.eosId || summary.eosId,
        profile: storedProfileFor(summary, info.fileName, new Date(), true),
      };

      const roster = players.some((p) => p.id === updated.id)
        ? players.map((p) => (p.id === updated.id ? updated : p))
        : [...players, updated];

      onCreated(roster, updated.id);
      toast.success(
        `Profile created — copy it to the server as ${profileFileNameFor(summary.eosId)}`,
      );
      onClose();
    } catch (e) {
      toast.error(`Could not create the profile: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Create a player profile" onClose={onClose} xl>
      <p className="text-sm text-ink-300 mb-4">
        Rebuilds a lost <span className="mono">.arkprofile</span> from one the
        game produced. Identity and progression are rewritten; everything else —
        appearance, engrams, explorer notes, the parts of this format nobody has
        mapped out — is inherited from the template byte for byte.
      </p>

      {!template ? (
        <Card title="1 · Choose a template">
          <p className="text-sm text-ink-300 mb-3">
            A clean slate is the right starting point for a rebuild: a fresh
            spawn with nothing spent, so the player levels and assigns their own
            points. Any other profile from the same map works too, but whatever
            it carries — engrams, appearance, notes — carries into the new one.
          </p>

          <div className="rounded-lg border border-ink-700 bg-ink-850 p-3 mb-3">
            <div className="flex items-center justify-between gap-3 mb-2">
              <span className="text-xs font-semibold text-ink-200 uppercase tracking-wide">
                Clean slate
              </span>
              <Button onClick={addCleanSlate} disabled={!isTauri || loading}>
                {slates.length > 0 ? "Add another map…" : "Register one…"}
              </Button>
            </div>
            {slates.length === 0 ? (
              <p className="text-xs text-ink-400">
                None registered yet. Make a fresh character on each map, take its
                profile, and register it here — it becomes the one-click starting
                point for every rebuild on that map.
              </p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {slates.map((slate) => (
                  <button
                    key={slate.map}
                    onClick={() => loadCleanSlate(slate.map)}
                    disabled={loading}
                    className={cx(
                      "text-left px-3 py-2 rounded-md border cursor-pointer",
                      "bg-ink-900 border-ink-700 hover:border-accent-500/60",
                    )}
                  >
                    <span className="text-sm text-ink-100">{slate.map}</span>
                    {slate.summary && (
                      <span className="text-xs text-ink-400 ml-2">
                        level {slate.summary.level} · {slate.summary.engramsLearned}{" "}
                        engrams · {slate.summary.spentPoints} points spent
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-end gap-2">
            <Field label="Or start from an existing profile" className="flex-1">
              <Select
                value=""
                disabled={loading || withProfiles.length === 0}
                onChange={(e) => e.target.value && loadFromRoster(e.target.value)}
              >
                <option value="">
                  {withProfiles.length === 0
                    ? "No stored profiles yet"
                    : "Use a stored profile…"}
                </option>
                {withProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {playerLabel(p)}
                    {p.profile?.map ? ` · ${p.profile.map}` : ""}
                    {p.profile?.summary ? ` · level ${p.profile.summary.level}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Button onClick={loadFromDisk} disabled={!isTauri || loading}>
              Choose a file…
            </Button>
          </div>
          {!isTauri && (
            <p className="text-xs text-amber-400 mt-3">
              Reading a template file from disk needs the desktop app — a profile
              already in the roster works here.
            </p>
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-4">
          <div className="flex flex-col gap-4">
            <Card
              title="2 · Identity"
              actions={
                <Button
                  variant="ghost"
                  onClick={() => {
                    setTemplate(null);
                    setDraft(null);
                  }}
                >
                  Change template
                </Button>
              }
            >
              <div className="grid grid-cols-2 gap-3">
                <Field
                  label="EOS ID"
                  hint={
                    eosOk
                      ? `File will be named ${profileFileNameFor(draft!.eosId)}`
                      : "32 hex characters — the game finds a profile by this"
                  }
                >
                  <Input
                    className={cx("mono", !eosOk && "border-danger/60")}
                    value={draft!.eosId}
                    onChange={(e) => setDraft({ ...draft!, eosId: e.target.value })}
                    placeholder="0002abcd…"
                  />
                </Field>
                <Field label="Player ID" hint="The number ListPlayers reports">
                  <Input
                    className="mono"
                    value={draft!.playerDataId}
                    onChange={(e) => setDraft({ ...draft!, playerDataId: e.target.value })}
                  />
                </Field>
                <Field label="Account name" hint="Platform name, not the survivor's">
                  <Input
                    value={draft!.accountName}
                    onChange={(e) => setDraft({ ...draft!, accountName: e.target.value })}
                  />
                </Field>
                <Field label="Character name" hint="In-game survivor name">
                  <Input
                    value={draft!.characterName}
                    onChange={(e) => setDraft({ ...draft!, characterName: e.target.value })}
                  />
                </Field>
                <Field label="Tribe ID" hint="0 leaves them tribeless">
                  <Input
                    className="mono"
                    value={draft!.tribeId}
                    onChange={(e) => setDraft({ ...draft!, tribeId: e.target.value })}
                  />
                </Field>
                <Field label="Map" hint="Retargets the save's level references">
                  <Select
                    value={draft!.map}
                    onChange={(e) => setDraft({ ...draft!, map: e.target.value })}
                  >
                    {mapList(settings).map((m) => (
                      <option key={m.name} value={m.name}>
                        {m.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </Card>

            <Card title="3 · Progression">
              <div className="grid grid-cols-3 gap-3">
                <Field label="Level">
                  <Input
                    value={draft!.level}
                    onChange={(e) => setDraft({ ...draft!, level: e.target.value })}
                  />
                </Field>
                <Field label="Experience">
                  <Input
                    value={draft!.experience}
                    onChange={(e) => setDraft({ ...draft!, experience: e.target.value })}
                  />
                </Field>
                <Field label="Engram points">
                  <Input
                    value={draft!.engramPoints}
                    onChange={(e) => setDraft({ ...draft!, engramPoints: e.target.value })}
                  />
                </Field>
              </div>

              <p className="text-xs text-ink-400 mt-3">
                All {levelPoints} of this level's stat points are left unspent,
                so the player assigns their own build in game.
              </p>

              <div className="grid grid-cols-3 gap-3 mt-4">
                <Field
                  label="Explorer notes"
                  hint={`0 – ${noteCapacity} on this map`}
                >
                  <Input
                    value={draft!.explorerNotes}
                    onChange={(e) =>
                      setDraft({ ...draft!, explorerNotes: e.target.value })
                    }
                  />
                </Field>
                <Field
                  label="Ascensions"
                  hint={
                    ascensionAvailable
                      ? `Stored as ${template.summary.ascensionProp}`
                      : "Not present in this template"
                  }
                >
                  <Input
                    value={draft!.ascension}
                    disabled={!ascensionAvailable}
                    placeholder={ascensionAvailable ? "" : "unavailable"}
                    onChange={(e) => setDraft({ ...draft!, ascension: e.target.value })}
                  />
                </Field>
              </div>
              <p className="text-xs text-ink-400 mt-1">
                Note unlocks are one bit per note and nobody has mapped which bit
                is which, so this sets the count, not the specific notes.
              </p>
            </Card>

            {template.summary.skillTrees.length > 0 && (
              <Card title="4 · Skill trees">
                <p className="text-sm text-ink-300 mb-3">
                  Each tree stores two numbers the game calls Level and Index.
                  What they mean is not documented — these are the template's
                  values, to adjust and test against a live server.
                </p>
                <div className="flex flex-col gap-2">
                  {template.summary.skillTrees.map((tree) => (
                    <div key={tree.name} className="flex items-center gap-3">
                      <span className="text-sm text-ink-200 w-32 truncate" title={tree.name}>
                        {tree.name}
                      </span>
                      <label className="flex items-center gap-1.5">
                        <span className="text-xs text-ink-400">Level</span>
                        <Input
                          className="w-16 text-center"
                          value={draft!.skillTrees[tree.name]?.level ?? "0"}
                          onChange={(e) =>
                            setDraft({
                              ...draft!,
                              skillTrees: {
                                ...draft!.skillTrees,
                                [tree.name]: {
                                  level: e.target.value,
                                  index: draft!.skillTrees[tree.name]?.index ?? "0",
                                },
                              },
                            })
                          }
                        />
                      </label>
                      <label className="flex items-center gap-1.5">
                        <span className="text-xs text-ink-400">Index</span>
                        <Input
                          className="w-16 text-center"
                          value={draft!.skillTrees[tree.name]?.index ?? "0"}
                          onChange={(e) =>
                            setDraft({
                              ...draft!,
                              skillTrees: {
                                ...draft!.skillTrees,
                                [tree.name]: {
                                  level: draft!.skillTrees[tree.name]?.level ?? "0",
                                  index: e.target.value,
                                },
                              },
                            })
                          }
                        />
                      </label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-ink-400 mt-3">
                  The template's {template.summary.completedMilestones} completed
                  milestones carry over as they are — which specific milestones a
                  survivor has done is a list of names, not a number, so it is not
                  something this can synthesise.
                </p>
              </Card>
            )}
          </div>

          <div className="flex flex-col gap-4">
            <Card title="Template">
              <p className="text-sm text-ink-200 truncate" title={template.source}>
                {template.source}
              </p>
              <p className="text-xs text-ink-400 mt-1">
                {template.summary.map || template.summary.mapPackage || "unknown map"} ·
                level {template.summary.level} · {template.summary.engramsLearned} engrams
              </p>
              <p className="text-xs text-ink-400 mt-2">
                The template's engrams, appearance and unlocked notes carry over
                to the new profile as they are.
              </p>
            </Card>

            <Card title="What will change">
              {preview && preview.changes.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {preview.changes.map((change) => (
                    <li key={change.field} className="text-xs">
                      <span className="text-ink-300">{change.field}</span>
                      <div className="flex items-baseline gap-1.5 mono">
                        <span className="text-ink-500 line-through truncate max-w-[110px]">
                          {change.from || "—"}
                        </span>
                        <span className="text-ink-500">→</span>
                        <span className="text-accent-400 truncate max-w-[110px]">
                          {change.to || "—"}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-ink-400">
                  Nothing yet — the draft still matches the template.
                </p>
              )}
              {preview && preview.skipped.length > 0 && (
                <p className="text-xs text-amber-400 mt-3">
                  Not in this template, so left out: {preview.skipped.join(", ")}.
                  Pick a template that has these fields if they matter.
                </p>
              )}
            </Card>

            <Card title="Attach to">
              <Select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
                <option value="new">A new roster entry</option>
                {players.map((p) => (
                  <option key={p.id} value={p.id}>
                    {playerLabel(p)}
                    {p.profile ? " · replaces stored profile" : ""}
                  </option>
                ))}
              </Select>
              <div className="mt-3 flex items-center gap-2">
                <Badge tone="warn">Experimental</Badge>
                <span className="text-xs text-ink-400">Test before going live</span>
              </div>
              <p className="text-xs text-ink-400 mt-2">
                Stop the server, drop the file into{" "}
                <span className="mono">
                  {/* The folder on disk carries the package name, not the
                      friendly one — sending an admin to "Scorched Earth/"
                      would send them to a folder that does not exist. */}
                  ShooterGame/Saved/SavedArks/
                  {packageForMap(draft!.map) || template.summary.mapPackage || "…"}/
                </span>{" "}
                and keep the old one until the player has logged in
                successfully.
              </p>
            </Card>

            <Button
              variant="primary"
              onClick={create}
              disabled={saving || !eosOk || !dir}
              title={eosOk ? undefined : "A valid EOS ID is required"}
            >
              {saving ? "Creating…" : "Create profile"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
