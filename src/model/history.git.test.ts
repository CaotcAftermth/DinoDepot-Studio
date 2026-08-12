import { describe, expect, it } from "vitest";
import { encodeCommitMessage, StructuredActionSchema } from "./commitActions";
import {
  buildHistory,
  isRestorable,
  restoreSubject,
  summarizeEntry,
  toHistoryEntry,
  type CommitSummary,
} from "./history.git";
import { leaksGitTerms } from "./syncState";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function action(type: string, over: Record<string, unknown> = {}) {
  return StructuredActionSchema.parse({ type, ...over });
}

function commit(over: Partial<CommitSummary> = {}): CommitSummary {
  return {
    sha: "abc1234def5678901234567890",
    message: encodeCommitMessage({
      projectId: "p1",
      schemaVersion: 2,
      operationId: "op-1",
      actions: [action("creature.updated", { id: "r1", label: "Rex", fields: ["interval"] })],
    }),
    at: NOW.getTime() - 3600_000,
    author: "DinoDepot Studio",
    isHead: true,
    ...over,
  };
}

describe("turning a commit into a row", () => {
  it("uses the subject as written, for a person", () => {
    const entry = toHistoryEntry(commit(), NOW);
    expect(entry.title).toBe("Updated creature configuration");
    expect(entry.fromStudio).toBe(true);
  });

  it("describes each change from the trailers", () => {
    const entry = toHistoryEntry(commit(), NOW);
    expect(entry.details).toEqual(["Changed interval on creature Rex"]);
  });

  it("shows the time the way the activity list always has", () => {
    expect(toHistoryEntry(commit(), NOW).when).not.toBe("");
  });

  it("keeps the sha for Advanced details only", () => {
    const entry = toHistoryEntry(commit(), NOW);
    expect(entry.shortSha).toBe("abc1234");
    expect(entry.title).not.toContain("abc1234");
  });

  /**
   * Somebody editing a file through the GitHub web UI is a real event. Hiding
   * it would make the list disagree with the repository.
   */
  it("still makes a row for a commit DinoDepot did not write", () => {
    const entry = toHistoryEntry(
      commit({ message: "Update players.json\n\nEdited on github.com", isHead: false }),
      NOW,
    );
    expect(entry.fromStudio).toBe(false);
    expect(entry.title).toBe("Update players.json");
    expect(entry.details).toEqual([]);
  });

  it("says something for a commit with no message at all", () => {
    expect(toHistoryEntry(commit({ message: "" }), NOW).title).toBe("Changed the project");
  });

  /** Counted, not hidden — the row must not claim less happened than did. */
  it("counts changes a newer Studio described in a way this one cannot read", () => {
    const entry = toHistoryEntry(
      commit({
        message: [
          "Updated creature configuration",
          "",
          "DinoDepot-Project: p1",
          'DinoDepot-Action: {"type":"creature.updated","id":"r1"}',
          "DinoDepot-Action: { not json",
        ].join("\n"),
      }),
      NOW,
    );
    expect(entry.details).toHaveLength(1);
    expect(entry.undescribed).toBe(1);
  });
});

describe("which page a row belongs to", () => {
  const kindFor = (type: string) =>
    toHistoryEntry(
      commit({
        message: encodeCommitMessage({
          projectId: "p1",
          schemaVersion: 2,
          operationId: "op-1",
          actions: [action(type, { id: "x" })],
        }),
      }),
      NOW,
    ).kind;

  it("sends each domain to its own page", () => {
    expect(kindFor("creature.updated")).toBe("production");
    expect(kindFor("remap.added")).toBe("remap");
    expect(kindFor("cosmetic.added")).toBe("cosmetics");
    expect(kindFor("mod.added")).toBe("source");
    expect(kindFor("player.updated")).toBe("players");
    expect(kindFor("settings.updated")).toBe("settings");
  });

  it("recognises a publish", () => {
    expect(kindFor("site.published")).toBe("publish");
    expect(
      toHistoryEntry(
        commit({
          message: encodeCommitMessage({
            projectId: "p1",
            schemaVersion: 0,
            operationId: "op-1",
            subject: "Published the cluster viewer",
            actions: [action("site.published", { id: "abc" })],
          }),
        }),
        NOW,
      ).isPublish,
    ).toBe(true);
  });

  it("falls back rather than leaving a row unclickable", () => {
    expect(kindFor("something.brandNew")).toBe("source");
  });
});

describe("the history list", () => {
  it("keeps the order it was given", () => {
    const entries = buildHistory(
      [commit({ sha: "newest0", isHead: true }), commit({ sha: "older00", isHead: false })],
      10,
      NOW,
    );
    expect(entries.map((e) => e.shortSha)).toEqual(["newest0", "older00"]);
  });

  it("respects the limit", () => {
    const commits = Array.from({ length: 30 }, (_, i) => commit({ sha: `c${i}`.padEnd(7, "0") }));
    expect(buildHistory(commits, 5, NOW)).toHaveLength(5);
  });

  it("copes with a project that has no history yet", () => {
    expect(buildHistory([], 10, NOW)).toEqual([]);
  });
});

describe("summarising a row", () => {
  const withActions = (types: string[]) =>
    toHistoryEntry(
      commit({
        message: encodeCommitMessage({
          projectId: "p1",
          schemaVersion: 2,
          operationId: "op-1",
          actions: types.map((t, i) => action(t, { id: `x${i}`, label: `Thing ${i}` })),
        }),
      }),
      NOW,
    );

  it("lists a few changes", () => {
    expect(summarizeEntry(withActions(["creature.added", "mod.added"]))).toBe(
      "Added creature Thing 0 · Added mod Thing 1",
    );
  });

  /** "12 changes" beats the first two and an ellipsis. */
  it("counts them once there are too many to read", () => {
    expect(
      summarizeEntry(withActions(["creature.added", "mod.added", "remap.added", "player.added"])),
    ).toBe("4 changes");
  });

  it("is empty when there is nothing to say", () => {
    expect(summarizeEntry(toHistoryEntry(commit({ message: "Initial commit" }), NOW))).toBe("");
  });
});

describe("restoring", () => {
  /** Nothing to do, so it is not offered. */
  it("is not offered for the current version", () => {
    expect(isRestorable(toHistoryEntry(commit({ isHead: true }), NOW))).toBe(false);
  });

  it("is offered for an older version", () => {
    expect(isRestorable(toHistoryEntry(commit({ isHead: false }), NOW))).toBe(true);
  });

  /** A publish lives in the delivery repository, which is regenerated. */
  it("is not offered for a publish", () => {
    const entry = toHistoryEntry(
      commit({
        isHead: false,
        message: encodeCommitMessage({
          projectId: "p1",
          schemaVersion: 0,
          operationId: "op-1",
          subject: "Published the cluster viewer",
          actions: [action("site.published", { id: "abc" })],
        }),
      }),
      NOW,
    );
    expect(isRestorable(entry)).toBe(false);
  });

  /**
   * Restoring makes a new commit on top rather than resetting, because history
   * is shared. The wording says so.
   */
  it("is worded as going back, not undoing", () => {
    const subject = restoreSubject(toHistoryEntry(commit({ isHead: false }), NOW));
    expect(subject).toContain("Went back to");
    expect(subject.toLowerCase()).not.toContain("revert");
    expect(subject.toLowerCase()).not.toContain("reset");
  });
});

describe("what the administrator reads", () => {
  it("never uses Git vocabulary", () => {
    const entry = toHistoryEntry(commit({ isHead: false }), NOW);
    const text = [entry.title, ...entry.details, summarizeEntry(entry), restoreSubject(entry)].join(
      " ",
    );
    expect(leaksGitTerms(text), text).toEqual([]);
  });
});
