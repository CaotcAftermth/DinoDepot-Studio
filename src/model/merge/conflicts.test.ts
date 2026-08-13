import { describe, expect, it } from "vitest";
import { leaksGitTerms } from "../syncState";
import {
  allResolved,
  conflictId,
  describeConflict,
  displayValue,
  groupByDomain,
  summarizeConflicts,
  type Conflict,
  type ConflictKind,
} from "./conflicts";

function conflict(over: Partial<Conflict> = {}): Conflict {
  return {
    id: "creature:r1:interval",
    domain: "creature",
    itemId: "r1",
    itemLabel: "Rex",
    field: "intervalSeconds",
    fieldLabel: "Interval",
    kind: "field",
    base: 300,
    mine: 900,
    theirs: 600,
    canKeepBoth: false,
    ...over,
  };
}

describe("conflictId", () => {
  /** A half-finished decision has to survive closing the dialog and returning. */
  it("is stable for the same item and field", () => {
    expect(conflictId("creature", "r1", "interval")).toBe("creature:r1:interval");
    expect(conflictId("creature", "r1", "interval")).toBe(
      conflictId("creature", "r1", "interval"),
    );
  });

  it("separates the same field on different items", () => {
    expect(conflictId("creature", "r1", "interval")).not.toBe(
      conflictId("creature", "r2", "interval"),
    );
  });

  it("separates a whole-item conflict from a field one", () => {
    expect(conflictId("creature", "r1", "")).not.toBe(
      conflictId("creature", "r1", "interval"),
    );
  });
});

describe("describeConflict", () => {
  it("names the field and the thing for a plain disagreement", () => {
    expect(describeConflict(conflict())).toBe("Interval on Rex");
  });

  it("explains a deletion that clashed with an edit", () => {
    expect(describeConflict(conflict({ kind: "delete-vs-edit" }))).toBe(
      "Rex was removed here and changed by someone else",
    );
  });

  it("explains two additions that collided", () => {
    expect(describeConflict(conflict({ kind: "add-vs-add" }))).toBe(
      "Rex was added in two different ways",
    );
  });

  it("explains two versions of a file", () => {
    expect(
      describeConflict(conflict({ kind: "binary", itemLabel: "player roster" })),
    ).toBe("Two different versions of player roster");
  });

  it("says something useful when there is no label to use", () => {
    expect(describeConflict(conflict({ itemLabel: "", itemId: "" }))).toContain("an item");
  });

  /**
   * The promise the whole design rests on: nobody has to know what a merge base
   * is. This is the guard against that leaking through the one screen where it
   * would be most tempting to explain the machinery.
   */
  it("never names a Git concept, whatever the kind", () => {
    const kinds: ConflictKind[] = ["field", "delete-vs-edit", "add-vs-add", "binary"];
    for (const kind of kinds) {
      const text = describeConflict(conflict({ kind }));
      expect(leaksGitTerms(text), `${kind}: ${text}`).toEqual([]);
    }
  });
});

describe("displayValue", () => {
  it("renders a boolean as a plain answer", () => {
    expect(displayValue(true)).toBe("Yes");
    expect(displayValue(false)).toBe("No");
  });

  /**
   * "Removed", "never set" and "set to nothing" are three different things, and
   * an administrator choosing between two columns has to be able to tell them
   * apart.
   */
  it("distinguishes absent, null and empty", () => {
    expect(displayValue(undefined)).toBe("(not set)");
    expect(displayValue(null)).toBe("(none)");
    expect(displayValue("")).toBe("(empty)");
  });

  it("summarises collections rather than dumping them", () => {
    expect(displayValue([1, 2, 3])).toBe("3 items");
    expect(displayValue([])).toBe("(nothing)");
    expect(displayValue({ a: 1 })).toBe("(several settings)");
  });

  it("passes strings and numbers through", () => {
    expect(displayValue("Ragnarok")).toBe("Ragnarok");
    expect(displayValue(300)).toBe("300");
    expect(displayValue(0)).toBe("0");
  });
});

describe("groupByDomain", () => {
  it("groups conflicts by what they are about", () => {
    const groups = groupByDomain([
      conflict({ id: "a", domain: "creature" }),
      conflict({ id: "b", domain: "mod" }),
      conflict({ id: "c", domain: "creature" }),
    ]);
    expect(groups.map(([domain, items]) => [domain, items.length])).toEqual([
      ["creature", 2],
      ["mod", 1],
    ]);
  });

  /** First-seen, so a domain rename cannot reshuffle the whole screen. */
  it("keeps the order the conflicts arrived in", () => {
    const groups = groupByDomain([
      conflict({ id: "a", domain: "mod" }),
      conflict({ id: "b", domain: "creature" }),
    ]);
    expect(groups.map(([domain]) => domain)).toEqual(["mod", "creature"]);
  });

  it("returns nothing for nothing", () => {
    expect(groupByDomain([])).toEqual([]);
  });
});

describe("summarizeConflicts", () => {
  it("counts them and lists what they are about", () => {
    expect(
      summarizeConflicts([
        conflict({ id: "a", domain: "creature" }),
        conflict({ id: "b", domain: "creature" }),
        conflict({ id: "c", domain: "mod" }),
      ]),
    ).toEqual({ count: 3, domains: ["creature", "mod"] });
  });

  it("reports nothing outstanding as nothing", () => {
    expect(summarizeConflicts([])).toEqual({ count: 0, domains: [] });
  });
});

describe("allResolved", () => {
  const conflicts = [conflict({ id: "a" }), conflict({ id: "b" })];

  it("is satisfied when there was nothing to decide", () => {
    expect(allResolved([], [])).toBe(true);
  });

  /** Half a decision is a project that is neither yours nor theirs. */
  it("is not satisfied while any question is unanswered", () => {
    expect(allResolved([{ ...conflicts[0], resolution: "mine" }], conflicts)).toBe(false);
  });

  it("is satisfied once every question has an answer", () => {
    expect(
      allResolved(
        [
          { ...conflicts[0], resolution: "mine" },
          { ...conflicts[1], resolution: "theirs" },
        ],
        conflicts,
      ),
    ).toBe(true);
  });

  it("is not fooled by an answer to something that is not being asked", () => {
    expect(
      allResolved(
        [
          { ...conflicts[0], resolution: "mine" },
          { ...conflict({ id: "unrelated" }), resolution: "mine" },
        ],
        conflicts,
      ),
    ).toBe(false);
  });
});
