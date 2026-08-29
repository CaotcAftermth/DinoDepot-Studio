import * as git from "./gitRepo";
import { StudioError } from "../model/errors";
import { PROJECT_FILE } from "../model/project";
import { StructuredActionSchema, type StructuredAction } from "../model/commitActions";
import {
  summarizeConflicts,
  type Conflict,
  type ResolvedConflict,
} from "../model/merge/conflicts";
import { FILE_MERGERS, mergeSettings, mergerFor } from "../model/merge/domains";
import { deepEqual } from "../model/merge/core";
import type { ReconcileInput, ReconcileResult } from "./sync";

/**
 * Bringing two administrators' work together.
 *
 * Three versions of every file: the one you both last agreed on, the one on
 * this computer, and the one that was fetched. Each goes through the merge
 * rules for its own file, and what comes out is either a complete project or a
 * complete project plus a list of questions.
 *
 * Nothing here touches Git's own merge machinery. A line-based merge of JSON
 * produces conflict markers *inside* the file, which the app then cannot parse
 * - turning a recoverable disagreement into a broken project.
 */

/** The full result, including the conflicts the UI needs to present. */
export interface ReconcileOutcome extends ReconcileResult {
  conflictList: Conflict[];
  /** Files as they would be written if every conflict resolved to "mine". */
  mergedFiles: Record<string, string>;
}

export interface ReconcileOptions {
  input: ReconcileInput;
  /** Files as they are on disk right now, including unsaved-but-flushed edits. */
  localFiles: Record<string, string>;
  /** Answers already given, when re-running after the administrator decided. */
  answers?: ResolvedConflict[];
}

/**
 * Files that are never merged, and why.
 *
 * `history.json` and `activity.json` are this install's record of what it did.
 * The shared record is the Git history itself, which is exactly why the spec
 * says not to synchronize them as append-only files - two administrators would
 * fight over the same array forever.
 */
const NOT_MERGED: string[] = [PROJECT_FILE.history, PROJECT_FILE.activity];

export async function reconcile(options: ReconcileOptions): Promise<ReconcileOutcome> {
  const { input, localFiles } = options;

  // A first sync has no agreed-on point. Every difference then reads as an
  // addition from both sides, which the by-id merge already handles.
  const baseFiles = input.base
    ? await readTreeSafely(input.dir, input.base, "the last version you both had")
    : {};
  const theirFiles = await readTreeSafely(
    input.dir,
    input.remoteCommit,
    "the team's latest version",
  );

  const conflicts: Conflict[] = [];
  const merged: Record<string, string> = {};
  const actions: StructuredAction[] = [];

  const names = new Set([
    ...Object.keys(baseFiles),
    ...Object.keys(localFiles),
    ...Object.keys(theirFiles),
  ]);

  for (const name of [...names].sort()) {
    if (!name.endsWith(".json")) continue;
    if (NOT_MERGED.includes(name)) {
      // Left exactly as this computer has it. Nothing shared depends on them.
      if (localFiles[name] !== undefined) merged[name] = localFiles[name];
      continue;
    }

    const mineText = localFiles[name];
    const theirsText = theirFiles[name];
    const baseText = baseFiles[name];

    // Only one side has it at all.
    if (mineText === undefined && theirsText !== undefined) {
      merged[name] = theirsText;
      continue;
    }
    if (theirsText === undefined && mineText !== undefined) {
      merged[name] = mineText;
      continue;
    }
    if (mineText === undefined || theirsText === undefined) continue;
    if (mineText === theirsText) {
      merged[name] = mineText;
      continue;
    }

    const outcome = mergeFile(name, baseText, mineText, theirsText);
    merged[name] = outcome.text;
    conflicts.push(...outcome.conflicts);
    if (outcome.changedFromMine) {
      actions.push(
        StructuredActionSchema.parse({
          type: "project.integrated",
          id: name,
          label: outcome.label,
        }),
      );
    }
  }

  const answered = applyAnswers(merged, conflicts, options.answers ?? []);
  const unresolved = conflicts.filter(
    (c) => !(options.answers ?? []).some((a) => a.id === c.id),
  );

  return {
    merged: unresolved.length === 0,
    files: answered,
    mergedFiles: answered,
    actions,
    conflicts: summarizeConflicts(unresolved),
    conflictList: unresolved,
  };
}

interface FileOutcome {
  text: string;
  conflicts: Conflict[];
  /** True when the merged file differs from what this computer had. */
  changedFromMine: boolean;
  label: string;
}

/** Merges one file, or raises a whole-file conflict when it cannot. */
function mergeFile(
  name: string,
  baseText: string | undefined,
  mineText: string,
  theirsText: string,
): FileOutcome {
  const merger = name === PROJECT_FILE.settings ? null : mergerFor(name);
  const label =
    name === PROJECT_FILE.settings ? "project settings" : merger?.label ?? name;

  // A file with no merge rule is not guessed at. Keeping one side silently is
  // how somebody's afternoon disappears without anyone noticing.
  if (name !== PROJECT_FILE.settings && !merger) {
    return {
      text: mineText,
      label,
      changedFromMine: false,
      conflicts: [
        {
          id: `file:${name}:`,
          domain: "file",
          itemId: name,
          itemLabel: name,
          field: "",
          fieldLabel: "",
          kind: "binary",
          mine: mineText,
          theirs: theirsText,
          canKeepBoth: false,
        },
      ],
    };
  }

  const base = parseOrUndefined(baseText);
  const mine = parseOrUndefined(mineText);
  const theirs = parseOrUndefined(theirsText);

  // Unparseable on either side is not something to merge - it is something to
  // stop for. The quarantine path handles the local case; this covers a file
  // that arrived damaged.
  if (mine === undefined || theirs === undefined) {
    return {
      text: mineText,
      label,
      changedFromMine: false,
      conflicts: [
        {
          id: `file:${name}:`,
          domain: "file",
          itemId: name,
          itemLabel: label,
          field: "",
          fieldLabel: "",
          kind: "binary",
          mine: mineText,
          theirs: theirsText,
          canKeepBoth: false,
        },
      ],
    };
  }

  const result =
    name === PROJECT_FILE.settings
      ? mergeSettings(base, mine, theirs)
      : merger!.merge(base, mine, theirs);

  return {
    text: `${JSON.stringify(result.value, null, 2)}\n`,
    conflicts: result.conflicts,
    changedFromMine: !deepEqual(result.value, mine),
    label,
  };
}

function parseOrUndefined(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Rewrites the merged files to reflect the administrator's answers.
 *
 * The merge holds this computer's value for anything disputed, so an answer of
 * "mine" needs no work; "theirs" and "custom" are written into the file the
 * conflict came from.
 */
export function applyAnswers(
  files: Record<string, string>,
  conflicts: Conflict[],
  answers: ResolvedConflict[],
): Record<string, string> {
  if (answers.length === 0) return files;
  const byId = new Map(conflicts.map((c) => [c.id, c]));
  const out = { ...files };

  for (const answer of answers) {
    if (answer.resolution === "mine") continue;
    const conflict = byId.get(answer.id);
    if (!conflict) continue;
    const file = fileForDomain(conflict.domain);
    const text = out[file];
    if (text === undefined) continue;

    if (answer.resolution === "both") {
      const updated = keepBoth(text, conflict);
      if (updated !== null) out[file] = updated;
      continue;
    }

    const value =
      answer.resolution === "custom" ? answer.custom : conflict.theirs;
    const updated = writeResolution(text, conflict, value);
    if (updated !== null) out[file] = updated;
  }
  return out;
}

/**
 * Keeps both sides of a collision, under distinct identities.
 *
 * Only meaningful when two administrators added *different things* that happen
 * to share an id - which the merge already reports as `add-vs-add`. Theirs is
 * re-identified rather than mine, so the ids on this computer stay stable and
 * nothing else referring to them breaks.
 *
 * A `binary` conflict (two saves for one player) is not handled here: the
 * roster holds one profile reference per player, so "both" would need a second
 * player record, which is a decision about the roster rather than a merge.
 */
function keepBoth(text: string, conflict: Conflict): string | null {
  if (conflict.kind !== "add-vs-add") return null;
  if (!isRecord(conflict.theirs)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const list = findListContaining(parsed, conflict.itemId);
  if (!list) return null;

  const theirs = { ...(conflict.theirs as Record<string, unknown>) };
  // Derived from the original rather than random, so re-running the same merge
  // produces the same file - a merge that is not deterministic shows a change
  // on every sync.
  const idKey = ["id", "modId"].find((key) => typeof theirs[key] === "string");
  if (!idKey) return null;
  theirs[idKey] = `${conflict.itemId}-2`;

  // Already added by an earlier answer; doing it twice would duplicate it.
  if (list.some((item) => isRecord(item) && item[idKey] === theirs[idKey])) {
    return null;
  }

  list.push(theirs);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/** The array holding an item with this id, wherever it is in the tree. */
function findListContaining(node: unknown, itemId: string): unknown[] | null {
  if (Array.isArray(node)) {
    if (node.some((item) => isRecord(item) && identityOf(item) === itemId)) {
      return node;
    }
    for (const item of node) {
      const found = findListContaining(item, itemId);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  for (const child of Object.values(node)) {
    const found = findListContaining(child, itemId);
    if (found) return found;
  }
  return null;
}

/**
 * Which file a domain's conflicts live in.
 *
 * Derived from the merger registry rather than a second table, so adding a
 * domain cannot leave this behind.
 */
const DOMAIN_FILES: Record<string, string> = {
  creature: PROJECT_FILE.production,
  remap: PROJECT_FILE.remaps,
  cosmetic: PROJECT_FILE.cosmetics,
  mod: PROJECT_FILE.catalog,
  icon: PROJECT_FILE.catalog,
  note: PROJECT_FILE.catalog,
  "map of origin": PROJECT_FILE.catalog,
  variant: PROJECT_FILE.catalog,
  "watched mod": PROJECT_FILE.watchlist,
  player: PROJECT_FILE.players,
  profile: PROJECT_FILE.players,
  "imported creature": PROJECT_FILE.creatureImports,
  project: PROJECT_FILE.settings,
};

function fileForDomain(domain: string): string {
  return DOMAIN_FILES[domain] ?? PROJECT_FILE.settings;
}

/**
 * Writes one resolved value back into a file.
 *
 * Walks the parsed structure looking for the item by id rather than by path,
 * for the same reason the merge does: a position is not an identity.
 */
function writeResolution(
  text: string,
  conflict: Conflict,
  value: unknown,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const changed = setByItemId(parsed, conflict.itemId, conflict.field, value);
  if (!changed) return null;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

/**
 * Finds the object carrying `id` anywhere in the tree and sets one field on it.
 *
 * An empty `field` replaces the whole item - which is what a delete-vs-edit or
 * an add-vs-add answer means.
 */
function setByItemId(
  node: unknown,
  itemId: string,
  field: string,
  value: unknown,
): boolean {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (isRecord(item) && identityOf(item) === itemId) {
        if (field === "") {
          if (value === undefined) node.splice(i, 1);
          else node[i] = value;
        } else {
          item[field] = value;
        }
        return true;
      }
      if (setByItemId(item, itemId, field, value)) return true;
    }
    return false;
  }
  if (!isRecord(node)) return false;

  // A map keyed by the id itself - icon assignments and the like.
  if (field !== "" && Object.prototype.hasOwnProperty.call(node, field)) {
    const looksLikeMap = Object.values(node).every(
      (v) => typeof v === "string" || typeof v === "number",
    );
    if (looksLikeMap) {
      if (value === undefined) delete node[field];
      else node[field] = value;
      return true;
    }
  }

  if (identityOf(node) === itemId) {
    if (field === "") return false;
    node[field] = value;
    return true;
  }

  for (const child of Object.values(node)) {
    if (setByItemId(child, itemId, field, value)) return true;
  }
  return false;
}

/** The fields that can carry an item's identity, in the order they are tried. */
function identityOf(item: Record<string, unknown>): string | undefined {
  for (const key of ["id", "modId", "map"]) {
    const value = item[key];
    if (typeof value === "string" && value) {
      return key === "map" ? value.trim().toLowerCase() : value;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readTreeSafely(
  dir: string,
  commit: string,
  what: string,
): Promise<Record<string, string>> {
  if (!commit) return {};
  try {
    return await git.readTree(dir, commit);
  } catch (e) {
    throw new StudioError(
      "sync.conflictsPending",
      `DinoDepot could not read ${what}, so it cannot safely bring the changes together.`,
      { detail: e instanceof Error ? e.message : String(e), cause: e },
    );
  }
}

/** Every file merging is capable of handling, for the coverage test. */
export const MERGED_FILES = [
  PROJECT_FILE.settings,
  ...FILE_MERGERS.map((m) => m.file),
];
