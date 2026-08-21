import { describe, expect, it } from "vitest";
import {
  categoryFor,
  DEFAULT_CATEGORY,
  dirtyCategories,
  SETTINGS_CATEGORIES,
} from "./categories";
import { defaultProjectSettings } from "../../model/project";

const base = defaultProjectSettings("Test", "Test Cluster", "test-id");

describe("categoryFor", () => {
  it("takes a slug that exists", () => {
    expect(categoryFor("publishing").slug).toBe("publishing");
  });

  /** `/settings` with no slug, and a stale bookmark, both land somewhere. */
  it("falls back rather than showing nothing", () => {
    expect(categoryFor(undefined).slug).toBe(DEFAULT_CATEGORY);
    expect(categoryFor("nonsense").slug).toBe(DEFAULT_CATEGORY);
  });
});

describe("category keys", () => {
  it("claims each key once, so an edit lights one section", () => {
    const seen = new Set<string>();
    for (const category of SETTINGS_CATEGORIES) {
      for (const key of category.keys) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it("covers every field the page edits", () => {
    const claimed = new Set(
      SETTINGS_CATEGORIES.flatMap((category) => [...category.keys]),
    );
    // Cards on the Settings page write exactly these. A card added without a
    // category would edit a draft no rail entry can mark as unsaved.
    for (const key of [
      "name",
      "cluster",
      "maps",
      "modules",
      "outputPaths",
      "defaults",
      "simulator",
      "discord",
    ]) {
      expect(claimed.has(key as never)).toBe(true);
    }
  });
});

describe("dirtyCategories", () => {
  it("is empty when nothing has been touched", () => {
    expect([...dirtyCategories(base, base)]).toEqual([]);
  });

  it("marks only the category holding the edit", () => {
    const draft = { ...base, cluster: "Renamed" };
    expect([...dirtyCategories(draft, base)]).toEqual(["project"]);
  });

  it("sees a change nested inside a key", () => {
    const draft = {
      ...base,
      simulator: { ...base.simulator, defaultHours: 48 },
    };
    expect([...dirtyCategories(draft, base)]).toEqual(["defaults"]);
  });

  it("marks more than one at a time", () => {
    const draft = {
      ...base,
      name: "Renamed",
      outputPaths: { ...base.outputPaths, players: "docs/players.json" },
    };
    expect([...dirtyCategories(draft, base)].sort()).toEqual([
      "project",
      "publishing",
    ]);
  });

  /**
   * `capabilities` is not edited by any card here. It still makes the page
   * dirty — Save writes the whole settings object — but no rail entry should
   * claim it, since nothing on that category's screen changed.
   */
  it("marks nothing for a key no category owns", () => {
    const draft = { ...base, capabilities: { experimental: true } };
    expect([...dirtyCategories(draft, base)]).toEqual([]);
  });

  it("is empty before a project is open", () => {
    expect([...dirtyCategories(null, base)]).toEqual([]);
    expect([...dirtyCategories(base, null)]).toEqual([]);
  });
});
