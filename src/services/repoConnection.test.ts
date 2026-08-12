import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioError } from "../model/errors";
import {
  LocalProjectStateSchema,
  newLocalProjectState,
  RepoBindingSchema,
  type LocalProjectState,
  type RepoBinding,
} from "../model/localState";
import type { RepoIdentity } from "../model/repoSetup";

/**
 * Binding a project to its repositories, against a scripted GitHub.
 *
 * The cases that matter are the ones where the repository has moved or gone:
 * a rename must be followed silently, and a deletion must never cost the
 * administrator anything on their own disk.
 */

/** What the fake GitHub answers with, keyed by id and by slug. */
let byId: Record<string, RepoIdentity | StudioError>;
let bySlug: Record<string, RepoIdentity | StudioError>;
let remoteSet: string[];

function answer(value: RepoIdentity | StudioError | undefined): RepoIdentity {
  if (!value) throw new StudioError("repo.unavailable", "Not found.");
  if (value instanceof StudioError) throw value;
  return value;
}

vi.mock("./githubAccount", () => ({
  repoById: async (_account: string, id: string) => answer(byId[id]),
  repoBySlug: async (_account: string, owner: string, name: string) =>
    answer(bySlug[`${owner}/${name}`]),
  connectAccount: async () => ({ accountId: "9", login: "ggfizz", avatarUrl: "" }),
  accountStatus: async () => ({ connected: true, login: "ggfizz", problem: "" }),
  disconnectAccount: async () => {},
  branchExists: async () => true,
}));

vi.mock("./gitRepo", () => ({
  setRemote: async (_dir: string, url: string) => {
    remoteSet.push(url);
  },
}));

const {
  connectRepository,
  verifyBinding,
  assertBoundIdentity,
  applyRemote,
  checkConnection,
} = await import("./repoConnection");

function identity(over: Partial<RepoIdentity> = {}): RepoIdentity {
  return {
    githubId: "123456789",
    owner: "ggfizz",
    name: "cluster-source",
    isPrivate: true,
    defaultBranch: "main",
    canPush: true,
    isEmpty: true,
    htmlUrl: "https://github.com/ggfizz/cluster-source",
    ...over,
  };
}

function binding(over: Partial<RepoBinding> = {}): RepoBinding {
  return RepoBindingSchema.parse({
    githubId: "123456789",
    owner: "ggfizz",
    name: "cluster-source",
    remoteUrl: "https://github.com/ggfizz/cluster-source.git",
    branch: "main",
    isPrivate: true,
    ...over,
  });
}

function state(over: Partial<LocalProjectState> = {}): LocalProjectState {
  return LocalProjectStateSchema.parse({
    ...newLocalProjectState("p1", "C:\\proj", "GG Fizz"),
    githubAccountId: "9",
    ...over,
  });
}

beforeEach(() => {
  byId = { "123456789": identity() };
  bySlug = { "ggfizz/cluster-source": identity() };
  remoteSet = [];
});

describe("connecting a repository", () => {
  it("binds a suitable one, carrying its id", async () => {
    const result = await connectRepository(state(), "source", "ggfizz", "cluster-source");
    expect(result.connected).toBe(true);
    expect(result.binding.githubId).toBe("123456789");
    expect(result.binding.remoteUrl).toBe(
      "https://github.com/ggfizz/cluster-source.git",
    );
  });

  it("trims what the administrator typed", async () => {
    const result = await connectRepository(
      state(),
      "source",
      "  ggfizz  ",
      "  cluster-source  ",
    );
    expect(result.connected).toBe(true);
  });

  /** Discovering this at the first Sync would be far too late. */
  it("refuses a public repository for the project, and says why", async () => {
    bySlug["ggfizz/cluster-source"] = identity({ isPrivate: false });
    const result = await connectRepository(state(), "source", "ggfizz", "cluster-source");
    expect(result.connected).toBe(false);
    expect(result.issues[0].message).toContain("is public");
  });

  it("refuses one the token cannot write to", async () => {
    bySlug["ggfizz/cluster-source"] = identity({ canPush: false });
    const result = await connectRepository(state(), "source", "ggfizz", "cluster-source");
    expect(result.connected).toBe(false);
  });

  /** A warning is not a refusal — an existing repository may be the right one. */
  it("connects despite a warning", async () => {
    bySlug["ggfizz/cluster-source"] = identity({ isEmpty: false });
    const result = await connectRepository(state(), "source", "ggfizz", "cluster-source");
    expect(result.connected).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].level).toBe("warning");
  });

  it("surfaces a repository that is not there", async () => {
    await expect(
      connectRepository(state(), "source", "ggfizz", "no-such-repo"),
    ).rejects.toMatchObject({ code: "repo.unavailable" });
  });

  it("takes the repository's default branch when none is given", async () => {
    bySlug["ggfizz/cluster-source"] = identity({ defaultBranch: "trunk" });
    const result = await connectRepository(state(), "source", "ggfizz", "cluster-source");
    expect(result.binding.branch).toBe("trunk");
  });
});

describe("verifying a binding", () => {
  it("looks up by id, not by name", async () => {
    // The name no longer resolves; only the id does.
    bySlug = {};
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.availability).toBeNull();
    expect(result.change).toBe("none");
  });

  /** A rename is news about the same repository, not a disappearance. */
  it("follows a rename and says so", async () => {
    byId["123456789"] = identity({ name: "cluster-config" });
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.change).toBe("renamed");
    expect(result.binding.name).toBe("cluster-config");
    expect(result.binding.remoteUrl).toBe(
      "https://github.com/ggfizz/cluster-config.git",
    );
    expect(result.note).toContain("renamed");
    expect(result.availability).toBeNull();
  });

  it("follows a transfer to another owner", async () => {
    byId["123456789"] = identity({ owner: "gg-fizz-org" });
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.change).toBe("transferred");
    expect(result.binding.owner).toBe("gg-fizz-org");
  });

  /**
   * A migrated schema-1 project has a name and no id. This is the one moment
   * the name is allowed to be used, and it is how the id gets learned.
   */
  it("uses the name once, for a binding that has never known its id", async () => {
    const result = await verifyBinding(
      state({ source: binding({ githubId: "" }) }),
      "source",
    );
    expect(result.change).toBe("named");
    expect(result.binding.githubId).toBe("123456789");
  });

  describe("when the repository is gone", () => {
    beforeEach(() => {
      byId = {};
      bySlug = {};
    });

    it("reports it without clearing the binding", async () => {
      const before = binding();
      const result = await verifyBinding(state({ source: before }), "source");
      expect(result.availability?.availability).toBe("unreachable");
      expect(result.binding).toEqual(before);
      expect(result.availability?.workIsSafe).toBe(true);
    });

    it("switches off both operations, and offers a reconnect", async () => {
      const result = await verifyBinding(state({ source: binding() }), "source");
      expect(result.availability?.disabled).toEqual(["sync", "publish"]);
      expect(result.availability?.offerReconnect).toBe(true);
    });

    it("switches off only publishing when it is the site repository", async () => {
      const result = await verifyBinding(
        state({ delivery: binding({ githubId: "987" }) }),
        "delivery",
      );
      expect(result.availability?.disabled).toEqual(["publish"]);
    });
  });

  it("treats being offline as temporary", async () => {
    byId["123456789"] = new StudioError("network.offline", "No connection.");
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.availability?.availability).toBe("offline");
    expect(result.availability?.offerReconnect).toBe(false);
  });

  it("reports a permission that was taken away", async () => {
    byId["123456789"] = new StudioError("auth.forbidden", "No access.");
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.availability?.availability).toBe("no-access");
  });

  it("notices a repository that has been made public since", async () => {
    byId["123456789"] = identity({ isPrivate: false });
    const result = await verifyBinding(state({ source: binding() }), "source");
    expect(result.issues.some((i) => i.message.includes("is public"))).toBe(true);
  });

  it("has nothing to say when nothing is bound", async () => {
    const result = await verifyBinding(state(), "source");
    expect(result.availability).toBeNull();
    expect(result.binding.githubId).toBe("");
  });
});

describe("confirming the bound identity", () => {
  /** An opened project is untrusted input. */
  it("passes when the id that answers is the one we are bound to", async () => {
    await expect(
      assertBoundIdentity(state({ source: binding() }), "source"),
    ).resolves.toBeUndefined();
  });

  it("refuses when a different repository answers", async () => {
    byId["123456789"] = identity({ githubId: "999999" });
    await expect(
      assertBoundIdentity(state({ source: binding() }), "source"),
    ).rejects.toMatchObject({ code: "repo.identityMismatch" });
  });

  it("has nothing to check before an id is known", async () => {
    await expect(
      assertBoundIdentity(state({ source: binding({ githubId: "" }) }), "source"),
    ).resolves.toBeUndefined();
  });
});

describe("pointing the local repository at its remote", () => {
  it("writes the rebuilt URL, never a stale one", async () => {
    await applyRemote("C:\\proj", binding({ owner: "gg-fizz-org", name: "renamed", remoteUrl: "https://github.com/gg-fizz-org/renamed.git" }));
    expect(remoteSet).toEqual(["https://github.com/gg-fizz-org/renamed.git"]);
  });
});

describe("the whole connection", () => {
  const paired = (over: Partial<LocalProjectState> = {}) =>
    state({
      source: binding(),
      delivery: binding({ githubId: "987654321", name: "cluster-site", isPrivate: false }),
      ...over,
    });

  beforeEach(() => {
    byId["987654321"] = identity({
      githubId: "987654321",
      name: "cluster-site",
      isPrivate: false,
    });
  });

  it("is happy when both repositories check out", async () => {
    const report = await checkConnection(paired());
    expect(report.disabled).toEqual([]);
    expect(report.notes).toEqual([]);
  });

  /** One conversation, not two. */
  it("checks both even when the first has a problem", async () => {
    byId["123456789"] = new StudioError("repo.unavailable", "Gone.");
    byId["987654321"] = new StudioError("repo.unavailable", "Gone too.");
    const report = await checkConnection(paired());
    expect(report.source?.availability?.availability).toBe("unreachable");
    expect(report.delivery?.availability?.availability).toBe("unreachable");
    expect(report.disabled.sort()).toEqual(["publish", "sync"]);
  });

  it("collects the renames worth mentioning", async () => {
    byId["123456789"] = identity({ name: "cluster-config" });
    const report = await checkConnection(paired());
    expect(report.notes).toHaveLength(1);
    expect(report.notes[0]).toContain("renamed");
  });

  /** Unwritable is as disqualifying as unreachable. */
  it("switches off syncing when the project repository turns unwritable", async () => {
    byId["123456789"] = identity({ canPush: false });
    const report = await checkConnection(paired());
    expect(report.disabled.sort()).toEqual(["publish", "sync"]);
  });

  it("switches off only publishing when the site repository goes private", async () => {
    byId["987654321"] = identity({
      githubId: "987654321",
      name: "cluster-site",
      isPrivate: true,
    });
    const report = await checkConnection(paired());
    expect(report.disabled).toEqual(["publish"]);
  });

  it("does not look for a site repository on the paid topology", async () => {
    const report = await checkConnection(
      paired({ topology: "single-private" }),
    );
    expect(report.delivery).toBeNull();
    expect(report.disabled).toEqual([]);
  });
});
