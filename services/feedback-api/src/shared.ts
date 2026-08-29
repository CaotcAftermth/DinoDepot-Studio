/**
 * The pieces this service shares with the desktop application.
 *
 * One file holds the relative paths, so the layout of the repository is a
 * one-line problem rather than something spread through every module here.
 *
 * Sharing rather than reimplementing is the point. The issue formatter in
 * particular has to produce byte-identical output on both sides: the app uses
 * it for the "open a prepared issue" fallback and this service uses it for the
 * real thing, and two copies would drift within a release - leaving reports
 * that look different depending on whether the network happened to be up.
 *
 * Everything imported here is free of runtime dependencies apart from Zod,
 * which this service uses for validation anyway.
 */

export {
  FeedbackReportSchema,
  IssueStateSchema,
  type FeedbackReport,
  type FeedbackType,
} from "../../../src/model/feedback/types";

export {
  DuplicateRequestSchema,
  IssueLookupRequestSchema,
  SubmitRequestSchema,
  type DuplicateCandidate,
  type IssueSummary,
} from "../../../src/model/feedback/wire";

export {
  findReportMarker,
  issueBody,
  issueTitle,
  markerSearchTerm,
} from "../../../src/model/feedback/issue";

export { labelsForReport, MANAGED_LABELS } from "../../../src/model/feedback/labels";

export {
  duplicateQueries,
  type DuplicateSubject,
} from "../../../src/model/feedback/duplicates";

export {
  FEEDBACK_SCHEMA_VERSION,
  MAX_FEEDBACK_ATTACHMENTS,
} from "../../../src/model/feedback/config";

export { containsCredentialLikeText } from "../../../src/model/feedback/log";
