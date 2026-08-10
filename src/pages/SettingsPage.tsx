import { Fragment, useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import { useDraftsStore } from "../stores/draftsStore";
import { ipc } from "../services/ipc";
import { pickFolder } from "../services/dialogs";
import { openExternal } from "../services/openExternal";
import {
  Badge,
  Button,
  Card,
  cx,
  Field,
  Input,
  PageHeader,
  Toggle,
} from "../components/ui";
import { APP_MODULES } from "../app/modules";
import { toast } from "../components/toast";
import { chooseDialog, confirmDialog } from "../components/confirm";
import {
  DiscordFormatSchema,
  defaultMaps,
  type MapEntry,
  type ProjectSettings,
} from "../model/project";
import {
  DISCORD_TOKENS,
  renderDiscordPost,
  SAMPLE_POST_MODS,
} from "../model/discordPost";
import {
  IconChooserModal,
  IconValue,
  MAP_EMOJI_PALETTE,
} from "../components/EntityIcon";

const TOKEN_KEY = "github-token";

/** Where the app itself lives — releases, modpacks, issues. */
const STUDIO_REPO_URL =
  "https://github.com/CaotcAftermth/DinoDepot_Production_Studio";

export function SettingsPage() {
  const { settings, saveSettings } = useProjectStore();
  const [draft, setDraft] = useState<ProjectSettings | null>(settings);
  const [tokenInput, setTokenInput] = useState("");
  const [hasToken, setHasToken] = useState<boolean | null>(null);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    ipc<boolean>("secret_has", { key: TOKEN_KEY })
      .then(setHasToken)
      .catch(() => setHasToken(null));
  }, []);

  const dirty =
    draft !== null &&
    settings !== null &&
    JSON.stringify(draft) !== JSON.stringify(settings);

  useUnsavedChangesPrompt(dirty, handleSave);

  if (!draft) return null;

  const update = (patch: Partial<ProjectSettings>) =>
    setDraft({ ...draft, ...patch });

  async function handleSave() {
    if (!draft) return false;
    try {
      await saveSettings(draft);
      // Rescan icons in case the images folder changed.
      void useDraftsStore.getState().refreshImages();
      toast.success("Settings saved");
      return true;
    } catch (e) {
      toast.error(
        `Could not save settings: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  async function handleSaveToken() {
    if (!tokenInput.trim()) return;
    try {
      await ipc("secret_set", { key: TOKEN_KEY, value: tokenInput.trim() });
      setTokenInput("");
      setHasToken(true);
      toast.success("GitHub token stored in Windows Credential Manager");
    } catch (e) {
      toast.error(
        `Could not store token: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function handleDeleteToken() {
    try {
      await ipc("secret_delete", { key: TOKEN_KEY });
      setHasToken(false);
      toast.info("GitHub token removed");
    } catch (e) {
      toast.error(
        `Could not remove token: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return (
    <SettingsContent
      draft={draft}
      update={update}
      handleSave={handleSave}
      dirty={dirty}
      tokenInput={tokenInput}
      setTokenInput={setTokenInput}
      hasToken={hasToken}
      handleSaveToken={handleSaveToken}
      handleDeleteToken={handleDeleteToken}
    />
  );
}

// ---------------------------------------------------------------------------

/**
 * Catches a navigation away from unsaved edits and asks what to do with them.
 * Leaving without noticing was the failure mode: nothing on this page is
 * written until Save, so a stray sidebar click quietly threw the work away.
 */
function useUnsavedChangesPrompt(dirty: boolean, save: () => Promise<boolean>) {
  const blocker = useBlocker(dirty);
  // `save` closes over the draft, so it changes every render — a ref keeps the
  // effect from re-running (and re-prompting) underneath an open dialog.
  const saveRef = useRef(save);
  saveRef.current = save;
  const asking = useRef(false);

  useEffect(() => {
    if (blocker.state !== "blocked" || asking.current) return;
    asking.current = true;

    void (async () => {
      const answer = await chooseDialog({
        title: "Save your settings changes?",
        message:
          "You've changed settings on this page but haven't saved them. Leaving now discards the changes.",
        options: [
          { key: "save", label: "Save and leave", variant: "primary" },
          { key: "discard", label: "Discard changes", variant: "danger" },
        ],
        cancelLabel: "Stay on this page",
      });

      // A failed write keeps the admin here rather than losing the edits.
      const leave =
        answer === "save" ? await saveRef.current() : answer === "discard";
      asking.current = false;
      if (leave) blocker.proceed?.();
      else blocker.reset?.();
    })();
  }, [blocker]);
}

/**
 * Input for a value kept in Windows Credential Manager. A stored secret is
 * never read back into the app, so the field stands in a row of asterisks to
 * show at a glance that something *is* saved — "Replace" clears it for typing.
 */
function SecretInput({
  stored,
  value,
  onChange,
  placeholder,
}: {
  stored: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  const [replacing, setReplacing] = useState(false);

  if (stored && !replacing) {
    return (
      <div className="flex gap-2 flex-1">
        <Input
          readOnly
          value={"*".repeat(28)}
          className="mono tracking-widest text-ink-400"
          title="A value is stored in Windows Credential Manager"
        />
        <Button
          className="shrink-0"
          onClick={() => {
            onChange("");
            setReplacing(true);
          }}
        >
          Replace
        </Button>
      </div>
    );
  }

  return (
    <div className="flex gap-2 flex-1">
      <Input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={replacing}
      />
      {stored && (
        <Button
          className="shrink-0"
          onClick={() => {
            onChange("");
            setReplacing(false);
          }}
        >
          Cancel
        </Button>
      )}
    </div>
  );
}

function DiscordWebhookCard() {
  const [input, setInput] = useState("");
  const [hasHook, setHasHook] = useState<boolean | null>(null);

  useEffect(() => {
    ipc<boolean>("secret_has", { key: "discord-webhook" })
      .then(setHasHook)
      .catch(() => setHasHook(null));
  }, []);

  async function save() {
    if (!input.trim()) return;
    try {
      await ipc("secret_set", { key: "discord-webhook", value: input.trim() });
      setInput("");
      setHasHook(true);
      toast.success("Discord webhook stored in Windows Credential Manager");
    } catch (e) {
      toast.error(
        `Could not store webhook: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  async function remove() {
    try {
      await ipc("secret_delete", { key: "discord-webhook" });
      setHasHook(false);
      toast.info("Discord webhook removed");
    } catch (e) {
      toast.error(
        `Could not remove webhook: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return (
    <Card
      className="self-stretch"
      title="Discord webhook"
      actions={
        hasHook === null ? null : hasHook ? (
          <Badge tone="ok">Webhook stored</Badge>
        ) : (
          <Badge tone="warn">No webhook</Badge>
        )
      }
    >
      <p className="text-xs text-ink-400 mb-3">
        Used by "Post to Discord" in the Cosmetics Collector (e.g. announcing
        new custom cosmetic mods). Create one in your Discord server: Channel
        settings → Integrations → Webhooks. Stored in Windows Credential
        Manager.
      </p>
      <div className="flex gap-2">
        <SecretInput
          stored={hasHook === true}
          value={input}
          onChange={setInput}
          placeholder="https://discord.com/api/webhooks/…"
        />
        <Button variant="primary" onClick={save} disabled={!input.trim()}>
          Store
        </Button>
        {hasHook && (
          <Button variant="danger" onClick={remove}>
            Remove
          </Button>
        )}
      </div>
    </Card>
  );
}

function SettingsContent({
  draft,
  update,
  handleSave,
  dirty,
  tokenInput,
  setTokenInput,
  hasToken,
  handleSaveToken,
  handleDeleteToken,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
  handleSave: () => void;
  dirty: boolean;
  tokenInput: string;
  setTokenInput: (v: string) => void;
  hasToken: boolean | null;
  handleSaveToken: () => void;
  handleDeleteToken: () => void;
}) {
  /**
   * The project's repository, derived from the owner and name already set
   * below rather than stored again.
   *
   * Those two fields are what publishing actually pushes to, so a separately
   * assigned link could quietly disagree with them and send someone to the
   * wrong repo — and it would mean naming the same repository twice.
   */
  const { owner, repo } = draft.github;
  const projectRepoUrl =
    owner.trim() && repo.trim()
      ? `https://github.com/${owner.trim()}/${repo.trim()}`
      : "";
  const ownerInput = useRef<HTMLInputElement>(null);

  return (
    <div>
      <PageHeader
        title="Settings"
        subtitle="Project configuration, GitHub publishing, and defaults"
        actions={
          <>
            {dirty && <Badge tone="warn">Unsaved changes</Badge>}
            <Button variant="primary" onClick={handleSave} disabled={!dirty}>
              Save settings
            </Button>
          </>
        }
      />

      {/* Paired by subject, two to a row. items-start keeps a short card from
          being stretched to match a tall neighbour. */}
      <div className="grid grid-cols-2 gap-5 items-start">
        <Card title="Project">
          <div className="flex flex-col gap-4">
            <Field label="Project name">
              <Input
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </Field>
            <Field label="Cluster name">
              <Input
                value={draft.cluster}
                onChange={(e) => update({ cluster: e.target.value })}
              />
            </Field>
            <Field
              label="Images folder"
              hint="Scanned (incl. subfolders like creatures\ and items\) for entry icons. Empty = images folder inside the project folder."
            >
              <div className="flex gap-2">
                <Input
                  className="mono"
                  value={draft.imagesDir}
                  onChange={(e) => update({ imagesDir: e.target.value })}
                  placeholder="e.g. C:\...\DinoDepotClaude\images"
                />
                <Button
                  onClick={async () => {
                    const dir = await pickFolder("Choose the images folder");
                    if (dir) update({ imagesDir: dir });
                  }}
                >
                  Browse…
                </Button>
              </div>
            </Field>
          </div>
        </Card>

        {/* self-stretch opts these three out of the grid's items-start, so
            each matches the height of the card beside it. */}
        <Card
          className="self-stretch"
          title="GitHub token"
          actions={
            hasToken === null ? null : hasToken ? (
              <Badge tone="ok">Token stored</Badge>
            ) : (
              <Badge tone="warn">No token</Badge>
            )
          }
        >
          <p className="text-xs text-ink-400 mb-3">
            A fine-grained personal access token with{" "}
            <b>Contents: Read and write</b> on the publish repository. Stored in
            Windows Credential Manager — never in project files.
          </p>
          <div className="flex gap-2">
            <SecretInput
              stored={hasToken === true}
              value={tokenInput}
              onChange={setTokenInput}
              placeholder="github_pat_…"
            />
            <Button
              variant="primary"
              onClick={handleSaveToken}
              disabled={!tokenInput.trim()}
            >
              Store
            </Button>
            {hasToken && (
              <Button variant="danger" onClick={handleDeleteToken}>
                Remove
              </Button>
            )}
          </div>

          {/* The two repositories this app talks to, one click away from the
              credential that reaches them. */}
          <div className="flex flex-wrap gap-2 mt-4 pt-3 border-t border-ink-700">
            <Button
              onClick={() => {
                if (projectRepoUrl) {
                  void openExternal(projectRepoUrl);
                  return;
                }
                // Nothing to open yet: send them to the fields that define it
                // rather than asking for the same repo a second time.
                ownerInput.current?.scrollIntoView({
                  block: "center",
                  behavior: "smooth",
                });
                ownerInput.current?.focus();
                toast.info(
                  "Set the repository owner and name below — the project repo link follows them",
                );
              }}
              title={
                projectRepoUrl
                  ? `Open ${projectRepoUrl}`
                  : "Not set yet — click to fill in the repository owner and name"
              }
            >
              Project Repo {projectRepoUrl ? "↗" : "…"}
            </Button>
            <Button
              onClick={() => void openExternal(STUDIO_REPO_URL)}
              title="Dino Depot Production Studio — releases, modpacks and issues"
            >
              DinoDepot Production Studio Repo ↗
            </Button>
          </div>
        </Card>

        <ProductionDefaultsCard draft={draft} update={update} />

        <Card title="GitHub repository">
          <div className="grid grid-cols-3 gap-3 mb-4">
            <Field label="Owner">
              <Input
                ref={ownerInput}
                value={draft.github.owner}
                onChange={(e) =>
                  update({ github: { ...draft.github, owner: e.target.value } })
                }
                placeholder="your-github-user"
              />
            </Field>
            <Field label="Repository">
              <Input
                value={draft.github.repo}
                onChange={(e) =>
                  update({ github: { ...draft.github, repo: e.target.value } })
                }
                placeholder="server-config"
              />
            </Field>
            <Field label="Branch">
              <Input
                value={draft.github.branch}
                onChange={(e) =>
                  update({
                    github: { ...draft.github, branch: e.target.value },
                  })
                }
              />
            </Field>
          </div>
          {/* Five stacked full-width path fields made this the tallest card on
              the page for no reason — they are short values. */}
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                ["production", "Passive production"],
                ["remaps", "Creature remaps"],
                ["cosmetics", "Custom cosmetics"],
                ["viewerData", "Cluster viewer data"],
                ["viewerPage", "Cluster viewer page"],
                ["players", "Player roster"],
                ["profiles", "Player profile backups (folder)"],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={label}>
                <Input
                  className="mono"
                  value={draft.github.paths[key]}
                  onChange={(e) =>
                    update({
                      github: {
                        ...draft.github,
                        paths: { ...draft.github.paths, [key]: e.target.value },
                      },
                    })
                  }
                />
              </Field>
            ))}
          </div>
        </Card>

        <SimulatorDefaultsCard draft={draft} update={update} />
        <DiscordWebhookCard />

        <CcmPostFormatCard draft={draft} update={update} />

        <MapsCard draft={draft} update={update} />
        <AdditionalPagesCard draft={draft} update={update} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Unparseable input keeps the fallback rather than writing NaN. */
function numOr(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Starting values for a new production rule. */
function ProductionDefaultsCard({
  draft,
  update,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}) {
  const set = (patch: Partial<ProjectSettings["defaults"]>) =>
    update({ defaults: { ...draft.defaults, ...patch } });

  return (
    <Card className="self-stretch" title="Production defaults">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Interval (seconds)">
          <Input
            type="number"
            value={draft.defaults.intervalSeconds}
            onChange={(e) => set({ intervalSeconds: numOr(e.target.value, 300) })}
          />
        </Field>
        <Field label="Chance to produce">
          <Input
            type="number"
            step="0.05"
            min="0"
            max="1"
            value={draft.defaults.chanceToProduce}
            onChange={(e) => set({ chanceToProduce: numOr(e.target.value, 1) })}
          />
        </Field>
        <Field label="Quantity per dino">
          <Input
            type="number"
            value={draft.defaults.quantityPerDino}
            onChange={(e) => set({ quantityPerDino: numOr(e.target.value, 1) })}
          />
        </Field>
        <Field label="Max per cycle (0 = none)">
          <Input
            type="number"
            value={draft.defaults.maxQuantityPerCycle}
            onChange={(e) =>
              set({ maxQuantityPerCycle: numOr(e.target.value, 0) })
            }
          />
        </Field>
        <Field label="Max in terminal (0 = none)">
          <Input
            type="number"
            value={draft.defaults.maxQuantityInTerminal}
            onChange={(e) =>
              set({ maxQuantityInTerminal: numOr(e.target.value, 0) })
            }
          />
        </Field>
      </div>
    </Card>
  );
}

/** Window and warning thresholds the Simulator opens with. */
function SimulatorDefaultsCard({
  draft,
  update,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}) {
  const set = (patch: Partial<ProjectSettings["simulator"]>) =>
    update({ simulator: { ...draft.simulator, ...patch } });

  return (
    <Card title="Simulator defaults">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Default hours">
          <Input
            type="number"
            value={draft.simulator.defaultHours}
            onChange={(e) => set({ defaultHours: numOr(e.target.value, 24) })}
          />
        </Field>
        <Field label="Default creature count">
          <Input
            type="number"
            value={draft.simulator.defaultCreatureCount}
            onChange={(e) =>
              set({ defaultCreatureCount: numOr(e.target.value, 10) })
            }
          />
        </Field>
        <Field
          label="High output warning (items/hr)"
          hint="An item can override this in its own Item info"
        >
          <Input
            type="number"
            value={draft.simulator.highOutputPerHour}
            onChange={(e) =>
              set({ highOutputPerHour: numOr(e.target.value, 500) })
            }
          />
        </Field>
        <Field label="Low output warning (items/hr)">
          <Input
            type="number"
            value={draft.simulator.lowOutputPerHour}
            onChange={(e) => set({ lowOutputPerHour: numOr(e.target.value, 1) })}
          />
        </Field>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Wording for the Custom Cosmetic Mod announcement. Kept as a template so the
 * post can be reworded without a rebuild — the Collector renders it for both
 * "Copy Discord post" and "Post to Discord".
 */
function CcmPostFormatCard({
  draft,
  update,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}) {
  const format = draft.discord;
  const set = (patch: Partial<typeof format>) =>
    update({ discord: { ...format, ...patch } });

  const preview = renderDiscordPost(format, SAMPLE_POST_MODS, {
    cluster: draft.cluster,
  });

  return (
    <Card
      // Full width with its own two columns — stacked, this was by far the
      // tallest card and left a hole beside its neighbour.
      className="col-span-2"
      title="CCM Discord post format"
      actions={
        <Button
          onClick={() => set(DiscordFormatSchema.parse({}))}
          title="Restore the stock wording"
        >
          Reset
        </Button>
      }
    >
      <p className="text-xs text-ink-400 mb-3">
        How the Cosmetics Collector writes its announcement. The line template
        is rendered once per new mod.
      </p>
      <div className="grid grid-cols-2 gap-5 items-start">
        <div className="flex flex-col gap-3">
          <Field label="Header" hint="Leave empty to omit">
            <Input
              className="mono"
              value={format.header}
              onChange={(e) => set({ header: e.target.value })}
            />
          </Field>
          <Field label="Line (once per mod)">
            <Input
              className="mono"
              value={format.line}
              onChange={(e) => set({ line: e.target.value })}
            />
          </Field>
          <Field label="Footer" hint="Leave empty to omit">
            <Input
              className="mono"
              value={format.footer}
              onChange={(e) => set({ footer: e.target.value })}
              placeholder="e.g. Add these to your CCM list before the next restart."
            />
          </Field>
        </div>

        <div>
          <div>
            <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
              Preview
            </span>
            <pre className="mono bg-ink-950 border border-ink-700 rounded-md p-3 text-ink-200 whitespace-pre-wrap break-words max-h-40 overflow-y-auto">
              {preview}
            </pre>
          </div>

          <div className="mt-4">
            <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
              Tokens
            </span>
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
              {DISCORD_TOKENS.map((t) => (
                <div key={t.token} className="text-xs text-ink-400">
                  <span className="mono text-accent-400">{t.token}</span> —{" "}
                  {t.means}
                  {t.scope === "line" && (
                    <span className="text-ink-500"> (line only)</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

/**
 * Toggles for the optional pages that live below the sidebar separator.
 * Everything is off by default, so the studio stays the studio unless the
 * admin asks for more.
 */
function AdditionalPagesCard({
  draft,
  update,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}) {
  return (
    <Card title="Additional pages">
      <p className="text-xs text-ink-400 mb-3">
        Optional functionality beyond the production studio. Anything enabled
        here appears in the sidebar below the separator.
      </p>
      {APP_MODULES.length === 0 ? (
        <p className="text-sm text-ink-400">
          None available yet — this is where they'll be listed.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {APP_MODULES.map((module) => (
            <div
              key={module.id}
              className="flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <div className="text-sm text-ink-100">
                  <span className="opacity-70 mr-1.5">{module.icon}</span>
                  {module.label}
                </div>
                <p className="text-xs text-ink-400">{module.description}</p>
              </div>
              <Toggle
                checked={draft.modules[module.id] === true}
                onChange={(v) =>
                  update({ modules: { ...draft.modules, [module.id]: v } })
                }
              />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------

/** The muted grey a map label falls back to when no color is set. */
const DEFAULT_MAP_COLOR = "#9ca3af";

/**
 * The map list Content Sources draws from. Adding a map here is all it takes
 * to be able to assign it; the icon and color follow it wherever it's shown.
 */
function MapsCard({
  draft,
  update,
}: {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}) {
  const maps = draft.maps;
  const [newName, setNewName] = useState("");
  const [iconFor, setIconFor] = useState<number | null>(null);

  const setMap = (i: number, patch: Partial<MapEntry>) =>
    update({ maps: maps.map((m, j) => (j === i ? { ...m, ...patch } : m)) });

  function add() {
    const name = newName.trim();
    if (!name) return;
    if (maps.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
      toast.error(`"${name}" is already on the list`);
      return;
    }
    update({ maps: [...maps, { name, icon: "🗺️", color: "", enabled: true }] });
    setNewName("");
  }

  async function remove(i: number) {
    const ok = await confirmDialog({
      title: `Remove "${maps[i].name}" from the map list?`,
      message:
        "Entries already assigned to it keep the assignment — they just lose the icon and color until the map is added back.",
      confirmLabel: "Remove map",
      danger: true,
    });
    if (!ok) return;
    update({ maps: maps.filter((_, j) => j !== i) });
  }

  const disabledCount = maps.filter((m) => !m.enabled).length;

  return (
    <Card
      title={`Maps (${maps.length}${disabledCount ? `, ${disabledCount} off` : ""})`}
      actions={
        <Button
          onClick={() => update({ maps: defaultMaps() })}
          title="Restore the stock map list"
        >
          Reset
        </Button>
      }
    >
      <p className="text-xs text-ink-400 mb-3">
        Offered when assigning an entry's map of origin in Content Sources. The
        icon and color follow the map onto the entry list. Icons can be emoji or
        images from your images folder — drop the official map art in there and
        pick it here.
      </p>
      <p className="text-xs text-ink-400 mb-3">
        Turning a map <b>off</b> says the cluster does not run it. Nothing is
        hidden — content first seen there stays fully available, because much of
        it turns up on later maps anyway (Scorched Earth wyverns on Ragnarok).
        It is marked <span className="text-amber-400">Caution</span> instead, as
        a reminder that some of it may genuinely be unobtainable here.
      </p>

      {/* Scrolls rather than growing the page — a long cluster map list would
          otherwise dwarf every other card. */}
      <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto] gap-x-3 gap-y-2 items-center max-h-[26rem] overflow-y-auto pr-1">
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
          On
        </span>
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
          Icon
        </span>
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
          Map name
        </span>
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
          Color
        </span>
        <span />

        {maps.map((map, i) => (
          <Fragment key={i}>
            <Toggle
              checked={map.enabled}
              onChange={(enabled) => setMap(i, { enabled })}
            />

            <button
              onClick={() => setIconFor(i)}
              title="Change this map's icon"
              className={cx(
                "w-10 h-10 flex items-center justify-center rounded-md border border-ink-600 bg-ink-900 hover:border-accent-500/60 cursor-pointer",
                !map.enabled && "opacity-50",
              )}
            >
              <IconValue icon={map.icon} size={24} />
            </button>

            <Input
              value={map.name}
              onChange={(e) => setMap(i, { name: e.target.value })}
              placeholder="Map name"
              title={
                map.enabled
                  ? undefined
                  : `The cluster does not run ${map.name} — its content is marked Caution`
              }
              style={{
                color: map.color || DEFAULT_MAP_COLOR,
                opacity: map.enabled ? undefined : 0.55,
              }}
            />

            {/* The native picker already offers presets and hex entry, so the
                swatch row and hex box that used to sit here were redundant. */}
            <input
              type="color"
              value={map.color || DEFAULT_MAP_COLOR}
              onChange={(e) => setMap(i, { color: e.target.value })}
              title={`Label color — ${map.color || `default (${DEFAULT_MAP_COLOR})`}`}
              className="w-9 h-9 rounded-md bg-ink-900 border border-ink-600 cursor-pointer p-1"
            />

            <Button
              variant="ghost"
              onClick={() => remove(i)}
              title={`Remove ${map.name}`}
            >
              ✕
            </Button>
          </Fragment>
        ))}
      </div>

      <div className="flex gap-2 mt-4 pt-3 border-t border-ink-700">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Add a map, e.g. Nyrandil"
          className="max-w-md"
        />
        <Button variant="primary" onClick={add} disabled={!newName.trim()}>
          Add map
        </Button>
      </div>

      {iconFor !== null && maps[iconFor] && (
        <IconChooserModal
          title={`Icon for ${maps[iconFor].name}`}
          current={maps[iconFor].icon}
          palette={MAP_EMOJI_PALETTE}
          imageSearchSeed={maps[iconFor].name}
          fallbackNote="Pick an image from the folder, an emoji, or paste an image URL."
          onPick={(icon) => setMap(iconFor, { icon: icon || "🗺️" })}
          onClose={() => setIconFor(null)}
        />
      )}
    </Card>
  );
}
