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
import { CatalogFile, CatalogFileSchema, emptyCatalog } from "../model/catalog";
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
import { useProjectStore } from "./projectStore";

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

/**
 * Surfaces a failed write. Losing an admin's work silently is the worst
 * outcome this app has, so a persist error is never swallowed — it was
 * `console.error` once, and a rejected file name went unnoticed because of it.
 */
async function reportSaveFailure(fileName: string, e: unknown) {
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`Failed to save ${fileName}:`, e);
  const { toast } = await import("../components/toast");
  toast.error(`Could not save ${fileName} — your changes are not on disk. ${detail}`);
}

function schedulePersist(fileName: ProjectFileName, content: string) {
  const existing = saveTimers.get(fileName);
  if (existing) clearTimeout(existing);
  saveTimers.set(
    fileName,
    setTimeout(() => {
      saveTimers.delete(fileName);
      useProjectStore
        .getState()
        .saveFile(fileName, content)
        .catch((e) => void reportSaveFailure(fileName, e));
    }, SAVE_DEBOUNCE_MS),
  );
}

/** Immediately flushes all pending debounced saves (used before publish/close). */
export async function flushPendingSaves(): Promise<void> {
  const state = useDraftsStore.getState();
  for (const timer of saveTimers.values()) clearTimeout(timer);
  saveTimers.clear();
  const project = useProjectStore.getState();
  if (!project.dir) return;

  const writes: [ProjectFileName, unknown][] = [
    [PROJECT_FILE.production, state.production],
    [PROJECT_FILE.remaps, state.remaps],
    [PROJECT_FILE.cosmetics, state.cosmetics],
    [PROJECT_FILE.catalog, state.catalog],
    [PROJECT_FILE.watchlist, state.watchlist],
    [PROJECT_FILE.history, state.history],
    [PROJECT_FILE.players, state.players],
    [PROJECT_FILE.creatureImports, state.creatureImports],
    [PROJECT_FILE.activity, state.activity],
  ];

  // One bad file must not stop the others from reaching disk.
  const results = await Promise.allSettled(
    writes.map(([name, value]) =>
      project.saveFile(name, JSON.stringify(value, null, 2)),
    ),
  );
  await Promise.all(
    results.flatMap((r, i) =>
      r.status === "rejected" ? [reportSaveFailure(writes[i][0], r.reason)] : [],
    ),
  );
}

// Last-ditch flush when the window goes away — closing the app mid-debounce
// would otherwise drop the edit. pagehide fires on close and on reload.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    void flushPendingSaves();
  });
}

function parseFile<T>(
  files: Record<string, string>,
  name: string,
  schema: { safeParse(v: unknown): { success: boolean; data?: T } },
  fallback: T,
): T {
  const raw = files[name];
  if (!raw) return fallback;
  try {
    const result = schema.safeParse(JSON.parse(raw));
    if (result.success && result.data !== undefined) return result.data;
    // Falling back to empty here means the file's contents are about to be
    // overwritten by nothing on the next edit — the admin has to know.
    reportLoadFailure(name, "did not match the expected format");
    return fallback;
  } catch {
    reportLoadFailure(name, "is not valid JSON");
    return fallback;
  }
}

/**
 * Announces a file that failed to load. Silence here is dangerous: the store
 * carries on with empty data, and the first subsequent edit writes that
 * emptiness over whatever was on disk.
 */
async function reportLoadFailure(name: string, why: string) {
  console.warn(`${name} ${why}; starting from empty`);
  const { toast } = await import("../components/toast");
  toast.error(
    `${name} ${why} and was not loaded. Its previous contents are in the project's backups folder — do not save over it until you've checked.`,
  );
}

interface DraftsState {
  hydratedFor: string | null;
  production: ProductionDraft;
  remaps: RemapsDraft;
  cosmetics: CosmeticsDraft;
  catalog: CatalogFile;
  watchlist: Watchlist;
  history: HistoryFile;
  players: PlayersFile;
  creatureImports: CreatureImportsFile;
  activity: ActivityFile;
  /** File names found in the project's images/ folder (used for icons). */
  imageFiles: string[];

  hydrate(): void;
  refreshImages(): Promise<void>;
  setProduction(draft: ProductionDraft): void;
  setRemaps(draft: RemapsDraft): void;
  setCosmetics(draft: CosmeticsDraft): void;
  setCatalog(catalog: CatalogFile): void;
  setWatchlist(watchlist: Watchlist): void;
  setHistory(history: HistoryFile): void;
  setPlayers(players: PlayersFile): void;
  setCreatureImports(imports: CreatureImportsFile): void;
  /**
   * Appends one project activity event. Called from commit boundaries — a
   * completed publish, a created rule — never from an in-progress edit.
   */
  recordActivity(event: ActivityInput): void;
}

export const useDraftsStore = create<DraftsState>((set, get) => ({
  hydratedFor: null,
  production: emptyProductionDraft(),
  remaps: emptyRemapsDraft(),
  cosmetics: emptyCosmeticsDraft(),
  catalog: emptyCatalog(),
  watchlist: emptyWatchlist(),
  history: emptyHistory(),
  players: emptyPlayers(),
  creatureImports: emptyCreatureImports(),
  activity: emptyActivity(),
  imageFiles: [],

  hydrate() {
    const { dir, files } = useProjectStore.getState();
    if (!dir || get().hydratedFor === dir) return;
    set({
      hydratedFor: dir,
      production: parseFile(files, PROJECT_FILE.production, ProductionDraftSchema, emptyProductionDraft()),
      remaps: parseFile(files, PROJECT_FILE.remaps, RemapsDraftSchema, emptyRemapsDraft()),
      cosmetics: parseFile(files, PROJECT_FILE.cosmetics, CosmeticsDraftSchema, emptyCosmeticsDraft()),
      catalog: parseFile(files, PROJECT_FILE.catalog, CatalogFileSchema, emptyCatalog()),
      watchlist: parseFile(files, PROJECT_FILE.watchlist, WatchlistSchema, emptyWatchlist()),
      history: parseFile(files, PROJECT_FILE.history, HistoryFileSchema, emptyHistory()),
      players: parseFile(files, PROJECT_FILE.players, PlayersFileSchema, emptyPlayers()),
      creatureImports: parseFile(files, PROJECT_FILE.creatureImports, CreatureImportsFileSchema, emptyCreatureImports()),
      activity: parseFile(files, PROJECT_FILE.activity, ActivityFileSchema, emptyActivity()),
    });
    void get().refreshImages();
  },

  async refreshImages() {
    const { dir, settings } = useProjectStore.getState();
    if (!dir) return;
    try {
      const { ipc } = await import("../services/ipc");
      const names = await ipc<string[]>("list_images", {
        dir: resolveImagesDir(dir, settings?.imagesDir),
      });
      set({ imageFiles: names });
    } catch {
      set({ imageFiles: [] });
    }
  },

  setProduction(production) {
    set({ production });
    schedulePersist(PROJECT_FILE.production, JSON.stringify(production, null, 2));
  },
  setRemaps(remaps) {
    set({ remaps });
    schedulePersist(PROJECT_FILE.remaps, JSON.stringify(remaps, null, 2));
  },
  setCosmetics(cosmetics) {
    set({ cosmetics });
    schedulePersist(PROJECT_FILE.cosmetics, JSON.stringify(cosmetics, null, 2));
  },
  setCatalog(catalog) {
    set({ catalog });
    schedulePersist(PROJECT_FILE.catalog, JSON.stringify(catalog, null, 2));
  },
  setWatchlist(watchlist) {
    set({ watchlist });
    schedulePersist(PROJECT_FILE.watchlist, JSON.stringify(watchlist, null, 2));
  },
  setHistory(history) {
    set({ history });
    schedulePersist(PROJECT_FILE.history, JSON.stringify(history, null, 2));
  },
  setPlayers(players) {
    set({ players });
    schedulePersist(PROJECT_FILE.players, JSON.stringify(players, null, 2));
  },
  setCreatureImports(creatureImports) {
    set({ creatureImports });
    schedulePersist(
      PROJECT_FILE.creatureImports,
      JSON.stringify(creatureImports, null, 2),
    );
  },

  recordActivity(event) {
    // No project open means no project folder to write to — the event would
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
 * the store through — the store action is the single implementation.
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
        watchlist: emptyWatchlist(),
        history: emptyHistory(),
        players: emptyPlayers(),
        creatureImports: emptyCreatureImports(),
        activity: emptyActivity(),
      });
    } else {
      useDraftsStore.setState({ hydratedFor: null });
      useDraftsStore.getState().hydrate();
    }
  }
});
