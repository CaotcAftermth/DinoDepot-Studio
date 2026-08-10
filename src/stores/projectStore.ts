import { create } from "zustand";
import { ipc } from "../services/ipc";
import {
  defaultProjectSettings,
  PROJECT_FILE,
  ProjectSettings,
  ProjectSettingsSchema,
  type ProjectFileName,
} from "../model/project";

export interface RecentProject {
  dir: string;
  name: string;
  openedAt: string;
}

const RECENTS_KEY = "ddstudio.recentProjects";

function loadRecents(): RecentProject[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

/**
 * Flushes the drafts store's debounced writes. Imported lazily because
 * draftsStore depends on this module — a static import would be a cycle.
 */
async function flushDrafts(): Promise<void> {
  if (!useProjectStore.getState().dir) return;
  try {
    const { flushPendingSaves } = await import("./draftsStore");
    await flushPendingSaves();
  } catch (e) {
    console.error("Failed to flush drafts before closing the project:", e);
  }
}

function pushRecent(dir: string, name: string) {
  const recents = loadRecents().filter((r) => r.dir !== dir);
  recents.unshift({ dir, name, openedAt: new Date().toISOString() });
  localStorage.setItem(RECENTS_KEY, JSON.stringify(recents.slice(0, 8)));
}

interface ProjectState {
  /** Absolute path of the open project folder, or null when no project open. */
  dir: string | null;
  settings: ProjectSettings | null;
  /** Raw contents of all project files as loaded/saved. Domain stores hydrate from here. */
  files: Record<string, string>;
  recents: RecentProject[];

  createProject(dir: string, name: string, cluster: string): Promise<void>;
  openProject(dir: string): Promise<void>;
  closeProject(): Promise<void>;
  /** Persists one project file to disk (with backup) and updates the in-memory copy. */
  saveFile(fileName: ProjectFileName, content: string): Promise<void>;
  saveSettings(settings: ProjectSettings): Promise<void>;
  refreshRecents(): void;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  dir: null,
  settings: null,
  files: {},
  recents: loadRecents(),

  async createProject(dir, name, cluster) {
    await ipc("create_project_dir", { dir });
    const settings = defaultProjectSettings(name, cluster);
    const content = JSON.stringify(settings, null, 2);
    await ipc("save_project_file", {
      dir,
      fileName: PROJECT_FILE.settings,
      content,
    });
    pushRecent(dir, name);
    set({
      dir,
      settings,
      files: { [PROJECT_FILE.settings]: content },
      recents: loadRecents(),
    });
  },

  async openProject(dir) {
    // Switching projects while edits are still in the debounce window would
    // drop them, and the pending write would then target the wrong folder.
    await flushDrafts();
    const files = await ipc<Record<string, string>>("load_project", { dir });
    const parsed = ProjectSettingsSchema.safeParse(
      JSON.parse(files[PROJECT_FILE.settings]),
    );
    if (!parsed.success) {
      throw new Error(`project.json is invalid: ${parsed.error.message}`);
    }
    pushRecent(dir, parsed.data.name);
    set({ dir, settings: parsed.data, files, recents: loadRecents() });
  },

  async closeProject() {
    // Drafts persist on a debounce; clearing `dir` first would strand any
    // write still in flight ("No project is open") and lose the edit.
    await flushDrafts();
    set({ dir: null, settings: null, files: {} });
  },

  async saveFile(fileName, content) {
    const { dir } = get();
    if (!dir) throw new Error("No project is open");
    await ipc("save_project_file", { dir, fileName, content });
    set((s) => ({ files: { ...s.files, [fileName]: content } }));
  },

  async saveSettings(settings) {
    ProjectSettingsSchema.parse(settings);
    await get().saveFile(PROJECT_FILE.settings, JSON.stringify(settings, null, 2));
    set({ settings });
  },

  refreshRecents() {
    set({ recents: loadRecents() });
  },
}));
