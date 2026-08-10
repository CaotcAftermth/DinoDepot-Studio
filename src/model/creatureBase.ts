import { officialSource } from "./officialCatalog";
import { normalizeBpPath, type CatalogEntry, type ContentSource } from "./catalog";
import { baseCreatureName } from "./variants";

/**
 * Resolving a creature to its "base" creature.
 *
 * Mods tag variants inconsistently — Arkology prefixes the display name
 * (`ARKOLOGY Achatina`), Zytharian only marks the class (`Achatina_Character_BP_Tek`),
 * NoUntameables uses `_Tameable`, and importer-derived names can be junk
 * (`ARKOLOGY SpiderS`). Matching the blueprint class against the bundled
 * official catalog resolves all of those, including cases where the display
 * name carries no usable information at all.
 */

/** Class stem of a blueprint path: `/A/B/X_Character_BP.X_Character_BP_C` -> `X_Character_BP`. */
export function classStem(bpPath: string): string {
  const last = bpPath.split(".").pop() ?? bpPath;
  return last.replace(/_C$/, "");
}

interface OfficialStem {
  lower: string;
  entry: CatalogEntry;
}

let stemIndex: OfficialStem[] | null = null;
let nameIndex: Map<string, CatalogEntry> | null = null;
const matchCache = new Map<string, CatalogEntry | null>();

/** Official class stems, longest first so the most specific match wins. */
function stems(): OfficialStem[] {
  if (!stemIndex) {
    stemIndex = officialSource.creatures
      .map((entry) => ({ lower: classStem(entry.bpPath).toLowerCase(), entry }))
      .filter((s) => s.lower.length > 0)
      .sort((a, b) => b.lower.length - a.lower.length);
  }
  return stemIndex;
}

function byName(): Map<string, CatalogEntry> {
  if (!nameIndex) {
    nameIndex = new Map();
    for (const entry of officialSource.creatures) {
      const key = entry.name.toLowerCase();
      if (!nameIndex.has(key)) nameIndex.set(key, entry);
    }
  }
  return nameIndex;
}

/**
 * True when `needle` appears in `haystack` on `_` boundaries. Keeps
 * `MegaRex_Character_BP` from matching the `Rex_Character_BP` stem while
 * still allowing `ARKOLOGY_Achatina_Character_BP` to match `Achatina_Character_BP`.
 */
function containsOnBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) return false;
    const before = i === 0 ? "_" : haystack[i - 1];
    const afterAt = i + needle.length;
    const after = afterAt >= haystack.length ? "_" : haystack[afterAt];
    if (before === "_" && after === "_") return true;
    from = i + 1;
  }
}

/** The official creature whose class stem this blueprint path is built from. */
export function matchOfficialByClass(bpPath: string): CatalogEntry | null {
  if (!bpPath) return null;
  const cached = matchCache.get(bpPath);
  if (cached !== undefined) return cached;

  const stem = classStem(bpPath).toLowerCase();
  let found: CatalogEntry | null = null;
  if (stem) {
    for (const candidate of stems()) {
      if (containsOnBoundary(stem, candidate.lower)) {
        found = candidate.entry;
        break;
      }
    }
  }
  matchCache.set(bpPath, found);
  return found;
}

export interface CreatureBase {
  /** Stable grouping key — shared by every variant of the same creature. */
  key: string;
  /** Group label shown in the UI. */
  label: string;
  /** Base creature's blueprint path when known (drives icon inheritance). */
  bpPath: string | null;
}

export interface ResolveOptions {
  /** Admin-assigned parent (always wins). */
  parentPath?: string | null;
  parentName?: string;
  /** The owning source's variant tag, stripped from the display name. */
  variantTag?: string;
}

/**
 * Resolves an entry to the creature it is a variant of. Resolution order:
 * manual parent -> official class-stem match -> tag/prefix-stripped name.
 * Names that resolve to an official creature reuse that creature's key, so
 * modded and vanilla variants group together.
 */
export function resolveCreatureBase(
  entry: CatalogEntry,
  opts: ResolveOptions = {},
): CreatureBase {
  if (opts.parentPath) {
    return {
      key: normalizeBpPath(opts.parentPath),
      label: opts.parentName || classStem(opts.parentPath),
      bpPath: opts.parentPath,
    };
  }

  const official = matchOfficialByClass(entry.bpPath);
  if (official && normalizeBpPath(official.bpPath) !== normalizeBpPath(entry.bpPath)) {
    return {
      key: normalizeBpPath(official.bpPath),
      label: official.name,
      bpPath: official.bpPath,
    };
  }

  // Either this *is* the official creature, or the class told us nothing —
  // fall back to name heuristics, then re-anchor onto an official creature
  // so vanilla variants share a key with modded ones.
  const base = baseCreatureName(entry.name, opts.variantTag);
  const byBaseName = byName().get(base.toLowerCase());
  if (byBaseName) {
    return {
      key: normalizeBpPath(byBaseName.bpPath),
      label: byBaseName.name,
      bpPath: byBaseName.bpPath,
    };
  }
  return { key: `name:${base.toLowerCase()}`, label: base, bpPath: null };
}

/**
 * The creature this one is a variant of, or null when it *is* the base (or
 * nothing could be resolved). Dino Depot applies a rule to the parent's
 * variants too, so this is what tells the Production Rules editor that a
 * separate rule is probably redundant.
 */
export function variantParent(
  entry: CatalogEntry,
  opts: ResolveOptions = {},
): CreatureBase | null {
  const base = resolveCreatureBase(entry, opts);
  if (!base.bpPath) return null;
  if (normalizeBpPath(base.bpPath) === normalizeBpPath(entry.bpPath)) {
    return null;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Per-source variant tag detection
// ---------------------------------------------------------------------------

const TAG_STOPWORDS = new Set([
  "character", "characters", "bp", "base", "basebp", "char", "dinos", "dino",
  "game", "creatures", "creature", "variants", "variant", "mods", "mod", "the",
  "new", "and", "of", "for",
]);

function tokens(text: string): string[] {
  return text.split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Finds a token shared by most of a source's creatures — the mod's variant
 * tag (ARKOLOGY, Tek, Tameable…). Tokens belonging to the resolved base
 * creature are excluded so "Achatina" can never be mistaken for a tag.
 */
export function detectSourceTag(source: ContentSource): string | null {
  const entries = source.creatures;
  if (entries.length < 3) return null;

  const counts = new Map<string, { n: number; display: string }>();
  for (const entry of entries) {
    const official = matchOfficialByClass(entry.bpPath);
    const baseTokens = new Set<string>();
    if (official) {
      for (const t of [
        ...tokens(official.name),
        ...tokens(classStem(official.bpPath)),
      ]) {
        baseTokens.add(t.toLowerCase());
      }
    }
    const seen = new Set<string>();
    const candidates = [
      ...tokens(entry.name),
      ...classStem(entry.bpPath).split("_"),
    ];
    for (const raw of candidates) {
      const t = raw.toLowerCase();
      if (t.length < 3 || TAG_STOPWORDS.has(t) || baseTokens.has(t)) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      const cur = counts.get(t) ?? { n: 0, display: raw };
      cur.n += 1;
      counts.set(t, cur);
    }
  }

  const threshold = Math.max(3, Math.ceil(entries.length * 0.6));
  let best: { token: string; n: number; display: string } | null = null;
  for (const [token, v] of counts) {
    if (v.n < threshold) continue;
    if (!best || v.n > best.n || (v.n === best.n && token.length > best.token.length)) {
      best = { token, n: v.n, display: v.display };
    }
  }
  return best ? best.display : null;
}

// ---------------------------------------------------------------------------
// Name cleanup
// ---------------------------------------------------------------------------

/**
 * A tidier display name built from the resolved official creature, keeping
 * the mod tag when the original name used it as a prefix and preserving
 * meaningful qualifiers from the class (Aberrant, Oil, …).
 * Returns null when nothing would change.
 */
export function proposeCleanName(
  entry: CatalogEntry,
  variantTag: string,
): string | null {
  const official = matchOfficialByClass(entry.bpPath);
  if (!official) return null;
  if (normalizeBpPath(official.bpPath) === normalizeBpPath(entry.bpPath)) {
    return null;
  }

  const officialSegments = new Set(
    classStem(official.bpPath)
      .split("_")
      .map((s) => s.toLowerCase()),
  );
  const tagLower = variantTag.toLowerCase();
  const qualifiers = classStem(entry.bpPath)
    .split("_")
    .filter((seg) => {
      const s = seg.toLowerCase();
      return (
        s.length > 0 &&
        !officialSegments.has(s) &&
        !TAG_STOPWORDS.has(s) &&
        s !== tagLower
      );
    });

  const usesTagPrefix =
    Boolean(variantTag) &&
    entry.name.toLowerCase().startsWith(tagLower.toLowerCase());
  const prefix = usesTagPrefix ? `${variantTag} ` : "";
  const suffix = qualifiers.length ? ` (${qualifiers.join(" ")})` : "";
  const proposed = `${prefix}${official.name}${suffix}`;
  return proposed === entry.name ? null : proposed;
}
