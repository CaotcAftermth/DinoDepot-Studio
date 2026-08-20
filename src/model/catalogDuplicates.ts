import { normalizeBpPath, type CatalogEntry, type ContentSource } from "./catalog";

/**
 * Duplicate protection for the catalog.
 *
 * The catalog index is a `Map` keyed on the normalized blueprint path, so a
 * class catalogued twice does not error — the second one silently wins, and
 * whichever source "owns" it depends on iteration order. That shows up later
 * as a picker offering the same creature under the wrong mod, or a rule that
 * points at content the admin thought they had removed.
 *
 * Every comparison here goes through `normalizeBpPath`, which trims, lowercases
 * and drops a trailing `_C`, so `/Game/X/Rex.Rex_C` and ` /game/x/rex.rex ` are
 * one class. Creatures and items stay separate namespaces: the same path never
 * legitimately appears as both.
 */

export type EntryKind = "creatures" | "items";

export interface EntryOwner {
  entry: CatalogEntry;
  source: ContentSource;
}

/**
 * Normalized blueprint path -> every entry holding it, in catalog order.
 *
 * Deliberately a list rather than one winner: when a project already contains
 * duplicates, keeping only the first would hide exactly the collisions this
 * module exists to find. A move, for instance, has to see past the copy it is
 * moving to the copy the destination already has.
 */
export type EntryOwnerIndex = Map<string, EntryOwner[]>;

export function buildEntryOwners(
  sources: ContentSource[],
  kind: EntryKind,
): EntryOwnerIndex {
  const owners: EntryOwnerIndex = new Map();
  for (const source of sources) {
    for (const entry of source[kind]) {
      const key = normalizeBpPath(entry.bpPath);
      if (!key) continue;
      owners.set(key, [...(owners.get(key) ?? []), { entry, source }]);
    }
  }
  return owners;
}

/** The catalogued entry that already uses this path, if any. */
export function findEntryOwner(
  owners: EntryOwnerIndex,
  bpPath: string,
  ignoreEntryIds?: Set<string>,
): EntryOwner | null {
  const hits = owners.get(normalizeBpPath(bpPath));
  if (!hits) return null;
  return hits.find((h) => !ignoreEntryIds?.has(h.entry.id)) ?? null;
}

/** "Rex in Official ASA" — the half of the message that says where to look. */
export function describeOwner(owner: EntryOwner): string {
  return `"${owner.entry.name}" in ${owner.source.name}`;
}

// ---------------------------------------------------------------------------
// Insert / bulk import
// ---------------------------------------------------------------------------

export type SkipReason = "catalog" | "batch";

export interface SkippedEntry {
  entry: CatalogEntry;
  reason: SkipReason;
  /** Where the conflicting class already lives. */
  conflictsWith: string;
}

export interface InsertPlan {
  accepted: CatalogEntry[];
  skipped: SkippedEntry[];
}

/**
 * Filters an incoming batch down to what can actually be added.
 *
 * Two collisions matter and are reported apart: against what is already
 * catalogued anywhere, and against an earlier line of the same paste. The
 * second is the one that silently corrupted a source before — a list pasted
 * twice used to double every entry.
 */
export function planEntryInsert(
  owners: EntryOwnerIndex,
  incoming: CatalogEntry[],
  ignoreEntryIds?: Set<string>,
): InsertPlan {
  const accepted: CatalogEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const inBatch = new Map<string, CatalogEntry>();

  for (const entry of incoming) {
    const key = normalizeBpPath(entry.bpPath);
    if (!key) continue;

    const earlier = inBatch.get(key);
    if (earlier) {
      skipped.push({
        entry,
        reason: "batch",
        conflictsWith: `"${earlier.name}" earlier in this import`,
      });
      continue;
    }

    const owner = findEntryOwner(owners, entry.bpPath, ignoreEntryIds);
    if (owner) {
      skipped.push({ entry, reason: "catalog", conflictsWith: describeOwner(owner) });
      continue;
    }

    inBatch.set(key, entry);
    accepted.push(entry);
  }
  return { accepted, skipped };
}

// ---------------------------------------------------------------------------
// Move between sources
// ---------------------------------------------------------------------------

export interface MovePlan {
  moved: CatalogEntry[];
  skipped: SkippedEntry[];
}

/**
 * What a move between sources can actually carry.
 *
 * The entries being moved are already in the owner index (they live in the
 * source they are leaving), so they are excluded by id — otherwise every move
 * would collide with itself. A genuine collision means the destination, or
 * some third source, already catalogues that class; those are reported rather
 * than dropped on the floor, which is what the old `Set` of lowercased paths
 * did for the destination only.
 */
export function planEntryMove(
  owners: EntryOwnerIndex,
  moving: CatalogEntry[],
): MovePlan {
  const movingIds = new Set(moving.map((e) => e.id));
  const moved: CatalogEntry[] = [];
  const skipped: SkippedEntry[] = [];
  const taken = new Map<string, CatalogEntry>();

  for (const entry of moving) {
    const key = normalizeBpPath(entry.bpPath);
    const earlier = taken.get(key);
    if (earlier) {
      skipped.push({
        entry,
        reason: "batch",
        conflictsWith: `"${earlier.name}" in the same selection`,
      });
      continue;
    }
    const owner = findEntryOwner(owners, entry.bpPath, movingIds);
    if (owner) {
      skipped.push({ entry, reason: "catalog", conflictsWith: describeOwner(owner) });
      continue;
    }
    taken.set(key, entry);
    moved.push(entry);
  }
  return { moved, skipped };
}

// ---------------------------------------------------------------------------
// Reporting duplicates that are already there
// ---------------------------------------------------------------------------

export interface DuplicateClass {
  kind: EntryKind;
  /** Normalized path the entries collide on. */
  key: string;
  /** Every place it is catalogued, in catalog order. */
  locations: { sourceName: string; entryName: string; bpPath: string }[];
}

/**
 * Duplicate classes already present in a project.
 *
 * Reporting only — a project saved before this check existed may legitimately
 * need its duplicates resolved by hand (which of the two names is right is not
 * something the app can know), and deleting one automatically would throw away
 * an admin's work.
 */
export function findCatalogDuplicates(
  sources: ContentSource[],
  kinds: EntryKind[] = ["creatures", "items"],
): DuplicateClass[] {
  const out: DuplicateClass[] = [];
  for (const kind of kinds) {
    const byKey = new Map<string, DuplicateClass["locations"]>();
    for (const source of sources) {
      for (const entry of source[kind]) {
        const key = normalizeBpPath(entry.bpPath);
        if (!key) continue;
        const list = byKey.get(key) ?? [];
        list.push({
          sourceName: source.name,
          entryName: entry.name,
          bpPath: entry.bpPath,
        });
        byKey.set(key, list);
      }
    }
    for (const [key, locations] of byKey) {
      if (locations.length > 1) out.push({ kind, key, locations });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CurseForge project IDs
// ---------------------------------------------------------------------------

/**
 * Two sources carrying the same CurseForge project ID produce a duplicated id
 * in the `-mods=` list and an ambiguous watchlist entry (the watcher keys on
 * `curseforgeId || source.id`, so the second mod's results overwrite the
 * first's). Empty stays legal — a mod known only by URL is a real case.
 */
export function normalizeCurseforgeId(id: string): string {
  return id.trim();
}

/**
 * The CurseForge project ID in whatever somebody typed or pasted, or "".
 *
 * A `/projects/<id>` link is the ID with decoration around it, so it counts.
 * Nothing else does: pulling the first number out of a slug URL would read
 * `/mods/super-mod-2` as project 2 and quietly catalogue the wrong mod.
 */
export function curseforgeProjectId(input: string): string {
  const text = normalizeCurseforgeId(input);
  if (/^\d+$/.test(text)) return text;
  return text.match(/\/projects\/(\d+)/)?.[1] ?? "";
}

/** The source already using this CurseForge project ID, ignoring `exceptId`. */
export function findSourceByCurseforgeId(
  sources: ContentSource[],
  curseforgeId: string,
  exceptSourceId?: string,
): ContentSource | null {
  const id = normalizeCurseforgeId(curseforgeId);
  if (!id) return null;
  return (
    sources.find(
      (s) =>
        s.id !== exceptSourceId && normalizeCurseforgeId(s.curseforgeId) === id,
    ) ?? null
  );
}

export interface DuplicateCurseforgeId {
  curseforgeId: string;
  sourceNames: string[];
}

/** CurseForge IDs used by more than one source — reporting only. */
export function findDuplicateCurseforgeIds(
  sources: ContentSource[],
): DuplicateCurseforgeId[] {
  const byId = new Map<string, string[]>();
  for (const source of sources) {
    const id = normalizeCurseforgeId(source.curseforgeId);
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), source.name]);
  }
  return [...byId.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([curseforgeId, sourceNames]) => ({ curseforgeId, sourceNames }));
}

/**
 * Canonical form of a CurseForge mod URL: scheme, host casing, `www.`, a
 * trailing slash and any query/fragment all vary between how an admin pasted
 * it and how the scraper reports it.
 */
/**
 * A mod page URL pointing at CurseForge's current site.
 *
 * Every installed mod's `.uplugin` carries a `legacy.curseforge.com` link —
 * verified across the local corpus — which still resolves but sends an
 * administrator to the old site. The host is the only difference; the path is
 * already correct, so dropping the subdomain is the whole fix.
 */
export function currentCurseforgeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return "";
  return trimmed.replace(
    /^(https?:\/\/)(?:www\.)?legacy\.curseforge\.com/i,
    "$1www.curseforge.com",
  );
}

export function canonicalCurseforgeUrl(url: string): string {
  const trimmed = currentCurseforgeUrl(url);
  if (!trimmed) return "";
  // `legacy.` is folded in above, so the same page linked both ways compares
  // equal and duplicate detection does not report it twice.
  let rest = trimmed.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  rest = rest.split("#")[0].split("?")[0];
  return rest.replace(/\/+$/, "").toLowerCase();
}

export interface DuplicateModUrl {
  url: string;
  sourceNames: string[];
}

/**
 * Sources pointing at the same CurseForge page. A warning rather than a block:
 * project-ID uniqueness is the real guard, and two entries can legitimately
 * share a page while one is being retired.
 */
export function findDuplicateModUrls(
  sources: ContentSource[],
): DuplicateModUrl[] {
  const byUrl = new Map<string, string[]>();
  for (const source of sources) {
    const url = canonicalCurseforgeUrl(source.url);
    if (!url) continue;
    byUrl.set(url, [...(byUrl.get(url) ?? []), source.name]);
  }
  return [...byUrl.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([url, sourceNames]) => ({ url, sourceNames }));
}
