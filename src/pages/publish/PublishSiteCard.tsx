import { useEffect, useState } from "react";
import { Badge, Button, Card, cx } from "../../components/ui";
import { toast } from "../../components/toast";
import { openExternal } from "../../services/openExternal";
import { publicSiteUrl, usePublishStore } from "../../stores/publishStore";
import { useProjectStore } from "../../stores/projectStore";
import { useSyncStore } from "../../stores/syncStore";
import { PUBLISH_STAGE_LABELS } from "../../services/publishPipeline";
import { issuesFor, type ProjectIssue } from "../../validation/project";
import { canPublish } from "../../model/localState";
import { feedbackTarget } from "../../model/feedback/targets";

/**
 * Publishing the public site.
 *
 * One button and one commit. The previous version published each output
 * separately, so a failure halfway through left a site that was half last
 * week's - and there was no single moment at which the site was known to
 * correspond to a particular version of the project.
 */
export function PublishSiteCard() {
  const stage = usePublishStore((s) => s.stage);
  const running = usePublishStore((s) => s.running);
  const last = usePublishStore((s) => s.last);
  const report = usePublishStore((s) => s.report);
  const acknowledged = usePublishStore((s) => s.warningsAcknowledged);
  const check = usePublishStore((s) => s.check);
  const publish = usePublishStore((s) => s.publish);
  const syncAndPublish = usePublishStore((s) => s.syncAndPublish);
  const acknowledge = usePublishStore((s) => s.acknowledgeWarnings);

  const local = useProjectStore((s) => s.local);
  const syncPhase = useSyncStore((s) => s.phase);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    check();
  }, [check]);

  const ready = canPublish(local);
  const synchronized = Boolean(local?.lastSyncedCommit);
  const errors = report?.issues.filter((i) => i.level === "error") ?? [];
  const warnings = report?.issues.filter((i) => i.level === "warning") ?? [];
  const siteUrl = publicSiteUrl();

  async function run(combined: boolean) {
    const result = combined ? await syncAndPublish() : await publish();
    if (result.error) toast.error(result.message);
    else toast.success(result.message);
  }

  return (
    <Card
      className="mb-4"
      title="Public site"
      feedback={feedbackTarget("publish-site-card")}
      actions={
        <div className="flex items-center gap-2">
          {running ? (
            <Badge tone="info">{PUBLISH_STAGE_LABELS[stage as never] ?? "Working"}</Badge>
          ) : last ? (
            <Badge tone={last.error ? "error" : last.stage === "timed-out" ? "warn" : "ok"}>
              {PUBLISH_STAGE_LABELS[last.stage]}
            </Badge>
          ) : null}
        </div>
      }
    >
      <p className="text-xs text-ink-400 mb-3">
        Everything the public page needs, published together as one change. The
        site records which version of the project it was built from, so it can
        only be built from a version the team already has.
      </p>

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-ink-400">Published together:</span>
        <Badge tone="info">Cluster Viewer Page</Badge>
        <Badge tone="info">Cluster Viewer Data</Badge>
        <Badge tone="neutral">Icons and build manifest</Badge>
      </div>

      {!ready && (
        <p className="text-sm text-amber-400 mb-3">
          {local?.topology === "source-and-delivery"
            ? "Connect a public site repository in Settings before publishing."
            : local?.topology === "single-public"
              ? "Connect one public project repository in Settings before publishing."
              : "Connect a private project repository in Settings before publishing."}
        </p>
      )}

      {ready && !synchronized && (
        <p className="text-sm text-amber-400 mb-3">
          Share your changes with the team first - use Sync and publish, or Sync
          on its own.
        </p>
      )}

      {errors.length > 0 && (
        <IssueList
          issues={errors}
          tone="error"
          heading={`${errors.length} problem${errors.length === 1 ? "" : "s"} must be fixed first`}
        />
      )}

      {errors.length === 0 && warnings.length > 0 && (
        <>
          <IssueList
            issues={warnings}
            tone="warning"
            heading={`${warnings.length} warning${warnings.length === 1 ? "" : "s"}`}
          />
          {!acknowledged && (
            <Button className="mb-3" onClick={acknowledge}>
              Publish anyway
            </Button>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => void run(true)}
          disabled={!ready || running || errors.length > 0}
          title="Shares your changes, then builds and publishes the site from them"
        >
          {running ? "Working…" : "Sync and publish"}
        </Button>
        <Button
          onClick={() => void run(false)}
          disabled={!ready || running || errors.length > 0 || !synchronized}
          title="Builds and publishes the site from the version already shared"
        >
          Publish only
        </Button>
        {siteUrl && (
          <Button onClick={() => void openExternal(siteUrl)}>View the site ↗</Button>
        )}
      </div>

      {last?.message && (
        <p
          className={cx(
            "text-sm mt-3",
            last.error ? "text-red-400" : "text-ink-300",
          )}
        >
          {last.message}
        </p>
      )}

      {/* Commit ids and technical detail live here and nowhere else. */}
      {(last?.commit || last?.error?.detail) && (
        <>
          <button
            type="button"
            className="mt-2 text-[11px] text-ink-500 hover:text-ink-300"
            onClick={() => setShowDetails((v) => !v)}
          >
            {showDetails ? "Hide" : "Show"} advanced details
          </button>
          {showDetails && (
            <dl className="mt-1 text-[11px] text-ink-500 mono flex flex-col gap-0.5">
              {last.sourceRevision && (
                <div>
                  <dt className="inline">Built from source revision: </dt>
                  <dd className="inline">{last.sourceRevision.slice(0, 10)}</dd>
                </div>
              )}
              {last.commit && (
                <div>
                  <dt className="inline">Site commit: </dt>
                  <dd className="inline">{last.commit.slice(0, 10)}</dd>
                </div>
              )}
              {last.manifest && (
                <div>
                  <dt className="inline">Build: </dt>
                  <dd className="inline">{last.manifest.publishOperationId}</dd>
                </div>
              )}
              {last.error?.detail && <div className="break-all">{last.error.detail}</div>}
              <div>Sync status: {syncPhase}</div>
            </dl>
          )}
        </>
      )}
    </Card>
  );
}

function IssueList({
  issues,
  tone,
  heading,
}: {
  issues: ProjectIssue[];
  tone: "error" | "warning";
  heading: string;
}) {
  // Grouped by area so a page with eight icon warnings reads as one line about
  // icons rather than eight about nothing in particular.
  const areas = [...new Set(issues.map((i) => i.area))];

  return (
    <div className="mb-3">
      <div
        className={cx(
          "text-sm mb-1",
          tone === "error" ? "text-red-400" : "text-amber-400",
        )}
      >
        {heading}
      </div>
      <ul className="text-xs text-ink-400 flex flex-col gap-1">
        {areas.map((area) => (
          <li key={area}>
            <span className="text-ink-300">{area}</span>
            <ul className="ml-4 list-disc">
              {issues
                .filter((i) => i.area === area)
                .slice(0, 5)
                .map((issue, i) => (
                  <li key={i}>
                    {issue.where}: {issue.message}
                  </li>
                ))}
            </ul>
          </li>
        ))}
      </ul>
      {issues.length > areas.length * 5 && (
        <div className="text-xs text-ink-500 mt-1">
          …and more. Fix these first, then check again.
        </div>
      )}
    </div>
  );
}

export { issuesFor };
