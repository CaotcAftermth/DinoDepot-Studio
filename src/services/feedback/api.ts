import { ipc } from "../ipc";
import {
  StudioError,
  asStudioError,
  STUDIO_ERROR_CODES,
  type StudioErrorCode,
} from "../../model/errors";
import { apiEndpoint, canSubmitDirectly, type FeedbackConfig } from "../../model/feedback/config";
import { FEEDBACK_SCOPE, studioLog } from "../../model/feedback/log";
import {
  DuplicateResponseSchema,
  FEEDBACK_ROUTES,
  HealthResponseSchema,
  IssueLookupResponseSchema,
  SubmitResponseSchema,
  type DuplicateRequest,
  type DuplicateResponse,
  type HealthResponse,
  type IssueLookupResponse,
  type IssueSummary,
  type SubmitResponse,
} from "../../model/feedback/wire";
import type { FeedbackReport } from "../../model/feedback/types";

/**
 * The client for the DinoDepot Feedback service.
 *
 * Every request goes out through Rust. That is not indirection for its own
 * sake — the desktop build's content security policy has no external
 * `connect-src`, so the webview cannot open a connection at all. The practical
 * effect is the one worth having: the code that renders untrusted project
 * content is not the code that talks to the network.
 *
 * Nothing here authenticates. The service files issues as a GitHub App using a
 * key that never leaves it, and this client sends a report and reads an
 * answer. There is no token to leak because there is no token.
 */

interface RawResponse {
  status: number;
  body: string;
}

const KNOWN_CODES = new Set<string>(STUDIO_ERROR_CODES);

/**
 * Turns a rejection from Rust into a StudioError.
 *
 * The same decoding the Git layer does, for the same reason: the caller needs
 * to tell "you are offline, and your report is safe on disk" from "the service
 * refused this report" without matching on English.
 */
function decodeFailure(error: unknown, fallback: string): StudioError {
  const text = error instanceof Error ? error.message : String(error ?? "");
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
      const code: StudioErrorCode = KNOWN_CODES.has(parsed.code)
        ? (parsed.code as StudioErrorCode)
        : "unknown";
      return new StudioError(code, String(parsed.message || fallback), {
        detail: typeof parsed.detail === "string" ? parsed.detail : "",
      });
    }
  } catch {
    /* not one of ours */
  }
  return asStudioError(error, "network.offline", fallback);
}

function notConfigured(): StudioError {
  return new StudioError(
    "unknown",
    "No feedback service is set up for this build, so reports cannot be sent directly.",
    { detail: "feedback.apiBaseUrl is empty" },
  );
}

async function request<T>(
  config: FeedbackConfig,
  path: string,
  method: "GET" | "POST",
  body: unknown,
  schema: { parse(value: unknown): T },
  fallback: string,
): Promise<T> {
  if (!canSubmitDirectly(config)) throw notConfigured();
  const endpoint = apiEndpoint(config, path);
  const serializedBody = body === undefined ? null : JSON.stringify(body);
  if (
    serializedBody !== null &&
    new TextEncoder().encode(serializedBody).byteLength > config.maxPayloadBytes
  ) {
    throw new StudioError(
      "validation.failed",
      "That report is too large to send. Remove an attachment and try again.",
      { detail: `Feedback payload exceeded ${config.maxPayloadBytes} bytes` },
    );
  }

  let raw: RawResponse;
  try {
    raw = await ipc<RawResponse>("feedback_api_request", {
      baseUrl: config.apiBaseUrl,
      path,
      method,
      body: serializedBody,
    });
  } catch (error) {
    const failure = decodeFailure(error, fallback);
    studioLog.error(FEEDBACK_SCOPE, `${method} ${path} failed: ${failure.message}`, failure.code);
    throw failure;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.body || "{}");
  } catch {
    throw new StudioError("unknown", fallback, {
      detail: `${endpoint} returned something that is not JSON`,
    });
  }

  const result = schemaSafeParse(schema, parsed);
  if (!result.ok) {
    throw new StudioError("unknown", fallback, {
      detail: `${endpoint} returned an unexpected shape: ${result.detail}`,
    });
  }
  return result.value;
}

/** `parse` in a try, so a schema mismatch is a StudioError like everything else. */
function schemaSafeParse<T>(
  schema: { parse(value: unknown): T },
  value: unknown,
): { ok: true; value: T } | { ok: false; detail: string } {
  try {
    return { ok: true, value: schema.parse(value) };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    };
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Files the report.
 *
 * The report id is the idempotency key, and it is inside the payload rather
 * than in a header so it survives every hop without depending on anything
 * preserving headers. A retry that carries the same id gets back the issue the
 * first attempt filed, with `alreadyFiled` set.
 */
export async function submitReport(
  config: FeedbackConfig,
  report: FeedbackReport,
): Promise<SubmitResponse> {
  return request(
    config,
    FEEDBACK_ROUTES.submit,
    "POST",
    { report },
    SubmitResponseSchema,
    "Your report could not be sent.",
  );
}

/**
 * Looks for issues that may already cover this.
 *
 * Failure here is not failure of anything: the caller treats an error as "no
 * candidates" and carries on to the submit step. Nobody should be stopped from
 * reporting a bug because a search timed out.
 */
export async function searchDuplicates(
  config: FeedbackConfig,
  query: DuplicateRequest,
): Promise<DuplicateResponse> {
  return request(
    config,
    FEEDBACK_ROUTES.duplicates,
    "POST",
    query,
    DuplicateResponseSchema,
    "Could not check for existing reports.",
  );
}

/** The current state of issues this installation has filed. */
export async function lookupIssues(
  config: FeedbackConfig,
  numbers: number[],
): Promise<IssueSummary[]> {
  if (numbers.length === 0) return [];
  const response = await request<IssueLookupResponse>(
    config,
    FEEDBACK_ROUTES.issueLookup,
    "POST",
    // Capped to the service's own limit, so a long history produces several
    // requests rather than one the service refuses.
    { numbers: numbers.slice(0, 50) },
    IssueLookupResponseSchema,
    "Could not refresh your reports.",
  );
  return response.issues;
}

/** Whether the configured service is reachable and pointed at the right repository. */
export async function checkHealth(config: FeedbackConfig): Promise<HealthResponse> {
  return request(
    config,
    FEEDBACK_ROUTES.health,
    "GET",
    undefined,
    HealthResponseSchema,
    "The feedback service did not answer.",
  );
}
