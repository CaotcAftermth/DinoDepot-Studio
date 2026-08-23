import type { LocalProjectState, RepoBinding } from "../model/localState";
import { bindingSlug, topologyUsesSeparateDelivery } from "../model/localState";
import { githubCall } from "./githubAccount";

export interface ProjectAccessTarget {
  role: "source" | "delivery";
  label: string;
  binding: RepoBinding;
}

export interface RepositoryCollaborator {
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  roleName: string;
}

export interface RepositoryInvitation {
  id: string;
  login: string;
  avatarUrl: string;
  htmlUrl: string;
  permission: string;
  createdAt: string;
}

export interface RepositoryAccess {
  currentPermission: string;
  canAdmin: boolean;
  managementAvailable: boolean;
  managementProblem: string;
  collaborators: RepositoryCollaborator[];
  invitations: RepositoryInvitation[];
}

export interface InviteResult {
  status: "invited" | "alreadyCollaborator";
  login: string;
  permission: string;
}

/** Repositories another administrator needs for this project's topology. */
export function projectAccessTargets(
  local: LocalProjectState | null,
): ProjectAccessTarget[] {
  if (!local?.source?.githubId) return [];
  const targets: ProjectAccessTarget[] = [
    {
      role: "source",
      label:
        local.topology === "single-public"
          ? "Public project repository"
          : "Private project repository",
      binding: local.source,
    },
  ];
  if (
    topologyUsesSeparateDelivery(local.topology) &&
    local.delivery?.githubId &&
    local.delivery.githubId !== local.source.githubId
  ) {
    targets.push({
      role: "delivery",
      label: "Public site repository",
      binding: local.delivery,
    });
  }
  return targets;
}

/** Accepts a pasted @handle while keeping path construction safe. */
export function normalizeGitHubLogin(value: string): string {
  return value.trim().replace(/^@/, "");
}

export function validGitHubLogin(value: string): boolean {
  const login = normalizeGitHubLogin(value);
  return (
    login.length >= 1 &&
    login.length <= 39 &&
    /^[A-Za-z0-9-]+$/.test(login) &&
    !login.startsWith("-") &&
    !login.endsWith("-")
  );
}

export async function repositoryAccess(
  accountId: string,
  binding: RepoBinding,
): Promise<RepositoryAccess> {
  return githubCall<RepositoryAccess>(
    "github_repository_access",
    { accountId, owner: binding.owner, repo: binding.name },
    `Could not load access for ${bindingSlug(binding)}.`,
  );
}

export async function inviteRepositoryCollaborator(
  accountId: string,
  binding: RepoBinding,
  username: string,
): Promise<InviteResult> {
  const login = normalizeGitHubLogin(username);
  if (!validGitHubLogin(login)) {
    throw new Error("Enter a valid GitHub username.");
  }
  return githubCall<InviteResult>(
    "github_invite_collaborator",
    { accountId, owner: binding.owner, repo: binding.name, username: login },
    `Could not invite ${login} to ${bindingSlug(binding)}.`,
  );
}
