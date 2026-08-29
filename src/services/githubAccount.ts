import { ipc } from "./ipc";
import { asStudioError, StudioError, STUDIO_ERROR_CODES } from "../model/errors";
import type { StudioErrorCode } from "../model/errors";
import type { RepoIdentity } from "../model/repoSetup";

/**
 * The GitHub account, and looking repositories up.
 *
 * A credential crosses into the application exactly once - `connectAccount`,
 * with a token the administrator pasted - and never comes back out. Everything
 * afterwards names an *account id*; the token stays in Windows Credential
 * Manager and is read only inside Rust.
 */

export interface GithubAccount {
  accountId: string;
  login: string;
  avatarUrl: string;
}

export interface AccountStatus {
  connected: boolean;
  login: string;
  /** Set when a credential exists but no longer works. */
  problem: string;
}

const KNOWN_CODES = new Set<string>(STUDIO_ERROR_CODES);

/** Decodes the JSON failure the Rust side raises. Same shape as the Git layer. */
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
        retryAfterSeconds:
          typeof parsed.retryAfterSeconds === "number"
            ? parsed.retryAfterSeconds
            : undefined,
      });
    }
  } catch {
    /* not one of ours */
  }
  return asStudioError(e, "unknown", fallback);
}

export async function githubCall<T>(
  cmd: string,
  args: Record<string, unknown>,
  fallback: string,
): Promise<T> {
  try {
    return await ipc<T>(cmd, args);
  } catch (e) {
    throw decodeFailure(e, fallback);
  }
}

/**
 * Verifies a pasted token and remembers the account it belongs to.
 *
 * The one place a credential is accepted. It is checked against GitHub before
 * being stored, so a mistyped token fails here rather than at the first Sync,
 * and the account id comes from GitHub rather than from anything typed.
 */
export async function connectAccount(token: string): Promise<GithubAccount> {
  return githubCall<GithubAccount>(
    "github_connect_account",
    { token },
    "That sign-in could not be completed.",
  );
}

/** Whether a stored credential still works. Never reveals it. */
export async function accountStatus(accountId: string): Promise<AccountStatus> {
  if (!accountId) return { connected: false, login: "", problem: "" };
  return githubCall<AccountStatus>(
    "github_account_status",
    { accountId },
    "Could not check your GitHub sign-in.",
  );
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await githubCall<void>(
    "github_disconnect_account",
    { accountId },
    "Could not remove your GitHub sign-in.",
  );
}

/** Looks a repository up by owner and name - the first binding. */
export async function repoBySlug(
  accountId: string,
  owner: string,
  name: string,
): Promise<RepoIdentity> {
  return githubCall<RepoIdentity>(
    "github_repo_by_slug",
    { accountId, owner, name },
    "Could not find that repository.",
  );
}

/**
 * Looks a repository up by its immutable id.
 *
 * How a rename or transfer is noticed: the id still resolves, and the owner and
 * name that come back are the current ones. Only a failure *here* means a
 * repository is genuinely unreachable.
 */
export async function repoById(
  accountId: string,
  githubId: string,
): Promise<RepoIdentity> {
  return githubCall<RepoIdentity>(
    "github_repo_by_id",
    { accountId, githubId },
    "Could not reach the project repository.",
  );
}

export async function branchExists(
  accountId: string,
  owner: string,
  name: string,
  branch: string,
): Promise<boolean> {
  return githubCall<boolean>(
    "github_branch_exists",
    { accountId, owner, name, branch },
    "Could not check the branch.",
  );
}

export const __testing = { decodeFailure };
