import { describe, expect, it } from "vitest";
import {
  applyRepoRename,
  bindingsAreDistinct,
  bindingSlug,
  canPublish,
  canSync,
  isSafeRemoteUrl,
  LocalProjectStateSchema,
  newLocalProjectState,
  remoteUrlFor,
  RepoBindingSchema,
  type LocalProjectState,
  type RepoBinding,
} from "./localState";

function binding(over: Partial<RepoBinding> = {}): RepoBinding {
  return RepoBindingSchema.parse({
    githubId: "123456",
    owner: "ggfizz",
    name: "cluster-source",
    remoteUrl: "https://github.com/ggfizz/cluster-source.git",
    branch: "main",
    isPrivate: true,
    ...over,
  });
}

function state(over: Partial<LocalProjectState> = {}): LocalProjectState {
  return {
    ...newLocalProjectState("project-1", "C:\\Projects\\GGFizz", "GG Fizz"),
    ...over,
  };
}

describe("local project state", () => {
  it("starts with no bindings and the recommended topology", () => {
    const fresh = newLocalProjectState("p1", "C:\\x", "Name");
    expect(fresh.source).toBeNull();
    expect(fresh.delivery).toBeNull();
    expect(fresh.topology).toBe("source-and-delivery");
    expect(fresh.lastSyncedCommit).toBe("");
  });

  /**
   * Everything here is rebuildable, and a project must open even if the record
   * was written by a version that knew different fields.
   */
  it("parses a record missing every optional field", () => {
    const parsed = LocalProjectStateSchema.safeParse({ projectId: "p1" });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.topology).toBe("source-and-delivery");
  });

  it("refuses a record with no project id", () => {
    expect(LocalProjectStateSchema.safeParse({ localPath: "C:\\x" }).success).toBe(
      false,
    );
  });
});

describe("remote URL safety", () => {
  it("accepts a plain HTTPS GitHub remote", () => {
    expect(isSafeRemoteUrl("https://github.com/ggfizz/cluster.git")).toBe(true);
  });

  /**
   * A token in a remote URL is how one ends up written into `.git/config` and
   * then read back by anything that can see the folder. Refused on the way in
   * rather than stripped on the way out.
   */
  it("refuses a URL carrying credentials", () => {
    expect(isSafeRemoteUrl("https://x-access-token:ghp_abc@github.com/o/r.git")).toBe(
      false,
    );
    expect(isSafeRemoteUrl("https://user@github.com/o/r.git")).toBe(false);
  });

  it("refuses anything that is not HTTPS to GitHub", () => {
    for (const bad of [
      "http://github.com/o/r.git",
      "git@github.com:o/r.git",
      "ssh://git@github.com/o/r.git",
      "https://evil.example.com/o/r.git",
      "https://github.com.evil.example/o/r.git",
      "not a url",
      "",
    ]) {
      expect(isSafeRemoteUrl(bad), bad).toBe(false);
    }
  });

  it("builds the canonical remote from owner and name", () => {
    expect(remoteUrlFor("ggfizz", "cluster")).toBe(
      "https://github.com/ggfizz/cluster.git",
    );
    expect(isSafeRemoteUrl(remoteUrlFor("ggfizz", "cluster"))).toBe(true);
  });
});

describe("repository renames", () => {
  /**
   * The id is the identity. A changed owner or name is news about the same
   * repository, not a reason to disconnect the project from it.
   */
  it("follows a rename without touching the id", () => {
    const renamed = applyRepoRename(binding(), "ggfizz", "cluster-config");
    expect(renamed.githubId).toBe("123456");
    expect(renamed.name).toBe("cluster-config");
    expect(renamed.remoteUrl).toBe("https://github.com/ggfizz/cluster-config.git");
  });

  it("follows a transfer to another owner", () => {
    const moved = applyRepoRename(binding(), "gg-fizz-org", "cluster-source");
    expect(moved.owner).toBe("gg-fizz-org");
    expect(moved.remoteUrl).toBe(
      "https://github.com/gg-fizz-org/cluster-source.git",
    );
  });

  /** The old URL only resolves while GitHub's redirect lasts. */
  it("rebuilds the remote rather than keeping the stale one", () => {
    const renamed = applyRepoRename(binding(), "ggfizz", "renamed");
    expect(renamed.remoteUrl).not.toContain("cluster-source");
  });

  it("returns the same object when nothing moved", () => {
    const original = binding();
    expect(applyRepoRename(original, "ggfizz", "cluster-source")).toBe(original);
  });

  it("names a binding as owner/name", () => {
    expect(bindingSlug(binding())).toBe("ggfizz/cluster-source");
  });
});

describe("what the bindings allow", () => {
  it("needs a source repository and an account before syncing", () => {
    expect(canSync(null)).toBe(false);
    expect(canSync(state())).toBe(false);
    expect(canSync(state({ source: binding() }))).toBe(false);
    expect(canSync(state({ source: binding(), githubAccountId: "9" }))).toBe(true);
  });

  it("needs a delivery repository as well before publishing", () => {
    const synced = state({ source: binding(), githubAccountId: "9" });
    expect(canPublish(synced)).toBe(false);
    expect(
      canPublish({
        ...synced,
        delivery: binding({ githubId: "789", name: "cluster-site", isPrivate: false }),
      }),
    ).toBe(true);
  });

  it("publishes from a single repository under the paid topology", () => {
    const single = state({
      source: binding(),
      githubAccountId: "9",
      topology: "single-private",
    });
    expect(canPublish(single)).toBe(true);
  });

  /**
   * Publishing generated output into the source repository would leave the
   * private roster one directory from a public Pages site.
   */
  it("refuses to publish when both bindings are the same repository", () => {
    const same = state({
      source: binding(),
      delivery: binding(),
      githubAccountId: "9",
    });
    expect(bindingsAreDistinct(same)).toBe(false);
    expect(canPublish(same)).toBe(false);
  });

  it("treats different repositories with the same name as distinct", () => {
    const distinct = state({
      source: binding({ githubId: "1" }),
      delivery: binding({ githubId: "2" }),
    });
    expect(bindingsAreDistinct(distinct)).toBe(true);
  });
});

describe("credentials", () => {
  /** The record names the account; Credential Manager holds the token. */
  it("has nowhere to put a token", () => {
    const full = state({
      source: binding(),
      delivery: binding({ githubId: "2" }),
      githubAccountId: "9",
      githubLogin: "ggfizz",
    });
    const serialized = JSON.stringify(full);
    expect(serialized).not.toMatch(/token/i);
    expect(serialized).not.toMatch(/password|secret/i);
    expect(Object.keys(LocalProjectStateSchema.parse(full))).not.toContain("token");
  });
});
