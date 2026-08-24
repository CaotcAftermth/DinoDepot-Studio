import { newId } from "../ids";
import {
  FEEDBACK_CONFIG,
  FEEDBACK_SOURCE,
  FEEDBACK_SCHEMA_VERSION,
} from "./config";
import { issueTitle } from "./issue";
import { containsCredentialLikeText } from "./log";
import {
  FEEDBACK_STATE_VERSION,
  FeedbackStateSchema,
  LocalFeedbackRecordSchema,
  MAX_LOCAL_RECORDS,
  emptyFeedbackState,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type FeedbackReport,
  type FeedbackState,
  type FeedbackStatus,
  type IssueState,
  type LocalFeedbackRecord,
} from "./types";

/**
 * The life of a report on the machine that produced it.
 *
 * A report is not a request that either succeeds or is forgotten. It is
 * something somebody wrote, and if the network was down while they wrote it,
 * losing it is the worst outcome available. So every report becomes a local
 * record first, and submission is a transition on that record rather than a
 * precondition for it existing.
 *
 * The transitions are here, as plain functions over plain data, because this
 * is the part that must be right whether or not any UI was rendered.
 */

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * The installation id.
 *
 * A random value, generated once, stored beside the reports. It exists so the
 * service can rate-limit and so two reports from one machine can be recognised
 * as such. It is not derived from the hardware, the network, the account, or
 * anything else that would survive somebody deleting it — which they can, by
 * deleting the feedback file.
 */
export function newReporterId(): string {
  return `dd-install-${newId()}`;
}

const REPORTER_ID_SHAPE = /^dd-install-[A-Za-z0-9-]{8,60}$/;

export function isReporterId(value: string): boolean {
  return REPORTER_ID_SHAPE.test(value);
}

/** The state with an installation id, generating one the first time. */
export function ensureReporterId(state: FeedbackState): FeedbackState {
  if (isReporterId(state.reporterId)) return state;
  return { ...state, reporterId: newReporterId() };
}

// ---------------------------------------------------------------------------
// Reading the stored file
// ---------------------------------------------------------------------------

/**
 * Parses the stored feedback file, and never throws.
 *
 * A feedback file that cannot be read must not be able to stop anything. Every
 * failure here returns an empty state, because the alternative — propagating
 * the error — would put a non-essential subsystem in a position to break the
 * app's startup, which is exactly what this design is meant to prevent.
 *
 * Records are parsed one at a time so a single corrupt entry costs that entry
 * rather than the whole history.
 */
export function migrateFeedbackState(raw: string | null): FeedbackState {
  if (!raw) return ensureReporterId(emptyFeedbackState());

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return ensureReporterId(emptyFeedbackState());
  }
  if (!parsed || typeof parsed !== "object") {
    return ensureReporterId(emptyFeedbackState());
  }

  const source = parsed as Record<string, unknown>;
  const version = typeof source.schemaVersion === "number" ? source.schemaVersion : 1;

  // A file written by a newer build. Its records are read on a best-effort
  // basis and written back at this build's version, which is lossy — but the
  // alternative is an administrator who downgraded losing their history
  // silently, and every field here is additive so far.
  const records: LocalFeedbackRecord[] = [];
  const rawRecords = Array.isArray(source.records) ? source.records : [];
  for (const entry of rawRecords) {
    const record = LocalFeedbackRecordSchema.safeParse(entry);
    if (record.success) records.push(record.data);
  }

  const state = FeedbackStateSchema.safeParse({
    ...source,
    schemaVersion: Math.min(version, FEEDBACK_STATE_VERSION),
    records,
  });
  return state.success
    ? ensureReporterId(state.data)
    : ensureReporterId(emptyFeedbackState());
}

/**
 * Keeps the file from growing without bound.
 *
 * Anything unfinished is kept whatever its age: a draft and a failed
 * submission are both work the reporter has not seen the end of. Resolved
 * reports are the ones that fall off, oldest first.
 */
export function pruneRecords(
  records: LocalFeedbackRecord[],
  limit = MAX_LOCAL_RECORDS,
): LocalFeedbackRecord[] {
  if (records.length <= limit) return records;

  const unfinished = (record: LocalFeedbackRecord) =>
    record.status === "draft" || record.status === "submission_failed";

  const keep = records.filter(unfinished);
  const rest = records
    .filter((record) => !unfinished(record))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const room = Math.max(0, limit - keep.length);
  const kept = new Set([...keep, ...rest.slice(0, room)]);
  // Original order is preserved so the file does not churn on every write.
  return records.filter((record) => kept.has(record));
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

function stamp(now: Date): string {
  return now.toISOString();
}

/** A brand-new record for something the reporter has started writing. */
export function draftRecord(
  draft: FeedbackDraft,
  now = new Date(),
  localId = newId(),
  projectId = "",
): LocalFeedbackRecord {
  const at = stamp(now);
  return LocalFeedbackRecordSchema.parse({
    localId,
    type: draft.type,
    title: recordTitle(draft),
    createdAt: at,
    updatedAt: at,
    status: "draft",
    projectId,
    draft,
  });
}

/**
 * The records belonging to one project, newest handling aside.
 *
 * Strict equality, including the empty id: a report written on the welcome
 * screen belongs to no project and stays there rather than attaching itself to
 * whichever project happens to open next.
 */
export function recordsForProject(
  records: LocalFeedbackRecord[],
  projectId: string,
): LocalFeedbackRecord[] {
  return records.filter((record) => record.projectId === projectId);
}

/**
 * The title My Reports shows.
 *
 * The same text the issue would get, so a report reads the same before and
 * after it is filed — a list where everything renames itself on submission is
 * a list nobody trusts.
 */
export function recordTitle(draft: FeedbackDraft): string {
  return issueTitle({
    type: draft.type,
    title: draft.title,
    description: draft.description,
  }).slice(0, 200);
}

export function withDraft(
  record: LocalFeedbackRecord,
  draft: FeedbackDraft,
  now = new Date(),
): LocalFeedbackRecord {
  return {
    ...record,
    type: draft.type,
    title: recordTitle(draft),
    draft,
    updatedAt: stamp(now),
  };
}

export function markPending(
  record: LocalFeedbackRecord,
  diagnostics: FeedbackDiagnostics,
  now = new Date(),
): LocalFeedbackRecord {
  return {
    ...record,
    status: "pending",
    diagnostics,
    failureMessage: "",
    failureCode: "",
    updatedAt: stamp(now),
  };
}

/**
 * The report reached GitHub.
 *
 * Attachment bytes are dropped here. They are on the issue now, and a
 * base64 screenshot kept in a local file forever is megabytes of duplicate
 * that nothing will ever read.
 */
export function markSubmitted(
  record: LocalFeedbackRecord,
  issue: { issueNumber: number; issueUrl: string },
  issueState: IssueState | null = null,
  now = new Date(),
): LocalFeedbackRecord {
  const at = stamp(now);
  return {
    ...record,
    status: "submitted",
    github: issue,
    lastKnownIssueState: issueState,
    lastSyncedAt: issueState ? at : "",
    draft: record.draft ? stripAttachmentBytes(record.draft) : null,
    failureMessage: "",
    failureCode: "",
    updatedAt: at,
  };
}

/** The reporter said an existing issue was theirs, so nothing new was filed. */
export function markLinked(
  record: LocalFeedbackRecord,
  issue: { issueNumber: number; issueUrl: string },
  issueState: IssueState | null = null,
  now = new Date(),
): LocalFeedbackRecord {
  const at = stamp(now);
  return {
    ...record,
    status: "linked_existing",
    github: issue,
    lastKnownIssueState: issueState,
    lastSyncedAt: issueState ? at : "",
    draft: record.draft ? stripAttachmentBytes(record.draft) : null,
    failureMessage: "",
    failureCode: "",
    updatedAt: at,
  };
}

/**
 * Submission failed. The record survives, with everything needed to retry.
 *
 * The message stored is the one the reporter was shown, not the technical
 * detail — when they come back to this tomorrow they should read the same
 * sentence they read when it happened.
 */
export function markFailed(
  record: LocalFeedbackRecord,
  message: string,
  code = "",
  now = new Date(),
): LocalFeedbackRecord {
  return {
    ...record,
    status: "submission_failed",
    failureMessage: message.slice(0, 400),
    failureCode: code.slice(0, 40),
    updatedAt: stamp(now),
  };
}

export function withIssueState(
  record: LocalFeedbackRecord,
  issueState: IssueState,
  now = new Date(),
): LocalFeedbackRecord {
  return {
    ...record,
    lastKnownIssueState: issueState,
    lastSyncedAt: stamp(now),
    updatedAt: stamp(now),
  };
}

function stripAttachmentBytes(draft: FeedbackDraft): FeedbackDraft {
  if (draft.attachments.length === 0) return draft;
  return {
    ...draft,
    attachments: draft.attachments.map((attachment) => ({
      ...attachment,
      dataB64: "",
    })),
  };
}

/** Replaces one record in the list, or appends it when it is new. */
export function upsertRecord(
  records: LocalFeedbackRecord[],
  record: LocalFeedbackRecord,
): LocalFeedbackRecord[] {
  const at = records.findIndex((existing) => existing.localId === record.localId);
  if (at === -1) return [...records, record];
  const next = [...records];
  next[at] = record;
  return next;
}

export function removeRecord(
  records: LocalFeedbackRecord[],
  localId: string,
): LocalFeedbackRecord[] {
  return records.filter((record) => record.localId !== localId);
}

/** Statuses a reporter may retry from. */
export function canRetry(status: FeedbackStatus): boolean {
  return status === "submission_failed" || status === "draft";
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** GitHub's own username rule, so a contact that cannot exist is refused here. */
const GITHUB_USERNAME = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

export interface DraftProblem {
  field:
    | "title"
    | "description"
    | "expectedBehavior"
    | "reproductionSteps"
    | "benefit"
    | "contact"
    | "attachments";
  message: string;
  kind?: "credential";
}

/** How much text makes a report worth a maintainer's time to read. */
export const MIN_DESCRIPTION = 10;

/**
 * What still needs filling in.
 *
 * A list rather than a boolean so the form can point at the field, and so the
 * Submit button can explain why it is disabled instead of just being disabled.
 */
export function validateDraft(draft: FeedbackDraft): DraftProblem[] {
  const problems: DraftProblem[] = [];

  // Only feature requests ask for a title. A bug and a suggestion take theirs
  // from the first sentence of what the reporter wrote, which is one less box
  // between noticing a problem and reporting it.
  if (draft.type === "feature_request" && draft.title.trim().length < 3) {
    problems.push({ field: "title", message: "Give the feature a short name." });
  }
  if (draft.description.trim().length < MIN_DESCRIPTION) {
    problems.push({
      field: "description",
      message: "Add a sentence or two describing it.",
    });
  }

  const contact = draft.contact.trim();
  if (contact) {
    if (contact.includes("@") && !contact.startsWith("@")) {
      problems.push({
        field: "contact",
        message: "Use a GitHub username. An email address here would be published.",
      });
    } else if (!GITHUB_USERNAME.test(contact.replace(/^@/, ""))) {
      problems.push({ field: "contact", message: "That is not a GitHub username." });
    }
  }

  if (draft.attachments.some((attachment) => !attachment.dataB64 && !attachment.url)) {
    problems.push({ field: "attachments", message: "An attachment failed to load." });
  }
  if (draft.attachments.length > FEEDBACK_CONFIG.maxAttachments) {
    problems.push({
      field: "attachments",
      message: `Attach no more than ${FEEDBACK_CONFIG.maxAttachments} images.`,
    });
  } else if (
    draft.attachments.some(
      (attachment) => attachment.sizeBytes > FEEDBACK_CONFIG.maxAttachmentBytes,
    )
  ) {
    problems.push({
      field: "attachments",
      message: "Remove the attachment that is over the size limit.",
    });
  }

  problems.push(...credentialProblems(draft));

  return problems;
}

/** Public text fields that contain something credential-shaped. */
export function credentialProblems(draft: FeedbackDraft): DraftProblem[] {
  const fields: Array<
    [DraftProblem["field"], string]
  > = [
    ["title", draft.title],
    ["description", draft.description],
    ["expectedBehavior", draft.expectedBehavior],
    ["reproductionSteps", draft.reproductionSteps],
    ["benefit", draft.benefit],
  ];
  return fields
    .filter(([, value]) => containsCredentialLikeText(value))
    .map(([field]) => ({
      field,
      kind: "credential" as const,
      message:
        "Remove the credential or secret from this field. Reports are public.",
    }));
}

export function isSubmittable(draft: FeedbackDraft): boolean {
  return validateDraft(draft).length === 0;
}

// ---------------------------------------------------------------------------
// Building the payload
// ---------------------------------------------------------------------------

/**
 * The report as it will be sent.
 *
 * The id comes from the local record so a retry carries the id the first
 * attempt used — that identity is the whole idempotency story, and generating
 * a fresh one here would turn every timeout into a duplicate issue.
 */
export function reportFrom(
  record: LocalFeedbackRecord,
  draft: FeedbackDraft,
  diagnostics: FeedbackDiagnostics,
  reporterId: string,
  appVersion: string,
): FeedbackReport {
  return {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: record.localId,
    type: draft.type,
    title: recordTitle(draft),
    description: draft.description.trim(),
    expectedBehavior: draft.expectedBehavior.trim(),
    reproductionSteps: draft.reproductionSteps.trim(),
    benefit: draft.benefit.trim(),
    severity: draft.type === "bug" ? draft.severity : null,
    // The affected-area picker is component diagnostics too. Keeping it when
    // the reporter switched that category off would make the toggle cosmetic.
    target: draft.diagnosticChoices.component ? draft.target : null,
    diagnostics,
    attachments: draft.attachments,
    contact: draft.contact.trim().replace(/^@/, ""),
    createdAt: record.createdAt,
    appVersion,
    reporterId,
    submissionSource: FEEDBACK_SOURCE,
  };
}
