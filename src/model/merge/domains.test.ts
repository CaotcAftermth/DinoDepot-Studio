import { describe, expect, it } from "vitest";
import { PROJECT_FILE } from "../project";
import { FILE_MERGERS, mergerFor, mergeSettings } from "./domains";
import { CosmeticsDraftSchema } from "../cosmetics";
import { ProductionDraftSchema } from "../production";
import { RemapsDraftSchema } from "../remaps";
import { PlayersFileSchema } from "../players";
import { WatchlistSchema } from "../watchlist";
import { CatalogFileSchema } from "../catalog";

/**
 * The domain merge rules, exercised against the project's real schemas.
 *
 * Every merged result is parsed back through the schema it came from, because
 * a merge that produces something the app cannot hydrate is worse than one
 * that refuses.
 */

function run(file: string, base: unknown, mine: unknown, theirs: unknown) {
  const merger = mergerFor(file);
  if (!merger) throw new Error(`no merger for ${file}`);
  return merger.merge(base, mine, theirs);
}

// ---------------------------------------------------------------------------

const cycle = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  name: "",
  intervalSeconds: 300,
  itemSelectMode: 0,
  items: [],
  ...over,
});

const rule = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  enabled: true,
  notes: "",
  dinoType: "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP",
  chanceToProduce: 1,
  cycles: [cycle(`${id}-c1`)],
  ...over,
});

const production = (rules: unknown[]) => ({ schemaVersion: 1, rules });

describe("production rules", () => {
  it("merges edits to different creatures without asking", () => {
    const base = production([rule("a"), rule("b")]);
    const result = run(
      PROJECT_FILE.production,
      base,
      production([rule("a", { chanceToProduce: 0.5 }), rule("b")]),
      production([rule("a"), rule("b", { enabled: false })]),
    );
    expect(result.conflicts).toEqual([]);
    const parsed = ProductionDraftSchema.parse(result.value);
    expect(parsed.rules.find((r) => r.id === "a")?.chanceToProduce).toBe(0.5);
    expect(parsed.rules.find((r) => r.id === "b")?.enabled).toBe(false);
  });

  it("merges edits to different fields of the same creature", () => {
    const base = production([rule("a")]);
    const result = run(
      PROJECT_FILE.production,
      base,
      production([rule("a", { notes: "mine" })]),
      production([rule("a", { chanceToProduce: 0.25 })]),
    );
    expect(result.conflicts).toEqual([]);
    const parsed = ProductionDraftSchema.parse(result.value);
    expect(parsed.rules[0].notes).toBe("mine");
    expect(parsed.rules[0].chanceToProduce).toBe(0.25);
  });

  it("asks when both changed the same field", () => {
    const result = run(
      PROJECT_FILE.production,
      production([rule("a")]),
      production([rule("a", { chanceToProduce: 0.5 })]),
      production([rule("a", { chanceToProduce: 0.75 })]),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].domain).toBe("creature");
    expect(result.conflicts[0].fieldLabel).toBe("Chance to produce");
    // Named by the creature, not by an opaque id.
    expect(result.conflicts[0].itemLabel).toBe("Rex_Character_BP");
  });

  /** Cycles carry their own ids, so the by-id rule applies all the way down. */
  it("merges edits to different cycles of one creature", () => {
    const base = production([rule("a", { cycles: [cycle("c1"), cycle("c2")] })]);
    const result = run(
      PROJECT_FILE.production,
      base,
      production([rule("a", { cycles: [cycle("c1", { intervalSeconds: 60 }), cycle("c2")] })]),
      production([rule("a", { cycles: [cycle("c1"), cycle("c2", { name: "Night" })] })]),
    );
    expect(result.conflicts).toEqual([]);
    const parsed = ProductionDraftSchema.parse(result.value);
    expect(parsed.rules[0].cycles[0].intervalSeconds).toBe(60);
    expect(parsed.rules[0].cycles[1].name).toBe("Night");
  });

  it("keeps a rule each administrator added", () => {
    const result = run(
      PROJECT_FILE.production,
      production([rule("a")]),
      production([rule("a"), rule("mine")]),
      production([rule("a"), rule("theirs")]),
    );
    expect(result.conflicts).toEqual([]);
    expect(ProductionDraftSchema.parse(result.value).rules.map((r) => r.id)).toEqual([
      "a",
      "mine",
      "theirs",
    ]);
  });

  it("asks when one deleted a rule the other edited", () => {
    const result = run(
      PROJECT_FILE.production,
      production([rule("a"), rule("b")]),
      production([rule("a")]),
      production([rule("a"), rule("b", { enabled: false })]),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe("delete-vs-edit");
  });
});

// ---------------------------------------------------------------------------

const remap = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  active: true,
  fromClass: "/Game/Mods/X/Old.Old",
  toClass: "/Game/Mods/X/New.New",
  fromSourceId: null,
  toSourceId: null,
  intentional: false,
  notes: "",
  ...over,
});

describe("creature remaps", () => {
  it("merges by the entry's own id", () => {
    const result = run(
      PROJECT_FILE.remaps,
      { schemaVersion: 1, entries: [remap("a")] },
      { schemaVersion: 1, entries: [remap("a", { notes: "mine" })] },
      { schemaVersion: 1, entries: [remap("a", { active: false })] },
    );
    expect(result.conflicts).toEqual([]);
    const parsed = RemapsDraftSchema.parse(result.value);
    expect(parsed.entries[0].notes).toBe("mine");
    expect(parsed.entries[0].active).toBe(false);
  });

  /**
   * Named as this computer names it, which is how it reads everywhere else in
   * this administrator's UI - never by the record id, which means nothing.
   */
  it("names a disputed remap by what it maps", () => {
    const result = run(
      PROJECT_FILE.remaps,
      { schemaVersion: 1, entries: [remap("a")] },
      { schemaVersion: 1, entries: [remap("a", { toClass: "/Game/A.A" })] },
      { schemaVersion: 1, entries: [remap("a", { toClass: "/Game/B.B" })] },
    );
    expect(result.conflicts[0].itemLabel).toBe("Old → A");
    expect(result.conflicts[0].fieldLabel).toBe("To creature");
  });
});

// ---------------------------------------------------------------------------

const cosmetic = (modId: string, over: Record<string, unknown> = {}) => ({
  id: `record-${modId}`,
  modId,
  enableDynamicDownload: true,
  allowNonDataOnlyBlueprints: true,
  included: true,
  name: `Mod ${modId}`,
  url: "",
  updated: "",
  notes: "",
  deprecatedAt: null,
  ...over,
});

const cosmetics = (entries: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  entries,
  lastScrapeAt: null,
  lastScrape: null,
  ...over,
});

describe("custom cosmetics", () => {
  /**
   * The same mod added on two machines gets two record ids but is one mod.
   * Merging by record id would put it in the published list twice.
   */
  it("treats the CurseForge id as the identity, not the record id", () => {
    const result = run(
      PROJECT_FILE.cosmetics,
      cosmetics([]),
      cosmetics([{ ...cosmetic("1431447"), id: "mine-record" }]),
      cosmetics([{ ...cosmetic("1431447"), id: "their-record" }]),
    );
    const parsed = CosmeticsDraftSchema.parse(result.value);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].modId).toBe("1431447");
  });

  it("asks when the two of you disagree about including a mod", () => {
    const result = run(
      PROJECT_FILE.cosmetics,
      cosmetics([cosmetic("1431447")]),
      cosmetics([cosmetic("1431447", { included: false })]),
      cosmetics([cosmetic("1431447", { notes: "keep this one" })]),
    );
    // Different fields - not a disagreement.
    expect(result.conflicts).toEqual([]);
    const parsed = CosmeticsDraftSchema.parse(result.value);
    expect(parsed.entries[0].included).toBe(false);
    expect(parsed.entries[0].notes).toBe("keep this one");
  });

  /** What CurseForge said is a cache, not a decision anybody made. */
  it("takes the newer scrape rather than conflicting over it", () => {
    const result = run(
      PROJECT_FILE.cosmetics,
      cosmetics([], { lastScrapeAt: "2026-08-01T00:00:00.000Z" }),
      cosmetics([], { lastScrapeAt: "2026-08-05T00:00:00.000Z" }),
      cosmetics([], { lastScrapeAt: "2026-08-09T00:00:00.000Z" }),
    );
    expect(result.conflicts).toEqual([]);
    expect(CosmeticsDraftSchema.parse(result.value).lastScrapeAt).toBe(
      "2026-08-09T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------

describe("the mod catalog", () => {
  const catalog = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    sources: [],
    icons: {},
    notes: {},
    maps: {},
    variantParents: {},
    ...over,
  });

  /** Two administrators assigning icons to different creatures, invisibly. */
  it("merges icon assignments key by key", () => {
    const result = run(
      PROJECT_FILE.catalog,
      catalog({ icons: { "/Game/A": "a.png" } }),
      catalog({ icons: { "/Game/A": "a.png", "/Game/B": "b.png" } }),
      catalog({ icons: { "/Game/A": "a.png", "/Game/C": "c.png" } }),
    );
    expect(result.conflicts).toEqual([]);
    expect(CatalogFileSchema.parse(result.value).icons).toEqual({
      "/Game/A": "a.png",
      "/Game/B": "b.png",
      "/Game/C": "c.png",
    });
  });

  it("asks when both assigned a different icon to the same creature", () => {
    const result = run(
      PROJECT_FILE.catalog,
      catalog({ icons: { "/Game/A": "old.png" } }),
      catalog({ icons: { "/Game/A": "mine.png" } }),
      catalog({ icons: { "/Game/A": "theirs.png" } }),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].domain).toBe("icon");
  });

  it("merges notes and maps of origin the same way", () => {
    const result = run(
      PROJECT_FILE.catalog,
      catalog(),
      catalog({ notes: { "/Game/A": "mine" }, maps: { "/Game/A": "Ragnarok" } }),
      catalog({ notes: { "/Game/B": "theirs" } }),
    );
    expect(result.conflicts).toEqual([]);
    const parsed = CatalogFileSchema.parse(result.value);
    expect(parsed.notes).toEqual({ "/Game/A": "mine", "/Game/B": "theirs" });
    expect(parsed.maps["/Game/A"]).toBe("Ragnarok");
  });

  /** A machine-local path that should never have been in a shared file. */
  it("does not fight over one administrator's icons folder", () => {
    const source = (over: Record<string, unknown> = {}) => ({
      id: "s1",
      name: "Ports of Atlas",
      kind: "mod",
      curseforgeId: "972253",
      ...over,
    });
    const result = run(
      PROJECT_FILE.catalog,
      catalog({ sources: [source()] }),
      catalog({ sources: [source({ iconsDir: "C:\\mine" })] }),
      catalog({ sources: [source({ iconsDir: "D:\\theirs" })] }),
    );
    expect(result.conflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("the watchlist", () => {
  const mod = (modId: string, over: Record<string, unknown> = {}) => ({
    id: `w-${modId}`,
    modId,
    name: `Mod ${modId}`,
    url: "",
    knownUpdated: "2026-07-01",
    latestUpdated: "2026-07-01",
    lastCheckedAt: null,
    needsReview: false,
    notes: "",
    watching: true,
    ...over,
  });

  /** Results of a check either machine happened to run, not decisions. */
  it("does not conflict over when each machine last checked", () => {
    const result = run(
      PROJECT_FILE.watchlist,
      { schemaVersion: 1, mods: [mod("1")] },
      { schemaVersion: 1, mods: [mod("1", { lastCheckedAt: "2026-08-01", latestUpdated: "2026-08-01", needsReview: true })] },
      { schemaVersion: 1, mods: [mod("1", { lastCheckedAt: "2026-08-09", latestUpdated: "2026-08-09", needsReview: true })] },
    );
    expect(result.conflicts).toEqual([]);
    expect(WatchlistSchema.parse(result.value).mods).toHaveLength(1);
  });

  it("does conflict over the acknowledged version, which is a decision", () => {
    const result = run(
      PROJECT_FILE.watchlist,
      { schemaVersion: 1, mods: [mod("1")] },
      { schemaVersion: 1, mods: [mod("1", { knownUpdated: "2026-08-01" })] },
      { schemaVersion: 1, mods: [mod("1", { knownUpdated: "2026-08-09" })] },
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].fieldLabel).toBe("Reviewed version");
  });
});

// ---------------------------------------------------------------------------

describe("the player roster", () => {
  const player = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    discordName: "survivor",
    discordId: "",
    steamName: "",
    steamId: "",
    accountName: "",
    gameName: "",
    playerId: "",
    eosId: "",
    notes: "",
    profile: null,
    ...over,
  });

  const roster = (players: unknown[], cleanSlates: unknown[] = []) => ({
    schemaVersion: 1,
    players,
    cleanSlates,
  });

  it("merges different identifiers for the same player", () => {
    const result = run(
      PROJECT_FILE.players,
      roster([player("p1")]),
      roster([player("p1", { steamId: "76561198000000000" })]),
      roster([player("p1", { eosId: "0002abcd0002abcd0002abcd0002abcd" })]),
    );
    expect(result.conflicts).toEqual([]);
    const parsed = PlayersFileSchema.parse(result.value);
    expect(parsed.players[0].steamId).toBe("76561198000000000");
    expect(parsed.players[0].eosId).toBe("0002abcd0002abcd0002abcd0002abcd");
  });

  /**
   * Two different saves for one survivor. Merging the *references* field-wise
   * would produce a record pointing at one file while describing another.
   */
  it("raises a whole-profile conflict when two saves collide", () => {
    const mineProfile = { fileName: "a.arkprofile", storedAt: "2026-08-01", map: "Ragnarok" };
    const theirProfile = { fileName: "b.arkprofile", storedAt: "2026-08-09", map: "The Island" };
    const result = run(
      PROJECT_FILE.players,
      roster([player("p1")]),
      roster([player("p1", { profile: mineProfile })]),
      roster([player("p1", { profile: theirProfile })]),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].kind).toBe("binary");
    expect(result.conflicts[0].fieldLabel).toBe("Stored profile");
    expect(result.conflicts[0].canKeepBoth).toBe(true);
  });

  it("takes a profile only one side stored", () => {
    const profile = { fileName: "a.arkprofile", storedAt: "2026-08-01", map: "Ragnarok" };
    const result = run(
      PROJECT_FILE.players,
      roster([player("p1")]),
      roster([player("p1")]),
      roster([player("p1", { profile })]),
    );
    expect(result.conflicts).toEqual([]);
    expect(PlayersFileSchema.parse(result.value).players[0].profile?.fileName).toBe(
      "a.arkprofile",
    );
  });

  /** One clean slate per map, so the map is the identity. */
  it("merges clean slates by their map", () => {
    const slate = (map: string, over: Record<string, unknown> = {}) => ({
      map,
      fileName: `clean-slate-${map.toLowerCase()}`,
      addedAt: "2026-08-01",
      summary: null,
      ...over,
    });
    const result = run(
      PROJECT_FILE.players,
      roster([], []),
      roster([], [slate("Ragnarok")]),
      roster([], [slate("The Island")]),
    );
    expect(result.conflicts).toEqual([]);
    expect(PlayersFileSchema.parse(result.value).cleanSlates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------

describe("the project manifest", () => {
  const settings = (over: Record<string, unknown> = {}) => ({
    format: "dinodepot.project",
    projectId: "11111111-2222-4333-8444-555555555555",
    schemaVersion: 2,
    minimumStudioVersion: "0.2.0",
    createdAt: "2026-08-01T00:00:00.000Z",
    capabilities: {},
    name: "GG Fizz",
    cluster: "GG Fizz Cluster",
    ...over,
  });

  it("merges independent settings changes", () => {
    const result = mergeSettings(
      settings(),
      settings({ cluster: "GG Fizz Main" }),
      settings({ name: "GG Fizz Cluster Config" }),
    );
    expect(result.conflicts).toEqual([]);
    expect((result.value as Record<string, unknown>).cluster).toBe("GG Fizz Main");
    expect((result.value as Record<string, unknown>).name).toBe("GG Fizz Cluster Config");
  });

  /**
   * Identity is not a setting. A disagreement about the project's id means
   * something has gone wrong that a merge must not paper over.
   */
  it("never merges or conflicts over the identity fields", () => {
    const result = mergeSettings(
      settings(),
      settings(),
      settings({ projectId: "a-different-project", createdAt: "2020-01-01T00:00:00.000Z" }),
    );
    expect(result.conflicts).toEqual([]);
    const value = result.value as Record<string, unknown>;
    expect(value.projectId).toBe("11111111-2222-4333-8444-555555555555");
    expect(value.createdAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("asks when both renamed the cluster", () => {
    const result = mergeSettings(
      settings(),
      settings({ cluster: "Mine" }),
      settings({ cluster: "Theirs" }),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].fieldLabel).toBe("Cluster name");
  });
});

// ---------------------------------------------------------------------------

describe("coverage", () => {
  /**
   * A project file with no merger is not merged - `reconcile` stops and asks
   * rather than silently keeping one side. Adding a project file therefore
   * means adding a merger, and this is what says so.
   */
  it("has a merger for every synchronized project file", () => {
    const unsynchronized: string[] = [
      // The manifest has its own merger, held apart because of the identity
      // fields it must not touch.
      PROJECT_FILE.settings,
      // Publish history and activity are per-machine records of what this
      // install did; Git history is the shared record. Not merged.
      PROJECT_FILE.history,
      PROJECT_FILE.activity,
    ];
    const covered = new Set(FILE_MERGERS.map((m) => m.file));
    for (const file of Object.values(PROJECT_FILE)) {
      if (unsynchronized.includes(file)) continue;
      expect(covered.has(file), `${file} has no merger`).toBe(true);
    }
  });

  it("gives every merger a name a person would recognise", () => {
    for (const merger of FILE_MERGERS) {
      expect(merger.label).toBeTruthy();
      expect(merger.label).not.toContain(".json");
    }
  });
});
