import { badRequest } from "../http";
import {
  DuplicateRequestSchema,
  FEEDBACK_SCHEMA_VERSION,
  IssueLookupRequestSchema,
  MAX_FEEDBACK_ATTACHMENTS,
  SubmitRequestSchema,
  containsCredentialLikeText,
  type FeedbackReport,
} from "../shared";

/**
 * Everything arriving from the network, checked before it is used.
 *
 * The schemas are the application's own - the same declarations the desktop
 * app builds its payloads from - so "the client and the server disagree about
 * the shape" is not a class of bug that can exist here.
 *
 * What this module adds on top is the things a schema cannot say: that a
 * report is not so long that filing it would be abusive, and that its version
 * is one this deployment understands.
 */

/** Report payload versions this deployment accepts. */
export const ACCEPTED_SCHEMA_VERSIONS = [FEEDBACK_SCHEMA_VERSION];

/**
 * Ceilings on the parts a schema allows to be long.
 *
 * Zod already caps each field. These are the totals, which is the number that
 * matters for an issue nobody can read and a repository nobody wants - a
 * report at every field's individual maximum would be twenty thousand words.
 */
const MAX_TOTAL_TEXT = 20000;

function fail(detail: string): never {
  throw badRequest(detail);
}

/**
 * A submission.
 *
 * Zod's error text is not passed through. It names paths and expected types,
 * which is useful in a log and confusing in a dialog, and the client has
 * already validated the same shape - anything reaching here malformed is a
 * mismatch or a script, and neither benefits from the detail.
 */
export function parseSubmit(body: unknown): FeedbackReport {
  const parsed = SubmitRequestSchema.safeParse(body);
  if (!parsed.success) fail("That report was not in a form this service understands.");

  const report = parsed.data.report;
  if (!ACCEPTED_SCHEMA_VERSIONS.includes(report.schemaVersion)) {
    fail("That report came from a version of DinoDepot Studio this service does not support.");
  }
  if (report.submissionSource !== "dinodepot-studio") {
    fail("That report did not come from DinoDepot Studio.");
  }

  const totalText =
    report.title.length +
    report.description.length +
    report.expectedBehavior.length +
    report.reproductionSteps.length +
    report.benefit.length;
  if (totalText > MAX_TOTAL_TEXT) {
    fail("That report is longer than this service accepts.");
  }
  if (report.attachments.length > MAX_FEEDBACK_ATTACHMENTS) {
    fail("A report may carry at most three attachments.");
  }
  if (!report.description.trim()) {
    fail("A report needs a description.");
  }
  // Check the complete parsed payload, not only the form fields. Current
  // clients sanitize target labels and logs too, but the service must also be
  // safe when an older or modified client sends those fields directly.
  if (containsCredentialLikeText(JSON.stringify(report))) {
    fail("Remove credentials, access tokens, or private keys before sending this report.");
  }

  return report;
}

export function parseDuplicateQuery(body: unknown) {
  const parsed = DuplicateRequestSchema.safeParse(body);
  if (!parsed.success) fail("That search was not in a form this service understands.");
  return parsed.data;
}

export function parseIssueLookup(body: unknown) {
  const parsed = IssueLookupRequestSchema.safeParse(body);
  if (!parsed.success) {
    fail("Ask for between one and fifty issue numbers.");
  }
  return parsed.data;
}

/** An issue number from a path segment. */
export function parseIssueNumber(segment: string): number {
  const number = Number.parseInt(segment, 10);
  if (!Number.isSafeInteger(number) || number <= 0) {
    fail("That is not an issue number.");
  }
  return number;
}
