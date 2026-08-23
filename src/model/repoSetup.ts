import {
  applyRepoRename,
  bindingSlug,
  remoteUrlFor,
  siteBinding,
  sourceShouldBePrivate,
  topologyUsesSeparateDelivery,
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
 * 2. **Repository creation stays on GitHub.** Project Access can read members
 *    and invite collaborators when the signed-in repository admin deliberately
 *    grants optional Administration permission; GitHub remains the authority.
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
  hasPages: boolean;
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

  if (
    role === "source" &&
    identity.isPrivate !== sourceShouldBePrivate(topology)
  ) {
    issues.push({
      level: "error",
      message: `${slug} is ${identity.isPrivate ? "private" : "public"}.`,
      fix:
        topology === "single-public"
          ? "Public-only uses one public repository for the project and site. Make it public on GitHub, or choose a private arrangement."
          : "The project repository can hold private project data. Make it private on GitHub before connecting it.",
    });
  }

  if (role === "delivery" && topologyUsesSeparateDelivery(topology) && identity.isPrivate) {
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
    hasPages: identity.hasPages,
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
  const updated: RepoBinding = {
    ...moved,
    isPrivate: identity.isPrivate,
    hasPages: identity.hasPages,
  };

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
  if (!topologyUsesSeparateDelivery(topology)) return null;
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
  | "topology"
  | "account"
  | "source"
  | "delivery"
  | "first-sync"
  | "first-publish"
  | "pages";

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
 * Presented as a checklist because each setup fact remains useful after the
 * first visit. A wizard would hide where you are the moment you close it.
 */
export function setupSteps(state: LocalProjectState | null): SetupStep[] {
  const topology = state?.topology ?? "source-and-delivery";
  const topologyConfirmed = Boolean(state?.topologyConfirmed || state?.source?.githubId);
  const hasAccount = Boolean(state?.githubAccountId);
  const hasSource = Boolean(state?.source?.githubId);
  const separate = topologyUsesSeparateDelivery(topology);
  const hasDelivery = !separate || Boolean(state?.delivery?.githubId);
  const synced = Boolean(state?.lastSyncedCommit);
  const published = Boolean(state?.lastPublishedCommit);
  const pages = state ? Boolean(siteBinding(state)?.hasPages) : false;
  const topologyDetail =
    topology === "source-and-delivery"
      ? "Private project repository, separate public site"
      : topology === "single-private"
        ? "One private repository, paid GitHub Pages"
        : "One public repository for project and site";

  return [
    {
      id: "topology",
      title: "Choose the repository arrangement",
      done: topologyConfirmed,
      blocked: false,
      detail: topologyDetail,
    },
    {
      id: "account",
      title: "Create the repositories, then connect your GitHub account",
      done: hasAccount,
      blocked: !topologyConfirmed,
      detail: state?.githubLogin ? `Signed in as ${state.githubLogin}` : "",
    },
    {
      id: "source",
      title:
        topology === "single-public"
          ? "Choose the public project repository"
          : "Choose the private project repository",
      done: hasSource,
      blocked: !hasAccount,
      detail: state?.source ? bindingSlug(state.source) : "",
    },
    {
      id: "delivery",
      title: separate
        ? "Choose the public site repository"
        : "Use the project repository for the public site",
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
    {
      id: "first-publish",
      title: "Publish the public site once",
      done: published,
      blocked: !hasDelivery || !synced,
      detail: "Creates the docs folder GitHub Pages will serve",
    },
    {
      id: "pages",
      title: "Enable GitHub Pages from the main branch /docs folder",
      done: pages,
      blocked: !published,
      detail: pages ? "GitHub reports Pages is enabled" : "Use the repository's Pages settings",
    },
  ];
}

export interface PublicSourcePrivacyInput {
  topology: PublishTopology;
  playerDataEnabled: boolean;
  playerCount: number;
  cleanSlateCount: number;
  hasPlayerActivity: boolean;
  hasPlayerHistory: boolean;
  hasPendingPlayerChanges: boolean;
}

/** Public source is allowed only when no Player Data can enter its history. */
export function publicSourcePrivacyProblem(input: PublicSourcePrivacyInput): string {
  if (input.topology !== "single-public") return "";
  if (
    !input.playerDataEnabled &&
    input.playerCount === 0 &&
    input.cleanSlateCount === 0 &&
    !input.hasPlayerActivity &&
    !input.hasPlayerHistory &&
    !input.hasPendingPlayerChanges
  ) {
    return "";
  }
  return "Public-only cannot be used after this project has held Player Data. Choose a private project repository instead.";
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
export function newRepoUrl(
  name: string,
  role: RepoRole,
  topology: PublishTopology = "source-and-delivery",
): string {
  const privateRepo = role === "source" && sourceShouldBePrivate(topology);
  const params = new URLSearchParams({
    name,
    description:
      role === "source"
        ? `DinoDepot Studio project — ${privateRepo ? "private" : "public"}`
        : "DinoDepot Studio public cluster site",
    visibility: privateRepo ? "private" : "public",
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

/** Extra permission used only by the separate Project Access screen. */
export const OPTIONAL_TOKEN_ACCESS = [
  "Repository permissions → Administration: Read and write — only to view pending invitations and invite project administrators",
] as const;

/**
 * Permissions DinoDepot must never be granted.
 *
 * Listed so the setup screen can say so plainly. Workflows would let the app
 * edit CI and is unrelated to every Studio operation.
 */
export const UNNECESSARY_TOKEN_ACCESS = [
  "Workflows — DinoDepot never edits GitHub Actions",
] as const;

/** The collaborators page, retained as the authoritative management fallback. */
export function collaboratorsUrl(binding: RepoBinding): string {
  return `https://github.com/${bindingSlug(binding)}/settings/access`;
}

/** The Pages settings page, for turning the public site on. */
export function pagesSettingsUrl(binding: RepoBinding): string {
  return `https://github.com/${bindingSlug(binding)}/settings/pages`;
}

/** Canonical GitHub Pages URL, including the special user-site repository. */
export function pagesSiteUrl(binding: Pick<RepoBinding, "owner" | "name">): string {
  const owner = binding.owner.trim();
  const name = binding.name.trim();
  const userSite = name.toLowerCase() === `${owner.toLowerCase()}.github.io`;
  return userSite
    ? `https://${owner}.github.io/`
    : `https://${owner}.github.io/${name}/`;
}
