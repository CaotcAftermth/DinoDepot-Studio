import { z } from "zod";
import {
  FEEDBACK_SCHEMA_VERSION,
  FEEDBACK_SOURCE,
  MAX_FEEDBACK_ATTACHMENT_BYTES,
  MAX_FEEDBACK_ATTACHMENTS,
} from "./config";
import { sanitizeTargetContext } from "./targets";

/**
 * The shape of everything the Feedback Center stores or sends.
 *
 * Two payloads live here and they are deliberately different. A
 * {@link FeedbackReport} is what leaves the machine: user text, an allowlisted
 * diagnostic bundle, nothing else. A {@link LocalFeedbackRecord} is what stays:
 * the report plus where it got to, so a failed submission is still on disk to
 * retry and My Reports has something to list.
 *
 * Both are versioned. The report is versioned because a service has to keep
 * accepting reports from installations nobody has updated; the local file is
 * versioned because a stored record outlives the build that wrote it.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const FEEDBACK_TYPES = ["bug", "suggestion", "feature_request"] as const;
export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPES);
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/**
 * Severity is the reporter's judgement, not a triage decision.
 *
 * Carried into the issue exactly as it was set, because the person who hit the
 * problem is the only one who knows whether it stopped them working.
 */
export const BUG_SEVERITIES = ["minor", "moderate", "major", "blocking"] as const;
export const BugSeveritySchema = z.enum(BUG_SEVERITIES);
export type BugSeverity = (typeof BUG_SEVERITIES)[number];

export const SEVERITY_LABELS: Record<BugSeverity, string> = {
  minor: "Minor",
  moderate: "Moderate",
  major: "Major",
  blocking: "Blocking",
};

/** One line each, so the picker does not need a legend beside it. */
export const SEVERITY_HINTS: Record<BugSeverity, string> = {
  minor: "Cosmetic, or easy to work around.",
  moderate: "Gets in the way, but there is another route.",
  major: "A part of the app is unusable.",
  blocking: "Cannot carry on working at all.",
};

export const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Bug",
  suggestion: "Suggestion",
  feature_request: "Feature Request",
};

// ---------------------------------------------------------------------------
// The component a report is about
// ---------------------------------------------------------------------------

/**
 * The part of the interface a report points at, captured when the reporter
 * chose it.
 *
 * A snapshot rather than a live reference: by the time the issue is read the
 * component may have been renamed or removed, and the id is what keeps the
 * report findable either way.
 */
export const FeedbackTargetSnapshotSchema = z.object({
  /** Stable kebab-case component id from the registry. */
  id: z.string().min(1).max(80),
  /** Friendly name, as it read when the report was made. */
  name: z.string().min(1).max(120),
  /** Area slug, e.g. `production-rules`. */
  area: z.string().max(60).default(""),
  /**
   * Friendly names from the outermost target down to this one, so an issue can
   * say "Production Rules › Creature Rule › Quantity" without the reader
   * needing the component tree in front of them.
   */
  hierarchy: z.array(z.string().max(120)).max(8).default([]),
  /**
   * Extra context the component chose to expose, already through the
   * allowlist. Short strings only; nothing is serialized blindly.
   */
  context: z
    .record(z.string(), z.string())
    .default({})
    // Parse-time sanitization is also a service boundary: an older client may
    // still send legacy entity-name keys even though current call sites do not.
    .transform(sanitizeTargetContext),
});
export type FeedbackTargetSnapshot = z.infer<typeof FeedbackTargetSnapshotSchema>;

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export const LOG_LEVELS = ["info", "warn", "error"] as const;
export const LogLevelSchema = z.enum(LOG_LEVELS);
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * A log line that has already been through the sanitizer.
 *
 * A distinct type from the raw entry on purpose, so a raw one cannot reach the
 * report builder by accident.
 */
export const SanitizedLogEntrySchema = z.object({
  at: z.string().max(40).default(""),
  level: LogLevelSchema.default("info"),
  /** Which part of the app wrote it, e.g. `sync` or `publish`. */
  scope: z.string().max(40).default(""),
  message: z.string().max(400).default(""),
  /** StudioErrorCode, when the entry came from a failure. */
  code: z.string().max(40).default(""),
});
export type SanitizedLogEntry = z.infer<typeof SanitizedLogEntrySchema>;

/**
 * Facts about the project that carry no project content.
 *
 * Counts and schema numbers only — never a project name, a cluster name, a
 * repository slug, a path, or anything an administrator typed. A cluster's
 * name is not ours to publish, and a count is enough to know whether a bug
 * needs a large project to reproduce.
 */
export const ProjectDiagnosticsSchema = z.object({
  schemaVersion: z.number().int().nonnegative().default(0),
  projectFormat: z.string().max(40).default(""),
  ruleCount: z.number().int().nonnegative().default(0),
  creatureCount: z.number().int().nonnegative().default(0),
  itemCount: z.number().int().nonnegative().default(0),
  mapCount: z.number().int().nonnegative().default(0),
  sourceCount: z.number().int().nonnegative().default(0),
  /** Package ids and versions installed, e.g. `official-asa@1.3.0`. */
  packages: z.array(z.string().max(80)).max(30).default([]),
});
export type ProjectDiagnostics = z.infer<typeof ProjectDiagnosticsSchema>;

export const FeedbackDiagnosticsSchema = z.object({
  app: z.object({
    version: z.string().max(40).default(""),
    /** `desktop`, or `browser` for the mock build used for interface work. */
    runtime: z.enum(["desktop", "browser"]).default("desktop"),
  }),
  environment: z.object({
    os: z.string().max(60).default(""),
    osVersion: z.string().max(60).default(""),
    architecture: z.string().max(30).default(""),
    /** Webview engine and version — the usual suspect for a rendering bug. */
    webview: z.string().max(80).default(""),
    /** Window size, which layout bugs almost always depend on. */
    viewport: z.string().max(20).default(""),
  }),
  navigation: z.object({
    /** Route with dynamic segments left as parameters, e.g. `/production/:ruleId`. */
    route: z.string().max(120).default(""),
    /** The page's friendly name. */
    page: z.string().max(80).default(""),
  }),
  component: FeedbackTargetSnapshotSchema.nullable().default(null),
  project: ProjectDiagnosticsSchema.nullable().default(null),
  logs: z.array(SanitizedLogEntrySchema).max(200).default([]),
});
export type FeedbackDiagnostics = z.infer<typeof FeedbackDiagnosticsSchema>;

/**
 * The categories an administrator can switch off before submitting.
 *
 * `project` starts off, because it is the only category that describes the
 * administrator's own work rather than the application.
 */
export const DiagnosticChoicesSchema = z.object({
  app: z.boolean().default(true),
  component: z.boolean().default(true),
  logs: z.boolean().default(true),
  project: z.boolean().default(false),
});
export type DiagnosticChoices = z.infer<typeof DiagnosticChoicesSchema>;

export function defaultDiagnosticChoices(): DiagnosticChoices {
  return DiagnosticChoicesSchema.parse({});
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

/** Images only: an attachment is evidence of what the screen looked like. */
export const ATTACHMENT_TYPES = ["image/png", "image/webp", "image/jpeg"] as const;
export const AttachmentTypeSchema = z.enum(ATTACHMENT_TYPES);
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

export const FeedbackAttachmentSchema = z.object({
  id: z.string().min(1).max(80),
  /** Display name only. Never a path — a path names the reporter's machine. */
  fileName: z.string().min(1).max(120),
  contentType: AttachmentTypeSchema,
  sizeBytes: z.number().int().positive().max(MAX_FEEDBACK_ATTACHMENT_BYTES),
  /** Base64 payload. Dropped from the record once the attachment has a URL. */
  dataB64: z
    .string()
    // Four base64 characters carry three bytes. The small allowance covers
    // padding without permitting a claimed one-byte image to carry megabytes.
    .max(Math.ceil(MAX_FEEDBACK_ATTACHMENT_BYTES / 3) * 4 + 4)
    .default(""),
  /** Where the attachment ended up, once a store has taken it. */
  url: z.string().max(500).default(""),
});
export type FeedbackAttachment = z.infer<typeof FeedbackAttachmentSchema>;

// ---------------------------------------------------------------------------
// What the reporter wrote
// ---------------------------------------------------------------------------

/**
 * The editable half of a report.
 *
 * Separate from the envelope so a draft can be saved, reopened and edited
 * without its identity, timestamps or diagnostics being rewritten each time.
 */
export const FeedbackDraftSchema = z.object({
  type: FeedbackTypeSchema,
  /** One line. Becomes the issue title, after a prefix. */
  title: z.string().max(160).default(""),
  /** Bug: what happened. Suggestion: what could be better. Feature: what it should do. */
  description: z.string().max(8000).default(""),
  /** Bug: what should have happened. Unused by the other two. */
  expectedBehavior: z.string().max(4000).default(""),
  reproductionSteps: z.string().max(4000).default(""),
  /** Suggestion: how to improve it. Feature: why it would be useful. */
  benefit: z.string().max(4000).default(""),
  severity: BugSeveritySchema.nullable().default(null),
  target: FeedbackTargetSnapshotSchema.nullable().default(null),
  /**
   * Optional GitHub username, for a maintainer who needs to ask something.
   *
   * A username and nothing else. There is no private metadata store behind
   * this, so whatever goes in here is published in the issue — and an email
   * address in a public issue is a mailing list subscription the reporter
   * never asked for.
   */
  contact: z.string().max(40).default(""),
  attachments: z
    .array(FeedbackAttachmentSchema)
    .max(MAX_FEEDBACK_ATTACHMENTS)
    .default([]),
  diagnosticChoices: DiagnosticChoicesSchema.default(defaultDiagnosticChoices),
});
export type FeedbackDraft = z.infer<typeof FeedbackDraftSchema>;

export function emptyDraft(type: FeedbackType): FeedbackDraft {
  return FeedbackDraftSchema.parse({ type });
}

// ---------------------------------------------------------------------------
// What gets sent
// ---------------------------------------------------------------------------

export const FeedbackReportSchema = z.object({
  schemaVersion: z
    .literal(FEEDBACK_SCHEMA_VERSION)
    .default(FEEDBACK_SCHEMA_VERSION),
  /**
   * Generated once, on the client, before the first submission attempt.
   *
   * Doubles as the idempotency key: a retry after a timeout carries the same
   * id, and the service uses it to recognise a report it already filed rather
   * than filing it twice.
   */
  id: z.string().min(8).max(80),
  type: FeedbackTypeSchema,
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(8000),
  expectedBehavior: z.string().max(4000).default(""),
  reproductionSteps: z.string().max(4000).default(""),
  benefit: z.string().max(4000).default(""),
  severity: BugSeveritySchema.nullable().default(null),
  target: FeedbackTargetSnapshotSchema.nullable().default(null),
  diagnostics: FeedbackDiagnosticsSchema,
  attachments: z
    .array(FeedbackAttachmentSchema)
    .max(MAX_FEEDBACK_ATTACHMENTS)
    .default([]),
  contact: z.string().max(40).default(""),
  createdAt: z.string().min(1).max(40),
  appVersion: z.string().max(40).default(""),
  /**
   * Anonymous, locally generated, and the only thing tying two reports to one
   * installation. Not derived from any hardware or account identifier.
   */
  reporterId: z.string().max(80).default(""),
  submissionSource: z.literal(FEEDBACK_SOURCE).default(FEEDBACK_SOURCE),
});
export type FeedbackReport = z.infer<typeof FeedbackReportSchema>;

// ---------------------------------------------------------------------------
// What stays on this machine
// ---------------------------------------------------------------------------

export const FEEDBACK_STATUSES = [
  "draft",
  "pending",
  "submitted",
  "linked_existing",
  "submission_failed",
] as const;
export const FeedbackStatusSchema = z.enum(FEEDBACK_STATUSES);
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const IssueStateSchema = z.object({
  state: z.enum(["open", "closed"]).default("open"),
  labels: z.array(z.string().max(60)).max(30).default([]),
  milestone: z.string().max(80).default(""),
  updatedAt: z.string().max(40).default(""),
  title: z.string().max(200).default(""),
});
export type IssueState = z.infer<typeof IssueStateSchema>;

export const LocalFeedbackRecordSchema = z.object({
  /** Identity of the record, and the report id once one has been sent. */
  localId: z.string().min(1).max(80),
  type: FeedbackTypeSchema,
  title: z.string().max(200).default(""),
  createdAt: z.string().max(40).default(""),
  updatedAt: z.string().max(40).default(""),
  status: FeedbackStatusSchema.default("draft"),
  /**
   * The project that was open when the report was written, or "" for one
   * written with no project open.
   *
   * The file itself stays machine-local — a bug report is about the
   * application, and filing it into the project would synchronize one
   * administrator's complaints to everybody else on the cluster. This is only
   * about what My Reports *lists*: a report written while working on one
   * cluster is not part of the next one's history, and mixing them made the
   * list read as somebody else's.
   *
   * Defaulted, so records written before this existed load as "no project"
   * rather than failing the schema.
   */
  projectId: z.string().max(80).default(""),
  /**
   * Everything the reporter entered, kept so a failed submission can be
   * retried or edited rather than retyped.
   *
   * Attachment bytes are dropped once a submission succeeds — there is no
   * reason to keep a copy of a screenshot that is already on the issue.
   */
  draft: FeedbackDraftSchema.nullable().default(null),
  /** The exact bundle that was sent, so a retry cannot quietly send something else. */
  diagnostics: FeedbackDiagnosticsSchema.nullable().default(null),
  github: z
    .object({
      issueNumber: z.number().int().positive(),
      issueUrl: z.string().max(300),
    })
    .nullable()
    .default(null),
  lastKnownIssueState: IssueStateSchema.nullable().default(null),
  lastSyncedAt: z.string().max(40).default(""),
  /** Why the last submission failed, in the words the reporter was shown. */
  failureMessage: z.string().max(400).default(""),
  /** StudioErrorCode of that failure, so a retry can tell offline from refused. */
  failureCode: z.string().max(40).default(""),
});
export type LocalFeedbackRecord = z.infer<typeof LocalFeedbackRecordSchema>;

/** How many records the local file keeps. Oldest resolved ones fall off first. */
export const MAX_LOCAL_RECORDS = 200;

export const FEEDBACK_STATE_VERSION = 1;

export const FeedbackStateSchema = z.object({
  /** Bumped when this file's shape changes; see `migrateFeedbackState`. */
  schemaVersion: z.number().int().positive().default(FEEDBACK_STATE_VERSION),
  /** `dd-install-<uuid>`. Generated on first use, never derived from the machine. */
  reporterId: z.string().max(80).default(""),
  records: z.array(LocalFeedbackRecordSchema).max(MAX_LOCAL_RECORDS).default([]),
  /** When My Reports last refreshed from the service. */
  lastSyncAt: z.string().max(40).default(""),
  /** The administrator's own configuration overrides. */
  settings: z
    .object({
      enabled: z.boolean().default(true),
      apiBaseUrl: z.string().max(300).default(""),
    })
    .default({ enabled: true, apiBaseUrl: "" }),
});
export type FeedbackState = z.infer<typeof FeedbackStateSchema>;

export function emptyFeedbackState(): FeedbackState {
  return FeedbackStateSchema.parse({ schemaVersion: FEEDBACK_STATE_VERSION });
}
