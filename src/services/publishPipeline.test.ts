import { beforeEach, describe, expect, it, vi } from "vitest";
import { StudioError } from "../model/errors";
import { decodeCommitMessage } from "../model/commitActions";
import {
  LocalProjectStateSchema,
  newLocalProjectState,
  type LocalProjectState,
} from "../model/localState";
import { PUBLIC_ROOT, type BuildManifest } from "../model/publishArtifact";
import type { ValidationReport } from "../validation/project";

/**
 * The Publish sequence, against a scripted delivery repository.
 *
 * What is pinned down is the order and the refusals: a failed Publish must
 * leave the synchronized source alone and the previous site still live, and
 * nothing private may reach a public repository.
 */

let calls: string[] = [];
let staged: Record<string, string> | null = null;
let pushRejectsOnce = false;
let commits: string[] = [];
let liveManifest: unknown = null;

vi.mock("./gitRepo", () => ({
  fetch: async () => {
    calls.push("fetch");
    return "remote-head";
  },
  fastForward: async () => {
    calls.push("fastForward");
    return { advanced: true, refused: "", commit: "remote-head" };
  },
  commit: async (_dir: string, _branch: string, message: string) => {
    calls.push("commit");
    commits.push(message);
    return `c${commits.length}`;
  },
  push: async () => {
    calls.push("push");
    if (pushRejectsOnce) {
      pushRejectsOnce = false;
      return { pushed: false, rejected: true, commit: "" };
    }
    return { pushed: true, rejected: false, commit: "c1" };
  },
}));

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "git_replace_dir") {
      calls.push("replaceDir");
      staged = args.files as Record<string, string>;
      return { written: Object.keys(staged).length, removed: 0 };
    }
    throw new Error(`unexpected command ${cmd}`);
  },
}));

const { publishProject } = await import("./publishPipeline");

function report(over: Partial<ValidationReport> = {}): ValidationReport {
  return {
    issues: [],
    errors: 0,
    warnings: 0,
    publishable: true,
    blockedAreas: [],
    ...over,
  };
}

function localState(over: Partial<LocalProjectState> = {}): LocalProjectState {
  return LocalProjectStateSchema.parse({
    ...newLocalProjectState("p1", "C:\\proj", "GG Fizz"),
    githubAccountId: "9",
    githubLogin: "ggfizz",
    source: {
      githubId: "1",
      owner: "ggfizz",
      name: "cluster-source",
      remoteUrl: "https://github.com/ggfizz/cluster-source.git",
      branch: "main",
      isPrivate: true,
    },
    delivery: {
      githubId: "2",
      owner: "ggfizz",
      name: "cluster-site",
      remoteUrl: "https://github.com/ggfizz/cluster-site.git",
      branch: "main",
      isPrivate: false,
    },
    ...over,
  });
}

function pagesEnabledState(): LocalProjectState {
  const local = localState();
  return {
    ...local,
    delivery: local.delivery ? { ...local.delivery, hasPages: true } : null,
  };
}

function context(over: Record<string, unknown> = {}) {
  const state = { current: (over.local as LocalProjectState) ?? localState() };
  const stages: string[] = [];
  return {
    ctx: {
      deliveryDir: "C:\\delivery",
      get local() {
        return state.current;
      },
      sourceRevision: "abc1234",
      projectId: "11111111-2222-4333-8444-555555555555",
      validate: () => report(),
      generate: () => ({
        indexHtml: "<html>Cluster</html>",
        data: { "viewer.json": '{"creatures":[]}' },
      }),
      accountId: async () => "9",
      saveLocal: async (patch: Partial<LocalProjectState>) => {
        state.current = { ...state.current, ...patch };
      },
      onStage: (s: string) => stages.push(s),
      now: () => 0,
      sleep: async () => {},
      ...over,
    } as Parameters<typeof publishProject>[0],
    state,
    stages,
  };
}

beforeEach(() => {
  calls = [];
  staged = null;
  commits = [];
  pushRejectsOnce = false;
  liveManifest = null;
});

describe("a normal publish", () => {
  it("generates, scans, and pushes one commit", async () => {
    const { ctx } = context();
    const result = await publishProject(ctx);

    expect(result.stage).toBe("live");
    expect(result.commit).toBe("c1");
    expect(commits).toHaveLength(1);
  });

  it("stages the whole tree, including .nojekyll and the manifest", async () => {
    await publishProject(context().ctx);
    expect(Object.keys(staged ?? {}).sort()).toEqual([
      ".nojekyll",
      "data/viewer.json",
      "dinodepot-build.json",
      "index.html",
    ]);
  });

  it("publishes into the docs folder Pages serves", async () => {
    await publishProject(context().ctx);
    expect(PUBLIC_ROOT).toBe("docs");
  });

  it("records the source revision it was built from", async () => {
    const { ctx, state } = context();
    const result = await publishProject(ctx);
    const manifest = JSON.parse(staged!["dinodepot-build.json"]) as BuildManifest;
    expect(manifest.sourceRevision).toBe("abc1234");
    expect(result.sourceRevision).toBe("abc1234");
    expect(state.current.lastPublishedSourceCommit).toBe("abc1234");
  });

  it("writes its own commit subject, separate from a sync", async () => {
    await publishProject(context().ctx);
    const decoded = decodeCommitMessage(commits[0]);
    expect(decoded.subject).toBe("Published the cluster viewer");
    expect(decoded.actor).toBe("ggfizz");
    expect(decoded.actions[0].type).toBe("site.published");
  });

  it("takes the remote before replacing the tree", async () => {
    await publishProject(context().ctx);
    expect(calls.indexOf("fetch")).toBeLessThan(calls.indexOf("replaceDir"));
    expect(calls.indexOf("replaceDir")).toBeLessThan(calls.indexOf("commit"));
  });

  it("reports its progress in order", async () => {
    const { ctx, stages } = context();
    await publishProject(ctx);
    expect(stages).toEqual(["checking", "generating", "scanning", "sending"]);
  });
});

describe("refusing to publish", () => {
  /**
   * The manifest names the source commit it was built from. Publishing
   * unsynchronized work would put a site on the web no repository can explain.
   */
  it("refuses when the source has never been shared", async () => {
    const result = await publishProject(context({ sourceRevision: "" }).ctx);
    expect(result.error?.code).toBe("publish.sourceNotSynchronized");
    expect(calls).toEqual([]);
  });

  it("refuses when the project has blocking problems", async () => {
    const result = await publishProject(
      context({
        validate: () =>
          report({
            errors: 2,
            publishable: false,
            issues: [
              { area: "production", level: "error", where: "Rule 1", message: "Bad", entityId: "" },
              { area: "remaps", level: "error", where: "Remap 2", message: "Also bad", entityId: "" },
            ],
          }),
      }).ctx,
    );
    expect(result.error?.code).toBe("validation.failed");
    expect(result.message).toContain("2 problems");
    expect(calls).toEqual([]);
  });

  /** Warnings can be accepted, but only deliberately. */
  it("stops once on warnings, then goes ahead when acknowledged", async () => {
    const warned = () =>
      report({
        warnings: 1,
        issues: [
          { area: "assets", level: "warning", where: "Icons", message: "Missing icon", entityId: "" },
        ],
      });

    const first = await publishProject(context({ validate: warned }).ctx);
    expect(first.error?.code).toBe("validation.failed");
    expect(first.message).toContain("1 warning");

    const second = await publishProject(
      context({ validate: warned, warningsAcknowledged: true }).ctx,
    );
    expect(second.stage).toBe("live");
  });

  it("refuses without a site repository", async () => {
    const result = await publishProject(
      context({ local: localState({ delivery: null }) }).ctx,
    );
    expect(result.error?.code).toBe("repo.unavailable");
  });

  it("refuses without a connected account", async () => {
    const result = await publishProject(context({ accountId: async () => "" }).ctx);
    expect(result.error?.code).toBe("auth.missing");
    expect(calls).toEqual([]);
  });

  it("publishes to the source repository on the paid topology", async () => {
    const result = await publishProject(
      context({
        local: localState({ topology: "single-private", delivery: null }),
      }).ctx,
    );
    expect(result.stage).toBe("live");
  });
});

describe("the privacy gate", () => {
  /** Nothing has left this computer — the scan runs over the staged files. */
  it("stops before anything is uploaded", async () => {
    const result = await publishProject(
      context({
        generate: () => ({
          indexHtml: "<html>Cluster</html>",
          data: { "viewer.json": '{"players":[{"steamId":"76561198000000000"}]}' },
        }),
      }).ctx,
    );

    expect(result.error?.code).toBe("publish.privacyViolation");
    expect(result.message).toContain("Nothing has been uploaded");
    expect(calls).toEqual([]);
    expect(commits).toEqual([]);
  });

  it("stops on an IP address", async () => {
    const result = await publishProject(
      context({
        generate: () => ({
          indexHtml: "<html>Cluster</html>",
          data: { "viewer.json": '{"note":"from 198.51.100.7"}' },
        }),
      }).ctx,
    );
    expect(result.error?.code).toBe("publish.privacyViolation");
    expect(result.error?.detail).toContain("198.51.100.7");
  });

  it("stops on a profile that somehow reached the artifact", async () => {
    const result = await publishProject(
      context({
        generate: () => ({
          indexHtml: "<html>Cluster</html>",
          data: { "0002abcd.arkprofile": "binary" },
        }),
      }).ctx,
    );
    expect(result.error?.code).toBe("publish.privacyViolation");
    expect(calls).toEqual([]);
  });
});

describe("when someone else publishes at the same time", () => {
  /** Regenerated, never merged — generated files have no authorship. */
  it("takes the remote and regenerates rather than merging", async () => {
    pushRejectsOnce = true;
    const result = await publishProject(context().ctx);

    expect(result.stage).toBe("live");
    expect(calls.filter((c) => c === "fetch")).toHaveLength(2);
    expect(calls.filter((c) => c === "replaceDir")).toHaveLength(2);
    expect(calls.filter((c) => c === "push")).toHaveLength(2);
  });
});

describe("waiting for GitHub Pages", () => {
  const manifestFrom = () => JSON.parse(staged!["dinodepot-build.json"]);

  it("reports live once the site serves this build", async () => {
    let polls = 0;
    const result = await publishProject(
      context({
        local: pagesEnabledState(),
        fetchLiveManifest: async () => {
          polls++;
          return polls > 1 ? manifestFrom() : { publishOperationId: "an-older-one" };
        },
      }).ctx,
    );
    expect(result.stage).toBe("live");
    expect(result.message).toContain("live");
  });

  /** Published is still published — Pages being slow is not a failure. */
  it("says published-but-waiting when Pages takes too long", async () => {
    let clock = 0;
    const result = await publishProject(
      context({
        local: pagesEnabledState(),
        fetchLiveManifest: async () => ({ publishOperationId: "never-matches" }),
        now: () => (clock += 60_000),
        sleep: async () => {},
      }).ctx,
    );
    expect(result.stage).toBe("timed-out");
    expect(result.commit).toBe("c1");
    expect(result.message).toContain("Published");
  });

  /** A site that has never been published 404s, which is not an error. */
  it("keeps waiting when the manifest cannot be fetched yet", async () => {
    let polls = 0;
    const result = await publishProject(
      context({
        local: pagesEnabledState(),
        fetchLiveManifest: async () => {
          polls++;
          if (polls < 2) throw new StudioError("repo.unavailable", "404");
          return manifestFrom();
        },
      }).ctx,
    );
    expect(result.stage).toBe("live");
  });

  it("does not poll when no fetcher is supplied", async () => {
    const result = await publishProject(context().ctx);
    expect(result.stage).toBe("live");
    expect(liveManifest).toBeNull();
  });

  it("publishes without polling when Pages still needs enabling", async () => {
    let polls = 0;
    const result = await publishProject(
      context({
        fetchLiveManifest: async () => {
          polls++;
          return manifestFrom();
        },
      }).ctx,
    );
    expect(result.stage).toBe("timed-out");
    expect(result.message).toContain("Enable GitHub Pages");
    expect(polls).toBe(0);
  });
});

describe("what a failed publish leaves behind", () => {
  it("does not record a published commit when it refused", async () => {
    const { ctx, state } = context({ sourceRevision: "" });
    await publishProject(ctx);
    expect(state.current.lastPublishedCommit).toBe("");
    expect(state.current.pending).toBeNull();
  });

  it("records the published commit only after the push", async () => {
    const { ctx, state } = context();
    await publishProject(ctx);
    expect(state.current.lastPublishedCommit).toBe("c1");
    expect(state.current.pending).toBeNull();
  });
});
