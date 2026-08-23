import type { IssueState, LocalFeedbackRecord } from "./types";

/**
 * What a report's state means to the person who filed it.
 *
 * GitHub says `open` with a label called `needs-triage`. An administrator wants
 * to know whether anybody has looked at it. This module is the translation,
 * and its one rule is that it never makes anything up: a repository that does
 * not use these labels gets "Open" and "Closed", which is true, rather than
 * "Submitted" and "Fixed", which would be a guess.
 */

export type StatusTone = "neutral" | "info" | "ok" | "warn" | "error";

export interface FriendlyStatus {
  label: string;
  tone: StatusTone;
  /** One line under the label, when there is something worth adding. */
  detail: string;
}

/**
 * Labels that describe progress, most advanced first.
 *
 * Order is the resolution rule: an issue carrying both `confirmed` and
 * `in-progress` is in progress, and reading them in a fixed order means two
 * clients never disagree about which one wins.
 */
const PROGRESS_LABELS: readonly (readonly [string, string, StatusTone])[] = [
  ["fixed", "Fixed", "ok"],
  ["duplicate", "Duplicate", "neutral"],
  ["wont-fix", "Won't fix", "neutral"],
  ["in-progress", "In progress", "info"],
  ["planned", "Planned", "info"],
  ["confirmed", "Confirmed", "info"],
  ["needs-triage", "Submitted", "neutral"],
] as const;

/** How a local record reads before it has ever reached GitHub. */
const LOCAL_STATUS: Record<string, FriendlyStatus> = {
  draft: { label: "Draft", tone: "neutral", detail: "Not submitted yet" },
  pending: {
    label: "Sending",
    tone: "info",
    detail: "Submission is in progress",
  },
  submission_failed: {
    label: "Not sent",
    tone: "error",
    detail: "Saved on this computer — retry when you are ready",
  },
};

/**
 * The status to show for one record.
 *
 * Local state wins while there is no issue: a draft is a draft regardless of
 * what GitHub thinks, and a failed submission must read as failed rather than
 * quietly as "Open".
 */
export function friendlyStatus(record: LocalFeedbackRecord): FriendlyStatus {
  const local = LOCAL_STATUS[record.status];
  if (local && !record.github) return local;
  if (record.status === "submission_failed") return LOCAL_STATUS.submission_failed;

  const issue = record.lastKnownIssueState;
  if (!issue) {
    return record.status === "linked_existing"
      ? { label: "Linked", tone: "info", detail: "Added to an existing report" }
      : { label: "Submitted", tone: "neutral", detail: "Waiting for the first update" };
  }
  return statusFromIssue(issue);
}

/**
 * The status a GitHub issue's own state and labels amount to.
 *
 * A closed issue with no progress label reads as "Closed" and nothing more.
 * Guessing "Fixed" there would tell somebody their bug was solved when it may
 * have been closed as a duplicate, as stale, or by mistake.
 */
export function statusFromIssue(issue: IssueState): FriendlyStatus {
  const labels = new Set(issue.labels.map((l) => l.toLowerCase()));
  for (const [label, text, tone] of PROGRESS_LABELS) {
    if (!labels.has(label)) continue;
    // `needs-triage` on a closed issue is stale bookkeeping, not a status.
    if (label === "needs-triage" && issue.state === "closed") break;
    const version = fixVersion(issue);
    return {
      label: text,
      tone,
      detail:
        label === "fixed" && version
          ? `Fixed in ${version}`
          : issue.state === "closed"
            ? "Closed on GitHub"
            : "",
    };
  }
  return issue.state === "open"
    ? { label: "Open", tone: "info", detail: "" }
    : { label: "Closed", tone: "neutral", detail: fixVersion(issue) ? `Released in ${fixVersion(issue)}` : "" };
}

/**
 * The release a fix landed in, if the repository records one.
 *
 * Two conventions are read because both are common and neither is required: a
 * milestone named after the version, or a `fixed-in:x.y.z` label. When the
 * repository uses neither, this returns nothing and the status simply does not
 * mention a version.
 */
export function fixVersion(issue: IssueState): string {
  const fromLabel = issue.labels
    .map((label) => /^fixed-in:\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/i.exec(label.trim()))
    .find(Boolean);
  if (fromLabel) return fromLabel[1];

  const milestone = issue.milestone.trim();
  const fromMilestone = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(milestone);
  if (fromMilestone) return fromMilestone[1];
  return "";
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export const REPORT_FILTERS = ["all", "open", "resolved", "drafts"] as const;
export type ReportFilter = (typeof REPORT_FILTERS)[number];

export const REPORT_FILTER_LABELS: Record<ReportFilter, string> = {
  all: "All",
  open: "Open",
  resolved: "Resolved",
  drafts: "Drafts",
};

/**
 * Which reports a filter shows.
 *
 * "Open" includes reports that failed to send. They are unfinished business
 * from the reporter's point of view, and putting them anywhere else means the
 * one list somebody checks is the list that hides the report they still need
 * to deal with.
 */
export function matchesFilter(
  record: LocalFeedbackRecord,
  filter: ReportFilter,
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "drafts":
      return record.status === "draft";
    case "open":
      if (record.status === "draft") return false;
      if (record.status === "submission_failed" || record.status === "pending") return true;
      return record.lastKnownIssueState?.state !== "closed";
    case "resolved":
      return record.lastKnownIssueState?.state === "closed";
  }
}

/**
 * The order My Reports lists them in.
 *
 * Newest first by the time the record last changed, so a report that just came
 * back from GitHub with a status rises to the top — which is the one somebody
 * opened the page to see.
 */
export function sortRecords(records: LocalFeedbackRecord[]): LocalFeedbackRecord[] {
  return [...records].sort((a, b) => {
    const at = b.updatedAt.localeCompare(a.updatedAt);
    return at !== 0 ? at : b.createdAt.localeCompare(a.createdAt);
  });
}

/** Whether a refresh from GitHub is due. Never polls; only answers on request. */
export function needsRefresh(lastSyncAt: string, maxAgeMs: number, now = Date.now()): boolean {
  if (!lastSyncAt) return true;
  const at = Date.parse(lastSyncAt);
  if (Number.isNaN(at)) return true;
  return now - at > maxAgeMs;
}

/** Issue numbers worth asking about: submitted or linked, and not closed long ago. */
export function issuesToRefresh(records: LocalFeedbackRecord[]): number[] {
  return records
    .filter((record) => record.github)
    .map((record) => record.github?.issueNumber ?? 0)
    .filter((number) => number > 0);
}
