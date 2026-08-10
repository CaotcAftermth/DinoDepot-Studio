import { z } from "zod";
import {
  ABILITY_KIND_LABELS,
  CreatureInfo,
  CreatureInfoSchema,
  DROP_LISTS,
  emptyCreatureInfo,
  INFO_SECTIONS,
  InfoSection,
  SECTION_LABELS,
  methodLabel,
} from "./creatureInfo";

/** Last path segment of a blueprint, for naming a drop that has no label. */
function shortDropName(bpPath: string): string {
  const file = bpPath.split("/").pop() ?? bpPath;
  return file.split(".")[0] || "(unnamed)";
}

/**
 * Wiki import staging.
 *
 * Nothing the importer produces is ever live. It writes *proposals* that a
 * human compares against the current record and accepts section by section.
 * The original wiki text is kept alongside so a reviewer can check the mapping
 * rather than trusting it, and the revision id is what makes a later reimport
 * a diff rather than a blind overwrite.
 */

export const IMPORT_STATUSES = [
  "pending",
  "accepted",
  "rejected",
  "superseded",
] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const IMPORT_STATUS_LABELS: Record<ImportStatus, string> = {
  pending: "Needs review",
  accepted: "Accepted",
  rejected: "Rejected",
  superseded: "Superseded by a newer revision",
};

/** Which game the extracted information applies to. */
export const IMPORT_GAMES = ["ASA", "ASE", "both", "unknown"] as const;
export type ImportGame = (typeof IMPORT_GAMES)[number];

export const ImportSourceSchema = z.object({
  /** Wiki page title, e.g. "Gigantoraptor" or "Mod:Additions Ascended/Edmontonia". */
  page: z.string(),
  /** Section the text came from, for the reviewer's orientation. */
  section: z.string().default("Taming"),
  url: z.string().default(""),
  /** Anchor for reimport comparison — a newer revision means a re-review. */
  revisionId: z.number().int().default(0),
  revisionTimestamp: z.string().default(""),
  importedAt: z.string(),
  game: z.enum(IMPORT_GAMES).default("unknown"),
  /** Set when the creature comes from a mod rather than the base game. */
  mod: z.string().default(""),
});
export type ImportSource = z.infer<typeof ImportSourceSchema>;

/** A name the importer could not resolve to a catalog entry. */
export const UnresolvedRefSchema = z.object({
  kind: z.enum(["item", "creature"]),
  /** The name as written on the wiki. */
  name: z.string(),
  /** Where it appeared, so the reviewer can find it. */
  where: z.string().default(""),
});
export type UnresolvedRef = z.infer<typeof UnresolvedRefSchema>;

export const ImportRecordSchema = z.object({
  id: z.string(),
  /** Target creature. Empty when the name matched nothing in the catalog. */
  bpPath: z.string().default(""),
  /** Creature name as written on the wiki. */
  creatureName: z.string(),
  status: z.enum(IMPORT_STATUSES).default("pending"),
  source: ImportSourceSchema,
  /** Original wiki text, keyed by section, for reviewer comparison. */
  rawText: z.record(z.string(), z.string()).default({}),
  /** What the importer proposes, in the live schema. */
  proposed: CreatureInfoSchema,
  unresolved: z.array(UnresolvedRefSchema).default([]),
  /** Things the importer refused to guess at. */
  ambiguities: z.array(z.string()).default([]),
  /**
   * `needs-review` when anything was inferred rather than read directly, or
   * when references didn't resolve.
   */
  confidence: z.enum(["high", "needs-review"]).default("needs-review"),
  /**
   * True when this creature inherits from a parent and the proposal would be
   * a duplicate of it — the reviewer is told to skip rather than duplicate.
   */
  duplicatesParent: z.boolean().default(false),
  /** Free-text note from the reviewer. */
  reviewNote: z.string().default(""),
  reviewedAt: z.string().nullable().default(null),
});
export type ImportRecord = z.infer<typeof ImportRecordSchema>;

export const CreatureImportsFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(ImportRecordSchema).default([]),
});
export type CreatureImportsFile = z.infer<typeof CreatureImportsFileSchema>;

export function emptyCreatureImports(): CreatureImportsFile {
  return { schemaVersion: 1, records: [] };
}

// ---------------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------------

export type SectionDecision = "accept" | "reject";

export interface ImportDecision {
  sections: Record<InfoSection, SectionDecision>;
  /**
   * Strategy notes are the most likely thing an admin wrote by hand, so they
   * are preserved by default even when the acquisition section is accepted.
   */
  keepLocalStrategy: boolean;
}

/** Nothing accepted — the reviewer opts in per section. */
export function defaultDecision(): ImportDecision {
  return {
    sections: {
      acquisition: "reject",
      spawns: "reject",
      abilities: "reject",
      drops: "reject",
      technical: "reject",
      notes: "reject",
    },
    keepLocalStrategy: true,
  };
}

/**
 * Applies an accepted proposal onto the record that is live today.
 * Rejected sections keep whatever is already there.
 */
export function applyImport(
  current: CreatureInfo | undefined,
  proposed: CreatureInfo,
  decision: ImportDecision,
): CreatureInfo {
  const base = current ?? emptyCreatureInfo();
  const next: CreatureInfo = { ...base };

  if (decision.sections.acquisition === "accept") {
    next.availability = proposed.availability;
    next.methods = proposed.methods.map((m) => {
      if (!decision.keepLocalStrategy) return { ...m };
      // Carry over hand-written strategy for a method we already had.
      const mine = base.methods.find(
        (x) => x.name.trim().toLowerCase() === m.name.trim().toLowerCase(),
      );
      return mine?.strategy.trim() ? { ...m, strategy: mine.strategy } : { ...m };
    });
  }
  if (decision.sections.spawns === "accept") {
    next.spawnMaps = [...proposed.spawnMaps];
  }
  if (decision.sections.abilities === "accept") {
    next.abilities = proposed.abilities.map((a) => ({ ...a }));
  }
  if (decision.sections.drops === "accept") {
    next.drops = structuredClone(proposed.drops);
  }
  if (decision.sections.technical === "accept") {
    next.technical = { ...proposed.technical };
  }
  if (decision.sections.notes === "accept") {
    next.notes = proposed.notes;
  }

  // Accepting a section on a variant means it now owns that section.
  const owned = new Set(base.overrides);
  for (const section of INFO_SECTIONS) {
    if (decision.sections[section] === "accept") owned.add(section);
  }
  next.overrides = [...owned];
  return next;
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

export type ChangeKind = "add" | "change" | "same";

export interface SectionDiff {
  section: InfoSection;
  label: string;
  kind: ChangeKind;
  /** Human-readable one-liners describing what would change. */
  lines: { before: string; after: string; field: string }[];
}

function describeAcquisition(info: CreatureInfo): { field: string; value: string }[] {
  const out = [
    { field: "Availability", value: info.availability || "—" },
  ];
  for (const m of info.methods) {
    out.push({
      field: `Method: ${methodLabel(m)}`,
      value: [
        m.outcome || "no outcome",
        m.tags.length ? m.tags.join(", ") : "no tags",
        `${m.phases.length} phase(s)`,
        `${m.inputs.length} input(s)`,
      ].join(" · "),
    });
  }
  return out;
}

function sectionFields(
  info: CreatureInfo,
  section: InfoSection,
): { field: string; value: string }[] {
  switch (section) {
    case "acquisition":
      return describeAcquisition(info);
    case "spawns":
      return [
        {
          field: "Spawns on",
          value: info.spawnMaps.length ? info.spawnMaps.join(", ") : "—",
        },
      ];
    case "abilities":
      return info.abilities.map((a) => ({
        field: `${ABILITY_KIND_LABELS[a.kind]}: ${a.label}`,
        value: a.detail || "—",
      }));
    case "drops":
      return DROP_LISTS.flatMap((list) =>
        info.drops[list.key].map((d) => ({
          field: `${list.label}: ${d.label.trim() || shortDropName(d.bpPath)}`,
          value:
            [d.qty, list.hasChance ? d.chance : "", d.note]
              .filter((part) => part.trim())
              .join(" · ") || "—",
        })),
      );
    case "technical":
      return [
        {
          field: "Drag weight",
          value:
            info.technical.dragWeight === null
              ? "—"
              : String(info.technical.dragWeight),
        },
      ];
    case "notes":
      return [{ field: "Notes", value: info.notes.trim() || "—" }];
  }
}

/** What accepting each section would change, for the review screen. */
export function diffImport(
  current: CreatureInfo | undefined,
  proposed: CreatureInfo,
): SectionDiff[] {
  const base = current ?? emptyCreatureInfo();
  return INFO_SECTIONS.map((section) => {
    const before = sectionFields(base, section);
    const after = sectionFields(proposed, section);
    const fields = [
      ...new Set([...before, ...after].map((f) => f.field)),
    ];

    const lines = fields
      .map((field) => ({
        field,
        before: before.find((f) => f.field === field)?.value ?? "—",
        after: after.find((f) => f.field === field)?.value ?? "—",
      }))
      .filter((l) => l.before !== l.after);

    const hadAnything = before.some((f) => f.value !== "—");
    return {
      section,
      label: SECTION_LABELS[section],
      kind: lines.length === 0 ? "same" : hadAnything ? "change" : "add",
      lines,
    };
  });
}

/** True when a proposal would change nothing that is already recorded. */
export function isNoOp(diffs: SectionDiff[]): boolean {
  return diffs.every((d) => d.kind === "same");
}

// ---------------------------------------------------------------------------
// Reimport
// ---------------------------------------------------------------------------

export interface ReimportResult {
  records: ImportRecord[];
  /** Ids of records that were superseded by the incoming batch. */
  superseded: string[];
  /** Names skipped because the wiki revision hasn't moved. */
  unchanged: string[];
}

/**
 * Merges freshly fetched proposals into the staging list.
 *
 * A record for the same creature at the same revision is left alone — that is
 * what stops a reimport from resetting a reviewer's decisions. A newer
 * revision supersedes the old proposal rather than replacing it silently, so
 * the previous review stays visible.
 */
export function mergeReimport(
  existing: ImportRecord[],
  incoming: ImportRecord[],
): ReimportResult {
  const records = [...existing];
  const superseded: string[] = [];
  const unchanged: string[] = [];

  for (const fresh of incoming) {
    const priorForCreature = records.filter(
      (r) =>
        r.creatureName.toLowerCase() === fresh.creatureName.toLowerCase() &&
        r.status !== "superseded",
    );
    const sameRevision = priorForCreature.find(
      (r) => r.source.revisionId === fresh.source.revisionId,
    );
    if (sameRevision) {
      unchanged.push(fresh.creatureName);
      continue;
    }
    for (const prior of priorForCreature) {
      const i = records.indexOf(prior);
      records[i] = { ...prior, status: "superseded" };
      superseded.push(prior.id);
    }
    records.push(fresh);
  }
  return { records, superseded, unchanged };
}

/** Counts by status, for the review screen header. */
export function importCounts(records: ImportRecord[]): Record<ImportStatus, number> {
  const counts: Record<ImportStatus, number> = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    superseded: 0,
  };
  for (const r of records) counts[r.status]++;
  return counts;
}
