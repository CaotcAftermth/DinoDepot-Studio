import { Fragment, useEffect, useMemo, useState } from "react";
import { useDraftsStore } from "../stores/draftsStore";
import { useGithubConfig, useProjectStore } from "../stores/projectStore";
import { newId } from "../model/ids";
import {
  comparePlayers,
  hasPlayerDetails,
  newPlayer,
  Player,
  playerLabel,
  playerMatches,
  profileIsBroken,
  rosterMaps,
  PLAYER_FIELDS,
  PLAYER_ROWS,
  type StoredProfile,
} from "../model/players";
import { mapList, mapStyle } from "../model/maps";
import {
  defaultPlayerDataSettings,
  profileAgeDays,
  profileIsArchived,
  profileIsStale,
  rosterHealth,
  saveVersionWarning,
  SKILL_TREE_SAVE_VERSION,
  type PlayerDataSettings,
} from "../model/playerData";
import type { ProfileSummary } from "../model/profileData";
import { IconValue } from "../components/EntityIcon";
import { ipc, isTauri } from "../services/ipc";
import { pickFile, pickFiles, pickSavePath } from "../services/dialogs";
import { githubConfigComplete } from "../services/publish";
import { backupProfile, restoreProfile } from "../services/profileBackup";
import {
  applySummaryToPlayer,
  bytesToBase64,
  chooseProfileFiles,
  groupProfileFiles,
  planImport,
  profileStorageKey,
  readProfileFile,
  storedProfileFor,
  type ProfileFile,
  type ProfileGroup,
  type ProfileImportResult,
} from "../services/profileImport";
import { ProfileDropZone, type DropRejects } from "../components/ProfileDropZone";
import { ProfileImportReview } from "../components/ProfileImportReview";
import { ProfileChoiceModal } from "../components/ProfileChoiceModal";
import { CreateProfileModal } from "../components/CreateProfileModal";
import { readProfilePath, readProfilePaths } from "../services/profileFiles";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Toggle,
} from "../components/ui";
import { toast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { feedbackTarget } from "../model/feedback/targets";

const PROFILE_FILTERS = [{ name: "ARK profile", extensions: ["arkprofile"] }];

/** Which archived saves the roster list shows. A view filter only. */
type ArchivedFilter = "active" | "all" | "archived";

const ARCHIVED_FILTERS: {
  key: ArchivedFilter;
  label: string;
  hint: string;
}[] = [
  {
    key: "active",
    label: "Active",
    hint: "Hide archived saves — the default working view",
  },
  {
    key: "all",
    label: "All",
    hint: "Show active and archived saves together",
  },
  {
    key: "archived",
    label: "Archived",
    hint: "Show only archived saves, for reviewing what has been set aside",
  },
];

/**
 * Cluster player roster: the identifiers that let an admin connect a Discord
 * report to a Steam account to an in-game survivor, plus the last .arkprofile
 * taken for that player.
 *
 * A saved record reads as plain text with every value click-to-copy, because
 * that is what these fields are for — you look a player up in order to paste
 * their id somewhere else. Editing is an explicit mode with its own Save.
 */
export function PlayerDataPage() {
  const { players, setPlayers, hydrate } = useDraftsStore();
  const dir = useProjectStore((s) => s.dir);
  useEffect(hydrate, [hydrate]);

  const settings = useProjectStore((s) => s.settings);
  const github = useGithubConfig();
  const saveSettings = useProjectStore((s) => s.saveSettings);
  const policy = settings?.playerData ?? defaultPlayerDataSettings();
  const [search, setSearch] = useState("");
  /** Empty = every map. Only maps the roster actually has are offered. */
  const [mapFilter, setMapFilter] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  /**
   * Archived saves are out of the way by default, never gone. "Archived only"
   * exists because reviewing what has been archived is its own task, and
   * hunting for the archived rows inside the full roster is the slow way to do
   * it. Purely a view: nothing here changes a profile's archived status.
   */
  const [archivedFilter, setArchivedFilter] = useState<ArchivedFilter>("active");
  /** Bulk-select mode, and what is ticked. Off by default — removing a player
   *  is destructive, so the checkboxes only appear when asked for. */
  const [selecting, setSelecting] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Player id (or "all") currently talking to GitHub. */
  const [busy, setBusy] = useState<string | null>(null);
  /** Non-null while editing — the working copy, committed on Save. */
  const [draft, setDraft] = useState<Player | null>(null);
  /** Non-null once a bulk import has finished, holding its per-file report. */
  const [importReport, setImportReport] = useState<ProfileImportResult[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [creating, setCreating] = useState(false);
  /** Set when an import is waiting on the admin to pick between saves. */
  const [pendingImport, setPendingImport] = useState<{
    files: ProfileFile[];
    groups: ProfileGroup[];
  } | null>(null);

  const maps = useMemo(() => rosterMaps(players.players), [players.players]);
  const health = useMemo(
    () => rosterHealth(players.players, policy),
    [players.players, policy],
  );
  const shown = useMemo(
    () =>
      players.players
        .filter((p) => (mapFilter ? p.profile?.map === mapFilter : true))
        .filter((p) => {
          if (archivedFilter === "all") return true;
          const archived = Boolean(
            p.profile && profileIsArchived(p.profile, policy),
          );
          // A player with no profile has nothing to archive, so they belong
          // with the active roster and never with the archived-only view.
          return archivedFilter === "archived" ? archived : !archived;
        })
        .filter((p) => playerMatches(p, search))
        .sort(comparePlayers),
    [players.players, search, mapFilter, archivedFilter, policy],
  );
  const selected =
    players.players.find((p) => p.id === selectedId) ?? shown[0] ?? null;

  function select(player: Player) {
    if (draft && draft.id !== player.id) {
      void confirmDialog({
        title: "Discard unsaved changes?",
        message: `Your edits to ${playerLabel(draft)} haven't been saved.`,
        confirmLabel: "Discard",
        danger: true,
      }).then((ok) => {
        if (!ok) return;
        setDraft(null);
        setSelectedId(player.id);
      });
      return;
    }
    setSelectedId(player.id);
  }

  function commit(player: Player) {
    setPlayers({
      ...players,
      players: players.players.map((p) => (p.id === player.id ? player : p)),
    });
  }

  function addPlayer() {
    const player = newPlayer(newId());
    setPlayers({ ...players, players: [...players.players, player] });
    setSelectedId(player.id);
    setDraft(player);
  }

  async function removePlayer(player: Player) {
    const ok = await confirmDialog({
      title: `Remove ${playerLabel(player)}?`,
      message:
        "Removes this player's record from the roster. Any stored .arkprofile is deleted with it.",
      confirmLabel: "Remove player",
      danger: true,
    });
    if (!ok) return;
    if (player.profile && dir) {
      await ipc("delete_player_profile", {
        dir,
        fileName: player.profile.fileName,
      }).catch(() => {
        /* the record goes either way */
      });
    }
    setPlayers({
      ...players,
      players: players.players.filter((p) => p.id !== player.id),
    });
    setDraft(null);
    if (selectedId === player.id) setSelectedId(null);
  }

  /**
   * Removes the file a newly stored profile replaced, when the two landed on
   * different names — otherwise the old one sits in profiles/ with nothing
   * pointing at it, and gets backed up to GitHub forever.
   */
  async function deleteSuperseded(previous: string | undefined, current: string) {
    if (!dir || !previous || previous === current) return;
    await ipc("delete_player_profile", { dir, fileName: previous }).catch(() => {
      /* the record moves on either way */
    });
  }

  async function uploadProfile(player: Player) {
    if (!dir) return;
    const source = await pickFile(
      `Choose the .arkprofile for ${playerLabel(player)}`,
      PROFILE_FILTERS,
    );
    if (!source) return;
    if (player.profile) {
      const ok = await confirmDialog({
        title: "Replace the stored profile?",
        message: `The profile stored on ${new Date(player.profile.storedAt).toLocaleString()} will be overwritten.`,
        confirmLabel: "Replace",
        danger: true,
      });
      if (!ok) return;
    }
    try {
      // Read it here rather than letting Rust copy the file, so the same
      // summary the bulk importer records is available for a single upload.
      const file = await readProfilePath(source);
      const read = readProfileFile(file);
      const info = await ipc<{ fileName: string }>("store_player_profile_b64", {
        dir,
        playerId: profileStorageKey(player, read.summary),
        contentB64: bytesToBase64(file.bytes),
      });
      await deleteSuperseded(player.profile?.fileName, info.fileName);

      const profile: StoredProfile = read.summary
        ? storedProfileFor(read.summary, info.fileName)
        : {
            fileName: info.fileName,
            storedAt: new Date().toISOString(),
            // A replacement is almost always the same map as the one it replaces.
            map: player.profile?.map ?? "",
            // A new file supersedes whatever is in the repo.
            backedUpAt: null,
            summary: null,
            generated: false,
            archivedAt: null,
          };

      // Profiles are files on disk, not edits — they save immediately.
      const filled = read.summary
        ? applySummaryToPlayer(player, read.summary)
        : { player, filled: [], conflicts: [] };
      commit({ ...filled.player, profile });
      if (draft?.id === player.id) setDraft({ ...draft, profile });
      toast[read.summary ? "success" : "error"](
        read.summary
          ? `Profile stored — ${read.summary.characterName || "survivor"}, level ${read.summary.level}`
          : `Profile stored, but could not be read: ${read.error}`,
      );
    } catch (e) {
      toast.error(`Could not store profile: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * Bulk import: reads every dropped profile, works out who each one belongs
   * to, then stores the files.
   *
   * The roster update and the file write are deliberately separate. Reading a
   * profile tells us the identifiers regardless of whether the file can be
   * saved, so a failed write costs the file, not the information — and the
   * report says which happened.
   */
  async function importProfiles(files: ProfileFile[], rejects: DropRejects) {
    if (rejects.ignored.length > 0) {
      toast.error(
        `Ignored ${rejects.ignored.length} file${rejects.ignored.length === 1 ? "" : "s"} that ${rejects.ignored.length === 1 ? "is" : "are"} not .arkprofile`,
      );
    }
    for (const message of rejects.errors) toast.error(message);
    if (files.length === 0) return;

    // One account can appear several times in a batch pulled from backups.
    // Where those copies are the same character the newest wins silently;
    // where they are not, the admin decides before anything is written.
    const { groups } = groupProfileFiles(files);
    const undecided = groups.filter((g) => g.needsChoice);
    if (undecided.length > 0) {
      setPendingImport({ files, groups: undecided });
      return;
    }
    await runImport(files, groups);
  }

  /** Second half of the import, once every account has exactly one file. */
  async function runImport(
    files: ProfileFile[],
    groups: ProfileGroup[],
    picks: Record<string, number> = {},
  ) {
    const { chosen, superseded } = chooseProfileFiles(files, groups, picks);
    setImporting(true);
    try {
      const plan = planImport(players.players, chosen);
      let roster = plan.players;
      const results = [...plan.results];

      // planImport emits exactly one result per file it was given, in order —
      // which is `chosen`, not the full batch.
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (!result.summary || !result.playerId) continue;
        const target = roster.find((p) => p.id === result.playerId);
        if (!target || !dir) {
          results[i] = { ...result, storeError: "no project folder is open" };
          continue;
        }
        try {
          const info = await ipc<{ fileName: string }>("store_player_profile_b64", {
            dir,
            playerId: profileStorageKey(target, result.summary),
            contentB64: bytesToBase64(chosen[i].bytes),
          });
          await deleteSuperseded(target.profile?.fileName, info.fileName);
          const profile = storedProfileFor(result.summary, info.fileName);
          roster = roster.map((p) => (p.id === target.id ? { ...p, profile } : p));
        } catch (e) {
          results[i] = {
            ...result,
            storeError: e instanceof Error ? e.message : String(e),
          };
        }
      }

      setPlayers({ ...players, players: roster });
      setImportReport(results);
      if (superseded.length > 0) {
        // Not necessarily older — the admin may have picked an earlier save.
        toast.success(
          `Skipped ${superseded.length} other cop${superseded.length === 1 ? "y" : "ies"} of accounts in this batch`,
        );
      }
    } finally {
      setImporting(false);
      setPendingImport(null);
    }
  }

  /** The same import, from a file picker rather than a drop. */
  async function importViaPicker() {
    const paths = await pickFiles("Choose .arkprofile files to import", PROFILE_FILTERS);
    if (paths.length === 0) return;
    setImporting(true);
    let read;
    try {
      read = await readProfilePaths(paths);
    } finally {
      setImporting(false);
    }
    await importProfiles(read.files, { ignored: read.ignored, errors: read.errors });
  }

  async function downloadProfile(player: Player) {
    if (!dir || !player.profile) return;
    const dest = await pickSavePath(
      `Save ${playerLabel(player)}'s profile`,
      player.profile.fileName,
      PROFILE_FILTERS,
    );
    if (!dest) return;
    try {
      await ipc("export_player_profile", {
        dir,
        fileName: player.profile.fileName,
        destPath: dest,
      });
      toast.success("Profile saved");
    } catch (e) {
      toast.error(`Could not save profile: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** Pushes this player's stored profile to the repo. */
  async function backup(player: Player) {
    if (!dir || !player.profile || !settings) return;
    setBusy(player.id);
    try {
      await backupProfile(
        github,
        dir,
        player.profile.fileName,
        `Back up ${playerLabel(player)}'s .arkprofile via Dino Depot Studio`,
      );
      commit({
        ...player,
        profile: { ...player.profile, backedUpAt: new Date().toISOString() },
      });
      toast.success(`${playerLabel(player)}'s profile backed up`);
    } catch (e) {
      toast.error(`Backup failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  }

  /** Pulls the repo's copy back into the project's profiles/ folder. */
  async function restore(player: Player) {
    if (!dir || !player.profile || !settings) return;
    const ok = await confirmDialog({
      title: `Restore ${playerLabel(player)}'s profile from GitHub?`,
      message:
        "The copy in this project's profiles folder is overwritten with the backed-up one.",
      confirmLabel: "Restore",
    });
    if (!ok) return;
    setBusy(player.id);
    try {
      const found = await restoreProfile(
        github,
        dir,
        player.profile.fileName,
      );
      toast[found ? "success" : "error"](
        found
          ? "Profile restored from the backup"
          : "No backup for this player in the repo yet",
      );
    } catch (e) {
      toast.error(`Restore failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(null);
    }
  }

  /** Backs up every player that has a stored profile. */
  async function backupAll() {
    const pending = players.players.filter((p) => p.profile);
    if (!dir || !settings || pending.length === 0) return;
    setBusy("all");
    let done = 0;
    const failed: string[] = [];
    for (const player of pending) {
      try {
        await backupProfile(
          github,
          dir,
          player.profile!.fileName,
          `Back up ${playerLabel(player)}'s .arkprofile via Dino Depot Studio`,
        );
        done++;
      } catch {
        failed.push(playerLabel(player));
      }
    }
    if (done > 0) {
      const at = new Date().toISOString();
      const failedSet = new Set(failed);
      setPlayers({
        ...players,
        players: players.players.map((p) =>
          p.profile && !failedSet.has(playerLabel(p))
            ? { ...p, profile: { ...p.profile, backedUpAt: at } }
            : p,
        ),
      });
    }
    setBusy(null);
    if (failed.length === 0) toast.success(`${done} profiles backed up`);
    else toast.error(`${done} backed up · failed: ${failed.join(", ")}`);
  }

  /**
   * Stored saves written in an older format than the current one, and not
   * already archived. These are the ones "Archive outdated versions" moves.
   */
  const outdatedProfiles = players.players.filter(
    (p) =>
      p.profile &&
      !p.profile.archivedAt &&
      p.profile.summary !== null &&
      p.profile.summary.saveVersion < SKILL_TREE_SAVE_VERSION,
  );

  /**
   * Archives every profile on an outdated save format in one pass.
   *
   * Archiving only — a pre-Lost-Colony save is still the only copy of that
   * character, and the reason to set it aside is that it needs attention, not
   * that it is disposable.
   */
  async function archiveOutdated() {
    if (outdatedProfiles.length === 0) return;
    const ok = await confirmDialog({
      title: `Archive ${outdatedProfiles.length} outdated save${outdatedProfiles.length === 1 ? "" : "s"}?`,
      message:
        `These were written before the Lost Colony update (save format v${SKILL_TREE_SAVE_VERSION - 2}) and carry no skill tree data. ` +
        "Archiving moves them out of the default roster view — the files stay on disk and stay backed up.",
      confirmLabel: "Archive them",
    });
    if (!ok) return;
    const at = new Date().toISOString();
    const ids = new Set(outdatedProfiles.map((p) => p.id));
    setPlayers({
      ...players,
      players: players.players.map((p) =>
        ids.has(p.id) && p.profile
          ? { ...p, profile: { ...p.profile, archivedAt: at } }
          : p,
      ),
    });
    toast.success(
      `${ids.size} outdated save${ids.size === 1 ? "" : "s"} archived — nothing deleted`,
    );
  }

  function toggleSelected(id: string) {
    setSelection((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Removes every ticked player, and the profile file each one owns.
   *
   * Names the players in the confirmation rather than just counting them —
   * this deletes save data, and "remove 12 players" is not something anyone
   * can check before agreeing to it.
   */
  async function removeSelected() {
    const doomed = players.players.filter((p) => selection.has(p.id));
    if (doomed.length === 0) return;
    const withProfiles = doomed.filter((p) => p.profile).length;
    const names = doomed.map(playerLabel);
    const listed = names.slice(0, 12).join(", ");
    const ok = await confirmDialog({
      title: `Remove ${doomed.length} player${doomed.length === 1 ? "" : "s"}?`,
      message:
        `${listed}${names.length > 12 ? `, and ${names.length - 12} more` : ""}.` +
        (withProfiles > 0
          ? `\n\n${withProfiles} stored .arkprofile${withProfiles === 1 ? "" : "s"} will be deleted with them. This cannot be undone.`
          : ""),
      confirmLabel: `Remove ${doomed.length} player${doomed.length === 1 ? "" : "s"}`,
      danger: true,
    });
    if (!ok) return;

    if (dir) {
      for (const player of doomed) {
        if (!player.profile) continue;
        await ipc("delete_player_profile", {
          dir,
          fileName: player.profile.fileName,
        }).catch(() => {
          /* the record goes either way */
        });
      }
    }
    setPlayers({
      ...players,
      players: players.players.filter((p) => !selection.has(p.id)),
    });
    if (selectedId && selection.has(selectedId)) setSelectedId(null);
    if (draft && selection.has(draft.id)) setDraft(null);
    setSelection(new Set());
    setSelecting(false);
    toast.success(`${doomed.length} removed`);
  }

  /**
   * Archives or restores a stored save. Deliberately does nothing to the file
   * — this is a view state, so that "tidy the roster" and "throw away a
   * character" can never be the same click.
   */
  function toggleArchive(player: Player) {
    if (!player.profile) return;
    const archivedAt = player.profile.archivedAt
      ? null
      : new Date().toISOString();
    const next = { ...player, profile: { ...player.profile, archivedAt } };
    commit(next);
    if (draft?.id === player.id) setDraft(next);
    toast.info(
      archivedAt
        ? `${playerLabel(player)}'s save archived — the file is untouched`
        : `${playerLabel(player)}'s save is back in the roster`,
    );
  }

  async function clearProfile(player: Player) {
    if (!player.profile) return;
    const ok = await confirmDialog({
      title: "Delete the stored profile?",
      message:
        "The file is removed from the project's profiles folder. The player record stays.",
      confirmLabel: "Delete profile",
      danger: true,
    });
    if (!ok) return;
    if (dir) {
      await ipc("delete_player_profile", {
        dir,
        fileName: player.profile.fileName,
      }).catch(() => {
        /* record is cleared regardless */
      });
    }
    commit({ ...player, profile: null });
    if (draft?.id === player.id) setDraft({ ...draft, profile: null });
  }

  const withProfiles = players.players.filter((p) => p.profile).length;
  const editing = draft?.id === selected?.id ? draft : null;
  const githubReady = githubConfigComplete(github);

  return (
    <div {...feedbackTarget("player-data")}>
      <PageHeader
        title="Player Data"
        subtitle={`${players.players.length} player${players.players.length === 1 ? "" : "s"} · ${withProfiles} with a stored profile`}
        actions={
          <>
            {withProfiles > 0 && (
              <Button
                onClick={backupAll}
                disabled={!isTauri || busy !== null || !githubReady}
                title={
                  githubReady
                    ? "Push every stored .arkprofile to the GitHub repo"
                    : "Configure the GitHub repository in Settings first"
                }
              >
                {busy === "all"
                  ? "Backing up…"
                  : `Back up all profiles (${withProfiles})`}
              </Button>
            )}
            <Button
              onClick={() => setCreating(true)}
              disabled={!dir}
              title="Rebuild a lost .arkprofile from an existing one"
            >
              Create profile…
            </Button>
            <Button variant="primary" onClick={addPlayer}>
              + Add player
            </Button>
            <Button
              onClick={() => setSettingsOpen(true)}
              title="Stale-save and save-format policy for this page"
            >
              Settings…
            </Button>
          </>
        }
      />

      {(health.stale > 0 || health.outdatedFormat > 0 || health.archived > 0) && (
        <div className="flex items-center gap-2 flex-wrap mb-3 text-xs text-ink-400">
          {health.stale > 0 && (
            <Badge tone="warn">
              {health.stale} stale (over {policy.staleAfterDays} days old)
            </Badge>
          )}
          {health.outdatedFormat > 0 && (
            <Badge tone="warn">
              {health.outdatedFormat} on an older save format
            </Badge>
          )}
          {health.archived > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="text-ink-500">
                {health.archived} archived — showing
              </span>
              {/* Segmented rather than a cycling toggle: with three states a
                  single button never says what the *other* two are, and this
                  filter decides whether a row you expect is on screen at all.
                  Filtering only changes the view, never the archived flag. */}
              <span className="inline-flex rounded-md border border-ink-700 overflow-hidden">
                {ARCHIVED_FILTERS.map((option) => (
                  <button
                    key={option.key}
                    onClick={() => setArchivedFilter(option.key)}
                    title={option.hint}
                    aria-pressed={archivedFilter === option.key}
                    className={cx(
                      "px-2 py-0.5 cursor-pointer transition-colors",
                      archivedFilter === option.key
                        ? "bg-accent-600 text-white"
                        : "text-ink-400 hover:text-ink-100 hover:bg-ink-800",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </span>
            </span>
          )}
          <span>Nothing is ever deleted automatically.</span>
        </div>
      )}

      <div className="mb-4">
        <ProfileDropZone onFiles={importProfiles} busy={importing} disabled={!dir}>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm text-ink-200">
                {importing
                  ? "Reading profiles…"
                  : "Drop .arkprofile files here to import them"}
              </p>
              <p className="text-xs text-ink-400 mt-0.5">
                A whole SavedArks folder at once is fine — each file finds its
                player by EOS ID, and new ones get a roster entry.
              </p>
            </div>
            <Button onClick={importViaPicker} disabled={!isTauri || importing || !dir}>
              Choose files…
            </Button>
          </div>
        </ProfileDropZone>
      </div>

      {!isTauri && (
        <p className="text-xs text-amber-400 mb-3">
          Profile upload and download only work in the desktop app — everything
          else on this page works here.
        </p>
      )}

      <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-5">
        <div>
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search any identifier or map…"
            className="mb-2"
          />
          {maps.length > 1 && (
            <Select
              value={mapFilter}
              onChange={(e) => setMapFilter(e.target.value)}
              className="mb-2"
              title="Show only players whose stored profile came from this map"
            >
              <option value="">All maps</option>
              {maps.map((map: string) => (
                <option key={map} value={map}>
                  {map}
                </option>
              ))}
            </Select>
          )}
          <div className="flex items-center justify-between gap-2 mb-2">
            <Button
              variant="ghost"
              className="text-xs"
              onClick={() => {
                setSelecting(!selecting);
                setSelection(new Set());
              }}
              disabled={shown.length === 0}
            >
              {selecting ? "Cancel" : "Select…"}
            </Button>
            {selecting && (
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  className="text-xs"
                  onClick={() =>
                    setSelection(
                      selection.size === shown.length
                        ? new Set()
                        : new Set(shown.map((p) => p.id)),
                    )
                  }
                >
                  {selection.size === shown.length ? "None" : "All"}
                </Button>
                <Button
                  variant="danger"
                  className="text-xs"
                  onClick={removeSelected}
                  disabled={selection.size === 0}
                >
                  Remove {selection.size || ""}
                </Button>
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1.5 max-h-[calc(100vh-260px)] overflow-y-auto pr-1">
            {shown.map((player) => (
              // A checkbox cannot live inside the row button, so the two sit
              // side by side and the button keeps the whole remaining width.
              <div key={player.id} className="flex items-center gap-2">
                {selecting && (
                  <input
                    type="checkbox"
                    checked={selection.has(player.id)}
                    onChange={() => toggleSelected(player.id)}
                    title={`Select ${playerLabel(player)}`}
                    className="shrink-0 accent-(--color-accent-500) w-4 h-4"
                  />
                )}
                <button
                  onClick={() => select(player)}
                  className={cx(
                    "relative flex-1 min-w-0 text-left px-3 py-2 rounded-lg border cursor-pointer",
                    player.id === selected?.id
                      ? "bg-ink-800 border-accent-500/50"
                      : "bg-ink-900 border-ink-700 hover:border-ink-600",
                  )}
                >
                  {/* Quiet corner mark: "has a save" is a yes/no fact, and a
                      word-sized badge gave it more weight than it earns. The
                      save version rides alongside it — which format a profile
                      is in decides what can be read out of it. */}
                  {player.profile && (
                    <span
                      className="absolute top-1.5 right-2 flex items-center gap-1 text-xs leading-none"
                      title={
                        (profileIsArchived(player.profile, policy)
                          ? "Has a stored .arkprofile (archived)"
                          : "Has a stored .arkprofile") +
                        (player.profile.summary
                          ? ` — save version ${player.profile.summary.saveVersion}`
                          : "")
                      }
                      aria-label={
                        player.profile.summary
                          ? `Has a stored profile, save version ${player.profile.summary.saveVersion}`
                          : "Has a stored profile"
                      }
                    >
                      {player.profile.summary && (
                        <span className="text-ink-400">
                          v{player.profile.summary.saveVersion}
                        </span>
                      )}
                      <span className="text-green-400">✓</span>
                    </span>
                  )}
                  <div className="text-sm font-medium text-ink-100 truncate pr-9">
                    {playerLabel(player)}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {player.gameName && (
                      <span className="text-xs text-ink-400 truncate">
                        {player.gameName}
                      </span>
                    )}
                    {draft?.id === player.id && (
                      <Badge tone="warn">unsaved</Badge>
                    )}
                  </div>
                </button>
              </div>
            ))}
            {shown.length === 0 && (
              <p className="text-sm text-ink-400 px-2 py-4">
                {search ? "No matches." : "No players yet."}
              </p>
            )}
          </div>
        </div>

        <div className="min-w-0">
          {!selected ? (
            <EmptyState title="Select a player to view">
              Or add one — a record only needs whichever identifier you have.
            </EmptyState>
          ) : (
            <Card
              title={playerLabel(selected)}
              actions={
                editing ? (
                  <>
                    <Button variant="ghost" onClick={() => setDraft(null)}>
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        commit(editing);
                        setDraft(null);
                        toast.success("Player saved");
                      }}
                    >
                      Save player
                    </Button>
                  </>
                ) : (
                  <>
                    <Button onClick={() => setDraft({ ...selected })}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => removePlayer(selected)}
                    >
                      Remove
                    </Button>
                  </>
                )
              }
            >
              {editing ? (
                <PlayerForm player={editing} onChange={setDraft} />
              ) : (
                <PlayerSummary player={selected} />
              )}

              <ProfileSection
                // Show the draft's map while editing so the pick is visible.
                player={editing ?? selected}
                editing={Boolean(editing)}
                busy={busy === selected.id || busy === "all"}
                githubReady={githubReady}
                onUpload={() => uploadProfile(selected)}
                onDownload={() => downloadProfile(selected)}
                onClear={() => clearProfile(selected)}
                onBackup={() => backup(selected)}
                onRestore={() => restore(selected)}
                // Only reachable while editing, so it rides along with the
                // record's Save/Cancel rather than committing on its own.
                onSetMap={(map) => {
                  if (!editing?.profile) return;
                  setDraft({
                    ...editing,
                    profile: { ...editing.profile, map },
                  });
                }}
                onToggleArchive={() => toggleArchive(selected)}
              />

              {selected.profile?.summary && (
                <ProfileDetails summary={selected.profile.summary} />
              )}
            </Card>
          )}
        </div>
      </div>

      {importReport && (
        <ProfileImportReview
          results={importReport}
          onClose={() => setImportReport(null)}
          onSelectPlayer={(playerId) => {
            setDraft(null);
            setSelectedId(playerId);
          }}
        />
      )}

      {pendingImport && (
        <ProfileChoiceModal
          groups={pendingImport.groups}
          onCancel={() => setPendingImport(null)}
          onConfirm={(picks) => {
            const { files } = pendingImport;
            // Re-group so accounts that needed no decision are included too.
            void runImport(files, groupProfileFiles(files).groups, picks);
          }}
        />
      )}

      {creating && (
        <CreateProfileModal
          playersFile={players}
          onClose={() => setCreating(false)}
          onCreated={(roster, playerId) => {
            setPlayers({ ...players, players: roster });
            setDraft(null);
            setSelectedId(playerId);
          }}
          onCleanSlates={(cleanSlates) => setPlayers({ ...players, cleanSlates })}
        />
      )}

      {settingsOpen && settings && (
        <PlayerDataSettingsModal
          value={policy}
          health={health}
          outdatedCount={outdatedProfiles.length}
          onArchiveOutdated={archiveOutdated}
          onClose={() => setSettingsOpen(false)}
          onSave={async (next) => {
            try {
              await saveSettings({ ...settings, playerData: next });
              toast.success("Player Data settings saved");
              setSettingsOpen(false);
            } catch (e) {
              toast.error(
                `Could not save settings: ${e instanceof Error ? e.message : e}`,
              );
            }
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Policy for this page, kept here rather than on the Settings page because the
 * Player Data module can be switched off — its settings should not outlive it
 * in a list of options that no longer do anything.
 */
function PlayerDataSettingsModal({
  value,
  health,
  outdatedCount,
  onArchiveOutdated,
  onSave,
  onClose,
}: {
  value: PlayerDataSettings;
  health: ReturnType<typeof rosterHealth>;
  /** How many stored saves are on an older format and not yet archived. */
  outdatedCount: number;
  onArchiveOutdated: () => void;
  onSave: (next: PlayerDataSettings) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<PlayerDataSettings>(value);
  const set = (patch: Partial<PlayerDataSettings>) =>
    setDraft({ ...draft, ...patch });

  return (
    <Modal
      title="Player Data settings"
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            Currently {health.stale} stale · {health.archived} archived ·{" "}
            {health.outdatedFormat} on an older save format
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => onSave(draft)}>
              Save settings
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="border border-ink-700 rounded-lg p-3 bg-ink-850">
          <p className="text-xs text-ink-300">
            A stored <span className="mono">.arkprofile</span> is often the only
            surviving copy of a player's character. Nothing on this page ever
            deletes one automatically — age and save format are labels, and the
            strongest thing archiving does is move a save out of the default
            list.
          </p>
        </div>

        <Field
          label="Call a save stale after"
          hint="Days since it was stored. 0 turns staleness off entirely."
        >
          <div className="flex items-center gap-2 max-w-xs">
            <Input
              type="number"
              min="0"
              max="3650"
              value={draft.staleAfterDays}
              onChange={(e) => {
                const n = Number(e.target.value);
                set({
                  staleAfterDays:
                    Number.isFinite(n) && n >= 0 ? Math.min(n, 3650) : 0,
                });
              }}
            />
            <span className="text-sm text-ink-400 shrink-0">days</span>
          </div>
        </Field>

        <div className="flex items-start gap-3">
          <span className="pt-0.5">
            <Toggle
              checked={draft.autoArchiveStale}
              onChange={(autoArchiveStale) => set({ autoArchiveStale })}
            />
          </span>
          <span>
            <span className="block text-sm text-ink-100">
              Archive stale saves automatically
            </span>
            <span className="block text-xs text-ink-400">
              Hides them from the roster behind a “show archived” toggle. The
              files stay in the project's profiles folder and keep getting
              backed up.
            </span>
          </span>
        </div>

        <div className="flex items-start gap-3">
          <span className="pt-0.5">
            <Toggle
              checked={draft.warnOnSaveVersion}
              onChange={(warnOnSaveVersion) => set({ warnOnSaveVersion })}
            />
          </span>
          <span>
            <span className="block text-sm text-ink-100">
              Warn about older save formats
            </span>
            <span className="block text-xs text-ink-400">
              Flags saves written before the Lost Colony update (save format
              v5). Those predate skill trees and carry no skill tree data, so
              restoring one returns the character with every tree at zero.
            </span>
          </span>
        </div>

        <div className="border-t border-ink-700 pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="block text-sm text-ink-100">
                Archive outdated versions
              </span>
              <span className="block text-xs text-ink-400">
                {outdatedCount > 0
                  ? `${outdatedCount} stored save${outdatedCount === 1 ? " is" : "s are"} on an older save format. Archiving moves ${outdatedCount === 1 ? "it" : "them"} out of the roster — the file${outdatedCount === 1 ? "" : "s"} stay${outdatedCount === 1 ? "s" : ""} on disk.`
                  : "Every stored save is on the current format."}
              </span>
            </div>
            <Button
              className="shrink-0"
              onClick={onArchiveOutdated}
              disabled={outdatedCount === 0}
            >
              Archive {outdatedCount || ""}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** Copies its value on click — these fields exist to be pasted elsewhere. */
function CopyValue({
  value,
  mono,
  label,
  placeholder = "—",
}: {
  value: string;
  mono?: boolean;
  label: string;
  placeholder?: string;
}) {
  if (!value.trim()) {
    return <span className="text-sm text-ink-600">{placeholder}</span>;
  }
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(value);
        toast.success(`${label} copied`);
      }}
      title={`Click to copy — ${value}`}
      className={cx(
        "text-sm text-ink-100 text-left truncate max-w-full cursor-pointer",
        "hover:text-accent-400",
        mono && "mono",
      )}
    >
      {value}
    </button>
  );
}

/**
 * Read view: one line per platform, pairing the name with its id, since
 * that's the pair you actually need together. Name and id copy separately.
 */
function PlayerSummary({ player }: { player: Player }) {
  if (!hasPlayerDetails(player)) {
    return (
      <p className="text-sm text-ink-400">
        Nothing recorded yet — press Edit to fill this in.
      </p>
    );
  }
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 items-baseline">
      {PLAYER_ROWS.map((row) => {
        const name = row.nameKey ? player[row.nameKey].trim() : "";
        const id = player[row.idKey].trim();
        if (!name && !id) return null;
        return (
          <Fragment key={row.label}>
            <span className="text-sm text-ink-400">{row.label}:</span>
            <span className="flex items-baseline gap-1.5 min-w-0">
              {row.nameKey && (
                <CopyValue
                  value={name}
                  label={`${row.label} name`}
                  placeholder="(no name)"
                />
              )}
              {id ? (
                <span className="flex items-baseline gap-0.5 min-w-0 text-ink-500">
                  {row.nameKey && "("}
                  <CopyValue value={id} mono label={`${row.label} ID`} />
                  {row.nameKey && ")"}
                </span>
              ) : (
                row.nameKey && <span className="text-ink-600 text-sm">(—)</span>
              )}
            </span>
          </Fragment>
        );
      })}
      {player.notes.trim() && (
        <>
          <span className="text-sm text-ink-400">Notes:</span>
          <span className="text-sm text-ink-200">{player.notes}</span>
        </>
      )}
    </div>
  );
}

/** Edit view. */
function PlayerForm({
  player,
  onChange,
}: {
  player: Player;
  onChange: (next: Player) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        {PLAYER_FIELDS.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <Input
              className={field.mono ? "mono" : undefined}
              value={player[field.key]}
              placeholder={field.placeholder}
              onChange={(e) =>
                onChange({ ...player, [field.key]: e.target.value })
              }
            />
          </Field>
        ))}
      </div>
      <div className="mt-3">
        <Field label="Notes">
          <Input
            value={player.notes}
            onChange={(e) => onChange({ ...player, notes: e.target.value })}
            placeholder="Tribe, timezone, past incidents…"
          />
        </Field>
      </div>
    </>
  );
}

/**
 * What the stored profile actually says.
 *
 * Read straight out of the save when it was imported, so this is the survivor
 * as the server has them — the thing an admin is usually trying to establish
 * when a player claims they lost levels.
 */
function ProfileDetails({ summary }: { summary: ProfileSummary }) {
  const spent = summary.statPoints.filter((s) => s.points > 0);
  return (
    <div className="mt-3 border-t border-ink-700 pt-3">
      <div className="flex items-center gap-4 flex-wrap text-sm">
        <span className="text-ink-100 font-medium">Level {summary.level}</span>
        {summary.highestLevel > summary.level && (
          <span className="text-amber-400 text-xs">
            highest reached {summary.highestLevel}
          </span>
        )}
        <span className="text-ink-400">
          {summary.engramsLearned} engrams · {summary.engramPoints} engram points
        </span>
        <span className="text-ink-400">
          {summary.deaths} death{summary.deaths === 1 ? "" : "s"}
        </span>
        {summary.explorerNotes > 0 && (
          <span className="text-ink-400">
            {summary.explorerNotes} note{summary.explorerNotes === 1 ? "" : "s"}
          </span>
        )}
      </div>

      {spent.length > 0 && (
        <div className="flex gap-x-3 gap-y-1 flex-wrap mt-2">
          {spent.map((stat) => (
            <span key={stat.index} className="text-xs text-ink-400">
              {stat.label} <span className="text-ink-200">{stat.points}</span>
            </span>
          ))}
          {summary.spentPoints !== summary.extraLevel && (
            <span
              className="text-xs text-amber-400"
              title="Points allocated do not match one per level — the server may hand out more, or the profile has been edited"
            >
              {summary.spentPoints} points over {summary.extraLevel} levels
            </span>
          )}
        </div>
      )}

      {summary.skillTrees.length > 0 && (
        <div className="flex gap-x-3 gap-y-1 flex-wrap mt-2">
          {summary.skillTrees.map((tree) => (
            <span
              key={tree.name}
              className="text-xs text-ink-400"
              title="Skill tree level and index, as the save stores them"
            >
              {tree.name}{" "}
              <span className="text-ink-200">
                {tree.level}/{tree.index}
              </span>
            </span>
          ))}
          <span className="text-xs text-ink-400">
            {summary.completedMilestones} milestones done
          </span>
        </div>
      )}

      <div className="flex gap-x-4 gap-y-1 flex-wrap mt-2 text-xs text-ink-500">
        {summary.saveVersion >= 7 && <span>save v{summary.saveVersion}</span>}
        {summary.ascension !== null && <span>ascensions {summary.ascension}</span>}
        {summary.activeBuffs.length > 0 && (
          <span>Logged out with: {summary.activeBuffs.join(", ")}</span>
        )}
        {summary.platform && <span>{summary.platform}</span>}
      </div>
    </div>
  );
}

/**
 * Stored profile: which map it came from, that there is one, and when. A
 * profile is per-map save data, so the map is the first thing you need to
 * know before restoring it anywhere.
 */
function ProfileSection({
  player,
  editing,
  busy,
  githubReady,
  onUpload,
  onDownload,
  onClear,
  onBackup,
  onRestore,
  onSetMap,
  onToggleArchive,
}: {
  player: Player;
  /** The map picker only appears while the record is open for editing. */
  editing: boolean;
  busy: boolean;
  githubReady: boolean;
  onUpload: () => void;
  onDownload: () => void;
  onClear: () => void;
  onBackup: () => void;
  onRestore: () => void;
  onSetMap: (map: string) => void;
  /** Moves the save out of (or back into) the default roster view. */
  onToggleArchive: () => void;
}) {
  const settings = useProjectStore((s) => s.settings);
  const maps = mapList(settings);
  const policy = settings?.playerData ?? defaultPlayerDataSettings();
  const profile = player.profile;
  const broken = profileIsBroken(profile);
  const style = profile?.map ? mapStyle(settings, profile.map) : null;
  const stale = profile ? profileIsStale(profile, policy) : false;
  const ageDays = profile ? profileAgeDays(profile) : null;
  const versionWarning = profile ? saveVersionWarning(profile, policy) : null;

  return (
    <div className="mt-4 border-t border-ink-700 pt-3 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide shrink-0">
          .arkprofile
        </span>
        {profile && broken ? (
          <Badge tone="error">File reference lost — upload it again</Badge>
        ) : profile ? (
          <>
            {profile.map ? (
              <span
                className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border border-ink-600"
                style={{ color: style?.color || undefined }}
                title="Map this profile came from"
              >
                <IconValue
                  icon={style?.icon ?? "🗺️"}
                  officialMap={profile.map}
                  size={13}
                />
                {profile.map}
              </span>
            ) : (
              <Badge tone="warn">Map not set</Badge>
            )}
            <span
              title={
                ageDays === null
                  ? undefined
                  : `${ageDays} day${ageDays === 1 ? "" : "s"} old`
              }
            >
              <Badge tone={stale ? "warn" : "ok"}>
                Stored {new Date(profile.storedAt).toLocaleString()}
                {stale && ` · stale (${ageDays}d)`}
              </Badge>
            </span>
            {versionWarning && (
              <span title={versionWarning.detail}>
                <Badge tone="warn">{versionWarning.label}</Badge>
              </span>
            )}
            {profile.archivedAt && (
              <span
                title={`Archived ${new Date(profile.archivedAt).toLocaleString()} — the file is untouched`}
              >
                <Badge tone="neutral">Archived</Badge>
              </span>
            )}
            {profile.generated && (
              <Badge tone="warn">Generated — not taken from a server</Badge>
            )}
            {profile.backedUpAt ? (
              <Badge tone="info">
                Backed up {new Date(profile.backedUpAt).toLocaleDateString()}
              </Badge>
            ) : (
              <Badge tone="warn">Local only</Badge>
            )}
          </>
        ) : (
          <Badge tone="neutral">Not stored</Badge>
        )}
      </div>
      <div className="flex gap-2 shrink-0 items-center">
        {profile && !broken && editing && (
          <div className="w-44">
            <Select
              value={profile.map}
              onChange={(e) => onSetMap(e.target.value)}
              title="Map this profile came from"
            >
              <option value="">Set map…</option>
              {maps.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </Select>
          </div>
        )}
        <Button onClick={onUpload} disabled={!isTauri || busy}>
          {profile ? "Replace…" : "Upload…"}
        </Button>
        {profile && !broken && (
          <>
            <Button onClick={onDownload} disabled={!isTauri || busy}>
              Download…
            </Button>
            <Button
              onClick={onBackup}
              disabled={!isTauri || busy || !githubReady}
              title={
                githubReady
                  ? "Push this profile to the GitHub repo"
                  : "Configure the GitHub repository in Settings first"
              }
            >
              {busy ? "Working…" : "Back up"}
            </Button>
            <Button
              onClick={onRestore}
              disabled={!isTauri || busy || !githubReady}
              title="Replace the local copy with the backed-up one"
            >
              Restore
            </Button>
            <Button
              variant="ghost"
              onClick={onToggleArchive}
              disabled={busy}
              title={
                profile.archivedAt
                  ? "Put this save back in the roster"
                  : "Move this save out of the default roster view — the file stays put"
              }
            >
              {profile.archivedAt ? "Unarchive" : "Archive"}
            </Button>
            <Button variant="ghost" onClick={onClear} disabled={busy}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
