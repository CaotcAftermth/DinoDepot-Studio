import { useFeedbackStore } from "../../stores/feedbackStore";
import { canSubmitDirectly, effectiveConfig } from "../../model/feedback/config";
import {
  FEEDBACK_TYPE_LABELS,
  type LocalFeedbackRecord,
} from "../../model/feedback/types";
import {
  REPORT_FILTERS,
  REPORT_FILTER_LABELS,
  friendlyStatus,
  matchesFilter,
  sortRecords,
  type ReportFilter,
} from "../../model/feedback/status";
import { canRetry, recordsForProject } from "../../model/feedback/records";
import { useProjectStore } from "../../stores/projectStore";
import { confirmDialog } from "../confirm";
import { Badge, Button, EmptyState, Modal, cx } from "../ui";

/**
 * Everything this installation has reported.
 *
 * The list is local. There is no "my reports" endpoint on the service and
 * deliberately so - answering that question would mean the service keeping a
 * record of which installation filed what, which is a database of exactly the
 * kind this design is trying not to have. The app knows its own issue numbers
 * and asks about those.
 */

export function MyReports() {
  const store = useFeedbackStore();
  const config = effectiveConfig(store.settings);
  // Reports written in the open project only - or, with none open, the ones
  // written with none open. The file holds every report this machine has made;
  // showing all of them here made one cluster's list read as another's.
  const projectId = useProjectStore((s) => s.settings?.projectId ?? "");
  const mine = recordsForProject(store.records, projectId);
  const visible = sortRecords(mine).filter((record) =>
    matchesFilter(record, store.filter),
  );

  return (
    <Modal
      title="My reports"
      onClose={store.close}
      wide
      footer={
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-ink-500">
            {store.refreshing
              ? "Checking for updates…"
              : store.lastSyncAt
                ? `Last checked ${relativeTime(store.lastSyncAt)}`
                : canSubmitDirectly(config)
                  ? "Not checked yet"
                  : "No feedback service configured"}
          </span>
          <div className="flex gap-2">
            {canSubmitDirectly(config) && (
              <Button
                variant="ghost"
                onClick={() => void store.refreshReports({ force: true })}
                disabled={store.refreshing}
              >
                Refresh
              </Button>
            )}
            <Button variant="secondary" onClick={store.openLauncher}>
              New report
            </Button>
          </div>
        </div>
      }
    >
      <div
        className="flex gap-1 mb-3 border-b border-ink-700 pb-2"
        role="tablist"
        aria-label="Filter reports"
      >
        {REPORT_FILTERS.map((filter) => (
          <FilterTab
            key={filter}
            filter={filter}
            active={store.filter === filter}
            count={mine.filter((r) => matchesFilter(r, filter)).length}
            onSelect={() => store.setFilter(filter)}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState title="Nothing here yet">
          {store.filter === "all"
            ? "Reports you send from inside DinoDepot Studio show up here, with whatever the maintainers do about them."
            : "Try another filter."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {visible.map((record) => (
            <ReportRow key={record.localId} record={record} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function FilterTab({
  filter,
  active,
  count,
  onSelect,
}: {
  filter: ReportFilter;
  active: boolean;
  count: number;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cx(
        "px-2.5 py-1 rounded-md text-sm cursor-pointer transition-colors",
        active
          ? "bg-ink-800 text-white"
          : "text-ink-400 hover:text-ink-100 hover:bg-ink-850",
      )}
    >
      {REPORT_FILTER_LABELS[filter]}
      {count > 0 && <span className="ml-1.5 text-xs text-ink-500">{count}</span>}
    </button>
  );
}

function ReportRow({ record }: { record: LocalFeedbackRecord }) {
  const store = useFeedbackStore();
  const status = friendlyStatus(record);
  const resumable = canRetry(record.status) && Boolean(record.draft);

  async function remove() {
    const ok = await confirmDialog({
      title: "Delete this report?",
      message: record.github
        ? "This removes it from your list here. The issue on GitHub stays where it is."
        : "This was never sent, so deleting it here loses what you wrote.",
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) await store.deleteRecord(record.localId);
  }

  return (
    <li className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-ink-100">
            {record.github && (
              <span className="text-ink-500 mono mr-1.5">
                #{record.github.issueNumber}
              </span>
            )}
            {record.title || "Untitled report"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={status.tone}>{status.label}</Badge>
            <span className="text-xs text-ink-400">
              {FEEDBACK_TYPE_LABELS[record.type]}
            </span>
            <span className="text-xs text-ink-500">
              {relativeTime(record.createdAt)}
            </span>
            {status.detail && (
              <span className="text-xs text-ink-500">· {status.detail}</span>
            )}
          </div>
          {record.status === "submission_failed" && record.failureMessage && (
            <p className="mt-1.5 text-xs text-red-400">{record.failureMessage}</p>
          )}
        </div>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-2">
        {record.github && (
          <Button variant="ghost" onClick={() => void store.openIssue(record.localId)}>
            Open on GitHub ↗
          </Button>
        )}
        {resumable && (
          <Button variant="secondary" onClick={() => store.resumeRecord(record.localId)}>
            {record.status === "draft" ? "Continue" : "Retry"}
          </Button>
        )}
        <Button variant="ghost" onClick={() => void remove()}>
          Delete
        </Button>
      </div>
    </li>
  );
}

/**
 * `2 days ago`, in whole units.
 *
 * Precision here would be noise: nobody needs to know a report was filed 51
 * hours ago, and "2 days ago" is what they would say out loud.
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.round(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}
