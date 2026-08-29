import type { BugSeverity, FeedbackType } from "./types";

/**
 * How a report becomes a set of GitHub labels.
 *
 * Labels are the only part of an issue that is machine-readable without
 * parsing prose, so they carry exactly the four things triage sorts by: what
 * kind of report it is, which part of the app it concerns, how badly it hurt,
 * and whether a human has looked at it yet.
 *
 * Nothing here fails when a label is missing from the repository. A label that
 * does not exist is dropped by the service and the issue is still filed -
 * losing a report because somebody renamed a label would be a poor trade.
 */

/** The label naming the kind of report. */
export const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "bug",
  suggestion: "suggestion",
  feature_request: "feature-request",
};

/** Marks issues the app filed, as opposed to ones typed into GitHub. */
export const SOURCE_LABEL = "source:in-app";

/** Every new report starts here. See `status.ts` for how it reads to a user. */
export const TRIAGE_LABEL = "needs-triage";

export function areaLabelFor(area: string): string {
  return area ? `area:${area}` : "";
}

/**
 * Severity is labelled only for bugs.
 *
 * A "blocking" feature request is a contradiction, and a severity label on one
 * would sort it into a queue it does not belong in.
 */
export function severityLabelFor(severity: BugSeverity | null): string {
  return severity ? `severity:${severity}` : "";
}

/**
 * The labels for a report, in a stable order.
 *
 * Deduplicated and ordered so two identical reports always produce the same
 * list - which is what lets a test assert on it, and what stops a diff between
 * two issues showing a difference that is only ordering.
 */
export function labelsForReport(report: {
  type: FeedbackType;
  severity?: BugSeverity | null;
  target?: { area?: string } | null;
}): string[] {
  const labels = [
    TYPE_LABELS[report.type],
    SOURCE_LABEL,
    TRIAGE_LABEL,
    areaLabelFor(report.target?.area ?? ""),
    report.type === "bug" ? severityLabelFor(report.severity ?? null) : "",
  ].filter(Boolean);
  return [...new Set(labels)];
}

// ---------------------------------------------------------------------------
// The labels the repository is expected to have
// ---------------------------------------------------------------------------

export interface LabelDefinition {
  name: string;
  /** Six hex digits, no leading hash - the form the GitHub API takes. */
  color: string;
  description: string;
}

/**
 * Every label this system emits or reads, with the colours the setup script
 * creates them in.
 *
 * Kept here rather than in the documentation so the list can be asserted
 * against what `labelsForReport` and `status.ts` actually produce - a
 * documented label that nothing emits, or an emitted label nobody documented,
 * are both bugs this table makes visible.
 */
export const MANAGED_LABELS: readonly LabelDefinition[] = [
  { name: "bug", color: "d73a4a", description: "Something is not working" },
  {
    name: "suggestion",
    color: "0e8a16",
    description: "An improvement to something that already exists",
  },
  {
    name: "feature-request",
    color: "1d76db",
    description: "Something DinoDepot Studio cannot do yet",
  },
  {
    name: SOURCE_LABEL,
    color: "5319e7",
    description: "Filed from inside DinoDepot Studio",
  },
  {
    name: TRIAGE_LABEL,
    color: "fbca04",
    description: "Not yet looked at",
  },
  { name: "confirmed", color: "b60205", description: "Reproduced" },
  { name: "in-progress", color: "0052cc", description: "Being worked on" },
  { name: "planned", color: "c2e0c6", description: "Accepted, not started" },
  { name: "fixed", color: "0e8a16", description: "Fixed in a release" },
  { name: "wont-fix", color: "ffffff", description: "Deliberately not changing" },
  { name: "duplicate", color: "cfd3d7", description: "Already reported" },
  ...(
    [
      ["app", "Application"],
      ["overview", "Overview"],
      ["production-rules", "Production Rules"],
      ["passive-production", "Passive Production Simulator"],
      ["content-sources", "Content Sources"],
      ["spawn-commands", "Spawn Commands"],
      ["creature-remaps", "Creature Remaps"],
      ["curseforge", "CurseForge"],
      ["publishing", "Publishing"],
      ["settings", "Settings"],
      ["github", "GitHub"],
      ["player-data", "Player Data"],
      ["project-home", "Welcome screen"],
      ["feedback", "The Feedback Center itself"],
    ] as const
  ).map(([slug, label]) => ({
    name: `area:${slug}`,
    color: "bfd4f2",
    description: label,
  })),
  ...(
    [
      ["minor", "Cosmetic, or easy to work around"],
      ["moderate", "Gets in the way"],
      ["major", "A part of the app is unusable"],
      ["blocking", "Cannot carry on working"],
    ] as const
  ).map(([slug, description]) => ({
    name: `severity:${slug}`,
    color: "e99695",
    description,
  })),
] as const;

/** `gh label create` lines, for the one-time repository setup. */
export function labelSetupCommands(slug: string): string[] {
  return MANAGED_LABELS.map(
    (label) =>
      `gh label create "${label.name}" --repo ${slug} --color ${label.color} --description "${label.description}" --force`,
  );
}
