import type { StudioError } from "./errors";
import type { StructuredAction } from "./commitActions";

/**
 * What the administrator is told, and nothing else.
 *
 * The whole point of the synchronization design is that nobody using it has to
 * know what a merge base or a non-fast-forward rejection is. This is the
 * complete vocabulary the normal UI may use; anything technical belongs behind
 * Advanced Details.
 */

export const SYNC_PHASES = [
  /** Nothing to send. */
  "synchronized",
  /** Edits are on disk here and have not been shared yet. */
  "local-changes",
  /** Saved, but the write failed or the project cannot be synced yet. */
  "saved-locally",
  "checking",
  "integrating",
  /** A real disagreement two people made that only a person can settle. */
  "needs-decision",
  "sending",
  "offline",
  "access-expired",
  "repository-unavailable",
  "blocked",
] as const;

export type SyncPhase = (typeof SYNC_PHASES)[number];

/** The exact words for each phase. Deliberately free of Git vocabulary. */
export const SYNC_PHASE_LABELS: Record<SyncPhase, string> = {
  synchronized: "Synchronized",
  "local-changes": "Local changes",
  "saved-locally": "Saved locally - waiting to sync",
  checking: "Checking for team changes",
  integrating: "Integrating changes",
  "needs-decision": "Needs your decision",
  sending: "Sharing your changes",
  offline: "Offline",
  "access-expired": "Access expired",
  "repository-unavailable": "Repository unavailable",
  blocked: "Cannot sync yet",
};

/** Phases where an admin can still work normally, whatever else is true. */
export function isWorkingPhase(phase: SyncPhase): boolean {
  return phase !== "needs-decision" && phase !== "blocked";
}

/**
 * Terms that must never reach the normal UI.
 *
 * Enforced by a test over the labels and messages, because the failure mode is
 * somebody writing a helpful-sounding "the push was rejected, please rebase"
 * into a toast six months from now.
 */
export const FORBIDDEN_UI_TERMS = [
  "merge base",
  "detached head",
  "rebase",
  "force push",
  "force-push",
  "non-fast-forward",
  "fast-forward",
  "refspec",
  "object database",
  "reflog",
  "stash",
  "HEAD~",
];

/** Whether a piece of user-facing text leaks an implementation term. */
export function leaksGitTerms(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_UI_TERMS.filter((term) => lower.includes(term.toLowerCase()));
}

// ---------------------------------------------------------------------------
// The outcome of one Sync
// ---------------------------------------------------------------------------

export type SyncOutcomeKind =
  /** Nothing had changed on either side. */
  | "already-synchronized"
  /** One commit was created and pushed. */
  | "synchronized"
  /** Other administrators' work arrived and merged cleanly with yours. */
  | "integrated"
  /** A genuine disagreement is waiting on the administrator. */
  | "needs-decision"
  /** Nothing was sent, and nothing was lost. */
  | "offline"
  /** Refused before anything was attempted. */
  | "blocked";

export interface SyncConflictSummary {
  /** How many disagreements need settling. */
  count: number;
  /** What they are about, for the "3 creatures, 1 mod" line. */
  domains: string[];
}

export interface SyncOutcome {
  kind: SyncOutcomeKind;
  phase: SyncPhase;
  /** One sentence for the administrator. */
  message: string;
  /** The commit this Sync created, when it created one. */
  commit: string;
  /** The source revision the project is now synchronized to. */
  syncedCommit: string;
  /** Actions the commit recorded. */
  actions: StructuredAction[];
  /** How many times the branch moved under us before the push landed. */
  retries: number;
  conflicts: SyncConflictSummary | null;
  /** Why it stopped, when it stopped. */
  error: StudioError | null;
}

/** The phase a failure should present as. */
export function phaseForError(error: StudioError): SyncPhase {
  switch (error.code) {
    case "network.offline":
    case "network.timeout":
      return "offline";
    case "auth.expired":
    case "auth.missing":
    case "auth.forbidden":
      return "access-expired";
    case "repo.unavailable":
    case "repo.identityMismatch":
      return "repository-unavailable";
    case "sync.conflictsPending":
      return "needs-decision";
    default:
      return "blocked";
  }
}

/**
 * The phase to show when no Sync is running.
 *
 * `saved-locally` rather than `local-changes` whenever something is stopping a
 * Sync from being possible - the distinction the admin cares about is "this
 * will go out next time" versus "this is going nowhere until I do something".
 */
export function restingPhase(input: {
  hasLocalChanges: boolean;
  canSync: boolean;
  saveHealthy: boolean;
}): SyncPhase {
  if (!input.saveHealthy) return "blocked";
  if (!input.hasLocalChanges) return input.canSync ? "synchronized" : "saved-locally";
  return input.canSync ? "local-changes" : "saved-locally";
}
