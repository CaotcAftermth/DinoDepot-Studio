import officialData from "../assets/catalog/official-asa.json";
import { normalizeBpPath } from "./catalog";
import type { CatalogEntry, CatalogFile, ContentSource } from "./catalog";

/**
 * The bundled official ASA content source, compiled from ark.wiki.gg by
 * scripts/build-official-catalog.mjs. Read-only; always present in the
 * catalog alongside the project's own sources.
 */

export const OFFICIAL_SOURCE_ID = "official-asa";

interface RawEntry {
  name: string;
  category: string;
  bpPath: string;
  /** Items only: max stack size from the wiki's Id item template. */
  stack?: number;
}

function toEntries(raw: RawEntry[], prefix: string): CatalogEntry[] {
  return raw.map((e, i) => ({
    id: `${prefix}-${i}`,
    name: e.name,
    bpPath: e.bpPath,
  }));
}

export const officialSource: ContentSource = {
  id: OFFICIAL_SOURCE_ID,
  name: "Official ASA",
  kind: "official",
  curseforgeId: "",
  url: "https://ark.wiki.gg/",
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
  notes: `Bundled from ${officialData.source} (${officialData.generatedAt.slice(0, 10)})`,
  creatures: toEntries(officialData.creatures as RawEntry[], "offc"),
  items: toEntries(officialData.items as RawEntry[], "offi"),
};

export const CATEGORY_EMOJI: Record<string, string> = {
  // creature categories (ark.wiki.gg)
  Dinosaurs: "🦖",
  Mammals: "🐻",
  Birds: "🦅",
  Fish: "🐟",
  Invertebrates: "🦂",
  Reptiles: "🦎",
  Amphibians: "🐸",
  Synthetic: "🤖",
  Bosses: "👹",
  "Alpha Creatures": "💀",
  "Event Creatures": "🎉",
  Fantasy: "🐉",
  // item categories
  Resources: "⛏️",
  Tools: "🔨",
  Armor: "🛡️",
  Saddles: "🐎",
  Structures: "🏗️",
  Vehicles: "🚗",
  Dye: "🎨",
  Consumables: "🍖",
  Recipes: "📜",
  Eggs: "🥚",
  Farming: "🌾",
  Seeds: "🌱",
  Weapons: "⚔️",
  Ammunition: "🏹",
  Skins: "👕",
  "Chibi Pets": "🧸",
  Artifacts: "🏺",
  Trophy: "🏆",
  Unobtainable: "🎁",
};

/** Category-based (or kind-based) emoji when no icon is assigned. */
export function fallbackIcon(
  bpPath: string,
  kind: "creatures" | "items",
): string {
  const category = officialCategories.get(normalizeBpPath(bpPath));
  if (category && CATEGORY_EMOJI[category]) return CATEGORY_EMOJI[category];
  return kind === "creatures" ? "🦕" : "📦";
}

/**
 * True for entries that came from the bundled dataset (as opposed to entries
 * the admin added to Official ASA themselves, which are removable/editable).
 */
export function isBundledOfficialId(id: string): boolean {
  return id.startsWith("offc-") || id.startsWith("offi-");
}

/** Blueprint paths the admin has marked as not present in ASA. */
function absentPaths(catalog: CatalogFile): Set<string> {
  const out = new Set<string>();
  for (const [key, verdict] of Object.entries(catalog.official.asaReview)) {
    if (verdict === "absent") out.add(key);
  }
  return out;
}

/**
 * The Official ASA source as the project sees it: bundled content plus any
 * admin-added creatures/items and reference links from the catalog overlay,
 * minus anything reviewed as not being in ASA.
 */
export function effectiveOfficialSource(catalog: CatalogFile): ContentSource {
  const overlay = catalog.official;
  const hasAdditions =
    overlay.creatures.length > 0 || overlay.items.length > 0;
  const absent = absentPaths(catalog);
  if (
    !hasAdditions &&
    !overlay.docsUrl &&
    !overlay.discordUrl &&
    !overlay.iniNotes &&
    absent.size === 0
  ) {
    return officialSource;
  }
  const keep = (e: CatalogEntry) => !absent.has(normalizeBpPath(e.bpPath));
  const creatures = hasAdditions
    ? [...officialSource.creatures, ...overlay.creatures]
    : officialSource.creatures;
  const items = hasAdditions
    ? [...officialSource.items, ...overlay.items]
    : officialSource.items;
  return {
    ...officialSource,
    docsUrl: overlay.docsUrl,
    discordUrl: overlay.discordUrl,
    iniNotes: overlay.iniNotes,
    modpackId: "",
    modpackVersion: "",
    creatures: absent.size > 0 ? creatures.filter(keep) : creatures,
    items: absent.size > 0 ? items.filter(keep) : items,
  };
}

/** Official ASA including entries reviewed as absent — for the review screen. */
export function officialWithAbsent(catalog: CatalogFile): ContentSource {
  const overlay = catalog.official;
  return {
    ...officialSource,
    modpackId: "",
    modpackVersion: "",
    creatures: [...officialSource.creatures, ...overlay.creatures],
    items: [...officialSource.items, ...overlay.items],
  };
}

/** Category lookup for official entries (used for grouping in pickers). */
export const officialCategories: Map<string, string> = new Map([
  ...(officialData.creatures as RawEntry[]).map(
    (c) => [normalizeBpPath(c.bpPath), c.category] as [string, string],
  ),
  ...(officialData.items as RawEntry[]).map(
    (i) => [normalizeBpPath(i.bpPath), i.category] as [string, string],
  ),
]);

/** Max stack size per official item, from the bundled wiki data. */
export const officialStackSizes: Map<string, number> = new Map(
  (officialData.items as RawEntry[])
    .filter((i) => typeof i.stack === "number")
    .map((i) => [normalizeBpPath(i.bpPath), i.stack!] as [string, number]),
);
