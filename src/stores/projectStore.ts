import { create } from "zustand";
import { ipc } from "../services/ipc";
import { asStudioError, StudioError } from "../model/errors";
import { newId } from "../model/ids";
import {
  defaultProjectSettings,
  effectiveGithubConfig,
  PROJECT_FILE,
  ProjectSettings,
  ProjectSettingsSchema,
  type GithubConfig,
  type ProjectFileName,
} from "../model/project";
import type { LocalProjectState } from "../model/localState";
import type { StructuredAction } from "../model/commitActions";
import type { MigrationReport } from "../model/migrations";
import {
  inspectProject,
  openInspectedProject,
  loadLocalState,
  listLocalProjects,
  refreshLock,
  releaseLock,
  saveLocalState,
  type ProjectInspection,
  type ProjectMode,
} from "../services/projectSession";
import { newLocalProjectState } from "../model/localState";
import { withManagedOfficialSettings } from "../services/officialContent";
import {
  exampleProjectFiles,
  isExampleProject,
  isExampleProjectName,
  markExampleProject,
} from "../model/exampleProject";

export interface RecentProject {
  dir: string;
  name: string;
  openedAt: string;
  /**
   * The project's own id, when this machine has a record for it.
   *
   * Empty for an entry written by a build that only remembered paths. Forget
   * needs it — dropping the row without the machine-local record would leave
   * the project to reappear the next time the list is rebuilt from disk.
   */
  projectId: string;
}

const RECENTS_KEY = "ddstudio.recentProjects";

/** How often the lock heartbeat is refreshed while a project is open. */
const HEARTBEAT_MS = 30_000;

function loadRecents(): RecentProject[] {
  let stored: unknown;
  try {
    stored = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) return [];
  return stored.map((entry) => ({
    dir: String((entry as RecentProject)?.dir ?? ""),
    name: String((entry as RecentProject)?.name ?? ""),
    openedAt: String((entry as RecentProject)?.openedAt ?? ""),
    projectId: String((entry as RecentProject)?.projectId ?? ""),
  })).filter((entry) => !isExampleRecent(entry));
}

/** Includes numbered copies produced by older builds; none belong in recents. */
function isExampleRecent(entry: Pick<RecentProject, "name">): boolean {
  return isExampleProjectName(entry.name);
}

function saveRecents(recents: RecentProject[]) {
  localStorage.setItem(
    RECENTS_KEY,
    JSON.stringify(recents.filter((entry) => !isExampleRecent(entry)).slice(0, 8)),
  );
}

/**
 * Flushes the drafts store's debounced writes. Imported lazily because
 * draftsStore depends on this module — a static import would be a cycle.
 */
async function flushDrafts(): Promise<void> {
  if (!useProjectStore.getState().dir) return;
  const { flushPendingSaves } = await import("./draftsStore");
  const result = await flushPendingSaves();
  if (!result.ok) {
    // Not swallowed: the caller (closing, syncing, publishing) has to know
    // that what is on disk is not what is in memory.
    throw new StudioError(
      "save.failed",
      "Some of your changes could not be saved. Fix that before closing the project.",
      { detail: result.failures.map((f) => `${f.fileName}: ${f.error.detail}`).join("; ") },
    );
  }
}

function pushRecent(dir: string, name: string, projectId: string) {
  // Matched on id as well as path: a project that has been moved and reopened
  // would otherwise sit in the list twice, once at a folder that is gone.
  const recents = loadRecents().filter(
    (r) => r.dir !== dir && !(projectId && r.projectId === projectId),
  );
  recents.unshift({ dir, name, openedAt: new Date().toISOString(), projectId });
  saveRecents(recents);
}

/**
 * Whether writes are reaching the disk.
 *
 * A save failure used to be a toast and nothing more, which meant an admin
 * could carry on editing, then Sync, and publish an hour of work that was only
 * ever in memory. This state is what Sync, Publish, migration and close all
 * check before they do anything.
 */
export interface SaveHealth {
  ok: boolean;
  /** File names whose last write failed and has not since succeeded. */
  failing: string[];
  lastError: StudioError | null;
  lastFailureAt: string;
}

const HEALTHY: SaveHealth = { ok: true, failing: [], lastError: null, lastFailureAt: "" };

/** Tail of the serialized settings-write chain. See `updateSettings`. */
let settingsQueue: Promise<void> = Promise.resolve();

interface ProjectState {
  /** Absolute path of the open project folder, or null when no project open. */
  dir: string | null;
  settings: ProjectSettings | null;
  /** This machine's record for the open project: paths, bindings, sync state. */
  local: LocalProjectState | null;
  /** Raw contents of all project files as loaded/saved. Domain stores hydrate from here. */
  files: Record<string, string>;
  /** "read-only" when the project's schema is newer than this build. */
  mode: ProjectMode;
  readOnlyReason: string;
  /** The migration that ran when this project was opened, if one did. */
  lastMigration: MigrationReport | null;
  migrationSnapshot: string;
  saveHealth: SaveHealth;
  recents: RecentProject[];

  createProject(
    dir: string,
    name: string,
    cluster: string,
    options?: { example?: boolean },
  ): Promise<void>;
  /** Reads a folder and reports what would happen, without changing anything. */
  inspect(dir: string): Promise<ProjectInspection>;
  /** Opens a project. `force` takes over a lock another instance holds. */
  openProject(dir: string, options?: { force?: boolean }): Promise<void>;
  closeProject(): Promise<void>;
  /** Persists one project file to disk (with backup) and updates the in-memory copy. */
  saveFile(fileName: ProjectFileName, content: string): Promise<void>;
  saveSettings(settings: ProjectSettings): Promise<void>;
  /**
   * Serialized read-modify-write of project settings.
   *
   * Prefer this over `saveSettings` whenever the new value depends on the old
   * one — it reads the current settings at commit time rather than from a
   * closure captured before some other operation wrote.
   */
  updateSettings(
    update: (current: ProjectSettings) => ProjectSettings,
  ): Promise<void>;
  /** Updates this machine's record for the open project. */
  updateLocal(patch: Partial<LocalProjectState>): Promise<void>;
  /**
   * Adds one change to the unsynchronized journal, which the next Sync turns
   * into the structured actions inside its commit.
   */
  recordChange(action: StructuredAction): void;
  /** Records a failed or recovered write. Called from the drafts store. */
  reportSaveOutcome(fileName: string, error: StudioError | null): void;
  refreshRecents(): void;
  /** Rebuilds the recents list from this machine's project records. */
  loadRecentProjects(): Promise<void>;
  /**
   * Removes a project from this machine entirely: the recents row and the
   * machine-local record behind it. Touches nothing in the project folder —
   * forgetting a project is not deleting it.
   */
  forgetProject(dir: string): Promise<void>;
  /**
   * Drops one recents row, keeping the machine-local record.
   *
   * What re-linking a moved project needs: the record is the same one, now
   * pointing at the new folder, and only the row naming the old path is stale.
   */
  dropRecentEntry(dir: string): void;
}

/** Writes are refused outright in read-only mode rather than failing later. */
function assertWritable(state: ProjectState): void {
  if (state.mode === "read-only") {
    throw new StudioError(
      "project.schemaTooNew",
      state.readOnlyReason ||
        "This project is open for viewing only and cannot be changed.",
    );
  }
}

/**
 * The journal is written on a short debounce.
 *
 * It has to survive a crash, so it cannot live only in memory; it is also
 * appended to at every commit boundary, so it cannot hit the disk on each one.
 * Two seconds is short enough that a crash loses at most the description of the
 * last thing done — never the change itself, which the drafts store has already
 * persisted.
 */
const JOURNAL_DEBOUNCE_MS = 2000;
let journalTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleJournalWrite() {
  if (journalTimer !== null) clearTimeout(journalTimer);
  journalTimer = setTimeout(() => {
    journalTimer = null;
    void flushJournal();
  }, JOURNAL_DEBOUNCE_MS);
}

/** Writes the journal now. Called before Sync, and when the project closes. */
export async function flushJournal(): Promise<void> {
  if (journalTimer !== null) {
    clearTimeout(journalTimer);
    journalTimer = null;
  }
  const local = useProjectStore.getState().local;
  if (!local) return;
  try {
    await saveLocalState(local);
  } catch (e) {
    // Losing the journal costs a commit its description, not an admin their
    // work — so this is reported rather than raised.
    console.error("Could not record what changed:", e);
  }
}

let heartbeat: ReturnType<typeof setInterval> | null = null;

function startHeartbeat(dir: string) {
  stopHeartbeat();
  if (typeof setInterval !== "function") return;
  heartbeat = setInterval(() => {
    void refreshLock(dir).then((status) => {
      // Somebody took the lock. Stopping the heartbeat is not enough — but it
      // is the part this module owns; the UI reads `saveHealth` for the rest.
      if (status.held && !status.owned) stopHeartbeat();
    });
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeat !== null) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  dir: null,
  settings: null,
  local: null,
  files: {},
  mode: "editable",
  readOnlyReason: "",
  lastMigration: null,
  migrationSnapshot: "",
  saveHealth: HEALTHY,
  recents: loadRecents(),

  async createProject(dir, name, cluster, options = {}) {
    await ipc("create_project_dir", { dir });
    const projectId = newId();
    // The managed Core Content pin is written with the very first settings
    // file, so no later asynchronous "add it if missing" pass can race an
    // administrator's own dependency write.
    let settings = withManagedOfficialSettings(
      defaultProjectSettings(name, cluster, projectId),
    );
    if (options.example) settings = markExampleProject(settings);
    const content = `${JSON.stringify(settings, null, 2)}\n`;

    // Seed files land before project.json, which is the backend's definition
    // of "this folder is a project". A failed seed therefore cannot appear as
    // a complete example that opens with half its teaching data missing.
    const seededFiles = options.example ? exampleProjectFiles() : {};
    for (const [fileName, seededContent] of Object.entries(seededFiles)) {
      await ipc("save_project_file", {
        dir,
        fileName,
        content: seededContent,
      });
    }
    await ipc("save_project_file", {
      dir,
      fileName: PROJECT_FILE.settings,
      content,
    });

    const local = newLocalProjectState(projectId, dir, name);
    await saveLocalState(local);
    if (!options.example) pushRecent(dir, name, projectId);
    set({
      dir,
      settings,
      local,
      files: { ...seededFiles, [PROJECT_FILE.settings]: content },
      mode: "editable",
      readOnlyReason: "",
      lastMigration: null,
      migrationSnapshot: "",
      saveHealth: HEALTHY,
      recents: loadRecents(),
    });
    startHeartbeat(dir);
  },

  async inspect(dir) {
    return inspectProject(dir);
  },

  async openProject(dir, options = {}) {
    // Switching projects while edits are still in the debounce window would
    // drop them, and the pending write would then target the wrong folder.
    if (get().dir) await flushDrafts();
    if (get().dir) await releaseLock(get().dir!);
    stopHeartbeat();

    const inspection = await inspectProject(dir);
    const opened = await openInspectedProject(inspection, options);

    if (!isExampleProject(opened.settings)) {
      pushRecent(dir, opened.settings.name, opened.settings.projectId);
    }
    set({
      dir: opened.dir,
      settings: opened.settings,
      local: opened.local,
      files: opened.files,
      mode: opened.mode,
      readOnlyReason: opened.readOnlyReason,
      lastMigration: opened.migration,
      migrationSnapshot: opened.migrationSnapshot,
      saveHealth: HEALTHY,
      recents: loadRecents(),
    });
    if (opened.mode === "editable") startHeartbeat(dir);
  },

  async closeProject() {
    // Drafts persist on a debounce; clearing `dir` first would strand any
    // write still in flight ("No project is open") and lose the edit.
    const dir = get().dir;
    if (dir && get().mode === "editable") {
      await flushDrafts();
      await flushJournal();
    }
    stopHeartbeat();
    if (dir) await releaseLock(dir);
    set({
      dir: null,
      settings: null,
      local: null,
      files: {},
      mode: "editable",
      readOnlyReason: "",
      lastMigration: null,
      migrationSnapshot: "",
      saveHealth: HEALTHY,
    });
  },

  async saveFile(fileName, content) {
    const state = get();
    if (!state.dir) throw new StudioError("save.failed", "No project is open.");
    assertWritable(state);
    try {
      await ipc("save_project_file", { dir: state.dir, fileName, content });
    } catch (e) {
      const error = asStudioError(
        e,
        "save.failed",
        `Could not save ${fileName}. Your changes are still here, but they are not on disk yet.`,
      );
      get().reportSaveOutcome(fileName, error);
      throw error;
    }
    get().reportSaveOutcome(fileName, null);
    set((s) => ({ files: { ...s.files, [fileName]: content } }));
  },

  async saveSettings(settings) {
    ProjectSettingsSchema.parse(settings);
    await get().saveFile(
      PROJECT_FILE.settings,
      `${JSON.stringify(settings, null, 2)}\n`,
    );
    set({ settings });
  },

  async updateSettings(update) {
    // Serialized on one chain so two callers cannot both read the settings,
    // both edit their own copy, and have the slower write erase the faster
    // one. Each `update` sees whatever the previous one committed.
    const run = settingsQueue.then(async () => {
      const current = get().settings;
      if (!current) throw new StudioError("save.failed", "No project is open.");
      const next = update(current);
      if (next === current) return;
      await get().saveSettings(next);
    });
    // The queue keeps going after a failure; only this caller sees the error.
    settingsQueue = run.catch(() => undefined);
    await run;
  },

  async updateLocal(patch) {
    const current = get().local;
    if (!current) throw new StudioError("save.failed", "No project is open.");
    const next = { ...current, ...patch };
    await saveLocalState(next);
    set({ local: next });
  },

  recordChange(action) {
    const state = get();
    // No project, or one that cannot be written, has no journal to add to.
    if (!state.local || state.mode === "read-only") return;
    const pendingActions = [...(state.local.pendingActions ?? []), action];
    set({ local: { ...state.local, pendingActions } });
    scheduleJournalWrite();
  },

  reportSaveOutcome(fileName, error) {
    set((s) => {
      const failing = s.saveHealth.failing.filter((f) => f !== fileName);
      if (error) failing.push(fileName);
      return {
        saveHealth: {
          ok: failing.length === 0,
          failing,
          lastError: error ?? s.saveHealth.lastError,
          lastFailureAt: error ? new Date().toISOString() : s.saveHealth.lastFailureAt,
        },
      };
    });
  },

  refreshRecents() {
    set({ recents: loadRecents() });
  },

  async loadRecentProjects() {
    const records = await listLocalProjects();
    if (records.length === 0) return;
    const recents = records
      .filter((r) => r.localPath)
      .filter((r) => !isExampleRecent(r))
      .slice(0, 8)
      .map((r) => ({
        dir: r.localPath,
        name: r.name,
        openedAt: r.openedAt,
        projectId: r.projectId,
      }));
    // Mirrored back, so the stored list carries the ids the records have and
    // Forget can reach the record behind a row.
    saveRecents(recents);
    set({ recents });
  },

  async forgetProject(dir) {
    const entry = get().recents.find((r) => r.dir === dir);
    const recents = loadRecents().filter((r) => r.dir !== dir);
    saveRecents(recents);
    set({ recents });
    if (!entry?.projectId) return;
    try {
      await ipc("local_state_delete", { projectId: entry.projectId });
    } catch (e) {
      // The row is already gone from the list the admin is looking at. A
      // record that outlives it reappears on the next rebuild, which is worth
      // saying rather than throwing over.
      console.error("Could not remove the local record for this project:", e);
    }
  },

  dropRecentEntry(dir) {
    const recents = loadRecents().filter((r) => r.dir !== dir);
    saveRecents(recents);
    set({ recents });
  },
}));

/**
 * Records one change for the next Sync's commit, from outside a component.
 *
 * A free function so a service or an event handler can describe what it did
 * without threading the store through — the store action is the single
 * implementation, exactly as `recordActivity` works.
 */
export function recordChange(action: StructuredAction): void {
  useProjectStore.getState().recordChange(action);
}

/** The open project's machine-local record, or a blank one. Never null. */
export function currentLocalState(): LocalProjectState {
  return useProjectStore.getState().local ?? newLocalProjectState("", "", "");
}

/**
 * The repository configuration for the open project.
 *
 * Assembled from the portable output layout and this machine's binding, which
 * is why it is a selector rather than a field: neither half is meaningful on
 * its own, and storing the assembled result is what put one administrator's
 * repository into everybody's project file.
 */
export function useGithubConfig(): GithubConfig {
  const settings = useProjectStore((s) => s.settings);
  const local = useProjectStore((s) => s.local);
  return effectiveGithubConfig(settings, local);
}

/** The same, outside React. */
export function currentGithubConfig(): GithubConfig {
  const { settings, local } = useProjectStore.getState();
  return effectiveGithubConfig(settings, local);
}

/** The folder icons are scanned from on this machine. */
export function useImagesDirSetting(): string {
  return useProjectStore((s) => s.local?.imagesDir ?? "");
}

export { loadLocalState };
