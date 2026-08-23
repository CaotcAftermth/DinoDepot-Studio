import { useCallback, useEffect, useState } from "react";
import {
  Badge,
  Button,
  Card,
  CollapsibleCard,
  Field,
  Input,
  cx,
} from "../../components/ui";
import { SecretInput } from "../../components/SecretInput";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";
import { openExternal } from "../../services/openExternal";
import { useProjectStore } from "../../stores/projectStore";
import { useDraftsStore } from "../../stores/draftsStore";
import * as github from "../../services/githubAccount";
import {
  applyRemote,
  connectRepository,
  refreshConnection,
} from "../../services/repoConnection";
import { asStudioError } from "../../model/errors";
import {
  bindingSlug,
  deliveryBindingPatch,
  siteBinding,
  sourceBindingPatch,
  topologyPatch,
  topologyUsesSeparateDelivery,
  type PublishTopology,
} from "../../model/localState";
import {
  currentStep,
  newRepoUrl,
  newTokenUrl,
  pagesSettingsUrl,
  publicSourcePrivacyProblem,
  OPTIONAL_TOKEN_ACCESS,
  REQUIRED_TOKEN_ACCESS,
  setupSteps,
  UNNECESSARY_TOKEN_ACCESS,
  type RepoRole,
  type SetupIssue,
  type SetupStep,
} from "../../model/repoSetup";
import { feedbackTarget } from "../../model/feedback/targets";

function privacyProblemFor(topology: PublishTopology): string {
  const project = useProjectStore.getState();
  const drafts = useDraftsStore.getState();
  return publicSourcePrivacyProblem({
    topology,
    playerDataEnabled: project.settings?.modules["player-data"] === true,
    playerCount: drafts.players.players.length,
    cleanSlateCount: drafts.players.cleanSlates.length,
    hasPlayerActivity: drafts.activity.events.some((event) => event.kind === "players"),
    hasPlayerHistory: drafts.history.records.some((record) => record.family === "players"),
    hasPendingPlayerChanges: Boolean(
      project.local?.pendingActions.some((action) => action.type.startsWith("player.")),
    ),
  });
}

/**
 * Connecting a project to GitHub.
 *
 * A checklist rather than a wizard: each setup fact, in order, which the
 * administrator either has or has not done. A wizard hides where you are the
 * moment you close it, and this is a setup people come back to — when a token
 * expires, when a repository is renamed, when a second administrator joins.
 *
 * Repository creation stays on GitHub. Collaborator visibility and invitations
 * live in the separate Project Access category; its extra Administration grant
 * is optional, repository-scoped, and never needed for Sync or Publish.
 *
 * The cards are in the order of the checklist above them, and a step that is
 * done folds itself away: once a token is stored there is nothing to read in
 * the card explaining which permissions to give it. Its header keeps the badge,
 * so what was decided is still legible at a glance, and it reopens on a click
 * or by itself if the connection later breaks.
 */
export function GitHubSetup() {
  const local = useProjectStore((s) => s.local);
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const dir = useProjectStore((s) => s.dir);

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<github.AccountStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [connectionIssues, setConnectionIssues] = useState<SetupIssue[]>([]);
  /**
   * Whether the account has been asked about yet.
   *
   * A failed check leaves `status` null, which is the same value it holds
   * while the check is still running — so without this the card cannot tell a
   * broken sign-in from one it has not looked at, and folds away over an
   * "Access expired" badge with the explanation hidden inside it.
   */
  const [checked, setChecked] = useState(false);

  const accountId = local?.githubAccountId ?? "";

  const refreshStatus = useCallback(() => {
    setChecked(false);
    setStatusError("");
    if (!accountId) {
      setStatus(null);
      setChecked(true);
      return;
    }
    github
      .accountStatus(accountId)
      .then((next) => {
        if (useProjectStore.getState().local?.githubAccountId !== accountId) return;
        setStatus(next);
        setStatusError("");
      })
      .catch((error) => {
        if (useProjectStore.getState().local?.githubAccountId !== accountId) return;
        setStatus(null);
        setStatusError(
          asStudioError(error, "unknown", "Could not check your GitHub sign-in.").message,
        );
      })
      .finally(() => {
        if (useProjectStore.getState().local?.githubAccountId === accountId) {
          setChecked(true);
        }
      });
  }, [accountId]);

  useEffect(refreshStatus, [refreshStatus]);

  const steps = setupSteps(local ?? null);
  const step = currentStep(steps);

  async function handleConnectAccount() {
    if (!token.trim()) return;
    setBusy("account");
    try {
      const account = await github.connectAccount(token.trim());
      setToken("");
      await updateLocal({
        githubAccountId: account.accountId,
        githubLogin: account.login,
      });
      toast.success(`Connected as ${account.login}`);
      refreshStatus();
    } catch (e) {
      toast.error(asStudioError(e, "auth.missing", "That sign-in failed.").message);
    } finally {
      setBusy("");
    }
  }

  async function handleDisconnect() {
    setBusy("account");
    try {
      await github.disconnectAccount(accountId);
      await updateLocal({ githubAccountId: "", githubLogin: "" });
      setStatus(null);
      toast.info("GitHub sign-in removed from this computer");
    } catch (e) {
      toast.error(asStudioError(e, "unknown", "Could not remove your GitHub sign-in.").message);
    } finally {
      setBusy("");
    }
  }

  async function handleRecheck() {
    if (!local || !dir) return;
    setBusy("check");
    setConnectionIssues([]);
    try {
      const { report, patch } = await refreshConnection(local, dir);
      if (Object.keys(patch).length > 0) await updateLocal(patch);
      for (const note of report.notes) toast.info(note);
      const results = [report.source, report.delivery].filter(Boolean);
      const issues: SetupIssue[] = [
        ...results.flatMap((result) => result?.issues ?? []),
        ...(report.pairing
          ? [{ level: "error" as const, message: report.pairing.message, fix: report.pairing.fix }]
          : []),
      ];
      const unavailable = results.flatMap((result) =>
        result?.availability ? [result.availability] : [],
      );
      setConnectionIssues([
        ...issues,
        ...unavailable.map((problem) => ({
          level: problem.availability === "offline" ? ("warning" as const) : ("error" as const),
          message: problem.message,
          fix: problem.offerReconnect
            ? "Choose Change on that repository to connect a replacement."
            : "Try Check connection again when GitHub is reachable.",
        })),
      ]);
      for (const problem of unavailable) toast.error(problem.message);
      if (issues.some((issue) => issue.level === "error")) {
        toast.error(issues.find((issue) => issue.level === "error")!.message);
      } else if (unavailable.length === 0 && report.notes.length === 0) {
        toast.success(
          `${results.length} connected ${results.length === 1 ? "repository is" : "repositories are"} reachable`,
        );
      }
    } catch (e) {
      toast.error(asStudioError(e, "unknown", "Could not check the connection.").message);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <SetupChecklist
        steps={steps}
        step={step}
        canCheck={Boolean(local?.source?.githubId)}
        busy={busy === "check"}
        onCheck={() => void handleRecheck()}
      />

      {connectionIssues.length > 0 && (
        <Card title="Connection issues">
          <IssueList issues={connectionIssues} />
        </Card>
      )}

      <TopologyCard />

      <CollapsibleCard
        title="GitHub account"
        prefKey="github:account"
        feedback={feedbackTarget("github-account")}
        // Folded once a token is stored, and open again the moment that token
        // stops working — the reason is inside the card, so it must not be
        // the thing that is hidden. Stays folded until the check comes back,
        // rather than flashing open on every visit.
        defaultOpen={!accountId || (checked && (!status?.connected || Boolean(statusError)))}
        actions={
          status?.connected ? (
            <Badge tone="ok">Signed in as {status.login}</Badge>
          ) : accountId && !checked ? (
            <Badge tone="neutral">Checking…</Badge>
          ) : statusError ? (
            <Badge tone="warn">Could not check</Badge>
          ) : accountId ? (
            <Badge tone="error">Access expired</Badge>
          ) : (
            <Badge tone="warn">Not connected</Badge>
          )
        }
      >
        {accountId && statusError ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-amber-300">{statusError}</p>
            <div className="flex gap-2">
              <Button onClick={refreshStatus}>Try again</Button>
              <Button
                variant="danger"
                onClick={() => void handleDisconnect()}
                disabled={busy === "account"}
              >
                Sign out
              </Button>
            </div>
          </div>
        ) : accountId && status?.connected ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-ink-400">
              Your token is in Windows Credential Manager. DinoDepot never puts it
              in a project file, a commit, or a repository address.
            </p>
            <Button
              variant="danger"
              onClick={() => void handleDisconnect()}
              disabled={busy === "account"}
            >
              Sign out
            </Button>
          </div>
        ) : (
          <>
            {accountId && status && !status.connected && status.problem && (
              <p className="text-xs text-red-400 mb-3">{status.problem}</p>
            )}
            <p className="text-xs text-ink-400 mb-3">
              DinoDepot uses your own fine-grained token, limited to this
              project's repositories. Every administrator uses their own — a
              shared one is not supported.
            </p>
            <p className="text-xs text-ink-300 mb-3">
              Create the repository or repositories below first, so GitHub can
              limit the token to only those repositories.
            </p>

            <div className="text-xs text-ink-300 mb-3">
              <div className="font-medium mb-1">Core access:</div>
              <ul className="list-disc ml-5 flex flex-col gap-0.5 text-ink-400">
                {REQUIRED_TOKEN_ACCESS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="font-medium mt-2 mb-1">
                Optional — direct invitations:
              </div>
              <ul className="list-disc ml-5 flex flex-col gap-0.5 text-ink-400">
                {OPTIONAL_TOKEN_ACCESS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="font-medium mt-2 mb-1">And nothing else:</div>
              <ul className="list-disc ml-5 flex flex-col gap-0.5 text-ink-400">
                {UNNECESSARY_TOKEN_ACCESS.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            <div className="flex gap-2">
              <Button onClick={() => void openExternal(newTokenUrl())}>
                Create a token on GitHub ↗
              </Button>
            </div>
            <div className="flex gap-2 mt-2">
              <SecretInput
                stored={false}
                value={token}
                onChange={setToken}
                placeholder="github_pat_…"
              />
              <Button
                variant="primary"
                onClick={() => void handleConnectAccount()}
                disabled={!token.trim() || busy === "account"}
              >
                {busy === "account" ? "Checking…" : "Connect"}
              </Button>
            </div>
          </>
        )}
      </CollapsibleCard>

      <RepositoryCard
        role="source"
        title={
          local?.topology === "single-public"
            ? "Project repository (public)"
            : "Project repository (private)"
        }
        blurb={
          local?.topology === "single-public"
            ? "Holds the project and generated viewer together. It is public, so this arrangement is available only to projects that have never held Player Data."
            : "Holds the project itself — including shared project data and history. It must be private. Local backups and raw profiles are never committed."
        }
        disabled={!accountId}
        busyKey={busy}
        setBusy={setBusy}
      />

      {local && topologyUsesSeparateDelivery(local.topology) && (
        <RepositoryCard
          role="delivery"
          title="Public site repository"
          blurb="Holds only the generated cluster viewer. Separate and public, so the project itself can stay private on a free GitHub plan."
          disabled={!accountId || !local?.source?.githubId}
          busyKey={busy}
          setBusy={setBusy}
        />
      )}

    </>
  );
}

/**
 * The setup facts, in dependency order.
 *
 * Folds itself once every step is done: a finished checklist is a list of
 * ticks, and the header alone carries that. The Check connection button stays
 * in the header, since re-checking is the one thing still worth doing here.
 */
function SetupChecklist({
  steps,
  step,
  canCheck,
  busy,
  onCheck,
}: {
  steps: SetupStep[];
  /** The step to look at, or null when there is nothing left. */
  step: SetupStep | null;
  canCheck: boolean;
  busy: boolean;
  onCheck(): void;
}) {
  const done = steps.filter((entry) => entry.done).length;

  return (
    <CollapsibleCard
      title="Setup"
      prefKey="github:setup"
      feedback={feedbackTarget("github-setup")}
      defaultOpen={Boolean(step)}
      // Only while folded: open, the ticks below say the same thing.
      collapsedSummary={
        step ? (
          <span className="text-xs text-ink-400">
            {done} of {steps.length}
          </span>
        ) : (
          <Badge tone="ok">All {steps.length} steps done</Badge>
        )
      }
      actions={
        canCheck && (
          <Button onClick={onCheck} disabled={busy}>
            {busy ? "Checking…" : "Check connection"}
          </Button>
        )
      }
    >
      <ol className="flex flex-col gap-2">
        {steps.map((entry) => (
          <li
            key={entry.id}
            className={cx(
              "flex items-start gap-2 text-sm",
              entry.blocked && !entry.done && "opacity-40",
            )}
          >
            <span
              className={cx(
                "mt-0.5 w-4 shrink-0 text-center",
                entry.done ? "text-accent-400" : "text-ink-600",
              )}
            >
              {entry.done ? "✓" : "○"}
            </span>
            <span>
              <span className={cx(entry.id === step?.id && "font-medium")}>
                {entry.title}
              </span>
              {entry.detail && (
                <span className="block text-xs text-ink-500">{entry.detail}</span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </CollapsibleCard>
  );
}

function RepositoryCard({
  role,
  title,
  blurb,
  disabled,
  busyKey,
  setBusy,
}: {
  role: RepoRole;
  title: string;
  blurb: string;
  disabled: boolean;
  busyKey: string;
  setBusy(value: string): void;
}) {
  const local = useProjectStore((s) => s.local);
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const dir = useProjectStore((s) => s.dir);
  const bound = role === "source" ? local?.source : local?.delivery;

  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [issues, setIssues] = useState<SetupIssue[]>([]);
  const [editing, setEditing] = useState(false);

  async function handleConnect() {
    if (!local || !dir) return;
    if (role === "source") {
      const privacyProblem = privacyProblemFor(local.topology);
      if (privacyProblem) {
        setIssues([{ level: "error", message: privacyProblem, fix: "" }]);
        return;
      }
    }
    setBusy(role);
    setIssues([]);
    try {
      const result = await connectRepository(local, role, owner, name);
      setIssues(result.issues);
      if (!result.connected) return;
      const changing = Boolean(
        bound?.githubId &&
          (bound.githubId !== result.binding.githubId || bound.branch !== result.binding.branch),
      );
      if (
        changing &&
        !(await confirmDialog({
          title: `Switch to ${bindingSlug(result.binding)}?`,
          message:
            role === "source"
              ? "Sync checkpoints and the local Git history will be reset for the new project repository. Your project files and unsynchronized edit journal stay on this computer."
              : "Publish checkpoints and the cached site history will be reset for the new site repository.",
          confirmLabel: "Switch repository",
        }))
      ) {
        return;
      }
      if (role === "source") {
        await applyRemote(
          dir,
          result.binding,
          bound?.githubId !== result.binding.githubId || bound?.branch !== result.binding.branch,
        );
        await updateLocal(sourceBindingPatch(local, result.binding));
      } else {
        await updateLocal(deliveryBindingPatch(local, result.binding));
      }
      setOwner("");
      setName("");
      setEditing(false);
      toast.success(`Connected ${bindingSlug(result.binding)}`);
    } catch (e) {
      const error = asStudioError(e, "repo.unavailable", "Could not find that repository.");
      setIssues([{ level: "error", message: error.message, fix: "" }]);
    } finally {
      setBusy("");
    }
  }

  return (
    <CollapsibleCard
      title={title}
      prefKey={`github:repo:${role}`}
      feedback={feedbackTarget("github-repository")}
      // Chosen means settled: the header badge names it, and the body is a
      // form for choosing one. It reopens on a click, or on a failed connect
      // below, which is when the form matters again.
      defaultOpen={!bound?.githubId || issues.length > 0}
      actions={
        bound?.githubId ? (
          <Badge tone="ok">{bindingSlug(bound)}</Badge>
        ) : (
          <Badge tone="warn">Not chosen</Badge>
        )
      }
    >
      <p className="text-xs text-ink-400 mb-3">{blurb}</p>

      {bound?.githubId && !editing ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-400">
            Branch <span className="mono">{bound.branch}</span>
          </span>
          <Button
            onClick={() => void openExternal(`https://github.com/${bindingSlug(bound)}`)}
          >
            Open on GitHub ↗
          </Button>
          {local && siteBinding(local)?.githubId === bound.githubId && (
            <Button onClick={() => void openExternal(pagesSettingsUrl(bound))}>
              Pages settings ↗
            </Button>
          )}
          <Button onClick={() => setEditing(true)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-2">
            <Button
              onClick={() =>
                void openExternal(
                  newRepoUrl(
                    role === "source" ? "dinodepot-project" : "dinodepot-site",
                    role,
                    local?.topology ?? "source-and-delivery",
                  ),
                )
              }
            >
              Create one on GitHub ↗
            </Button>
            <span className="text-xs text-ink-500 self-center">
              then type its name below
            </span>
          </div>
          <div className="grid grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
            <Field label="Owner">
              <Input
                value={owner}
                onChange={(e) => setOwner(e.target.value)}
                placeholder="your-github-user"
                disabled={disabled}
              />
            </Field>
            <Field label="Repository">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={role === "source" ? "dinodepot-project" : "dinodepot-site"}
                disabled={disabled}
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => void handleConnect()}
              disabled={disabled || !owner.trim() || !name.trim() || busyKey === role}
            >
              {busyKey === role ? "Checking…" : "Connect"}
            </Button>
            {editing && (
              <Button
                onClick={() => {
                  setEditing(false);
                  setIssues([]);
                  setOwner("");
                  setName("");
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </>
      )}

      {issues.length > 0 && <IssueList issues={issues} className="mt-3" />}
    </CollapsibleCard>
  );
}

/** How the project and public site are divided between repositories. */
function TopologyCard() {
  const local = useProjectStore((s) => s.local);
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const topology = local?.topology ?? "source-and-delivery";

  async function choose(value: PublishTopology) {
    if (!local) return;
    const privacyProblem = privacyProblemFor(value);
    if (privacyProblem) {
      toast.error(privacyProblem);
      return;
    }
    if (value === topology) {
      if (!local.topologyConfirmed) await updateLocal({ topologyConfirmed: true });
      return;
    }
    if (
      (local.source || local.delivery) &&
      !(await confirmDialog({
        title: "Change repository arrangement?",
        message:
          "Repository bindings that no longer fit will be disconnected, and publishing checkpoints will be reset. Project files and unsynchronized edits stay on this computer.",
        confirmLabel: "Change arrangement",
      }))
    ) {
      return;
    }
    try {
      await updateLocal(topologyPatch(local, value));
      toast.info("Repository arrangement updated");
    } catch (error) {
      toast.error(asStudioError(error, "unknown", "Could not change the arrangement.").message);
    }
  }

  const summary =
    topology === "source-and-delivery"
      ? "Separate public site"
      : topology === "single-private"
        ? "One private repository"
        : "One public repository";

  return (
    <CollapsibleCard
      title="How the public site is published"
      prefKey="github:topology"
      defaultOpen={!local?.topologyConfirmed && !local?.source}
      actions={
        <Badge tone="neutral">{summary}</Badge>
      }
    >
      <div className="flex flex-col gap-2">
        <TopologyChoice
          selected={topology === "source-and-delivery"}
          onSelect={() => void choose("source-and-delivery")}
          title="Private project, separate public site"
          detail="Recommended, and the only arrangement that works on a free GitHub plan. The project stays private; a second, public repository carries the viewer."
        />
        <TopologyChoice
          selected={topology === "single-private"}
          onSelect={() => void choose("single-private")}
          title="One private repository, GitHub Pages"
          detail="Needs a paid GitHub plan. DinoDepot publishes to /docs; after the first publish, enable Pages from the main branch and /docs folder in GitHub settings."
        />
        <TopologyChoice
          selected={topology === "single-public"}
          onSelect={() => void choose("single-public")}
          title="One public repository"
          detail="Free and simple, but the entire project history is public. Available only when the project has never held Player Data. Local backups and raw profiles remain excluded."
        />
      </div>
    </CollapsibleCard>
  );
}

function IssueList({ issues, className }: { issues: SetupIssue[]; className?: string }) {
  return (
    <ul className={cx("flex flex-col gap-2", className)}>
      {issues.map((issue, i) => (
        <li
          key={`${issue.level}-${issue.message}-${i}`}
          className={cx(
            "text-xs rounded border p-2",
            issue.level === "error"
              ? "border-danger/30 bg-danger/10 text-red-300"
              : "border-amber-flag/30 bg-amber-flag/10 text-amber-300",
          )}
        >
          <div>{issue.message}</div>
          {issue.fix && <div className="text-ink-400 mt-1">{issue.fix}</div>}
        </li>
      ))}
    </ul>
  );
}

function TopologyChoice({
  selected,
  onSelect,
  title,
  detail,
}: {
  selected: boolean;
  onSelect(): void;
  title: string;
  detail: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cx(
        "text-left rounded border p-3 transition",
        selected ? "border-brand-400 bg-brand-500/10" : "border-ink-700 hover:border-ink-500",
      )}
    >
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-ink-400 mt-0.5">{detail}</div>
    </button>
  );
}
