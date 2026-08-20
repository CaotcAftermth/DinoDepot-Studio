/**
 * Fertilized egg entries, added from a mapping read out of the game.
 *
 * ARK ships a fertilized counterpart for most eggs, but the wiki's Id item
 * pages do not list them — so a catalog built from those pages can name the
 * egg a creature lays and not the egg it hatches from, and a production rule
 * consuming one is flagged as referring to content that is not in the catalog.
 *
 * There is no naming rule to derive them from. `_Fertilized` is *inserted*
 * before a variant qualifier rather than appended:
 *
 *   PrimalItemConsumable_Egg_Para_Bionic
 *     -> PrimalItemConsumable_Egg_Para_Fertilized_Bionic   (not _Bionic_Fertilized)
 *
 * and some eggs have no fertilized form at all — the generic Small/Medium/
 * Large eggs, Titanoboa, Pachyrhino. Guessing produced sixteen wrong entries
 * out of eighty, so the pairs come from `scripts/data/fertilized-eggs.json`,
 * which was read from the game's own containers.
 *
 * Each added entry is filed as a variant of the egg it came from, so pickers
 * collapse the pair onto one row and the icon is inherited rather than needing
 * a new image per egg.
 *
 * Run standalone to apply this to the catalog already on disk, without
 * re-reading the wiki:
 *
 *   node scripts/fertilized-eggs.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** What the wiki reports for the fertilized eggs it does list. */
const FERTILIZED_STACK = 1;
const FERTILIZED = /_fertilized/i;

/** Verified plain-class -> fertilized-class pairs, read from the game. */
export const FERTILIZED_PAIRS = JSON.parse(
  fs.readFileSync(path.join(here, "data", "fertilized-eggs.json"), "utf8"),
).pairs;

/** `/Game/A/B.B_C` -> `B`; the class, without the blueprint suffix. */
export function classOf(bpPath) {
  return (bpPath.split(".").pop() ?? bpPath).replace(/_C$/, "");
}

/** Matching the app's own path comparison: case-insensitive, no trailing `_C`. */
export function normalize(bpPath) {
  return bpPath.trim().replace(/_C$/i, "").toLowerCase();
}

/**
 * The fertilized path for an egg, or null when there is no such item.
 *
 * Only the package and class segments are rewritten; the folder the egg lives
 * in is left alone, because the fertilized asset sits beside it.
 */
export function fertilizedPathFor(bpPath) {
  const fertilizedClass = FERTILIZED_PAIRS[classOf(bpPath)];
  if (!fertilizedClass) return null;
  const hadClassSuffix = /_C$/.test(bpPath);
  const base = bpPath.replace(/_C$/, "");
  const dot = base.lastIndexOf(".");
  if (dot < 0) return null;
  const folder = base.slice(0, base.lastIndexOf("/") + 1);
  return `${folder}${fertilizedClass}.${fertilizedClass}${
    hadClassSuffix ? "_C" : ""
  }`;
}

/** "Allosaurus Egg" -> "Fertilized Allosaurus Egg". */
export function fertilizedNameFor(name) {
  const trimmed = name.trim();
  return FERTILIZED.test(trimmed) ? trimmed : `Fertilized ${trimmed}`;
}

/**
 * Adds the known fertilized eggs to a catalog and records their parents.
 *
 * Pure: takes the built catalog, returns a new one. Anything already present
 * is left untouched, so re-running changes nothing.
 */
export function withFertilizedEggs(catalog) {
  const existing = new Set(catalog.items.map((item) => normalize(item.bpPath)));
  const added = [];
  const variantParents = { ...(catalog.variantParents ?? {}) };

  for (const item of catalog.items) {
    if (FERTILIZED.test(item.bpPath)) continue;
    const bpPath = fertilizedPathFor(item.bpPath);
    if (!bpPath || existing.has(normalize(bpPath))) continue;
    existing.add(normalize(bpPath));
    added.push({
      name: fertilizedNameFor(item.name),
      category: item.category,
      bpPath,
      // Fertilized eggs do not stack. Taken from the ones the wiki does list
      // rather than from the plain egg, which stacks to 100.
      stack: FERTILIZED_STACK,
    });
    variantParents[normalize(bpPath)] = item.bpPath;
  }

  return {
    ...catalog,
    items: [...catalog.items, ...added].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    variantParents,
    fertilizedEggsAdded: added.length,
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const target = path.join(
    here,
    "..",
    "src",
    "assets",
    "catalog",
    "official-asa.json",
  );
  const before = JSON.parse(fs.readFileSync(target, "utf8"));
  const after = withFertilizedEggs(before);
  const { fertilizedEggsAdded, ...output } = after;
  fs.writeFileSync(target, JSON.stringify(output, null, 2));
  console.log(
    `Added ${fertilizedEggsAdded} fertilized eggs; items ${before.items.length} -> ${output.items.length}`,
  );
  console.log(
    `Verified pairs available: ${Object.keys(FERTILIZED_PAIRS).length}`,
  );
}
