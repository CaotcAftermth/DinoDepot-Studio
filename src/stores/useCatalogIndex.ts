import { useDraftsStore } from "./draftsStore";
import {
  buildCatalogIndex,
  normalizeBpPath,
  type CatalogFile,
  type ContentSource,
} from "../model/catalog";
import { effectiveOfficialSource } from "../model/officialCatalog";

/**
 * Catalog derivations, cached on the catalog's identity rather than with
 * `useMemo`.
 *
 * These are read from deep inside the tree - every EntityIcon resolves names
 * and variants - so a per-component `useMemo` meant rebuilding a ~2,000-entry
 * index once per icon on the Content Sources list. Zustand hands back the same
 * catalog object until something actually changes, so a single-entry cache
 * keyed on that reference collapses all of it to one build per change.
 */

function cachedByCatalog<T>(compute: (catalog: CatalogFile) => T) {
  let key: CatalogFile | null = null;
  let value: T;
  return (catalog: CatalogFile): T => {
    if (key !== catalog) {
      key = catalog;
      value = compute(catalog);
    }
    return value;
  };
}

const officialOf = cachedByCatalog(effectiveOfficialSource);

const sourcesOf = cachedByCatalog((catalog): ContentSource[] => [
  officialOf(catalog),
  ...catalog.sources,
]);

const indexOf = cachedByCatalog((catalog) =>
  buildCatalogIndex({ sources: sourcesOf(catalog) }),
);

const nameMapOf = cachedByCatalog((catalog) => {
  const map = new Map<string, string>();
  for (const source of sourcesOf(catalog)) {
    for (const creature of source.creatures) {
      const key = creature.name.toLowerCase();
      if (!map.has(key)) map.set(key, creature.bpPath);
    }
  }
  return map;
});

/** Catalog index (official + project sources) for pickers and validation. */
export function useCatalogIndex() {
  return indexOf(useDraftsStore((s) => s.catalog));
}

/** All sources including the official one (bundled + admin additions). */
export function useAllSources() {
  return sourcesOf(useDraftsStore((s) => s.catalog));
}

/** creature display name (lowercase) -> bpPath, across all sources. */
export function useCreatureNameMap(): Map<string, string> {
  return nameMapOf(useDraftsStore((s) => s.catalog));
}

export function displayNameFor(
  index: ReturnType<typeof buildCatalogIndex>,
  kind: "creatures" | "items",
  bpPath: string,
): string {
  const hit = index[kind].get(normalizeBpPath(bpPath));
  if (hit) return hit.entry.name;
  const file = bpPath.split("/").pop() ?? bpPath;
  return file.split(".")[0] || "(unnamed)";
}
