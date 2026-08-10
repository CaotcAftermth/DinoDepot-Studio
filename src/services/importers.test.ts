import { describe, expect, it } from "vitest";
import { absorbUnknownPaths } from "./importers";
import { emptyCatalog, normalizeBpPath, type CatalogFile } from "../model/catalog";
import { findCatalogDuplicates } from "../model/catalogDuplicates";
import { officialSource } from "../model/officialCatalog";

/**
 * Importing a live file adds any unknown blueprint path to an "Imported /
 * unsorted" source. That is another door into the catalog, so it has to obey
 * the same duplicate rules as the manual ones.
 */

const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
const NEW_CREATURE = "/Game/Mods/Z/Newthing_Character_BP.Newthing_Character_BP";
const NEW_ITEM = "/Game/Mods/Z/PrimalItem_Newthing.PrimalItem_Newthing";

function catalogWithMod(): CatalogFile {
  return {
    ...emptyCatalog(),
    sources: [
      {
        id: "mod",
        name: "Mod A",
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
        creatures: [{ id: "c", name: "Thing", bpPath: NEW_CREATURE }],
        items: [],
      },
    ],
  };
}

describe("absorbUnknownPaths", () => {
  it("adds paths the catalog does not have", () => {
    const { catalog, added } = absorbUnknownPaths(emptyCatalog(), {
      creatures: [NEW_CREATURE],
      items: [NEW_ITEM],
    });
    expect(added).toBe(2);
    const imported = catalog.sources.find((s) => s.kind === "imported")!;
    expect(imported.creatures).toHaveLength(1);
    expect(imported.items).toHaveLength(1);
  });

  it("does not re-add bundled official content", () => {
    const { added } = absorbUnknownPaths(emptyCatalog(), {
      creatures: [REX],
      items: [],
    });
    expect(added).toBe(0);
  });

  it("does not re-add something a project mod already catalogues", () => {
    const { added } = absorbUnknownPaths(catalogWithMod(), {
      creatures: [NEW_CREATURE],
      items: [],
    });
    expect(added).toBe(0);
  });

  it("matches regardless of case or a trailing _C", () => {
    const { added } = absorbUnknownPaths(catalogWithMod(), {
      creatures: [NEW_CREATURE.toUpperCase(), `${NEW_CREATURE}_C`],
      items: [],
    });
    expect(added).toBe(0);
  });

  it("adds a repeated path only once", () => {
    const { catalog, added } = absorbUnknownPaths(emptyCatalog(), {
      creatures: [NEW_CREATURE, NEW_CREATURE, `${NEW_CREATURE}_C`],
      items: [],
    });
    expect(added).toBe(1);
    expect(catalog.sources[0].creatures).toHaveLength(1);
  });

  it("keeps creature and item namespaces separate", () => {
    // The same path arriving as both is unusual but must not collapse into one.
    const { catalog } = absorbUnknownPaths(emptyCatalog(), {
      creatures: [NEW_CREATURE],
      items: [NEW_CREATURE],
    });
    const imported = catalog.sources[0];
    expect(imported.creatures).toHaveLength(1);
    expect(imported.items).toHaveLength(1);
  });

  it("leaves no duplicate classes behind", () => {
    const { catalog } = absorbUnknownPaths(catalogWithMod(), {
      creatures: [NEW_CREATURE, REX, NEW_CREATURE.toUpperCase(), "/Game/Z/A.A"],
      items: [NEW_ITEM, NEW_ITEM],
    });
    expect(
      findCatalogDuplicates([officialSource, ...catalog.sources]),
    ).toEqual([]);
  });

  it("returns the catalog untouched when there is nothing to add", () => {
    const before = catalogWithMod();
    const { catalog, added } = absorbUnknownPaths(before, {
      creatures: [NEW_CREATURE],
      items: [],
    });
    expect(added).toBe(0);
    expect(catalog).toBe(before);
  });

  it("appends to an existing Imported / unsorted source rather than making another", () => {
    const first = absorbUnknownPaths(emptyCatalog(), {
      creatures: [NEW_CREATURE],
      items: [],
    });
    const second = absorbUnknownPaths(first.catalog, {
      creatures: ["/Game/Z/Another.Another"],
      items: [],
    });
    const imported = second.catalog.sources.filter((s) => s.kind === "imported");
    expect(imported).toHaveLength(1);
    expect(imported[0].creatures.map((c) => normalizeBpPath(c.bpPath))).toEqual([
      normalizeBpPath(NEW_CREATURE),
      normalizeBpPath("/Game/Z/Another.Another"),
    ]);
  });
});
