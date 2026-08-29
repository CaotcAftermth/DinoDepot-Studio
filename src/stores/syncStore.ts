import { create } from "zustand";
import { ipc } from "../services/ipc";
import { syncProject, type SyncContext } from "../services/sync";
import { reconcile } from "../services/reconcile";
import { flushPendingSaves, useDraftsStore } from "./draftsStore";
import { flushJournal, useProjectStore } from "./projectStore";
import { CURRENT_PROJECT_SCHEMA } from "../model/manifest";
import { canSync } from "../model/localState";
import { StudioError } from "../model/errors";
import { publicSourcePrivacyProblem } from "../model/repoSetup";
import { connectionProblem, refreshConnection } from "../services/repoConnection";
import type { Conflict, ResolvedConflict } from "../model/merge/conflicts";
import {
  restingPhase,
  type SyncOutcome,
  type SyncPhase,
} from "../model/syncState";

/**
 * What the Sync button is doing, and what it needs from the administrator.
 *
 * The orchestration itself is a pure-ish function in `services/sync.ts`; this
 * is only the part that reaches into the stores for its inputs and holds the
 * result. Keeping the two apart is what lets the whole fourteen-step sequence
 * be tested without a project, a repository or a webview.
 */

interface SyncState {
  phase: SyncPhase;
  running: boolean;
  /** The last completed Sync, for the status line and Advanced details. */
  last: SyncOutcome | null;
  /** Questions waiting on the administrator. Empty when there are none. */
  conflicts: Conflict[];
  /** Answers given so far, carried into the re-run. */
  answers: ResolvedConflict[];

  sync(): Promise<SyncOutcome>;
  /** Re-runs the merge with the administrator's decisions applied. */
  resolve(answers: ResolvedConflict[]): Promise<SyncOutcome>;
  /** Leaves the questions unanswered. The work stays here, unshared. */
  dismissConflicts(): void;
  /** Recomputes the resting phase after an edit or a project change. */
  refreshPhase(): void;
}

export const useSyncStore = create<SyncState>((set, get) => ({
  phase: "saved-locally",
  running: false,
  last: null,
  conflicts: [],
  answers: [],

  async sync() {
    return run(set, get, get().answers);
  },

  async resolve(answers) {
    set({ answers });
    return run(set, get, answers);
  },

  dismissConflicts() {
    set({ conflicts: [], answers: [] });
    get().refreshPhase();
  },

  refreshPhase() {
    if (get().running) return;
    const project = useProjectStore.getState();
    set({
      phase: restingPhase({
        // Anything in the journal is unshared work. A file changed outside
        // Studio is too, but only a fetch can tell - so this is the cheap,
        // always-available half, and Sync itself does the thorough version.
        hasLocalChanges: (project.local?.pendingActions ?? []).length > 0,
        canSync: canSync(project.local) && project.mode === "editable",
        saveHealthy: project.saveHealth.ok,
      }),
    });
  },
}));

async function run(
  set: (partial: Partial<SyncState>) => void,
  get: () => SyncState,
  answers: ResolvedConflict[],
): Promise<SyncOutcome> {
  if (get().running) return get().last ?? emptyOutcome();

  const project = useProjectStore.getState();
  const { dir, settings, local } = project;
  if (!dir || !settings || !local) {
    return emptyOutcome("No project is open.");
  }

  set({ running: true, phase: "checking" });
  try {
    const drafts = useDraftsStore.getState();
    const privacyProblem = publicSourcePrivacyProblem({
      topology: local.topology,
      playerDataEnabled: settings.modules["player-data"] === true,
      playerCount: drafts.players.players.length,
      cleanSlateCount: drafts.players.cleanSlates.length,
      hasPlayerActivity: drafts.activity.events.some((event) => event.kind === "players"),
      hasPlayerHistory: drafts.history.records.some((record) => record.family === "players"),
      hasPendingPlayerChanges: local.pendingActions.some((action) =>
        action.type.startsWith("player."),
      ),
    });
    if (privacyProblem) {
      const result = emptyOutcome(
        privacyProblem,
        new StudioError("publish.privacyViolation", privacyProblem),
      );
      set({ last: result, phase: result.phase });
      return result;
    }

    const refreshed = await refreshConnection(local, dir);
    if (Object.keys(refreshed.patch).length > 0) {
      await useProjectStore.getState().updateLocal(refreshed.patch);
    }
    const currentLocal = { ...local, ...refreshed.patch };
    const repositoryProblem = connectionProblem(refreshed.report, "sync");
    if (repositoryProblem) {
      const result = emptyOutcome(
        repositoryProblem,
        new StudioError("repo.unavailable", repositoryProblem),
      );
      set({ last: result, phase: result.phase });
      return result;
    }

    const context: SyncContext = {
      dir,
      projectId: settings.projectId,
      schemaVersion: CURRENT_PROJECT_SCHEMA,
      local: currentLocal,
      async flush() {
        // The journal describes what the commit will say, so it has to be on
        // disk before the commit is built - a crash between the two would
        // otherwise produce a commit that cannot explain itself.
        await flushJournal();
        return flushPendingSaves();
      },
      readiness() {
        const state = useProjectStore.getState();
        if (state.mode === "read-only") {
          return {
            ready: false,
            reason:
              state.readOnlyReason ||
              "This project is open for viewing only and cannot be shared.",
            code: "project.schemaTooNew" as const,
          };
        }
        if (!state.saveHealth.ok) {
          return {
            ready: false,
            reason:
              "Some of your changes are not saved on this computer yet. Fix that before sharing.",
            code: "save.failed" as const,
          };
        }
        if (!state.local?.source?.githubId && !state.local?.source?.owner) {
          return {
            ready: false,
            reason: "Connect this project to a GitHub repository first.",
            code: "repo.unavailable" as const,
          };
        }
        return { ready: true, reason: "" };
      },
      async accountId() {
        return useProjectStore.getState().local?.githubAccountId ?? "";
      },
      async saveLocal(patch) {
        await useProjectStore.getState().updateLocal(patch);
      },
      async readLocalFiles() {
        return ipc<Record<string, string>>("load_project", { dir });
      },
      async writeFiles(files) {
        const store = useProjectStore.getState();
        for (const [fileName, content] of Object.entries(files)) {
          await store.saveFile(fileName as never, content);
        }
        // The merged project is now on disk; the draft slices have to be
        // re-read from it or the next autosave would write the pre-merge
        // version straight back over it.
        const { useDraftsStore } = await import("./draftsStore");
        useDraftsStore.setState({ hydratedFor: null });
        useDraftsStore.getState().hydrate();
      },
      onPhase(phase) {
        set({ phase });
      },
      async reconcile(input) {
        const outcome = await reconcile({
          input,
          localFiles: input.localFiles,
          answers,
        });
        set({ conflicts: outcome.conflictList });
        return outcome;
      },
    };

    const result = await syncProject(context);
    set({
      running: false,
      last: result,
      phase: result.phase,
      // A successful Sync clears the questions and the answers together.
      conflicts: result.kind === "needs-decision" ? get().conflicts : [],
      answers: result.kind === "needs-decision" ? answers : [],
    });
    if (result.kind !== "needs-decision") get().refreshPhase();
    return result;
  } catch (e) {
    // syncProject resolves rather than throws; this is the belt-and-braces
    // case, so the button can never be left spinning.
    set({ running: false });
    get().refreshPhase();
    return emptyOutcome(e instanceof Error ? e.message : String(e));
  } finally {
    set({ running: false });
  }
}

function emptyOutcome(message = "", error: StudioError | null = null): SyncOutcome {
  return {
    kind: "blocked",
    phase: "blocked",
    message,
    commit: "",
    syncedCommit: "",
    actions: [],
    retries: 0,
    conflicts: null,
    error,
  };
}

// Keep the resting phase in step with the project without every page having to
// remember to ask.
useProjectStore.subscribe((state, prev) => {
  if (
    state.dir !== prev.dir ||
    state.local?.pendingActions !== prev.local?.pendingActions ||
    state.saveHealth.ok !== prev.saveHealth.ok ||
    state.mode !== prev.mode
  ) {
    useSyncStore.getState().refreshPhase();
  }
});
