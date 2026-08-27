import { STUDIO_REPO, studioRepoPath } from "../studio";

/**
 * Everything the Feedback Center needs to know about where reports go and how
 * big they may be.
 *
 * One module rather than constants at each call site: the repository slug, the
 * API address and the size limits are all things that change together, and a
 * limit the client enforces has to be the same number the server enforces or
 * one of them is decoration.
 *
 * The API address is deliberately empty in a stock build. An unset address is
 * a working configuration, not a broken one — the app falls back to preparing
 * the issue in the administrator's browser, which needs no service at all. See
 * `docs/architecture/feedback.md`.
 */

/** Bumped when the payload the client sends changes shape. */
export const FEEDBACK_SCHEMA_VERSION = 1;

/** Identifies the client to the API, and appears in every generated issue. */
export const FEEDBACK_SOURCE = "dinodepot-studio";

/**
 * Transport limits shared by every TypeScript call site.
 *
 * Rust and the deployed service mirror these values and have tests around
 * their own boundaries. A one-megabyte image becomes roughly 1.34 MB once it
 * is base64 encoded, so three images plus the report text stay comfortably
 * inside the six-megabyte request ceiling.
 */
export const MAX_FEEDBACK_ATTACHMENT_BYTES = 1 * 1024 * 1024;
export const MAX_FEEDBACK_ATTACHMENTS = 3;
export const MAX_FEEDBACK_REQUEST_BYTES = 6 * 1024 * 1024;

export interface FeedbackConfig {
  /** Master switch. Off hides every entry point and renders no feedback UI. */
  enabled: boolean;
  /**
   * Base URL of the DinoDepot Feedback API, without a trailing slash.
   *
   * Empty means no service is configured, and the app says so plainly rather
   * than pretending to submit.
   */
  apiBaseUrl: string;
  /** The application repository issues are filed against. Never a project's. */
  owner: string;
  repo: string;
  /** Whether to look for existing issues before submitting. */
  duplicateSearchEnabled: boolean;
  /** How many recent log entries diagnostics may carry, at most. */
  diagnosticsLogLimit: number;
  /** Per-attachment ceiling, in bytes. Enforced again on the server. */
  maxAttachmentBytes: number;
  /** How many attachments one report may carry. */
  maxAttachments: number;
  /** Whole-payload ceiling, in bytes. Enforced again on the server. */
  maxPayloadBytes: number;
  /** How long a My Reports refresh is considered current, in milliseconds. */
  statusCacheMs: number;
}

/**
 * The build-time address, if one was set.
 *
 * Read through a guard because `import.meta.env` does not exist when these
 * modules are imported by the test runner or by the feedback service.
 */
function buildTimeApiUrl(): string {
  try {
    const env = (import.meta as { env?: Record<string, string | undefined> }).env;
    return (env?.VITE_FEEDBACK_API_URL ?? "").trim().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export const FEEDBACK_CONFIG: FeedbackConfig = {
  enabled: true,
  apiBaseUrl: buildTimeApiUrl(),
  owner: STUDIO_REPO.owner,
  repo: STUDIO_REPO.repo,
  duplicateSearchEnabled: true,
  diagnosticsLogLimit: 50,
  maxAttachmentBytes: MAX_FEEDBACK_ATTACHMENT_BYTES,
  maxAttachments: MAX_FEEDBACK_ATTACHMENTS,
  maxPayloadBytes: MAX_FEEDBACK_REQUEST_BYTES,
  statusCacheMs: 5 * 60 * 1000,
};

/**
 * The configuration in force for this build.
 *
 * An official build's managed service is authoritative: allowing a stored
 * address to replace it would let reports, diagnostics, and screenshots be
 * redirected away from DinoDepot by accident. A runtime address remains
 * available for development and self-hosted builds that ship without one.
 */
export function effectiveConfig(
  overrides: Partial<Pick<FeedbackConfig, "enabled" | "apiBaseUrl">> = {},
): FeedbackConfig {
  const buildUrl = FEEDBACK_CONFIG.apiBaseUrl.trim().replace(/\/+$/, "");
  const runtimeUrl = overrides.apiBaseUrl?.trim() ?? "";
  const apiBaseUrl = isUsableApiUrl(buildUrl)
    ? buildUrl
    : runtimeUrl.trim().replace(/\/+$/, "");
  return {
    ...FEEDBACK_CONFIG,
    enabled: overrides.enabled ?? FEEDBACK_CONFIG.enabled,
    apiBaseUrl: isUsableApiUrl(apiBaseUrl) ? apiBaseUrl : "",
  };
}

/** Whether this build owns the service address rather than local settings. */
export function hasManagedFeedbackService(): boolean {
  return isUsableApiUrl(FEEDBACK_CONFIG.apiBaseUrl.trim().replace(/\/+$/, ""));
}

/**
 * Whether an address is one the app will actually send a report to.
 *
 * HTTPS only, and no credentials in the URL — the same rule the package
 * downloader applies, for the same reason: a URL with a password in it ends up
 * in a log the moment anything goes wrong.
 */
export function isUsableApiUrl(url: string): boolean {
  if (!url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.search || parsed.hash) return false;
  return Boolean(parsed.hostname);
}

/** Whether direct submission is possible at all with this configuration. */
export function canSubmitDirectly(config: FeedbackConfig): boolean {
  return config.enabled && isUsableApiUrl(config.apiBaseUrl);
}

/** An endpoint under the configured API. Returns "" when none is configured. */
export function apiEndpoint(config: FeedbackConfig, path: string): string {
  if (!canSubmitDirectly(config)) return "";
  return `${config.apiBaseUrl}/${path.replace(/^\/+/, "")}`;
}

/** The repository's new-issue page, used when the API cannot be reached. */
export function newIssueUrl(): string {
  return studioRepoPath("issues/new");
}

/** A specific issue in the application repository. */
export function issueUrl(number: number): string {
  return studioRepoPath(`issues/${number}`);
}
