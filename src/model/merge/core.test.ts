import { describe, expect, it } from "vitest";
import { deepEqual, mergeList, mergeMap, mergeObject, mergeValue } from "./core";

const CONTEXT = { domain: "creature", itemId: "r1", itemLabel: "Rex" };

describe("deepEqual", () => {
  it("compares structurally, not by reference", () => {
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(deepEqual({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
  });

  it("distinguishes a missing key from an undefined one only when it matters", () => {
    // Both read as "no value", which is what a merge cares about.
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it("does not confuse an array with an object", () => {
    expect(deepEqual([], {})).toBe(false);
  });

  it("treats two NaNs as unchanged", () => {
    expect(deepEqual(NaN, NaN)).toBe(true);
  });
});

describe("mergeValue", () => {
  it("keeps the value when nobody changed it", () => {
    expect(mergeValue(300, 300, 300, "interval", CONTEXT)).toEqual({
      value: 300,
      conflicts: [],
    });
  });

  it("takes their change when this computer made none", () => {
    const result = mergeValue(300, 300, 600, "interval", CONTEXT);
    expect(result.value).toBe(600);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps this computer's change when they made none", () => {
    const result = mergeValue(300, 900, 300, "interval", CONTEXT);
    expect(result.value).toBe(900);
    expect(result.conflicts).toEqual([]);
  });

  it("is not a conflict when both made the same change", () => {
    expect(mergeValue(300, 600, 600, "interval", CONTEXT).conflicts).toEqual([]);
  });

  it("raises a conflict when both changed it differently", () => {
    const result = mergeValue(300, 900, 600, "interval", CONTEXT);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.kind).toBe("field");
    expect(conflict.field).toBe("interval");
    expect(conflict.base).toBe(300);
    expect(conflict.mine).toBe(900);
    expect(conflict.theirs).toBe(600);
    expect(conflict.itemLabel).toBe("Rex");
  });

  /** A half-merged project must still be a complete, valid one. */
  it("holds this computer's value while a conflict is unanswered", () => {
    expect(mergeValue(300, 900, 600, "interval", CONTEXT).value).toBe(900);
  });

  it("uses the friendly field label when one is supplied", () => {
    const result = mergeValue(300, 900, 600, "intervalSeconds", {
      ...CONTEXT,
      labels: { intervalSeconds: "Production interval" },
    });
    expect(result.conflicts[0].fieldLabel).toBe("Production interval");
  });
});

describe("mergeObject", () => {
  const base = { name: "Rex", interval: 300, chance: 1 };

  /** The behaviour that makes most of this invisible. */
  it("merges independent edits to different fields without asking", () => {
    const result = mergeObject(
      base,
      { ...base, name: "Rex (Tamed)" },
      { ...base, interval: 600 },
      CONTEXT,
    );
    expect(result.value).toEqual({ name: "Rex (Tamed)", interval: 600, chance: 1 });
    expect(result.conflicts).toEqual([]);
  });

  it("raises one conflict per genuinely disputed field", () => {
    const result = mergeObject(
      base,
      { name: "Mine", interval: 900, chance: 1 },
      { name: "Theirs", interval: 600, chance: 1 },
      CONTEXT,
    );
    expect(result.conflicts.map((c) => c.field).sort()).toEqual(["interval", "name"]);
  });

  it("takes a field only one side added", () => {
    type WithNotes = typeof base & { notes?: string };
    const result = mergeObject<WithNotes>(
      base,
      { ...base, notes: "mine" },
      { ...base },
      CONTEXT,
    );
    expect(result.value.notes).toBe("mine");
  });

  /** Timestamps and caches change on their own and are not disagreements. */
  it("ignores the fields it was told to ignore", () => {
    const result = mergeObject(
      { ...base, lastCheckedAt: "a" },
      { ...base, lastCheckedAt: "b" },
      { ...base, lastCheckedAt: "c" },
      { ...CONTEXT, ignore: ["lastCheckedAt"] },
    );
    expect(result.conflicts).toEqual([]);
    expect(result.value.lastCheckedAt).toBe("b");
  });
});

// ---------------------------------------------------------------------------

interface Rule extends Record<string, unknown> {
  id: string;
  name: string;
  interval: number;
}

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  name: id.toUpperCase(),
  interval: 300,
  ...over,
});

const listOptions = {
  keyOf: (r: Rule) => r.id,
  labelOf: (r: Rule) => r.name,
  domain: "creature",
};

describe("mergeList", () => {
  it("keeps additions from both sides", () => {
    const result = mergeList(
      [rule("a")],
      [rule("a"), rule("b")],
      [rule("a"), rule("c")],
      listOptions,
    );
    expect(result.value.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(result.conflicts).toEqual([]);
  });

  /**
   * The single most important rule. Merged by index, one administrator
   * inserting a rule at the top pairs every later rule against the wrong one,
   * and a merge that looks clean rewrites the whole list into nonsense.
   */
  it("pairs items by id, never by position", () => {
    const result = mergeList(
      [rule("a"), rule("b")],
      // Same two rules, reordered, with one edited.
      [rule("b", { interval: 600 }), rule("a")],
      [rule("a"), rule("b")],
      listOptions,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.value.find((r) => r.id === "b")?.interval).toBe(600);
    expect(result.value.find((r) => r.id === "a")?.interval).toBe(300);
  });

  it("treats a reorder on its own as no change at all", () => {
    const result = mergeList(
      [rule("a"), rule("b"), rule("c")],
      [rule("c"), rule("b"), rule("a")],
      [rule("b"), rule("a"), rule("c")],
      listOptions,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.value.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  /** Either administrator syncing first must produce the same file. */
  it("produces the same order whichever side is 'mine'", () => {
    const base = [rule("a")];
    const x = [rule("a"), rule("x")];
    const y = [rule("a"), rule("y")];
    const one = mergeList(base, x, y, listOptions).value.map((r) => r.id);
    const other = mergeList(base, y, x, listOptions).value.map((r) => r.id);
    expect(new Set(one)).toEqual(new Set(other));
    expect(one[0]).toBe("a");
  });

  it("merges independent edits to the same item", () => {
    const result = mergeList(
      [rule("a")],
      [rule("a", { name: "Mine" })],
      [rule("a", { interval: 600 })],
      listOptions,
    );
    expect(result.conflicts).toEqual([]);
    expect(result.value[0]).toEqual({ id: "a", name: "Mine", interval: 600 });
  });

  it("raises a conflict when both edited the same field", () => {
    const result = mergeList(
      [rule("a")],
      [rule("a", { interval: 900 })],
      [rule("a", { interval: 600 })],
      listOptions,
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe("interval");
    expect(result.conflicts[0].itemLabel).toBe("A");
  });

  describe("deletions", () => {
    it("accepts a deletion of something the other side left alone", () => {
      const result = mergeList([rule("a"), rule("b")], [rule("a")], [rule("a"), rule("b")], listOptions);
      expect(result.value.map((r) => r.id)).toEqual(["a"]);
      expect(result.conflicts).toEqual([]);
    });

    it("accepts a deletion both sides made", () => {
      const result = mergeList([rule("a"), rule("b")], [rule("a")], [rule("a")], listOptions);
      expect(result.value.map((r) => r.id)).toEqual(["a"]);
      expect(result.conflicts).toEqual([]);
    });

    /** Somebody's edit would otherwise vanish without being mentioned. */
    it("asks when one side deleted what the other edited", () => {
      const result = mergeList(
        [rule("a"), rule("b")],
        [rule("a")],
        [rule("a"), rule("b", { interval: 600 })],
        listOptions,
      );
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].kind).toBe("delete-vs-edit");
      expect(result.conflicts[0].mine).toBeUndefined();
      expect(result.conflicts[0].theirs).toMatchObject({ interval: 600 });
      // Kept until answered - a deletion is the irreversible choice.
      expect(result.value.map((r) => r.id)).toContain("b");
    });

    it("asks the same way round when they deleted what we edited", () => {
      const result = mergeList(
        [rule("a"), rule("b")],
        [rule("a"), rule("b", { interval: 600 })],
        [rule("a")],
        listOptions,
      );
      expect(result.conflicts[0].kind).toBe("delete-vs-edit");
      expect(result.conflicts[0].mine).toMatchObject({ interval: 600 });
      expect(result.conflicts[0].theirs).toBeUndefined();
    });
  });

  describe("the same id added twice", () => {
    it("is fine when the content matches", () => {
      const result = mergeList([], [rule("a")], [rule("a")], listOptions);
      expect(result.conflicts).toEqual([]);
      expect(result.value).toHaveLength(1);
    });

    /** Two different things that happen to collide, not one thing to merge. */
    it("is a conflict when the content differs", () => {
      const result = mergeList(
        [],
        [rule("a", { name: "Mine" })],
        [rule("a", { name: "Theirs" })],
        listOptions,
      );
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].kind).toBe("add-vs-add");
      expect(result.conflicts[0].canKeepBoth).toBe(true);
    });
  });

  it("gives every conflict a stable id", () => {
    const run = () =>
      mergeList([rule("a")], [rule("a", { interval: 900 })], [rule("a", { interval: 600 })], listOptions)
        .conflicts[0].id;
    expect(run()).toBe(run());
    expect(run()).toBe("creature:a:interval");
  });

  it("does nothing surprising with empty inputs", () => {
    expect(mergeList([], [], [], listOptions)).toEqual({ value: [], conflicts: [] });
  });

  it("handles a first sync, where there is no base at all", () => {
    const result = mergeList(undefined, [rule("a")], [rule("b")], listOptions);
    expect(result.value.map((r) => r.id)).toEqual(["a", "b"]);
    expect(result.conflicts).toEqual([]);
  });
});

describe("mergeMap", () => {
  const context = { domain: "icon", itemId: "", itemLabel: "icon assignment" };

  it("keeps entries added on either side", () => {
    const result = mergeMap({ a: "1" }, { a: "1", b: "2" }, { a: "1", c: "3" }, context);
    expect(result.value).toEqual({ a: "1", b: "2", c: "3" });
    expect(result.conflicts).toEqual([]);
  });

  it("accepts a removal the other side left alone", () => {
    const result = mergeMap({ a: "1", b: "2" }, { a: "1" }, { a: "1", b: "2" }, context);
    expect(result.value).toEqual({ a: "1" });
  });

  it("takes a one-sided change", () => {
    const result = mergeMap({ a: "1" }, { a: "1" }, { a: "2" }, context);
    expect(result.value).toEqual({ a: "2" });
    expect(result.conflicts).toEqual([]);
  });

  it("asks when both changed the same key", () => {
    const result = mergeMap({ a: "1" }, { a: "2" }, { a: "3" }, context);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].field).toBe("a");
  });

  it("comes out in a stable order regardless of input order", () => {
    const one = mergeMap({}, { b: "2", a: "1" }, { c: "3" }, context);
    const other = mergeMap({}, { a: "1", b: "2" }, { c: "3" }, context);
    expect(Object.keys(one.value)).toEqual(Object.keys(other.value));
  });
});
