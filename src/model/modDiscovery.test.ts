import { describe, expect, it } from "vitest";
import {
  applyDiscovery,
  brokenReferences,
  classifyAsset,
  detectVariantTag,
  diffDiscovery,
  discoverMod,
  humanizeName,
  impactedReferences,
  parseManifest,
  parseModFolderName,
  parseUplugin,
  planDiscovery,
  referencedBlueprintPaths,
  toBlueprintPath,
  type DiscoveredMod,
} from "./modDiscovery";
import { emptyCatalog, normalizeBpPath, type CatalogEntry } from "./catalog";

/** Ids are injected so entry identity is stable across a test run. */
function counter() {
  let n = 0;
  return () => `disc-${++n}`;
}

/** Shape of a real manifest line: cooked path, tab, ISO timestamp. */
function manifest(...paths: string[]): string {
  return paths.map((p) => `${p}\t2026-07-30T02:54:43.563Z`).join("\n");
}

describe("installed mod folder names", () => {
  it("splits the CurseForge project id from the file id", () => {
    expect(parseModFolderName("1005095_8537720")).toEqual({
      projectId: "1005095",
      fileId: "8537720",
    });
  });

  it("rejects anything that is not two numbers", () => {
    expect(parseModFolderName("Novabeast")).toBeNull();
    expect(parseModFolderName("1005095")).toBeNull();
    expect(parseModFolderName("1005095_8537720_extra")).toBeNull();
  });
});

describe("manifest parsing", () => {
  it("reads path and timestamp from each line", () => {
    const rows = parseManifest(
      "ShooterGame/Mods/Novabeast/Content/A.uasset\t2026-07-30T02:52:44.172Z",
    );
    expect(rows).toEqual([
      {
        cookedPath: "ShooterGame/Mods/Novabeast/Content/A.uasset",
        mtime: "2026-07-30T02:52:44.172Z",
      },
    ]);
  });

  it("ignores blank lines and tolerates CRLF", () => {
    expect(parseManifest("a.uasset\tT\r\n\r\nb.uasset\tT\r\n")).toHaveLength(2);
  });

  it("keeps a path that carries no timestamp rather than dropping content", () => {
    const rows = parseManifest("ShooterGame/Mods/M/Content/A.uasset");
    expect(rows).toEqual([
      { cookedPath: "ShooterGame/Mods/M/Content/A.uasset", mtime: "" },
    ]);
  });
});

describe("blueprint path transform", () => {
  // Both of these are taken from live cluster remap config, so they are the
  // ground truth the whole feature rests on.
  it("produces the path a live remap already uses (Ports of Atlas)", () => {
    const asset = toBlueprintPath(
      "ShooterGame/Mods/PortsOfAtlas/Content/Creatures/GrandTortugar/GrandTortugar_Character_BP.uasset",
      "PortsOfAtlas",
    );
    expect(asset?.bpPath).toBe(
      "/PortsOfAtlas/Creatures/GrandTortugar/GrandTortugar_Character_BP.GrandTortugar_Character_BP",
    );
  });

  it("produces the path a live remap already uses (AAHelicoprion)", () => {
    const asset = toBlueprintPath(
      "ShooterGame/Mods/AAHelicoprion/Content/Dinos/HelicoprionAA_Character_BP.uasset",
      "AAHelicoprion",
    );
    expect(asset?.bpPath).toBe(
      "/AAHelicoprion/Dinos/HelicoprionAA_Character_BP.HelicoprionAA_Character_BP",
    );
  });

  it("mounts at the plugin name rather than under /Game/", () => {
    // ASA mods are Unreal plugins; only official content lives under /Game/.
    const asset = toBlueprintPath(
      "ShooterGame/Mods/Novabeast/Content/PrimalGameData_Novabeast.uasset",
      "Novabeast",
    );
    expect(asset?.bpPath.startsWith("/Novabeast/")).toBe(true);
  });

  it("skips the payload files that accompany every asset", () => {
    // Counting .uexp/.ubulk alongside .uasset would double every total.
    for (const ext of [".uexp", ".ubulk", ".uptnl"]) {
      expect(
        toBlueprintPath(`ShooterGame/Mods/M/Content/A${ext}`, "M"),
      ).toBeNull();
    }
  });

  it("accepts .umap and flags it", () => {
    expect(
      toBlueprintPath("ShooterGame/Mods/M/Content/TestMap.umap", "M")?.isMap,
    ).toBe(true);
  });

  it("rejects paths belonging to a different mod", () => {
    expect(
      toBlueprintPath("ShooterGame/Mods/Other/Content/A.uasset", "M"),
    ).toBeNull();
  });

  it("rejects files outside Content/, such as the asset registry", () => {
    expect(
      toBlueprintPath("ShooterGame/Mods/M/AssetRegistry.bin", "M"),
    ).toBeNull();
  });
});

describe("asset classification", () => {
  it("recognises creatures with and without the class suffix", () => {
    expect(classifyAsset("Rex_Character_BP")).toBe("creature");
    expect(classifyAsset("ARKOLOGY_Acrocanthosaurus_Character_BP_C")).toBe(
      "creature",
    );
  });

  it("recognises every PrimalItem flavour as an item", () => {
    for (const leaf of [
      "PrimalItemResource_ApexDrop_Acro_Alpha",
      "PrimalItemConsumable_Egg_Allo_Fertilized",
      "PrimalItemStructure_Wall",
      "PrimalItemSkin_AberrationHelmet",
    ]) {
      expect(classifyAsset(leaf)).toBe("item");
    }
  });

  it("keeps engram entries out of the item list", () => {
    // Engrams are the easiest thing to mistake for an item and would inflate
    // every mod's item count with unspawnable classes.
    expect(classifyAsset("EngramEntry_StoneWall")).toBe("engram");
  });

  it("leaves meshes, materials and textures unclassified", () => {
    for (const leaf of ["SK_Fox_Skin", "MI_Rex_Body", "T_Icon_Sword", "Buff_Foo"]) {
      expect(classifyAsset(leaf)).toBe("other");
    }
  });
});

describe("variant tag detection", () => {
  it("finds the token a re-skin mod stamps on every creature", () => {
    expect(
      detectVariantTag([
        "ARKOLOGY_Acrocanthosaurus_Character_BP",
        "ARKOLOGY_Angler_Character_BP",
        "Arkology_Allo_Character_BP",
        "Arkology_Ankylo_Character_BP",
      ]),
    ).toBe("ARKOLOGY");
  });

  it("ignores a token only a minority share", () => {
    expect(
      detectVariantTag([
        "ARKOLOGY_Rex_Character_BP",
        "Wyvern_Fire_Character_BP",
        "Drake_Rock_Character_BP",
        "Golem_Ice_Character_BP",
      ]),
    ).toBe("");
  });

  it("declines to guess from too few creatures", () => {
    // Two creatures sharing a first word is a coincidence, not a brand.
    expect(
      detectVariantTag(["Moros_Livyatan_Character_BP", "Moros_Gigantophis_Character_BP"]),
    ).toBe("");
  });

  it("returns nothing for an empty roster", () => {
    expect(detectVariantTag([])).toBe("");
  });
});

describe("readable names", () => {
  it("strips the creature class suffix", () => {
    expect(humanizeName("GrandTortugar_Character_BP")).toBe("Grand Tortugar");
  });

  it("strips the PrimalItem prefix whatever the flavour", () => {
    expect(humanizeName("PrimalItemResource_SnailPaste")).toBe("Snail Paste");
    expect(humanizeName("PrimalItemConsumable_Berry_Mejoberry")).toBe(
      "Berry Mejoberry",
    );
  });

  it("removes the mod's variant tag so the base creature reads clearly", () => {
    expect(humanizeName("ARKOLOGY_Acrocanthosaurus_Character_BP", "ARKOLOGY")).toBe(
      "Acrocanthosaurus",
    );
  });

  it("keeps acronyms intact when splitting camel case", () => {
    expect(humanizeName("PrimalItemResource_ApexDropTSW")).toBe("Apex Drop TSW");
  });

  it("falls back to the class name rather than returning nothing", () => {
    expect(humanizeName("PrimalItemResource_")).toBe("PrimalItemResource_");
  });
});

describe("uplugin parsing", () => {
  const real = JSON.stringify({
    FileVersion: 3,
    VersionName: "345925C9468833964C450FB90CC37E11",
    FriendlyName: "Novabeast (Custom Cosmetic)",
    Description: "Adds a custom Novabeast as chest cosmetic.&cf_ugcID=1005095",
    Category: "UGC",
    MarketplaceURL: "https://www.curseforge.com/ark-survival-ascended/mods/novabeast-cosmetic",
  });

  it("pulls the CurseForge id out of the description", () => {
    expect(parseUplugin(real).cfUgcId).toBe("1005095");
  });

  it("keeps the id out of the human-facing description", () => {
    expect(parseUplugin(real).description).toBe(
      "Adds a custom Novabeast as chest cosmetic.",
    );
  });

  it("reads the name and marketplace link", () => {
    const meta = parseUplugin(real);
    expect(meta.friendlyName).toBe("Novabeast (Custom Cosmetic)");
    expect(meta.marketplaceUrl).toContain("curseforge.com");
  });

  it("tolerates a byte order mark", () => {
    expect(parseUplugin(`﻿${real}`).friendlyName).toBe(
      "Novabeast (Custom Cosmetic)",
    );
  });

  it("degrades to blanks rather than throwing on malformed JSON", () => {
    // A mod with an unreadable plugin file is still worth cataloguing.
    expect(parseUplugin("{not json").friendlyName).toBe("");
    expect(parseUplugin("").cfUgcId).toBe("");
  });
});

describe("discovering a mod", () => {
  const raw = {
    folderName: "945275_7802896",
    shortName: "PortsOfAtlas",
    uplugin: JSON.stringify({
      FriendlyName: "The Ports of Atlas",
      Description: "Adds ships.&cf_ugcID=945275",
      MarketplaceURL: "https://www.curseforge.com/ark-survival-ascended/mods/ports-of-atlas",
    }),
    manifest: manifest(
      "ShooterGame/Mods/PortsOfAtlas/Content/Creatures/GrandTortugar/GrandTortugar_Character_BP.uasset",
      "ShooterGame/Mods/PortsOfAtlas/Content/Creatures/GrandTortugar/GrandTortugar_Character_BP.uexp",
      "ShooterGame/Mods/PortsOfAtlas/Content/Items/PrimalItemResource_Plank.uasset",
      "ShooterGame/Mods/PortsOfAtlas/Content/Items/EngramEntry_Plank.uasset",
      "ShooterGame/Mods/PortsOfAtlas/Content/Meshes/SM_Hull.uasset",
      "ShooterGame/Mods/PortsOfAtlas/AssetRegistry.bin",
    ),
  };

  it("preserves the plugin CurseForge id when the install folder is unusual", () => {
    const result = discoverMod({ ...raw, folderName: "PortsOfAtlas" }, counter());
    expect(result.projectId).toBe("945275");
    expect(result.fileId).toBe("");
    expect(result.warnings[0]).toContain("not the expected");
  });

  it("produces catalog entries for creatures and items only", () => {
    const mod = discoverMod(raw, counter());
    expect(mod.creatures.map((c) => c.name)).toEqual(["Grand Tortugar"]);
    expect(mod.items.map((i) => i.name)).toEqual(["Plank"]);
  });

  it("counts what it saw without cataloguing it", () => {
    const mod = discoverMod(raw, counter());
    expect(mod.counts.engram).toBe(1);
    expect(mod.counts.other).toBe(1);
  });

  it("carries the mod identity through", () => {
    const mod = discoverMod(raw, counter());
    expect(mod.projectId).toBe("945275");
    expect(mod.fileId).toBe("7802896");
    expect(mod.name).toBe("The Ports of Atlas");
    expect(mod.url).toContain("ports-of-atlas");
  });

  it("does not emit the same blueprint twice", () => {
    // The payload file shares its stem with the asset; only one entry may result.
    const mod = discoverMod(raw, counter());
    expect(mod.creatures).toHaveLength(1);
  });

  it("stores paths without a trailing _C, matching the bundled catalog", () => {
    const mod = discoverMod(raw, counter());
    expect(mod.creatures[0].bpPath.endsWith("_C")).toBe(false);
  });

  it("falls back to the plugin name when there is no friendly name", () => {
    const mod = discoverMod({ ...raw, uplugin: "" }, counter());
    expect(mod.name).toBe("PortsOfAtlas");
    expect(mod.warnings.some((w) => w.includes(".uplugin"))).toBe(true);
  });

  it("warns when a mod yields nothing catalogable", () => {
    const mod = discoverMod(
      {
        ...raw,
        manifest: manifest("ShooterGame/Mods/PortsOfAtlas/Content/Meshes/SM_Hull.uasset"),
      },
      counter(),
    );
    expect(mod.creatures).toHaveLength(0);
    expect(mod.warnings.some((w) => w.includes("No creatures or items"))).toBe(true);
  });

  it("warns when the plugin disagrees with the folder about its id", () => {
    const mod = discoverMod({ ...raw, folderName: "999999_1" }, counter());
    expect(mod.warnings.some((w) => w.includes("945275"))).toBe(true);
  });

  it("warns when the folder cannot be versioned", () => {
    const mod = discoverMod({ ...raw, folderName: "PortsOfAtlas" }, counter());
    expect(mod.warnings.some((w) => w.includes("version"))).toBe(true);
  });
});

describe("re-discovery diff", () => {
  const entry = (name: string, bpPath: string): CatalogEntry => ({
    id: name,
    name,
    bpPath,
  });

  const rex = entry("Rex", "/M/Dinos/Rex_Character_BP.Rex_Character_BP");
  const raptor = entry("Raptor", "/M/Dinos/Raptor_Character_BP.Raptor_Character_BP");

  it("reports genuinely new content as added", () => {
    const diff = diffDiscovery([rex], [rex, raptor]);
    expect(diff.added.map((e) => e.name)).toEqual(["Raptor"]);
    expect(diff.removed).toHaveLength(0);
    expect(diff.unchanged).toBe(1);
  });

  it("reports deleted content as removed", () => {
    const diff = diffDiscovery([rex, raptor], [rex]);
    expect(diff.removed.map((e) => e.name)).toEqual(["Raptor"]);
  });

  it("reports a moved blueprint as renamed, not as a delete plus an add", () => {
    // This is the case that silently breaks config: a rule pointing at the old
    // path keeps validating while producing nothing in game.
    const moved = entry("Rex", "/M/Creatures/Rex_Character_BP.Rex_Character_BP");
    const diff = diffDiscovery([rex], [moved]);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.renamed).toHaveLength(1);
    expect(diff.renamed[0].to.bpPath).toBe(moved.bpPath);
  });

  it("treats an unchanged catalogue as entirely unchanged", () => {
    const diff = diffDiscovery([rex, raptor], [rex, raptor]);
    expect(diff.unchanged).toBe(2);
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.renamed).toHaveLength(0);
  });

  it("ignores a trailing _C difference between scans", () => {
    const withSuffix = entry("Rex", `${rex.bpPath}_C`);
    expect(diffDiscovery([rex], [withSuffix]).unchanged).toBe(1);
  });
});

describe("broken references", () => {
  const rex = { id: "1", name: "Rex", bpPath: "/M/Dinos/Rex_Character_BP.Rex_Character_BP" };
  const moved = {
    id: "1",
    name: "Rex",
    bpPath: "/M/Creatures/Rex_Character_BP.Rex_Character_BP",
  };

  it("points a rule at where its blueprint moved to", () => {
    const diff = diffDiscovery([rex], [moved]);
    expect(brokenReferences([rex.bpPath], diff)).toEqual([
      { path: rex.bpPath, movedTo: moved.bpPath },
    ]);
  });

  it("flags a reference whose blueprint is simply gone", () => {
    const diff = diffDiscovery([rex], []);
    expect(brokenReferences([rex.bpPath], diff)).toEqual([
      { path: rex.bpPath, movedTo: null },
    ]);
  });

  it("says nothing about references that still resolve", () => {
    const diff = diffDiscovery([rex], [rex]);
    expect(brokenReferences([rex.bpPath], diff)).toEqual([]);
  });

  it("matches a stored path that carries the class suffix", () => {
    // Remap config stores fromClass with _C; the catalogue does not.
    const diff = diffDiscovery([rex], []);
    expect(brokenReferences([`${rex.bpPath}_C`], diff)).toHaveLength(1);
  });
});

describe("review then apply", () => {
  const REX = "/M/Dinos/Rex_Character_BP.Rex_Character_BP";
  const RAPTOR = "/M/Dinos/Raptor_Character_BP.Raptor_Character_BP";
  const PLANK = "/M/Items/PrimalItemResource_Plank.PrimalItemResource_Plank";

  function mod(over: Partial<DiscoveredMod> = {}): DiscoveredMod {
    return {
      projectId: "945275",
      fileId: "7802896",
      shortName: "M",
      name: "Test Mod",
      url: "https://example.com/mod",
      meta: {
        friendlyName: "Test Mod",
        description: "",
        category: "UGC",
        versionName: "",
        createdBy: "",
        marketplaceUrl: "",
        cfUgcId: "945275",
      },
      variantTag: "",
      creatures: [{ id: "c1", name: "Rex", bpPath: REX }],
      items: [{ id: "i1", name: "Plank", bpPath: PLANK }],
      counts: { creature: 1, item: 1, engram: 0, other: 0, map: 0 },
      warnings: [],
      ...over,
    };
  }

  /** A project that already has this mod catalogued. */
  function catalogWithMod(creatures: CatalogEntry[], items: CatalogEntry[] = []) {
    const catalog = emptyCatalog();
    catalog.sources.push({
      id: "src-1",
      name: "Test Mod",
      kind: "mod",
      curseforgeId: "945275",
      url: "",
      docsUrl: "https://docs.example.com",
      discordUrl: "",
      iconsDir: "mods/testmod",
      iniNotes: "some notes",
      iniSettings: [],
      iniBuild: {},
      variantTag: "",
      modpackId: "",
      modpackVersion: "",
      enabled: false,
      removed: false,
      notes: "admin notes",
      creatures,
      items,
    });
    return catalog;
  }

  it("plans an addition when the project has never seen the mod", () => {
    const plan = planDiscovery(emptyCatalog(), mod());
    expect(plan.existingSourceId).toBeNull();
    expect(plan.creatures.added).toHaveLength(1);
  });

  it("treats a brand new mod as something to do", () => {
    // Everything about an unseen mod is a change; reporting otherwise disables
    // the Apply button on exactly the case discovery exists for.
    expect(planDiscovery(emptyCatalog(), mod()).noChanges).toBe(false);
  });

  it("still has something to do when a known mod gains content", () => {
    const plan = planDiscovery(catalogWithMod([]), mod());
    expect(plan.noChanges).toBe(false);
  });

  it("plans an update against the source with the same CurseForge id", () => {
    const plan = planDiscovery(
      catalogWithMod([{ id: "old", name: "Rex", bpPath: REX }]),
      mod(),
    );
    expect(plan.existingSourceId).toBe("src-1");
    expect(plan.creatures.unchanged).toBe(1);
  });

  it("reports nothing to do when a re-scan finds the same content", () => {
    const plan = planDiscovery(
      catalogWithMod(
        [{ id: "old", name: "Rex", bpPath: REX }],
        [{ id: "oldi", name: "Plank", bpPath: PLANK }],
      ),
      mod(),
    );
    expect(plan.noChanges).toBe(true);
  });

  it("surfaces what the project would lose", () => {
    const plan = planDiscovery(
      catalogWithMod([
        { id: "old", name: "Rex", bpPath: REX },
        { id: "hand", name: "Raptor", bpPath: RAPTOR },
      ]),
      mod(),
    );
    expect(plan.unmatchedCreatures.map((e) => e.name)).toEqual(["Raptor"]);
  });

  it("keeps hand-added entries discovery could not classify", () => {
    // The classifier reads naming conventions; an oddly named creature an admin
    // added by hand must not vanish because of that.
    const catalog = catalogWithMod([
      { id: "old", name: "Rex", bpPath: REX },
      { id: "hand", name: "Raptor", bpPath: RAPTOR },
    ]);
    const plan = planDiscovery(catalog, mod());
    const { catalog: next, keptUnmatched } = applyDiscovery(catalog, plan, () => "new");

    const source = next.sources.find((s) => s.id === "src-1")!;
    expect(source.creatures.map((c) => c.name).sort()).toEqual(["Raptor", "Rex"]);
    expect(source.discovery?.creatures.map((c) => c.name)).toEqual(["Rex"]);
    expect(source.structuralOverrides?.creatures.map((c) => c.name)).toEqual([
      "Raptor",
    ]);
    expect(keptUnmatched).toBe(1);
  });

  it("drops them when the admin asks for the mod's version wholesale", () => {
    const catalog = catalogWithMod([
      { id: "old", name: "Rex", bpPath: REX },
      { id: "hand", name: "Raptor", bpPath: RAPTOR },
    ]);
    const plan = planDiscovery(catalog, mod());
    const { catalog: next } = applyDiscovery(catalog, plan, () => "new", {
      keepUnmatched: false,
    });
    expect(
      next.sources.find((s) => s.id === "src-1")!.creatures.map((c) => c.name),
    ).toEqual(["Rex"]);
  });

  it("never touches what the admin owns", () => {
    const catalog = catalogWithMod([{ id: "old", name: "Rex", bpPath: REX }]);
    const plan = planDiscovery(catalog, mod());
    const source = applyDiscovery(catalog, plan, () => "new").catalog.sources.find(
      (s) => s.id === "src-1",
    )!;

    // Whether the mod runs here, and everything written about it, is a cluster
    // decision that a re-scan of the mod's files has no business changing.
    expect(source.enabled).toBe(false);
    expect(source.notes).toBe("admin notes");
    expect(source.iniNotes).toBe("some notes");
    expect(source.iconsDir).toBe("mods/testmod");
    expect(source.docsUrl).toBe("https://docs.example.com");
  });

  it("adds a new source when there was none", () => {
    const catalog = emptyCatalog();
    const plan = planDiscovery(catalog, mod());
    const result = applyDiscovery(catalog, plan, () => "src-new");

    expect(result.updated).toBe(false);
    expect(result.catalog.sources).toHaveLength(1);
    const source = result.catalog.sources[0];
    expect(source.name).toBe("Test Mod");
    expect(source.curseforgeId).toBe("945275");
    expect(source.url).toBe("https://example.com/mod");
    expect(source.kind).toBe("mod");
    expect(source.discovery).toMatchObject({
      fileId: "7802896",
      shortName: "M",
    });
  });

  it("carries a detected variant tag onto a brand new source", () => {
    const catalog = emptyCatalog();
    const plan = planDiscovery(catalog, mod({ variantTag: "ARKOLOGY" }));
    expect(
      applyDiscovery(catalog, plan, () => "s").catalog.sources[0].variantTag,
    ).toBe("ARKOLOGY");
  });

  it("moves notes and icons onto a renamed blueprint rather than orphaning them", () => {
    // A mod update that moves a blueprint must not cost the admin the taming
    // write-up they attached to it.
    const catalog = catalogWithMod([{ id: "old", name: "Rex", bpPath: REX }]);
    catalog.notes[normalizeBpPath(REX)] = "Tame with prime meat";
    catalog.icons[normalizeBpPath(REX)] = "🦖";

    const movedPath = "/M/Creatures/Rex_Character_BP.Rex_Character_BP";
    const plan = planDiscovery(
      catalog,
      mod({ creatures: [{ id: "c1", name: "Rex", bpPath: movedPath }] }),
    );
    expect(plan.creatures.renamed).toHaveLength(1);

    const next = applyDiscovery(catalog, plan, () => "new").catalog;
    expect(next.notes[normalizeBpPath(movedPath)]).toBe("Tame with prime meat");
    expect(next.icons[normalizeBpPath(movedPath)]).toBe("🦖");
    expect(next.notes[normalizeBpPath(REX)]).toBeUndefined();
  });

  it("leaves out entries unticked during review", () => {
    const catalog = emptyCatalog();
    const plan = planDiscovery(catalog, mod());
    const { catalog: next } = applyDiscovery(catalog, plan, () => "s", {
      exclude: new Set([normalizeBpPath(PLANK)]),
    });
    const source = next.sources[0];
    expect(source.items).toHaveLength(0);
    expect(source.creatures).toHaveLength(1);
  });

  it("matches an exclusion regardless of the class suffix", () => {
    const catalog = emptyCatalog();
    const plan = planDiscovery(catalog, mod());
    const { catalog: next } = applyDiscovery(catalog, plan, () => "s", {
      exclude: new Set([normalizeBpPath(`${REX}_C`)]),
    });
    expect(next.sources[0].creatures).toHaveLength(0);
  });

  it("counts kept entries correctly even when others were excluded", () => {
    const catalog = catalogWithMod([
      { id: "old", name: "Rex", bpPath: REX },
      { id: "hand", name: "Raptor", bpPath: RAPTOR },
    ]);
    const plan = planDiscovery(catalog, mod());
    const result = applyDiscovery(catalog, plan, () => "new", {
      exclude: new Set([normalizeBpPath(REX)]),
    });
    // Raptor is the admin's own; excluding Rex must not distort the tally.
    expect(result.keptUnmatched).toBe(1);
    expect(
      result.catalog.sources[0].creatures.map((c) => c.name),
    ).toEqual(["Raptor"]);
  });

  it("keeps a local rename of the mod itself", () => {
    const catalog = catalogWithMod([]);
    catalog.sources[0].name = "My Renamed Mod";
    const plan = planDiscovery(catalog, mod());
    expect(
      applyDiscovery(catalog, plan, () => "new").catalog.sources[0].name,
    ).toBe("My Renamed Mod");
  });
});

describe("config impact", () => {
  const REX = "/M/Dinos/Rex_Character_BP.Rex_Character_BP";
  const HIDE = "/M/Items/PrimalItemResource_Hide.PrimalItemResource_Hide";
  const KERATIN = "/M/Items/PrimalItemResource_Keratin.PrimalItemResource_Keratin";
  const BERRY = "/M/Items/PrimalItemConsumable_Berry.PrimalItemConsumable_Berry";

  const production = {
    rules: [
      {
        dinoType: REX,
        cycles: [
          {
            items: [
              {
                bpPath: HIDE,
                alternateItems: [{ bpPath: KERATIN }],
                consumesItems: [{ bpPath: BERRY }],
              },
            ],
          },
        ],
      },
    ],
  };

  const remaps = {
    entries: [{ fromClass: `${REX}_C`, toClass: "/Game/ASA/Dinos/Rex.Rex_C" }],
  };

  it("finds every path a rule names, at any depth", () => {
    const refs = referencedBlueprintPaths(production, { entries: [] });
    expect(refs.map((r) => r.bpPath)).toEqual([REX, HIDE, KERATIN, BERRY]);
  });

  it("labels each reference the way the validation screens do", () => {
    const refs = referencedBlueprintPaths(production, { entries: [] });
    expect(refs.map((r) => r.where)).toEqual([
      "Rex_Character_BP",
      "Rex_Character_BP › Cycle 1 › Item 1",
      "Rex_Character_BP › Cycle 1 › Item 1 › Alternate 1",
      "Rex_Character_BP › Cycle 1 › Item 1 › Consumes 1",
    ]);
  });

  it("covers both sides of a remap", () => {
    const refs = referencedBlueprintPaths({ rules: [] }, remaps);
    expect(refs.map((r) => r.where)).toEqual(["Remap 1 (from)", "Remap 1 (to)"]);
  });

  it("skips empty paths rather than reporting blanks", () => {
    const refs = referencedBlueprintPaths(
      { rules: [{ dinoType: "", cycles: [] }] },
      { entries: [{ fromClass: "", toClass: "" }] },
    );
    expect(refs).toEqual([]);
  });

  it("says nothing when a discovery changes nothing relevant", () => {
    const diff = diffDiscovery(
      [{ id: "1", name: "Rex", bpPath: REX }],
      [{ id: "1", name: "Rex", bpPath: REX }],
    );
    expect(
      impactedReferences(referencedBlueprintPaths(production, remaps), [diff]),
    ).toEqual([]);
  });

  it("points a rule at where its item moved to", () => {
    const moved = "/M/Resources/PrimalItemResource_Hide.PrimalItemResource_Hide";
    const diff = diffDiscovery(
      [{ id: "1", name: "Hide", bpPath: HIDE }],
      [{ id: "1", name: "Hide", bpPath: moved }],
    );
    const impacts = impactedReferences(
      referencedBlueprintPaths(production, remaps),
      [diff],
    );
    expect(impacts).toHaveLength(1);
    expect(impacts[0].reference.where).toBe("Rex_Character_BP › Cycle 1 › Item 1");
    expect(impacts[0].movedTo).toBe(moved);
  });

  it("flags a remap whose source creature the mod dropped", () => {
    // The remap stores fromClass with _C; the catalogue does not.
    const diff = diffDiscovery([{ id: "1", name: "Rex", bpPath: REX }], []);
    const impacts = impactedReferences(
      referencedBlueprintPaths({ rules: [] }, remaps),
      [diff],
    );
    expect(impacts).toHaveLength(1);
    expect(impacts[0].reference.kind).toBe("remap");
    expect(impacts[0].movedTo).toBeNull();
  });

  it("combines the diffs of several mods in one pass", () => {
    const creatureDiff = diffDiscovery([{ id: "1", name: "Rex", bpPath: REX }], []);
    const itemDiff = diffDiscovery([{ id: "2", name: "Hide", bpPath: HIDE }], []);
    const impacts = impactedReferences(
      referencedBlueprintPaths(production, { entries: [] }),
      [creatureDiff, itemDiff],
    );
    expect(impacts.map((i) => i.reference.bpPath).sort()).toEqual(
      [HIDE, REX].sort(),
    );
  });
});
