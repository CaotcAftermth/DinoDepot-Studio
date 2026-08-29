import {
  emptyItemInfo,
  normalizeBpPath,
  type CatalogFile,
  type ItemInfo,
} from "./catalog";
import { officialCategories, officialStackSizes } from "./officialCatalog";

/**
 * Per-item facts: administrator values with bundled official defaults.
 */

/**
 * Rarity tiers. ASA has no per-item rarity of its own - this is the cluster's
 * own grading, used for viewer presentation and for spotting when a passive
 * rule hands out something it shouldn't.
 */
export const ITEM_RARITIES = [
  "Common",
  "Uncommon",
  "Rare",
  "Very Rare",
  "Legendary",
] as const;

/** Color per rarity, for badges on the entry list and the viewer. */
export const RARITY_COLOR: Record<string, string> = {
  Common: "#9ca3af",
  Uncommon: "#4ade80",
  Rare: "#38bdf8",
  "Very Rare": "#c084fc",
  Legendary: "#fbbf24",
};

/** Item types offered in the picker from bundled categories. */
export const ITEM_TYPES = [
  "Ammunition",
  "Armor",
  "Artifacts",
  "Attachments",
  "Chibi-pets",
  "Coloring",
  "Consumables",
  "Eggs",
  "Farming",
  "Recipes",
  "Resources",
  "Saddles",
  "Seeds",
  "Skins",
  "Structures",
  "Tools",
  "Trophies",
  "Vehicles",
  "Weapons",
] as const;

/** Bundled item defaults, when available. */
export function bundledItemInfo(bpPath: string): Partial<ItemInfo> {
  const key = normalizeBpPath(bpPath);
  return {
    type: officialCategories.get(key) ?? "",
    stackSize: officialStackSizes.get(key) ?? null,
  };
}

/**
 * Effective info for an item: administrator values win, bundled data fills the
 * gaps. Never returns null so callers can read fields directly.
 */
export function itemInfoOf(catalog: CatalogFile, bpPath: string): ItemInfo {
  const stored = catalog.itemInfo[normalizeBpPath(bpPath)];
  const bundled = bundledItemInfo(bpPath);
  return {
    ...emptyItemInfo(),
    type: stored?.type || bundled.type || "",
    rarity: stored?.rarity ?? "",
    stackSize: stored?.stackSize ?? bundled.stackSize ?? null,
    highOutputPerHour: stored?.highOutputPerHour ?? null,
  };
}

/** True when the admin has recorded anything of their own for this item. */
export function hasStoredItemInfo(
  catalog: CatalogFile,
  bpPath: string,
): boolean {
  const stored = catalog.itemInfo[normalizeBpPath(bpPath)];
  if (!stored) return false;
  return Boolean(
    stored.type ||
      stored.rarity ||
      stored.stackSize !== null ||
      stored.highOutputPerHour !== null,
  );
}

/**
 * Per-item high-output thresholds for the simulator, keyed by normalized
 * path. Only items with their own override appear; everything else uses the
 * project-wide setting.
 */
export function itemOutputThresholds(
  catalog: CatalogFile,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, info] of Object.entries(catalog.itemInfo)) {
    if (info.highOutputPerHour !== null && info.highOutputPerHour !== undefined) {
      out[key] = info.highOutputPerHour;
    }
  }
  return out;
}
