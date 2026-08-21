import { describe, expect, it } from "vitest";
import {
  ContentSourceSchema,
  emptyCatalog,
  forgetPaths,
  isWatched,
  normalizeBpPath,
  pathsOf,
  type CatalogFile,
  type ContentSource,
} from "./catalog";
import { knownPaths, officialSource } from "./officialCatalog";

function source(over: Partial<ContentSource> = {}): ContentSource {
  return {
    id: "s1",
    name: "Test Mod",
    kind: "mod",
    curseforgeId: "972253",
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

describe("isWatched", () => {
  it("watches an enabled mod that can be looked up", () => {
    expect(isWatched(source())).toBe(true);
    expect(isWatched(source({ curseforgeId: "", url: "https://cf/x" }))).toBe(true);
  });

  it("does not watch a disabled mod", () => {
    // The whole point of folding the two switches together: a mod that is not
    // running is not one whose updates matter.
    expect(isWatched(source({ enabled: false }))).toBe(false);
  });

  it("does not watch a mod with nothing to check", () => {
    expect(isWatched(source({ curseforgeId: "", url: "" }))).toBe(false);
  });

  it("never watches bundled official content", () => {
    expect(isWatched(officialSource)).toBe(false);
  });

  it("keeps watching a mod that is being removed but still enabled", () => {
    // "Being removed" is a plan, not a state — the mod is still on the server
    // until it isn't, and an update to it still matters while it runs.
    expect(isWatched(source({ removed: true }))).toBe(true);
  });
});

describe("ContentSourceSchema", () => {
  it("loads a catalog written before the watch flag was dropped", () => {
    // Old projects carry `watch`; zod strips unknown keys, so they must still
    // parse and simply take their watching from `enabled` from now on.
    const legacy = { ...source({ enabled: true }), watch: false };
    const parsed = ContentSourceSchema.parse(legacy);
    expect("watch" in parsed).toBe(false);
    expect(isWatched(parsed)).toBe(true);
  });
});

const MOD_CREATURE = "/Game/Mods/Anomalo/Anomalo_Character_BP.Anomalo_Character_BP_C";
const MOD_ITEM = "/Game/Mods/Anomalo/PrimalItemSaddle_Anomalo.PrimalItemSaddle_Anomalo";
const OFFICIAL_REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";

function catalogWithMod(): CatalogFile {
  return {
    ...emptyCatalog(),
    sources: [
      source({
        creatures: [{ id: "c1", name: "Anomalocaris", bpPath: MOD_CREATURE }],
        items: [{ id: "i1", name: "Anomalo Saddle", bpPath: MOD_ITEM }],
      }),
    ],
    icons: {
      [normalizeBpPath(MOD_CREATURE)]: "file:Anomalo_Entry.webp",
      [normalizeBpPath(OFFICIAL_REX)]: "file:Rex.webp",
    },
    notes: { [normalizeBpPath(MOD_CREATURE)]: "how to tame it" },
    maps: { [normalizeBpPath(MOD_ITEM)]: "Ragnarok" },
  };
}

describe("pathsOf", () => {
  it("collects creatures and items, normalized", () => {
    const paths = pathsOf(catalogWithMod().sources);
    expect(paths.has(normalizeBpPath(MOD_CREATURE))).toBe(true);
    expect(paths.has(normalizeBpPath(MOD_ITEM))).toBe(true);
    expect(paths.size).toBe(2);
  });

  /**
   * Validation reads whatever is on disk. A source missing its lists has to
   * produce findings, not an exception that takes the whole report down.
   */
  it("survives a source with no entry lists", () => {
    const broken = [{ id: "s1", name: "Hand edited" } as unknown as ContentSource];
    expect(pathsOf(broken).size).toBe(0);
  });
});

describe("knownPaths", () => {
  it("counts official content as catalogued", () => {
    const known = knownPaths(catalogWithMod());
    expect(known.has(normalizeBpPath(MOD_CREATURE))).toBe(true);
    expect(known.has(normalizeBpPath(OFFICIAL_REX))).toBe(true);
  });
});

describe("forgetPaths", () => {
  it("drops every per-entry map for the paths given", () => {
    const catalog = catalogWithMod();
    const gone = forgetPaths(
      catalog,
      new Set([normalizeBpPath(MOD_CREATURE), normalizeBpPath(MOD_ITEM)]),
    );
    expect(gone.icons[normalizeBpPath(MOD_CREATURE)]).toBeUndefined();
    expect(gone.notes[normalizeBpPath(MOD_CREATURE)]).toBeUndefined();
    expect(gone.maps[normalizeBpPath(MOD_ITEM)]).toBeUndefined();
  });

  it("leaves data for paths it was not given", () => {
    const catalog = catalogWithMod();
    const gone = forgetPaths(catalog, new Set([normalizeBpPath(MOD_CREATURE)]));
    expect(gone.icons[normalizeBpPath(OFFICIAL_REX)]).toBe("file:Rex.webp");
    expect(gone.maps[normalizeBpPath(MOD_ITEM)]).toBe("Ragnarok");
  });

  it("returns the same catalog when there is nothing to forget", () => {
    const catalog = catalogWithMod();
    expect(forgetPaths(catalog, new Set())).toBe(catalog);
  });
});
