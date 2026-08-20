import { describe, expect, it } from "vitest";
import {
  applyModpack,
  compareVersions,
  ModpackSchema,
  iconBaseName,
  matchModpackSource,
  packDirName,
  packFileName,
  packIconFiles,
  registryEntryFor,
  RegistryEntrySchema,
  registryVersion,
  searchRegistry,
  slugify,
  sourceToModpack,
  templateModpack,
  templateReadme,
  updateAvailable,
  type Modpack,
  type RegistryEntry,
} from "./modpack";
import {
  ContentSourceSchema,
  IniSettingSchema,
  emptyCatalog,
  normalizeBpPath,
  type CatalogFile,
  type ContentSource,
} from "./catalog";
import { emptyCreatureInfo } from "./creatureInfo";

const CREATURE = "/Game/Mods/Test/Dinos/Foo_Character_BP.Foo_Character_BP_C";
const ITEM = "/Game/Mods/Test/Items/PrimalItemResource_Bar.PrimalItemResource_Bar";
const OFFICIAL = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";

let n = 0;
const ids = () => `id-${++n}`;

function source(patch: Partial<ContentSource> = {}): ContentSource {
  return ContentSourceSchema.parse({
    id: "src-1",
    name: "Test Mod",
    kind: "mod",
    curseforgeId: "12345",
    url: "https://curseforge.example/mod",
    docsUrl: "https://docs.example",
    discordUrl: "https://discord.gg/x",
    iniNotes: "notes",
    enabled: true,
    removed: false,
    notes: "",
    creatures: [{ id: "c1", name: "Foo", bpPath: CREATURE }],
    items: [{ id: "i1", name: "Bar", bpPath: ITEM }],
    ...patch,
  });
}

/** A catalog holding data for the mod's paths *and* an official one. */
function catalogWithData(): CatalogFile {
  const catalog = emptyCatalog();
  catalog.sources = [source()];
  catalog.icons[normalizeBpPath(CREATURE)] = "🦖";
  catalog.icons[normalizeBpPath(OFFICIAL)] = "🦕";
  catalog.notes[normalizeBpPath(CREATURE)] = "mod creature note";
  catalog.notes[normalizeBpPath(OFFICIAL)] = "our own Rex note";
  catalog.maps[normalizeBpPath(ITEM)] = "Ragnarok";
  catalog.creatureInfo[normalizeBpPath(CREATURE)] = {
    ...emptyCreatureInfo(),
    notes: "how to tame Foo",
  };
  catalog.creatureInfo[normalizeBpPath(OFFICIAL)] = {
    ...emptyCreatureInfo(),
    notes: "our own Rex writeup",
  };
  return catalog;
}

describe("compareVersions", () => {
  it("orders dotted numbers numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.1", "1.2")).toBe(1);
  });

  it("does not throw on junk from community data", () => {
    expect(compareVersions("", "0")).toBe(0);
    expect(compareVersions("1.x.0", "1.0.0")).toBe(0);
  });

  it("tolerates a leading v, which community versions constantly carry", () => {
    // Treating "v2.0.0" as older than "1.0.0" would hide a real update.
    expect(compareVersions("v2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("v1.0.0", "1.0.0")).toBe(0);
  });
});

describe("updateAvailable", () => {
  const entry = (patch: Partial<RegistryEntry> = {}): RegistryEntry => ({
    id: "test-mod",
    name: "Test Mod",
    version: "2.0.0",
    updatedAt: "",
    author: "",
    description: "",
    curseforgeId: "",
    dir: "",
    file: "",
    creatureCount: 0,
    itemCount: 0,
    ...patch,
  });

  it("reports an update when the registry is ahead", () => {
    const installed = { modpackId: "test-mod", modpackVersion: "1.0.0" };
    expect(updateAvailable(installed, entry())).toBe(true);
  });

  it("stays quiet when the installed version is current or newer", () => {
    expect(
      updateAvailable({ modpackId: "test-mod", modpackVersion: "2.0.0" }, entry()),
    ).toBe(false);
    expect(
      updateAvailable({ modpackId: "test-mod", modpackVersion: "3.0.0" }, entry()),
    ).toBe(false);
  });

  it("never claims an update for a hand-added source", () => {
    // A source catalogued here is nobody else's to update, however closely a
    // registry entry happens to match it.
    expect(updateAvailable({ modpackId: "", modpackVersion: "" }, entry())).toBe(
      false,
    );
  });

  it("ignores an entry for a different pack", () => {
    expect(
      updateAvailable(
        { modpackId: "other-mod", modpackVersion: "1.0.0" },
        entry(),
      ),
    ).toBe(false);
  });
});

describe("immutable registry versions", () => {
  it("finds only the requested exact version", () => {
    const entry = RegistryEntrySchema.parse({
      id: "pack",
      name: "Pack",
      version: "2.0.0",
      versions: [
        { version: "1.0.0", manifest: "pack/versions/1.0.0/manifest.json" },
        { version: "2.0.0", manifest: "pack/versions/2.0.0/manifest.json" },
      ],
    });
    expect(registryVersion(entry, "1.0.0")?.manifest).toContain("/1.0.0/");
    expect(registryVersion(entry, "1.0")).toBeNull();
    expect(registryVersion(entry, "3.0.0")).toBeNull();
  });
});

describe("searchRegistry", () => {
  const packs: RegistryEntry[] = [
    registryEntryFor(
      ModpackSchema.parse({ meta: { id: "ports", name: "Ports of Atlas", curseforgeId: "972253" } }),
    ),
    registryEntryFor(
      ModpackSchema.parse({ meta: { id: "arkology", name: "ARKOLOGY", author: "someone" } }),
    ),
  ];

  it("matches on name, id and CurseForge id", () => {
    expect(searchRegistry(packs, "atlas").map((p) => p.id)).toEqual(["ports"]);
    expect(searchRegistry(packs, "972253").map((p) => p.id)).toEqual(["ports"]);
    expect(searchRegistry(packs, "arkology").map((p) => p.id)).toEqual(["arkology"]);
  });

  it("is case-insensitive and returns everything for a blank query", () => {
    expect(searchRegistry(packs, "PORTS").map((p) => p.id)).toEqual(["ports"]);
    expect(searchRegistry(packs, "   ")).toHaveLength(2);
  });
});

describe("packFileName", () => {
  it("falls back to <id>.json", () => {
    expect(packFileName({ id: "ports" })).toBe("ports.json");
    expect(packFileName({ id: "ports", file: "custom.json" })).toBe("custom.json");
  });
});

describe("sourceToModpack", () => {
  it("carries the mod's metadata and content", () => {
    const pack = sourceToModpack(source(), catalogWithData());
    expect(pack.meta.name).toBe("Test Mod");
    expect(pack.meta.curseforgeId).toBe("12345");
    expect(pack.meta.docsUrl).toBe("https://docs.example");
    expect(pack.creatures).toHaveLength(1);
    expect(pack.items).toHaveLength(1);
    expect(pack.iniNotes).toBe("notes");
  });

  it("only takes per-path data belonging to this mod", () => {
    // The exporting cluster's opinions about official creatures are not facts
    // about the mod, and must not travel with it.
    const pack = sourceToModpack(source(), catalogWithData());
    expect(pack.icons[normalizeBpPath(CREATURE)]).toBe("🦖");
    expect(pack.icons[normalizeBpPath(OFFICIAL)]).toBeUndefined();
    expect(pack.notes[normalizeBpPath(OFFICIAL)]).toBeUndefined();
    expect(pack.creatureInfo[normalizeBpPath(OFFICIAL)]).toBeUndefined();
    expect(pack.creatureInfo[normalizeBpPath(CREATURE)].notes).toBe(
      "how to tame Foo",
    );
    expect(pack.maps[normalizeBpPath(ITEM)]).toBe("Ragnarok");
  });

  it("leaves the local INI composer state behind", () => {
    const withBuild = source({
      iniSettings: [IniSettingSchema.parse({ id: "s1", key: "Foo", value: "1", added: true })],
    });
    const pack = sourceToModpack(withBuild, catalogWithData());
    expect(pack.iniSettings[0].added).toBe(false);
  });

  it("derives an id from the name when none is given", () => {
    expect(sourceToModpack(source({ name: "Ports of Atlas!" }), emptyCatalog()).meta.id)
      .toBe("ports-of-atlas");
  });

  it("round-trips through the schema", () => {
    const pack = sourceToModpack(source(), catalogWithData());
    expect(ModpackSchema.parse(pack)).toEqual(pack);
  });
});

describe("slugify", () => {
  it("produces a url-safe id, never empty", () => {
    expect(slugify("Ports of Atlas")).toBe("ports-of-atlas");
    expect(slugify("  ***  ")).toBe("modpack");
  });
});

describe("applyModpack", () => {
  const pack = (): Modpack => sourceToModpack(source(), catalogWithData(), {
    id: "test-mod",
    version: "1.0.0",
  });

  it("adds a new source carrying the pack's identity", () => {
    const result = applyModpack(emptyCatalog(), pack(), ids);
    expect(result.updated).toBe(false);
    const added = result.catalog.sources[0];
    expect(added.name).toBe("Test Mod");
    expect(added.modpackId).toBe("test-mod");
    expect(added.modpackVersion).toBe("1.0.0");
    expect(added.creatures).toHaveLength(1);
    expect(result.catalog.creatureInfo[normalizeBpPath(CREATURE)].notes).toBe(
      "how to tame Foo",
    );
  });

  it("cannot restore an entry the project excluded", () => {
    // Reviewing Discovery and unticking an entry is a decision about this
    // project. Enrichment from the published pack ran straight over it.
    const catalog = emptyCatalog();
    catalog.sources = [
      source({
        modpackId: "test-mod",
        modpackVersion: "1.0.0",
        creatures: [],
        excludedPaths: [normalizeBpPath(CREATURE)],
      }),
    ];
    const result = applyModpack(catalog, pack(), ids);
    expect(result.catalog.sources[0].creatures).toHaveLength(0);
    expect(result.catalog.sources[0].items).toHaveLength(1);
  });

  it("keeps a local rename of the source across an update", () => {
    const catalog = emptyCatalog();
    catalog.sources = [
      source({ name: "Our Renamed Mod", modpackId: "test-mod" }),
    ];
    const result = applyModpack(catalog, pack(), ids);
    expect(result.catalog.sources[0].name).toBe("Our Renamed Mod");
  });

  it("updates in place rather than adding a duplicate", () => {
    const first = applyModpack(emptyCatalog(), pack(), ids);
    const next = { ...pack(), meta: { ...pack().meta, version: "2.0.0" } };
    const second = applyModpack(first.catalog, next, ids);
    expect(second.updated).toBe(true);
    expect(second.catalog.sources).toHaveLength(1);
    expect(second.catalog.sources[0].id).toBe(first.sourceId);
    expect(second.catalog.sources[0].modpackVersion).toBe("2.0.0");
  });

  it("removes package-only structure when a directly installed pack updates", () => {
    const firstPack = pack();
    firstPack.creatures.push({
      id: "removed",
      name: "Removed",
      bpPath: "/Test/Dinos/Removed.Removed",
    });
    const first = applyModpack(emptyCatalog(), firstPack, ids);
    const second = applyModpack(first.catalog, pack(), ids);

    expect(second.catalog.sources[0].creatures).toHaveLength(1);
    expect(second.catalog.sources[0].creatures[0].bpPath).toBe(CREATURE);
  });

  it("keeps the cluster's own decisions across an update", () => {
    const first = applyModpack(emptyCatalog(), pack(), ids);
    // Local state a pack has no business resetting.
    first.catalog.sources[0] = {
      ...first.catalog.sources[0],
      enabled: false,
      notes: "we disabled this",
      iniBuild: { s1: { value: "local", choices: {}, optionValues: {} } },
    };
    const second = applyModpack(first.catalog, pack(), ids);
    const updated = second.catalog.sources[0];
    expect(updated.enabled).toBe(false);
    expect(updated.notes).toBe("we disabled this");
    expect(updated.iniBuild.s1.value).toBe("local");
  });

  it("keeps local per-entry edits by default", () => {
    const catalog = emptyCatalog();
    catalog.creatureInfo[normalizeBpPath(CREATURE)] = {
      ...emptyCreatureInfo(),
      notes: "our own writeup",
    };
    const result = applyModpack(catalog, pack(), ids);
    expect(result.catalog.creatureInfo[normalizeBpPath(CREATURE)].notes).toBe(
      "our own writeup",
    );
    expect(result.keptLocal).toBeGreaterThan(0);
  });

  it("takes the pack's version when asked to", () => {
    const catalog = emptyCatalog();
    catalog.creatureInfo[normalizeBpPath(CREATURE)] = {
      ...emptyCreatureInfo(),
      notes: "our own writeup",
    };
    const result = applyModpack(catalog, pack(), ids, { keepLocalEdits: false });
    expect(result.catalog.creatureInfo[normalizeBpPath(CREATURE)].notes).toBe(
      "how to tame Foo",
    );
  });

  it("leaves other sources and unrelated entries untouched", () => {
    const catalog = emptyCatalog();
    catalog.notes[normalizeBpPath(OFFICIAL)] = "our own Rex note";
    const result = applyModpack(catalog, pack(), ids);
    expect(result.catalog.notes[normalizeBpPath(OFFICIAL)]).toBe(
      "our own Rex note",
    );
  });

  it("never matches a hand-added source by name alone", () => {
    // A same-named manual entry for another CurseForge project must not be
    // silently taken over. Names are never identity.
    const catalog = emptyCatalog();
    catalog.sources = [
      source({ id: "manual", modpackId: "", curseforgeId: "99999" }),
    ];
    const result = applyModpack(catalog, pack(), ids);
    expect(result.updated).toBe(false);
    expect(result.catalog.sources).toHaveLength(2);
  });

  it("adopts a unique discovered source with the same CurseForge id", () => {
    const catalog = emptyCatalog();
    catalog.sources = [source({ id: "discovered", modpackId: "" })];

    const result = applyModpack(catalog, pack(), ids);

    expect(result.updated).toBe(true);
    expect(result.matchedBy).toBe("curseforgeId");
    expect(result.sourceId).toBe("discovered");
    expect(result.catalog.sources).toHaveLength(1);
    expect(result.catalog.sources[0].modpackId).toBe("test-mod");
  });

  it("enriches discovered structure without erasing locally discovered paths", () => {
    const discoveredOnly =
      "/Test/Dinos/Hidden_Character_BP.Hidden_Character_BP";
    const catalog = emptyCatalog();
    catalog.sources = [
      source({
        id: "discovered",
        modpackId: "",
        creatures: [
          { id: "stable-local", name: "Raw Foo", bpPath: CREATURE },
          { id: "local-only", name: "Hidden", bpPath: discoveredOnly },
        ],
      }),
    ];
    const curated = pack();
    curated.creatures[0] = { ...curated.creatures[0], name: "Curated Foo" };

    const result = applyModpack(catalog, curated, ids);
    const creatures = result.catalog.sources[0].creatures;

    expect(creatures).toHaveLength(2);
    expect(creatures.find((entry) => entry.bpPath === CREATURE)).toMatchObject({
      id: "stable-local",
      name: "Curated Foo",
    });
    expect(creatures.some((entry) => entry.bpPath === discoveredOnly)).toBe(true);
  });

  it("does not retain removed package-only rows above a Discovery snapshot", () => {
    const oldPackagePath =
      "/Test/Dinos/Removed_Character_BP.Removed_Character_BP";
    const catalog = emptyCatalog();
    catalog.sources = [
      source({
        id: "discovered",
        modpackId: "test-mod",
        discovery: {
          fileId: "42",
          shortName: "Test",
          creatures: [{ id: "local", name: "Foo", bpPath: CREATURE }],
          items: [],
        },
        creatures: [
          { id: "local", name: "Foo", bpPath: CREATURE },
          { id: "old-pack", name: "Removed", bpPath: oldPackagePath },
        ],
        items: [],
      }),
    ];

    const result = applyModpack(catalog, pack(), ids);

    expect(
      result.catalog.sources[0].creatures.some(
        (entry) => entry.bpPath === oldPackagePath,
      ),
    ).toBe(false);
  });

  it("refuses an ambiguous CurseForge identity instead of adding another duplicate", () => {
    const catalog = emptyCatalog();
    catalog.sources = [
      source({ id: "one", modpackId: "" }),
      source({ id: "two", modpackId: "" }),
    ];

    expect(matchModpackSource(catalog, pack()).ambiguous).toHaveLength(2);
    expect(() => applyModpack(catalog, pack(), ids)).toThrow(/duplicate sources/i);
    expect(catalog.sources).toHaveLength(2);
  });
});

describe("templateModpack", () => {
  it("is a valid pack that survives a round trip", () => {
    const pack = templateModpack();
    expect(ModpackSchema.safeParse(pack).success).toBe(true);
    expect(ModpackSchema.parse(JSON.parse(JSON.stringify(pack)))).toEqual(pack);
  });

  it("demonstrates every section rather than shipping empty", () => {
    const pack = templateModpack();
    expect(pack.creatures.length).toBeGreaterThan(0);
    expect(pack.items.length).toBeGreaterThan(0);
    expect(pack.iniSettings.length).toBeGreaterThan(0);
    expect(Object.keys(pack.creatureInfo).length).toBeGreaterThan(0);
    expect(Object.keys(pack.itemInfo).length).toBeGreaterThan(0);
  });

  it("documents the folder layout without leaking escapes", () => {
    const readme = templateReadme();
    expect(readme).toContain("icons/");
    expect(readme).toContain("modpack.json");
    // Backticks must survive the template literal as real backticks.
    expect(readme).toContain("`modpack.json`");
    // Char codes 92 + 96 are backslash + backtick. Built at runtime so the
    // assertion cannot itself be mangled by a layer of escaping.
    expect(readme).not.toContain(String.fromCharCode(92, 96));
  });

  it("installs cleanly, so the example is known-good", () => {
    const result = applyModpack(emptyCatalog(), templateModpack(), ids);
    expect(result.catalog.sources[0].creatures).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe("packDirName", () => {
  it("is <curseforgeId>-<Mod_Name>", () => {
    expect(
      packDirName({ id: "x", name: "No Untameables", curseforgeId: "929684" }),
    ).toBe("929684-No_Untameables");
  });

  it("collapses punctuation and runs of spaces into single underscores", () => {
    expect(
      packDirName({ id: "x", name: "Ports of Atlas: Reborn!", curseforgeId: "1" }),
    ).toBe("1-Ports_of_Atlas_Reborn");
  });

  it("falls back to just the name when there is no project ID", () => {
    expect(packDirName({ id: "x", name: "Some Mod", curseforgeId: "" })).toBe(
      "Some_Mod",
    );
    expect(packDirName({ id: "x", name: "Some Mod", curseforgeId: "  " })).toBe(
      "Some_Mod",
    );
  });

  it("never produces an empty or unsafe folder name", () => {
    expect(packDirName({ id: "x", name: "***", curseforgeId: "" })).toBe("Modpack");
    expect(packDirName({ id: "x", name: String.raw`a/b\c`, curseforgeId: "" })).toBe("a_b_c");
  });
});

describe("pack icons", () => {
  it("lists only the icons that are actual files", () => {
    const pack = ModpackSchema.parse({
      meta: { id: "x", name: "X" },
      icons: {
        a: "file:Rex.png",
        b: "🦖",
        c: "https://example.com/x.png",
        d: "file:Rex.png",
        e: "file:Dodo.png",
      },
    });
    // Emoji and remote URLs need no file; duplicates collapse.
    expect(packIconFiles(pack)).toEqual(["Dodo.png", "Rex.png"]);
  });

  it("is empty for a pack with no local icons", () => {
    expect(packIconFiles(ModpackSchema.parse({ meta: { id: "x", name: "X" } })))
      .toEqual([]);
  });

  it("flattens nested icon paths on export so packs stay portable", () => {
    // The exporting project may nest images; the importing one should not have
    // to recreate that layout.
    const catalog = emptyCatalog();
    catalog.icons[normalizeBpPath(CREATURE)] = "file:creatures/mod/Foo.png";
    catalog.icons[normalizeBpPath(ITEM)] = "🍖";
    const pack = sourceToModpack(source(), catalog);
    expect(pack.icons[normalizeBpPath(CREATURE)]).toBe("file:Foo.png");
    expect(pack.icons[normalizeBpPath(ITEM)]).toBe("🍖");
    expect(packIconFiles(pack)).toEqual(["Foo.png"]);
  });

  it("leaves remote icon URLs alone — they already travel", () => {
    const catalog = emptyCatalog();
    catalog.icons[normalizeBpPath(CREATURE)] = "https://example.com/rex.png";
    const pack = sourceToModpack(source(), catalog);
    expect(pack.icons[normalizeBpPath(CREATURE)]).toBe(
      "https://example.com/rex.png",
    );
    expect(packIconFiles(pack)).toEqual([]);
  });
});

describe("iconBaseName", () => {
  it("takes the last segment of either separator", () => {
    expect(iconBaseName("creatures/mod/Foo.png")).toBe("Foo.png");
    expect(iconBaseName(String.raw`creatures\mod\Foo.png`)).toBe("Foo.png");
    expect(iconBaseName("Foo.png")).toBe("Foo.png");
  });
});

describe("registryEntryFor", () => {
  it("points at the pack's folder rather than a bare file", () => {
    const pack = ModpackSchema.parse({
      meta: { id: "no-untameables", name: "No Untameables", curseforgeId: "929684" },
    });
    const entry = registryEntryFor(pack);
    expect(entry.dir).toBe("929684-No_Untameables");
    expect(entry.file).toBe("");
  });
});
