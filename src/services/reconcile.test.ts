import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROJECT_FILE } from "../model/project";
import { ProductionDraftSchema } from "../model/production";
import { PlayersFileSchema } from "../model/players";
import { leaksGitTerms } from "../model/syncState";
import { describeConflict, displayValue } from "../model/merge/conflicts";

/**
 * Reconciliation end to end: three versions of a project in, one merged project
 * plus a list of questions out.
 *
 * The Git layer is faked at the tree-reading boundary — what matters here is
 * what happens to the *contents*, and the real tree reading has its own tests
 * against a bare repository in Rust.
 */

let trees: Record<string, Record<string, string>>;

vi.mock("./gitRepo", () => ({
  readTree: async (_dir: string, commit: string) => {
    const tree = trees[commit];
    if (!tree) throw new Error(`no such commit ${commit}`);
    return tree;
  },
}));

const { reconcile, applyAnswers, MERGED_FILES } = await import("./reconcile");

const cycle = (id: string) => ({
  id,
  name: "",
  intervalSeconds: 300,
  itemSelectMode: 0,
  items: [],
});

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  notes: "",
  dinoType: `/Game/Dinos/${id}.${id}`,
  chanceToProduce: 1,
  cycles: [cycle(`${id}-c1`)],
  ...over,
});

const production = (rules: unknown[]) =>
  `${JSON.stringify({ schemaVersion: 1, rules }, null, 2)}\n`;

function parseProduction(files: Record<string, string>) {
  return ProductionDraftSchema.parse(JSON.parse(files[PROJECT_FILE.production]));
}

const input = (localFiles: Record<string, string>) => ({
  input: {
    base: "base",
    localCommit: "mine",
    remoteCommit: "theirs",
    dir: "C:\\proj",
    localFiles,
  },
  localFiles,
});

beforeEach(() => {
  trees = {};
});

describe("reconciling a project", () => {
  it("merges edits to different creatures with no questions", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a"), rule("b")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a"), rule("b", { enabled: false })]),
    };
    const local = {
      [PROJECT_FILE.production]: production([rule("a", { notes: "mine" }), rule("b")]),
    };

    const result = await reconcile(input(local));
    expect(result.merged).toBe(true);
    expect(result.conflictList).toEqual([]);

    const parsed = parseProduction(result.files);
    expect(parsed.rules.find((r) => r.id === "a")?.notes).toBe("mine");
    expect(parsed.rules.find((r) => r.id === "b")?.enabled).toBe(false);
  });

  it("keeps what each administrator added", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = { [PROJECT_FILE.production]: production([rule("a"), rule("theirs")]) };
    const local = { [PROJECT_FILE.production]: production([rule("a"), rule("mine")]) };

    const result = await reconcile(input(local));
    expect(result.merged).toBe(true);
    expect(parseProduction(result.files).rules.map((r) => r.id)).toEqual([
      "a",
      "mine",
      "theirs",
    ]);
  });

  it("stops and asks when both changed the same field", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.25 })]),
    };
    const local = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.75 })]),
    };

    const result = await reconcile(input(local));
    expect(result.merged).toBe(false);
    expect(result.conflictList).toHaveLength(1);
    expect(result.conflicts).toEqual({ count: 1, domains: ["creature"] });
  });

  /** A half-merged project is neither yours nor theirs; it must still be valid. */
  it("returns a complete, parseable project even with a question outstanding", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.25 })]),
    };
    const local = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.75 })]),
    };

    const result = await reconcile(input(local));
    expect(() => parseProduction(result.files)).not.toThrow();
    // Held at this computer's value until answered.
    expect(parseProduction(result.files).rules[0].chanceToProduce).toBe(0.75);
  });

  it("takes a file only the other side has", async () => {
    trees.base = {};
    trees.theirs = { [PROJECT_FILE.remaps]: '{"schemaVersion":1,"entries":[]}' };
    const result = await reconcile(input({ [PROJECT_FILE.production]: production([]) }));
    expect(result.files[PROJECT_FILE.remaps]).toBeDefined();
    expect(result.merged).toBe(true);
  });

  it("handles a first sync, with no agreed-on version", async () => {
    trees.theirs = { [PROJECT_FILE.production]: production([rule("theirs")]) };
    const local = { [PROJECT_FILE.production]: production([rule("mine")]) };
    const result = await reconcile({
      ...input(local),
      input: { ...input(local).input, base: "" },
    });
    expect(result.merged).toBe(true);
    expect(parseProduction(result.files).rules.map((r) => r.id)).toEqual([
      "mine",
      "theirs",
    ]);
  });
});

describe("files that are not merged", () => {
  /**
   * These are this install's record of what it did. The shared record is the
   * Git history — two administrators appending to the same array would fight
   * over it forever.
   */
  it("leaves history and activity exactly as this computer has them", async () => {
    trees.base = { [PROJECT_FILE.activity]: '{"schemaVersion":1,"events":["base"]}' };
    trees.theirs = { [PROJECT_FILE.activity]: '{"schemaVersion":1,"events":["theirs"]}' };
    const local = { [PROJECT_FILE.activity]: '{"schemaVersion":1,"events":["mine"]}' };

    const result = await reconcile(input(local));
    expect(result.files[PROJECT_FILE.activity]).toContain("mine");
    expect(result.conflictList).toEqual([]);
  });

  /** Keeping one side silently is how somebody's afternoon disappears. */
  it("asks rather than guessing at a file it has no rules for", async () => {
    trees.base = { "something-new.json": '{"a":1}' };
    trees.theirs = { "something-new.json": '{"a":3}' };
    const result = await reconcile(input({ "something-new.json": '{"a":2}' }));

    expect(result.merged).toBe(false);
    expect(result.conflictList).toHaveLength(1);
    expect(result.conflictList[0].kind).toBe("binary");
    expect(result.conflictList[0].itemLabel).toBe("something-new.json");
  });

  it("asks when the version that arrived cannot be read", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = { [PROJECT_FILE.production]: "{ truncated" };
    const result = await reconcile(input({ [PROJECT_FILE.production]: production([rule("a", { notes: "x" })]) }));

    expect(result.merged).toBe(false);
    expect(result.conflictList[0].kind).toBe("binary");
    // The readable local version is what stays on disk.
    expect(result.files[PROJECT_FILE.production]).toContain("notes");
  });

  it("does not merge files that are not JSON", async () => {
    trees.base = {};
    trees.theirs = { "docs/index.html": "<html>theirs</html>" };
    const result = await reconcile(input({ "docs/index.html": "<html>mine</html>" }));
    expect(result.files["docs/index.html"]).toBeUndefined();
  });
});

describe("applying the administrator's answers", () => {
  const setup = async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.25 })]),
    };
    return reconcile(
      input({ [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.75 })]) }),
    );
  };

  it("keeping mine leaves the merged file alone", async () => {
    const result = await setup();
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "mine" },
    ]);
    expect(parseProduction(applied).rules[0].chanceToProduce).toBe(0.75);
  });

  it("keeping theirs writes their value into the file", async () => {
    const result = await setup();
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "theirs" },
    ]);
    expect(parseProduction(applied).rules[0].chanceToProduce).toBe(0.25);
  });

  it("a supplied value overrides both", async () => {
    const result = await setup();
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "custom", custom: 0.5 },
    ]);
    expect(parseProduction(applied).rules[0].chanceToProduce).toBe(0.5);
  });

  it("reaches a field nested inside a cycle", async () => {
    const withCycle = (interval: number) =>
      production([
        {
          ...rule("a"),
          cycles: [{ ...cycle("a-c1"), intervalSeconds: interval }],
        },
      ]);
    trees.base = { [PROJECT_FILE.production]: withCycle(300) };
    trees.theirs = { [PROJECT_FILE.production]: withCycle(60) };
    const result = await reconcile(input({ [PROJECT_FILE.production]: withCycle(900) }));

    expect(result.conflictList).toHaveLength(1);
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "theirs" },
    ]);
    expect(parseProduction(applied).rules[0].cycles[0].intervalSeconds).toBe(60);
  });

  it("resolves a disputed icon assignment, which lives in a map", async () => {
    const catalog = (icon: string) =>
      `${JSON.stringify(
        { schemaVersion: 1, sources: [], icons: { "/Game/A": icon }, notes: {}, maps: {} },
        null,
        2,
      )}\n`;
    trees.base = { [PROJECT_FILE.catalog]: catalog("old.png") };
    trees.theirs = { [PROJECT_FILE.catalog]: catalog("theirs.png") };
    const result = await reconcile(input({ [PROJECT_FILE.catalog]: catalog("mine.png") }));

    expect(result.conflictList).toHaveLength(1);
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "theirs" },
    ]);
    expect(JSON.parse(applied[PROJECT_FILE.catalog]).icons["/Game/A"]).toBe("theirs.png");
  });

  it("resolves a whole-player profile conflict", async () => {
    const roster = (fileName: string | null) =>
      `${JSON.stringify(
        {
          schemaVersion: 1,
          players: [
            {
              id: "p1",
              discordName: "survivor",
              discordId: "",
              steamName: "",
              steamId: "",
              accountName: "",
              gameName: "",
              playerId: "",
              eosId: "",
              notes: "",
              profile: fileName
                ? { fileName, storedAt: "2026-08-01", map: "Ragnarok" }
                : null,
            },
          ],
          cleanSlates: [],
        },
        null,
        2,
      )}\n`;
    trees.base = { [PROJECT_FILE.players]: roster(null) };
    trees.theirs = { [PROJECT_FILE.players]: roster("theirs.arkprofile") };
    const result = await reconcile(input({ [PROJECT_FILE.players]: roster("mine.arkprofile") }));

    expect(result.conflictList[0].kind).toBe("binary");
    const applied = applyAnswers(result.files, result.conflictList, [
      { ...result.conflictList[0], resolution: "theirs" },
    ]);
    expect(PlayersFileSchema.parse(JSON.parse(applied[PROJECT_FILE.players])).players[0].profile?.fileName)
      .toBe("theirs.arkprofile");
  });

  describe("keeping both", () => {
    /** Two administrators added different things that collided on an id. */
    const collide = async () => {
      const remaps = (id: string, to: string) =>
        `${JSON.stringify(
          {
            schemaVersion: 1,
            entries: [
              {
                id,
                active: true,
                fromClass: "/Game/A.Old",
                toClass: to,
                fromSourceId: null,
                toSourceId: null,
                intentional: false,
                notes: "",
              },
            ],
          },
          null,
          2,
        )}\n`;
      trees.base = { [PROJECT_FILE.remaps]: '{"schemaVersion":1,"entries":[]}' };
      trees.theirs = { [PROJECT_FILE.remaps]: remaps("e1", "/Game/Theirs.T") };
      return reconcile(input({ [PROJECT_FILE.remaps]: remaps("e1", "/Game/Mine.M") }));
    };

    it("adds theirs alongside mine, under a new id", async () => {
      const result = await collide();
      expect(result.conflictList[0].kind).toBe("add-vs-add");

      const applied = applyAnswers(result.files, result.conflictList, [
        { ...result.conflictList[0], resolution: "both" },
      ]);
      const entries = JSON.parse(applied[PROJECT_FILE.remaps]).entries;
      expect(entries).toHaveLength(2);
      expect(entries.map((e: { toClass: string }) => e.toClass).sort()).toEqual([
        "/Game/Mine.M",
        "/Game/Theirs.T",
      ]);
    });

    /** My ids stay stable, so nothing referring to them breaks. */
    it("re-identifies theirs, never mine", async () => {
      const result = await collide();
      const applied = applyAnswers(result.files, result.conflictList, [
        { ...result.conflictList[0], resolution: "both" },
      ]);
      const entries = JSON.parse(applied[PROJECT_FILE.remaps]).entries;
      expect(entries.find((e: { id: string }) => e.id === "e1").toClass).toBe("/Game/Mine.M");
      expect(entries.find((e: { id: string }) => e.id !== "e1").toClass).toBe(
        "/Game/Theirs.T",
      );
    });

    /** A merge that is not deterministic shows a change on every sync. */
    it("produces the same id every time", async () => {
      const once = applyAnswers((await collide()).files, (await collide()).conflictList, [
        { ...(await collide()).conflictList[0], resolution: "both" },
      ]);
      const twice = applyAnswers((await collide()).files, (await collide()).conflictList, [
        { ...(await collide()).conflictList[0], resolution: "both" },
      ]);
      expect(once).toEqual(twice);
    });

    it("does not add it twice when answered twice", async () => {
      const result = await collide();
      const answer = { ...result.conflictList[0], resolution: "both" as const };
      const applied = applyAnswers(result.files, result.conflictList, [answer, answer]);
      expect(JSON.parse(applied[PROJECT_FILE.remaps]).entries).toHaveLength(2);
    });
  });

  it("counts a conflict as settled once it has been answered", async () => {
    const result = await setup();
    const answered = await reconcile({
      ...input({
        [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.75 })]),
      }),
      answers: [{ ...result.conflictList[0], resolution: "theirs" }],
    });
    expect(answered.merged).toBe(true);
    expect(answered.conflictList).toEqual([]);
    expect(parseProduction(answered.files).rules[0].chanceToProduce).toBe(0.25);
  });
});

describe("what the administrator is asked", () => {
  it("describes a conflict without naming a Git concept", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.25 })]),
    };
    const result = await reconcile(
      input({ [PROJECT_FILE.production]: production([rule("a", { chanceToProduce: 0.75 })]) }),
    );

    for (const conflict of result.conflictList) {
      const text = `${describeConflict(conflict)} ${conflict.itemLabel} ${conflict.fieldLabel}`;
      expect(leaksGitTerms(text), text).toEqual([]);
    }
  });

  it("has words for a deletion that clashed with an edit", async () => {
    trees.base = { [PROJECT_FILE.production]: production([rule("a"), rule("b")]) };
    trees.theirs = {
      [PROJECT_FILE.production]: production([rule("a"), rule("b", { notes: "keep" })]),
    };
    const result = await reconcile(input({ [PROJECT_FILE.production]: production([rule("a")]) }));

    expect(result.conflictList[0].kind).toBe("delete-vs-edit");
    expect(describeConflict(result.conflictList[0])).toContain("removed here");
  });

  it("renders values in a form a person can compare", () => {
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue(false)).toBe("No");
    expect(displayValue("")).toBe("(empty)");
    expect(displayValue(null)).toBe("(none)");
    expect(displayValue(undefined)).toBe("(not set)");
    expect(displayValue(300)).toBe("300");
    expect(displayValue([1, 2, 3])).toBe("3 items");
    expect(displayValue([])).toBe("(nothing)");
    expect(displayValue({ a: 1 })).toBe("(several settings)");
  });
});

describe("coverage", () => {
  it("knows how to merge the manifest and every domain file", () => {
    expect(MERGED_FILES).toContain(PROJECT_FILE.settings);
    expect(MERGED_FILES).toContain(PROJECT_FILE.production);
    expect(MERGED_FILES).toContain(PROJECT_FILE.players);
    expect(MERGED_FILES).not.toContain(PROJECT_FILE.activity);
  });
});
