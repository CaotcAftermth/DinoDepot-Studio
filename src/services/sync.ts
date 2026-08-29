import * as git from "./gitRepo";
import { snapshotProject } from "./projectSession";
import { StudioError, asStudioError } from "../model/errors";
import { newId } from "../model/ids";
import {
  collapseActions,
  encodeCommitMessage,
  EXTERNAL_CHANGES_ACTION,
  StructuredActionSchema,
  type StructuredAction,
} from "../model/commitActions";
import {
  phaseForError,
  type SyncOutcome,
  type SyncPhase,
} from "../model/syncState";
import type { LocalProjectState } from "../model/localState";

/**
 * Sync: making this computer's copy of the project and GitHub's agree, without
 * either administrator losing work.
 *
 * Save, Sync and Publish are three separate things. Save puts edits on this
 * disk. Sync shares them. Publish generates the public site, and requires a
 * synchronized source.
 *
 * The sequence below is the design, and its order is load-bearing:
 *
 *  1. Flush pending saves - and refuse if any failed. Syncing what is in memory
 *     rather than what is on disk is how an administrator ends up sharing work
 *     they later cannot recover.
 *  2. Check the project is in a state that may be written at all.
 *  3. Confirm this instance still holds the project.
 *  4. Take a recovery snapshot before anything is committed.
 *  5. Fetch. This moves the remote-tracking pointer and nothing else.
 *  6. Compare where we last agreed, where we are, and where they are.
 *  7. Remote unchanged → one commit describing what was done here.
 *  8. Both changed → reconcile semantically. (Phase 3.)
 *  9. Anything only a person can settle → stop and ask.
 * 10. Validate the result before it can leave.
 * 11. Commit on top of the latest remote state.
 * 12. Push, never forced.
 * 13. Rejected because they got there first → fetch and go round again.
 * 14. Record the new synchronized point only once the push has landed.
 *
 * Step 12 is the guarantee. Everything above it is an attempt to make step 13
 * rare; step 12 is what makes losing somebody's commit impossible when all of
 * that fails.
 */

/** How many times to go round after losing a race before asking for help. */
const MAX_PUSH_ATTEMPTS = 5;

/** Everything Sync needs, passed in so the orchestration can be tested whole. */
export interface SyncContext {
  dir: string;
  projectId: string;
  schemaVersion: number;
  local: LocalProjectState;
  /** Writes the project to disk. Must report failures rather than swallow them. */
  flush(): Promise<{ ok: boolean; failures: { fileName: string }[] }>;
  /** Blocking reasons that have nothing to do with the network. */
  readiness(): { ready: boolean; reason: string; code?: StudioError["code"] };
  /**
   * The GitHub account these operations authenticate as.
   *
   * An account id, never a credential: the token is looked up inside Rust, so
   * it never exists in this half of the application.
   */
  accountId(): Promise<string>;
  /** Persists machine-local state - the journal, the synchronized point. */
  saveLocal(patch: Partial<LocalProjectState>): Promise<void>;
  /** The project's files as they are on disk, after the flush. */
  readLocalFiles(): Promise<Record<string, string>>;
  /** Writes merged files back before the commit is made. */
  writeFiles(files: Record<string, string>): Promise<void>;
  /** Progress, for the status line. */
  onPhase?(phase: SyncPhase): void;
  /**
   * Reconciles local and remote when both moved. Phase 3 supplies the real
   * one; without it, a diverged project stops and says so rather than
   * guessing.
   */
  reconcile?(input: ReconcileInput): Promise<ReconcileResult>;
}

export interface ReconcileInput {
  /** The last commit both sides agreed on, or "" if there has never been one. */
  base: string;
  /** What is on this computer, on top of the base. */
  localCommit: string;
  /** What the other administrators have pushed. */
  remoteCommit: string;
  dir: string;
  /** The project as it stands on disk right now. */
  localFiles: Record<string, string>;
}

export interface ReconcileResult {
  /** True when everything merged without a decision being needed. */
  merged: boolean;
  /** Files to write before committing, keyed by project-relative name. */
  files: Record<string, string>;
  /** Extra actions describing what was integrated. */
  actions: StructuredAction[];
  conflicts: { count: number; domains: string[] };
}

function outcome(over: Partial<SyncOutcome>): SyncOutcome {
  return {
    kind: "blocked",
    phase: "blocked",
    message: "",
    commit: "",
    syncedCommit: "",
    actions: [],
    retries: 0,
    conflicts: null,
    error: null,
    ...over,
  };
}

function failed(error: StudioError, retries = 0): SyncOutcome {
  const phase = phaseForError(error);
  return outcome({
    kind: phase === "offline" ? "offline" : "blocked",
    phase,
    message: error.message,
    error,
    retries,
  });
}

/**
 * Runs one Sync.
 *
 * Resolves with an outcome rather than throwing: every failure here is
 * something the administrator is shown and can act on, and a rejected promise
 * would push that decision into whichever caller happened to be first.
 */
export async function syncProject(context: SyncContext): Promise<SyncOutcome> {
  const operationId = newId();
  const phase = (p: SyncPhase) => context.onPhase?.(p);

  // --- 1. everything on disk --------------------------------------------
  let flushed;
  try {
    flushed = await context.flush();
  } catch (e) {
    return failed(asStudioError(e, "save.failed", "Your changes could not be saved."));
  }
  if (!flushed.ok) {
    return failed(
      new StudioError(
        "save.failed",
        "Some of your changes are not saved on this computer yet, so there is nothing safe to share. Fix that first.",
        { detail: flushed.failures.map((f) => f.fileName).join(", ") },
      ),
    );
  }

  // --- 2. is this project allowed to be written at all -------------------
  const readiness = context.readiness();
  if (!readiness.ready) {
    return failed(new StudioError(readiness.code ?? "validation.failed", readiness.reason));
  }

  let accountId: string;
  try {
    accountId = await context.accountId();
  } catch (e) {
    return failed(
      asStudioError(
        e,
        "auth.missing",
        "Connect your GitHub account before sharing changes.",
      ),
    );
  }
  if (!accountId) {
    return failed(
      new StudioError(
        "auth.missing",
        "Connect your GitHub account before sharing changes.",
      ),
    );
  }

  // --- 3–4. a recovery point before anything is written ------------------
  phase("checking");
  const base = context.local.lastSyncedCommit;
  let snapshotPath = "";
  try {
    snapshotPath = await snapshotProject(context.dir, "pre-sync");
  } catch {
    // A snapshot is a safety net, not a precondition - a project on a full disk
    // still deserves the chance to get its work off this machine.
  }
  await context.saveLocal({
    pending: {
      operationId,
      kind: "sync",
      startedAt: new Date().toISOString(),
      stage: "started",
      recoveryRef: snapshotPath,
    },
  });

  let retries = 0;
  try {
    while (retries < MAX_PUSH_ATTEMPTS) {
      // --- 5. fetch ------------------------------------------------------
      const remote = await git.fetch(context.dir, branchOf(context), accountId);
      const before = await git.state(context.dir, branchOf(context));

      // --- 6. where does everybody stand ---------------------------------
      const localMoved = before.dirty || before.head !== base;
      const remoteMoved = remote !== "" && remote !== base;

      if (!localMoved && !remoteMoved) {
        await finish(context, operationId, before.head || base);
        return outcome({
          kind: "already-synchronized",
          phase: "synchronized",
          message: "Everything is already up to date.",
          syncedCommit: before.head || base,
          retries,
        });
      }

      // Only they worked. Taking their version wholesale is safe precisely
      // because there is nothing here to lose - and it is the common case on a
      // machine that has been closed for a week.
      if (!localMoved && remoteMoved) {
        phase("integrating");
        const forward = await git.fastForward(context.dir, branchOf(context));
        if (!forward.advanced) {
          return failed(
            new StudioError(
              "sync.conflictsPending",
              "The team's changes could not be brought in automatically.",
              { detail: forward.refused },
            ),
            retries,
          );
        }
        await finish(context, operationId, forward.commit);
        return outcome({
          kind: "integrated",
          phase: "synchronized",
          message: "The team's changes are now on this computer.",
          syncedCommit: forward.commit,
          retries,
        });
      }

      // --- 7/8. reconcile if both sides moved ----------------------------
      let integrated: StructuredAction[] = [];
      // Tracked separately from `integrated`: a reconciliation that merged
      // cleanly and had nothing quotable to say about it still brought the
      // other administrator's work in, and the outcome must say so.
      let reconciled = false;
      const conflicts: SyncOutcome["conflicts"] = null;

      if (remoteMoved && localMoved) {
        phase("integrating");
        if (!context.reconcile) {
          // Refusing is the honest answer. Committing on top of a remote whose
          // contents were never looked at would keep the other administrator's
          // commit in history while silently replacing every file in it.
          return failed(
            new StudioError(
              "sync.conflictsPending",
              "Another administrator has saved changes to this project. Update DinoDepot Studio to bring their work in alongside yours.",
              { detail: `local ${before.head} / other ${remote} / base ${base || "none"}` },
            ),
            retries,
          );
        }
        const result = await context.reconcile({
          base,
          localCommit: before.head,
          remoteCommit: remote,
          dir: context.dir,
          localFiles: await context.readLocalFiles(),
        });
        if (!result.merged) {
          // --- 9. only a person can settle this --------------------------
          phase("needs-decision");
          await context.saveLocal({
            pending: {
              operationId,
              kind: "sync",
              startedAt: new Date().toISOString(),
              stage: "awaiting-decision",
              recoveryRef: snapshotPath,
            },
          });
          return outcome({
            kind: "needs-decision",
            phase: "needs-decision",
            message: describeConflicts(result.conflicts),
            conflicts: result.conflicts,
            retries,
          });
        }
        // The merged project goes to disk before it is committed, so what is
        // recorded is exactly what the administrator will be looking at.
        await context.writeFiles(result.files);
        integrated = result.actions;
        reconciled = true;
      }

      // --- 10/11. one commit describing what was done --------------------
      const journal = collapseActions(context.local.pendingActions ?? []);
      const actions = describeWork(journal, integrated, before.dirty);
      const message = encodeCommitMessage({
        projectId: context.projectId,
        schemaVersion: context.schemaVersion,
        operationId,
        actor: context.local.githubLogin,
        actions,
      });

      const commit = await git.commit(context.dir, branchOf(context), message);
      await git.markRecovery(context.dir, operationId, commit);

      // --- 12. push, never forced ----------------------------------------
      phase("sending");
      const push = await git.push(context.dir, branchOf(context), accountId);

      if (push.pushed) {
        // --- 14. only now is this the synchronized point -----------------
        await finish(context, operationId, commit);
        return outcome({
          kind: reconciled ? "integrated" : "synchronized",
          phase: "synchronized",
          message: reconciled
            ? "Your changes are shared, and the team's changes are here."
            : "Your changes are shared with the team.",
          commit,
          syncedCommit: commit,
          actions,
          conflicts,
          retries,
        });
      }

      // --- 13. they got there first; go round again ----------------------
      if (!push.rejected) {
        return failed(
          new StudioError("unknown", "Your changes could not be shared. Nothing was lost."),
          retries,
        );
      }
      retries++;
      phase("checking");
    }

    return failed(
      new StudioError(
        "repo.conflict",
        "The team is saving changes faster than this can keep up. Your work is safe here - try again in a moment.",
        { detail: `gave up after ${MAX_PUSH_ATTEMPTS} attempts` },
      ),
      retries,
    );
  } catch (e) {
    const error = asStudioError(e, "unknown", "Your changes could not be shared.");
    // The pending record stays: an interrupted Sync is reconciled against the
    // remote by operation id next time, rather than blindly repeated.
    return failed(error, retries);
  }
}

function branchOf(context: SyncContext): string {
  return context.local.source?.branch || "main";
}

/**
 * Clears the operation and records the new synchronized point.
 *
 * The journal is emptied here and nowhere else: an action stays pending until
 * the commit describing it is provably on GitHub.
 */
async function finish(
  context: SyncContext,
  operationId: string,
  commit: string,
): Promise<void> {
  await context.saveLocal({
    lastSyncedCommit: commit,
    lastSyncedAt: new Date().toISOString(),
    pendingActions: [],
    pending: null,
  });
  try {
    await git.clearRecovery(context.dir, operationId);
  } catch {
    /* a stale recovery ref is harmless; it is overwritten next time */
  }
}

/**
 * What the commit will say.
 *
 * When the working tree changed but the journal is empty, somebody edited the
 * project outside Studio - a hand-edited JSON file, a restored backup. Saying
 * so is better than a commit that claims nothing happened.
 */
export function describeWork(
  journal: StructuredAction[],
  integrated: StructuredAction[],
  workingTreeChanged: boolean,
): StructuredAction[] {
  const actions = [...journal, ...integrated];
  if (actions.length === 0 && workingTreeChanged) {
    return [StructuredActionSchema.parse({ type: EXTERNAL_CHANGES_ACTION })];
  }
  return actions;
}

function describeConflicts(conflicts: { count: number; domains: string[] }): string {
  if (conflicts.count === 1) {
    return "One change needs your decision: you and another administrator edited the same thing.";
  }
  return `${conflicts.count} changes need your decision: you and another administrator edited the same things.`;
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * Adds an action to the unsynchronized journal.
 *
 * Appended rather than collapsed on the way in, so the order things were done
 * in survives a crash; collapsing happens when the commit is written.
 */
export function appendToJournal(
  local: LocalProjectState,
  action: StructuredAction,
): StructuredAction[] {
  return [...(local.pendingActions ?? []), action];
}

/**
 * Whether this project has work that has not been shared.
 *
 * The journal alone is not enough: a file edited outside Studio is
 * unsynchronized work too, and nothing recorded it.
 */
export function hasUnsharedWork(
  local: LocalProjectState,
  repo: { head: string; dirty: boolean },
): boolean {
  if ((local.pendingActions ?? []).length > 0) return true;
  if (repo.dirty) return true;
  return repo.head !== "" && repo.head !== local.lastSyncedCommit;
}
