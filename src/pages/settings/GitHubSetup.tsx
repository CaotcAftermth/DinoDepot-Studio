import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, Field, Input, cx } from "../../components/ui";
import { SecretInput } from "../../components/SecretInput";
import { toast } from "../../components/toast";
import { openExternal } from "../../services/openExternal";
import { useProjectStore } from "../../stores/projectStore";
import * as github from "../../services/githubAccount";
import { checkConnection, connectRepository } from "../../services/repoConnection";
import { asStudioError } from "../../model/errors";
import { bindingSlug, type PublishTopology } from "../../model/localState";
import {
  collaboratorsUrl,
  currentStep,
  newRepoUrl,
  newTokenUrl,
  pagesSettingsUrl,
  REQUIRED_TOKEN_ACCESS,
  setupSteps,
  UNNECESSARY_TOKEN_ACCESS,
  type RepoRole,
  type SetupIssue,
} from "../../model/repoSetup";

/**
 * Connecting a project to GitHub.
 *
 * A checklist rather than a wizard: five things, in order, each of which the
 * administrator either has or has not done. A wizard hides where you are the
 * moment you close it, and this is a setup people come back to — when a token
 * expires, when a repository is renamed, when a second administrator joins.
 *
 * Every repository and every collaborator is created **on GitHub, in the
 * browser**. DinoDepot never asks for the Administration permission, so it
 * could not create one even if it wanted to — and the administrator sees
 * exactly what they are agreeing to.
 */
export function GitHubSetup() {
  const local = useProjectStore((s) => s.local);
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const dir = useProjectStore((s) => s.dir);

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState("");
  const [status, setStatus] = useState<github.AccountStatus | null>(null);

  const accountId = local?.githubAccountId ?? "";

  const refreshStatus = useCallback(() => {
    if (!accountId) {
      setStatus(null);
      return;
    }
    github
      .accountStatus(accountId)
      .then(setStatus)
      .catch(() => setStatus(null));
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
    } finally {
      setBusy("");
    }
  }

  async function handleRecheck() {
    if (!local) return;
    setBusy("check");
    try {
      const report = await checkConnection(local);
      // A rename or transfer is followed silently and mentioned — never
      // treated as the repository having gone.
      if (report.source && report.source.change !== "none") {
        await updateLocal({ source: report.source.binding });
      }
      if (report.delivery && report.delivery.change !== "none") {
        await updateLocal({ delivery: report.delivery.binding });
      }
      for (const note of report.notes) toast.info(note);
      const unreachable = [report.source, report.delivery].find((r) => r?.availability);
      if (unreachable?.availability) toast.error(unreachable.availability.message);
      else if (report.notes.length === 0) toast.success("Both repositories are reachable");
    } catch (e) {
      toast.error(asStudioError(e, "unknown", "Could not check the connection.").message);
    } finally {
      setBusy("");
    }
  }

  return (
    <>
      <Card
        title="GitHub account"
        actions={
          status?.connected ? (
            <Badge tone="ok">Signed in as {status.login}</Badge>
          ) : accountId ? (
            <Badge tone="error">Access expired</Badge>
          ) : (
            <Badge tone="warn">Not connected</Badge>
          )
        }
      >
        {accountId && status?.connected ? (
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

            <div className="text-xs text-ink-300 mb-3">
              <div className="font-medium mb-1">Give it exactly this:</div>
              <ul className="list-disc ml-5 flex flex-col gap-0.5 text-ink-400">
                {REQUIRED_TOKEN_ACCESS.map((line) => (
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
      </Card>

      <Card
        title="Setup"
        actions={
          local?.source?.githubId ? (
            <Button onClick={() => void handleRecheck()} disabled={busy === "check"}>
              {busy === "check" ? "Checking…" : "Check connection"}
            </Button>
          ) : null
        }
      >
        <ol className="flex flex-col gap-2">
          {steps.map((s) => (
            <li
              key={s.id}
              className={cx(
                "flex items-start gap-2 text-sm",
                s.blocked && !s.done && "opacity-40",
              )}
            >
              <span
                className={cx(
                  "mt-0.5 w-4 shrink-0 text-center",
                  s.done ? "text-accent-400" : "text-ink-600",
                )}
              >
                {s.done ? "✓" : "○"}
              </span>
              <span>
                <span className={cx(s.id === step?.id && "font-medium")}>{s.title}</span>
                {s.detail && (
                  <span className="block text-xs text-ink-500">{s.detail}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <RepositoryCard
        role="source"
        title="Project repository (private)"
        blurb="Holds the project itself — the roster, the profile backups, and the history every administrator shares. It must be private."
        disabled={!accountId}
        busyKey={busy}
        setBusy={setBusy}
      />

      {local?.topology === "source-and-delivery" && (
        <RepositoryCard
          role="delivery"
          title="Public site repository"
          blurb="Holds only the generated cluster viewer. Separate and public, so the project itself can stay private on a free GitHub plan."
          disabled={!accountId || !local?.source?.githubId}
          busyKey={busy}
          setBusy={setBusy}
        />
      )}

      <TopologyCard />

      {dir && local?.source?.githubId && (
        <Card title="Other administrators">
          <p className="text-xs text-ink-400 mb-3">
            Add them on GitHub, as collaborators on the project repository. Each
            one connects their own token in their own copy of Studio.
          </p>
          <Button onClick={() => void openExternal(collaboratorsUrl(local.source!))}>
            Manage access on GitHub ↗
          </Button>
        </Card>
      )}
    </>
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
  const bound = role === "source" ? local?.source : local?.delivery;

  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [issues, setIssues] = useState<SetupIssue[]>([]);

  async function handleConnect() {
    if (!local) return;
    setBusy(role);
    setIssues([]);
    try {
      const result = await connectRepository(local, role, owner, name);
      setIssues(result.issues);
      if (!result.connected) return;
      await updateLocal(
        role === "source" ? { source: result.binding } : { delivery: result.binding },
      );
      setOwner("");
      setName("");
      toast.success(`Connected ${bindingSlug(result.binding)}`);
    } catch (e) {
      const error = asStudioError(e, "repo.unavailable", "Could not find that repository.");
      setIssues([{ level: "error", message: error.message, fix: "" }]);
    } finally {
      setBusy("");
    }
  }

  return (
    <Card
      title={title}
      actions={
        bound?.githubId ? (
          <Badge tone="ok">{bindingSlug(bound)}</Badge>
        ) : (
          <Badge tone="warn">Not chosen</Badge>
        )
      }
    >
      <p className="text-xs text-ink-400 mb-3">{blurb}</p>

      {bound?.githubId ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-400">
            Branch <span className="mono">{bound.branch}</span>
          </span>
          <Button
            onClick={() => void openExternal(`https://github.com/${bindingSlug(bound)}`)}
          >
            Open on GitHub ↗
          </Button>
          {role === "delivery" && (
            <Button onClick={() => void openExternal(pagesSettingsUrl(bound))}>
              Pages settings ↗
            </Button>
          )}
          <Button
            onClick={() =>
              void updateLocal(role === "source" ? { source: null } : { delivery: null })
            }
          >
            Change
          </Button>
        </div>
      ) : (
        <>
          <div className="flex gap-2 mb-2">
            <Button
              disabled={disabled}
              onClick={() =>
                void openExternal(
                  newRepoUrl(
                    role === "source" ? "dinodepot-project" : "dinodepot-site",
                    role,
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
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 items-end">
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
          </div>
        </>
      )}

      {issues.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2">
          {issues.map((issue, i) => (
            <li
              key={i}
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
      )}
    </Card>
  );
}

/** How the public site is published. Two options, and the trade-off is money. */
function TopologyCard() {
  const local = useProjectStore((s) => s.local);
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const topology = local?.topology ?? "source-and-delivery";

  const choose = (value: PublishTopology) => void updateLocal({ topology: value });

  return (
    <Card title="How the public site is published">
      <div className="flex flex-col gap-2">
        <TopologyChoice
          selected={topology === "source-and-delivery"}
          onSelect={() => choose("source-and-delivery")}
          title="Private project, separate public site"
          detail="Recommended, and the only arrangement that works on a free GitHub plan. The project stays private; a second, public repository carries the viewer."
        />
        <TopologyChoice
          selected={topology === "single-private"}
          onSelect={() => choose("single-private")}
          title="One private repository, GitHub Pages"
          detail="Needs a paid GitHub plan — Pages cannot serve a private repository for free. You install a small publishing workflow yourself; DinoDepot never edits workflows."
        />
      </div>
    </Card>
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
