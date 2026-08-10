import { describe, expect, it } from "vitest";
import { emptyCatalog, type CatalogFile } from "./catalog";
import {
  bundledItemInfo,
  hasStoredItemInfo,
  itemInfoOf,
  itemOutputThresholds,
} from "./itemInfo";

const FIBER =
  "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Fibers.PrimalItemResource_Fibers";

function catalogWith(path: string, info: Record<string, unknown>): CatalogFile {
  const catalog = emptyCatalog();
  catalog.itemInfo[path.toLowerCase()] = {
    type: "",
    rarity: "",
    stackSize: null,
    highOutputPerHour: null,
    ...info,
  };
  return catalog;
}

describe("bundledItemInfo", () => {
  it("reads type and stack size from the bundled wiki data", () => {
    const info = bundledItemInfo(FIBER);
    expect(info.type).toBe("Resources");
    expect(info.stackSize).toBe(300);
  });

  it("matches regardless of a trailing _C", () => {
    expect(bundledItemInfo(`${FIBER}_C`).stackSize).toBe(300);
  });

  it("returns blanks for something not in the bundled data", () => {
    expect(bundledItemInfo("/Game/Mods/X/PrimalItem_Nope.PrimalItem_Nope")).toEqual({
      type: "",
      stackSize: null,
    });
  });
});

describe("itemInfoOf", () => {
  it("falls back to bundled data when nothing is stored", () => {
    const info = itemInfoOf(emptyCatalog(), FIBER);
    expect(info.type).toBe("Resources");
    expect(info.stackSize).toBe(300);
    expect(info.rarity).toBe("");
    expect(info.highOutputPerHour).toBeNull();
  });

  it("lets stored values win over the bundled ones", () => {
    const catalog = catalogWith(FIBER, { type: "Farming", stackSize: 1000 });
    const info = itemInfoOf(catalog, FIBER);
    expect(info.type).toBe("Farming");
    expect(info.stackSize).toBe(1000);
  });

  it("keeps a stored stack size of zero rather than falling back", () => {
    const catalog = catalogWith(FIBER, { stackSize: 0 });
    expect(itemInfoOf(catalog, FIBER).stackSize).toBe(0);
  });
});

describe("hasStoredItemInfo", () => {
  it("is false with nothing recorded", () => {
    expect(hasStoredItemInfo(emptyCatalog(), FIBER)).toBe(false);
  });

  it("is false for an all-blank record", () => {
    expect(hasStoredItemInfo(catalogWith(FIBER, {}), FIBER)).toBe(false);
  });

  it("is true once any field is set", () => {
    expect(hasStoredItemInfo(catalogWith(FIBER, { rarity: "Rare" }), FIBER)).toBe(
      true,
    );
  });
});

describe("itemOutputThresholds", () => {
  it("collects only items with their own threshold", () => {
    const catalog = catalogWith(FIBER, { highOutputPerHour: 2000 });
    catalog.itemInfo["/game/other"] = {
      type: "",
      rarity: "Rare",
      stackSize: 5,
      highOutputPerHour: null,
    };
    expect(itemOutputThresholds(catalog)).toEqual({
      [FIBER.toLowerCase()]: 2000,
    });
  });

  it("keeps a threshold of zero", () => {
    const catalog = catalogWith(FIBER, { highOutputPerHour: 0 });
    expect(itemOutputThresholds(catalog)[FIBER.toLowerCase()]).toBe(0);
  });
});
