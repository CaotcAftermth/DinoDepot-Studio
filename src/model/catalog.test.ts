import { describe, expect, it } from "vitest";
import { ContentSourceSchema, isWatched, type ContentSource } from "./catalog";
import { officialSource } from "./officialCatalog";

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
