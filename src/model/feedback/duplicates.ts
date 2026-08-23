import { areaLabelFor } from "./labels";
import type { FeedbackTargetSnapshot, FeedbackType } from "./types";

/**
 * Finding the issue somebody has already filed.
 *
 * Deliberately deterministic — no model, no embedding service, nothing that
 * has to be running for a report to be submitted. Two facts do most of the
 * work: reports filed from the app carry the component id in the issue body,
 * and two people hitting the same bug describe it with overlapping words. The
 * first is close to an exact key; the second is a decent tiebreak.
 *
 * Nothing here can block a submission. The candidates are shown, the reporter
 * decides, and "Submit anyway" is always available — a duplicate costs a
 * maintainer thirty seconds, and a suppressed report costs them the bug.
 */

export interface DuplicateSubject {
  type: FeedbackType;
  title: string;
  description: string;
  target: FeedbackTargetSnapshot | null;
}

export interface IssueCandidate {
  number: number;
  title: string;
  /** Trimmed by the service; only the opening is needed for scoring. */
  body: string;
  state: "open" | "closed";
  labels: string[];
  url: string;
  updatedAt: string;
}

export interface ScoredCandidate extends IssueCandidate {
  score: number;
  /** Why it was suggested, in the words the reporter sees. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Words that appear in every bug report and distinguish none of them.
 *
 * Includes the domain's own filler — "dino", "ark", "studio" — because a
 * search inside the DinoDepot Studio repository for the word "studio" returns
 * the repository.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "but", "for", "not", "with", "this", "that", "then", "than",
  "when", "what", "where", "which", "while", "into", "from", "have", "has",
  "had", "was", "were", "will", "would", "should", "could", "can", "does",
  "did", "doing", "done", "you", "your", "its", "it's", "there", "their",
  "they", "them", "some", "any", "all", "one", "two", "get", "got", "set",
  "use", "used", "using", "make", "makes", "made", "try", "tried", "trying",
  "just", "also", "only", "even", "still", "back", "after", "before",
  "click", "clicks", "clicked", "clicking", "open", "opens", "opened",
  "page", "app", "application", "screen", "button", "issue", "problem",
  "bug", "error", "errors", "happens", "happened", "expected", "actual",
  "dino", "depot", "dinodepot", "studio", "ark", "please", "would", "like",
]);

/** Below this a word is noise, and GitHub's search ignores it anyway. */
const MIN_KEYWORD = 4;

/**
 * The words worth searching for, best first.
 *
 * Ranked by how often they appear and then by length: a word the reporter used
 * three times is what the report is about, and among equally frequent words
 * the longer one is the more specific.
 */
export function keywordsOf(text: string, limit = 6): string[] {
  const counts = new Map<string, number>();
  for (const raw of String(text ?? "").toLowerCase().split(/[^a-z0-9']+/)) {
    const word = raw.replace(/^'+|'+$/g, "");
    if (word.length < MIN_KEYWORD) continue;
    if (STOPWORDS.has(word)) continue;
    if (/^\d+$/.test(word)) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * The searches to run, in the order they should be tried.
 *
 * Two rather than one, because they answer different questions. The first asks
 * "has anyone reported this exact control before", which is nearly an
 * identity match and is worth running on its own so a broad word search cannot
 * crowd it out. The second is the ordinary keyword search, and it deliberately
 * does not filter by area label — a repository that has not had the labels
 * created yet would otherwise return nothing at all.
 *
 * Closed issues are included. "This was fixed in 1.3.9" is one of the more
 * useful answers a reporter can get.
 */
export function duplicateQueries(
  subject: DuplicateSubject,
  repoSlug: string,
): string[] {
  const queries: string[] = [];
  const scope = `repo:${repoSlug} is:issue`;

  if (subject.target?.id) {
    queries.push(`${scope} in:body "${subject.target.id}"`);
  }

  const words = keywordsOf(`${subject.title} ${subject.description}`);
  if (words.length > 0) {
    queries.push(`${scope} in:title,body ${words.join(" ")}`);
  }

  // Nothing usable to search for — a two-word report with no target. Falling
  // back to the area alone would return the whole area, so it returns nothing
  // and the reporter is not shown a list of unrelated issues.
  return queries;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * How close a candidate is to the report being written.
 *
 * The component id dominates on purpose: it is the one signal that is a fact
 * rather than a guess. Everything else nudges.
 */
export function scoreCandidate(
  subject: DuplicateSubject,
  candidate: IssueCandidate,
): ScoredCandidate {
  let score = 0;
  const reasons: string[] = [];

  const componentId = subject.target?.id ?? "";
  if (componentId && candidate.body.includes(componentId)) {
    score += 6;
    reasons.push("same component");
  }

  const areaLabel = areaLabelFor(subject.target?.area ?? "");
  if (areaLabel && candidate.labels.includes(areaLabel)) {
    score += 2;
    if (reasons.length === 0) reasons.push("same area");
  }

  const mine = new Set(keywordsOf(`${subject.title} ${subject.description}`, 12));
  const theirs = new Set(keywordsOf(`${candidate.title} ${candidate.body}`, 24));
  let shared = 0;
  for (const word of mine) if (theirs.has(word)) shared += 1;
  const overlap = mine.size > 0 ? shared / mine.size : 0;
  score += overlap * 5;
  if (overlap >= 0.4 && reasons.length === 0) reasons.push("similar wording");

  // A report of the same kind is more likely to be the same report. A bug and
  // a feature request about one control are usually two different things.
  if (candidate.labels.includes(typeLabelOf(subject.type))) score += 1;

  // An open issue is the one worth joining; a closed one is still worth
  // showing, because "already fixed" is an answer.
  if (candidate.state === "open") score += 1;

  return {
    ...candidate,
    score: Math.round(score * 100) / 100,
    reason: reasons[0] ?? "possibly related",
  };
}

function typeLabelOf(type: FeedbackType): string {
  return type === "feature_request" ? "feature-request" : type;
}

/** Below this a candidate is not worth interrupting somebody with. */
export const DUPLICATE_THRESHOLD = 3;

/** How many candidates are ever shown. More than this is a search, not a hint. */
export const MAX_DUPLICATES = 4;

/**
 * The candidates worth showing, best first.
 *
 * Deduplicated by issue number because the two queries overlap by design, and
 * cut at a threshold so a report that resembles nothing shows no list rather
 * than a list of the four most recent issues.
 */
export function rankCandidates(
  subject: DuplicateSubject,
  candidates: IssueCandidate[],
  limit = MAX_DUPLICATES,
): ScoredCandidate[] {
  const seen = new Set<number>();
  const scored: ScoredCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.number)) continue;
    seen.add(candidate.number);
    scored.push(scoreCandidate(subject, candidate));
  }
  return scored
    .filter((c) => c.score >= DUPLICATE_THRESHOLD)
    .sort((a, b) => b.score - a.score || b.number - a.number)
    .slice(0, limit);
}
