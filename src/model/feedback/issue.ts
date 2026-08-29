import { targetBreadcrumb } from "./resolveTarget";
import { areaLabel } from "./targets";
import { SEVERITY_LABELS } from "./types";
import type {
  FeedbackDiagnostics,
  FeedbackReport,
  FeedbackTargetSnapshot,
  FeedbackType,
} from "./types";

/**
 * Turning a report into the GitHub issue a maintainer reads.
 *
 * This module is shared by the desktop app and the feedback service on
 * purpose. The service is what actually files the issue, but the app has to be
 * able to produce the same thing when the service cannot be reached - and two
 * separate formatters would drift apart within a release, leaving reports that
 * look different depending on whether the network was up.
 *
 * It imports no runtime dependency of its own, so the service can bundle it
 * without pulling the application in behind it. Everything from `types.ts` is
 * imported as a type and erased.
 *
 * ## Written for two readers
 *
 * A person triaging, and a coding agent asked to fix the issue later. Both
 * want the same things and want them in fixed places: which area, which
 * component id, what was expected, what happened, which build. The section
 * order never varies, so "the component id is under Affected Area" is
 * something either reader can rely on.
 */

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TITLE_PREFIX: Record<FeedbackType, string> = {
  bug: "[Bug]",
  suggestion: "[Suggestion]",
  feature_request: "[Feature]",
};

/** GitHub's own limit is 256; this leaves room for the prefix and an ellipsis. */
export const MAX_TITLE = 160;

/**
 * The issue title.
 *
 * A prefix and the reporter's own words - never an id. An id in a title makes
 * the issue list unreadable and tells a human nothing they cannot get by
 * opening it, and the id is a label and a body field already.
 */
export function issueTitle(report: {
  type: FeedbackType;
  title: string;
  description?: string;
}): string {
  const prefix = TITLE_PREFIX[report.type];
  // Local records use the finished issue title as their display title. When
  // one becomes a report (including the GitHub-only fallback), that title can
  // therefore already carry a kind prefix. Normalize every known prefix away
  // before adding the authoritative one for this report type.
  const written = stripTitlePrefix(oneLine(report.title)) || firstSentence(report.description ?? "");
  const room = MAX_TITLE - prefix.length - 1;
  const body = written.length > room ? `${written.slice(0, room - 1).trimEnd()}…` : written;
  return `${prefix} ${body || "Report from DinoDepot Studio"}`;
}

function stripTitlePrefix(title: string): string {
  return title.replace(/^\[(?:Bug|Suggestion|Feature)\]\s*/i, "").trim();
}

function oneLine(text: string): string {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** The first sentence of a description, for a report that was never titled. */
function firstSentence(text: string): string {
  const flat = oneLine(text);
  const stop = flat.search(/[.!?](\s|$)/);
  const candidate = stop > 0 ? flat.slice(0, stop) : flat;
  return candidate.length > 100 ? `${candidate.slice(0, 99).trimEnd()}…` : candidate;
}

// ---------------------------------------------------------------------------
// The machine-readable marker
// ---------------------------------------------------------------------------

const MARKER_PREFIX = "dinodepot-report-id:";

/**
 * The line that lets the service recognise an issue it has already filed.
 *
 * This is how a retry after a timeout does not produce a second issue: the
 * service looks for this marker before creating anything, so the report id the
 * client generated once is the idempotency key whether or not any storage
 * survived in between.
 *
 * Written by the service, never by the client - and any marker-shaped text in
 * the reporter's own words is neutralized by {@link escapeUserText} before it
 * gets near the body, so a report cannot claim to be one that already exists.
 */
export function reportMarker(reportId: string): string {
  return `<!-- ${MARKER_PREFIX} ${reportId} -->`;
}

/** Reads the marker back out of an issue body. Null when there is none. */
export function findReportMarker(body: string): string | null {
  const match = new RegExp(`<!--\\s*${MARKER_PREFIX}\\s*([A-Za-z0-9_-]{8,80})\\s*-->`).exec(
    body ?? "",
  );
  return match ? match[1] : null;
}

/** The search term that finds an issue by report id. */
export function markerSearchTerm(reportId: string): string {
  return `${MARKER_PREFIX} ${reportId}`;
}

// ---------------------------------------------------------------------------
// User text
// ---------------------------------------------------------------------------

/** Ceiling per section, so one pasted log cannot become the whole issue. */
export const MAX_SECTION = 8000;

/**
 * Makes a block of reporter-written text safe to drop into generated Markdown.
 *
 * The reporter may absolutely use Markdown - lists, emphasis, code spans are
 * all how somebody explains a bug. What they may not do, even by accident, is
 * change the *structure* around their text. Three things can:
 *
 * - an HTML comment, which is what the report marker is;
 * - a `<details>` tag, which is what the diagnostics block is;
 * - an unclosed code fence, which would swallow every section after it.
 *
 * The first two are escaped into their visible equivalents, so the reporter
 * still sees what they typed. The third is balanced by appending the closing
 * fence they left off, which is also what they meant.
 */
export function escapeUserText(text: string, limit = MAX_SECTION): string {
  let out = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, limit);

  out = out
    .replace(/<!--/g, "&lt;!--")
    .replace(/-->/g, "--&gt;")
    .replace(/<\/?details(\s|>)/gi, (match) => `&lt;${match.slice(1)}`)
    .replace(/<\/?summary(\s|>)/gi, (match) => `&lt;${match.slice(1)}`);

  // An odd number of fences means one was opened and never closed.
  const fences = out.match(/^```/gm)?.length ?? 0;
  if (fences % 2 === 1) out += "\n```";

  return out;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

/** The heading each type gives its main description field. */
const DESCRIPTION_HEADING: Record<FeedbackType, string> = {
  bug: "What happened",
  suggestion: "What could be improved",
  feature_request: "What it should be able to do",
};

/** The heading each type gives its second field, when it uses one. */
const BENEFIT_HEADING: Record<FeedbackType, string> = {
  bug: "",
  suggestion: "How it could be improved",
  feature_request: "Why this would be useful",
};

export interface IssueBodyOptions {
  /** Include the report marker. The service sets this; the app does not. */
  marker?: boolean;
  /** Leave the diagnostics block out, for the length-limited browser fallback. */
  omitDiagnostics?: boolean;
}

/**
 * The full issue body.
 *
 * Sections appear in a fixed order and a section with nothing in it is left
 * out entirely, rather than printed with "N/A" under it. An empty heading is
 * noise for a human and a false negative for anything reading the issue
 * automatically.
 */
export function issueBody(
  report: FeedbackReport,
  options: IssueBodyOptions = {},
): string {
  const parts: string[] = [];
  if (options.marker) parts.push(reportMarker(report.id));

  parts.push(section(DESCRIPTION_HEADING[report.type], escapeUserText(report.description)));

  if (report.type === "bug") {
    parts.push(section("Expected behaviour", escapeUserText(report.expectedBehavior)));
    parts.push(section("Steps to reproduce", escapeUserText(report.reproductionSteps)));
  } else {
    parts.push(section(BENEFIT_HEADING[report.type], escapeUserText(report.benefit)));
  }

  parts.push(affectedAreaSection(report.target, report.diagnostics));

  if (report.type === "bug" && report.severity) {
    parts.push(section("Severity", SEVERITY_LABELS[report.severity]));
  }

  parts.push(section("Environment", environmentList(report)));
  parts.push(attachmentsSection(report));
  if (!options.omitDiagnostics) parts.push(diagnosticsSection(report.diagnostics));
  parts.push(footer(report));

  return parts.filter(Boolean).join("\n\n");
}

function section(heading: string, body: string): string {
  if (!heading || !body.trim()) return "";
  return `## ${heading}\n\n${body.trim()}`;
}

/**
 * Where the problem is, in the three forms different readers need.
 *
 * The friendly trail is for a person, the component id is for a grep, and the
 * area is what the label was chosen from. All three, because a maintainer
 * reading on a phone wants the first and an agent asked to fix it wants the
 * second.
 */
function affectedAreaSection(
  target: FeedbackTargetSnapshot | null,
  diagnostics: FeedbackDiagnostics,
): string {
  const lines: string[] = [];
  const route = diagnostics.navigation.route;
  const page = diagnostics.navigation.page;

  if (target) {
    const area = areaLabel(target.area) || target.area;
    if (area) lines.push(`- **Area:** ${area}`);
    lines.push(`- **Component:** ${targetBreadcrumb(target)}`);
    lines.push(`- **Component ID:** \`${target.id}\``);
  } else if (page || route) {
    lines.push(`- **Area:** ${page || route}`);
    lines.push("- **Component:** not selected");
  }
  if (route) lines.push(`- **Route:** \`${route}\``);

  if (lines.length === 0) return "";

  let body = lines.join("\n");
  const context = Object.entries(target?.context ?? {});
  if (context.length > 0) {
    body += `\n\n**Context**\n\n${context
      .map(([key, value]) => `- ${escapeInline(key)}: ${escapeInline(value)}`)
      .join("\n")}`;
  }
  return section("Affected area", body);
}

/** Context values are short and already sanitized; this only stops them formatting. */
function escapeInline(value: string): string {
  return String(value ?? "").replace(/[`*_[\]<>]/g, (c) => `\\${c}`);
}

function environmentList(report: FeedbackReport): string {
  const { app, environment, project } = report.diagnostics;
  const lines = [`- DinoDepot Studio: \`${app.version || report.appVersion}\``];
  if (app.runtime === "browser") {
    lines.push("- Runtime: browser mock build (not the desktop app)");
  }
  const os = [environment.os, environment.osVersion, environment.architecture]
    .filter(Boolean)
    .join(" ");
  if (os) lines.push(`- OS: ${os}`);
  if (environment.webview) lines.push(`- Webview: ${environment.webview}`);
  if (environment.viewport) lines.push(`- Window: ${environment.viewport}`);
  if (report.diagnostics.navigation.page) {
    lines.push(`- Page: ${report.diagnostics.navigation.page}`);
  }
  if (project) {
    lines.push(`- Project schema: \`v${project.schemaVersion}\``);
    lines.push(
      `- Project size: ${project.ruleCount} rules, ${project.creatureCount} creatures, ${project.itemCount} items, ${project.sourceCount} sources`,
    );
    if (project.packages.length > 0) {
      lines.push(`- Packages: ${project.packages.map((p) => `\`${p}\``).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function attachmentsSection(report: FeedbackReport): string {
  const uploaded = report.attachments.filter((a) => a.url);
  if (uploaded.length === 0) return "";
  return section(
    "Attachments",
    uploaded
      .map((a) => `- [${escapeInline(a.fileName)}](${a.url})`)
      .join("\n"),
  );
}

/**
 * The diagnostics, folded away.
 *
 * Inside `<details>` because it is reference material: the sections above are
 * what gets read, and a wall of JSON at the top of an issue makes the human
 * part of it look like an afterthought.
 */
function diagnosticsSection(diagnostics: FeedbackDiagnostics): string {
  const json = JSON.stringify(diagnostics, null, 2);
  return [
    "<details>",
    "<summary>Diagnostics</summary>",
    "",
    "```json",
    json,
    "```",
    "",
    "</details>",
  ].join("\n");
}

function footer(report: FeedbackReport): string {
  const bits = [
    `Submitted from DinoDepot Studio ${report.appVersion || "unknown"}`,
  ];
  if (report.reporterId) bits.push(`installation \`${report.reporterId}\``);
  if (report.contact) bits.push(`contact @${escapeInline(report.contact)}`);
  return `---\n\n${bits.join(" · ")}`;
}

// ---------------------------------------------------------------------------
// The browser fallback
// ---------------------------------------------------------------------------

/**
 * How much of a prefilled body a URL can carry.
 *
 * Browsers and servers disagree about URL length; 6 KB of body leaves room for
 * the rest of the query and stays well under every limit that matters. A body
 * that is silently truncated by a proxy is worse than one that says it was
 * shortened, so this is enforced here rather than discovered later.
 */
export const MAX_PREFILL_BODY = 6000;

/**
 * A reduced body for the "open a prepared issue" fallback.
 *
 * The diagnostics block is left out entirely. It is the largest part and the
 * one part that would be travelling through a URL - through the browser's
 * history, and through whatever sits between here and GitHub - which is not
 * where a machine description belongs when nobody has to put it there.
 */
export function fallbackIssueBody(report: FeedbackReport): string {
  const body = issueBody(report, { omitDiagnostics: true });
  if (body.length <= MAX_PREFILL_BODY) return body;
  return `${body.slice(0, MAX_PREFILL_BODY - 80).trimEnd()}\n\n_(shortened - the rest was too long to carry in a link)_`;
}

/**
 * A prefilled new-issue URL.
 *
 * Labels are passed as a hint. GitHub applies them only when the person
 * following the link may label issues, so the service remains the only thing
 * that can be relied on to get them right - which is exactly what makes this
 * a fallback rather than an alternative.
 */
export function prefilledIssueUrl(
  newIssueBase: string,
  report: FeedbackReport,
  labels: string[] = [],
): string {
  const params = new URLSearchParams({
    title: issueTitle(report),
    body: fallbackIssueBody(report),
  });
  if (labels.length > 0) params.set("labels", labels.join(","));
  return `${newIssueBase}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Copy debug information
// ---------------------------------------------------------------------------

/**
 * The plain-text summary behind "Copy debug information".
 *
 * Deliberately the same facts the issue's Environment section carries and no
 * more, so pasting this into a chat is never a bigger disclosure than filing a
 * report would have been.
 */
export function debugInfoText(
  diagnostics: FeedbackDiagnostics,
  target: FeedbackTargetSnapshot | null,
): string {
  const lines = [
    `DinoDepot Studio ${diagnostics.app.version || "unknown"}`,
  ];
  const os = [
    diagnostics.environment.os,
    diagnostics.environment.osVersion,
    diagnostics.environment.architecture,
  ]
    .filter(Boolean)
    .join(" ");
  if (os) lines.push(os);
  if (diagnostics.environment.viewport) {
    lines.push(`Window: ${diagnostics.environment.viewport}`);
  }
  if (diagnostics.navigation.route) lines.push(`Route: ${diagnostics.navigation.route}`);
  if (target) {
    const area = areaLabel(target.area) || target.area;
    if (area) lines.push(`Area: ${area}`);
    lines.push(`Component: ${targetBreadcrumb(target)}`);
    lines.push(`Component ID: ${target.id}`);
    for (const [key, value] of Object.entries(target.context)) {
      lines.push(`  ${key}: ${value}`);
    }
  }
  if (diagnostics.project) {
    lines.push(`Project schema: v${diagnostics.project.schemaVersion}`);
  }
  return lines.join("\n");
}
