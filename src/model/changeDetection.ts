import { StructuredActionSchema, type StructuredAction } from "./commitActions";
import { deepEqual } from "./merge/core";

/**
 * Working out what an edit did, so the commit can say so.
 *
 * The alternative was asking every call site to describe its own change, which
 * is a promise nobody keeps: the twentieth place that edits a creature forgets,
 * and the commit silently degrades to "files changed". Diffing the before and
 * after states cannot be forgotten, because it happens in the one place every
 * edit already goes through - the store setter.
 *
 * Deliberately shallow about *values*. "Changed interval on Rex" is what an
 * administrator wants; "changed interval from 300 to 600" is what the file
 * already records, and repeating it in the history doubles the size of every
 * commit message for nothing.
 */

/** What a domain looks like to the differ: a list of things with stable ids. */
export interface DiffSpec<T> {
  /** `<domain>` in the resulting `<domain>.<verb>` action type. */
  domain: string;
  keyOf(item: T): string;
  labelOf(item: T): string;
  /** Fields never worth mentioning - caches, timestamps, scrape results. */
  ignore?: string[];
}

/**
 * Compares two versions of a list and describes the difference.
 *
 * By stable id, for the same reason the merge is: an item's position is not its
 * identity, and diffing by index would report an insertion at the top as every
 * item having changed.
 */
export function diffList<T extends Record<string, unknown>>(
  before: T[],
  after: T[],
  spec: DiffSpec<T>,
): StructuredAction[] {
  const actions: StructuredAction[] = [];
  const beforeById = new Map(before.map((item) => [spec.keyOf(item), item]));
  const afterById = new Map(after.map((item) => [spec.keyOf(item), item]));

  for (const [id, item] of afterById) {
    const previous = beforeById.get(id);
    if (!previous) {
      actions.push(
        action(`${spec.domain}.added`, id, spec.labelOf(item)),
      );
      continue;
    }
    const fields = changedFields(previous, item, spec.ignore);
    if (fields.length > 0) {
      actions.push(
        action(`${spec.domain}.updated`, id, spec.labelOf(item), fields),
      );
    }
  }

  for (const [id, item] of beforeById) {
    if (!afterById.has(id)) {
      actions.push(action(`${spec.domain}.deleted`, id, spec.labelOf(item)));
    }
  }

  return actions;
}

/**
 * Which top-level fields differ.
 *
 * Nested structures collapse to their own name - "cycles" rather than a path
 * three levels deep - because the point is to tell the administrator *where* to
 * look, and they will look at the creature either way.
 */
function changedFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: string[] = [],
): string[] {
  const fields: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (ignore.includes(key)) continue;
    if (!deepEqual(before[key], after[key])) fields.push(key);
  }
  return fields.sort();
}

function action(
  type: string,
  id: string,
  label: string,
  fields: string[] = [],
): StructuredAction {
  return StructuredActionSchema.parse({ type, id, label, fields });
}

/** Compares two string-keyed maps - icon assignments, notes, maps of origin. */
export function diffMap(
  before: Record<string, string>,
  after: Record<string, string>,
  domain: string,
): StructuredAction[] {
  const actions: StructuredAction[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of [...keys].sort()) {
    const had = key in before;
    const has = key in after;
    if (!had && has) actions.push(action(`${domain}.added`, key, leafOf(key)));
    else if (had && !has) actions.push(action(`${domain}.deleted`, key, leafOf(key)));
    else if (before[key] !== after[key]) {
      actions.push(action(`${domain}.updated`, key, leafOf(key)));
    }
  }
  return actions;
}

/** Compares a settings object field by field. */
export function diffSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  ignore: string[] = [],
): StructuredAction[] {
  const fields = changedFields(before, after, ignore);
  if (fields.length === 0) return [];
  return [action("settings.updated", "settings", "project settings", fields)];
}

/** The readable tail of a blueprint path, for a label. */
export function leafOf(bpPath: string): string {
  return bpPath.split(/[./]/).filter(Boolean).pop() ?? bpPath;
}

// ---------------------------------------------------------------------------
// The specs for each project file
// ---------------------------------------------------------------------------

type Any = Record<string, unknown>;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export const PRODUCTION_SPEC: DiffSpec<Any> = {
  domain: "creature",
  keyOf: (r) => str(r.id),
  labelOf: (r) => leafOf(str(r.dinoType)),
};

export const REMAP_SPEC: DiffSpec<Any> = {
  domain: "remap",
  keyOf: (e) => str(e.id),
  labelOf: (e) => `${leafOf(str(e.fromClass))} → ${leafOf(str(e.toClass))}`,
};

export const COSMETIC_SPEC: DiffSpec<Any> = {
  domain: "cosmetic",
  keyOf: (e) => str(e.modId) || str(e.id),
  labelOf: (e) => str(e.name) || str(e.modId),
};

export const SOURCE_SPEC: DiffSpec<Any> = {
  domain: "mod",
  keyOf: (s) => str(s.id),
  labelOf: (s) => str(s.name) || str(s.id),
  // A machine-local path, and not something the team needs told about.
  ignore: ["iconsDir"],
};

export const WATCHLIST_SPEC: DiffSpec<Any> = {
  domain: "watchlist",
  keyOf: (m) => str(m.modId) || str(m.id),
  labelOf: (m) => str(m.name) || str(m.modId),
  // Results of a check this machine happened to run, not decisions anybody made.
  ignore: ["lastCheckedAt", "latestUpdated", "needsReview"],
};

export const PLAYER_SPEC: DiffSpec<Any> = {
  domain: "player",
  keyOf: (p) => str(p.id),
  labelOf: (p) =>
    str(p.discordName) || str(p.gameName) || str(p.steamName) || str(p.id),
};

export const IMPORT_SPEC: DiffSpec<Any> = {
  domain: "creature",
  keyOf: (r) => str(r.id),
  labelOf: (r) => leafOf(str(r.bpPath)) || str(r.id),
};

/**
 * Everything that changed between two versions of the catalog.
 *
 * Four shapes in one file, and the three maps are where most edits actually
 * happen - assigning an icon, writing a note - so they get described rather
 * than collapsing into "the catalog changed".
 */
export function diffCatalog(before: Any, after: Any): StructuredAction[] {
  const actions = diffList(
    asArray(before.sources),
    asArray(after.sources),
    SOURCE_SPEC,
  );
  for (const [key, domain] of [
    ["icons", "icon"],
    ["notes", "note"],
    ["maps", "map"],
  ] as const) {
    actions.push(
      ...diffMap(
        asMap(before[key]),
        asMap(after[key]),
        domain,
      ),
    );
  }
  return actions;
}

function asArray(value: unknown): Any[] {
  return Array.isArray(value) ? (value as Any[]) : [];
}

function asMap(value: unknown): Record<string, string> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, string>)
    : {};
}
