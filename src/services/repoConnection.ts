import * as github from "./githubAccount";
import * as git from "./gitRepo";
import { asStudioError, isStudioError } from "../model/errors";
import {
  bindingSlug,
  topologyUsesSeparateDelivery,
  type LocalProjectState,
  type RepoBinding,
} from "../model/localState";
import {
  availabilityFor,
  bindingFor,
  blockingIssues,
  checkPairing,
  checkSuitability,
  identityMatches,
  reconcileBinding,
  type AvailabilityState,
  type BindingChange,
  type PairingProblem,
  type RepoIdentity,
  type RepoRole,
  type SetupIssue,
} from "../model/repoSetup";

/**
 * Binding a project to a repository, and checking that binding is still true.
 *
 * Two operations, and the difference between them matters. *Connecting* is the
 * administrator choosing a repository by name, once. *Verifying* is everything
 * afterwards, and goes by id — so a rename is followed rather than mistaken for
 * the repository having vanished.
 */

export interface ConnectResult {
  binding: RepoBinding;
  identity: RepoIdentity;
  /** Blocking issues mean the binding was not applied. */
  issues: SetupIssue[];
  connected: boolean;
}

/**
 * Connects a repository the administrator named.
 *
 * Refuses on any blocking issue rather than binding and complaining later: a
 * public project repository or one the token cannot write to is not something
 * to discover at the first Sync.
 */
export async function connectRepository(
  state: LocalProjectState,
  role: RepoRole,
  owner: string,
  name: string,
  branch?: string,
): Promise<ConnectResult> {
  const identity = await github.repoBySlug(
    state.githubAccountId,
    owner.trim(),
    name.trim(),
  );
  const binding = bindingFor(identity, branch);
  const issues = checkSuitability(identity, role, state.topology);
  const pairing = checkPairing({
    ...state,
    [role]: binding,
  });
  if (pairing) {
    issues.push({ level: "error", message: pairing.message, fix: pairing.fix });
  }

  return {
    binding,
    identity,
    issues,
    connected: blockingIssues(issues).length === 0,
  };
}

export interface VerifyResult {
  /** The binding as it should now be stored. */
  binding: RepoBinding;
  change: BindingChange;
  /** One line worth telling the administrator, when something moved. */
  note: string;
  /** Null while everything is reachable. */
  availability: AvailabilityState | null;
  /** Issues the repository has developed since it was connected. */
  issues: SetupIssue[];
}

/**
 * Re-checks a bound repository, by id.
 *
 * Everything this can discover — a rename, a transfer, a permission that was
 * taken away, a repository that was deleted — is handled by *reporting* it. The
 * binding is updated where the id still matches and left alone where it does
 * not; nothing here clears a binding, creates a replacement, or touches the
 * project on disk.
 */
export async function verifyBinding(
  state: LocalProjectState,
  role: RepoRole,
): Promise<VerifyResult> {
  const binding = role === "source" ? state.source : state.delivery;
  if (!binding) {
    return {
      binding: blank(),
      change: "none",
      note: "",
      availability: null,
      issues: [],
    };
  }

  const slug = bindingSlug(binding);
  try {
    // By id where we have one. A binding that has never been reached — a
    // migrated schema-1 project — has only a name to go on, and this is the
    // one moment it is allowed to be used.
    const identity = binding.githubId
      ? await github.repoById(state.githubAccountId, binding.githubId)
      : await github.repoBySlug(state.githubAccountId, binding.owner, binding.name);

    const update = reconcileBinding(binding, identity);
    return {
      binding: update.binding,
      change: update.change,
      note: update.note,
      availability: null,
      issues: checkSuitability(identity, role, state.topology),
    };
  } catch (e) {
    const error = asStudioError(e, "unknown", `Could not check ${slug}.`);
    return {
      binding,
      change: "none",
      note: "",
      availability: availabilityFor(error.code, role, slug),
      issues: [],
    };
  }
}

/**
 * Confirms the repository answering is the one this project is bound to.
 *
 * The guard against a project file pointing credentials at something unrelated:
 * an opened project is untrusted input, and a binding is only trusted when the
 * id it names is the id that replies.
 */
export async function assertBoundIdentity(
  state: LocalProjectState,
  role: RepoRole,
): Promise<void> {
  const binding = role === "source" ? state.source : state.delivery;
  if (!binding?.githubId) return;
  const identity = await github.repoById(state.githubAccountId, binding.githubId);
  if (!identityMatches(binding, identity)) {
    throw asStudioError(
      new Error(`expected ${binding.githubId}, got ${identity.githubId}`),
      "repo.identityMismatch",
      "That repository is not the one this project is connected to.",
    );
  }
}

/**
 * Points the local repository at its remote.
 *
 * Called after a binding is established or followed through a rename — the
 * stored remote URL is rebuilt from the current owner and name, and the old one
 * only worked while GitHub's redirect lasted.
 */
export async function applyRemote(
  dir: string,
  binding: RepoBinding,
  resetHistory = false,
): Promise<void> {
  await git.setRemote(dir, binding.remoteUrl, resetHistory);
}

/** An empty binding, for the "nothing connected yet" case. */
function blank(): RepoBinding {
  return {
    githubId: "",
    owner: "",
    name: "",
    remoteUrl: "",
    branch: "main",
    isPrivate: true,
    hasPages: false,
  };
}

/**
 * Everything a project's connection status amounts to, in one call.
 *
 * Used by the setup screen and before Publish. Deliberately checks both
 * repositories even when the first has a problem: "your project repository is
 * gone *and* so is the site" is one conversation, not two.
 */
export interface ConnectionReport {
  source: VerifyResult | null;
  delivery: VerifyResult | null;
  pairing: PairingProblem | null;
  /** Operations that must be switched off right now. */
  disabled: ("sync" | "publish")[];
  /** Changes worth mentioning — renames, transfers. */
  notes: string[];
}

export async function checkConnection(
  state: LocalProjectState,
): Promise<ConnectionReport> {
  const source = state.source ? await verifyBinding(state, "source") : null;
  const delivery =
    state.delivery && topologyUsesSeparateDelivery(state.topology)
      ? await verifyBinding(state, "delivery")
      : null;

  const disabled = new Set<"sync" | "publish">();
  const pairing = checkPairing(state);
  for (const result of [source, delivery]) {
    for (const op of result?.availability?.disabled ?? []) disabled.add(op);
  }
  // A blocking suitability problem is as disqualifying as being unreachable —
  // a repository the token cannot write to cannot be synced to either.
  if (source && blockingIssues(source.issues).length > 0) {
    disabled.add("sync");
    disabled.add("publish");
  }
  if (delivery && blockingIssues(delivery.issues).length > 0) {
    disabled.add("publish");
  }
  if (pairing) disabled.add("publish");

  return {
    source,
    delivery,
    pairing,
    disabled: [...disabled],
    notes: [source?.note, delivery?.note].filter((n): n is string => Boolean(n)),
  };
}

export interface ConnectionRefresh {
  report: ConnectionReport;
  patch: Partial<LocalProjectState>;
}

/** Best user-facing reason an operation was disabled by a connection check. */
export function connectionProblem(
  report: ConnectionReport,
  operation: "sync" | "publish",
): string {
  if (!report.disabled.includes(operation)) return "";
  for (const result of [report.source, report.delivery]) {
    if (result?.availability?.disabled.includes(operation)) {
      return result.availability.message;
    }
    const issue = result ? blockingIssues(result.issues)[0] : undefined;
    if (issue) return [issue.message, issue.fix].filter(Boolean).join(" ");
  }
  if (report.pairing) {
    return [report.pairing.message, report.pairing.fix].filter(Boolean).join(" ");
  }
  return operation === "sync"
    ? "The project repository is not ready for Sync."
    : "The connected repositories are not ready for Publish.";
}

/**
 * Rechecks every binding and returns machine-local metadata that must be saved.
 * A source rename also updates the working copy's remote before callers can
 * start Sync with a stale URL.
 */
export async function refreshConnection(
  state: LocalProjectState,
  sourceDir: string,
): Promise<ConnectionRefresh> {
  const report = await checkConnection(state);
  const patch: Partial<LocalProjectState> = {};
  if (report.source && bindingChanged(state.source, report.source.binding)) {
    if (report.source.change !== "none") {
      await applyRemote(sourceDir, report.source.binding);
    }
    patch.source = report.source.binding;
  }
  if (report.delivery && bindingChanged(state.delivery, report.delivery.binding)) {
    patch.delivery = report.delivery.binding;
  }
  return { report, patch };
}

function bindingChanged(current: RepoBinding | null, next: RepoBinding): boolean {
  return (
    !current ||
    current.githubId !== next.githubId ||
    current.owner !== next.owner ||
    current.name !== next.name ||
    current.remoteUrl !== next.remoteUrl ||
    current.branch !== next.branch ||
    current.isPrivate !== next.isPrivate ||
    current.hasPages !== next.hasPages
  );
}

export { isStudioError };
