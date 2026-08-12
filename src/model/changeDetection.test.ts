import { describe, expect, it } from "vitest";
import {
  COSMETIC_SPEC,
  diffCatalog,
  diffList,
  diffMap,
  diffSettings,
  leafOf,
  PLAYER_SPEC,
  PRODUCTION_SPEC,
  REMAP_SPEC,
  WATCHLIST_SPEC,
} from "./changeDetection";
import { collapseActions, describeAction } from "./commitActions";

/**
 * Working out what an edit did.
 *
 * Diffed rather than declared, because a promise that every call site describes
 * its own change is one nobody keeps — and the failure is silent, producing a
 * commit that says "files changed" about an afternoon of work.
 */

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  notes: "",
  dinoType: `/Game/Dinos/${id}.${id}`,
  chanceToProduce: 1,
  cycles: [],
  ...over,
});

describe("diffing a list", () => {
  it("notices an addition", () => {
    const actions = diffList([], [rule("a")], PRODUCTION_SPEC);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("creature.added");
    expect(actions[0].label).toBe("a");
  });

  it("notices a deletion", () => {
    const actions = diffList([rule("a")], [], PRODUCTION_SPEC);
    expect(actions[0].type).toBe("creature.deleted");
  });

  it("notices a change, and names the fields", () => {
    const actions = diffList(
      [rule("a")],
      [rule("a", { chanceToProduce: 0.5, notes: "hi" })],
      PRODUCTION_SPEC,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("creature.updated");
    expect(actions[0].fields).toEqual(["chanceToProduce", "notes"]);
  });

  it("says nothing when nothing changed", () => {
    expect(diffList([rule("a")], [rule("a")], PRODUCTION_SPEC)).toEqual([]);
  });

  /**
   * By id, for the same reason the merge is. Diffing by index would report an
   * insertion at the top as every item having changed.
   */
  it("is not fooled by a reorder", () => {
    expect(
      diffList([rule("a"), rule("b")], [rule("b"), rule("a")], PRODUCTION_SPEC),
    ).toEqual([]);
  });

  it("reports several changes at once", () => {
    const actions = diffList(
      [rule("a"), rule("gone")],
      [rule("a", { enabled: false }), rule("new")],
      PRODUCTION_SPEC,
    );
    expect(actions.map((a) => a.type).sort()).toEqual([
      "creature.added",
      "creature.deleted",
      "creature.updated",
    ]);
  });

  /** Nested structures collapse to their own name, not a deep path. */
  it("names a nested change by its top-level field", () => {
    const actions = diffList(
      [rule("a")],
      [rule("a", { cycles: [{ id: "c1", intervalSeconds: 60 }] })],
      PRODUCTION_SPEC,
    );
    expect(actions[0].fields).toEqual(["cycles"]);
  });

  it("ignores the fields it was told to ignore", () => {
    const mod = (over: Record<string, unknown> = {}) => ({
      id: "w1",
      modId: "1431447",
      name: "Ports of Atlas",
      knownUpdated: "2026-07-01",
      lastCheckedAt: null,
      latestUpdated: "2026-07-01",
      needsReview: false,
      ...over,
    });
    expect(
      diffList(
        [mod()],
        [mod({ lastCheckedAt: "2026-08-09", latestUpdated: "2026-08-09", needsReview: true })],
        WATCHLIST_SPEC,
      ),
    ).toEqual([]);
  });

  it("still notices the acknowledged version, which is a decision", () => {
    const mod = (over: Record<string, unknown> = {}) => ({
      id: "w1",
      modId: "1431447",
      name: "Ports of Atlas",
      knownUpdated: "2026-07-01",
      ...over,
    });
    const actions = diffList([mod()], [mod({ knownUpdated: "2026-08-09" })], WATCHLIST_SPEC);
    expect(actions[0].fields).toEqual(["knownUpdated"]);
  });
});

describe("the labels an administrator reads", () => {
  it("names a creature by its blueprint, not its record id", () => {
    const actions = diffList(
      [],
      [rule("r1", { dinoType: "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP" })],
      PRODUCTION_SPEC,
    );
    expect(actions[0].label).toBe("Rex_Character_BP");
    expect(describeAction(actions[0])).toBe("Added creature Rex_Character_BP");
  });

  it("names a remap by what it maps", () => {
    const remap = { id: "e1", fromClass: "/Game/A.Old", toClass: "/Game/B.New" };
    expect(diffList([], [remap], REMAP_SPEC)[0].label).toBe("Old → New");
  });

  it("names a cosmetic by its mod name", () => {
    const entry = { id: "c1", modId: "1431447", name: "Ports of Atlas" };
    expect(diffList([], [entry], COSMETIC_SPEC)[0].label).toBe("Ports of Atlas");
  });

  it("names a player by whichever name they have", () => {
    expect(
      diffList([], [{ id: "p1", discordName: "", gameName: "Rex Wrangler" }], PLAYER_SPEC)[0]
        .label,
    ).toBe("Rex Wrangler");
  });

  it("falls back to the id when there is no name at all", () => {
    expect(diffList([], [{ id: "p1" }], PLAYER_SPEC)[0].label).toBe("p1");
  });

  it("reads the tail off a blueprint path", () => {
    expect(leafOf("/Game/Dinos/Rex.Rex_C")).toBe("Rex_C");
    expect(leafOf("plain")).toBe("plain");
    expect(leafOf("")).toBe("");
  });
});

describe("diffing a map", () => {
  it("notices an assignment, a change and a removal", () => {
    const actions = diffMap(
      { "/Game/A": "a.webp", "/Game/gone": "g.webp" },
      { "/Game/A": "changed.webp", "/Game/new": "n.webp" },
      "icon",
    );
    expect(actions.map((a) => a.type).sort()).toEqual([
      "icon.added",
      "icon.deleted",
      "icon.updated",
    ]);
  });

  it("says nothing when nothing changed", () => {
    expect(diffMap({ a: "1" }, { a: "1" }, "icon")).toEqual([]);
  });
});

describe("diffing the catalog", () => {
  const catalog = (over: Record<string, unknown> = {}) => ({
    sources: [],
    icons: {},
    notes: {},
    maps: {},
    ...over,
  });

  it("describes a mod being added", () => {
    const actions = diffCatalog(
      catalog(),
      catalog({ sources: [{ id: "s1", name: "Ports of Atlas" }] }),
    );
    expect(actions[0].type).toBe("mod.added");
    expect(actions[0].label).toBe("Ports of Atlas");
  });

  /** Assigning an icon is where most edits actually happen. */
  it("describes an icon assignment rather than 'the catalog changed'", () => {
    const actions = diffCatalog(catalog(), catalog({ icons: { "/Game/A.Rex": "rex.webp" } }));
    expect(actions[0].type).toBe("icon.added");
    expect(actions[0].label).toBe("Rex");
  });

  it("describes notes and maps of origin too", () => {
    const actions = diffCatalog(
      catalog(),
      catalog({ notes: { "/Game/A": "x" }, maps: { "/Game/A": "Ragnarok" } }),
    );
    expect(actions.map((a) => a.type).sort()).toEqual(["map.added", "note.added"]);
  });

  /** A machine-local path is not something the team needs told about. */
  it("does not report one administrator's icons folder", () => {
    const source = (over: Record<string, unknown> = {}) => ({
      id: "s1",
      name: "Ports of Atlas",
      ...over,
    });
    expect(
      diffCatalog(
        catalog({ sources: [source({ iconsDir: "C:\\mine" })] }),
        catalog({ sources: [source({ iconsDir: "D:\\other" })] }),
      ),
    ).toEqual([]);
  });

  it("copes with a catalog missing its maps entirely", () => {
    expect(diffCatalog({}, {})).toEqual([]);
  });
});

describe("diffing settings", () => {
  it("reports the fields that changed as one action", () => {
    const actions = diffSettings({ name: "A", cluster: "X" }, { name: "B", cluster: "Y" });
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("settings.updated");
    expect(actions[0].fields).toEqual(["cluster", "name"]);
  });

  it("says nothing when nothing changed", () => {
    expect(diffSettings({ name: "A" }, { name: "A" })).toEqual([]);
  });

  it("ignores what it was told to", () => {
    expect(diffSettings({ a: 1 }, { a: 2 }, ["a"])).toEqual([]);
  });
});

describe("what an afternoon of edits comes out as", () => {
  /**
   * The journal is appended to on every keystroke; `collapseActions` is what
   * turns that into one readable line per thing.
   */
  it("collapses to one action per thing touched", () => {
    const journal = [
      ...diffList([rule("a")], [rule("a", { notes: "x" })], PRODUCTION_SPEC),
      ...diffList([rule("a")], [rule("a", { notes: "xy" })], PRODUCTION_SPEC),
      ...diffList([rule("a")], [rule("a", { chanceToProduce: 0.5 })], PRODUCTION_SPEC),
      ...diffList([], [rule("b")], PRODUCTION_SPEC),
    ];
    const collapsed = collapseActions(journal);

    expect(collapsed).toHaveLength(2);
    expect(collapsed[0].fields).toEqual(["notes", "chanceToProduce"]);
    expect(collapsed[1].type).toBe("creature.added");
  });

  /** Created and removed between syncs: nobody else ever saw it. */
  it("drops something added and then removed again", () => {
    const journal = [
      ...diffList([], [rule("temp")], PRODUCTION_SPEC),
      ...diffList([rule("temp")], [], PRODUCTION_SPEC),
    ];
    expect(collapseActions(journal)).toEqual([]);
  });
});
