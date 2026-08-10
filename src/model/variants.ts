/** Variant naming heuristics shared by grouping, icon inheritance, and the viewer. */

const VARIANT_PREFIXES = [
  "Aberrant ",
  "Abyssal ",
  "Tek ",
  "Eerie ",
  "R-",
  "X-",
  "VR ",
  "Malfunctioned Tek ",
  "Malfunctioned ",
  "Summoned ",
  "Skeletal ",
  "Corrupted ",
  "Enraged ",
  "Brute ",
  "Alpha ",
  "Bunny ",
  "Zombie ",
  "Zomdodo ",
  "Mega ",
];

function stripTag(name: string, tag: string): string {
  const t = tag.trim();
  if (!t) return name;
  const lower = name.toLowerCase();
  const tl = t.toLowerCase();
  if (lower.startsWith(`${tl} `)) return name.slice(t.length + 1);
  if (lower.startsWith(tl) && name.length > t.length) return name.slice(t.length).trim();
  if (lower.endsWith(` ${tl}`)) return name.slice(0, -(t.length + 1));
  return name;
}

/**
 * Strips variant markers to find the base creature name: any trailing
 * parenthetical (`Anomalocaris (TSW)`, `Broodmother Lysrix (Gamma)`), the
 * owning mod's variant tag when known (`ARKOLOGY Achatina`), and the known
 * vanilla prefixes (`Aberrant Achatina`).
 */
export function baseCreatureName(name: string, variantTag = ""): string {
  let base = name.replace(/\s*\([^)]*\)\s*$/g, "").trim();
  base = stripTag(base, variantTag);

  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of VARIANT_PREFIXES) {
      if (base.startsWith(prefix) && base.length > prefix.length) {
        base = base.slice(prefix.length);
        changed = true;
      }
    }
  }
  return base.trim() || name;
}
