import { create } from "zustand";
import { ipc } from "../services/ipc";
import { asStudioError } from "../model/errors";
import { buildHistory, type CommitSummary, type HistoryEntry } from "../model/history.git";
import { formatActivityTime } from "../model/activity";
import { exampleProjectActivityEvents, isExampleProject } from "../model/exampleProject";
import { useProjectStore } from "./projectStore";

/**
 * The project's history, read from Git.
 *
 * Replaces the `activity.json` the project used to carry. That file was a
 * shared append-only array: two administrators fought over it forever, and it
 * lied the moment anybody edited a file outside Studio.
 */

interface HistoryState {
  entries: HistoryEntry[];
  loading: boolean;
  /** Empty unless the history could not be read. */
  problem: string;
  /** Which entry a restore is running for. */
  restoring: string;

  load(limit?: number): Promise<void>;
  /**
   * Puts an older version's files back.
   *
   * Writes into the working tree and stops there - the next Sync commits it as
   * an ordinary change on top of history. Nothing here resets or rewrites,
   * because the history is shared and somebody may already have pulled it.
   */
  restore(entry: HistoryEntry): Promise<boolean>;
}

// Only newest request may update shared rows. Opening expanded history can
// overlap Overview's initial 20-row request on a slow disk.
let loadGeneration = 0;

export const useHistoryStore = create<HistoryState>((set, get) => ({
  entries: [],
  loading: false,
  problem: "",
  restoring: "",

  async load(limit = 20) {
    const generation = ++loadGeneration;
    const project = useProjectStore.getState();
    if (!project.dir) {
      set({ entries: [], loading: false, problem: "" });
      return;
    }
    if (isExampleProject(project.settings)) {
      const now = new Date();
      const entries: HistoryEntry[] = exampleProjectActivityEvents(now).map((event) => {
        const author = event.title.startsWith("RexOps") ? "RexOps" : "ExampleOwner";
        const withoutAuthor = event.title.replace(/^(RexOps|ExampleOwner)\s+/, "");
        return {
          sha: `example-${event.id}`,
          shortSha: event.id.slice(0, 7),
          at: new Date(event.at).getTime(),
          when: formatActivityTime(event.at, now),
          author,
          title: withoutAuthor.charAt(0).toUpperCase() + withoutAuthor.slice(1),
          details: event.detail ? [event.detail] : [],
          undescribed: 0,
          kind: event.kind,
          fromStudio: true,
          isHead: true,
          isPublish: event.kind === "publish",
        };
      });
      set({ entries: entries.slice(0, limit), loading: false, problem: "" });
      return;
    }
    set({ loading: true });
    try {
      const commits = await ipc<CommitSummary[]>("git_log", {
        dir: project.dir,
        branch: project.local?.source?.branch || "main",
        limit,
      });
      if (generation === loadGeneration) {
        set({ entries: buildHistory(commits, limit), problem: "" });
      }
    } catch (e) {
      // A project with no repository behind it has no history, which is the
      // normal state of a new one - not something to report as a fault. Only a
      // project that *is* connected gets an error message.
      const connected = Boolean(useProjectStore.getState().local?.source?.owner);
      if (generation === loadGeneration) {
        set({
          entries: [],
          problem: connected
            ? asStudioError(e, "unknown", "The project history could not be read.").message
            : "",
        });
      }
    } finally {
      if (generation === loadGeneration) set({ loading: false });
    }
  },

  async restore(entry) {
    const project = useProjectStore.getState();
    if (!project.dir || project.mode === "read-only") return false;

    set({ restoring: entry.sha });
    try {
      // Every project file, so a restore is the project as it was rather than a
      // mixture of two versions.
      const paths = Object.keys(project.files);
      const restored = await ipc<number>("git_restore_files", {
        dir: project.dir,
        commit: entry.sha,
        paths,
      });
      if (restored === 0) return false;

      // Re-read from disk: the drafts in memory are the version that was just
      // replaced, and the next autosave would write them straight back over it.
      await project.openProject(project.dir);
      await get().load();
      return true;
    } finally {
      set({ restoring: "" });
    }
  },
}));

// Reload whenever the open project changes.
useProjectStore.subscribe((state, prev) => {
  if (state.dir !== prev.dir) void useHistoryStore.getState().load();
});
