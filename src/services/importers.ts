import {
  buildCatalogIndex,
  CatalogEntry,
  CatalogFile,
  ContentSource,
  normalizeBpPath,
} from "../model/catalog";
import { effectiveOfficialSource } from "../model/officialCatalog";
import { newId } from "../model/ids";
import { ProductionDraft } from "../model/production";
import { RemapsDraft } from "../model/remaps";
import { parseProduction } from "../serializers/production";
import { parseRemaps } from "../serializers/remaps";
import { parseCosmetics } from "../serializers/cosmetics";
import { CosmeticsDraft } from "../model/cosmetics";

const IMPORTED_SOURCE_NAME = "Imported / unsorted";

/**
 * Ensures every blueprint path referenced by the draft exists somewhere in
 * the catalog; unknown paths are added to an "Imported / unsorted" source so
 * pickers and validation can see them. Returns the updated catalog and how
 * many entries were added.
 */
export function absorbUnknownPaths(
  catalog: CatalogFile,
  refs: { creatures: string[]; items: string[] },
): { catalog: CatalogFile; added: number } {
  const index = buildCatalogIndex({
    sources: [effectiveOfficialSource(catalog), ...catalog.sources],
  });

  const newCreatures: CatalogEntry[] = [];
  const newItems: CatalogEntry[] = [];
  const seen = new Set<string>();

  for (const bpPath of refs.creatures) {
    const key = normalizeBpPath(bpPath);
    if (!bpPath || index.creatures.has(key) || seen.has(key)) continue;
    seen.add(key);
    newCreatures.push({ id: newId(), name: deriveName(bpPath), bpPath });
  }
  for (const bpPath of refs.items) {
    const key = normalizeBpPath(bpPath);
    if (!bpPath || index.items.has(key) || seen.has(`i:${key}`)) continue;
    seen.add(`i:${key}`);
    newItems.push({ id: newId(), name: deriveName(bpPath), bpPath });
  }

  const added = newCreatures.length + newItems.length;
  if (added === 0) return { catalog, added };

  const existing = catalog.sources.find((s) => s.name === IMPORTED_SOURCE_NAME);
  let sources: ContentSource[];
  if (existing) {
    sources = catalog.sources.map((s) =>
      s.id === existing.id
        ? {
            ...s,
            modpackId: "",
    modpackVersion: "",
    creatures: [...s.creatures, ...newCreatures],
            items: [...s.items, ...newItems],
          }
        : s,
    );
  } else {
    sources = [
      ...catalog.sources,
      {
        id: newId(),
        name: IMPORTED_SOURCE_NAME,
        kind: "imported" as const,
        curseforgeId: "",
        url: "",
        docsUrl: "",
        discordUrl: "",
        iconsDir: "",
        iniNotes: "",
        iniSettings: [],
        iniBuild: {},
        variantTag: "",
        enabled: true,
        removed: false,
        notes:
          "Blueprint paths found in imported files that were not in the catalog. Move or rename them into proper mod sources as needed.",
        modpackId: "",
    modpackVersion: "",
    creatures: newCreatures,
        items: newItems,
      },
    ];
  }
  return { catalog: { ...catalog, sources }, added };
}

function deriveName(bpPath: string): string {
  const file = bpPath.split("/").pop() ?? bpPath;
  return file
    .split(".")[0]
    .replace(/^PrimalItem\w*?_/, "")
    .replace(/_Character_BP.*$/i, "")
    .replace(/_/g, " ")
    .trim();
}

export function collectProductionRefs(draft: ProductionDraft): {
  creatures: string[];
  items: string[];
} {
  const creatures: string[] = [];
  const items: string[] = [];
  for (const rule of draft.rules) {
    creatures.push(rule.dinoType);
    for (const cycle of rule.cycles) {
      for (const item of cycle.items) {
        items.push(item.bpPath);
        for (const alt of item.alternateItems) items.push(alt.bpPath);
        for (const consumed of item.consumesItems) items.push(consumed.bpPath);
      }
    }
  }
  return { creatures, items };
}

export function collectRemapRefs(draft: RemapsDraft): {
  creatures: string[];
  items: string[];
} {
  const creatures: string[] = [];
  for (const entry of draft.entries) {
    creatures.push(entry.fromClass, entry.toClass);
  }
  return { creatures, items: [] };
}

// ---------------------------------------------------------------------------

export interface ImportResult<T> {
  draft: T;
  catalog: CatalogFile;
  catalogAdded: number;
}

export function importProductionText(
  text: string,
  catalog: CatalogFile,
): ImportResult<ProductionDraft> {
  const draft = parseProduction(text);
  const { catalog: nextCatalog, added } = absorbUnknownPaths(
    catalog,
    collectProductionRefs(draft),
  );
  return { draft, catalog: nextCatalog, catalogAdded: added };
}

export function importRemapsText(
  text: string,
  catalog: CatalogFile,
): ImportResult<RemapsDraft> {
  const draft = parseRemaps(text);
  const { catalog: nextCatalog, added } = absorbUnknownPaths(
    catalog,
    collectRemapRefs(draft),
  );
  return { draft, catalog: nextCatalog, catalogAdded: added };
}

export function importCosmeticsText(text: string): CosmeticsDraft {
  return parseCosmetics(text);
}
