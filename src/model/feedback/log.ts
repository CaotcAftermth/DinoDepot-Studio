import { redactSecrets } from "../errors";
import type { LogLevel, SanitizedLogEntry } from "./types";

/**
 * A short, bounded record of what the app was doing before something went
 * wrong.
 *
 * There was no application log before the Feedback Center; failures went to
 * `console.error`, which nobody reading a bug report can see. This is the
 * smallest thing that fixes that: a fixed-size ring in memory, never written
 * to disk, and only ever leaving the machine as part of a report the
 * administrator has read first.
 *
 * ## Two forms, deliberately
 *
 * {@link RawLogEntry} is what the app writes — whatever the failure said. It
 * never leaves this module. {@link SanitizedLogEntry} is what a report may
 * carry, and the only way to get one is {@link sanitizeLogEntry}. Keeping them
 * as different types means "forgot to sanitize" is a compile error rather than
 * something discovered in a public issue.
 *
 * Sanitizing on the way *out* rather than on the way in is on purpose: the
 * developer console should show the real path when somebody is debugging, and
 * only the copy that travels is reduced.
 */

/** How many entries the ring holds. Older ones are overwritten. */
export const LOG_CAPACITY = 100;

export interface RawLogEntry {
  /** Epoch milliseconds. Formatted only when the entry is sanitized. */
  at: number;
  level: LogLevel;
  /** Which part of the app wrote it: `sync`, `publish`, `feedback`… */
  scope: string;
  message: string;
  /** StudioErrorCode, when the entry came from a classified failure. */
  code: string;
}

/**
 * The ring itself.
 *
 * Module scope rather than a store, because logging has to work from anywhere
 * — including modules that load before React does — and because a log that
 * re-renders anything is a log that will eventually cause the bug it is meant
 * to record.
 */
const entries: RawLogEntry[] = [];

function push(level: LogLevel, scope: string, message: string, code = ""): void {
  entries.push({
    at: Date.now(),
    level,
    scope: scope.slice(0, 40),
    // Trimmed here as well as during sanitization: an unbounded string held in
    // a ring for the life of the process is a slow leak, and a stack trace
    // pasted into a log message is easily a megabyte.
    message: String(message ?? "").slice(0, 2000),
    code,
  });
  if (entries.length > LOG_CAPACITY) entries.splice(0, entries.length - LOG_CAPACITY);
}

/**
 * The app's logger.
 *
 * Also writes to the console, so nothing that used to be visible during
 * development stops being visible.
 */
export const studioLog = {
  info(scope: string, message: string): void {
    push("info", scope, message);
  },
  warn(scope: string, message: string): void {
    push("warn", scope, message);
    console.warn(`[${scope}] ${message}`);
  },
  /**
   * Records a failure. `code` is a StudioErrorCode when the caller has one —
   * it is what lets a maintainer tell "GitHub was down" from "the token was
   * revoked" without reading the message.
   */
  error(scope: string, message: string, code = ""): void {
    push("error", scope, message, code);
    console.error(`[${scope}] ${message}`);
  },
};

/** The most recent entries, oldest first. Never leaves the module unsanitized. */
export function recentRawLogs(limit = LOG_CAPACITY): RawLogEntry[] {
  return entries.slice(-Math.max(0, limit));
}

/** Empties the ring. Exists for tests and for the Clear button in diagnostics. */
export function clearLogs(): void {
  entries.length = 0;
}

/** How many entries are held right now. */
export function logSize(): number {
  return entries.length;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

/**
 * Absolute paths, in the three shapes this app produces.
 *
 * Windows drive paths dominate — every project folder, every mod directory —
 * and every one of them contains the administrator's Windows account name.
 * That is a real person's name, published in a public issue, in exchange for
 * nothing: the folder layout is never what a bug turns on.
 */
const PATH_PATTERNS: RegExp[] = [
  // C:\Users\somebody\... and C:/Users/somebody/...
  //
  // The lookbehind is load-bearing: without it the `s:` of `https://` reads as
  // a drive letter, and every URL in the log becomes `http«path»`.
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]*/g,
  // UNC shares.
  /\\\\[^\s"'<>|]+/g,
  // POSIX home directories.
  /\/(?:Users|home)\/[^\s"'<>|]*/g,
];

/**
 * Anything of the form `key=value` or `"key": "value"` whose key names a
 * credential.
 *
 * The value is replaced, not the pair: knowing that a request carried an
 * Authorization header is useful, and knowing what was in it is not.
 */
const SECRET_KEYS =
  "token|authorization|password|passwd|secret|apikey|api_key|githubtoken|github_token|bearer|cookie|session|webhook|credential|private_key|privatekey";

/** JSON, as it appears in an error body: `"token": "abc"`. */
const SECRET_JSON = new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"[^"]*"`, "gi");

/** Query strings, environment variables and config lines: `token=abc`. */
const SECRET_ASSIGNMENT = new RegExp(
  `\\b(${SECRET_KEYS})(\\s*[=:]\\s*)([^\\s,;&"')\\]}]+)`,
  "gi",
);

/** Bare email addresses, which arrive via Git author strings. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A Discord webhook, whose path segment is itself the credential. */
const DISCORD_WEBHOOK = /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S*/gi;

/**
 * Credential shapes that user-entered report text must never carry.
 *
 * Logs are redacted because dropping a log line would lose useful context.
 * Text the reporter typed is different: silently rewriting their report is
 * surprising, so validation asks them to remove the credential instead.
 */
const CREDENTIAL_TEXT_PATTERNS: readonly RegExp[] = [
  /github_pat_[A-Za-z0-9_]{20,}/i,
  /gh[pousr]_[A-Za-z0-9]{20,}/i,
  /xox[baprs]-[A-Za-z0-9-]{10,}/i,
  /AKIA[0-9A-Z]{16}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /https?:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /Authorization:\s*(?:Bearer|token|Basic)\s+\S+/i,
  /https:\/\/discord(?:app)?\.com\/api\/webhooks\/\S+/i,
  new RegExp(`"(?:${SECRET_KEYS})"\\s*:\\s*"(?!«redacted»)[^"]+"`, "i"),
  new RegExp(
    `\\b(?:${SECRET_KEYS})\\s*[=:]\\s*(?!«redacted»)[^\\s,;&"')\\]}]+`,
    "i",
  ),
];

/** Whether text contains a credential that must be removed before publishing. */
export function containsCredentialLikeText(input: string): boolean {
  const text = String(input ?? "");
  return CREDENTIAL_TEXT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Reduces one line of text to something publishable.
 *
 * Order matters. Credential-shaped tokens go first, because the redactor for
 * those is the strictest and a later rule could otherwise chop a token in half
 * and leave the tail. Paths go before emails, because a Windows path can
 * contain something that looks like neither until the drive letter is gone.
 */
export function sanitizeText(input: string): string {
  let text = redactSecrets(String(input ?? ""));
  text = text.replace(DISCORD_WEBHOOK, "«webhook»");
  // The key is kept and only the value replaced: that a request carried an
  // Authorization header is useful, and what was in it is not.
  text = text.replace(SECRET_JSON, '$1"«redacted»"');
  text = text.replace(SECRET_ASSIGNMENT, "$1$2«redacted»");
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, "«path»");
  text = text.replace(EMAIL, "«email»");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The timestamp form used in reports: whole seconds, UTC.
 *
 * Milliseconds say nothing a reader can use and make two entries a second
 * apart look precise about an ordering the ring does not actually guarantee
 * across asynchronous work.
 */
function stamp(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 19)}Z`;
}

export function sanitizeLogEntry(entry: RawLogEntry): SanitizedLogEntry {
  return {
    at: stamp(entry.at),
    level: entry.level,
    scope: sanitizeText(entry.scope).slice(0, 40),
    message: sanitizeText(entry.message).slice(0, 400),
    code: entry.code.slice(0, 40),
  };
}

/**
 * The recent log, ready to attach to a report.
 *
 * Entries the Feedback Center itself wrote are left out. They describe the act
 * of reporting rather than the problem being reported, and by the time a
 * report is being assembled they are the newest entries — so keeping them
 * would push the interesting ones off the end of the limit.
 */
export function sanitizedLogs(limit: number): SanitizedLogEntry[] {
  if (limit <= 0) return [];
  return entries
    .filter((entry) => entry.scope !== FEEDBACK_SCOPE)
    .slice(-limit)
    .map(sanitizeLogEntry);
}

/** The scope the Feedback Center logs under, and excludes from its own reports. */
export const FEEDBACK_SCOPE = "feedback";
