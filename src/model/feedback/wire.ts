import { z } from "zod";
import { FeedbackReportSchema, IssueStateSchema } from "./types";

/**
 * The contract between the desktop app and the feedback service.
 *
 * One module, imported by both. The service validates incoming requests with
 * the same schemas the app builds them from, which is the only arrangement
 * where "the client and the server disagree about the payload" is a type
 * error rather than a support ticket.
 *
 * Responses are parsed on the way in as strictly as requests are on the way
 * out. The service is trusted to be honest, but it is still something on the
 * far side of a network, and a malformed response must produce a clear failure
 * rather than an `undefined` three call frames later.
 */

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const FEEDBACK_ROUTES = {
  health: "/api/health",
  submit: "/api/feedback",
  duplicates: "/api/feedback/search-duplicates",
  /** One issue, by number. */
  issue: (number: number) => `/api/feedback/issues/${number}`,
  /**
   * Several issues at once.
   *
   * There is deliberately no "list everything this installation reported"
   * endpoint. Answering that would mean the service keeping a record of who
   * filed what — a database of report-to-installation mappings that does not
   * otherwise need to exist. The app already knows its own issue numbers, so
   * it asks about those, and the service stores nothing.
   */
  issueLookup: "/api/feedback/issues/lookup",
} as const;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** `POST /api/feedback`. The report itself, unchanged. */
export const SubmitRequestSchema = z.object({
  report: FeedbackReportSchema,
});
export type SubmitRequest = z.infer<typeof SubmitRequestSchema>;

/**
 * `POST /api/feedback/search-duplicates`.
 *
 * Only what the search needs. Sending the whole report to look for duplicates
 * would mean the diagnostics — and any attachment — travelling for a query the
 * reporter has not yet decided to submit.
 */
export const DuplicateRequestSchema = z.object({
  type: FeedbackReportSchema.shape.type,
  title: z.string().max(200),
  description: z.string().max(2000),
  componentId: z.string().max(80).default(""),
  area: z.string().max(60).default(""),
});
export type DuplicateRequest = z.infer<typeof DuplicateRequestSchema>;

/** `POST /api/feedback/issues/lookup`. */
export const IssueLookupRequestSchema = z.object({
  numbers: z.array(z.number().int().positive()).min(1).max(50),
});
export type IssueLookupRequest = z.infer<typeof IssueLookupRequestSchema>;

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export const IssueSummarySchema = z.object({
  number: z.number().int().positive(),
  url: z.string().max(300),
  title: z.string().max(300).default(""),
  state: z.enum(["open", "closed"]).default("open"),
  labels: z.array(z.string().max(60)).max(30).default([]),
  milestone: z.string().max(80).default(""),
  updatedAt: z.string().max(40).default(""),
});
export type IssueSummary = z.infer<typeof IssueSummarySchema>;

export const SubmitResponseSchema = z.object({
  issue: IssueSummarySchema,
  /**
   * True when the service recognised this report id and returned the issue it
   * had already filed instead of creating a second one.
   *
   * Reported rather than hidden: a retry that quietly succeeds looks identical
   * to a first submission, and the reporter should know which happened.
   */
  alreadyFiled: z.boolean().default(false),
  /** Labels the repository did not have, so nothing looks silently missing. */
  missingLabels: z.array(z.string().max(60)).max(20).default([]),
});
export type SubmitResponse = z.infer<typeof SubmitResponseSchema>;

export const DuplicateCandidateSchema = z.object({
  number: z.number().int().positive(),
  title: z.string().max(300).default(""),
  /** Opening of the body only — enough to score against, not the whole issue. */
  body: z.string().max(2000).default(""),
  state: z.enum(["open", "closed"]).default("open"),
  labels: z.array(z.string().max(60)).max(30).default([]),
  url: z.string().max(300).default(""),
  updatedAt: z.string().max(40).default(""),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

export const DuplicateResponseSchema = z.object({
  candidates: z.array(DuplicateCandidateSchema).max(30).default([]),
});
export type DuplicateResponse = z.infer<typeof DuplicateResponseSchema>;

export const IssueLookupResponseSchema = z.object({
  issues: z.array(IssueSummarySchema).max(50).default([]),
});
export type IssueLookupResponse = z.infer<typeof IssueLookupResponseSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  /** `owner/repo` the service files into, so a misconfiguration is visible. */
  repository: z.string().max(120).default(""),
  /** Report schema versions this deployment understands. */
  accepts: z.array(z.number().int().positive()).max(10).default([]),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** The shape every failure from the service takes. */
export const ApiErrorSchema = z.object({
  error: z.string().max(80),
  message: z.string().max(400).default(""),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// ---------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------

/** An issue summary as the local record stores it. */
export function issueStateFrom(summary: IssueSummary) {
  return IssueStateSchema.parse({
    state: summary.state,
    labels: summary.labels,
    milestone: summary.milestone,
    updatedAt: summary.updatedAt,
    title: summary.title,
  });
}
