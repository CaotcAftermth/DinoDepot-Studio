import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEEDBACK_SCOPE,
  LOG_CAPACITY,
  clearLogs,
  logSize,
  recentRawLogs,
  sanitizeLogEntry,
  sanitizeText,
  sanitizedLogs,
  studioLog,
} from "./log";

/**
 * The sanitizer is the single most security-relevant function in the Feedback
 * Center: everything it misses goes into a public issue.
 *
 * So the tests are written as the leak they prevent, not as the transformation
 * they perform — each one names a thing that must never appear in a report,
 * and asserts it does not.
 */

beforeEach(() => {
  clearLogs();
  vi.restoreAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("sanitizeText", () => {
  it("removes a GitHub token in every shape GitHub issues one", () => {
    for (const token of [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
    ]) {
      const output = sanitizeText(`push failed with ${token} attached`);
      expect(output).not.toContain(token);
      expect(output).toContain("«token»");
    }
  });

  it("removes credentials smuggled into a remote URL", () => {
    const output = sanitizeText(
      "remote https://x-access-token:ghp_abcdefghijklmnopqrst@github.com/o/r.git",
    );
    expect(output).not.toContain("ghp_");
    expect(output).not.toContain("x-access-token:");
  });

  /** The Discord webhook path segment is itself the credential. */
  it("removes a Discord webhook entirely", () => {
    const output = sanitizeText(
      "POST https://discord.com/api/webhooks/123456/abcdefgABCDEFG failed",
    );
    expect(output).not.toContain("abcdefgABCDEFG");
    expect(output).not.toContain("123456");
    expect(output).toContain("«webhook»");
  });

  it("replaces the value of anything credential-shaped, keeping the key", () => {
    const json = sanitizeText('{"githubToken":"abc123","name":"Rex"}');
    expect(json).not.toContain("abc123");
    expect(json).toContain("githubToken");
    expect(json).toContain("Rex");

    const query = sanitizeText("GET /thing?token=abc123&page=2");
    expect(query).not.toContain("abc123");
    expect(query).toContain("page=2");
  });

  /**
   * Every Windows path in this application contains the administrator's own
   * account name, and no bug turns on the folder layout.
   */
  it("removes absolute paths on every platform", () => {
    expect(sanitizeText("Failed to save C:\\Users\\jane\\Cluster\\project.json")).toBe(
      "Failed to save «path»",
    );
    expect(sanitizeText("open C:/Users/jane/Cluster")).toBe("open «path»");
    expect(sanitizeText("stat /home/jane/projects/x")).toBe("stat «path»");
    expect(sanitizeText("read /Users/jane/Documents/a.json")).toBe("read «path»");
    expect(sanitizeText("share \\\\fileserver\\clusters\\a")).toBe("share «path»");
  });

  /**
   * The regression this rule exists for: without a lookbehind, the `s:` of
   * `https://` reads as a drive letter and every URL becomes `http«path»`.
   */
  it("does not mistake a URL scheme for a drive letter", () => {
    expect(sanitizeText("could not reach https://github.com/o/r")).toBe(
      "could not reach https://github.com/o/r",
    );
  });

  it("removes email addresses, which arrive via Git author strings", () => {
    const output = sanitizeText("commit by jane.doe+ark@example.com failed");
    expect(output).not.toContain("jane.doe");
    expect(output).toContain("«email»");
  });

  it("leaves an ordinary failure readable", () => {
    expect(sanitizeText("Sync refused: the branch moved on (repo.nonFastForward)")).toBe(
      "Sync refused: the branch moved on (repo.nonFastForward)",
    );
  });

  it("survives being handed nothing", () => {
    expect(sanitizeText("")).toBe("");
    // Nothing in, nothing out — not the word "undefined" in an issue body.
    expect(sanitizeText(undefined as unknown as string)).toBe("");
    expect(sanitizeText(null as unknown as string)).toBe("");
  });
});

describe("the log ring", () => {
  it("keeps the newest entries and drops the oldest", () => {
    for (let index = 0; index < LOG_CAPACITY + 25; index++) {
      studioLog.info("test", `entry ${index}`);
    }
    expect(logSize()).toBe(LOG_CAPACITY);
    const entries = recentRawLogs();
    expect(entries[0].message).toBe("entry 25");
    expect(entries[entries.length - 1].message).toBe(
      `entry ${LOG_CAPACITY + 24}`,
    );
  });

  it("caps a single entry, so a pasted stack trace is not held forever", () => {
    studioLog.error("test", "x".repeat(9000));
    expect(recentRawLogs()[0].message.length).toBeLessThanOrEqual(2000);
  });

  it("carries the error code, so a maintainer can classify without reading", () => {
    studioLog.error("sync", "Your GitHub access has expired.", "auth.expired");
    expect(recentRawLogs()[0].code).toBe("auth.expired");
  });

  it("still writes to the console, so development is unchanged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    studioLog.error("sync", "boom");
    expect(spy).toHaveBeenCalled();
  });
});

describe("sanitizedLogs", () => {
  it("sanitizes on the way out, not on the way in", () => {
    studioLog.error("save", "Failed to save C:\\Users\\jane\\project.json");
    // The raw entry keeps the path, so the developer console is still useful.
    expect(recentRawLogs()[0].message).toContain("jane");
    expect(sanitizedLogs(10)[0].message).toBe("Failed to save «path»");
  });

  it("honours the limit and returns the newest", () => {
    for (let index = 0; index < 20; index++) studioLog.info("test", `n${index}`);
    const entries = sanitizedLogs(5);
    expect(entries.length).toBe(5);
    expect(entries[4].message).toBe("n19");
  });

  it("returns nothing when the limit is zero", () => {
    studioLog.info("test", "something");
    expect(sanitizedLogs(0)).toEqual([]);
  });

  /**
   * The Feedback Center's own entries are the newest ones by the time a report
   * is assembled, so keeping them would push the interesting ones off the end.
   */
  it("leaves out the Feedback Center's own entries", () => {
    studioLog.error("sync", "the interesting failure");
    studioLog.error(FEEDBACK_SCOPE, "opening the form");
    const messages = sanitizedLogs(10).map((entry) => entry.message);
    expect(messages).toContain("the interesting failure");
    expect(messages).not.toContain("opening the form");
  });

  it("stamps to whole seconds in UTC", () => {
    const entry = sanitizeLogEntry({
      at: Date.UTC(2026, 7, 22, 9, 14, 15, 678),
      level: "warn",
      scope: "publish",
      message: "hm",
      code: "",
    });
    expect(entry.at).toBe("2026-08-22T09:14:15Z");
  });
});
