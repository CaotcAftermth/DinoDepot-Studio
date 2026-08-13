import { conflictId, type Conflict } from "./conflicts";

/**
 * Three-way merge over domain objects, not over lines.
 *
 * The whole point: a line-based merge of a JSON file produces conflict markers
 * inside the file, which is both unreadable and — since the app then cannot
 * parse it — actively destructive. Merging the parsed data instead means two
 * administrators who touched different creatures never conflict at all, and
 * the ones who touched the same field get asked a question they can answer.
 *
 * Three inputs throughout: `base` is where the two of you last agreed, `mine`
 * is this computer, `theirs` is what was fetched. Without a base there is no
 * way to tell "I changed this" from "they changed this", which is why the last
 * synchronized commit is tracked so carefully.
 */

export interface MergeContext {
  domain: string;
  itemId: string;
  itemLabel: string;
  /** Field names to friendly labels. Anything absent falls back to the key. */
  labels?: Record<string, string>;
  /** Fields never worth conflicting over — timestamps, caches. */
  ignore?: string[];
}

export interface MergeResult<T> {
  value: T;
  conflicts: Conflict[];
}

/** Structural equality, which is what "unchanged" has to mean for objects. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    // NaN is the one value not equal to itself; treat two of them as unchanged.
    return Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) return false;
  }
  return true;
}

/**
 * Merges one value.
 *
 * The four cases are the whole of three-way merging: nobody changed it, only
 * one of you did (twice), or you both did and disagreed. Only the last is a
 * question for a person.
 */
export function mergeValue<T>(
  base: T | undefined,
  mine: T,
  theirs: T,
  field: string,
  context: MergeContext,
): MergeResult<T> {
  if (deepEqual(mine, theirs)) return { value: mine, conflicts: [] };
  if (deepEqual(mine, base)) return { value: theirs, conflicts: [] };
  if (deepEqual(theirs, base)) return { value: mine, conflicts: [] };
  return {
    // Held at this computer's value until the administrator says otherwise, so
    // a merged result is always a complete, valid project even mid-decision.
    value: mine,
    conflicts: [
      {
        id: conflictId(context.domain, context.itemId, field),
        domain: context.domain,
        itemId: context.itemId,
        itemLabel: context.itemLabel,
        field,
        fieldLabel: context.labels?.[field] ?? field,
        kind: "field",
        base,
        mine,
        theirs,
        canKeepBoth: false,
      },
    ],
  };
}

/**
 * Merges an object field by field.
 *
 * Independently changed fields both survive, which is the behaviour that makes
 * most of this invisible: one administrator renaming a creature while another
 * adjusts its interval is not a conflict and should never be presented as one.
 */
export function mergeObject<T extends Record<string, unknown>>(
  base: T | undefined,
  mine: T,
  theirs: T,
  context: MergeContext,
): MergeResult<T> {
  const out: Record<string, unknown> = { ...mine };
  const conflicts: Conflict[] = [];
  const keys = new Set([...Object.keys(mine), ...Object.keys(theirs)]);

  for (const key of keys) {
    if (context.ignore?.includes(key)) continue;
    const result = mergeValue(base?.[key], mine[key], theirs[key], key, context);
    out[key] = result.value;
    conflicts.push(...result.conflicts);
  }
  return { value: out as T, conflicts };
}

// ---------------------------------------------------------------------------
// Collections keyed by a stable id
// ---------------------------------------------------------------------------

export interface ListMergeOptions<T> {
  /** The item's stable identity. Never its position. */
  keyOf(item: T): string;
  /** What to call one on screen. */
  labelOf(item: T): string;
  domain: string;
  labels?: Record<string, string>;
  ignore?: string[];
  /** Overrides the default field-wise merge for one item. */
  mergeItem?(base: T | undefined, mine: T, theirs: T, context: MergeContext): MergeResult<T>;
}

/**
 * Merges a list whose items carry stable ids.
 *
 * Merging by id rather than by index is the single most important rule here.
 * By index, one administrator inserting a rule at the top silently pairs every
 * subsequent rule against the wrong one, and a merge that looks clean rewrites
 * the whole list into nonsense.
 *
 * Ordering is normalised rather than merged: these lists are sets the UI sorts
 * for display, so two people reordering them is not a disagreement worth
 * anybody's time. Base order is preserved, then this computer's additions, then
 * theirs — stable, and deterministic regardless of who syncs first.
 */
export function mergeList<T extends Record<string, unknown>>(
  base: T[] | undefined,
  mine: T[],
  theirs: T[],
  options: ListMergeOptions<T>,
): MergeResult<T[]> {
  const key = options.keyOf;
  const baseMap = indexBy(base ?? [], key);
  const mineMap = indexBy(mine, key);
  const theirsMap = indexBy(theirs, key);
  const conflicts: Conflict[] = [];
  const merged = new Map<string, T>();

  const ids = orderedIds(base ?? [], mine, theirs, key);

  for (const id of ids) {
    const inBase = baseMap.get(id);
    const inMine = mineMap.get(id);
    const inTheirs = theirsMap.get(id);
    const label = options.labelOf(inMine ?? inTheirs ?? inBase!);
    const context: MergeContext = {
      domain: options.domain,
      itemId: id,
      itemLabel: label,
      labels: options.labels,
      ignore: options.ignore,
    };

    // Added on one side only, or added identically on both.
    if (!inBase) {
      if (inMine && !inTheirs) {
        merged.set(id, inMine);
      } else if (!inMine && inTheirs) {
        merged.set(id, inTheirs);
      } else if (inMine && inTheirs) {
        if (deepEqual(inMine, inTheirs)) {
          merged.set(id, inMine);
        } else {
          // The same id arriving from two places with different content is not
          // something to merge field-wise: it is two different things that
          // happen to collide, and only a person can say which is wanted.
          merged.set(id, inMine);
          conflicts.push({
            id: conflictId(options.domain, id, ""),
            domain: options.domain,
            itemId: id,
            itemLabel: label,
            field: "",
            fieldLabel: "",
            kind: "add-vs-add",
            mine: inMine,
            theirs: inTheirs,
            canKeepBoth: true,
          });
        }
      }
      continue;
    }

    // Deleted on both sides: agreed.
    if (!inMine && !inTheirs) continue;

    // Deleted on one side. Silent only when the other side left it alone —
    // otherwise somebody's edit is about to vanish without being mentioned.
    if (!inMine || !inTheirs) {
      const survivor = inMine ?? inTheirs!;
      const deletedByMe = !inMine;
      if (deepEqual(survivor, inBase)) continue; // untouched; the delete wins

      merged.set(id, survivor);
      conflicts.push({
        id: conflictId(options.domain, id, ""),
        domain: options.domain,
        itemId: id,
        itemLabel: options.labelOf(survivor),
        field: "",
        fieldLabel: "",
        kind: "delete-vs-edit",
        base: inBase,
        mine: deletedByMe ? undefined : survivor,
        theirs: deletedByMe ? survivor : undefined,
        canKeepBoth: false,
      });
      continue;
    }

    const merge = options.mergeItem ?? mergeObject;
    const result = merge(inBase, inMine, inTheirs, context);
    merged.set(id, result.value);
    conflicts.push(...result.conflicts);
  }

  return { value: [...merged.values()], conflicts };
}

function indexBy<T>(items: T[], key: (item: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(key(item), item);
  return map;
}

/**
 * The order the merged list comes out in: base first, then this computer's
 * additions, then theirs.
 *
 * Deterministic on purpose. Two administrators syncing in either order must
 * produce the same file, or every sync would show a spurious change.
 */
function orderedIds<T>(base: T[], mine: T[], theirs: T[], key: (item: T) => string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const list of [base, mine, theirs]) {
    for (const item of list) {
      const id = key(item);
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Maps keyed by a string
// ---------------------------------------------------------------------------

/**
 * Merges a plain string-keyed map — icon assignments, per-path notes.
 *
 * The same rules as a list, one key at a time: independent keys both survive,
 * a key removed on one side and left alone on the other is removed, and only a
 * genuine disagreement about one key becomes a question.
 */
export function mergeMap<V>(
  base: Record<string, V> | undefined,
  mine: Record<string, V>,
  theirs: Record<string, V>,
  context: MergeContext,
): MergeResult<Record<string, V>> {
  const out: Record<string, V> = {};
  const conflicts: Conflict[] = [];
  const keys = new Set([
    ...Object.keys(base ?? {}),
    ...Object.keys(mine),
    ...Object.keys(theirs),
  ]);

  for (const key of [...keys].sort()) {
    const inBase = base?.[key];
    const inMine = mine[key];
    const inTheirs = theirs[key];
    const hadBase = base !== undefined && key in base;
    const hasMine = key in mine;
    const hasTheirs = key in theirs;

    if (!hasMine && !hasTheirs) continue;

    // Removed on one side, untouched on the other.
    if (hadBase && !hasMine && hasTheirs && deepEqual(inTheirs, inBase)) continue;
    if (hadBase && !hasTheirs && hasMine && deepEqual(inMine, inBase)) continue;

    if (!hasMine && hasTheirs) {
      out[key] = inTheirs;
      continue;
    }
    if (hasMine && !hasTheirs) {
      out[key] = inMine;
      continue;
    }

    const result = mergeValue(inBase, inMine, inTheirs, key, {
      ...context,
      itemId: context.itemId || key,
    });
    out[key] = result.value;
    conflicts.push(...result.conflicts);
  }
  return { value: out, conflicts };
}

// ---------------------------------------------------------------------------
// Applying answers
// ---------------------------------------------------------------------------

/**
 * Whether every conflict raised has an answer.
 *
 * Checked before a merged project may be committed: half a decision is a
 * project that is neither yours nor theirs.
 */
export function isFullyResolved(
  conflicts: Conflict[],
  answers: Map<string, unknown>,
): boolean {
  return conflicts.every((c) => answers.has(c.id));
}
