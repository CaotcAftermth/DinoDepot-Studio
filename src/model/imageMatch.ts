/**
 * Matching of catalog entries to files in the images folder.
 *
 * Files are relative paths like `creatures/Achatina.png`, `items/Hide.png`,
 * or flat `Achatina.png`. Matching is by display name (and blueprint class
 * name), ignoring case, spaces, and punctuation. Parenthetical suffixes like
 * `Anomalocaris (TSW).png` also match `Anomalocaris` - but a plain-named file
 * wins when both exist.
 */

export interface ImageIndex {
  creatures: Map<string, string>;
  items: Map<string, string>;
  /** Placeholder icons (files named like missing_creature_icon / missing_item_icon). */
  missing: { creatures: string | null; items: string | null };
}

/** "Woolly Rhino" / "Woolly_Rhino.png" -> "woollyrhino" */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-z0-9]/g, "");
}

/** Basename without extension: "creatures/Achatina.png" -> "Achatina" */
function baseName(relPath: string): string {
  const file = relPath.split("/").pop() ?? relPath;
  return file.replace(/\.[a-z0-9]+$/i, "");
}

export function buildImageIndex(files: string[]): ImageIndex {
  const creatures = new Map<string, string>();
  const items = new Map<string, string>();
  const missing: ImageIndex["missing"] = { creatures: null, items: null };

  // Placeholder detection is tolerant: any folder, double extensions, any
  // separators - e.g. "creatures/Missing_Item_Icon.png.png" still counts.
  for (const relPath of files) {
    const normalized = relPath.replace(/\\/g, "/");
    const file = (normalized.split("/").pop() ?? "").toLowerCase();
    if (/missing[\s_-]*creature[\s_-]*icon/.test(file) && !missing.creatures) {
      missing.creatures = normalized;
    } else if (/missing[\s_-]*item[\s_-]*icon/.test(file) && !missing.items) {
      missing.items = normalized;
    }
  }

  // Plain names first; for the same name WebP wins over the PNG fallback.
  const sorted = [...files].sort((a, b) => {
    const aParen = /\(/.test(a) ? 1 : 0;
    const bParen = /\(/.test(b) ? 1 : 0;
    const aPng = /\.png$/i.test(a) ? 1 : 0;
    const bPng = /\.png$/i.test(b) ? 1 : 0;
    return aParen - bParen || aPng - bPng || a.localeCompare(b);
  });

  for (const relPath of sorted) {
    const normalized = relPath.replace(/\\/g, "/");
    if (normalized === missing.creatures || normalized === missing.items) {
      continue; // placeholders never match by name
    }
    const lower = normalized.toLowerCase();
    const targets =
      lower.startsWith("creatures/") ? [creatures]
      : lower.startsWith("items/") ? [items]
      : [creatures, items]; // flat files can be either

    const base = baseName(normalized);
    const keys = new Set<string>([nameKey(base)]);
    // "Acrocanthosaurus (mod)" also indexes as "Acrocanthosaurus".
    const stripped = base.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    if (stripped && stripped !== base) keys.add(nameKey(stripped));

    for (const map of targets) {
      for (const key of keys) {
        if (key && !map.has(key)) map.set(key, normalized);
      }
    }
  }
  return { creatures, items, missing };
}

/**
 * A name for a file being copied into the images folder that cannot overwrite
 * an image already there.
 *
 * Icons picked out of a mod's own folder are copied in, and two mods both
 * shipping `Rex.png` is not unusual - silently replacing one with the other
 * would change an icon elsewhere in the project without anyone touching it.
 * The owner's name disambiguates, and a counter settles the rest.
 */
export function freeIconName(
  rel: string,
  owner: string,
  existing: string[],
): string {
  const base = rel.split(/[/\\]/).pop() || rel;
  const taken = new Set(
    existing.map((f) => (f.split(/[/\\]/).pop() || f).toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;

  const slug =
    owner.trim().replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "mod";
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  let candidate = `${slug}_${stem}${ext}`;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${slug}_${stem}_${n++}${ext}`;
  }
  return candidate;
}

/** First file matching any candidate name, or null. */
export function matchImage(
  index: ImageIndex,
  kind: "creatures" | "items",
  candidates: string[],
): string | null {
  const map = index[kind];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hit = map.get(nameKey(candidate));
    if (hit) return hit;
  }
  return null;
}
