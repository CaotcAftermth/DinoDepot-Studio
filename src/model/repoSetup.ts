import {
  applyRepoRename,
  bindingSlug,
  remoteUrlFor,
  type LocalProjectState,
  type PublishTopology,
  type RepoBinding,
} from "./localState";
import { STUDIO_REPO } from "./studio";

/**
 * Connecting a project to its repositories, and keeping that connection honest
 * as the repositories change underneath it.
 *
 * Two rules run through everything here:
 *
 * 1. **Identity is the numeric id.** Owner and name are display, and both
 *    change. A binding that a rename can orphan is not a binding.
 * 2. **Nothing is created on the administrator's behalf.** Repository creation
 *    and collaborator management happen in the browser, on GitHub, where the
 *    administrator can see exactly what they are agreeing to — which is also
 *    why DinoDepot never asks for the Administration permission.
 */

export type RepoRole = "source" | "delivery";

export const ROLE_LABELS: Record<RepoRole, string> = {
  source: "project repository",
  delivery: "public site repository",
};

// ---------------------------------------------------------------------------
// What GitHub says a repository is
// ---------------------------------------------------------------------------

export interface RepoIdentity {
  githubId: string;
  owner: string;
  name: string;
  isPrivate: boolean;
  defaultBranch: string;
  canPush: boolean;
  isEmpty: boolean;
  htmlUrl: string;
}

export interface SetupIssue {
  /** Blocking issues stop the connection; warnings are acknowledged and pass. */
  level: "error" | "warning";
  message: string;
  /** What the administrator should do about it, if anything. */
  fix: string;
}

/**
 * Whether a repository can play the role it is being connected as.
 *
 * The privacy checks are the ones that matter. A project repository holds the
 * roster and the profile backups; a public one would put both on the open web
 * the moment anything synchronized. A delivery repository has the opposite
 * requirement — a private one cannot serve Pages without a paid plan, so
 * connecting one on the free topology produces a site nobody can reach.
 */
export function checkSuitability(
  identity: RepoIdentity,
  role: RepoRole,
  topology: PublishTopology,
): SetupIssue[] {
  const issues: SetupIssue[] = [];

  const slug = `${identity.owner}/${identity.name}`;

  if (!identity.canPush) {
    issues.push({
      level: "error",
      message: `Your GitHub access cannot write to ${slug}.`,
      fix: "Give the token Contents: Read and write for this repository, and make sure the repository is in the token's selected list.",
    });
  }

  if (role === "source" && !identity.isPrivate) {
    issues.push({
      level: "error",
      message: `${slug} is public.`,
      fix: "The project repository holds your player roster and profile backups. Make it private on GitHub before connecting it.",
    });
  }

  if (role === "delivery" && topology === "source-and-delivery" && identity.isPrivate) {
    issues.push({
      level: "error",
      message: `${slug} is private.`,
      fix: "The public site repository has to be public for GitHub Pages to serve it on a free plan. Make it public, or switch to the paid single-repository setup.",
    });
  }

  // Connecting the app's own repository would be a very bad afternoon.
  if (
    identity.owner.toLowerCase() === STUDIO_REPO.owner.toLowerCase() &&
    identity.name.toLowerCase() === STUDIO_REPO.repo.toLowerCase()
  ) {
    issues.push({
      level: "error",
      message: "That is the DinoDepot Studio repository itself.",
      fix: "Create a repository of your own for this project.",
    });
  }

  if (role === "source" && !identity.isEmpty) {
    issues.push({
      level: "warning",
      message: `${slug} already has files in it.`,
      fix: "That is fine if it is this project's repository. If it is something else, connecting will mix the two together.",
    });
  }

  return issues;
}

export function blockingIssues(issues: SetupIssue[]): SetupIssue[] {
  return issues.filter((issue) => issue.level === "error");
}

/** A binding built from what GitHub just told us. */
export function bindingFor(identity: RepoIdentity, branch?: string): RepoBinding {
  return {
    githubId: identity.githubId,
    owner: identity.owner,
    name: identity.name,
    remoteUrl: remoteUrlFor(identity.owner, identity.name),
    branch: branch?.trim() || identity.defaultBranch || "main",
    isPrivate: identity.isPrivate,
  };
}

// ---------------------------------------------------------------------------
// Keeping a binding current
// ---------------------------------------------------------------------------

export type BindingChange = "none" | "named" | "renamed" | "transferred";

export interface BindingUpdate {
  binding: RepoBinding;
  change: BindingChange;
  /** One line for the activity feed, empty when nothing moved. */
  note: string;
}

/**
 * Brings a stored binding up to date with what GitHub reports.
 *
 * A changed owner or name is *news about the same repository*, because the id
 * matched — so it is applied silently and mentioned, never treated as the
 * repository having disappeared. `named` covers the schema-1 case, where the
 * binding was carried across by name only and is learning its id for the first
 * time.
 */
export function reconcileBinding(
  binding: RepoBinding,
  identity: RepoIdentity,
): BindingUpdate {
  if (!binding.githubId) {
    return {
      binding: { ...bindingFor(identity, binding.branch), branch: binding.branch },
      change: "named",
      note: "",
    };
  }

  const moved = applyRepoRename(binding, identity.owner, identity.name);
  const updated: RepoBinding = { ...moved, isPrivate: identity.isPrivate };

  if (binding.owner !== identity.owner && binding.name !== identity.name) {
    return {
      binding: updated,
      change: "transferred",
      note: `The project repository moved to ${identity.owner}/${identity.name}.`,
    };
  }
  if (binding.owner !== identity.owner) {
    return {
      binding: updated,
      change: "transferred",
      note: `The project repository was transferred to ${identity.owner}.`,
    };
  }
  if (binding.name !== identity.name) {
    return {
      binding: updated,
      change: "renamed",
      note: `The project repository was renamed to ${identity.name}.`,
    };
  }
  return { binding: updated, change: "none", note: "" };
}

/**
 * Whether the identity that answered is the one this project is bound to.
 *
 * The guard against a project file redirecting credentials somewhere unrelated:
 * a binding is only ever trusted when the id it names is the id that replied.
 */
export function identityMatches(binding: RepoBinding, identity: RepoIdentity): boolean {
  return Boolean(binding.githubId) && binding.githubId === identity.githubId;
}

// ---------------------------------------------------------------------------
// Pairing
// ---------------------------------------------------------------------------

export interface PairingProblem {
  message: string;
  fix: string;
}

/**
 * Whether the two repositories a project uses are a sane pair.
 *
 * Publishing generated output into the source repository would leave the
 * private roster one directory away from a public Pages site, so the two are
 * required to differ by id — not by name, which can be made to match by
 * renaming one of them.
 */
export function checkPairing(state: LocalProjectState): PairingProblem | null {
  const { source, delivery, topology } = state;
  if (topology === "single-private") return null;
  if (!source || !delivery) return null;

  if (source.githubId && delivery.githubId && source.githubId === delivery.githubId) {
    return {
      message: "The project and its public site are set to the same repository.",
      fix: "Choose a separate public repository for the site, or switch to the paid single-repository setup.",
    };
  }
  if (delivery.isPrivate) {
    return {
      message: `${bindingSlug(delivery)} is private, so GitHub Pages cannot serve it on a free plan.`,
      fix: "Make it public on GitHub, or switch to the paid single-repository setup.",
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// When a repository goes away
// ---------------------------------------------------------------------------

export type Availability = "ok" | "unreachable" | "no-access" | "signed-out" | "offline";

export interface AvailabilityState {
  availability: Availability;
  /** What the administrator is told. */
  message: string;
  /** Operations that must be switched off while this lasts. */
  disabled: ("sync" | "publish")[];
  /** Whether local work is still safe. Always true — this is the promise. */
  workIsSafe: true;
  /** Whether the administrator should be offered a reconnect flow. */
  offerReconnect: boolean;
}

/**
 * What to do when a bound repository cannot be reached.
 *
 * Never: silently create a replacement, clear the binding, or touch local data.
 * A repository that is missing today may be a permission that gets restored
 * tomorrow, and the project on this disk is the administrator's work either way.
 */
export function availabilityFor(
  errorCode: string,
  role: RepoRole,
  slug: string,
): AvailabilityState {
  const disabled: ("sync" | "publish")[] =
    role === "source" ? ["sync", "publish"] : ["publish"];

  switch (errorCode) {
    case "network.offline":
    case "network.timeout":
      return {
        availability: "offline",
        message: "DinoDepot cannot reach GitHub right now. Your work is saved on this computer.",
        disabled,
        workIsSafe: true,
        offerReconnect: false,
      };
    case "auth.missing":
    case "auth.expired":
      return {
        availability: "signed-out",
        message: "Your GitHub access has expired. Sign in again to continue.",
        disabled,
        workIsSafe: true,
        offerReconnect: false,
      };
    case "auth.forbidden":
      return {
        availability: "no-access",
        message: `Your GitHub access no longer covers ${slug}.`,
        disabled,
        workIsSafe: true,
        offerReconnect: true,
      };
    case "repo.unavailable":
      return {
        availability: "unreachable",
        message: `${slug} could not be found. It may have been deleted, or your access to it removed.`,
        disabled,
        workIsSafe: true,
        offerReconnect: true,
      };
    default:
      return {
        availability: "unreachable",
        message: `DinoDepot could not check ${slug}.`,
        disabled,
        workIsSafe: true,
        offerReconnect: false,
      };
  }
}

// ---------------------------------------------------------------------------
// The setup checklist
// ---------------------------------------------------------------------------

export type SetupStepId =
  | "account"
  | "source"
  | "topology"
  | "delivery"
  | "first-sync";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  /** Done steps are ticked; the first undone one is the current step. */
  done: boolean;
  /** Steps that cannot be started yet, because an earlier one is undone. */
  blocked: boolean;
  detail: string;
}

/**
 * Where a project has got to in setting up.
 *
 * Presented as a checklist because that is what it is — five things, in order,
 * each of which the administrator either has or has not done. The alternative,
 * a wizard, hides where you are the moment you close it.
 */
export function setupSteps(state: LocalProjectState | null): SetupStep[] {
  const hasAccount = Boolean(state?.githubAccountId);
  const hasSource = Boolean(state?.source?.githubId);
  const single = state?.topology === "single-private";
  const hasDelivery = single || Boolean(state?.delivery?.githubId);
  const synced = Boolean(state?.lastSyncedCommit);

  return [
    {
      id: "account",
      title: "Connect your GitHub account",
      done: hasAccount,
      blocked: false,
      detail: state?.githubLogin ? `Signed in as ${state.githubLogin}` : "",
    },
    {
      id: "source",
      title: "Choose the private project repository",
      done: hasSource,
      blocked: !hasAccount,
      detail: state?.source ? bindingSlug(state.source) : "",
    },
    {
      id: "topology",
      title: "Choose how the public site is published",
      // Every project has a topology from the moment it is created, so this is
      // done as soon as there is a repository for it to apply to.
      done: hasSource,
      blocked: !hasSource,
      detail: single
        ? "One private repository, GitHub Pages (paid plan)"
        : "Private project repository, separate public site",
    },
    {
      id: "delivery",
      title: single ? "Install the publishing workflow" : "Choose the public site repository",
      done: hasDelivery,
      blocked: !hasSource,
      detail: state?.delivery ? bindingSlug(state.delivery) : "",
    },
    {
      id: "first-sync",
      title: "Share the project for the first time",
      done: synced,
      blocked: !hasSource,
      detail: "",
    },
  ];
}

/** The step the administrator should be looking at, or null when finished. */
export function currentStep(steps: SetupStep[]): SetupStep | null {
  return steps.find((step) => !step.done) ?? null;
}

// ---------------------------------------------------------------------------
// Browser-guided setup
// ---------------------------------------------------------------------------

/**
 * The GitHub page for creating a repository, pre-filled.
 *
 * Opened in the browser rather than created through the API, so the
 * administrator sees and agrees to what is being made — and so DinoDepot never
 * needs the Administration permission that creating one would require.
 */
export function newRepoUrl(name: string, role: RepoRole): string {
  const params = new URLSearchParams({
    name,
    description:
      role === "source"
        ? "DinoDepot Studio project — private"
        : "DinoDepot Studio public cluster site",
    visibility: role === "source" ? "private" : "public",
  });
  return `https://github.com/new?${params.toString()}`;
}

/**
 * The token page, with exactly the access DinoDepot needs preselected where
 * GitHub allows it.
 *
 * Fine-grained rather than classic: it can be limited to the repositories this
 * project actually uses, which a classic token cannot.
 */
export function newTokenUrl(): string {
  return "https://github.com/settings/personal-access-tokens/new";
}

/** What the administrator has to grant, in the words GitHub uses. */
export const REQUIRED_TOKEN_ACCESS = [
  "Repository access: Only select repositories — this project's repositories",
  "Repository permissions → Contents: Read and write",
  "Repository permissions → Metadata: Read-only (GitHub adds this for you)",
] as const;

/**
 * Permissions DinoDepot must never be granted.
 *
 * Listed so the setup screen can say so plainly. Administration would let the
 * app create and delete repositories; Workflows would let it edit CI. Neither
 * is needed, and asking for either would be asking for trust the app does not
 * require.
 */
export const UNNECESSARY_TOKEN_ACCESS = [
  "Administration — DinoDepot never creates or deletes repositories",
  "Workflows — DinoDepot never edits GitHub Actions",
] as const;

/** The collaborators page, for adding the other administrators by hand. */
export function collaboratorsUrl(binding: RepoBinding): string {
  return `https://github.com/${bindingSlug(binding)}/settings/access`;
}

/** The Pages settings page, for turning the public site on. */
export function pagesSettingsUrl(binding: RepoBinding): string {
  return `https://github.com/${bindingSlug(binding)}/settings/pages`;
}
