import { describe, expect, it } from "vitest";
import {
  buildEntryOwners,
  canonicalCurseforgeUrl,
  describeOwner,
  findCatalogDuplicates,
  findDuplicateCurseforgeIds,
  findDuplicateModUrls,
  findEntryOwner,
  findSourceByCurseforgeId,
  normalizeCurseforgeId,
  planEntryInsert,
  planEntryMove,
} from "./catalogDuplicates";
import type { CatalogEntry, ContentSource } from "./catalog";
import { officialSource } from "./officialCatalog";

function source(
  over: Partial<ContentSource> & { id: string; name: string },
): ContentSource {
  return {
    kind: "mod",
    curseforgeId: "",
    url: "",
    docsUrl: "",
    discordUrl: "",
    iconsDir: "",
    iniNotes: "",
    iniSettings: [],
    iniBuild: {},
    variantTag: "",
    modpackId: "",
    modpackVersion: "",
    enabled: true,
    removed: false,
    notes: "",
    creatures: [],
    items: [],
    ...over,
  };
}

const e = (id: string, name: string, bpPath: string): CatalogEntry => ({
  id,
  name,
  bpPath,
});

const PATH = "/Game/Mods/A/Thing_Character_BP.Thing_Character_BP";
const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";

const modA = source({
  id: "a",
  name: "Mod A",
  creatures: [e("a1", "Thing", PATH)],
  items: [e("ai1", "Widget", "/Game/Mods/A/PrimalItem_Widget.PrimalItem_Widget")],
});
const modB = source({ id: "b", name: "Mod B" });

describe("findEntryOwner", () => {
  const owners = buildEntryOwners([modA, modB], "creatures");

  it("finds an exact match", () => {
    expect(findEntryOwner(owners, PATH)?.source.name).toBe("Mod A");
  });

  it("ignores case", () => {
    expect(findEntryOwner(owners, PATH.toUpperCase())?.entry.name).toBe("Thing");
  });

  it("treats a trailing _C as the same class", () => {
    expect(findEntryOwner(owners, `${PATH}_C`)?.entry.name).toBe("Thing");
  });

  it("trims whitespace", () => {
    expect(findEntryOwner(owners, `  ${PATH}  `)?.entry.name).toBe("Thing");
  });

  it("returns null for something genuinely new", () => {
    expect(findEntryOwner(owners, "/Game/Mods/Z/New.New")).toBeNull();
  });

  it("can be told to ignore specific entries", () => {
    expect(
      findEntryOwner(owners, PATH, new Set(["a1"])),
    ).toBeNull();
  });

  it("keeps creature and item namespaces apart", () => {
    const itemOwners = buildEntryOwners([modA, modB], "items");
    expect(findEntryOwner(itemOwners, PATH)).toBeNull();
  });

  it("sees bundled Official ASA content", () => {
    const withOfficial = buildEntryOwners([officialSource, modA], "creatures");
    expect(findEntryOwner(withOfficial, REX)?.source.name).toBe("Official ASA");
  });

  it("names the entry and its source for the error message", () => {
    expect(describeOwner(findEntryOwner(owners, PATH)!)).toBe(
      '"Thing" in Mod A',
    );
  });
});

describe("planEntryInsert", () => {
  const owners = buildEntryOwners([officialSource, modA], "creatures");

  it("accepts entries nothing else claims", () => {
    const plan = planEntryInsert(owners, [e("n1", "New", "/Game/Mods/Z/New.New")]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a class the same source already has", () => {
    const plan = planEntryInsert(owners, [e("n1", "Thing again", PATH)]);
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped[0]).toMatchObject({
      reason: "catalog",
      conflictsWith: '"Thing" in Mod A',
    });
  });

  it("skips a class another source already has", () => {
    const plan = planEntryInsert(owners, [e("n1", "My Rex", REX)]);
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped[0].conflictsWith).toContain("Official ASA");
  });

  it("skips a case-only difference", () => {
    const plan = planEntryInsert(owners, [e("n1", "thing", PATH.toLowerCase())]);
    expect(plan.accepted).toEqual([]);
  });

  it("skips a _C difference", () => {
    const plan = planEntryInsert(owners, [e("n1", "Thing", `${PATH}_C`)]);
    expect(plan.accepted).toEqual([]);
  });

  it("skips a repeat within the same batch, and says so", () => {
    const plan = planEntryInsert(owners, [
      e("n1", "Alpha", "/Game/Mods/Z/New.New"),
      e("n2", "Alpha copy", "/Game/Mods/Z/New.New_C"),
    ]);
    expect(plan.accepted).toHaveLength(1);
    expect(plan.skipped[0]).toMatchObject({ reason: "batch" });
    expect(plan.skipped[0].conflictsWith).toContain("Alpha");
  });

  it("reports catalog and batch collisions separately", () => {
    const plan = planEntryInsert(owners, [
      e("n1", "Thing", PATH),
      e("n2", "Fresh", "/Game/Mods/Z/Fresh.Fresh"),
      e("n3", "Fresh again", "/Game/Mods/Z/Fresh.Fresh"),
    ]);
    expect(plan.accepted.map((x) => x.name)).toEqual(["Fresh"]);
    expect(plan.skipped.map((s) => s.reason)).toEqual(["catalog", "batch"]);
  });

  it("ignores entries with no usable path", () => {
    const plan = planEntryInsert(owners, [e("n1", "Blank", "   ")]);
    expect(plan.accepted).toEqual([]);
    expect(plan.skipped).toEqual([]);
  });
});

describe("planEntryMove", () => {
  it("moves entries the destination does not have", () => {
    const owners = buildEntryOwners([modA, modB], "creatures");
    const plan = planEntryMove(owners, modA.creatures);
    expect(plan.moved).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("does not let an entry collide with itself", () => {
    const owners = buildEntryOwners([modA], "creatures");
    expect(planEntryMove(owners, modA.creatures).moved).toHaveLength(1);
  });

  it("reports rather than drops an entry the destination already has", () => {
    const dest = source({
      id: "b",
      name: "Mod B",
      creatures: [e("b1", "Their Thing", PATH)],
    });
    const owners = buildEntryOwners([modA, dest], "creatures");
    const plan = planEntryMove(owners, modA.creatures);
    expect(plan.moved).toEqual([]);
    expect(plan.skipped[0].conflictsWith).toBe('"Their Thing" in Mod B');
  });

  it("reports a collision with a third source, not just the destination", () => {
    const third = source({
      id: "c",
      name: "Mod C",
      creatures: [e("c1", "Elsewhere", PATH)],
    });
    const owners = buildEntryOwners([modA, modB, third], "creatures");
    const plan = planEntryMove(owners, modA.creatures);
    expect(plan.skipped[0].conflictsWith).toContain("Mod C");
  });

  it("carries only one of two same-class entries in the selection", () => {
    const messy = source({
      id: "d",
      name: "Mod D",
      creatures: [e("d1", "One", PATH), e("d2", "Two", `${PATH}_C`)],
    });
    const owners = buildEntryOwners([messy], "creatures");
    const plan = planEntryMove(owners, messy.creatures);
    expect(plan.moved).toHaveLength(1);
    expect(plan.skipped).toHaveLength(1);
  });
});

describe("findCatalogDuplicates", () => {
  it("says nothing about a clean catalog", () => {
    expect(findCatalogDuplicates([modA, modB])).toEqual([]);
  });

  it("reports the same class in two sources, with both locations", () => {
    const other = source({
      id: "b",
      name: "Mod B",
      creatures: [e("b1", "Thing (dupe)", `${PATH}_C`)],
    });
    const dupes = findCatalogDuplicates([modA, other], ["creatures"]);
    expect(dupes).toHaveLength(1);
    expect(dupes[0].locations.map((l) => l.sourceName)).toEqual([
      "Mod A",
      "Mod B",
    ]);
  });

  it("reports a duplicate within one source", () => {
    const messy = source({
      id: "m",
      name: "Messy",
      creatures: [e("1", "A", PATH), e("2", "B", PATH.toUpperCase())],
    });
    expect(findCatalogDuplicates([messy], ["creatures"])).toHaveLength(1);
  });

  it("does not treat a creature and an item sharing a path as a duplicate", () => {
    const odd = source({
      id: "o",
      name: "Odd",
      creatures: [e("1", "A", PATH)],
      items: [e("2", "B", PATH)],
    });
    expect(findCatalogDuplicates([odd])).toEqual([]);
  });

  it("is non-destructive — it only describes", () => {
    const before = structuredClone(modA);
    findCatalogDuplicates([modA, modA]);
    expect(modA).toEqual(before);
  });
});

describe("CurseForge project IDs", () => {
  const one = source({ id: "1", name: "Ports of Atlas", curseforgeId: "972253" });
  const two = source({ id: "2", name: "Ark Additions", curseforgeId: "881410" });
  const urlOnly = source({
    id: "3",
    name: "URL only",
    url: "https://www.curseforge.com/ark-survival-ascended/mods/thing",
  });

  it("trims before comparing", () => {
    expect(normalizeCurseforgeId("  972253 ")).toBe("972253");
    expect(findSourceByCurseforgeId([one, two], " 972253 ")?.name).toBe(
      "Ports of Atlas",
    );
  });

  it("finds the source already using an ID when adding", () => {
    expect(findSourceByCurseforgeId([one, two], "881410")?.name).toBe(
      "Ark Additions",
    );
  });

  it("lets a source keep its own ID when editing", () => {
    expect(findSourceByCurseforgeId([one, two], "972253", "1")).toBeNull();
  });

  it("still catches an edit that takes another source's ID", () => {
    expect(findSourceByCurseforgeId([one, two], "881410", "1")?.name).toBe(
      "Ark Additions",
    );
  });

  it("allows empty IDs — URL-only mods are legal", () => {
    expect(findSourceByCurseforgeId([urlOnly, one], "")).toBeNull();
    expect(findSourceByCurseforgeId([urlOnly, one], "   ")).toBeNull();
  });

  it("reports legacy duplicates without changing anything", () => {
    const clash = source({ id: "4", name: "Copy", curseforgeId: " 972253" });
    const dupes = findDuplicateCurseforgeIds([one, two, clash]);
    expect(dupes).toEqual([
      { curseforgeId: "972253", sourceNames: ["Ports of Atlas", "Copy"] },
    ]);
  });

  it("says nothing when every ID is unique or empty", () => {
    expect(findDuplicateCurseforgeIds([one, two, urlOnly])).toEqual([]);
  });
});

describe("canonicalCurseforgeUrl", () => {
  const base = "https://www.curseforge.com/ark-survival-ascended/mods/thing";

  it("ignores scheme, www, trailing slash, query and case", () => {
    const forms = [
      base,
      `${base}/`,
      `${base}?utm_source=x`,
      `${base}#files`,
      "http://curseforge.com/ark-survival-ascended/mods/THING",
      `  ${base}  `,
    ];
    const canonical = forms.map(canonicalCurseforgeUrl);
    expect(new Set(canonical).size).toBe(1);
  });

  it("keeps different mods apart", () => {
    expect(canonicalCurseforgeUrl(base)).not.toBe(
      canonicalCurseforgeUrl(`${base}-two`),
    );
  });

  it("maps an empty URL to an empty key", () => {
    expect(canonicalCurseforgeUrl("  ")).toBe("");
  });

  it("warns about two sources on one page but ignores blanks", () => {
    const a = source({ id: "a", name: "A", url: base });
    const b = source({ id: "b", name: "B", url: `${base}/` });
    const c = source({ id: "c", name: "C" });
    expect(findDuplicateModUrls([a, b, c])).toEqual([
      { url: "curseforge.com/ark-survival-ascended/mods/thing", sourceNames: ["A", "B"] },
    ]);
  });
});
