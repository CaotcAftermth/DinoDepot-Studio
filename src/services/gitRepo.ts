import { ipc } from "./ipc";
import {
  asStudioError,
  StudioError,
  type StudioErrorCode,
  STUDIO_ERROR_CODES,
} from "../model/errors";

/**
 * The repository service.
 *
 * Everything the app knows about Git goes through this interface, and the
 * implementation behind it is libgit2 in Rust. Keeping the boundary here means
 * the synchronization engine never names a Git concept it does not need — and
 * that replacing the implementation is one module's problem.
 *
 * Rust rejects with a JSON-encoded failure carrying a code. Decoding it here
 * rather than at each call site is what lets the orchestration branch on
 * "the branch moved on" versus "your access was revoked" without reading
 * English out of an error string.
 */

export interface GitCapabilities {
  version: string;
  https: boolean;
  ssh: boolean;
  threads: boolean;
}

export interface RepoState {
  /** Commit the local branch points at, or "" before the first commit. */
  head: string;
  /** Commit the remote-tracking ref points at, or "" if never fetched. */
  remote: string;
  dirty: boolean;
  branch: string;
}

export interface PushOutcome {
  pushed: boolean;
  /** The branch moved on. Refetch and reconcile — never retry the same push. */
  rejected: boolean;
  commit: string;
}

const KNOWN_CODES = new Set<string>(STUDIO_ERROR_CODES);

/**
 * Turns a rejection from the Rust side into a StudioError.
 *
 * The Git layer serializes `{ code, message, detail }`; anything else — a
 * command that does not exist, a panic — falls through to the generic wrapper
 * rather than being mistaken for a classified failure.
 */
function decodeFailure(e: unknown, fallback: string): StudioError {
  const text = e instanceof Error ? e.message : String(e ?? "");
  try {
    const parsed = JSON.parse(text);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      const code: StudioErrorCode = KNOWN_CODES.has(parsed.code)
        ? (parsed.code as StudioErrorCode)
        : "unknown";
      return new StudioError(code, parsed.message, {
        detail: typeof parsed.detail === "string" ? parsed.detail : "",
      });
    }
  } catch {
    /* not one of ours */
  }
  return asStudioError(e, "unknown", fallback);
}

async function call<T>(cmd: string, args: Record<string, unknown>, fallback: string): Promise<T> {
  try {
    return await ipc<T>(cmd, args);
  } catch (e) {
    throw decodeFailure(e, fallback);
  }
}

/** What the linked Git implementation can do. Asserted, never assumed. */
export async function capabilities(): Promise<GitCapabilities> {
  return call<GitCapabilities>("git_capabilities", {}, "Could not start the Git engine.");
}

export async function state(dir: string, branch: string): Promise<RepoState> {
  return call<RepoState>(
    "git_state",
    { dir, branch },
    "Could not read the project's history.",
  );
}

/** Every file in a commit, as text, keyed by repository path. */
export async function readTree(
  dir: string,
  commit: string,
  prefix = "",
): Promise<Record<string, string>> {
  return call<Record<string, string>>(
    "git_read_tree",
    { dir, commit, prefix },
    "Could not read that version of the project.",
  );
}

export async function setRemote(dir: string, url: string): Promise<void> {
  await call<void>("git_set_remote", { dir, url }, "Could not set the project repository.");
}

/**
 * Fetches the branch. Updates the remote-tracking ref only, never the files.
 *
 * Takes the GitHub *account id*, not a credential: the token is looked up in
 * Rust, so it never exists in the webview at all.
 */
export async function fetch(
  dir: string,
  branch: string,
  accountId: string,
): Promise<string> {
  return call<string>(
    "git_fetch",
    { dir, branch, accountId },
    "Could not check for other administrators' changes.",
  );
}

export async function commit(
  dir: string,
  branch: string,
  message: string,
  paths: string[] = [],
): Promise<string> {
  return call<string>(
    "git_commit",
    { request: { dir, branch, message, paths } },
    "Could not record your changes.",
  );
}

/** Pushes without force. A rejection is an outcome, not an error. */
export async function push(
  dir: string,
  branch: string,
  accountId: string,
): Promise<PushOutcome> {
  return call<PushOutcome>(
    "git_push",
    { dir, branch, accountId },
    "Could not send your changes to GitHub.",
  );
}

export interface FastForwardOutcome {
  advanced: boolean;
  /** Why it was refused, when it was. Empty on success. */
  refused: string;
  commit: string;
}

/**
 * Takes the other administrators' work when this computer has none of its own.
 *
 * Refuses on a divergence or an unsaved edit rather than resolving either — the
 * first belongs to the semantic merge, and the second must never be checked
 * out over.
 */
export async function fastForward(
  dir: string,
  branch: string,
): Promise<FastForwardOutcome> {
  return call<FastForwardOutcome>(
    "git_fast_forward",
    { dir, branch },
    "Could not bring in the team's changes.",
  );
}

export async function markRecovery(
  dir: string,
  operationId: string,
  commitSha: string,
): Promise<void> {
  await call<void>(
    "git_mark_recovery",
    { dir, operationId, commit: commitSha },
    "Could not record a recovery point.",
  );
}

export async function clearRecovery(dir: string, operationId: string): Promise<void> {
  await call<void>(
    "git_clear_recovery",
    { dir, operationId },
    "Could not clear a recovery point.",
  );
}

/** Exposed for the tests that check failure decoding directly. */
export const __testing = { decodeFailure };
