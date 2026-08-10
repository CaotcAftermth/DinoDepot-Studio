import { normalizeBpPath, type CatalogEntry, type ContentSource } from "./catalog";
import { resolveCreatureBase } from "./creatureBase";
import { shortClassName } from "../services/spawnCommands";

/**
 * Blueprint picker result building.
 *
 * A cluster running a dozen creature mods has ten Rexes in the catalog and one
 * of them is the Rex. For production rules that is actively unhelpful: Dino
 * Depot applies a rule to the parent's variants too, so the picker should
 * offer the parent and keep the children out of the way until they are asked
 * for.
 *
 * Kept as a pure function because the interesting behaviour — which entry
 * represents a group, what happens when a search only matches a hidden child,
 * what happens when no parent can be resolved — is exactly what a component
 * test cannot reach comfortably.
 */

export interface PickerRow {
  entry: CatalogEntry;
  source: ContentSource;
  /** Variants collapsed under this row. 0 when nothing is hidden. */
  hiddenVariants: number;
  /**
   * Names of collapsed children that matched the search when this row's own
   * name and path did not — "Rex — matched Aberrant Rex".
   */
  matchedVia: string[];
}

export interface PickerRowOptions {
  sources: ContentSource[];
  kind: "creatures" | "items";
  search: string;
  /**
   * Collapse variants onto their parent. Creatures only — items have no
   * variant relationships, so this is ignored for them.
   */
  collapseVariants: boolean;
  /** Admin-assigned parents from the catalog; always wins over heuristics. */
  variantParents?: Record<string, string>;
  /** Result cap, matching the flat picker's original budget. */
  limit?: number;
}

const DEFAULT_LIMIT = 200;

function matchesQuery(entry: CatalogEntry, q: string): boolean {
  if (!q) return true;
  return (
    entry.name.toLowerCase().includes(q) ||
    entry.bpPath.toLowerCase().includes(q)
  );
}

/**
 * Picker rows for the given search.
 *
 * With `collapseVariants` off (and for items) this is the original flat list:
 * every match, in source order, capped at `limit`.
 */
export function buildPickerRows(opts: PickerRowOptions): PickerRow[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const q = opts.search.trim().toLowerCase();

  if (opts.kind !== "creatures" || !opts.collapseVariants) {
    const out: PickerRow[] = [];
    for (const source of opts.sources) {
      for (const entry of source[opts.kind]) {
        if (!matchesQuery(entry, q)) continue;
        out.push({ entry, source, hiddenVariants: 0, matchedVia: [] });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  return collapseCreatureRows(opts.sources, q, opts.variantParents ?? {}, limit);
}

interface Group {
  /** Row that represents the group — the parent, once one is found. */
  head: { entry: CatalogEntry; source: ContentSource } | null;
  /** Everything filed under the group that is not the head. */
  children: { entry: CatalogEntry; source: ContentSource }[];
  /** Children whose name/path matched the search. */
  matchedChildren: string[];
  /** True when the head itself matched, or nothing is being searched. */
  headMatched: boolean;
  /** First position seen, so output order stays stable and predictable. */
  order: number;
}

function collapseCreatureRows(
  sources: ContentSource[],
  q: string,
  variantParents: Record<string, string>,
  limit: number,
): PickerRow[] {
  // Every creature in the effective catalog, so a parent living in a different
  // source than its variant is still found.
  const byPath = new Map<string, { entry: CatalogEntry; source: ContentSource }>();
  for (const source of sources) {
    for (const entry of source.creatures) {
      const key = normalizeBpPath(entry.bpPath);
      if (!byPath.has(key)) byPath.set(key, { entry, source });
    }
  }

  const groups = new Map<string, Group>();
  let order = 0;

  for (const source of sources) {
    for (const entry of source.creatures) {
      const position = order++;
      const entryKey = normalizeBpPath(entry.bpPath);
      const parentPath = variantParents[entryKey] ?? null;
      const base = resolveCreatureBase(entry, {
        parentPath,
        parentName: parentPath
          ? (byPath.get(normalizeBpPath(parentPath))?.entry.name ??
            shortClassName(parentPath))
          : undefined,
        variantTag: source.variantTag,
      });

      // A parent that isn't in the catalog can't be offered in its place, so
      // the entry stands on its own rather than disappearing. It still keys on
      // its own path, so anything that names *it* as a parent joins the same
      // group instead of forming a headless one.
      const parentInCatalog = base.bpPath
        ? (byPath.get(normalizeBpPath(base.bpPath)) ?? null)
        : null;
      const groupKey = parentInCatalog ? base.key : entryKey;

      const group = groups.get(groupKey) ?? {
        head: null,
        children: [],
        matchedChildren: [],
        headMatched: false,
        order: position,
      };

      const isHead = parentInCatalog
        ? normalizeBpPath(parentInCatalog.entry.bpPath) === entryKey
        : true;
      const matched = matchesQuery(entry, q);

      if (isHead) {
        group.head = { entry, source };
        group.headMatched = group.headMatched || matched;
        group.order = Math.min(group.order, position);
      } else {
        group.children.push({ entry, source });
        if (matched) group.matchedChildren.push(entry.name);
      }
      groups.set(groupKey, group);
    }
  }

  const rows: PickerRow[] = [];
  for (const group of [...groups.values()].sort((a, b) => a.order - b.order)) {
    const anyMatch = group.headMatched || group.matchedChildren.length > 0;
    if (!anyMatch) continue;

    if (group.head) {
      rows.push({
        entry: group.head.entry,
        source: group.head.source,
        hiddenVariants: group.children.length,
        // Only worth explaining when the head itself is not an obvious hit.
        matchedVia: group.headMatched ? [] : group.matchedChildren.slice(0, 3),
      });
    } else {
      // The group's parent was resolvable but is not itself in the catalog —
      // emit the children so nothing is silently unreachable.
      for (const child of group.children) {
        if (!matchesQuery(child.entry, q)) continue;
        rows.push({
          entry: child.entry,
          source: child.source,
          hiddenVariants: 0,
          matchedVia: [],
        });
        if (rows.length >= limit) return rows;
      }
    }
    if (rows.length >= limit) return rows;
  }
  return rows;
}
