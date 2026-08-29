import { create } from "zustand";
import { PROJECT_FILE, type ProjectFileName } from "../model/project";
import {
  emptyProductionDraft,
  ProductionDraft,
  ProductionDraftSchema,
} from "../model/production";
import { emptyRemapsDraft, RemapsDraft, RemapsDraftSchema } from "../model/remaps";
import {
  CosmeticsDraft,
  CosmeticsDraftSchema,
  emptyCosmeticsDraft,
} from "../model/cosmetics";
import { CatalogFile, CatalogFileSchema, catalogForWrite, emptyCatalog } from "../model/catalog";
import { emptyWatchlist, Watchlist, WatchlistSchema } from "../model/watchlist";
import { emptyHistory, HistoryFile, HistoryFileSchema } from "../model/history";
import { emptyPlayers, PlayersFile, PlayersFileSchema } from "../model/players";
import {
  CreatureImportsFile,
  CreatureImportsFileSchema,
  emptyCreatureImports,
} from "../model/creatureImport";
import {
  ActivityFile,
  ActivityFileSchema,
  ActivityInput,
  appendActivity,
  emptyActivity,
} from "../model/activity";
import { newId } from "../model/ids";
import type { AssetRef } from "../model/assetRef";
import { asStudioError, type StudioError } from "../model/errors";
import {
  COSMETIC_SPEC,
  diffCatalog,
  diffList,
  IMPORT_SPEC,
  PLAYER_SPEC,
  PRODUCTION_SPEC,
  REMAP_SPEC,
  WATCHLIST_SPEC,
} from "../model/changeDetection";
import type { StructuredAction } from "../model/commitActions";
import { useProjectStore } from "./projectStore";
import {
  ensureProjectDependencies,
  projectOverridesFromResolved,
  resolveDependencyLayers,
  type DependencyDiagnostic,
} from "../services/dependencyManager";
import {
  managedOfficialDependency,
  withManagedOfficialDependency,
} from "../services/officialContent";
import { mergeDependencies } from "../model/dependency";

/**
 * Domain drafts for the open project. Hydrated from the project files when a
 * project opens; every mutation is persisted back to disk with a short
 * debounce (each save rotates a backup on the Rust side).
 */

/** The folder scanned for icon images (project setting, or images/ inside the project). */
export function resolveImagesDir(
  projectDir: string,
  imagesDir: string | undefined,
): string {
  return imagesDir?.trim() ? imagesDir.trim() : `${projectDir}/images`;
}

const SAVE_DEBOUNCE_MS = 1200;
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The newest content scheduled per file, so a flush writes what a timer would. */
const pendingContent = new Map<ProjectFileName, string>();

export interface SaveFailure {
  fileName: string;
  error: StudioError;
}

/**
 * What a flush actually achieved.
 *
 * Returned rather than thrown so a caller can report every failure at once,
 * and typed rather than boolean so Sync and Publish can refuse for a reason
 * they can show. `flushPendingSaves` resolving used to mean nothing at all -
 * it swallowed rejections into a toast - which is how an admin could Publish
 * work that had never reached the disk.
 */
export interface FlushResult {
  ok: boolean;
  failures: SaveFailure[];
}

/**
 * Surfaces a failed write. Losing an admin's work silently is the worst
 * outcome this app has, so a persist error is never swallowed - it was
 * `console.error` once, and a rejected file name went unnoticed because of it.
 */
async function reportSaveFailure(fileName: string, error: StudioError) {
  console.error(`Failed to save ${fileName}:`, error.detail);
  const { toast } = await import("../components/toast");
  toast.error(`${error.message} (${fileName})`);
}

/**
 * Adds what an edit did to the unsynchronized journal.
 *
 * Called from the setters rather than from the call sites, because a promise
 * that every place editing a creature describes its own change is one nobody
 * keeps - the twentieth one forgets, and the commit degrades to "files
 * changed". Every edit already goes through here.
 *
 * Failing to describe a change must never stop the change itself, so this is
 * deliberately best-effort.
 */
function recordChanges(actions: StructuredAction[]) {
  if (actions.length === 0) return;
  try {
    const { recordChange } = useProjectStore.getState();
    for (const action of actions) recordChange(action);
  } catch (e) {
    console.error("Could not describe a change:", e);
  }
}

function schedulePersist(fileName: ProjectFileName, content: string) {
  const existing = saveTimers.get(fileName);
  if (existing) clearTimeout(existing);
  pendingContent.set(fileName, content);
  saveTimers.set(
    fileName,
    setTimeout(() => {
      saveTimers.delete(fileName);
      pendingContent.delete(fileName);
      useProjectStore
        .getState()
        .saveFile(fileName, content)
        .catch((e) => {
          const error = asStudioError(e, "save.failed", `Could not save ${fileName}.`);
          void reportSaveFailure(fileName, error);
        });
    }, SAVE_DEBOUNCE_MS),
  );
}

/** Drops a queued debounced write, for callers that write the file themselves. */
function cancelPendingPersist(fileName: ProjectFileName) {
  const existing = saveTimers.get(fileName);
  if (existing) clearTimeout(existing);
  saveTimers.delete(fileName);
  pendingContent.delete(fileName);
}

/**
 * Writes every pending change immediately.
 *
 * Writes the whole draft set rather than only what a timer had queued: the
 * cost is a no-op compare in Rust for the unchanged files, and the benefit is
 * that "flushed" means the same thing every time.
 */
export async function flushPendingSaves(): Promise<FlushResult> {
  const state = useDraftsStore.getState();
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  pendingContent.clear();
  const project = useProjectStore.getState();
  if (!project.dir) return { ok: true, failures: [] };
  // A read-only project has nothing to flush and must not be written to.
  if (project.mode === "read-only") return { ok: true, failures: [] };

  const writes: [ProjectFileName, unknown][] = [
    [PROJECT_FILE.production, state.production],
    [PROJECT_FILE.remaps, state.remaps],
    [PROJECT_FILE.cosmetics, state.cosmetics],
    [PROJECT_FILE.catalog, catalogForWrite(state.projectCatalog)],
    [PROJECT_FILE.watchlist, state.watchlist],
    [PROJECT_FILE.history, state.history],
    [PROJECT_FILE.players, state.players],
    [PROJECT_FILE.creatureImports, state.creatureImports],
    [PROJECT_FILE.activity, state.activity],
  ];

  // One bad file must not stop the others from reaching disk.
  const results = await Promise.allSettled(
    writes
      // A file that failed to load was quarantined, and its store slot holds
      // an empty default. Writing that back is precisely the overwrite the
      // quarantine exists to prevent.
      .filter(([name]) => !state.unloadable.some((u) => u.fileName === name))
      .map(([name, value]) => project.saveFile(name, JSON.stringify(value, null, 2))),
  );

  const failures: SaveFailure[] = [];
  results.forEach((result, i) => {
    if (result.status !== "rejected") return;
    const fileName = writes[i][0];
    const error = asStudioError(result.reason, "save.failed", `Could not save ${fileName}.`);
    failures.push({ fileName, error });
    void reportSaveFailure(fileName, error);
  });

  return { ok: failures.length === 0, failures };
}

/**
 * Last-ditch flush when the window goes away.
 *
 * Best-effort only, and nothing depends on it: `pagehide` cannot await an
 * asynchronous write, so a browser that tears the page down first simply wins.
 * Correctness comes from the debounce being short and from Sync, Publish and
 * close all flushing explicitly and checking the result.
 */
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushPendingSaves();
  });
}

/** A file that could not be loaded, and where its contents were put. */
export interface UnloadableFile {
  fileName: string;
  why: string;
  /** Where the original was set aside, when it could be. */
  movedTo: string;
}

function parseFile<T>(
  files: Record<string, string>,
  name: ProjectFileName,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  fallback: T,
  damaged: UnloadableFile[],
): T {
  const raw = files[name];
  if (!raw) return fallback;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    if (result.success && result.data !== undefined) return result.data;
    damaged.push({ fileName: name, why: "did not match the expected format", movedTo: "" });
    return fallback;
  } catch {
    damaged.push({ fileName: name, why: "is not valid JSON", movedTo: "" });
    return fallback;
  }
}

/**
 * Sets damaged files aside and tells the admin.
 *
 * The old behaviour was to carry on with empty data and show a toast. That is
 * a trap: the store now holds nothing where the roster was, and the first
 * keystroke autosaves that nothing straight over the file. Moving the original
 * out of the folder first means the worst case is a file to go and look at.
 */
async function quarantineDamaged(dir: string, damaged: UnloadableFile[]) {
  const { quarantineFile } = await import("../services/projectSession");
  const resolved: UnloadableFile[] = [];
  for (const entry of damaged) {
    try {
      const { movedTo } = await quarantineFile(dir, entry.fileName);
      resolved.push({ ...entry, movedTo });
    } catch {
      // Could not be moved - it stays where it is, and stays on the blocked
      // list, so nothing writes over it either way.
      resolved.push(entry);
    }
  }
  useDraftsStore.setState({ unloadable: resolved });

  const { toast } = await import("../components/toast");
  for (const entry of resolved) {
    toast.error(
      entry.movedTo
        ? `${entry.fileName} ${entry.why}. The original has been set aside in the project's recovery folder - nothing will be written over it.`
        : `${entry.fileName} ${entry.why} and could not be set aside. Do not save until you have checked it.`,
    );
  }
}

interface DraftsState {
  hydratedFor: string | null;
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  /** Resolved editing view: package defaults plus project-owned overrides. */
  catalog: CatalogFile;
  /** Portable data actually persisted to catalog.mods.json. */
  projectCatalog: CatalogFile;
  packageDefaults: CatalogFile;
  packageAssets: Record<string, AssetRef>;
  packageRoots: Record<string, string>;
  /** Pinned Core Content version, so managed official art resolves exactly. */
  officialVersion: string;
  dependencyDiagnostics: DependencyDiagnostic[];
  dependenciesLoading: boolean;
  watchlist: Watchlist;
  history: HistoryFile;
  players: PlayersFile;
  creatureImports: CreatureImportsFile;
  activity: ActivityFile;
  /** File names found in the project's images/ folder (used for icons). */
  imageFiles: string[];
  /**
   * Files that could not be read. Their store slots hold empty defaults, so
   * nothing may write them back - see the filter in `flushPendingSaves`.
   */
  unloadable: UnloadableFile[];

  hydrate(): void;
  refreshDependencies(): Promise<void>;
  refreshImages(): Promise<void>;
  setProduction(draft: ProductionDraft): void;
  setRemaps(draft: RemapsDraft): void;
  setCosmetics(draft: CosmeticsDraft): void;
  setCatalog(catalog: CatalogFile): void;
  /** `setCatalog` that resolves only once `catalog.mods.json` is on disk. */
  setCatalogDurable(catalog: CatalogFile): Promise<void>;
  setWatchlist(watchlist: Watchlist): void;
  setHistory(history: HistoryFile): void;
  setPlayers(players: PlayersFile): void;
  setCreatureImports(imports: CreatureImportsFile): void;
  /**
   * Appends one project activity event. Called from commit boundaries - a
   * completed publish, a created rule - never from an in-progress edit.
   */
  recordActivity(event: ActivityInput): void;
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  hydratedFor: null,
  production: emptyProductionDraft(),
  remaps: emptyRemapsDraft(),
  cosmetics: emptyCosmeticsDraft(),
  catalog: emptyCatalog(),
  projectCatalog: emptyCatalog(),
  packageDefaults: emptyCatalog(),
  packageAssets: {},
  packageRoots: {},
  officialVersion: "",
  dependencyDiagnostics: [],
  dependenciesLoading: false,
  watchlist: emptyWatchlist(),
  history: emptyHistory(),
  players: emptyPlayers(),
  creatureImports: emptyCreatureImports(),
  activity: emptyActivity(),
  imageFiles: [],
  unloadable: [],

  hydrate() {
    const projectState = useProjectStore.getState();
    const { dir, files, mode, local } = projectState;
    if (!dir || get().hydratedFor === dir) return;
    const damaged: UnloadableFile[] = [];
    const projectCatalog = parseFile(
      files,
      PROJECT_FILE.catalog,
      CatalogFileSchema,
      emptyCatalog(),
      damaged,
    );
    set({
      hydratedFor: dir,
      unloadable: [],
      production: parseFile(files, PROJECT_FILE.production, ProductionDraftSchema, emptyProductionDraft(), damaged),
      remaps: parseFile(files, PROJECT_FILE.remaps, RemapsDraftSchema, emptyRemapsDraft(), damaged),
      cosmetics: parseFile(files, PROJECT_FILE.cosmetics, CosmeticsDraftSchema, emptyCosmeticsDraft(), damaged),
      catalog: projectCatalog,
      projectCatalog,
      packageDefaults: emptyCatalog(),
      packageAssets: {},
      packageRoots: {},
      officialVersion: "",
      dependencyDiagnostics: [],
      dependenciesLoading: false,
      watchlist: parseFile(files, PROJECT_FILE.watchlist, WatchlistSchema, emptyWatchlist(), damaged),
      history: parseFile(files, PROJECT_FILE.history, HistoryFileSchema, emptyHistory(), damaged),
      players: parseFile(files, PROJECT_FILE.players, PlayersFileSchema, emptyPlayers(), damaged),
      creatureImports: parseFile(files, PROJECT_FILE.creatureImports, CreatureImportsFileSchema, emptyCreatureImports(), damaged),
      activity: parseFile(files, PROJECT_FILE.activity, ActivityFileSchema, emptyActivity(), damaged),
    });
    if (damaged.length > 0) {
      // Listed immediately so a save cannot slip through before the
      // quarantine round-trip finishes.
      set({ unloadable: damaged });
      if (mode === "editable") void quarantineDamaged(dir, damaged);
    }
    const legacyIconSources = projectCatalog.sources.filter(
      (source) =>
        source.iconsDir.trim() &&
        !local?.sourceIconDirs[source.id]?.trim(),
    );
    if (mode === "editable" && local && legacyIconSources.length > 0) {
      const sourceIconDirs = { ...local.sourceIconDirs };
      for (const source of legacyIconSources) {
        sourceIconDirs[source.id] = source.iconsDir.trim();
      }
      void projectState
        .updateLocal({ sourceIconDirs })
        .then(() => {
          if (useProjectStore.getState().dir !== dir) return;
          const migrated = new Set(
            legacyIconSources.map((source) => source.id),
          );
          const clean = (value: CatalogFile): CatalogFile => ({
            ...value,
            sources: value.sources.map((source) =>
              migrated.has(source.id) ? { ...source, iconsDir: "" } : source,
            ),
          });
          const projectCatalog = clean(get().projectCatalog);
          set({ catalog: clean(get().catalog), projectCatalog });
          schedulePersist(
            PROJECT_FILE.catalog,
            JSON.stringify(catalogForWrite(projectCatalog), null, 2),
          );
        })
        .catch(async (error: unknown) => {
          const { toast } = await import("../components/toast");
          toast.error(
            `Could not move mod icon folders to this machine's settings: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
    }
    void get().refreshImages();
    void get().refreshDependencies();
  },

  async refreshDependencies() {
    const project = useProjectStore.getState();
    const openedDir = project.dir;
    if (!openedDir || !project.settings) return;
    const configured = project.settings.packageDependencies;
    let dependencies = withManagedOfficialDependency(configured);
    if (dependencies !== configured && project.mode === "editable") {
      // Core Content is a portable exact dependency, not a selected local
      // folder. Persist the first managed release without making an offline
      // download a condition of opening the project.
      //
      // Merged rather than assigned: an administrator may be installing a
      // modpack at this very moment, and its pin must not be erased by a list
      // that was read before it landed. An existing official pin is left
      // exactly as it is - this never silently upgrades one.
      try {
        await project.updateSettings((current) => ({
          ...current,
          packageDependencies: mergeDependencies(
            current.packageDependencies,
            [managedOfficialDependency()],
            { asDefaults: true },
          ),
        }));
        dependencies =
          useProjectStore.getState().settings?.packageDependencies ??
          dependencies;
      } catch (error) {
        const { toast } = await import("../components/toast");
        toast.error(
          `Could not save the managed Official ASA dependency: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    set({ dependenciesLoading: true });
    const ensured = await ensureProjectDependencies(
      dependencies,
      project.local?.localPackageSources ?? {},
    );
    // A slow download finishing after the user changed projects must not put
    // one project's catalog into another project's store.
    if (useProjectStore.getState().dir !== openedDir) return;
    const resolved = resolveDependencyLayers(
      get().projectCatalog,
      ensured.available,
      ensured.diagnostics,
    );
    set({
      catalog: resolved.catalog,
      packageDefaults: resolved.defaults,
      packageAssets: resolved.packageAssets,
      packageRoots: resolved.packageRoots,
      officialVersion: resolved.officialVersion,
      dependencyDiagnostics: resolved.diagnostics,
      dependenciesLoading: false,
    });
  },

  async refreshImages() {
    const { dir, local } = useProjectStore.getState();
    if (!dir) return;
    try {
      const { ipc } = await import("../services/ipc");
      const names = await ipc<string[]>("list_images", {
        dir: resolveImagesDir(dir, local?.imagesDir),
      });
      set({ imageFiles: names });
    } catch {
      set({ imageFiles: [] });
    }
  },

  setProduction(production) {
    recordChanges(diffList(get().production.rules, production.rules, PRODUCTION_SPEC));
    set({ production });
    schedulePersist(PROJECT_FILE.production, JSON.stringify(production, null, 2));
  },
  setRemaps(remaps) {
    recordChanges(diffList(get().remaps.entries, remaps.entries, REMAP_SPEC));
    set({ remaps });
    schedulePersist(PROJECT_FILE.remaps, JSON.stringify(remaps, null, 2));
  },
  setCosmetics(cosmetics) {
    recordChanges(diffList(get().cosmetics.entries, cosmetics.entries, COSMETIC_SPEC));
    set({ cosmetics });
    schedulePersist(PROJECT_FILE.cosmetics, JSON.stringify(cosmetics, null, 2));
  },
  setCatalog(catalog) {
    recordChanges(diffCatalog(get().catalog, catalog));
    const projectCatalog = projectOverridesFromResolved(
      catalog,
      get().packageDefaults,
    );
    set({ catalog, projectCatalog });
    schedulePersist(
      PROJECT_FILE.catalog,
      JSON.stringify(catalogForWrite(projectCatalog), null, 2),
    );
  },

  async setCatalogDurable(catalog) {
    // Same bookkeeping as `setCatalog`, but the write is awaited rather than
    // debounced. Used where an operation may not report success until the
    // content is actually on disk - see `commitPackageActivation`.
    recordChanges(diffCatalog(get().catalog, catalog));
    const projectCatalog = projectOverridesFromResolved(
      catalog,
      get().packageDefaults,
    );
    cancelPendingPersist(PROJECT_FILE.catalog);
    set({ catalog, projectCatalog });
    await useProjectStore
      .getState()
      .saveFile(PROJECT_FILE.catalog, JSON.stringify(catalogForWrite(projectCatalog), null, 2));
  },
  setWatchlist(watchlist) {
    recordChanges(diffList(get().watchlist.mods, watchlist.mods, WATCHLIST_SPEC));
    set({ watchlist });
    schedulePersist(PROJECT_FILE.watchlist, JSON.stringify(watchlist, null, 2));
  },
  setHistory(history) {
    set({ history });
    schedulePersist(PROJECT_FILE.history, JSON.stringify(history, null, 2));
  },
  setPlayers(players) {
    recordChanges(diffList(get().players.players, players.players, PLAYER_SPEC));
    set({ players });
    schedulePersist(PROJECT_FILE.players, JSON.stringify(players, null, 2));
  },
  setCreatureImports(creatureImports) {
    recordChanges(
      diffList(get().creatureImports.records, creatureImports.records, IMPORT_SPEC),
    );
    set({ creatureImports });
    schedulePersist(
      PROJECT_FILE.creatureImports,
      JSON.stringify(creatureImports, null, 2),
    );
  },

  recordActivity(event) {
    // No project open means no project folder to write to - the event would
    // be attributed to whichever project opened next.
    if (!useProjectStore.getState().dir) return;
    const activity = appendActivity(get().activity, {
      detail: "",
      to: "",
      ...event,
      id: newId(),
      at: new Date().toISOString(),
    });
    set({ activity });
    schedulePersist(PROJECT_FILE.activity, JSON.stringify(activity, null, 2));
  },
}));

/**
 * Records project activity from outside a component.
 *
 * A free function so services and event handlers can log without threading
 * the store through - the store action is the single implementation.
 */
export function recordActivity(event: ActivityInput) {
  useDraftsStore.getState().recordActivity(event);
}

// Reset drafts when the project closes / changes.
useProjectStore.subscribe((state, prev) => {
  if (state.dir !== prev.dir) {
    if (!state.dir) {
      useDraftsStore.setState({
        hydratedFor: null,
        production: emptyProductionDraft(),
        remaps: emptyRemapsDraft(),
        cosmetics: emptyCosmeticsDraft(),
        catalog: emptyCatalog(),
        projectCatalog: emptyCatalog(),
        packageDefaults: emptyCatalog(),
        packageAssets: {},
        packageRoots: {},
        officialVersion: "",
        dependencyDiagnostics: [],
        dependenciesLoading: false,
        watchlist: emptyWatchlist(),
        history: emptyHistory(),
        players: emptyPlayers(),
        creatureImports: emptyCreatureImports(),
        activity: emptyActivity(),
        unloadable: [],
      });
    } else {
      useDraftsStore.setState({ hydratedFor: null });
      useDraftsStore.getState().hydrate();
    }
  }
});
