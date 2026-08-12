import { describe, expect, it } from "vitest";
import {
  asStudioError,
  classifyHttpStatus,
  isAccessProblem,
  isOffline,
  isRetryable,
  redactSecrets,
  StudioError,
} from "./errors";

describe("StudioError", () => {
  it("carries a code, a user message and technical detail separately", () => {
    const error = new StudioError("save.failed", "Could not save your changes.", {
      detail: "ENOSPC: no space left on device",
      context: { fileName: "players.json" },
    });
    expect(error.code).toBe("save.failed");
    expect(error.message).toBe("Could not save your changes.");
    expect(error.detail).toContain("ENOSPC");
    expect(error.context.fileName).toBe("players.json");
  });

  it("redacts credentials out of detail on construction", () => {
    const error = new StudioError("unknown", "Failed.", {
      detail: "remote https://user:github_pat_11ABCDEFG0abcdefghijklmnop@github.com/o/r",
    });
    expect(error.detail).not.toContain("github_pat_");
    expect(error.detail).not.toContain("user:");
  });
});

describe("asStudioError", () => {
  it("passes a StudioError through untouched", () => {
    const original = new StudioError("auth.expired", "Expired.");
    expect(asStudioError(original)).toBe(original);
  });

  /** Rejected Tauri commands arrive as bare strings, not Errors. */
  it("wraps a string rejection without losing it", () => {
    const wrapped = asStudioError("No project.json found in that folder");
    expect(wrapped.code).toBe("unknown");
    expect(wrapped.detail).toBe("No project.json found in that folder");
  });

  it("uses the caller's fallback code and message", () => {
    const wrapped = asStudioError(new Error("EACCES"), "save.failed", "Could not save.");
    expect(wrapped.code).toBe("save.failed");
    expect(wrapped.message).toBe("Could not save.");
    expect(wrapped.detail).toBe("EACCES");
  });
});

describe("classifyHttpStatus", () => {
  it("maps 401 to an expired credential", () => {
    expect(classifyHttpStatus(401, "the project repository").code).toBe("auth.expired");
  });

  it("maps 403 to a permission problem", () => {
    const error = classifyHttpStatus(403, "the project repository");
    expect(error.code).toBe("auth.forbidden");
    expect(error.message).toContain("Contents read and write");
  });

  /**
   * GitHub uses 403 for secondary rate limits too, and tells you so with
   * Retry-After. Reading that as "your token is wrong" would send an admin off
   * regenerating a credential that was fine.
   */
  it("maps a 403 carrying Retry-After to rate limiting", () => {
    const error = classifyHttpStatus(403, "the project repository", {
      retryAfterSeconds: 60,
    });
    expect(error.code).toBe("network.rateLimited");
    expect(error.retryAfterSeconds).toBe(60);
  });

  it("maps 404 to an unavailable repository", () => {
    const error = classifyHttpStatus(404, "the project repository");
    expect(error.code).toBe("repo.unavailable");
    expect(error.message).toContain("The project repository");
  });

  it("maps 409 and 422 to a conflict", () => {
    expect(classifyHttpStatus(409, "the branch").code).toBe("repo.conflict");
    expect(classifyHttpStatus(422, "the branch").code).toBe("repo.conflict");
  });

  it("maps 429 to rate limiting", () => {
    expect(classifyHttpStatus(429, "the branch").code).toBe("network.rateLimited");
  });

  it("maps 5xx to a server problem", () => {
    for (const status of [500, 502, 503]) {
      expect(classifyHttpStatus(status, "the branch").code).toBe("network.serverError");
    }
  });

  it("redacts a token echoed back inside the response body", () => {
    const error = classifyHttpStatus(403, "the branch", {
      detail: 'Bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    });
    expect(error.detail).not.toContain("ghp_abcdefghij");
    expect(error.detail).toContain("«token»");
  });
});

describe("classification helpers", () => {
  it("marks transport failures and a moved branch as retryable", () => {
    for (const code of [
      "network.offline",
      "network.timeout",
      "network.rateLimited",
      "network.serverError",
      "repo.nonFastForward",
    ] as const) {
      expect(isRetryable(new StudioError(code, "x")), code).toBe(true);
    }
  });

  it("does not retry a refused credential or a failed validation", () => {
    for (const code of [
      "auth.expired",
      "auth.forbidden",
      "repo.unavailable",
      "validation.failed",
      "publish.privacyViolation",
    ] as const) {
      expect(isRetryable(new StudioError(code, "x")), code).toBe(false);
    }
  });

  it("separates being offline from being refused", () => {
    expect(isOffline(new StudioError("network.offline", "x"))).toBe(true);
    expect(isOffline(new StudioError("auth.forbidden", "x"))).toBe(false);
    expect(isAccessProblem(new StudioError("auth.forbidden", "x"))).toBe(true);
    expect(isAccessProblem(new StudioError("network.offline", "x"))).toBe(false);
  });
});

describe("redactSecrets", () => {
  it("removes every GitHub token shape", () => {
    const samples = [
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
    ];
    for (const sample of samples) {
      const redacted = redactSecrets(`failed with ${sample} attached`);
      expect(redacted, sample).not.toContain(sample);
      expect(redacted, sample).toContain("«token»");
    }
  });

  /**
   * A fine-grained token starts `github_pat_`, which also matches nothing in
   * the shorter pattern — but only if the longer one is tried first. Getting
   * that order wrong leaves the tail of the token in the log.
   */
  it("redacts a fine-grained token whole", () => {
    const redacted = redactSecrets("github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz");
    expect(redacted).toBe("«token»");
  });

  it("strips credentials embedded in a remote URL", () => {
    expect(redactSecrets("https://x-access-token:secret123@github.com/o/r.git")).toBe(
      "https://«credentials»@github.com/o/r.git",
    );
  });

  it("strips an Authorization header", () => {
    expect(redactSecrets("Authorization: Bearer abc.def.ghi")).toBe(
      "Authorization: Bearer «token»",
    );
    expect(redactSecrets("authorization: token abc123")).toBe(
      "authorization: token «token»",
    );
  });

  it("leaves ordinary text alone", () => {
    const text = "No space left on device while writing players.json";
    expect(redactSecrets(text)).toBe(text);
  });
});
