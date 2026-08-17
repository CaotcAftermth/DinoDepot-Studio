import { describe, expect, it } from "vitest";
import {
  emptyCosmeticsDraft,
  includedActiveModIds,
  type CosmeticEntry,
} from "./cosmetics";

function entry(patch: Partial<CosmeticEntry> = {}): CosmeticEntry {
  return {
    id: "entry-1",
    modId: "12345",
    enableDynamicDownload: true,
    allowNonDataOnlyBlueprints: true,
    included: true,
    name: "Cosmetic",
    url: "",
    updated: "",
    notes: "",
    deprecatedAt: null,
    ...patch,
  };
}

describe("Discovery cosmetic IDs", () => {
  it("includes only active entries selected for publication", () => {
    const draft = emptyCosmeticsDraft();
    draft.entries = [
      entry({ id: "active", modId: " 12345 " }),
      entry({ id: "excluded", modId: "23456", included: false }),
      entry({ id: "deprecated", modId: "34567", deprecatedAt: "2026-08-01" }),
    ];

    expect([...includedActiveModIds(draft)]).toEqual(["12345"]);
  });

  it("drops blank IDs", () => {
    const draft = emptyCosmeticsDraft();
    draft.entries = [entry({ modId: "   " })];
    expect(includedActiveModIds(draft).size).toBe(0);
  });
});
