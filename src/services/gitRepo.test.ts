import { beforeEach, describe, expect, it, vi } from "vitest";
import { isStudioError, StudioError } from "../model/errors";

/** Every command the wrapper sent, so the arguments can be inspected. */
let sent: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    sent.push({ cmd, args });
    if (cmd === "git_push") return { pushed: true, rejected: false, commit: "c1" };
    return "c1";
  },
}));

const git = await import("./gitRepo");
const { decodeFailure } = git.__testing;

beforeEach(() => {
  sent = [];
});

/**
 * The credential boundary, guarded at the one place it could be undone.
 *
 * An earlier cut of the Git layer took the token as a command argument, which
 * would have required the webview to be able to read it - undoing the whole
 * point of removing `secret_get`. These assertions exist so that change cannot
 * come back unnoticed.
 */
describe("the credential boundary", () => {
  it("names the account, and never carries a credential", async () => {
    await git.fetch("C:\\proj", "main", "account-9");
    await git.push("C:\\proj", "main", "account-9");

    expect(sent.map((c) => c.cmd)).toEqual(["git_fetch", "git_push"]);
    for (const call of sent) {
      expect(call.args.accountId).toBe("account-9");
      expect(Object.keys(call.args)).not.toContain("token");
      expect(Object.keys(call.args)).not.toContain("password");
      expect(Object.keys(call.args)).not.toContain("secret");
    }
  });

  it("sends nothing that looks like a token in any argument", async () => {
    await git.fetch("C:\\proj", "main", "account-9");
    await git.setRemote("C:\\proj", "https://github.com/o/r.git");
    const serialized = JSON.stringify(sent);
    expect(serialized).not.toMatch(/github_pat_|gh[pousr]_/);
    // And no credentials smuggled into the remote URL either.
    expect(serialized).not.toMatch(/https:\/\/[^"@/]+:[^"@/]+@/);
  });

  it("passes an explicit history reset only for a deliberate rebind", async () => {
    await git.setRemote("C:\\proj", "https://github.com/o/new.git", true);
    expect(sent[0]).toEqual({
      cmd: "git_set_remote",
      args: {
        dir: "C:\\proj",
        url: "https://github.com/o/new.git",
        resetHistory: true,
      },
    });
  });
});

/**
 * The boundary between the Rust Git layer and the rest of the app.
 *
 * Rust rejects with a JSON-encoded failure carrying a code. Decoding it here is
 * what lets the orchestration tell "the branch moved on, go round again" apart
 * from "your access was revoked, stop and ask" - without reading English out of
 * an error string.
 */
describe("decodeFailure", () => {
  it("reads a classified failure from the Git layer", () => {
    const error = decodeFailure(
      new Error(
        JSON.stringify({
          code: "repo.nonFastForward",
          message: "Somebody else saved changes first.",
          detail: "pushing to GitHub: fetch first",
        }),
      ),
      "fallback",
    );
    expect(error.code).toBe("repo.nonFastForward");
    expect(error.message).toBe("Somebody else saved changes first.");
    expect(error.detail).toContain("fetch first");
  });

  it("reads it from a bare string rejection too", () => {
    const error = decodeFailure(
      JSON.stringify({ code: "auth.expired", message: "Your access expired." }),
      "fallback",
    );
    expect(error.code).toBe("auth.expired");
  });

  /**
   * A code this build has never heard of must not become a code it *has* heard
   * of by accident - the retry logic branches on these.
   */
  it("does not trust a code it does not recognise", () => {
    const error = decodeFailure(
      JSON.stringify({ code: "repo.somethingNew", message: "Newer Studio said this." }),
      "fallback",
    );
    expect(error.code).toBe("unknown");
    // The message still reaches the administrator.
    expect(error.message).toBe("Newer Studio said this.");
  });

  it("falls back for anything that is not one of ours", () => {
    for (const raw of [
      new Error("command git_push not found"),
      "some plain text",
      new Error("{ not json"),
      new Error(JSON.stringify({ nope: true })),
      new Error(JSON.stringify(["an", "array"])),
    ]) {
      const error = decodeFailure(raw, "Could not send your changes.");
      expect(isStudioError(error)).toBe(true);
      expect(error.code).toBe("unknown");
      expect(error.message).toBe("Could not send your changes.");
    }
  });

  /**
   * A classified failure raised above this layer - by the mock backend, or by
   * a wrapper - passes straight through. Re-wrapping it as "unknown" would
   * throw away the very classification the retry logic needs.
   */
  it("passes an already-classified failure through untouched", () => {
    const original = new StudioError("network.offline", "No connection.");
    expect(decodeFailure(original, "fallback")).toBe(original);
  });

  /** Redaction is on StudioError's constructor, so it applies here too. */
  it("redacts a credential the Git layer let through", () => {
    const error = decodeFailure(
      new Error(
        JSON.stringify({
          code: "auth.expired",
          message: "Your access expired.",
          detail: "https://x:ghp_abcdefghijklmnopqrst@github.com/o/r",
        }),
      ),
      "fallback",
    );
    expect(error.detail).not.toContain("ghp_abcdefghij");
  });
});
