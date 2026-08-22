/**
 * Official creature info, compiled from the taming workbook.
 *
 * Two sources of very different confidence live in one record, and the
 * distinction matters to anyone deciding whether to trust a field:
 *
 *   availability, spawn maps, drag weight, drops
 *     Read from the ARK Official Community Wiki. Each row in the workbook
 *     names the exact revision it was taken from.
 *
 *   acquisition methods and their steps
 *     Captured from Chrome AI (ChatGPT and Gemini). Useful, spot-checked, but
 *     *not* wiki-verified — treat as a starting point an administrator may
 *     correct. A method is only attached to a creature the wiki says is
 *     acquirable, so no untameable creature is given a taming route.
 *
 * Anything an administrator writes themselves wins: this arrives as the
 * dependency layer's defaults, and `differentEntries` subtracts it again
 * before the project file is written, so none of it is ever persisted into
 * somebody's catalog.
 *
 * Records omit every field the schema defaults, since package content is
 * parsed through `CreatureInfoSchema` on read. Ids are positional (`m1p2s1`)
 * rather than generated, because the built package is immutable and has to
 * rebuild to identical bytes.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const payload = JSON.parse(
  fs.readFileSync(path.join(here, "data", "creature-info.json"), "utf8"),
);

/** Normalized blueprint path -> creature info record. */
export const CREATURE_INFO = payload.creatureInfo;

/** Where each part of a record came from, for the changelog and the docs. */
export const CREATURE_INFO_PROVENANCE = payload.provenance;

/**
 * Variant creature -> the creature it is a variant of, both normalized.
 *
 * The bundled catalog has always declared variant parents for items only, so
 * every Aberrant, Tek and X- creature carried a full copy of its base
 * creature's record. With a parent declared, a variant stores only what
 * differs and `resolveCreatureInfo` supplies the rest.
 */
export const CREATURE_VARIANT_PARENTS = payload.variantParents;

/** Guides the workbook filed under the wrong creature, and why. */
export const DROPPED_GUIDES = payload.droppedGuides;

/** `/Game/A/B.B_C` -> the app's comparison form: lower case, no `_C`. */
export function normalizePath(bpPath) {
  return bpPath.trim().replace(/_C$/i, "").toLowerCase();
}

/**
 * The records whose blueprint path the given catalog actually has.
 *
 * A record for a path no longer in the catalog would be dead weight in an
 * immutable package, so the build drops it rather than shipping it.
 */
export function creatureInfoFor(catalog) {
  const known = new Set(
    (catalog.creatures ?? []).map((entry) => normalizePath(entry.bpPath)),
  );
  return Object.fromEntries(
    Object.entries(CREATURE_INFO)
      .filter(([bpPath]) => known.has(normalizePath(bpPath)))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}
