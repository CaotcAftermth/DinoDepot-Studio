/**
 * What two administrators disagreed about, in terms they will recognise.
 *
 * A conflict here is never "both sides changed line 47". It names the thing -
 * a creature, a mod, a player - the field, and the two values, because that is
 * the only form a question about it can usefully take: *you set the interval to
 * 300, Sam set it to 600; which is right?*
 */

export type ConflictKind =
  /** Both changed the same field to different values. */
  | "field"
  /** One deleted it; the other changed it. */
  | "delete-vs-edit"
  /** Both added something with the same id, but not the same content. */
  | "add-vs-add"
  /** Two different files under one name - a profile backup, say. */
  | "binary";

export type Resolution =
  /** Keep this computer's version. */
  | "mine"
  /** Keep the other administrator's. */
  | "theirs"
  /** Keep both, under distinct identities. Only offered where it makes sense. */
  | "both"
  /** A value the administrator supplied instead of either. */
  | "custom";

export interface Conflict {
  /**
   * Stable across a re-run of the same merge, so a half-finished resolution
   * survives the administrator closing the dialog and coming back.
   */
  id: string;
  /** "creature", "mod", "player" - what the UI groups by. */
  domain: string;
  /** Stable id of the thing, for reference. Not shown. */
  itemId: string;
  /** What to call it on screen: a creature's name, a mod's title. */
  itemLabel: string;
  /** Field key. Empty for a whole-item conflict. */
  field: string;
  /** What to call the field on screen. */
  fieldLabel: string;
  kind: ConflictKind;
  /** What it was when the two of you last agreed. Absent when it is new. */
  base?: unknown;
  mine: unknown;
  theirs: unknown;
  /** Whether "keep both" is a sensible answer for this one. */
  canKeepBoth: boolean;
}

export interface ResolvedConflict extends Conflict {
  resolution: Resolution;
  /** The value chosen, when the resolution is "custom". */
  custom?: unknown;
}

/** Builds the id a conflict is tracked by. */
export function conflictId(domain: string, itemId: string, field: string): string {
  return `${domain}:${itemId}:${field}`;
}

/**
 * A short line describing what needs deciding.
 *
 * Deliberately free of Git vocabulary - see `leaksGitTerms`, which a test runs
 * over everything this produces.
 */
export function describeConflict(conflict: Conflict): string {
  const what = conflict.itemLabel || conflict.itemId || "an item";
  switch (conflict.kind) {
    case "delete-vs-edit":
      return `${what} was removed here and changed by someone else`;
    case "add-vs-add":
      return `${what} was added in two different ways`;
    case "binary":
      return `Two different versions of ${what}`;
    default:
      return `${conflict.fieldLabel || conflict.field} on ${what}`;
  }
}

/** How a value should read in the "yours / theirs" columns. */
export function displayValue(value: unknown): string {
  if (value === undefined) return "(not set)";
  if (value === null) return "(none)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string") return value === "" ? "(empty)" : value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    return value.length === 0 ? "(nothing)" : `${value.length} items`;
  }
  if (typeof value === "object") return "(several settings)";
  return String(value);
}

/**
 * Conflicts grouped by what they are about, in first-seen order.
 *
 * First-seen rather than alphabetical: the grouping should read in the order
 * the administrator's own project does, not in an order that reshuffles itself
 * when a domain name changes.
 */
export function groupByDomain(conflicts: Conflict[]): [string, Conflict[]][] {
  const groups = new Map<string, Conflict[]>();
  for (const conflict of conflicts) {
    const existing = groups.get(conflict.domain);
    if (existing) existing.push(conflict);
    else groups.set(conflict.domain, [conflict]);
  }
  return [...groups.entries()];
}

/** Groups conflicts for the summary line: "3 creatures, 1 mod". */
export function summarizeConflicts(conflicts: Conflict[]): {
  count: number;
  domains: string[];
} {
  const domains: string[] = [];
  for (const conflict of conflicts) {
    if (!domains.includes(conflict.domain)) domains.push(conflict.domain);
  }
  return { count: conflicts.length, domains };
}

/** True once every conflict has an answer. */
export function allResolved(resolved: ResolvedConflict[], conflicts: Conflict[]): boolean {
  if (conflicts.length === 0) return true;
  const answers = new Set(resolved.map((r) => r.id));
  return conflicts.every((c) => answers.has(c.id));
}
