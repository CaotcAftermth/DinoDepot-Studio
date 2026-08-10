import { useEffect, useMemo, useState } from "react";
import { recordActivity, useDraftsStore } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  effectiveOfficialSource,
  isBundledOfficialId,
  officialCategories,
  officialWithAbsent,
  OFFICIAL_SOURCE_ID,
} from "../model/officialCatalog";
import {
  AsaVerdict,
  CatalogEntry,
  ContentSource,
  emptyItemInfo,
  ItemInfo,
  normalizeBpPath,
  sourceCurseforgeUrl,
} from "../model/catalog";
import {
  bundledItemInfo,
  hasStoredItemInfo,
  ITEM_RARITIES,
  ITEM_TYPES,
  itemInfoOf,
  RARITY_COLOR,
} from "../model/itemInfo";
import { newId } from "../model/ids";
import {
  detectSourceTag,
  proposeCleanName,
  resolveCreatureBase,
} from "../model/creatureBase";
import { mapIsDisabled, mapOf, mapStyle } from "../model/maps";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Field,
  Input,
  MenuButton,
  Modal,
  PageHeader,
  Select,
  Toggle,
} from "../components/ui";
import { toast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { openExternal } from "../services/openExternal";
import { pickFolder } from "../services/dialogs";
import { IniSettingsPanel } from "./content/IniSettingsPanel";
import { CreatureDetailsModal } from "./content/CreatureDetailsModal";
import { CreaturePreviewModal } from "./content/CreaturePreviewModal";
import { ItemPreviewModal } from "./content/ItemPreviewModal";
import { MapOfOriginModal } from "./content/MapOfOriginModal";
import { EntryDataModal } from "./content/EntryDataModal";
import { AssociationModal } from "./content/AssociationModal";
import { AddModpackModal } from "./content/AddModpackModal";
import { ExportModpackModal } from "./content/ExportModpackModal";
import { defaultModpackRegistry } from "../model/modpack";
import { WikiImportModal } from "./content/WikiImportModal";
import {
  hasCreatureInfo,
  resolveCreatureInfo,
} from "../model/creatureInfo";
import {
  EntityIcon,
  type IconFolder,
  IconValue,
} from "../components/EntityIcon";
import { PlayerFieldInput } from "../components/PlayerFieldInput";
import { playerLabel } from "../model/players";
import { useCatalogIndex } from "../stores/useCatalogIndex";
import {
  buildCreatureCommands,
  buildItemCommands,
  DEFAULT_CREATURE_PARAMS,
  DEFAULT_ITEM_PARAMS,
  PLAYER_ID_KIND_LABELS,
  type PlayerIdKind,
  shortClassName,
  SpawnCommand,
} from "../services/spawnCommands";
import {
  ColorsEditor,
  StatsEditor,
  TraitsEditor,
} from "./content/SpawnArgEditors";
import { plural } from "../model/text";
import {
  buildEntryOwners,
  describeOwner,
  findCatalogDuplicates,
  findDuplicateCurseforgeIds,
  findDuplicateModUrls,
  findEntryOwner,
  findSourceByCurseforgeId,
  normalizeCurseforgeId,
  planEntryInsert,
  planEntryMove,
  type EntryOwner,
} from "../model/catalogDuplicates";

/** Discord's wordmark glyph, inlined — the app ships no external assets. */
function DiscordIcon() {
  return (
    <svg
      viewBox="0 0 127.14 96.36"
      aria-hidden="true"
      className="w-3.5 h-3.5 fill-current shrink-0"
    >
      <path d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z" />
    </svg>
  );
}

/**
 * Row markers for what is recorded on an entry.
 *
 * Two small glyphs rather than a sentence: the row is scanned, not read, and
 * "Partly inherited from Achatina" spent a line of every variant saying
 * something the group header already implies. Both carry the full explanation
 * on hover.
 */
function InfoMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="w-3.5 h-3.5 fill-current shrink-0">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1Zm0 1.4A5.6 5.6 0 1 1 8 13.6 5.6 5.6 0 0 1 8 2.4Zm0 1.6a.95.95 0 1 0 0 1.9.95.95 0 0 0 0-1.9Zm-.8 3.3v4.6h1.6V7.3H7.2Z" />
    </svg>
  );
}

/** Shown on a variant that overrides some of what it would inherit. */
function OverrideMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="w-3.5 h-3.5 fill-current shrink-0">
      <path d="M3.2 1.5A1.2 1.2 0 0 0 2 2.7v10.6a1.2 1.2 0 0 0 1.2 1.2h6.3v-1.4H3.4V2.9h6.1v2.6c0 .5.4.9.9.9h2.2v1.3H14V5.1L10.4 1.5H3.2Zm7.7 1.9 1.5 1.5h-1.5V3.4ZM4.8 6.2v1.3h5.4V6.2H4.8Zm0 2.6V10h3.4V8.8H4.8Zm8.9.3-3.1 3.1-1.3-1.3-1 1 2.3 2.3 4.1-4.1-1-1Z" />
    </svg>
  );
}

/**
 * A reference link beside the mod name: opens the link when one is set,
 * otherwise prompts for it. The pencil re-opens the editor either way.
 */
function LinkChip({
  url,
  icon,
  setLabel,
  addLabel,
  addTitle,
  onEdit,
}: {
  url: string;
  icon: React.ReactNode;
  setLabel: string;
  addLabel: string;
  addTitle: string;
  onEdit: () => void;
}) {
  return (
    <>
      <button
        onClick={async () => {
          if (!url) return onEdit();
          try {
            await openExternal(url);
          } catch (e) {
            toast.error(`${e instanceof Error ? e.message : e}`);
          }
        }}
        title={url || addTitle}
        className={cx(
          "inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md border cursor-pointer font-normal",
          url
            ? "border-ink-600 text-ink-200 hover:text-accent-400 hover:border-accent-500/60"
            : "border-dashed border-ink-600 text-ink-400 hover:text-ink-200",
        )}
      >
        {icon}
        {url ? setLabel : addLabel}
      </button>
      {url && (
        <button
          onClick={onEdit}
          title={`Edit the ${addLabel.replace(/^Add /, "")} link`}
          className="text-xs text-ink-400 hover:text-ink-200 cursor-pointer font-normal"
        >
          ✎
        </button>
      )}
    </>
  );
}

type EntryKind = "creatures" | "items";
type TabKind = EntryKind | "ini";

export function ContentSourcesPage() {
  const { catalog, setCatalog, hydrate } = useDraftsStore();
  const projectSettings = useProjectStore((s) => s.settings);
  useEffect(hydrate, [hydrate]);

  const [selectedId, setSelectedId] = useState<string>(OFFICIAL_SOURCE_ID);
  const [addingSource, setAddingSource] = useState(false);

  const official = useMemo(() => effectiveOfficialSource(catalog), [catalog]);
  const allSources = useMemo(
    // Official ASA is pinned first — it is the baseline every mod adds to, not
    // one entry among them. The mods themselves sort by name, because the only
    // way anyone looks for a mod in a list this long is alphabetically.
    () => [
      official,
      ...[...catalog.sources].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    ],
    [official, catalog.sources],
  );
  const selected = allSources.find((s) => s.id === selectedId) ?? official;
  const isOfficial = selected.id === OFFICIAL_SOURCE_ID;

  /**
   * Official ASA is backed by bundled data, so its edits are stored as an
   * overlay: only admin-added entries and the reference links are persisted.
   */
  function updateSource(patch: Partial<ContentSource>) {
    if (isOfficial) {
      const overlay = { ...catalog.official };
      if (patch.docsUrl !== undefined) overlay.docsUrl = patch.docsUrl;
      if (patch.discordUrl !== undefined) overlay.discordUrl = patch.discordUrl;
      if (patch.iniNotes !== undefined) overlay.iniNotes = patch.iniNotes;
      if (patch.iniSettings !== undefined) {
        overlay.iniSettings = patch.iniSettings;
      }
      if (patch.creatures) {
        overlay.creatures = patch.creatures.filter(
          (e) => !isBundledOfficialId(e.id),
        );
      }
      if (patch.items) {
        overlay.items = patch.items.filter((e) => !isBundledOfficialId(e.id));
      }
      setCatalog({ ...catalog, official: overlay });
      return;
    }
    setCatalog({
      ...catalog,
      sources: catalog.sources.map((s) =>
        s.id === selected.id ? { ...s, ...patch } : s,
      ),
    });
  }

  /** Patches any mod by id — the source list edits rows other than the selected one. */
  function updateSourceById(id: string, patch: Partial<ContentSource>) {
    const source = catalog.sources.find((s) => s.id === id);
    setCatalog({
      ...catalog,
      sources: catalog.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
    // Enabling a mod also starts watching it for updates, so it is worth a
    // line in the log; the other patches from this path are field edits.
    if (source && patch.enabled !== undefined && patch.enabled !== source.enabled) {
      recordActivity({
        kind: "source",
        title: `${patch.enabled ? "Enabled" : "Disabled"} ${source.name}`,
      });
    }
  }

  function addSource(source: ContentSource) {
    setCatalog({ ...catalog, sources: [...catalog.sources, source] });
    setSelectedId(source.id);
    setAddingSource(false);
    recordActivity({ kind: "source", title: `Added content source ${source.name}` });
  }

  async function deleteSource() {
    const ok = await confirmDialog({
      title: `Delete "${selected.name}"?`,
      message:
        "This removes the mod and everything catalogued under it. Production rules and remaps that reference its content will start showing missing-content warnings.",
      details: [
        plural(selected.creatures.length, "creature"),
        plural(selected.items.length, "item"),
        plural(selected.iniSettings.length, "INI setting"),
        "This cannot be undone (previous versions remain in the project's backups folder)",
      ],
      confirmLabel: "Delete mod",
      danger: true,
    });
    if (!ok) return;
    setCatalog({
      ...catalog,
      sources: catalog.sources.filter((s) => s.id !== selected.id),
    });
    setSelectedId(OFFICIAL_SOURCE_ID);
    recordActivity({
      kind: "source",
      title: `Removed content source ${selected.name}`,
      detail: `${plural(selected.creatures.length, "creature")}, ${plural(selected.items.length, "item")}`,
    });
  }

  /**
   * Moves entries (by id) from the selected source into another source.
   *
   * A class the destination — or any other source — already catalogues is left
   * where it is and reported. The old check only looked at the destination and
   * dropped anything it matched without saying so, which quietly lost entries.
   */
  function moveEntries(kind: EntryKind, entryIds: Set<string>, targetId: string) {
    const moving = selected[kind].filter((e) => entryIds.has(e.id));
    if (moving.length === 0) return;

    const owners = buildEntryOwners(allSources, kind);
    const plan = planEntryMove(owners, moving);
    if (plan.moved.length === 0) {
      toast.error(
        `Nothing moved — ${plural(plan.skipped.length, "class")} already catalogued elsewhere (${plan.skipped[0]?.conflictsWith})`,
      );
      return;
    }

    const movedIds = new Set(plan.moved.map((e) => e.id));
    // Official ASA lives in the overlay, not in catalog.sources.
    const official = isOfficial
      ? {
          ...catalog.official,
          [kind]: catalog.official[kind].filter((e) => !movedIds.has(e.id)),
        }
      : catalog.official;
    setCatalog({
      ...catalog,
      official,
      sources: catalog.sources.map((s) => {
        if (s.id === selected.id) {
          return { ...s, [kind]: s[kind].filter((e) => !movedIds.has(e.id)) };
        }
        if (s.id === targetId) {
          return { ...s, [kind]: [...s[kind], ...plan.moved] };
        }
        return s;
      }),
    });
    const target = catalog.sources.find((s) => s.id === targetId);
    toast.success(
      `Moved ${plan.moved.length} ${kind} to "${target?.name ?? "?"}"` +
        (plan.skipped.length > 0
          ? ` — ${plan.skipped.length} kept here (already catalogued: ${plan.skipped
              .slice(0, 3)
              .map((s) => s.conflictsWith)
              .join(", ")})`
          : ""),
    );
  }

  return (
    <div>
      <PageHeader
        title="Content Sources"
        subtitle="The mods, creatures, and items this project can reference — mods watched for updates are managed here too"
        actions={
          <>
            {/* The two places this data actually comes from, one click away. */}
            <Button
              onClick={() => void openExternal("https://ark.wiki.gg/")}
              title="ark.wiki.gg — the source the bundled official catalog is compiled from"
            >
              Ark Wiki ↗
            </Button>
            <Button
              onClick={() =>
                void openExternal(
                  "https://www.curseforge.com/ark-survival-ascended",
                )
              }
              title="CurseForge — ASA mod listings"
            >
              CurseForge ↗
            </Button>
            <Button variant="primary" onClick={() => setAddingSource(true)}>
              + Add mod
            </Button>
          </>
        }
      />

      <CatalogHealthBanner sources={allSources} modSources={catalog.sources} />

      {/* minmax(0,…) so long values wrap instead of widening the page. */}
      <div className="grid grid-cols-[280px_minmax(0,1fr)] gap-5">
        <div className="flex flex-col gap-1.5">
          {allSources.map((source) => (
            // The status badge is its own control, so the row is a div rather
            // than a button — nesting a button inside a button is invalid and
            // the inner click would never be reliable.
            <div
              key={source.id}
              onClick={() => setSelectedId(source.id)}
              className={cx(
                "text-left px-3 py-2.5 rounded-lg border cursor-pointer transition-colors",
                source.id === selected.id
                  ? "bg-ink-800 border-accent-500/50"
                  : "bg-ink-900 border-ink-700 hover:border-ink-600",
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-ink-100 truncate">
                  {source.name}
                </span>
                <span className="flex items-center gap-1 shrink-0">
                  {source.kind === "official" ? (
                    <Badge tone="info">Official</Badge>
                  ) : source.removed ? (
                    <Badge tone="error">Removed</Badge>
                  ) : (
                    // Enabling a mod is a one-click fact about it, so the badge
                    // that states it is also the switch that changes it.
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        updateSourceById(source.id, { enabled: !source.enabled });
                      }}
                      title={
                        source.enabled
                          ? `${source.name} is enabled and watched for updates — click to disable`
                          : `${source.name} is disabled and not watched — click to enable`
                      }
                      className="cursor-pointer hover:brightness-125 transition-[filter]"
                    >
                      <Badge tone={source.enabled ? "ok" : "warn"}>
                        {source.enabled ? "Enabled" : "Disabled"}
                      </Badge>
                    </button>
                  )}
                </span>
              </div>
              <div className="text-xs text-ink-400 mt-0.5">
                {source.creatures.length} creatures · {source.items.length} items
                {source.modpackId && (
                  <span
                    className="text-ink-500"
                    title={`Installed from the modpack "${source.modpackId}"`}
                  >
                    {" · "}pack v{source.modpackVersion || "?"}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>

        <SourceDetail
          source={selected}
          isOfficial={isOfficial}
          allSources={allSources}
          onUpdate={updateSource}
          onDelete={deleteSource}
          onMove={moveEntries}
        />
      </div>

      {addingSource && (
        <AddModpackModal
          registry={projectSettings?.modpackRegistry ?? defaultModpackRegistry()}
          findIdConflict={(id) => findSourceByCurseforgeId(catalog.sources, id)}
          onInstalled={(sourceId) => {
            setSelectedId(sourceId);
            setAddingSource(false);
          }}
          onAddManual={addSource}
          onClose={() => setAddingSource(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The mod's CurseForge project ID, checked for uniqueness when the field is
 * done being edited.
 *
 * Committed on blur rather than on every keystroke: typing "97" on the way to
 * "972253" would otherwise collide with a mod whose ID happens to be 97.
 */
function CurseforgeIdField({
  source,
  modSources,
  onUpdate,
}: {
  source: ContentSource;
  modSources: ContentSource[];
  onUpdate: (patch: Partial<ContentSource>) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? source.curseforgeId;
  const conflict =
    draft === null
      ? null
      : findSourceByCurseforgeId(modSources, draft, source.id);

  return (
    <Field
      label="CurseForge ID"
      hint={conflict ? `Already used by "${conflict.name}"` : undefined}
    >
      <Input
        value={value}
        className={conflict ? "border-danger/60" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft;
          setDraft(null);
          if (next === null) return;
          const trimmed = normalizeCurseforgeId(next);
          if (trimmed === normalizeCurseforgeId(source.curseforgeId)) return;
          const clash = findSourceByCurseforgeId(modSources, trimmed, source.id);
          if (clash) {
            toast.error(
              `Project ID ${trimmed} already belongs to "${clash.name}" — IDs must be unique`,
            );
            return;
          }
          onUpdate({ curseforgeId: trimmed });
        }}
      />
    </Field>
  );
}

// ---------------------------------------------------------------------------

/**
 * Duplicates that are already in the project.
 *
 * New ones are blocked at every entry point, but a project saved before those
 * checks existed can carry them, and nothing here deletes anything: which of
 * two same-class entries is the right one, and which mod should own it, is a
 * judgement only the admin can make.
 */
function CatalogHealthBanner({
  sources,
  modSources,
}: {
  sources: ContentSource[];
  modSources: ContentSource[];
}) {
  const duplicateClasses = useMemo(
    () => findCatalogDuplicates(sources),
    [sources],
  );
  const duplicateIds = useMemo(
    () => findDuplicateCurseforgeIds(modSources),
    [modSources],
  );
  const duplicateUrls = useMemo(
    () => findDuplicateModUrls(modSources),
    [modSources],
  );
  const [open, setOpen] = useState(false);

  const total =
    duplicateClasses.length + duplicateIds.length + duplicateUrls.length;
  if (total === 0) return null;

  return (
    <div className="mb-4 border border-amber-flag/30 bg-amber-flag/5 rounded-lg px-4 py-2.5">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-3 cursor-pointer text-left"
      >
        <span className="text-sm text-amber-300">
          ⚠ {plural(total, "duplicate")} in this project —{" "}
          {[
            duplicateClasses.length > 0 &&
              plural(duplicateClasses.length, "blueprint class"),
            duplicateIds.length > 0 &&
              plural(duplicateIds.length, "CurseForge ID"),
            duplicateUrls.length > 0 && plural(duplicateUrls.length, "mod URL"),
          ]
            .filter(Boolean)
            .join(", ")}
        </span>
        <span className="text-xs text-ink-400 shrink-0">
          {open ? "Hide" : "Show"} details
        </span>
      </button>
      {open && (
        <div className="mt-3 pt-3 border-t border-amber-flag/20 text-xs space-y-2">
          <p className="text-ink-400">
            Nothing was changed. Delete whichever entry is wrong, or move the
            class into the mod that really provides it.
          </p>
          {duplicateClasses.slice(0, 20).map((dup) => (
            <div key={`${dup.kind}-${dup.key}`} className="text-ink-300">
              <span className="mono text-ink-400">
                {dup.locations[0].bpPath}
              </span>{" "}
              —{" "}
              {dup.locations
                .map((l) => `"${l.entryName}" in ${l.sourceName}`)
                .join(" · ")}
            </div>
          ))}
          {duplicateClasses.length > 20 && (
            <div className="text-ink-400">
              …and {duplicateClasses.length - 20} more duplicate classes
            </div>
          )}
          {duplicateIds.map((dup) => (
            <div key={dup.curseforgeId} className="text-ink-300">
              CurseForge ID <span className="mono">{dup.curseforgeId}</span> is
              on {dup.sourceNames.join(" and ")} — the enabled-mod list would
              repeat it and the watcher can only track one.
            </div>
          ))}
          {duplicateUrls.map((dup) => (
            <div key={dup.url} className="text-ink-300">
              {dup.sourceNames.join(" and ")} point at the same CurseForge page
              (<span className="mono">{dup.url}</span>).
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RowData {
  entry: CatalogEntry;
  /** Set in global search mode: which source the entry belongs to. */
  source: ContentSource;
}

function SourceDetail({
  source,
  isOfficial,
  allSources,
  onUpdate,
  onDelete,
  onMove,
}: {
  source: ContentSource;
  isOfficial: boolean;
  allSources: ContentSource[];
  onUpdate: (patch: Partial<ContentSource>) => void;
  onDelete: () => void;
  onMove: (kind: EntryKind, entryIds: Set<string>, targetId: string) => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const index = useCatalogIndex();
  const [exporting, setExporting] = useState(false);
  const [tab, setTab] = useState<TabKind>("creatures");
  // Entry machinery always needs a concrete kind; the INI tab renders separately.
  const entryTab: EntryKind = tab === "ini" ? "creatures" : tab;
  const [search, setSearch] = useState("");
  const [globalSearch, setGlobalSearch] = useState(false);
  const [mapFilter, setMapFilter] = useState("");
  const [moveMode, setMoveMode] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [addingEntry, setAddingEntry] = useState(false);
  const [groupVariants, setGroupVariants] = useState(true);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [moveTarget, setMoveTarget] = useState("");
  const [spawnFor, setSpawnFor] = useState<CatalogEntry | null>(null);
  const [associationFor, setAssociationFor] = useState<CatalogEntry | null>(null);
  /**
   * The entry whose own record is being edited, with the source it belongs to
   * (for its icon folder) and whether the catalog lets it be changed at all.
   */
  const [entryDataFor, setEntryDataFor] = useState<{
    entry: CatalogEntry;
    sourceId: string;
    editable: boolean;
  } | null>(null);
  const [infoFor, setInfoFor] = useState<CatalogEntry | null>(null);
  /** Read-only summary card, opened from the row's Preview Info marker. */
  const [previewFor, setPreviewFor] = useState<CatalogEntry | null>(null);
  const [notesForEntry, setNotesForEntry] = useState<CatalogEntry | null>(null);
  const [mapFor, setMapFor] = useState<CatalogEntry | null>(null);
  const [docsOpen, setDocsOpen] = useState(false);
  const [discordOpen, setDiscordOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const [asaReviewOpen, setAsaReviewOpen] = useState(false);
  const [wikiImportOpen, setWikiImportOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);

  useEffect(() => {
    setSelection(new Set());
    setSearch("");
    setMoveMode(false);
    setMapFilter("");
  }, [source.id, tab]);

  /** Rows for the current view: selected source, or every source in global mode. */
  const rows: RowData[] = useMemo(() => {
    const q = search.toLowerCase();
    const matches = (entry: CatalogEntry) => {
      if (mapFilter && mapOf(catalog, entry.bpPath) !== mapFilter) return false;
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.bpPath.toLowerCase().includes(q) ||
        mapOf(catalog, entry.bpPath).toLowerCase().includes(q)
      );
    };
    if (globalSearch) {
      // No collection cap: Official ASA alone exceeds any render limit, so
      // capping here would hide every mod. Rendering slices instead.
      const out: RowData[] = [];
      for (const s of allSources) {
        for (const entry of s[entryTab]) {
          if (matches(entry)) out.push({ entry, source: s });
        }
      }
      return out;
    }
    return source[entryTab].filter(matches).map((entry) => ({ entry, source }));
  }, [source, allSources, tab, search, mapFilter, globalSearch, catalog]);

  /** Maps present in the current tab (for the filter dropdown). */
  const mapOptions = useMemo(() => {
    const set = new Set<string>();
    const scan = globalSearch ? allSources : [source];
    for (const s of scan) {
      for (const entry of s[entryTab]) {
        const m = mapOf(catalog, entry.bpPath);
        if (m) set.add(m);
      }
    }
    return [...set].sort();
  }, [source, allSources, tab, globalSearch, catalog]);

  /** Resolves an entry to the creature it is a variant of. */
  function groupBaseFor(entry: CatalogEntry, ownSource: ContentSource) {
    const parentPath =
      catalog.variantParents[normalizeBpPath(entry.bpPath)] ?? null;
    return resolveCreatureBase(entry, {
      parentPath,
      parentName: parentPath
        ? (index.creatures.get(normalizeBpPath(parentPath))?.entry.name ??
          shortClassName(parentPath))
        : undefined,
      variantTag: ownSource.variantTag,
    });
  }

  /**
   * Grouped creature view. Within a single source, variants of the same
   * creature collapse together; in "All sources" mode the same key groups
   * across mods, so every Rex lands under one header.
   */
  const groups = useMemo(() => {
    if (tab !== "creatures" || !groupVariants) return null;
    // Every path some creature has been assigned as its parent. A creature in
    // this set keys its group by its own path, which is how it ends up in the
    // same bucket as the children pointing at it — left to the name-based
    // heuristic it keys by name, and an assigned parent would sit outside the
    // very group it heads.
    const assignedParents = new Set(
      Object.values(catalog.variantParents).map(normalizeBpPath),
    );

    const map = new Map<string, { label: string; bpPath: string | null; rows: RowData[] }>();
    for (const row of rows) {
      const ownKey = normalizeBpPath(row.entry.bpPath);
      const base = assignedParents.has(ownKey)
        ? { key: ownKey, label: row.entry.name, bpPath: row.entry.bpPath }
        : groupBaseFor(row.entry, row.source);
      const bucket = map.get(base.key) ?? {
        label: base.label,
        bpPath: base.bpPath,
        rows: [],
      };
      // The parent names the group, whichever order the rows arrive in.
      if (assignedParents.has(ownKey)) {
        bucket.label = row.entry.name;
        bucket.bpPath = row.entry.bpPath;
      }
      bucket.rows.push(row);
      map.set(base.key, bucket);
    }
    // Within a group the parent comes first and its variants follow in name
    // order: the parent is what the group *is*, and reading "Aberrant
    // Achatina" above "Achatina" inverts the relationship the group exists to
    // show. Everything after the parent is alphabetical, since among siblings
    // there is no other meaningful order.
    for (const bucket of map.values()) {
      const parentKey = bucket.bpPath ? normalizeBpPath(bucket.bpPath) : null;
      const isParent = (row: RowData) =>
        parentKey !== null && normalizeBpPath(row.entry.bpPath) === parentKey;
      bucket.rows.sort((a, b) => {
        if (isParent(a) !== isParent(b)) return isParent(a) ? -1 : 1;
        return a.entry.name.localeCompare(b.entry.name, undefined, {
          sensitivity: "base",
        });
      });
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tab, groupVariants, catalog.variantParents, index]);

  const moveTargets = allSources.filter(
    (s) => s.id !== source.id && s.kind !== "official",
  );
  const cfUrl = sourceCurseforgeUrl(source);
  // Official ASA content belongs to the bundled catalog — moving it out
  // would misrepresent where it came from.
  const showCheckboxes = moveMode && !globalSearch && !isOfficial;

  function setEntries(kind: EntryKind, next: CatalogEntry[]) {
    onUpdate({ [kind]: next });
  }

  function toggleSelected(id: string) {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelection(next);
  }

  /**
   * The icon folder to offer for an entry, by owning source.
   *
   * Only mods have one: bundled Official ASA content is stored as an overlay
   * with nowhere to keep the path, and its art belongs in the project's own
   * images folder anyway.
   */
  function iconFolderFor(sourceId: string): IconFolder | undefined {
    const owner = catalog.sources.find((s) => s.id === sourceId);
    if (!owner) return undefined;
    return {
      label: owner.name,
      dir: owner.iconsDir,
      onChangeDir: (dir) =>
        setCatalog({
          ...catalog,
          sources: catalog.sources.map((s) =>
            s.id === owner.id ? { ...s, iconsDir: dir } : s,
          ),
        }),
    };
  }

  const rowProps = (row: RowData): EntryRowProps => {
    const { entry } = row;
    const ownSource = row.source;
    // Bundled Official ASA content can't be removed; admin-added entries can.
    const editable =
      !globalSearch &&
      (ownSource.kind !== "official" || !isBundledOfficialId(entry.id));
    const mapLabel = mapOf(catalog, entry.bpPath);
    const style = mapLabel ? mapStyle(settings, mapLabel) : null;

    // The row has to describe what an admin would *see* on this creature, and
    // a variant sees its parent's record for every section it hasn't
    // overridden. Summarising the stored child record alone leaves a fully
    // inherited variant looking blank.
    const key = normalizeBpPath(entry.bpPath);
    const base = entryTab === "creatures" ? groupBaseFor(entry, ownSource) : null;
    const infoParent =
      base?.bpPath && normalizeBpPath(base.bpPath) !== key ? base.bpPath : null;
    const resolvedInfo = resolveCreatureInfo(
      catalog.creatureInfo[key],
      infoParent ? catalog.creatureInfo[normalizeBpPath(infoParent)] : undefined,
      infoParent,
    );

    return {
      entry,
      kind: entryTab,
      showCheckbox: showCheckboxes && editable,
      selected: selection.has(entry.id),
      hasInfo:
        entryTab === "items"
          ? hasStoredItemInfo(catalog, entry.bpPath)
          : hasCreatureInfo(resolvedInfo.info) || Boolean(catalog.notes[key]),
      infoInheritedFrom: infoParent && base ? base.label : "",
      infoInheritedFromClass: infoParent ? shortClassName(infoParent) : "",
      // Overrides are what "differs from the parent" means in this model: the
      // child stores only the sections it took ownership of.
      ownInfoDiffers:
        entryTab === "creatures" &&
        infoParent !== null &&
        (catalog.creatureInfo[key]?.overrides.length ?? 0) > 0,
      hasParent: Boolean(catalog.variantParents[normalizeBpPath(entry.bpPath)]),
      mapLabel,
      mapIcon: style?.icon ?? "🗺️",
      mapColor: style?.color ?? "",
      mapDisabled: mapIsDisabled(settings, mapLabel),
      rarity:
        entryTab === "items" ? itemInfoOf(catalog, entry.bpPath).rarity : "",
      sourceBadge: globalSearch ? ownSource.name : null,
      canRemove: editable,
      onToggleSelect: () => toggleSelected(entry.id),
      onSpawn: () => setSpawnFor(entry),
      onAssociation: () => setAssociationFor(entry),
      onEntryData: () =>
        setEntryDataFor({ entry, sourceId: ownSource.id, editable }),
      onInfo: () => setInfoFor(entry),
      onPreview: () => setPreviewFor(entry),
      onMap: () => setMapFor(entry),
      onRemove: () =>
        setEntries(
          entryTab,
          source[entryTab].filter((e) => e.id !== entry.id),
        ),
    };
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            {cfUrl ? (
              <a
                href={cfUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-accent-400 underline decoration-ink-600 underline-offset-2"
              >
                {source.name} ↗
              </a>
            ) : (
              source.name
            )}
            <LinkChip
              url={source.docsUrl}
              icon={<span>📖</span>}
              setLabel="Docs ↗"
              addLabel="Add docs"
              addTitle="Add a wiki / docs link for this mod"
              onEdit={() => setDocsOpen(true)}
            />
            <LinkChip
              url={source.discordUrl}
              icon={<DiscordIcon />}
              setLabel="Discord ↗"
              addLabel="Add Discord"
              addTitle="Add this mod's Discord invite or channel link"
              onEdit={() => setDiscordOpen(true)}
            />
          </span>
        }
        actions={
          !isOfficial && (
            <>
              {/* Enabled lives on the badge in the mod list, and update
                  watching now follows it — a mod you run is a mod you want to
                  know about, and the two were always set together. */}
              <Toggle
                checked={source.removed}
                onChange={(v) => onUpdate({ removed: v })}
                label="Being removed"
              />
              <Button
                onClick={() => setExporting(true)}
                title="Save this mod's catalogued content as a shareable modpack"
              >
                Export modpack…
              </Button>
              <Button variant="danger" onClick={onDelete}>
                Delete
              </Button>
            </>
          )
        }
      >
        {isOfficial ? (
          <p className="text-xs text-ink-400">
            {source.notes} — bundled content is read-only, but you can add
            missing creatures and items below.
          </p>
        ) : (
          <div className="grid grid-cols-5 gap-3">
            <Field label="Mod name">
              <Input
                value={source.name}
                onChange={(e) => onUpdate({ name: e.target.value })}
              />
            </Field>
            <Field
              label="Variant tag"
              hint="Stripped when grouping variants (e.g. ARKOLOGY, Tek)"
            >
              <div className="flex gap-1.5">
                <Input
                  value={source.variantTag}
                  onChange={(e) => onUpdate({ variantTag: e.target.value })}
                  placeholder="none"
                />
                <Button
                  onClick={() => {
                    const detected = detectSourceTag(source);
                    if (!detected) {
                      toast.info("No shared tag detected across this mod's creatures");
                      return;
                    }
                    onUpdate({ variantTag: detected });
                    toast.success(`Detected variant tag "${detected}"`);
                  }}
                  title="Detect a tag shared by this mod's creatures"
                >
                  Detect
                </Button>
              </div>
            </Field>
            <CurseforgeIdField
              source={source}
              modSources={catalog.sources}
              onUpdate={onUpdate}
            />
            <Field label="Mod page URL">
              <Input
                value={source.url}
                onChange={(e) => onUpdate({ url: e.target.value })}
                placeholder="https://www.curseforge.com/…"
              />
            </Field>
            <Field
              label="Notes"
              hint={
                source.notes.trim()
                  ? `${source.notes.trim().split(/\s+/).length} words recorded`
                  : "Nothing recorded yet"
              }
            >
              <Button
                className="w-full"
                onClick={() => setNotesOpen(true)}
                title={source.notes.trim() || "Add notes about this mod"}
              >
                {source.notes.trim() ? "Notes •" : "Notes…"}
              </Button>
            </Field>
          </div>
        )}
        {!isOfficial && (
          <div className="flex items-center gap-2 mt-3 text-xs text-ink-400 min-w-0">
            <span className="font-semibold uppercase tracking-wide text-ink-300 shrink-0">
              Icon folder
            </span>
            <span className="mono truncate" title={source.iconsDir}>
              {source.iconsDir || "not set"}
            </span>
            <Button
              className="shrink-0"
              onClick={async () => {
                const dir = await pickFolder(`Icon folder for ${source.name}`);
                if (dir) onUpdate({ iconsDir: dir });
              }}
            >
              {source.iconsDir ? "Change…" : "Choose…"}
            </Button>
            {source.iconsDir && (
              <Button
                variant="ghost"
                className="shrink-0"
                onClick={() => onUpdate({ iconsDir: "" })}
              >
                Clear
              </Button>
            )}
            <span className="shrink-0">
              — this mod's own art, searched by its entries' icon pickers
              alongside the images folder.
            </span>
          </div>
        )}
        {source.removed && (
          <p className="text-xs text-red-400 mt-3">
            This source is marked as being removed. Production rules and remap
            sources that reference its creatures will show warnings.
          </p>
        )}
      </Card>

      <Card
        title={
          <span className="flex items-center gap-3">
            {(["creatures", "items"] as const).map((kind) => (
              <button
                key={kind}
                onClick={() => setTab(kind)}
                className={cx(
                  "cursor-pointer capitalize pb-0.5 border-b-2",
                  tab === kind
                    ? "text-white border-accent-500"
                    : "text-ink-400 border-transparent hover:text-ink-200",
                )}
              >
                {kind} ({source[kind].length})
              </button>
            ))}
            <button
              onClick={() => setTab("ini")}
              className={cx(
                "cursor-pointer pb-0.5 border-b-2",
                tab === "ini"
                  ? "text-white border-accent-500"
                  : "text-ink-400 border-transparent hover:text-ink-200",
              )}
            >
              INI settings ({source.iniSettings.length})
            </button>
          </span>
        }
        actions={
          tab === "ini" || globalSearch ? null : (
            // Six buttons competed for attention when only one is used often.
            // Adding an entry stays a button; the rest are occasional jobs and
            // live behind one menu. Move mode is the exception — while it is
            // on, the whole list looks different, so the way out has to be
            // visible rather than one level down.
            <>
              {moveMode && (
                <Button
                  variant="primary"
                  onClick={() => {
                    setMoveMode(false);
                    setSelection(new Set());
                    setMoveTarget("");
                  }}
                >
                  Done moving
                </Button>
              )}
              <MenuButton
                label="Tools"
                title={`Bulk and maintenance actions for these ${entryTab}`}
                items={[
                  ...(!isOfficial && !moveMode
                    ? [
                        {
                          label: "Move to another mod…",
                          hint: "Select entries and move them",
                          onSelect: () => {
                            setMoveMode(true);
                            setSelection(new Set());
                            setMoveTarget("");
                          },
                        },
                      ]
                    : []),
                  {
                    label: "Bulk import…",
                    hint: "Paste a list of names and paths",
                    onSelect: () => setBulkOpen(true),
                  },
                  ...(tab === "creatures"
                    ? [
                        {
                          label: "Import from wiki…",
                          hint: "Stage acquisition info for review",
                          onSelect: () => setWikiImportOpen(true),
                        },
                      ]
                    : []),
                  ...(tab === "creatures" && !isOfficial
                    ? [
                        {
                          label: "Clean up names…",
                          hint: "Rebuild importer-derived names",
                          onSelect: () => setCleanupOpen(true),
                        },
                      ]
                    : []),
                  ...(isOfficial
                    ? [
                        {
                          label: "Review ASA…",
                          hint: "Confirm which bundled entries exist in ASA",
                          onSelect: () => setAsaReviewOpen(true),
                        },
                      ]
                    : []),
                ]}
              />
              <Button variant="primary" onClick={() => setAddingEntry(true)}>
                + Add {tab === "creatures" ? "creature" : "item"}
              </Button>
            </>
          )
        }
      >
        {tab === "ini" ? (
          <IniSettingsPanel source={source} onChange={onUpdate} />
        ) : (
          <>
        <div className="flex items-center gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                globalSearch
                  ? `Search ${tab} across ALL sources…`
                  : `Search ${source[entryTab].length} ${entryTab}…`
              }
            />
          </div>
          {/* View options belong with the list they change, not up in the
              header among the actions that alter data. */}
          {tab === "creatures" && !globalSearch && (
            <span className="shrink-0">
              <Toggle
                checked={groupVariants}
                onChange={setGroupVariants}
                label="Group variants"
              />
            </span>
          )}
          <span className="shrink-0">
            <Toggle
              checked={globalSearch}
              onChange={(v) => {
                setGlobalSearch(v);
                setMoveMode(false);
                setSelection(new Set());
              }}
              label="All sources"
            />
          </span>
          {mapOptions.length > 0 && (
            <div className="w-48 shrink-0">
              <Select
                value={mapFilter}
                onChange={(e) => setMapFilter(e.target.value)}
              >
                <option value="">All maps</option>
                {mapOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        {showCheckboxes && (
          <div className="flex items-center gap-2 mb-3 px-3 py-2 bg-ink-800 border border-ink-600 rounded-md">
            <span className="text-sm text-ink-200">
              {selection.size} selected — pick entries below, then choose a
              destination
            </span>
            <Select
              className="w-64"
              value={moveTarget}
              onChange={(e) => setMoveTarget(e.target.value)}
            >
              <option value="">Move to…</option>
              {moveTargets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Button
              variant="primary"
              disabled={!moveTarget || selection.size === 0}
              onClick={() => {
                onMove(tab, selection, moveTarget);
                setSelection(new Set());
                setMoveTarget("");
                setMoveMode(false);
              }}
            >
              Move
            </Button>
            <Button variant="ghost" onClick={() => setSelection(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {rows.length === 0 ? (
          <EmptyState title={search || mapFilter ? "No matches" : `No ${tab} yet`}>
            {!search && !mapFilter && "Add entries manually or use bulk import."}
          </EmptyState>
        ) : (
          <div className="max-h-[calc(100vh-420px)] overflow-y-auto flex flex-col divide-y divide-ink-800">
            {groups
              ? groups.slice(0, 300).map((group) =>
                  group.rows.length === 1 ? (
                    <EntryRow
                      key={group.rows[0].entry.id}
                      {...rowProps(group.rows[0])}
                    />
                  ) : (
                    <VariantGroup
                      key={group.label + group.rows.length}
                      base={group.label}
                      baseBpPath={group.bpPath}
                      rows={group.rows}
                      kind={entryTab}
                      rowProps={rowProps}
                    />
                  ),
                )
              : rows
                  .slice(0, 500)
                  .map((row) => <EntryRow key={`${row.source.id}-${row.entry.id}`} {...rowProps(row)} />)}
          </div>
        )}
          </>
        )}
      </Card>

      {bulkOpen && (
        <BulkImportModal
          kind={entryTab}
          onClose={() => setBulkOpen(false)}
          onImport={(imported) => {
            // Checked against every source, not just this one — the same class
            // catalogued under two mods is what makes the picker ambiguous.
            const plan = planEntryInsert(
              buildEntryOwners(allSources, entryTab),
              imported,
            );
            setEntries(entryTab, [...source[entryTab], ...plan.accepted]);
            setBulkOpen(false);
            const inBatch = plan.skipped.filter((s) => s.reason === "batch").length;
            const inCatalog = plan.skipped.length - inBatch;
            toast.success(
              `Imported ${plural(
                plan.accepted.length,
                entryTab === "creatures" ? "creature" : "item",
              )}` +
                (plan.skipped.length > 0
                  ? ` — ${plan.skipped.length} skipped (${[
                      inCatalog > 0 && `${inCatalog} already in the catalog`,
                      inBatch > 0 && `${inBatch} repeated in this paste`,
                    ]
                      .filter(Boolean)
                      .join(", ")})`
                  : ""),
            );
            // Name the first collision so "skipped" is actionable rather than
            // just a number.
            const firstCatalogClash = plan.skipped.find(
              (s) => s.reason === "catalog",
            );
            if (firstCatalogClash) {
              toast.info(
                `${firstCatalogClash.entry.name} is already ${firstCatalogClash.conflictsWith}`,
              );
            }
          }}
        />
      )}

      {addingEntry && (
        <AddEntryModal
          kind={entryTab}
          // Live check as the path is typed, so the conflict is visible before
          // the Add button is ever pressed.
          findConflict={(bpPath) =>
            findEntryOwner(buildEntryOwners(allSources, entryTab), bpPath)
          }
          onClose={() => setAddingEntry(false)}
          onAdd={(entry) => {
            setEntries(entryTab, [...source[entryTab], entry]);
            setAddingEntry(false);
          }}
        />
      )}

      {spawnFor && (
        <SpawnCommandModal
          entry={spawnFor}
          kind={entryTab}
          onClose={() => setSpawnFor(null)}
        />
      )}

      {associationFor && (
        <AssociationModal
          entry={associationFor}
          onClose={() => setAssociationFor(null)}
        />
      )}

      {entryDataFor && (
        <EntryDataModal
          entry={entryDataFor.entry}
          kind={entryTab}
          editable={entryDataFor.editable}
          iconFolder={iconFolderFor(entryDataFor.sourceId)}
          findConflict={(bpPath) => {
            const owner = findEntryOwner(
              buildEntryOwners(allSources, entryTab),
              bpPath,
            );
            // The entry's own record is not a conflict with itself.
            return owner && owner.entry.id !== entryDataFor.entry.id
              ? { label: describeOwner(owner) }
              : null;
          }}
          onSave={(next) =>
            setEntries(
              entryTab,
              source[entryTab].map((e) => (e.id === next.id ? next : e)),
            )
          }
          onClose={() => setEntryDataFor(null)}
        />
      )}

      {infoFor &&
        (entryTab === "items" ? (
          <ItemInfoModal entry={infoFor} onClose={() => setInfoFor(null)} />
        ) : (
          <CreatureDetailsModal
            entry={infoFor}
            onClose={() => setInfoFor(null)}
          />
        ))}

      {previewFor &&
        (entryTab === "items" ? (
          <ItemPreviewModal
            entry={previewFor}
            onClose={() => setPreviewFor(null)}
            onEdit={() => {
              setInfoFor(previewFor);
              setPreviewFor(null);
            }}
          />
        ) : (
          <CreaturePreviewModal
            entry={previewFor}
            onClose={() => setPreviewFor(null)}
            onEdit={() => {
              setInfoFor(previewFor);
              setPreviewFor(null);
            }}
          />
        ))}

      {notesForEntry && (
        <InfoModal
          entry={notesForEntry}
          onClose={() => setNotesForEntry(null)}
        />
      )}

      {exporting && (
        <ExportModpackModal
          source={source}
          registry={settings?.modpackRegistry ?? defaultModpackRegistry()}
          onClose={() => setExporting(false)}
        />
      )}

      {mapFor && (
        <MapOfOriginModal entry={mapFor} onClose={() => setMapFor(null)} />
      )}

      {docsOpen && (
        <LinkModal
          title={`Docs link — ${source.name}`}
          blurb="A second reference link for this mod: its wiki, a Google Doc, a spawn code sheet — anything you want one click away."
          current={source.docsUrl}
          placeholder="https://…"
          savedLabel="Docs link"
          onClose={() => setDocsOpen(false)}
          onSave={(url) => onUpdate({ docsUrl: url })}
        />
      )}

      {discordOpen && (
        <LinkModal
          title={`Discord — ${source.name}`}
          blurb="The mod's Discord: an invite link, or a deep link straight to its support or changelog channel."
          current={source.discordUrl}
          placeholder="https://discord.gg/…"
          savedLabel="Discord link"
          onClose={() => setDiscordOpen(false)}
          onSave={(url) => onUpdate({ discordUrl: url })}
        />
      )}

      {notesOpen && (
        <SourceNotesModal
          source={source}
          onClose={() => setNotesOpen(false)}
          onSave={(text) => onUpdate({ notes: text })}
        />
      )}

      {asaReviewOpen && (
        <AsaReviewModal onClose={() => setAsaReviewOpen(false)} />
      )}

      {wikiImportOpen && (
        <WikiImportModal onClose={() => setWikiImportOpen(false)} />
      )}


      {cleanupOpen && (
        <NameCleanupModal
          source={source}
          onClose={() => setCleanupOpen(false)}
          onApply={(renames) => {
            onUpdate({
              creatures: source.creatures.map((e) =>
                renames.has(e.id) ? { ...e, name: renames.get(e.id)! } : e,
              ),
            });
            setCleanupOpen(false);
            toast.success(`Renamed ${renames.size} creatures`);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Reviewable bulk rename: rebuilds importer-derived names from the resolved
 * official creature. Nothing is applied until the admin confirms, and each
 * row can be excluded.
 */
function NameCleanupModal({
  source,
  onApply,
  onClose,
}: {
  source: ContentSource;
  onApply: (renames: Map<string, string>) => void;
  onClose: () => void;
}) {
  const proposals = useMemo(() => {
    const used = new Set(source.creatures.map((e) => e.name.toLowerCase()));
    const out: { entry: CatalogEntry; proposed: string }[] = [];
    for (const entry of source.creatures) {
      let proposed = proposeCleanName(entry, source.variantTag);
      if (!proposed) continue;
      // Avoid colliding with a name already in this source.
      if (used.has(proposed.toLowerCase()) && source.variantTag) {
        proposed = `${proposed} (${source.variantTag})`;
      }
      if (used.has(proposed.toLowerCase())) continue;
      used.add(proposed.toLowerCase());
      out.push({ entry, proposed });
    }
    return out;
  }, [source]);

  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  }

  const applyCount = proposals.length - excluded.size;

  return (
    <Modal title={`Clean up names — ${source.name}`} onClose={onClose} wide>
      {proposals.length === 0 ? (
        <EmptyState title="Nothing to clean up">
          Every creature here already resolves to a sensible name.
        </EmptyState>
      ) : (
        <>
          <p className="text-xs text-ink-400 mb-3">
            Names rebuilt from the matching official creature — useful after
            importing a live file, where names are derived from blueprint
            paths. Untick anything you want to keep as-is.
            {!source.variantTag && (
              <> Setting a variant tag first produces better results.</>
            )}
          </p>
          <div className="max-h-[55vh] overflow-y-auto flex flex-col divide-y divide-ink-800">
            {proposals.map(({ entry, proposed }) => (
              <label
                key={entry.id}
                className="flex items-center gap-3 py-2 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={!excluded.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  className="accent-(--color-accent-500) w-4 h-4 shrink-0"
                />
                <span className="text-sm text-ink-400 line-through truncate w-[40%]">
                  {entry.name}
                </span>
                <span className="text-ink-500">→</span>
                <span className="text-sm text-ink-100 font-medium truncate flex-1">
                  {proposed}
                </span>
              </label>
            ))}
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={applyCount === 0}
              onClick={() =>
                onApply(
                  new Map(
                    proposals
                      .filter((p) => !excluded.has(p.entry.id))
                      .map((p) => [p.entry.id, p.proposed]),
                  ),
                )
              }
            >
              Rename {applyCount}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

type AsaFilter = "all" | "unreviewed" | "confirmed" | "absent";

/**
 * ASA availability review of the bundled official catalog.
 *
 * The bundled dataset comes from a wiki that documents both ASE and ASA, so it
 * carries entries that never made the jump (the Electrical Outlet and friends).
 * There is no marker on the wiki that separates them, so this is a review
 * surface rather than an automatic filter: verdicts can be set by hand, or in
 * bulk by diffing against a known-good list exported from the actual server.
 * Nothing is deleted — `absent` entries are hidden and stay recoverable.
 */
function AsaReviewModal({ onClose }: { onClose: () => void }) {
  const { catalog, setCatalog } = useDraftsStore();
  const [kind, setKind] = useState<EntryKind>("items");
  const [filter, setFilter] = useState<AsaFilter>("all");
  const [search, setSearch] = useState("");
  const [importOpen, setImportOpen] = useState(false);

  const full = useMemo(() => officialWithAbsent(catalog), [catalog]);
  const review = catalog.official.asaReview;

  const entries = full[kind];
  const counts = useMemo(() => {
    let confirmed = 0;
    let absent = 0;
    for (const entry of entries) {
      const verdict = review[normalizeBpPath(entry.bpPath)];
      if (verdict === "confirmed") confirmed++;
      else if (verdict === "absent") absent++;
    }
    return {
      confirmed,
      absent,
      unreviewed: entries.length - confirmed - absent,
      total: entries.length,
    };
  }, [entries, review]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((entry) => {
      const verdict = review[normalizeBpPath(entry.bpPath)];
      if (filter === "unreviewed" && verdict) return false;
      if (filter === "confirmed" && verdict !== "confirmed") return false;
      if (filter === "absent" && verdict !== "absent") return false;
      if (!q) return true;
      return (
        entry.name.toLowerCase().includes(q) ||
        entry.bpPath.toLowerCase().includes(q)
      );
    });
  }, [entries, review, filter, search]);

  function setVerdicts(paths: string[], verdict: AsaVerdict | null) {
    const next = { ...review };
    for (const path of paths) {
      const key = normalizeBpPath(path);
      if (verdict) next[key] = verdict;
      else delete next[key];
    }
    setCatalog({
      ...catalog,
      official: { ...catalog.official, asaReview: next },
    });
  }

  async function markAllShown(verdict: AsaVerdict) {
    if (shown.length === 0) return;
    if (verdict === "absent") {
      const ok = await confirmDialog({
        title: `Mark ${plural(shown.length, kind === "items" ? "item" : "creature")} as not in ASA?`,
        message:
          "They disappear from Content Sources and every picker. Production rules and remaps still referencing them will start showing missing-content warnings.",
        details: [
          "Reversible — filter to \"Not in ASA\" here and set them back.",
        ],
        confirmLabel: "Mark not in ASA",
        danger: true,
      });
      if (!ok) return;
    }
    setVerdicts(shown.map((e) => e.bpPath), verdict);
    toast.success(
      `${shown.length} ${kind} marked ${verdict === "absent" ? "not in ASA" : "confirmed"}`,
    );
  }

  return (
    <Modal title="ASA availability review" onClose={onClose} xl>
      <p className="text-xs text-ink-400 mb-3">
        The bundled catalog is compiled from a wiki that documents both ASE and
        ASA, so some entries — the Electrical Outlet, for one — never shipped to
        ASA. Nothing on the wiki marks them, so confirm them here. The quickest
        route is a known-good list pulled from your own server; anything it
        doesn't mention gets flagged for you to review.
      </p>

      <div className="flex items-center gap-3 mb-3">
        <span className="flex items-center gap-3 shrink-0">
          {(["items", "creatures"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={cx(
                "cursor-pointer capitalize pb-0.5 border-b-2 text-sm",
                kind === k
                  ? "text-white border-accent-500"
                  : "text-ink-400 border-transparent hover:text-ink-200",
              )}
            >
              {k}
            </button>
          ))}
        </span>
        <div className="flex-1 min-w-0">
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={`Search ${counts.total} ${kind}…`}
          />
        </div>
        <div className="w-44 shrink-0">
          <Select
            value={filter}
            onChange={(e) => setFilter(e.target.value as AsaFilter)}
          >
            <option value="all">All ({counts.total})</option>
            <option value="unreviewed">Unreviewed ({counts.unreviewed})</option>
            <option value="confirmed">In ASA ({counts.confirmed})</option>
            <option value="absent">Not in ASA ({counts.absent})</option>
          </Select>
        </div>
        <Button className="shrink-0" onClick={() => setImportOpen(true)}>
          Import known-good list…
        </Button>
      </div>

      <div className="flex items-center gap-2 mb-3 text-xs text-ink-400">
        <span>
          {shown.length} shown
          {shown.length > 0 && shown.length !== counts.total && " (filtered)"}
        </span>
        {shown.length > 0 && (
          <>
            <span className="text-ink-600">·</span>
            <button
              onClick={() => markAllShown("confirmed")}
              className="cursor-pointer hover:text-accent-400"
            >
              Mark all shown in ASA
            </button>
            <span className="text-ink-600">·</span>
            <button
              onClick={() => markAllShown("absent")}
              className="cursor-pointer hover:text-red-400"
            >
              Mark all shown not in ASA
            </button>
            <span className="text-ink-600">·</span>
            <button
              onClick={() => setVerdicts(shown.map((e) => e.bpPath), null)}
              className="cursor-pointer hover:text-ink-200"
            >
              Clear verdicts
            </button>
          </>
        )}
      </div>

      {shown.length === 0 ? (
        <EmptyState title="Nothing to review here" />
      ) : (
        <div className="max-h-[50vh] overflow-y-auto flex flex-col divide-y divide-ink-800 border border-ink-700 rounded-lg">
          {shown.slice(0, 400).map((entry) => {
            const verdict = review[normalizeBpPath(entry.bpPath)];
            return (
              <div
                key={entry.id}
                className="flex items-center gap-3 px-3 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-100 truncate">
                    {entry.name}
                    <span className="text-xs text-ink-500 ml-2">
                      {officialCategories.get(normalizeBpPath(entry.bpPath)) ??
                        ""}
                    </span>
                  </div>
                  <div className="mono text-xs text-ink-500 truncate" title={entry.bpPath}>
                    {shortClassName(entry.bpPath)}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {(
                    [
                      ["confirmed", "In ASA"],
                      ["absent", "Not in ASA"],
                    ] as const
                  ).map(([value, label]) => (
                    <button
                      key={value}
                      onClick={() =>
                        setVerdicts(
                          [entry.bpPath],
                          verdict === value ? null : value,
                        )
                      }
                      className={cx(
                        "text-xs px-2 py-0.5 rounded-md border cursor-pointer",
                        verdict === value
                          ? value === "confirmed"
                            ? "bg-accent-500/15 text-accent-400 border-accent-500/40"
                            : "bg-danger/15 text-red-400 border-danger/40"
                          : "border-ink-700 text-ink-500 hover:text-ink-200 hover:border-ink-600",
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          {shown.length > 400 && (
            <p className="text-xs text-ink-500 px-3 py-2">
              Showing the first 400 — narrow the search to reach the rest.
            </p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-ink-400">
          {counts.confirmed} in ASA · {counts.absent} hidden as not in ASA ·{" "}
          {counts.unreviewed} unreviewed
        </span>
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      </div>

      {importOpen && (
        <AsaListImportModal
          entries={entries}
          kind={kind}
          onClose={() => setImportOpen(false)}
          onApply={(confirmed, absent) => {
            const next = { ...review };
            for (const path of confirmed) next[normalizeBpPath(path)] = "confirmed";
            for (const path of absent) next[normalizeBpPath(path)] = "absent";
            setCatalog({
              ...catalog,
              official: { ...catalog.official, asaReview: next },
            });
            setImportOpen(false);
            toast.success(
              `${confirmed.length} confirmed, ${absent.length} flagged as not in ASA`,
            );
          }}
        />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * Diffs the bundled catalog against a list of what the server actually has.
 * Matching is lenient — blueprint paths and bare class names both work, since
 * every practical source of truth (a spawn-code sheet, a dev-kit dump, an
 * in-game item list) emits one or the other.
 */
function AsaListImportModal({
  entries,
  kind,
  onApply,
  onClose,
}: {
  entries: CatalogEntry[];
  kind: EntryKind;
  onApply: (confirmed: string[], absent: string[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [flagUnmatched, setFlagUnmatched] = useState(true);

  const result = useMemo(() => {
    const paths = new Set<string>();
    const classes = new Set<string>();
    let lines = 0;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim().replace(/^["']|["'],?$/g, "");
      if (!line) continue;
      lines++;
      if (line.includes("/")) paths.add(normalizeBpPath(line));
      // A path's own class stem counts too, so either column of a sheet works.
      classes.add(shortClassName(line).toLowerCase());
    }
    const confirmed: string[] = [];
    const unmatched: string[] = [];
    for (const entry of entries) {
      const hit =
        paths.has(normalizeBpPath(entry.bpPath)) ||
        classes.has(shortClassName(entry.bpPath).toLowerCase());
      (hit ? confirmed : unmatched).push(entry.bpPath);
    }
    return { confirmed, unmatched, lines };
  }, [text, entries]);

  return (
    <Modal title={`Import known-good ASA ${kind}`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-3">
        Paste what your server actually has — one blueprint path or class name
        per line. Anything the list mentions is confirmed; the rest can be
        flagged for review in one go.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        autoFocus
        className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 mono text-ink-100 focus:outline-none focus:border-accent-500/60"
        placeholder={
          kind === "items"
            ? "PrimalItemResource_Fiber_C\nPrimalItemResource_Metal_C\n/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Wood.PrimalItemResource_Wood"
            : "Rex_Character_BP_C\nDodo_Character_BP_C"
        }
      />
      <div className="flex items-center justify-between mt-3">
        <div className="text-xs">
          <span className="text-ink-400">{result.lines} lines · </span>
          <span className="text-accent-400">
            {result.confirmed.length} matched
          </span>
          <span className="text-amber-400 ml-3">
            {result.unmatched.length} not in the list
          </span>
        </div>
        <Toggle
          checked={flagUnmatched}
          onChange={setFlagUnmatched}
          label="Flag unmatched as not in ASA"
        />
      </div>
      {result.unmatched.length > 0 && flagUnmatched && result.lines > 0 && (
        <p className="text-xs text-amber-400 mt-2">
          {result.unmatched.length} of {entries.length} {kind} would be hidden.
          If that looks too aggressive, the list is probably partial — turn the
          toggle off and only confirm what matched.
        </p>
      )}
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={result.lines === 0}
          onClick={() =>
            onApply(result.confirmed, flagUnmatched ? result.unmatched : [])
          }
        >
          Apply
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function LinkModal({
  title,
  blurb,
  current,
  placeholder,
  savedLabel,
  onSave,
  onClose,
}: {
  title: string;
  blurb: string;
  current: string;
  placeholder: string;
  savedLabel: string;
  onSave: (url: string) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState(current);

  async function saveAndOpen(open: boolean) {
    const trimmed = url.trim();
    onSave(trimmed);
    onClose();
    if (open && trimmed) {
      try {
        await openExternal(trimmed);
      } catch (e) {
        toast.error(`${e instanceof Error ? e.message : e}`);
      }
    } else {
      toast.success(trimmed ? `${savedLabel} saved` : `${savedLabel} cleared`);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-xs text-ink-400 mb-3">{blurb}</p>
      <Field label="URL">
        <Input
          className="mono"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={placeholder}
          autoFocus
        />
      </Field>
      <div className="flex justify-end gap-2 mt-4">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {current && (
          <Button variant="ghost" onClick={() => { setUrl(""); onSave(""); onClose(); }}>
            Remove link
          </Button>
        )}
        <Button onClick={() => saveAndOpen(false)} disabled={!url.trim()}>
          Save
        </Button>
        <Button
          variant="primary"
          onClick={() => saveAndOpen(true)}
          disabled={!url.trim()}
        >
          Save &amp; open
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** Freeform notes about the mod itself — the counterpart to the INI tab's. */
function SourceNotesModal({
  source,
  onSave,
  onClose,
}: {
  source: ContentSource;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(source.notes);
  return (
    <Modal title={`Notes — ${source.name}`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-2">
        Anything worth remembering about this mod: who maintains it, why it's
        on the cluster, balance decisions, things to re-check after an update.
        Config-shaped notes belong on the INI settings tab instead.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={14}
        autoFocus
        className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 text-sm text-ink-100 focus:outline-none focus:border-accent-500/60"
        placeholder={"e.g. Kept for the Tek variants only — vanilla dinos disabled in its config.\nAuthor is responsive on Discord; ping before a major version bump."}
      />
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onSave(text);
            onClose();
            toast.success("Notes saved");
          }}
        >
          Save notes
        </Button>
      </div>
    </Modal>
  );
}


// ---------------------------------------------------------------------------

interface EntryRowProps {
  entry: CatalogEntry;
  kind: EntryKind;
  showCheckbox: boolean;
  selected: boolean;
  hasInfo: boolean;
  hasParent: boolean;
  mapLabel: string;
  mapIcon: string;
  mapColor: string;
  /**
   * The map of origin is switched off for this cluster. The entry is still
   * fully usable — it may well be obtainable on a map that is running — so
   * this only earns a Caution marker, never a filter.
   */
  mapDisabled: boolean;
  /** Items only: the recorded rarity, shown as a colored badge. */
  rarity: string;
  /**
   * Creatures only: the parent this row inherits from, named in the override
   * marker's tooltip. Empty when the record is entirely its own.
   */
  infoInheritedFrom: string;
  /** The parent's short class, for when parent and child share a display name. */
  infoInheritedFromClass: string;
  /**
   * Creatures only: this variant overrides some of what it would otherwise
   * inherit, so its details genuinely differ from its parent's.
   */
  ownInfoDiffers: boolean;
  sourceBadge: string | null;
  canRemove: boolean;
  onToggleSelect: () => void;
  onSpawn: () => void;
  /** Creatures only: parent/child configuration. */
  onAssociation: () => void;
  /** Name, blueprint path, class and icon — the entry's own record. */
  onEntryData: () => void;
  onInfo: () => void;
  /** Creatures only: opens the read-only summary card. */
  onPreview: () => void;
  onMap: () => void;
  onRemove: () => void;
}

function VariantGroup({
  base,
  baseBpPath,
  rows,
  kind,
  rowProps,
}: {
  base: string;
  baseBpPath: string | null;
  rows: RowData[];
  kind: EntryKind;
  rowProps: (row: RowData) => EntryRowProps;
}) {
  const [open, setOpen] = useState(false);
  const primary = rows.find((r) => r.entry.name === base) ?? rows[0];
  // Prefer the resolved base creature's icon so a group of modded variants
  // still shows the vanilla artwork.
  const iconPath = baseBpPath ?? primary.entry.bpPath;
  const sources = new Set(rows.map((r) => r.source.name));
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 py-1.5 cursor-pointer hover:bg-ink-850 rounded px-1"
      >
        <span className={cx("text-xs transition-transform", open && "rotate-90")}>
          ▸
        </span>
        <EntityIcon bpPath={iconPath} kind={kind} name={base} size={60} />
        <span className="text-sm font-medium text-ink-100">{base}</span>
        <Badge tone="neutral">{rows.length} variants</Badge>
        {sources.size > 1 && (
          <Badge tone="info">{sources.size} sources</Badge>
        )}
      </button>
      {open && (
        <div className="ml-7 flex flex-col divide-y divide-ink-800/60 border-l border-ink-700 pl-3 mb-1">
          {rows.map((row) => (
            <EntryRow key={row.entry.id} {...rowProps(row)} />
          ))}
        </div>
      )}
    </div>
  );
}

function EntryRow(props: EntryRowProps) {
  const {
    entry,
    kind,
    showCheckbox,
    selected,
    hasInfo,
    hasParent,
    mapLabel,
    mapIcon,
    mapColor,
    mapDisabled,
    rarity,
    infoInheritedFrom,
    infoInheritedFromClass,
    ownInfoDiffers,
    sourceBadge,
    canRemove,
    onToggleSelect,
    onSpawn,
    onAssociation,
    onEntryData,
    onInfo,
    onPreview,
    onMap,
    onRemove,
  } = props;
  const isCreature = kind === "creatures";
  const noun = isCreature ? "creature" : "item";

  return (
    <div className="flex items-center gap-3 py-2 group relative">
      {showCheckbox && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="shrink-0 accent-(--color-accent-500) w-4 h-4"
          title="Select for move"
        />
      )}
      {/* The icon is the natural handle on an entry, so it opens what's
          recorded about it. Assigning an icon lives in Edit → Entry data. */}
      <button
        onClick={onPreview}
        title={`See what's recorded for this ${noun}`}
        className="cursor-pointer hover:scale-105 transition-transform shrink-0"
      >
        <EntityIcon bpPath={entry.bpPath} kind={kind} name={entry.name} size={60} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink-100 flex items-center gap-1.5">
          <span className="truncate font-medium">{entry.name}</span>
          {hasInfo && (
            <span
              className="text-ink-500 shrink-0"
              title={
                isCreature
                  ? "Information is recorded for this creature — click its icon to see it"
                  : "Information is recorded for this item — click its icon to see it"
              }
            >
              <InfoMark />
            </span>
          )}
          {ownInfoDiffers && (
            <span
              className="text-accent-400/80 shrink-0"
              title={
                // A modded creature often carries its parent's exact name, so
                // the name alone would read as "differs from itself".
                infoInheritedFrom && infoInheritedFrom !== entry.name
                  ? `This variant defines its own details rather than following ${infoInheritedFrom}`
                  : `This variant defines its own details rather than following its parent${infoInheritedFromClass ? ` (${infoInheritedFromClass})` : ""}`
              }
            >
              <OverrideMark />
            </span>
          )}
          {rarity && (
            <span
              className="text-xs px-1.5 py-0.5 rounded-full border shrink-0"
              style={{
                color: RARITY_COLOR[rarity] ?? undefined,
                borderColor: `${RARITY_COLOR[rarity] ?? "#6b7280"}55`,
              }}
            >
              {rarity}
            </span>
          )}
          {sourceBadge && <Badge tone="neutral">{sourceBadge}</Badge>}
        </div>
        <div className="mono text-ink-400 truncate" title={entry.bpPath}>
          {shortClassName(entry.bpPath)}
        </div>
        <div className="flex items-center gap-3 mt-0.5">
          {mapLabel && (
            <div
              className="text-xs flex items-center gap-1"
              style={{ color: mapColor || undefined }}
            >
              <IconValue icon={mapIcon} size={14} />
              <span className={mapColor ? "" : "text-ink-400"}>{mapLabel}</span>
            </div>
          )}
          {mapDisabled && (
            <span
              className="shrink-0"
              title={`${mapLabel} is switched off for this cluster. This entry is still available — it may be obtainable on a map you do run — but check before promising it.`}
            >
              <Badge tone="warn">Caution</Badge>
            </span>
          )}
        </div>
      </div>
      {/* focus-within keeps these from being reachable-but-invisible by keyboard. */}
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 shrink-0">
        <Button variant="ghost" onClick={onSpawn}>
          Spawn…
        </Button>
        {/* One Edit menu rather than a row of hover buttons: the row is
            scanned far more often than it is edited, and the actions it used
            to carry read as equal choices when only two ever get used.
            Creatures and items differ only in what the menu contains. */}
        <MenuButton
          label="Edit"
          title={`Edit ${entry.name}`}
          items={[
            {
              label: "Entry data…",
              hint: "Name, blueprint path, class, icon",
              onSelect: onEntryData,
            },
            {
              label: "Edit info…",
              hint: isCreature
                ? "Acquisition, spawns, abilities, drops"
                : "Type, rarity, stack size, viewer notes",
              onSelect: onInfo,
            },
            ...(isCreature
              ? [
                  {
                    label: "Association…",
                    hint: hasParent
                      ? "Child of another creature"
                      : "Parent class",
                    onSelect: onAssociation,
                  },
                ]
              : [
                  // An item has no parent/child relationship, so its map of
                  // origin takes that slot rather than living on the row.
                  {
                    label: "Map of origin…",
                    hint: mapLabel || "Not set",
                    onSelect: onMap,
                  },
                ]),
            ...(canRemove
              ? [
                  {
                    label: "Remove from catalog",
                    onSelect: onRemove,
                    danger: true,
                  },
                ]
              : []),
          ]}
        />
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------

function CommandRow({ cmd }: { cmd: SpawnCommand }) {
  return (
    <div className="border border-ink-700 rounded-md p-2.5 bg-ink-850">
      <div className="flex items-center justify-between mb-1">
        <div>
          <span className="text-sm font-medium text-ink-100">{cmd.label}</span>
          <span className="text-xs text-ink-400 ml-2">{cmd.hint}</span>
        </div>
        <Button
          variant="primary"
          disabled={Boolean(cmd.warning)}
          onClick={() => {
            navigator.clipboard.writeText(cmd.command);
            toast.success("Command copied");
          }}
        >
          Copy
        </Button>
      </div>
      <div className="mono text-ink-300 break-all select-all">{cmd.command}</div>
      {cmd.warning && (
        <div className="text-xs text-amber-400 mt-1">{cmd.warning}</div>
      )}
    </div>
  );
}

function SpawnCommandModal({
  entry,
  kind,
  onClose,
}: {
  entry: CatalogEntry;
  kind: EntryKind;
  onClose: () => void;
}) {
  const [creatureParams, setCreatureParams] = useState(DEFAULT_CREATURE_PARAMS);
  const [itemParams, setItemParams] = useState(DEFAULT_ITEM_PARAMS);
  const roster = useDraftsStore((s) => s.players.players);

  const otherIdKind: PlayerIdKind =
    creatureParams.playerIdKind === "playerId" ? "eosId" : "playerId";

  /**
   * Switches which identifier `-p=` carries, keeping the same player.
   *
   * The two ids are never interchangeable, so the value cannot simply carry
   * over — but making the admin find the player again to say the same thing a
   * different way is busywork. When the roster knows who the current value
   * belongs to, their other id is filled in; otherwise the field clears rather
   * than leave a value that looks right and is not.
   */
  function swapIdentifierKind() {
    const current = creatureParams.playerId.trim();
    const match = current
      ? roster.find(
          (p) => p[creatureParams.playerIdKind].trim() === current,
        )
      : undefined;
    const swapped = match?.[otherIdKind].trim() ?? "";
    setCreatureParams({
      ...creatureParams,
      playerIdKind: otherIdKind,
      playerId: swapped,
    });
    if (match && !swapped) {
      toast.info(
        `${playerLabel(match)} has no ${PLAYER_ID_KIND_LABELS[otherIdKind]} on record`,
      );
    }
  }

  const commands =
    kind === "creatures"
      ? buildCreatureCommands(entry.bpPath, creatureParams)
      : buildItemCommands(entry.bpPath, itemParams);

  const num = (v: string, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };

  return (
    <Modal title={`Spawn commands — ${entry.name}`} onClose={onClose} wide>
      {kind === "creatures" ? (
        <div className="grid grid-cols-4 gap-3 mb-4">
          <Field label="Level">
            <Input
              type="number"
              min={1}
              value={creatureParams.level}
              onChange={(e) =>
                setCreatureParams({
                  ...creatureParams,
                  level: num(e.target.value, 150),
                })
              }
            />
          </Field>
          <Field
            // Only the words switch the identifier — without this the whole
            // field, input padding and hint included, was one big toggle.
            interactiveLabel
            // The label *is* the switch: there are only two identifiers, so a
            // pair of extra buttons was two controls to say one thing.
            label={
              <button
                type="button"
                onClick={swapIdentifierKind}
                title={`Showing ${PLAYER_ID_KIND_LABELS[creatureParams.playerIdKind]} — click to switch to ${PLAYER_ID_KIND_LABELS[otherIdKind]}`}
                className="inline-flex items-center gap-1 cursor-pointer hover:text-accent-400 transition-colors"
              >
                {PLAYER_ID_KIND_LABELS[creatureParams.playerIdKind]}
                <span aria-hidden>⇄</span>
              </button>
            }
            hint="For the Dino Depot ball command (-p=)"
          >
            <PlayerFieldInput
              field={creatureParams.playerIdKind}
              value={creatureParams.playerId}
              onChange={(playerId) =>
                setCreatureParams({ ...creatureParams, playerId })
              }
              placeholder={
                creatureParams.playerIdKind === "playerId"
                  ? "e.g. 735008833"
                  : "e.g. 0002fe9c…"
              }
            />
          </Field>
          <Field label="Dino name" hint="Optional (-n=)">
            <Input
              value={creatureParams.dinoName}
              onChange={(e) =>
                setCreatureParams({ ...creatureParams, dinoName: e.target.value })
              }
            />
          </Field>
          <div className="flex flex-col gap-2 pt-5">
            <Toggle
              checked={creatureParams.tamed}
              onChange={(v) => setCreatureParams({ ...creatureParams, tamed: v })}
              label="Tamed"
            />
            <Toggle
              checked={creatureParams.female}
              onChange={(v) => setCreatureParams({ ...creatureParams, female: v })}
              label="Female"
            />
            <Toggle
              checked={creatureParams.neutered}
              onChange={(v) =>
                setCreatureParams({ ...creatureParams, neutered: v })
              }
              label="Neutered"
            />
          </div>
          <Field label="Imprint (0–1)">
            <Input
              type="number"
              min={0}
              max={1}
              step="0.05"
              value={creatureParams.imprint}
              onChange={(e) =>
                setCreatureParams({
                  ...creatureParams,
                  imprint: num(e.target.value, 1),
                })
              }
            />
          </Field>
          <Field label="Age (0–1)">
            <Input
              type="number"
              min={0}
              max={1}
              step="0.05"
              value={creatureParams.age}
              onChange={(e) =>
                setCreatureParams({ ...creatureParams, age: num(e.target.value, 1) })
              }
            />
          </Field>
          {/* Three buttons rather than three panels: most spawns set none of
              these, and the ones that do are edited in a dropdown. */}
          <div className="col-span-2 flex items-center gap-2 pt-5">
            <StatsEditor
              stats={creatureParams.stats}
              onChange={(stats) => setCreatureParams({ ...creatureParams, stats })}
            />
            <ColorsEditor
              colors={creatureParams.colors}
              onChange={(colors) => setCreatureParams({ ...creatureParams, colors })}
            />
            <TraitsEditor
              traits={creatureParams.traits}
              onChange={(traits) => setCreatureParams({ ...creatureParams, traits })}
            />
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-3 mb-4">
          <Field label="Quantity">
            <Input
              type="number"
              min={1}
              value={itemParams.quantity}
              onChange={(e) =>
                setItemParams({ ...itemParams, quantity: num(e.target.value, 1) })
              }
            />
          </Field>
          <Field label="Quality (0–100)">
            <Input
              type="number"
              min={0}
              max={100}
              value={itemParams.quality}
              onChange={(e) =>
                setItemParams({ ...itemParams, quality: num(e.target.value, 0) })
              }
            />
          </Field>
          <div className="pt-5">
            <Toggle
              checked={itemParams.asBlueprint}
              onChange={(v) => setItemParams({ ...itemParams, asBlueprint: v })}
              label="As blueprint"
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        {commands.map((cmd) => (
          <CommandRow key={cmd.label} cmd={cmd} />
        ))}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * Item facts, as four fields rather than a page of prose. The high-output
 * threshold is the interesting one: it overrides the project-wide simulator
 * warning, because 500 Element/hour and 500 Fiber/hour are not the same
 * problem.
 */
function ItemInfoModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const key = normalizeBpPath(entry.bpPath);
  const bundled = bundledItemInfo(entry.bpPath);
  const [draft, setDraft] = useState<ItemInfo>(
    catalog.itemInfo[key] ?? emptyItemInfo(),
  );
  // The long-form viewer notes moved out of this modal but are still reachable,
  // so nothing an admin already wrote becomes stranded.
  const [notesOpen, setNotesOpen] = useState(false);
  const set = (patch: Partial<ItemInfo>) => setDraft({ ...draft, ...patch });

  /** Empty input means "no opinion", which is different from zero. */
  const numOrNull = (v: string): number | null => {
    if (!v.trim()) return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  function save() {
    const itemInfo = { ...catalog.itemInfo };
    const empty =
      !draft.type &&
      !draft.rarity &&
      draft.stackSize === null &&
      draft.highOutputPerHour === null;
    if (empty) delete itemInfo[key];
    else itemInfo[key] = draft;
    setCatalog({ ...catalog, itemInfo });
    onClose();
    toast.success(`Info saved for ${entry.name}`);
  }

  return (
    <Modal title={`Item info — ${entry.name}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Type"
          hint={bundled.type ? `Wiki: ${bundled.type}` : undefined}
        >
          <Select
            value={draft.type}
            onChange={(e) => set({ type: e.target.value })}
          >
            <option value="">{bundled.type || "Unspecified"}</option>
            {ITEM_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Rarity" hint="This cluster's own grading">
          <Select
            value={draft.rarity}
            onChange={(e) => set({ rarity: e.target.value })}
          >
            <option value="">Unspecified</option>
            {ITEM_RARITIES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Stack size"
          hint={
            bundled.stackSize !== null && bundled.stackSize !== undefined
              ? `Wiki: ${bundled.stackSize}`
              : "Not in the bundled wiki data"
          }
        >
          <Input
            type="number"
            min="0"
            value={draft.stackSize ?? ""}
            placeholder={
              bundled.stackSize !== null && bundled.stackSize !== undefined
                ? String(bundled.stackSize)
                : "unknown"
            }
            onChange={(e) => set({ stackSize: numOrNull(e.target.value) })}
          />
        </Field>
        <Field
          label="High output warning (items/hr)"
          hint={`Overrides the simulator default of ${settings?.simulator.highOutputPerHour ?? 500}/hr`}
        >
          <Input
            type="number"
            min="0"
            value={draft.highOutputPerHour ?? ""}
            placeholder={String(settings?.simulator.highOutputPerHour ?? 500)}
            onChange={(e) =>
              set({ highOutputPerHour: numOrNull(e.target.value) })
            }
          />
        </Field>
      </div>
      <div className="flex items-center justify-between mt-4">
        <Button variant="ghost" onClick={() => setNotesOpen(true)}>
          Viewer notes{catalog.notes[key] ? " •" : "…"}
        </Button>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Save info
          </Button>
        </div>
      </div>
      {notesOpen && (
        <InfoModal entry={entry} onClose={() => setNotesOpen(false)} />
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function InfoModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const { catalog, setCatalog } = useDraftsStore();
  const key = normalizeBpPath(entry.bpPath);
  const [text, setText] = useState(catalog.notes[key] ?? "");

  function save() {
    const notes = { ...catalog.notes };
    if (text.trim()) notes[key] = text;
    else delete notes[key];
    setCatalog({ ...catalog, notes });
    onClose();
    toast.success(`Info saved for ${entry.name}`);
  }

  return (
    <Modal title={`Viewer info — ${entry.name}`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-2">
        Taming / utility notes shown on the public cluster viewer page. Simple
        markdown supported: <span className="mono"># headers</span>,{" "}
        <span className="mono">**bold**</span>,{" "}
        <span className="mono">*italic*</span>,{" "}
        <span className="mono">- lists</span>.
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        autoFocus
        className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 text-sm text-ink-100 focus:outline-none focus:border-accent-500/60"
        placeholder={`## Taming\nKnockout tame — prefers Sweet Vegetable Cake…\n\n## Utility\nPassive Achatina Paste production, great for Cementing Paste supply.`}
      />
      <div className="flex justify-end gap-2 mt-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={save}>
          Save info
        </Button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function AddEntryModal({
  kind,
  findConflict,
  onAdd,
  onClose,
}: {
  kind: EntryKind;
  /** The entry already using this path, anywhere in the effective catalog. */
  findConflict: (bpPath: string) => EntryOwner | null;
  onAdd: (entry: CatalogEntry) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [bpPath, setBpPath] = useState("");
  const label = kind === "creatures" ? "creature" : "item";
  const conflict = bpPath.trim() ? findConflict(bpPath) : null;
  return (
    <Modal title={`Add ${label}`} onClose={onClose}>
      <div className="flex flex-col gap-4">
        <Field label="Display name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <Field
          label="Blueprint path"
          hint={
            kind === "creatures"
              ? "e.g. /Game/Mods/X/Creatures/X_Character_BP.X_Character_BP"
              : "e.g. /Game/Mods/X/Items/PrimalItemResource_X.PrimalItemResource_X"
          }
        >
          <Input
            className="mono"
            value={bpPath}
            onChange={(e) => setBpPath(e.target.value)}
          />
        </Field>
        {conflict && (
          <p className="text-xs rounded-lg border border-danger/30 bg-danger/5 text-red-300 px-3 py-2">
            This class is already catalogued as {describeOwner(conflict)}. A
            class in two places makes pickers and validation ambiguous — edit
            the existing entry instead, or move it here.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!name.trim() || !bpPath.trim() || Boolean(conflict)}
            onClick={() =>
              onAdd({ id: newId(), name: name.trim(), bpPath: bpPath.trim() })
            }
          >
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function parseBulkLines(text: string): { entries: CatalogEntry[]; bad: string[] } {
  const entries: CatalogEntry[] = [];
  const bad: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    // Accept "Name | /Game/path" or a bare "/Game/path"
    const parts = line.split("|").map((p) => p.trim());
    let name = "";
    let bpPath = "";
    if (parts.length >= 2 && parts[1].startsWith("/")) {
      [name, bpPath] = parts;
    } else if (parts.length === 1 && parts[0].startsWith("/")) {
      bpPath = parts[0];
      const file = bpPath.split("/").pop() ?? "";
      name = file.split(".")[0].replace(/^PrimalItem\w*?_/, "").replace(/_/g, " ");
    } else {
      bad.push(line);
      continue;
    }
    if (!bpPath.includes("/") || !bpPath.includes(".")) {
      bad.push(line);
      continue;
    }
    entries.push({ id: newId(), name, bpPath });
  }
  return { entries, bad };
}

function BulkImportModal({
  kind,
  onImport,
  onClose,
}: {
  kind: EntryKind;
  onImport: (entries: CatalogEntry[]) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const { entries, bad } = useMemo(() => parseBulkLines(text), [text]);
  return (
    <Modal title={`Bulk import ${kind}`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-3">
        One entry per line: <span className="mono">Name | /Game/…/Thing.Thing</span>{" "}
        — or just a blueprint path (a name will be derived).
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={12}
        className="w-full bg-ink-950 border border-ink-600 rounded-md p-3 mono text-ink-100 focus:outline-none focus:border-accent-500/60"
        placeholder={`Helicoprion | /AAHelicoprion/Dinos/HelicoprionAA_Character_BP.HelicoprionAA_Character_BP\n/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Hide.PrimalItemResource_Hide`}
      />
      <div className="flex items-center justify-between mt-3">
        <div className="text-xs">
          <span className="text-accent-400">{entries.length} parsed</span>
          {bad.length > 0 && (
            <span className="text-red-400 ml-3">
              {bad.length} unparseable line{bad.length > 1 ? "s" : ""}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={entries.length === 0}
            onClick={() => onImport(entries)}
          >
            Import {entries.length}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
