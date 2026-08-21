import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useBlocker, useParams } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import { SecretInput } from "../components/SecretInput";
import { GitHubSetup } from "./settings/GitHubSetup";
import { SettingsNav } from "./settings/SettingsNav";
import { categoryFor, dirtyCategories } from "./settings/categories";
import { ipc } from "../services/ipc";
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

export function SettingsPage() {
  const { settings, saveSettings } = useProjectStore();
  const [draft, setDraft] = useState<ProjectSettings | null>(settings);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  const dirty =
    (draft !== null &&
      settings !== null &&
      JSON.stringify(draft) !== JSON.stringify(settings));

  useUnsavedChangesPrompt(dirty, handleSave);

  if (!draft) return null;

  const update = (patch: Partial<ProjectSettings>) =>
    setDraft({ ...draft, ...patch });

  async function handleSave() {
    if (!draft) return false;
    try {
      await saveSettings(draft);
      toast.success("Settings saved");
      return true;
    } catch (e) {
      toast.error(
        `Could not save settings: ${e instanceof Error ? e.message : e}`,
      );
      return false;
    }
  }

  return (
    <SettingsContent
      draft={draft}
      saved={settings}
      update={update}
      handleSave={handleSave}
      dirty={dirty}
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
  // Moving between categories stays on this page and keeps the draft, so only
  // a navigation that leaves Settings is worth interrupting.
  const blocker = useBlocker(
    ({ nextLocation }) =>
      dirty && !nextLocation.pathname.startsWith("/settings"),
  );
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
  saved,
  update,
  handleSave,
  dirty,
}: {
  draft: ProjectSettings;
  saved: ProjectSettings | null;
  update: (patch: Partial<ProjectSettings>) => void;
  handleSave: () => void;
  dirty: boolean;
}) {
  const { tab } = useParams();
  const category = categoryFor(tab);
  const active = category.slug;

  return (
    <div>
      {/* Pinned so Save is reachable from anywhere in a long category. The
          negative margins let the bar span the page padding rather than
          leaving a strip of scrolling content either side of it. */}
      <div className="sticky top-0 z-10 -mx-6 -mt-6 px-6 pt-6 bg-ink-950 border-b border-ink-800">
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
      </div>

      <div className="flex gap-6 mt-5">
        <SettingsNav active={active} dirty={dirtyCategories(draft, saved)} />

        {/* Paired by subject, two to a row. items-start keeps a short card
            from being stretched to match a tall neighbour. */}
        <div
          className={cx(
            "flex-1 min-w-0 grid gap-5 items-start",
            category.columns === 2 ? "grid-cols-2" : "grid-cols-1 max-w-4xl",
          )}
        >
          {active === "project" && (
            <ProjectCategory draft={draft} update={update} />
          )}
          {active === "github" && <GitHubCategory />}
          {active === "publishing" && (
            <PublishingCategory draft={draft} update={update} />
          )}
          {active === "defaults" && (
            <DefaultsCategory draft={draft} update={update} />
          )}
          {active === "discord" && (
            <DiscordCategory draft={draft} update={update} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Shared by every category: the cards all edit the one draft. */
interface CategoryProps {
  draft: ProjectSettings;
  update: (patch: Partial<ProjectSettings>) => void;
}

/**
 * A line explaining that a card writes immediately and ignores Save.
 *
 * Two save contracts share this page — the draft written by Save, and the
 * machine-local cards that store a credential the moment they are used. Saying
 * so beside them is cheaper than making them behave alike, since a credential
 * has no business sitting in an unsaved draft.
 */
function MachineLocalNote({ children }: { children: ReactNode }) {
  return (
    <p className="col-span-full -mb-2 text-xs text-ink-400">
      <span className="text-ink-300">This computer only:</span> {children}
    </p>
  );
}

function ProjectCategory({ draft, update }: CategoryProps) {
  return (
    <>
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
          <p className="text-xs text-ink-400">
            Official and modpack icons are resolved automatically from their
            managed packages. Project-owned overrides live in the project's
            <span className="mono"> images</span> folder; WebP is preferred and
            PNG is also accepted.
          </p>
        </div>
      </Card>

      <AdditionalPagesCard draft={draft} update={update} />
      <MapsCard draft={draft} update={update} />
    </>
  );
}

function GitHubCategory() {
  return (
    <>
      <MachineLocalNote>
        the account and repository below are stored on this computer and saved
        as you set them, so the Save button does not apply here. Two people
        editing one cluster each sign in as themselves.
      </MachineLocalNote>

      <GitHubSetup />
    </>
  );
}

function PublishingCategory({ draft, update }: CategoryProps) {
  return (
    <>
      <Card title="Where published files go">
        {/* Repository-relative, and genuinely shared: every administrator
            publishes to the same layout. Which repository that layout lives
            in is machine-local — see the GitHub section. */}
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
                value={draft.outputPaths[key]}
                onChange={(e) =>
                  update({
                    outputPaths: {
                      ...draft.outputPaths,
                      [key]: e.target.value,
                    },
                  })
                }
              />
            </Field>
          ))}
        </div>
      </Card>
    </>
  );
}

function DefaultsCategory({ draft, update }: CategoryProps) {
  return (
    <>
      <ProductionDefaultsCard draft={draft} update={update} />
      <SimulatorDefaultsCard draft={draft} update={update} />
    </>
  );
}

function DiscordCategory({ draft, update }: CategoryProps) {
  return (
    <>
      <MachineLocalNote>
        the webhook below is kept in Windows Credential Manager and stored the
        moment you press Store. The post format waits for Save.
      </MachineLocalNote>

      <DiscordWebhookCard />
      <CcmPostFormatCard draft={draft} update={update} />
    </>
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
      //
      // `col-span-full`, not `col-span-2`: a two-column span inside a
      // single-column category creates an implicit second track, which
      // collapses the real one to zero width and overlaps whatever is in it.
      className="col-span-full"
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
        project overrides. Stock map art is resolved automatically from the
        managed official package; no image-folder setup is required.
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
              <IconValue icon={map.icon} officialMap={map.name} size={24} />
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
