import {
  decodeCommitMessage,
  describeAction,
  type StructuredAction,
} from "./commitActions";
import { formatActivityTime, type ActivityKind } from "./activity";

/**
 * Recent Activity, read from the project's history.
 *
 * The previous version kept `activity.json` in the project and synchronized it
 * as a shared append-only array. Two administrators fight over that array
 * forever, and it lies the moment anybody edits a file outside Studio. Git
 * already records what happened, who did it and when — so this reads that
 * instead, and the structured trailers Sync writes are what make it readable
 * rather than a list of shas.
 */

export interface CommitSummary {
  sha: string;
  message: string;
  /** Author time, epoch milliseconds. */
  at: number;
  author: string;
  isHead: boolean;
}

export interface HistoryEntry {
  /** The commit sha. Shown only under Advanced details. */
  sha: string;
  /** Short sha, for the one place a person might quote it. */
  shortSha: string;
  at: number;
  when: string;
  author: string;
  /** The subject line — already written for a person to read. */
  title: string;
  /** One line per change, from the structured trailers. */
  details: string[];
  /** Changes this build cannot describe, from a newer Studio. */
  undescribed: number;
  /** Which page this belongs to, for the click target. */
  kind: ActivityKind;
  /** False for a commit DinoDepot did not write — a web edit, say. */
  fromStudio: boolean;
  isHead: boolean;
  /** True when this commit was a Publish rather than a Sync. */
  isPublish: boolean;
}

/** Domain prefix to the page it belongs to. */
const KIND_BY_DOMAIN: [prefix: string, kind: ActivityKind][] = [
  ["creature.", "production"],
  ["rule.", "production"],
  ["item.", "production"],
  ["remap.", "remap"],
  ["cosmetic.", "cosmetics"],
  ["mod.", "source"],
  ["source.", "source"],
  ["watchlist.", "watchlist"],
  ["player.", "players"],
  ["profile.", "players"],
  ["site.", "publish"],
  ["settings.", "settings"],
];

/**
 * Which page a commit belongs to.
 *
 * The first action decides, because a commit's subject is generated from the
 * same order — so the row and the place it takes you agree.
 */
function kindOf(actions: StructuredAction[]): ActivityKind {
  for (const action of actions) {
    const match = KIND_BY_DOMAIN.find(([prefix]) => action.type.startsWith(prefix));
    if (match) return match[1];
  }
  return "source";
}

/** Turns one commit into a row. */
export function toHistoryEntry(commit: CommitSummary, now = new Date()): HistoryEntry {
  const decoded = decodeCommitMessage(commit.message);
  const isPublish = decoded.actions.some((a) => a.type.startsWith("site."));

  return {
    sha: commit.sha,
    shortSha: commit.sha.slice(0, 7),
    at: commit.at,
    when: formatActivityTime(new Date(commit.at).toISOString(), now),
    // Studio's trailer carries the authenticated GitHub username. The Git
    // author remains a useful fallback for older Studio versions and changes
    // made directly through GitHub.
    author:
      (decoded.isDinoDepot ? decoded.actor : "") ||
      commit.author ||
      "Unknown administrator",
    title: decoded.subject || "Changed the project",
    details: decoded.actions.map(describeAction),
    undescribed: decoded.unreadableActions,
    kind: isPublish ? "publish" : kindOf(decoded.actions),
    fromStudio: decoded.isDinoDepot,
    isHead: commit.isHead,
    isPublish,
  };
}

/**
 * The history, newest first.
 *
 * Commits are already ordered by the Git layer; this only decodes them. A
 * commit DinoDepot did not write still becomes a row — somebody editing a file
 * through the GitHub web UI is a real event, and hiding it would make the list
 * disagree with the repository.
 */
export function buildHistory(
  commits: CommitSummary[],
  limit = 20,
  now = new Date(),
): HistoryEntry[] {
  return commits.slice(0, limit).map((commit) => toHistoryEntry(commit, now));
}

/**
 * A one-line summary of what a commit did, for a collapsed row.
 *
 * Falls back to the count when there are too many to list, because "12 changes"
 * is more useful than the first two and an ellipsis.
 */
export function summarizeEntry(entry: HistoryEntry): string {
  const total = entry.details.length + entry.undescribed;
  if (total === 0) return "";
  if (total > 3) return `${total} changes`;
  if (entry.undescribed > 0) {
    return [...entry.details, `${entry.undescribed} more this version cannot describe`].join(
      " · ",
    );
  }
  return entry.details.join(" · ");
}

/**
 * Whether an entry can be restored from.
 *
 * The current version is not a restore target — there would be nothing to do —
 * and a Publish commit lives in the *delivery* repository, whose contents are
 * regenerated rather than restored.
 */
export function isRestorable(entry: HistoryEntry): boolean {
  return !entry.isHead && !entry.isPublish;
}

/**
 * What a restore will say it did.
 *
 * Restoring produces a new commit on top of history rather than resetting,
 * because the history is shared and somebody may already have pulled it. The
 * wording says so: "went back to", not "undone".
 */
export function restoreSubject(entry: HistoryEntry): string {
  return `Went back to the project as it was on ${new Date(entry.at).toLocaleDateString(
    undefined,
    { month: "short", day: "numeric" },
  )}`;
}

/** Username as shown in history. Studio actors come from its connected GitHub login. */
export function historyAuthorLabel(entry: HistoryEntry): string {
  const author = entry.author.trim() || "Unknown administrator";
  return entry.fromStudio &&
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(author)
    ? `@${author}`
    : author;
}

/** Complete readable details, including changes from a newer Studio. */
export function historyDetailText(entry: HistoryEntry): string {
  return [
    ...entry.details,
    ...(entry.undescribed > 0
      ? [`${entry.undescribed} more this version cannot describe`]
      : []),
  ].join(" · ");
}

/** Searches every value an administrator can see or reasonably paste. */
export function filterHistory(entries: HistoryEntry[], query: string): HistoryEntry[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return entries;
  return entries.filter((entry) => {
    const text = [
      entry.title,
      ...entry.details,
      entry.author,
      historyAuthorLabel(entry),
      historyDetailText(entry),
      entry.kind,
      entry.sha,
      entry.shortSha,
      new Date(entry.at).toISOString(),
      new Date(entry.at).toLocaleString(),
      entry.when,
      entry.fromStudio ? "Studio" : "outside Studio",
    ]
      .join("\n")
      .toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

/** CSV for the history modal's Download action. */
export function historyToCsv(entries: HistoryEntry[]): string {
  const rows = entries.map((entry) => [
    new Date(entry.at).toISOString(),
    historyAuthorLabel(entry),
    entry.title,
    historyDetailText(entry),
    entry.fromStudio ? "DinoDepot Studio" : "Outside Studio",
    entry.shortSha,
  ]);
  return [
    ["Timestamp", "Administrator", "Summary", "Details", "Source", "Version"],
    ...rows,
  ]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
