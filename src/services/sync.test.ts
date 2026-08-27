import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioError } from "../model/errors";
import {
  decodeCommitMessage,
  EXTERNAL_CHANGES_ACTION,
  StructuredActionSchema,
  type StructuredAction,
} from "../model/commitActions";
import {
  LocalProjectStateSchema,
  newLocalProjectState,
  type LocalProjectState,
} from "../model/localState";
import { leaksGitTerms, SYNC_PHASE_LABELS } from "../model/syncState";

/**
 * The Sync orchestration, against a scripted repository.
 *
 * A fake at the `gitRepo` boundary rather than at `ipc`, because what is being
 * pinned down is the *sequence* — what is done before what, and what is only
 * recorded once the push has landed. The Rust side has its own tests against a
 * real bare repository for the parts that are actually Git.
 */

interface FakeRemote {
  /** Commit the remote branch points at. */
  head: string;
  /** Bumped to simulate somebody else pushing between our fetch and our push. */
  advanceOnNextPush: string | null;
}

let remote: FakeRemote;
let localHead: string;
let dirty: boolean;
let commits: { sha: string; message: string; parent: string }[];
let recoveryRefs: Set<string>;
let calls: string[];
let nextSha = 0;
let failFetchWith: StudioError | null;
/** Files the merged result was written back as, when reconciliation ran. */
let written: Record<string, string> | null;

vi.mock("./projectSession", () => ({
  snapshotProject: async () => {
    calls.push("snapshot");
    return "C:\\proj\\backups\\snapshots\\20260809-pre-sync";
  },
}));

vi.mock("./gitRepo", () => ({
  fetch: async () => {
    calls.push("fetch");
    if (failFetchWith) throw failFetchWith;
    return remote.head;
  },
  state: async () => {
    calls.push("state");
    return { head: localHead, remote: remote.head, dirty, branch: "main" };
  },
  commit: async (_dir: string, _branch: string, message: string) => {
    calls.push("commit");
    const sha = `c${++nextSha}`;
    commits.push({ sha, message, parent: localHead });
    localHead = sha;
    dirty = false;
    return sha;
  },
  push: async () => {
    calls.push("push");
    // Somebody else pushed while we were working.
    if (remote.advanceOnNextPush) {
      remote.head = remote.advanceOnNextPush;
      remote.advanceOnNextPush = null;
      return { pushed: false, rejected: true, commit: localHead };
    }
    remote.head = localHead;
    return { pushed: true, rejected: false, commit: localHead };
  },
  markRecovery: async (_dir: string, operationId: string) => {
    calls.push("markRecovery");
    recoveryRefs.add(operationId);
  },
  clearRecovery: async (_dir: string, operationId: string) => {
    calls.push("clearRecovery");
    recoveryRefs.delete(operationId);
  },
  fastForward: async () => {
    calls.push("fastForward");
    // The real one refuses over unsaved edits and over a divergence. A
    // divergence never reaches here — the orchestration routes that to
    // reconciliation — so the only refusal this fake needs is the dirty tree.
    if (dirty) {
      return {
        advanced: false,
        refused: "there are unsaved changes on this computer",
        commit: localHead,
      };
    }
    localHead = remote.head;
    return { advanced: true, refused: "", commit: remote.head };
  },
  readTree: async () => ({}),
  setRemote: async () => {},
  capabilities: async () => ({ version: "1.9.6", https: true, ssh: false, threads: true }),
}));

const { syncProject, describeWork, hasUnsharedWork, appendToJournal } = await import("./sync");

function action(over: Partial<StructuredAction> = {}): StructuredAction {
  return StructuredActionSchema.parse({ type: "creature.updated", ...over });
}

function localState(over: Partial<LocalProjectState> = {}): LocalProjectState {
  return LocalProjectStateSchema.parse({
    ...newLocalProjectState("project-1", "C:\\proj", "GG Fizz"),
    githubAccountId: "9",
    githubLogin: "ggfizz",
    source: {
      githubId: "123",
      owner: "ggfizz",
      name: "cluster-source",
      remoteUrl: "https://github.com/ggfizz/cluster-source.git",
      branch: "main",
      isPrivate: true,
    },
    ...over,
  });
}

/** A context whose local state is updated by `saveLocal`, as the real one is. */
function context(over: Partial<Parameters<typeof syncProject>[0]> = {}) {
  const state = { current: localState(over.local ? { ...over.local } : {}) };
  const phases: string[] = [];
  const ctx = {
    dir: "C:\\proj",
    projectId: "11111111-2222-4333-8444-555555555555",
    schemaVersion: 2,
    get local() {
      return state.current;
    },
    flush: async () => ({ ok: true, failures: [] as { fileName: string }[] }),
    readiness: () => ({ ready: true, reason: "" }),
    readLocalFiles: async () => {
      calls.push("readLocalFiles");
      return { "project.json": "{}" };
    },
    writeFiles: async (files: Record<string, string>) => {
      calls.push("writeFiles");
      written = files;
    },
    accountId: async () => "9",
    saveLocal: async (patch: Partial<LocalProjectState>) => {
      state.current = { ...state.current, ...patch };
    },
    onPhase: (p: string) => phases.push(p),
    ...over,
  };
  return { ctx: ctx as Parameters<typeof syncProject>[0], state, phases };
}

beforeEach(() => {
  remote = { head: "", advanceOnNextPush: null };
  localHead = "";
  dirty = true;
  commits = [];
  recoveryRefs = new Set();
  calls = [];
  nextSha = 0;
  failFetchWith = null;
  written = null;
});

describe("the first sync of a new project", () => {
  it("commits and pushes, and reports success", async () => {
    const { ctx } = context({ local: localState({ pendingActions: [action()] }) });
    const result = await syncProject(ctx);

    expect(result.kind).toBe("synchronized");
    expect(result.phase).toBe("synchronized");
    expect(result.commit).toBe("c1");
    expect(remote.head).toBe("c1");
  });

  it("takes a recovery snapshot before it commits anything", async () => {
    const { ctx } = context({ local: localState({ pendingActions: [action()] }) });
    await syncProject(ctx);
    expect(calls.indexOf("snapshot")).toBeLessThan(calls.indexOf("commit"));
  });

  it("writes one commit, not one per change", async () => {
    const { ctx } = context({
      local: localState({
        pendingActions: [
          action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
          action({ type: "creature.updated", id: "r1", fields: ["interval"] }),
          action({ type: "mod.added", id: "1431447" }),
        ],
      }),
    });
    await syncProject(ctx);
    expect(commits).toHaveLength(1);
  });

  it("puts the collapsed journal into the commit as structured actions", async () => {
    const { ctx } = context({
      local: localState({
        pendingActions: [
          action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
          action({ type: "creature.updated", id: "r1", fields: ["interval"] }),
          action({ type: "mod.added", id: "1431447" }),
        ],
      }),
    });
    await syncProject(ctx);

    const decoded = decodeCommitMessage(commits[0].message);
    expect(decoded.subject).toBe("Updated creature and mod configuration");
    expect(decoded.projectId).toBe("11111111-2222-4333-8444-555555555555");
    expect(decoded.schemaVersion).toBe(2);
    expect(decoded.operationId).not.toBe("");
    expect(decoded.actor).toBe("ggfizz");
    expect(decoded.actions).toHaveLength(2);
    expect(decoded.actions[0].fields).toEqual(["displayName", "interval"]);
  });

  /**
   * Sync never handles a credential at all — it names an account, and Rust
   * looks the token up. So there is nothing here that *could* reach a commit.
   */
  it("carries an account id, never a credential", async () => {
    const { ctx } = context({ local: localState({ pendingActions: [action()] }) });
    await syncProject(ctx);
    expect(commits[0].message).not.toMatch(/github_pat_|ghp_/);
  });
});

describe("recording the synchronized point", () => {
  it("clears the journal and records the commit, but only after the push", async () => {
    const { ctx, state } = context({
      local: localState({ pendingActions: [action()] }),
    });
    await syncProject(ctx);

    expect(state.current.lastSyncedCommit).toBe("c1");
    expect(state.current.pendingActions).toEqual([]);
    expect(state.current.pending).toBeNull();
    expect(calls.indexOf("push")).toBeLessThan(calls.lastIndexOf("clearRecovery"));
  });

  /**
   * The journal is the only record of what an afternoon's work *was*. Losing it
   * to a failed push would turn the next Sync's commit into "files changed".
   */
  it("keeps the journal when the push never lands", async () => {
    failFetchWith = new StudioError("network.offline", "No connection.");
    const { ctx, state } = context({
      local: localState({ pendingActions: [action({ id: "r1" })] }),
    });
    await syncProject(ctx);

    expect(state.current.pendingActions).toHaveLength(1);
    expect(state.current.lastSyncedCommit).toBe("");
  });

  it("leaves a pending record behind when it is interrupted", async () => {
    failFetchWith = new StudioError("network.offline", "No connection.");
    const { ctx, state } = context({ local: localState({ pendingActions: [action()] }) });
    await syncProject(ctx);

    expect(state.current.pending?.kind).toBe("sync");
    expect(state.current.pending?.recoveryRef).toContain("snapshots");
  });
});

describe("when nothing has changed", () => {
  it("says so without writing a commit", async () => {
    dirty = false;
    localHead = "c0";
    remote.head = "c0";
    const { ctx } = context({ local: localState({ lastSyncedCommit: "c0" }) });
    const result = await syncProject(ctx);

    expect(result.kind).toBe("already-synchronized");
    expect(commits).toHaveLength(0);
    expect(calls).not.toContain("push");
  });
});

/** A reconciler that always merges cleanly, for exercising the race loop. */
const alwaysMerges = async () => ({
  merged: true,
  files: {},
  actions: [] as StructuredAction[],
  conflicts: { count: 0, domains: [] as string[] },
});

describe("when the branch moves under us", () => {
  /**
   * The race this design exists for: two administrators pushing at once.
   *
   * The loser does not retry the same push. It goes back to the fetch, and
   * because the remote has now moved while this computer holds a commit of its
   * own, that second pass is a genuine reconciliation — which is exactly right,
   * and is why a rejection can never be resolved by forcing.
   */
  it("goes round again through reconciliation and succeeds", async () => {
    remote.advanceOnNextPush = "theirs";
    const { ctx } = context({
      local: localState({ pendingActions: [action()] }),
      reconcile: alwaysMerges,
    });
    const result = await syncProject(ctx);

    expect(result.kind).toBe("integrated");
    expect(result.retries).toBe(1);
    expect(calls.filter((c) => c === "fetch")).toHaveLength(2);
    expect(calls.filter((c) => c === "push")).toHaveLength(2);
    expect(remote.head).toBe(localHead);
  });

  it("gives up politely rather than looping forever", async () => {
    const { ctx } = context({
      local: localState({ pendingActions: [action()] }),
      reconcile: alwaysMerges,
    });
    // Every push loses, forever.
    let round = 0;
    const gitRepo = await import("./gitRepo");
    vi.spyOn(gitRepo, "push").mockImplementation(async () => {
      calls.push("push");
      round += 1;
      remote.head = "theirs-" + round;
      return { pushed: false, rejected: true, commit: localHead };
    });

    const result = await syncProject(ctx);
    expect(result.kind).toBe("blocked");
    expect(result.message).toContain("Your work is safe here");
    expect(leaksGitTerms(result.message)).toEqual([]);
    vi.restoreAllMocks();
  });
});

describe("when only the other administrators changed things", () => {
  /** The common case on a machine that has been closed for a week. */
  it("takes their work without writing a commit of its own", async () => {
    dirty = false;
    localHead = "base";
    remote.head = "theirs";
    const { ctx, state } = context({ local: localState({ lastSyncedCommit: "base" }) });

    const result = await syncProject(ctx);
    expect(result.kind).toBe("integrated");
    expect(result.phase).toBe("synchronized");
    expect(result.syncedCommit).toBe("theirs");
    expect(commits).toHaveLength(0);
    expect(calls).toContain("fastForward");
    expect(state.current.lastSyncedCommit).toBe("theirs");
  });

  it("does not ask the reconciler for work that is only theirs", async () => {
    dirty = false;
    localHead = "base";
    remote.head = "theirs";
    const reconcile = vi.fn(alwaysMerges);
    const { ctx } = context({ local: localState({ lastSyncedCommit: "base" }), reconcile });
    await syncProject(ctx);
    expect(reconcile).not.toHaveBeenCalled();
  });

  /** Never checked out over — the one thing that must not happen. */
  it("refuses to take their work over an unsaved edit", async () => {
    dirty = true;
    localHead = "base";
    remote.head = "theirs";
    const { ctx, state } = context({ local: localState({ lastSyncedCommit: "base" }) });
    // `dirty` makes this locally-moved too, so it routes to reconciliation
    // rather than to a checkout. Either way, nothing is overwritten.
    const result = await syncProject(ctx);
    expect(result.error?.code).toBe("sync.conflictsPending");
    expect(state.current.lastSyncedCommit).toBe("base");
  });
});

describe("when both sides changed", () => {
  beforeEach(() => {
    localHead = "mine";
    remote.head = "theirs";
    dirty = true;
  });

  it("asks the reconciler, and commits what it merged", async () => {
    const reconcile = vi.fn(async () => ({
      merged: true,
      files: {},
      actions: [action({ type: "creature.updated", id: "theirs-r2", label: "Argentavis" })],
      conflicts: { count: 0, domains: [] },
    }));
    const { ctx } = context({
      local: localState({ lastSyncedCommit: "base", pendingActions: [action({ id: "r1" })] }),
      reconcile,
    });

    const result = await syncProject(ctx);
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ base: "base", localCommit: "mine", remoteCommit: "theirs" }),
    );
    expect(result.kind).toBe("integrated");
    expect(decodeCommitMessage(commits[0].message).actions).toHaveLength(2);
  });

  /**
   * The merged project reaches disk before it is recorded, so what the commit
   * contains is exactly what the administrator is looking at afterwards.
   */
  it("writes the merged files before it commits them", async () => {
    const { ctx } = context({
      local: localState({ lastSyncedCommit: "base", pendingActions: [action()] }),
      reconcile: async () => ({
        merged: true,
        files: { "project.json": '{"merged":true}' },
        actions: [],
        conflicts: { count: 0, domains: [] },
      }),
    });
    await syncProject(ctx);

    expect(written).toEqual({ "project.json": '{"merged":true}' });
    expect(calls.indexOf("writeFiles")).toBeLessThan(calls.indexOf("commit"));
  });

  it("writes nothing when a decision is still needed", async () => {
    const { ctx } = context({
      local: localState({ lastSyncedCommit: "base", pendingActions: [action()] }),
      reconcile: async () => ({
        merged: false,
        files: { "project.json": '{"half":true}' },
        actions: [],
        conflicts: { count: 1, domains: ["creature"] },
      }),
    });
    await syncProject(ctx);
    expect(written).toBeNull();
  });

  it("stops and asks when a decision is genuinely needed", async () => {
    const { ctx, state } = context({
      local: localState({ lastSyncedCommit: "base", pendingActions: [action()] }),
      reconcile: async () => ({
        merged: false,
        files: {},
        actions: [],
        conflicts: { count: 3, domains: ["creature", "mod"] },
      }),
    });

    const result = await syncProject(ctx);
    expect(result.kind).toBe("needs-decision");
    expect(result.phase).toBe("needs-decision");
    expect(result.conflicts?.count).toBe(3);
    expect(commits).toHaveLength(0);
    // Nothing is recorded as synchronized, and the journal survives.
    expect(state.current.lastSyncedCommit).toBe("base");
    expect(state.current.pendingActions).toHaveLength(1);
    expect(state.current.pending?.stage).toBe("awaiting-decision");
  });

  /**
   * Without a reconciler, committing on top of the remote would keep the other
   * administrator's commit in history while replacing every file in it. Refusing
   * is the only honest answer.
   */
  it("refuses rather than overwriting when it cannot reconcile", async () => {
    const { ctx } = context({
      local: localState({ lastSyncedCommit: "base", pendingActions: [action()] }),
    });
    const result = await syncProject(ctx);

    expect(result.error?.code).toBe("sync.conflictsPending");
    expect(commits).toHaveLength(0);
    expect(remote.head).toBe("theirs");
  });

});

describe("refusing before anything is attempted", () => {
  it("will not sync work that is not on disk", async () => {
    const { ctx } = context({
      flush: async () => ({ ok: false, failures: [{ fileName: "players.json" }] }),
    });
    const result = await syncProject(ctx);

    expect(result.error?.code).toBe("save.failed");
    expect(calls).not.toContain("fetch");
    expect(result.message).toContain("not saved");
  });

  it("respects a project-level blocker", async () => {
    const { ctx } = context({
      readiness: () => ({
        ready: false,
        reason: "This project is open for viewing only.",
        code: "project.schemaTooNew" as const,
      }),
    });
    const result = await syncProject(ctx);
    expect(result.error?.code).toBe("project.schemaTooNew");
    expect(calls).not.toContain("fetch");
  });

  it("asks for a sign-in rather than failing obscurely", async () => {
    const { ctx } = context({
      accountId: async () => {
        throw new StudioError("auth.missing", "No GitHub sign-in stored.");
      },
    });
    const result = await syncProject(ctx);
    expect(result.error?.code).toBe("auth.missing");
    expect(result.phase).toBe("access-expired");
  });

  it("asks for a sign-in when no account is bound yet", async () => {
    const { ctx } = context({ accountId: async () => "" });
    const result = await syncProject(ctx);
    expect(result.error?.code).toBe("auth.missing");
    expect(calls).not.toContain("fetch");
  });
});

describe("offline", () => {
  it("keeps the work and says plainly that nothing was sent", async () => {
    failFetchWith = new StudioError("network.offline", "Cannot reach GitHub.");
    const { ctx, state } = context({
      local: localState({ pendingActions: [action({ id: "r1" })] }),
    });
    const result = await syncProject(ctx);

    expect(result.kind).toBe("offline");
    expect(result.phase).toBe("offline");
    expect(state.current.pendingActions).toHaveLength(1);
    // It must not claim success.
    expect(result.commit).toBe("");
    expect(result.syncedCommit).toBe("");
  });

  it("succeeds on the retry once the connection is back", async () => {
    failFetchWith = new StudioError("network.offline", "Cannot reach GitHub.");
    const { ctx } = context({
      local: localState({ pendingActions: [action({ id: "r1" })] }),
    });
    await syncProject(ctx);
    expect(commits).toHaveLength(0);

    failFetchWith = null;
    const second = await syncProject(ctx);
    expect(second.kind).toBe("synchronized");
    expect(second.commit).toBe("c1");
  });
});

describe("changes made outside Studio", () => {
  it("is recorded rather than described as nothing", () => {
    const actions = describeWork([], [], true);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe(EXTERNAL_CHANGES_ACTION);
  });

  it("is not claimed when Studio knows what it did", () => {
    const journal = [action({ id: "r1" })];
    expect(describeWork(journal, [], true)).toEqual(journal);
  });

  it("reaches the commit when the project was edited by hand", async () => {
    const { ctx } = context({ local: localState({ pendingActions: [] }) });
    await syncProject(ctx);
    expect(decodeCommitMessage(commits[0].message).subject).toBe(
      "Recorded changes made outside Studio",
    );
  });
});

describe("the journal", () => {
  it("appends in the order things happened", () => {
    const state = localState();
    const once = appendToJournal(state, action({ id: "a" }));
    const twice = appendToJournal({ ...state, pendingActions: once }, action({ id: "b" }));
    expect(twice.map((a) => a.id)).toEqual(["a", "b"]);
  });

  it("knows there is unshared work from the journal alone", () => {
    expect(
      hasUnsharedWork(localState({ pendingActions: [action()] }), {
        head: "c1",
        dirty: false,
      }),
    ).toBe(true);
  });

  /** A hand-edited file is unshared work too, and nothing recorded it. */
  it("knows there is unshared work from a changed file alone", () => {
    expect(hasUnsharedWork(localState({ lastSyncedCommit: "c1" }), { head: "c1", dirty: true }))
      .toBe(true);
  });

  it("knows there is unshared work from a commit ahead of the synced point", () => {
    expect(hasUnsharedWork(localState({ lastSyncedCommit: "c1" }), { head: "c2", dirty: false }))
      .toBe(true);
  });

  it("reports nothing to share when everything agrees", () => {
    expect(hasUnsharedWork(localState({ lastSyncedCommit: "c1" }), { head: "c1", dirty: false }))
      .toBe(false);
  });
});

describe("what the administrator is shown", () => {
  it("never uses Git vocabulary in a phase label", () => {
    for (const [phase, label] of Object.entries(SYNC_PHASE_LABELS)) {
      expect(leaksGitTerms(label), `${phase}: ${label}`).toEqual([]);
    }
  });

  it("never uses Git vocabulary in an outcome message", async () => {
    const cases: (() => Promise<{ message: string }>)[] = [
      async () => syncProject(context({ local: localState({ pendingActions: [action()] }) }).ctx),
      async () => {
        failFetchWith = new StudioError("network.offline", "Cannot reach GitHub.");
        return syncProject(context().ctx);
      },
      async () => {
        localHead = "mine";
        remote.head = "theirs";
        return syncProject(
          context({ local: localState({ lastSyncedCommit: "base" }) }).ctx,
        );
      },
    ];
    for (const run of cases) {
      const result = await run();
      expect(leaksGitTerms(result.message), result.message).toEqual([]);
    }
  });

  it("reports progress in the order the administrator sees it", async () => {
    const { ctx, phases } = context({ local: localState({ pendingActions: [action()] }) });
    await syncProject(ctx);
    expect(phases).toEqual(["checking", "sending"]);
  });

  it("says it is integrating while it brings in the team's work", async () => {
    dirty = false;
    localHead = "base";
    remote.head = "theirs";
    const { ctx, phases } = context({ local: localState({ lastSyncedCommit: "base" }) });
    await syncProject(ctx);
    expect(phases).toEqual(["checking", "integrating"]);
  });
});
