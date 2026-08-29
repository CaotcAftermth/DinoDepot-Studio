import { describe, expect, it } from "vitest";
import { buildPickerRows } from "./pickerResults";
import { normalizeBpPath } from "./catalog";
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

const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
const DODO = "/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP";

function entry(id: string, name: string, bpPath: string): CatalogEntry {
  return { id, name, bpPath };
}

/** Official Rex + Dodo, plus a mod that ships variants of both. */
const modded = source({
  id: "mod-1",
  name: "Ark Extras",
  creatures: [
    entry("m1", "Aberrant Rex", "/Game/Mods/X/Rex_Character_BP_Aberrant.Rex_Character_BP_Aberrant"),
    entry("m2", "Tek Rex", "/Game/Mods/X/Rex_Character_BP_Tek.Rex_Character_BP_Tek"),
    entry("m3", "Party Dodo", "/Game/Mods/X/Dodo_Character_BP_Party.Dodo_Character_BP_Party"),
  ],
  items: [entry("i1", "Mod Berry", "/Game/Mods/X/PrimalItem_Berry.PrimalItem_Berry")],
});

const SOURCES = [officialSource, modded];

function names(rows: { entry: CatalogEntry }[]): string[] {
  return rows.map((r) => r.entry.name);
}

describe("flat mode (unchanged behaviour)", () => {
  it("returns every match in source order when not collapsing", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "Aberrant Rex",
      collapseVariants: false,
    });
    expect(names(rows)).toContain("Aberrant Rex");
    expect(rows.every((r) => r.hiddenVariants === 0)).toBe(true);
  });

  it("matches on the blueprint path as well as the name", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "Rex_Character_BP_Tek",
      collapseVariants: false,
    });
    expect(names(rows)).toEqual(["Tek Rex"]);
  });

  it("caps results at the limit", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "",
      collapseVariants: false,
      limit: 5,
    });
    expect(rows).toHaveLength(5);
  });

  it("leaves items alone even when collapsing is requested", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "items",
      search: "Mod Berry",
      collapseVariants: true,
    });
    expect(names(rows)).toEqual(["Mod Berry"]);
    expect(rows[0].hiddenVariants).toBe(0);
  });
});

describe("parent-first mode", () => {
  it("offers the parent instead of its variants", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "rex",
      collapseVariants: true,
    });
    const shown = names(rows);
    expect(shown).toContain("Rex");
    expect(shown).not.toContain("Aberrant Rex");
    expect(shown).not.toContain("Tek Rex");
  });

  it("counts the variants it collapsed", () => {
    // Official ASA ships Rex variants of its own (Corrupted, X-, Tek…), so the
    // count is "everything under this parent", not just the modded ones.
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "",
      collapseVariants: true,
      limit: 5000,
    });
    const rex = rows.filter((r) => r.entry.bpPath === REX);
    expect(rex).toHaveLength(1);
    expect(rex[0].hiddenVariants).toBeGreaterThanOrEqual(2);
  });

  it("counts exactly the variants filed under a parent it fully controls", () => {
    const solo = source({
      id: "mod-solo",
      name: "Solo",
      creatures: [
        entry("p", "Glorp", "/Game/Mods/Y/Glorp_Character_BP.Glorp_Character_BP"),
        entry("c1", "Glorp Alpha", "/Game/Mods/Y/GlorpA_Character_BP.GlorpA_Character_BP"),
        entry("c2", "Glorp Beta", "/Game/Mods/Y/GlorpB_Character_BP.GlorpB_Character_BP"),
      ],
    });
    const rows = buildPickerRows({
      sources: [solo],
      kind: "creatures",
      search: "",
      collapseVariants: true,
      variantParents: {
        "/game/mods/y/glorpa_character_bp.glorpa_character_bp":
          "/Game/Mods/Y/Glorp_Character_BP.Glorp_Character_BP",
        "/game/mods/y/glorpb_character_bp.glorpb_character_bp":
          "/Game/Mods/Y/Glorp_Character_BP.Glorp_Character_BP",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entry.name).toBe("Glorp");
    expect(rows[0].hiddenVariants).toBe(2);
  });

  it("surfaces the parent when only a hidden child matches, and says which", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "Party Dodo",
      collapseVariants: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entry.bpPath).toBe(DODO);
    expect(rows[0].matchedVia).toEqual(["Party Dodo"]);
  });

  it("does not explain the match when the parent matched on its own", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "Dodo",
      collapseVariants: true,
    });
    const dodo = rows.find((r) => r.entry.bpPath === DODO)!;
    expect(dodo.matchedVia).toEqual([]);
  });

  it("shows a creature whose parent cannot be resolved rather than hiding it", () => {
    const orphans = source({
      id: "mod-2",
      name: "Unknowns",
      creatures: [
        entry("o1", "Glorp", "/Game/Mods/Y/Glorp_Character_BP.Glorp_Character_BP"),
      ],
    });
    const rows = buildPickerRows({
      sources: [officialSource, orphans],
      kind: "creatures",
      search: "Glorp",
      collapseVariants: true,
    });
    expect(names(rows)).toEqual(["Glorp"]);
  });

  it("shows a variant whose parent is not itself in the catalog", () => {
    // The class resolves to an official creature, but that creature is not in
    // the sources being searched - hiding the child would make it unreachable.
    const onlyVariants = source({
      id: "mod-3",
      name: "Variants only",
      creatures: [
        entry("v1", "Aberrant Rex", "/Game/Mods/X/Rex_Character_BP_Aberrant.Rex_Character_BP_Aberrant"),
      ],
    });
    const rows = buildPickerRows({
      sources: [onlyVariants],
      kind: "creatures",
      search: "rex",
      collapseVariants: true,
    });
    expect(names(rows)).toEqual(["Aberrant Rex"]);
  });

  it("honours a manually assigned parent over the heuristics", () => {
    const odd = source({
      id: "mod-4",
      name: "Odd names",
      creatures: [
        entry("q1", "Quetzal Mk II", "/Game/Mods/Z/Weird_Character_BP.Weird_Character_BP"),
      ],
    });
    const rows = buildPickerRows({
      sources: [officialSource, odd],
      kind: "creatures",
      search: "Quetzal Mk II",
      collapseVariants: true,
      variantParents: {
        "/game/mods/z/weird_character_bp.weird_character_bp": REX,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entry.bpPath).toBe(REX);
    expect(rows[0].matchedVia).toEqual(["Quetzal Mk II"]);
  });

  it("groups a variant under a parent that lives in a different source", () => {
    const rows = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "Tek Rex",
      collapseVariants: true,
    });
    expect(rows[0].entry.bpPath).toBe(REX);
    expect(rows[0].source.id).toBe(officialSource.id);
  });

  it("collapses to far fewer rows than the flat list", () => {
    const flat = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "rex",
      collapseVariants: false,
      limit: 1000,
    });
    const collapsed = buildPickerRows({
      sources: SOURCES,
      kind: "creatures",
      search: "rex",
      collapseVariants: true,
      limit: 1000,
    });
    expect(collapsed.length).toBeLessThan(flat.length);
  });

  it("returns nothing when the search matches neither a parent nor a child", () => {
    expect(
      buildPickerRows({
        sources: SOURCES,
        kind: "creatures",
        search: "zzzznotathing",
        collapseVariants: true,
      }),
    ).toEqual([]);
  });
});

describe("item variant collapsing", () => {
  const itemSource = (items: CatalogEntry[]) =>
    source({ id: "official-asa", name: "Official ASA", items });

  const EGG = "/Game/PrimalEarth/Items/PrimalItemConsumable_Egg_Allo.PrimalItemConsumable_Egg_Allo";
  const FERT =
    "/Game/PrimalEarth/Items/PrimalItemConsumable_Egg_Allo_Fertilized.PrimalItemConsumable_Egg_Allo_Fertilized";

  const sources = [
    itemSource([
      { id: "i1", name: "Allosaurus Egg", bpPath: EGG },
      { id: "i2", name: "Fertilized Allosaurus Egg", bpPath: FERT },
    ]),
  ];
  const parents = { [normalizeBpPath(FERT)]: EGG };

  it("folds a fertilized egg onto the egg it comes from", () => {
    const rows = buildPickerRows({
      sources,
      kind: "items",
      search: "",
      collapseVariants: true,
      variantParents: parents,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].entry.name).toBe("Allosaurus Egg");
    expect(rows[0].hiddenVariants).toBe(1);
  });

  it("shows both when the toggle is off", () => {
    const rows = buildPickerRows({
      sources,
      kind: "items",
      search: "",
      collapseVariants: false,
      variantParents: parents,
    });
    expect(rows).toHaveLength(2);
  });

  it("still finds a variant by name while collapsed", () => {
    const rows = buildPickerRows({
      sources,
      kind: "items",
      search: "fertilized",
      collapseVariants: true,
      variantParents: parents,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].matchedVia).toContain("Fertilized Allosaurus Egg");
  });

  it("never groups two items that share no declared parent", () => {
    // Items have no naming convention worth guessing at: only an explicit
    // parent groups them, or every similarly named item would fold together.
    const unrelated = [
      itemSource([
        { id: "a", name: "Raw Meat", bpPath: "/G/PrimalItemConsumable_RawMeat.X" },
        { id: "b", name: "Raw Prime Meat", bpPath: "/G/PrimalItemConsumable_RawPrimeMeat.Y" },
      ]),
    ];
    const rows = buildPickerRows({
      sources: unrelated,
      kind: "items",
      search: "",
      collapseVariants: true,
      variantParents: {},
    });
    expect(rows).toHaveLength(2);
  });
});
