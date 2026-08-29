import { z } from "zod";

/**
 * What a synchronization commit says it did, in a form both a person and the
 * app can read.
 *
 * The subject line is written for the administrator scrolling their project's
 * history on github.com. The trailers underneath are for Studio: they are how
 * Recent Activity gets its detail without the app having to diff two JSON files
 * and guess what the difference meant.
 *
 * ```
 * Updated creature and mod configuration
 *
 * DinoDepot-Project: 11111111-2222-4333-8444-555555555555
 * DinoDepot-Schema: 2
 * DinoDepot-Operation: 8a7c…
 * DinoDepot-Actions-Version: 1
 * DinoDepot-Action: {"type":"creature.updated","id":"r1","fields":["displayName"]}
 * DinoDepot-Action: {"type":"mod.added","id":"1431447"}
 * ```
 *
 * Trailers rather than a JSON blob in the body because they survive everything
 * that handles commit messages - `git log --format`, the GitHub UI, a cherry-pick
 * - and because a reader who has never heard of DinoDepot can still tell what
 * the commit did.
 */

/**
 * Version of the *action* vocabulary, which moves independently of the project
 * schema. A reader that finds a higher number keeps what it understands and
 * says plainly that some detail came from a newer Studio, rather than throwing
 * away a commit it could mostly read.
 */
export const ACTION_SCHEMA_VERSION = 1;

export const TRAILER = {
  project: "DinoDepot-Project",
  schema: "DinoDepot-Schema",
  operation: "DinoDepot-Operation",
  actor: "DinoDepot-Actor",
  actionsVersion: "DinoDepot-Actions-Version",
  action: "DinoDepot-Action",
} as const;

/**
 * One thing that happened.
 *
 * `type` is deliberately an open string rather than an enum: a commit written by
 * a newer Studio will carry types this build has never heard of, and the right
 * response is to show them plainly, not to refuse the commit.
 */
export const StructuredActionSchema = z.object({
  /** `<domain>.<verb>`, e.g. `creature.updated`. */
  type: z.string().min(1),
  /** Stable id of the thing acted on. Empty when the action is not about one. */
  id: z.string().default(""),
  /** Fields that changed, for an update. */
  fields: z.array(z.string()).default([]),
  /**
   * Human-readable name at the time of the change, so history stays readable
   * after the thing is renamed or deleted.
   */
  label: z.string().default(""),
  /** For actions that summarise several items rather than naming one. */
  count: z.number().int().nonnegative().optional(),
});
export type StructuredAction = z.infer<typeof StructuredActionSchema>;

/**
 * Recorded when the project files changed but Studio did not do it - someone
 * edited JSON by hand, or restored a file from a backup.
 *
 * Without this, such a sync would produce a commit that claims nothing
 * happened, which is worse than admitting the app does not know.
 */
export const EXTERNAL_CHANGES_ACTION = "project.external_changes_detected";

/** Recorded by the migration coordinator on the first sync after a migration. */
export const MIGRATION_ACTION = "project.migrated";

/** Domain each action type belongs to, and how to say it in a subject line. */
const DOMAIN_LABELS: [prefix: string, label: string][] = [
  ["creature.", "creature"],
  ["item.", "item"],
  ["rule.", "production"],
  ["mod.", "mod"],
  ["source.", "mod"],
  ["remap.", "remap"],
  ["cosmetic.", "cosmetic"],
  ["player.", "player"],
  ["profile.", "profile"],
  ["watchlist.", "watchlist"],
  ["settings.", "settings"],
  ["project.", "project"],
];

function domainOf(type: string): string {
  return DOMAIN_LABELS.find(([prefix]) => type.startsWith(prefix))?.[1] ?? "project";
}

/**
 * The subject line for a set of actions.
 *
 * Names at most three domains; beyond that the list stops being a summary. The
 * order follows first appearance rather than the table above, so the subject
 * reflects what the administrator actually did first.
 */
export function commitSubject(actions: StructuredAction[]): string {
  if (actions.length === 0) return "Updated project files";
  if (actions.length === 1 && actions[0].type === EXTERNAL_CHANGES_ACTION) {
    return "Recorded changes made outside Studio";
  }
  if (actions.every((a) => a.type === MIGRATION_ACTION)) {
    return "Updated the project to a newer format";
  }

  const domains: string[] = [];
  for (const action of actions) {
    const domain = domainOf(action.type);
    if (!domains.includes(domain)) domains.push(domain);
  }
  if (domains.length > 3) return "Updated several parts of the project";
  return `Updated ${joinWords(domains)} configuration`;
}

function joinWords(words: string[]): string {
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export interface CommitEnvelope {
  projectId: string;
  schemaVersion: number;
  operationId: string;
  /** GitHub username of the administrator sharing this change. */
  actor?: string;
  actions: StructuredAction[];
  /** Overrides the generated subject. Used by Publish, which writes its own. */
  subject?: string;
}

/**
 * Builds the complete commit message.
 *
 * Each action is serialized on one line. `JSON.stringify` escapes any newline
 * inside a string value, so an action can never break out of its trailer and
 * turn into something a parser reads as a different field.
 */
export function encodeCommitMessage(envelope: CommitEnvelope): string {
  const subject = envelope.subject?.trim() || commitSubject(envelope.actions);
  // A trailer is one line by definition. GitHub usernames cannot contain a
  // newline, but keeping this boundary safe costs nothing and prevents a bad
  // local record from manufacturing another trailer.
  const actor = envelope.actor?.replace(/[\r\n]+/g, " ").trim() ?? "";
  const lines = [
    subject,
    "",
    `${TRAILER.project}: ${envelope.projectId}`,
    `${TRAILER.schema}: ${envelope.schemaVersion}`,
    `${TRAILER.operation}: ${envelope.operationId}`,
    ...(actor ? [`${TRAILER.actor}: ${actor}`] : []),
    `${TRAILER.actionsVersion}: ${ACTION_SCHEMA_VERSION}`,
    ...envelope.actions.map(
      (action) => `${TRAILER.action}: ${JSON.stringify(compact(action))}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Drops defaulted fields before serializing.
 *
 * Every commit message is permanent, and an empty `fields: []` on thousands of
 * actions is bytes nobody will ever read. The schema fills them back in on the
 * way out.
 */
function compact(action: StructuredAction): Record<string, unknown> {
  const out: Record<string, unknown> = { type: action.type };
  if (action.id) out.id = action.id;
  if (action.fields.length > 0) out.fields = action.fields;
  if (action.label) out.label = action.label;
  if (action.count !== undefined) out.count = action.count;
  return out;
}

export interface DecodedCommit {
  subject: string;
  projectId: string;
  schemaVersion: number | null;
  operationId: string;
  /** GitHub username recorded by Studio, when known. */
  actor: string;
  /** Null when the commit carries no version - i.e. it is not one of ours. */
  actionsVersion: number | null;
  actions: StructuredAction[];
  /**
   * Action trailers that could not be parsed. Counted rather than discarded so
   * the UI can say "and 3 more changes this version of Studio cannot describe"
   * instead of quietly showing less than happened.
   */
  unreadableActions: number;
  /** True when the commit was written by a newer action vocabulary. */
  fromNewerStudio: boolean;
  /** False for a commit DinoDepot did not write - a web edit, say. */
  isDinoDepot: boolean;
}

/**
 * Reads a commit message back.
 *
 * Tolerant throughout: this runs against commits written by versions that do
 * not exist yet, and against commits DinoDepot did not write at all - somebody
 * editing a file through the GitHub web UI produces a perfectly ordinary commit
 * that this still has to describe.
 */
export function decodeCommitMessage(message: string): DecodedCommit {
  const lines = message.split(/\r?\n/);
  const subject = lines[0]?.trim() ?? "";

  const result: DecodedCommit = {
    subject,
    projectId: "",
    schemaVersion: null,
    operationId: "",
    actor: "",
    actionsVersion: null,
    actions: [],
    unreadableActions: 0,
    fromNewerStudio: false,
    isDinoDepot: false,
  };

  for (const line of lines.slice(1)) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    switch (key) {
      case TRAILER.project:
        result.projectId = value;
        result.isDinoDepot = true;
        break;
      case TRAILER.schema:
        result.schemaVersion = Number.isInteger(Number(value)) ? Number(value) : null;
        break;
      case TRAILER.operation:
        result.operationId = value;
        break;
      case TRAILER.actor:
        result.actor = value;
        break;
      case TRAILER.actionsVersion:
        result.actionsVersion = Number.isInteger(Number(value)) ? Number(value) : null;
        break;
      case TRAILER.action: {
        const parsed = parseAction(value);
        if (parsed) result.actions.push(parsed);
        else result.unreadableActions++;
        break;
      }
      default:
        break;
    }
  }

  result.fromNewerStudio =
    result.actionsVersion !== null && result.actionsVersion > ACTION_SCHEMA_VERSION;
  return result;
}

function parseAction(value: string): StructuredAction | null {
  try {
    const parsed = StructuredActionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The journal
// ---------------------------------------------------------------------------

/**
 * Collapses a run of actions into what a single commit should say.
 *
 * Editing one creature's name twenty times is one line of history, not twenty:
 * repeated updates to the same thing merge, and their changed fields union.
 * A create followed by updates stays a create - the thing is new, and saying so
 * is more useful than listing what it was adjusted to on the way in.
 * A create followed by a delete disappears entirely, because between one sync
 * and the next it never existed as far as anyone else is concerned.
 */
export function collapseActions(actions: StructuredAction[]): StructuredAction[] {
  const out: StructuredAction[] = [];
  /** Where each `type-domain:id` currently sits in `out`. */
  const index = new Map<string, number>();

  for (const action of actions) {
    const domain = action.type.split(".")[0];
    const verb = action.type.split(".").slice(1).join(".");
    const key = `${domain}:${action.id}`;
    // An action about no particular thing cannot be collapsed against another.
    const existingAt = action.id ? index.get(key) : undefined;

    if (existingAt === undefined) {
      index.set(key, out.length);
      out.push({ ...action, fields: [...action.fields] });
      continue;
    }

    const existing = out[existingAt];
    const existingVerb = existing.type.split(".").slice(1).join(".");

    if (verb === "deleted" && (existingVerb === "added" || existingVerb === "created")) {
      // Created and removed between syncs: nobody else ever saw it.
      out.splice(existingAt, 1);
      index.delete(key);
      for (const [otherKey, at] of index) {
        if (at > existingAt) index.set(otherKey, at - 1);
      }
      continue;
    }

    if (verb === "deleted") {
      out[existingAt] = { ...action, fields: [] };
      continue;
    }

    if (existingVerb === "added" || existingVerb === "created") {
      // Still a create; carry the latest label forward.
      out[existingAt] = { ...existing, label: action.label || existing.label };
      continue;
    }

    out[existingAt] = {
      ...existing,
      label: action.label || existing.label,
      fields: [...new Set([...existing.fields, ...action.fields])],
    };
  }

  return out;
}

/**
 * A one-line description of an action, for Recent Activity.
 *
 * Falls back to the raw type for anything unrecognised, so a commit from a
 * newer Studio still reads as something rather than as a blank row.
 */
export function describeAction(action: StructuredAction): string {
  const name = action.label || action.id || "an item";
  const [, verb] = action.type.split(".");
  const domain = domainOf(action.type);

  switch (action.type) {
    case EXTERNAL_CHANGES_ACTION:
      return "Changes made outside Studio were included";
    case MIGRATION_ACTION:
      return "The project was updated to a newer format";
    default:
      break;
  }

  switch (verb) {
    case "added":
    case "created":
      return `Added ${domain} ${name}`;
    case "deleted":
    case "removed":
      return `Removed ${domain} ${name}`;
    case "updated":
    case "changed":
      return action.fields.length > 0
        ? `Changed ${joinWords(action.fields)} on ${domain} ${name}`
        : `Updated ${domain} ${name}`;
    default:
      return `${action.type} ${name}`.trim();
  }
}
