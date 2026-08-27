import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Badge, Button, Card, Field, Input } from "../../components/ui";
import { toast } from "../../components/toast";
import { asStudioError } from "../../model/errors";
import { bindingSlug } from "../../model/localState";
import { collaboratorsUrl } from "../../model/repoSetup";
import { feedbackTarget } from "../../model/feedback/targets";
import { isExampleProject } from "../../model/exampleProject";
import { openExternal } from "../../services/openExternal";
import {
  inviteRepositoryCollaborator,
  normalizeGitHubLogin,
  projectAccessTargets,
  repositoryAccess,
  validGitHubLogin,
  type ProjectAccessTarget,
  type RepositoryAccess,
} from "../../services/projectAccess";
import { useProjectStore } from "../../stores/projectStore";

interface AccessState {
  access?: RepositoryAccess;
  error?: string;
}

function roleLabel(role: string): string {
  const known: Record<string, string> = {
    admin: "Admin",
    maintain: "Maintain",
    write: "Write",
    push: "Write",
    triage: "Triage",
    read: "Read",
    pull: "Read",
    none: "No access",
  };
  return known[role.toLowerCase()] ?? role;
}

/** GitHub-backed project membership. No access list is copied into project files. */
export function ProjectAccess() {
  const local = useProjectStore((state) => state.local);
  const settings = useProjectStore((state) => state.settings);
  const example = isExampleProject(settings);
  const targets = useMemo(() => projectAccessTargets(local), [local]);
  const [states, setStates] = useState<Record<string, AccessState>>({});
  const [loading, setLoading] = useState(false);
  const [username, setUsername] = useState("");
  const [inviting, setInviting] = useState(false);
  const request = useRef(0);

  const refresh = useCallback(async () => {
    const accountId = local?.githubAccountId ?? "";
    const version = ++request.current;
    if (example || !accountId || targets.length === 0) {
      setStates({});
      return;
    }
    setLoading(true);
    const next: Record<string, AccessState> = {};
    await Promise.all(
      targets.map(async (target) => {
        try {
          next[target.binding.githubId] = {
            access: await repositoryAccess(accountId, target.binding),
          };
        } catch (error) {
          next[target.binding.githubId] = {
            error: asStudioError(
              error,
              "unknown",
              `Could not load access for ${bindingSlug(target.binding)}.`,
            ).message,
          };
        }
      }),
    );
    if (request.current === version) {
      setStates(next);
      setLoading(false);
    }
  }, [example, local?.githubAccountId, targets]);

  useEffect(() => {
    void refresh();
    return () => {
      request.current += 1;
    };
  }, [refresh]);

  const manageable =
    targets.length > 0 &&
    targets.every((target) => {
      const access = states[target.binding.githubId]?.access;
      return access?.canAdmin && access.managementAvailable;
    });
  const login = normalizeGitHubLogin(username);
  const usernameValid = validGitHubLogin(login);
  const invitingSelf =
    Boolean(login) && login.toLowerCase() === local?.githubLogin.toLowerCase();

  async function invite() {
    if (!local?.githubAccountId || !manageable || !usernameValid || invitingSelf) return;
    setInviting(true);
    const results = await Promise.allSettled(
      targets.map((target) =>
        inviteRepositoryCollaborator(
          local.githubAccountId,
          target.binding,
          login,
        ),
      ),
    );
    const failed = results
      .map((result, index) => ({ result, target: targets[index] }))
      .filter(
        (entry): entry is {
          result: PromiseRejectedResult;
          target: ProjectAccessTarget;
        } => entry.result.status === "rejected",
      );
    if (failed.length === 0) {
      const already = results.every(
        (result) =>
          result.status === "fulfilled" &&
          result.value.status === "alreadyCollaborator",
      );
      if (already) toast.info(`${login} already has access to this project`);
      else toast.success(`Invitation sent to ${login}`);
      setUsername("");
    } else {
      const succeeded = results.length - failed.length;
      const detail = failed
        .map(({ result, target }) => {
          const error = asStudioError(
            result.reason,
            "unknown",
            "GitHub refused the invitation.",
          );
          return `${target.label}: ${error.message}`;
        })
        .join(" ");
      toast.error(
        succeeded > 0
          ? `Access was added to ${succeeded} of ${results.length} repositories. ${detail}`
          : detail,
      );
    }
    await refresh();
    setInviting(false);
  }

  if (example) return <MockProjectAccess />;

  if (!local?.githubAccountId) {
    return (
      <Card title="Project access" feedback={feedbackTarget("project-access")}>
        <p className="text-sm text-amber-400">
          Connect your account under <Link className="underline" to="/settings/github">GitHub</Link>{" "}
          before viewing project access.
        </p>
      </Card>
    );
  }

  if (targets.length === 0) {
    return (
      <Card title="Project access" feedback={feedbackTarget("project-access")}>
        <p className="text-sm text-amber-400">
          Connect project repositories under <Link className="underline" to="/settings/github">GitHub</Link>{" "}
          before adding administrators.
        </p>
      </Card>
    );
  }

  return (
    <>
      <p className="col-span-full -mb-2 text-xs text-ink-400">
        GitHub controls access. Studio reads current roles and sends invitations;
        no administrator list is stored in project files.
      </p>

      <Card
        title="Project administrators"
        feedback={feedbackTarget("project-access")}
        actions={
          <Button onClick={() => void refresh()} disabled={loading || inviting}>
            {loading ? "Refreshing…" : "Refresh access"}
          </Button>
        }
      >
        <p className="text-xs text-ink-400 mb-3">
          Full Studio access requires Write permission on every repository below.
          Repository Admin permission is only required to invite other people or
          change GitHub settings.
        </p>

        <div className="flex flex-col gap-4">
          {targets.map((target) => (
            <RepositoryAccessPanel
              key={target.binding.githubId}
              target={target}
              currentLogin={local.githubLogin}
              state={states[target.binding.githubId]}
              loading={loading && !states[target.binding.githubId]}
            />
          ))}
        </div>
      </Card>

      <Card title="Invite a project administrator">
        <p className="text-xs text-ink-400 mb-3">
          Sends Write-access invitations to all {targets.length} connected
          {targets.length === 1 ? " repository" : " repositories"}. They must
          accept on GitHub, then connect their own token in Studio.
        </p>
        {!manageable && !loading && (
          <p className="text-xs text-amber-400 mb-3">
            Direct invitations require your account to be Admin on every repository
            and your token to grant Administration: Read and write. You can still
            use each repository's Manage access link.
          </p>
        )}
        <div className="flex gap-2 items-end">
          <Field label="GitHub username" className="flex-1">
            <Input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="username"
              onKeyDown={(event) => {
                if (event.key === "Enter") void invite();
              }}
            />
          </Field>
          <Button
            variant="primary"
            onClick={() => void invite()}
            disabled={
              !manageable ||
              !usernameValid ||
              invitingSelf ||
              inviting ||
              loading
            }
          >
            {inviting ? "Inviting…" : "Invite to project"}
          </Button>
        </div>
        {username && !usernameValid && (
          <p className="text-xs text-red-400 mt-2">Enter a valid GitHub username.</p>
        )}
        {invitingSelf && (
          <p className="text-xs text-amber-400 mt-2">You already have project access.</p>
        )}
      </Card>
    </>
  );
}

function RepositoryAccessPanel({
  target,
  currentLogin,
  state,
  loading,
  mock = false,
}: {
  target: ProjectAccessTarget;
  currentLogin: string;
  state?: AccessState;
  loading: boolean;
  mock?: boolean;
}) {
  const access = state?.access;
  const collaborators = [...(access?.collaborators ?? [])].sort((a, b) => {
    const aCurrent = a.login.toLowerCase() === currentLogin.toLowerCase();
    const bCurrent = b.login.toLowerCase() === currentLogin.toLowerCase();
    return Number(bCurrent) - Number(aCurrent) || a.login.localeCompare(b.login);
  });

  return (
    <section className="border border-ink-700 rounded-lg overflow-hidden">
      <header className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-ink-850">
        <div>
          <div className="text-sm font-medium text-ink-100">{target.label}</div>
          <div className="text-xs mono text-ink-400">{bindingSlug(target.binding)}</div>
        </div>
        <div className="flex items-center gap-2">
          {access && (
            <Badge tone={access.canAdmin ? "ok" : "neutral"}>
              Your role: {roleLabel(access.currentPermission)}
            </Badge>
          )}
          {!mock && (
            <Button
              variant="ghost"
              onClick={() => void openExternal(collaboratorsUrl(target.binding))}
            >
              Manage access on GitHub ↗
            </Button>
          )}
        </div>
      </header>

      <div className="p-3">
        {loading ? (
          <p className="text-xs text-ink-400">Loading access…</p>
        ) : state?.error ? (
          <p className="text-xs text-red-400">{state.error}</p>
        ) : access ? (
          <>
            <div className="text-xs font-medium text-ink-300 mb-1">
              People with repository access ({collaborators.length})
            </div>
            <div className="divide-y divide-ink-800">
              {collaborators.map((collaborator) => (
                <div
                  key={collaborator.login}
                  className="flex items-center justify-between gap-3 py-2 text-sm"
                >
                  <button
                    type="button"
                    className="text-ink-200 hover:text-white hover:underline"
                    onClick={() =>
                      collaborator.htmlUrl && void openExternal(collaborator.htmlUrl)
                    }
                    disabled={!collaborator.htmlUrl}
                  >
                    @{collaborator.login}
                    {collaborator.login.toLowerCase() === currentLogin.toLowerCase() && (
                      <span className="text-xs text-ink-500 ml-2">You</span>
                    )}
                  </button>
                  <Badge tone={collaborator.roleName === "admin" ? "ok" : "neutral"}>
                    {roleLabel(collaborator.roleName)}
                  </Badge>
                </div>
              ))}
            </div>

            {access.canAdmin && access.managementAvailable && (
              <div className="mt-3 pt-3 border-t border-ink-800">
                <div className="text-xs font-medium text-ink-300 mb-1">
                  Pending invitations ({access.invitations.length})
                </div>
                {access.invitations.length === 0 ? (
                  <p className="text-xs text-ink-500">No pending invitations.</p>
                ) : (
                  <div className="divide-y divide-ink-800">
                    {access.invitations.map((invitation) => (
                      <div
                        key={invitation.id}
                        className="flex items-center justify-between gap-3 py-2 text-sm"
                      >
                        <span className="text-ink-300">@{invitation.login}</span>
                        <div className="flex items-center gap-2">
                          <Badge tone="warn">Pending</Badge>
                          <Badge>{roleLabel(invitation.permission)}</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {access.canAdmin && !access.managementAvailable && (
              <p className="text-xs text-amber-400 mt-3">
                {access.managementProblem ||
                  "Pending invitations need Administration permission in your token."}
              </p>
            )}
            {!access.canAdmin && (
              <p className="text-xs text-ink-500 mt-3">
                Only repository admins can send or view pending invitations.
              </p>
            )}
          </>
        ) : (
          <p className="text-xs text-ink-500">Access has not been checked yet.</p>
        )}
      </div>
    </section>
  );
}

const MOCK_ACCESS_TARGETS: ProjectAccessTarget[] = [
  {
    role: "source",
    label: "Private project repository",
    binding: {
      githubId: "example-private",
      owner: "DinoDepot-Demo",
      name: "Example-Cluster-Config",
      remoteUrl: "",
      branch: "main",
      isPrivate: true,
      hasPages: false,
    },
  },
  {
    role: "delivery",
    label: "Public site repository",
    binding: {
      githubId: "example-public",
      owner: "DinoDepot-Demo",
      name: "Example-Cluster-Site",
      remoteUrl: "",
      branch: "main",
      isPrivate: false,
      hasPages: true,
    },
  },
];

const MOCK_ACCESS: RepositoryAccess = {
  currentPermission: "admin",
  canAdmin: true,
  managementAvailable: true,
  managementProblem: "",
  collaborators: [
    { login: "ExampleOwner", avatarUrl: "", htmlUrl: "", roleName: "admin" },
    { login: "RexOps", avatarUrl: "", htmlUrl: "", roleName: "admin" },
  ],
  invitations: [
    {
      id: "example-invitation",
      login: "BuildHerder",
      avatarUrl: "",
      htmlUrl: "",
      permission: "write",
      createdAt: "2026-08-24T12:00:00.000Z",
    },
  ],
};

function MockProjectAccess() {
  return (
    <>
      <p className="col-span-full -mb-2 text-xs text-cyan-300">
        Example data only. No GitHub account, repository, or invitation is contacted.
      </p>
      <Card title="Project administrators" feedback={feedbackTarget("project-access")}>
        <p className="mb-3 text-xs text-ink-400">
          This private-project and public-site pair demonstrates access shared across both repositories.
        </p>
        <div className="flex flex-col gap-4">
          {MOCK_ACCESS_TARGETS.map((target) => (
            <RepositoryAccessPanel
              key={target.binding.githubId}
              target={target}
              currentLogin="ExampleOwner"
              state={{ access: MOCK_ACCESS }}
              loading={false}
              mock
            />
          ))}
        </div>
      </Card>
      <Card title="Invite a project administrator">
        <p className="text-xs text-ink-400">
          Example invitation controls are disabled so this project cannot contact GitHub.
        </p>
        <div className="mt-3 flex items-end gap-2">
          <Field label="GitHub username" className="flex-1">
            <Input value="BuildHerder" disabled readOnly />
          </Field>
          <Button variant="primary" disabled>Invite to project</Button>
        </div>
      </Card>
    </>
  );
}
