/**
 * The one vocabulary of failures the app speaks.
 *
 * Every operation that can fail — a save, a fetch, a push, a migration —
 * resolves to one of these codes rather than to a string. Two things fall out
 * of that: the UI can say something an admin understands without parsing
 * English out of an error message, and the retry logic can tell "the network
 * blinked" apart from "your token was revoked" without guessing.
 *
 * Messages here are the *user-facing* ones. Anything technical — a status
 * code, a path, a commit sha — belongs in `detail`, which the UI shows only
 * under Advanced Details.
 */

export const STUDIO_ERROR_CODES = [
  // --- local persistence -------------------------------------------------
  /** A file could not be written: disk full, permissions, antivirus. */
  "save.failed",
  /** A project file exists but is not valid JSON, or not the shape expected. */
  "project.corrupt",
  /** Another DinoDepot Studio instance holds this project. */
  "project.locked",
  /** The project's schema is newer than this build understands. */
  "project.schemaTooNew",
  /** A migration could not complete; the original project is untouched. */
  "migration.failed",

  // --- authentication and access ----------------------------------------
  /** No credential stored for the account this project is bound to. */
  "auth.missing",
  /** 401 — the token is invalid or expired. */
  "auth.expired",
  /** 403 — the token is valid but lacks the permission needed. */
  "auth.forbidden",

  // --- repository state --------------------------------------------------
  /** 404 — the repository is gone, or access to it was revoked. */
  "repo.unavailable",
  /** The repository answering is not the one this project is bound to. */
  "repo.identityMismatch",
  /** 409/422 — a ref or repository conflict GitHub refused outright. */
  "repo.conflict",
  /** The push was rejected because the branch moved on. Retryable by design. */
  "repo.nonFastForward",

  // --- transport ---------------------------------------------------------
  /** No connectivity, or DNS failed. */
  "network.offline",
  /** The request took longer than its budget. */
  "network.timeout",
  /** 429 or a secondary rate limit. Carries `retryAfterSeconds` when GitHub says. */
  "network.rateLimited",
  /** 5xx — GitHub's problem, not ours. */
  "network.serverError",

  // --- domain ------------------------------------------------------------
  /** Project validation found blocking errors. */
  "validation.failed",
  /** Unresolved merge conflicts are in the way. */
  "sync.conflictsPending",
  /** Publish was asked for while the source is not synchronized. */
  "publish.sourceNotSynchronized",
  /** The staged public artifact contains something private. */
  "publish.privacyViolation",
  /** A profile could not be parsed or sanitized, so it must not be uploaded. */
  "profile.unsanitizable",

  /** Anything not yet classified. Always carries a `detail`. */
  "unknown",
] as const;

export type StudioErrorCode = (typeof STUDIO_ERROR_CODES)[number];

export interface StudioErrorOptions {
  /** Technical text for Advanced Details. Never shown in the normal UI. */
  detail?: string;
  /** The underlying error, kept for logging. */
  cause?: unknown;
  /** Seconds GitHub asked us to wait, from `Retry-After` or the rate headers. */
  retryAfterSeconds?: number;
  /** Extra machine-readable context, e.g. `{ fileName, path, sha }`. */
  context?: Record<string, string | number | boolean>;
}

/**
 * A failure with a code the app can branch on.
 *
 * Constructed with a plain-English message because it is going in front of a
 * server admin, not a developer: "Your GitHub access has expired" rather than
 * "HTTP 401".
 */
export class StudioError extends Error {
  /** Declared here because the ES2020 lib this project targets has no `cause`. */
  cause?: unknown;
  readonly code: StudioErrorCode;
  readonly detail: string;
  readonly retryAfterSeconds: number | null;
  readonly context: Record<string, string | number | boolean>;

  constructor(code: StudioErrorCode, message: string, options: StudioErrorOptions = {}) {
    super(message);
    this.name = "StudioError";
    // Assigned rather than passed to `super`: the ES2020 target this project
    // compiles to has no ErrorOptions overload.
    if (options.cause !== undefined) this.cause = options.cause;
    this.code = code;
    this.detail = redactSecrets(options.detail ?? "");
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.context = options.context ?? {};
  }
}

export function isStudioError(value: unknown): value is StudioError {
  return value instanceof StudioError;
}

/**
 * Wraps anything thrown into a StudioError without losing what it said.
 *
 * A rejected Tauri command arrives as a bare string, which is why this takes
 * `unknown` rather than `Error`.
 */
export function asStudioError(
  value: unknown,
  fallbackCode: StudioErrorCode = "unknown",
  fallbackMessage = "Something went wrong.",
): StudioError {
  if (isStudioError(value)) return value;
  const detail = value instanceof Error ? value.message : String(value ?? "");
  return new StudioError(fallbackCode, fallbackMessage, { detail, cause: value });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Which failures are worth trying again on their own.
 *
 * A non-fast-forward push is retryable in the sense that the *sync* re-runs
 * from the fetch — never that the same push is repeated blindly.
 */
const RETRYABLE: ReadonlySet<StudioErrorCode> = new Set([
  "network.offline",
  "network.timeout",
  "network.rateLimited",
  "network.serverError",
  "repo.nonFastForward",
]);

export function isRetryable(error: StudioError): boolean {
  return RETRYABLE.has(error.code);
}

/** Failures that mean "you are not connected", as opposed to "you are refused". */
export function isOffline(error: StudioError): boolean {
  return error.code === "network.offline" || error.code === "network.timeout";
}

/** Failures that mean the credential or its grant needs attention. */
export function isAccessProblem(error: StudioError): boolean {
  return (
    error.code === "auth.missing" ||
    error.code === "auth.expired" ||
    error.code === "auth.forbidden" ||
    error.code === "repo.unavailable"
  );
}

/**
 * Turns an HTTP status into a code and a sentence an admin can act on.
 *
 * `what` names the thing being reached for — "the project repository" — so the
 * message reads as advice rather than as a status line.
 */
export function classifyHttpStatus(
  status: number,
  what: string,
  options: { detail?: string; retryAfterSeconds?: number } = {},
): StudioError {
  const base = { detail: options.detail, retryAfterSeconds: options.retryAfterSeconds };
  if (status === 401) {
    return new StudioError(
      "auth.expired",
      "Your GitHub access has expired. Sign in again to continue.",
      base,
    );
  }
  if (status === 403 && options.retryAfterSeconds !== undefined) {
    return new StudioError(
      "network.rateLimited",
      "GitHub is asking us to slow down. This will retry shortly.",
      base,
    );
  }
  if (status === 403) {
    return new StudioError(
      "auth.forbidden",
      `Your GitHub access does not cover ${what}. Check the repository is included in your token's list and that it grants Contents read and write.`,
      base,
    );
  }
  if (status === 404) {
    return new StudioError(
      "repo.unavailable",
      `${capitalize(what)} could not be found. It may have been deleted, or your access to it removed.`,
      base,
    );
  }
  if (status === 409 || status === 422) {
    return new StudioError(
      "repo.conflict",
      `${capitalize(what)} is not in the state we expected. Nothing was changed.`,
      base,
    );
  }
  if (status === 429) {
    return new StudioError(
      "network.rateLimited",
      "GitHub is asking us to slow down. This will retry shortly.",
      base,
    );
  }
  if (status >= 500) {
    return new StudioError(
      "network.serverError",
      "GitHub is having trouble right now. Your work is saved locally — try again in a moment.",
      base,
    );
  }
  return new StudioError("unknown", `GitHub refused the request for ${what}.`, base);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * Token shapes GitHub issues. Order matters: the fine-grained prefix has to be
 * tried before the shorter `ghp_`-style one, or a `github_pat_` token gets
 * half-matched and the tail survives into the log.
 */
const TOKEN_PATTERNS: RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  // A token smuggled into a remote URL as basic-auth credentials.
  /(https?:\/\/)[^/\s:@]+:[^/\s@]+@/g,
  // Authorization headers echoed back in an error body.
  /(Authorization:\s*(?:Bearer|token)\s+)\S+/gi,
];

/**
 * Strips anything that looks like a credential.
 *
 * Applied to every StudioError detail on construction rather than at the
 * logging call site, because the one place a token leaks is the place somebody
 * forgot to call the redactor.
 */
export function redactSecrets(text: string): string {
  let out = text;
  out = out.replace(TOKEN_PATTERNS[0], "«token»");
  out = out.replace(TOKEN_PATTERNS[1], "«token»");
  out = out.replace(TOKEN_PATTERNS[2], "$1«credentials»@");
  out = out.replace(TOKEN_PATTERNS[3], "$1«token»");
  return out;
}
