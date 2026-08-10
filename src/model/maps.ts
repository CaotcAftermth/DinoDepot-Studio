import { normalizeBpPath, type CatalogFile } from "./catalog";
import { defaultMaps, type MapEntry, type ProjectSettings } from "./project";

/** Map-of-origin support: derived from blueprint paths, overridable per entry. */

/** Names only — the list an admin starts with before editing it in Settings. */
export const KNOWN_MAPS = defaultMaps().map((m) => m.name);

const PATH_SEGMENT_MAP: [RegExp, string][] = [
  [/\/game\/scorchedearth\//, "Scorched Earth"],
  [/\/game\/aberration\//, "Aberration"],
  [/\/game\/extinction\//, "Extinction"],
  [/\/game\/genesis2\//, "Genesis: Part 2"],
  [/\/game\/genesis\//, "Genesis: Part 1"],
  [/\/game\/valguero\//, "Valguero"],
  [/\/game\/ragnarok\//, "Ragnarok"],
  [/\/game\/crystalisles\//, "Crystal Isles"],
  [/\/game\/lostisland\//, "Lost Island"],
  [/\/game\/fjordur\//, "Fjordur"],
  [/\/game\/thecenter\//, "The Center"],
  [/\/game\/primalearth\//, "The Island"],
];

/**
 * Best-effort map derivation from the blueprint path. Imperfect (many DLC
 * creatures live under PrimalEarth) — manual overrides win.
 */
export function deriveMapFromPath(bpPath: string): string | null {
  const lower = bpPath.toLowerCase();
  for (const [pattern, map] of PATH_SEGMENT_MAP) {
    if (pattern.test(lower)) return map;
  }
  return null;
}

/** Effective map of origin: manual override, else path-derived, else "". */
export function mapOf(catalog: CatalogFile, bpPath: string): string {
  return (
    catalog.maps[normalizeBpPath(bpPath)] ?? deriveMapFromPath(bpPath) ?? ""
  );
}

/** The configured map list, falling back to the defaults for older projects. */
export function mapList(settings: ProjectSettings | null): MapEntry[] {
  const maps = settings?.maps;
  return maps && maps.length > 0 ? maps : defaultMaps();
}

/**
 * Icon and color for a map name. Unlisted maps (typed by hand as a custom
 * source) still render, just without styling.
 */
export function mapStyle(
  settings: ProjectSettings | null,
  name: string,
): MapEntry {
  const hit = mapList(settings).find(
    (m) => m.name.toLowerCase() === name.trim().toLowerCase(),
  );
  // A map typed by hand as a custom source isn't in the list, so it can't be
  // "disabled" — treat it as running rather than cautioning about it.
  return hit ?? { name, icon: "🗺️", color: "", enabled: true };
}

/**
 * True when the cluster has turned this map off in Settings.
 *
 * Content from a disabled map stays available everywhere — a Scorched Earth
 * wyvern also spawns on Ragnarok — but callers should mark it Caution, since
 * some of it really will be unobtainable on the maps the cluster runs.
 */
export function mapIsDisabled(
  settings: ProjectSettings | null,
  name: string,
): boolean {
  if (!name.trim()) return false;
  return !mapStyle(settings, name).enabled;
}

/** Maps the cluster actually runs — for pickers that should default to them. */
export function enabledMaps(settings: ProjectSettings | null): MapEntry[] {
  return mapList(settings).filter((m) => m.enabled);
}
