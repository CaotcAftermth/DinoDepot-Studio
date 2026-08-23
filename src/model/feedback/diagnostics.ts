import {
  FeedbackDiagnosticsSchema,
  type DiagnosticChoices,
  type FeedbackDiagnostics,
  type FeedbackTargetSnapshot,
  type ProjectDiagnostics,
  type SanitizedLogEntry,
} from "./types";

/**
 * What a report is allowed to say about the machine it came from.
 *
 * This module is an allowlist, and the distinction matters more than it looks.
 * The other way round — gather everything, then try to redact it — fails the
 * first time somebody adds a field, because the redactor does not know about
 * the field that was added yesterday. Here, a fact that nobody wrote a line
 * for simply is not collected, and adding one is a deliberate edit to a file
 * whose whole subject is what may be published.
 *
 * Nothing here reads a credential store, a project file, or the filesystem.
 * The inputs are supplied by the caller, which is what makes the rules
 * testable without a running application.
 */

/**
 * The raw facts a diagnostics bundle may be built from.
 *
 * Every field is optional because the app can be asked for feedback before it
 * knows most of them — from the welcome screen, there is no project, no route
 * inside the shell, and no component.
 */
export interface DiagnosticsInput {
  appVersion?: string;
  runtime?: "desktop" | "browser";
  os?: string;
  osVersion?: string;
  architecture?: string;
  webview?: string;
  viewport?: string;
  route?: string;
  page?: string;
  target?: FeedbackTargetSnapshot | null;
  project?: ProjectDiagnostics | null;
  logs?: SanitizedLogEntry[];
}

/**
 * Assembles the bundle, honouring what the administrator switched off.
 *
 * A switched-off category is *absent*, not blanked: an empty object still
 * announces that the app tried to collect something, and a reader of the issue
 * should be able to tell "they declined to send logs" from "there were no
 * logs".
 *
 * The application version and runtime are the one thing always included. A
 * report that does not say which build it came from cannot be acted on at all,
 * and it says nothing about the person who sent it.
 */
export function buildDiagnostics(
  input: DiagnosticsInput,
  choices: DiagnosticChoices,
  logLimit: number,
): FeedbackDiagnostics {
  const environment = choices.app
    ? {
        os: input.os ?? "",
        osVersion: input.osVersion ?? "",
        architecture: input.architecture ?? "",
        webview: input.webview ?? "",
        viewport: input.viewport ?? "",
      }
    : {};

  const navigation = choices.component
    ? { route: input.route ?? "", page: input.page ?? "" }
    : {};

  return FeedbackDiagnosticsSchema.parse({
    app: {
      version: input.appVersion ?? "",
      runtime: input.runtime ?? "desktop",
    },
    environment,
    navigation,
    component: choices.component ? (input.target ?? null) : null,
    project: choices.project ? (input.project ?? null) : null,
    logs: choices.logs ? (input.logs ?? []).slice(-Math.max(0, logLimit)) : [],
  });
}

// ---------------------------------------------------------------------------
// The review screen
// ---------------------------------------------------------------------------

export interface DiagnosticRow {
  /** Stable key, for React and for tests. */
  key: string;
  label: string;
  /** The actual value being sent, so review means review and not reassurance. */
  detail: string;
}

/**
 * What the diagnostics review lists as included.
 *
 * Every row carries the value, not just the category name. A review screen
 * that says "✓ Operating system" without saying which one is asking somebody
 * to consent to a description rather than to the thing itself.
 */
export function includedRows(diagnostics: FeedbackDiagnostics): DiagnosticRow[] {
  const rows: DiagnosticRow[] = [
    {
      key: "version",
      label: "DinoDepot Studio version",
      detail: diagnostics.app.version || "unknown",
    },
  ];

  const env = diagnostics.environment;
  if (env.os) {
    rows.push({
      key: "os",
      label: "Operating system",
      detail: [env.os, env.osVersion, env.architecture].filter(Boolean).join(" "),
    });
  }
  if (env.webview) {
    rows.push({ key: "webview", label: "Webview", detail: env.webview });
  }
  if (env.viewport) {
    rows.push({ key: "viewport", label: "Window size", detail: env.viewport });
  }
  if (diagnostics.navigation.route) {
    rows.push({
      key: "route",
      label: "Current page",
      detail: diagnostics.navigation.page
        ? `${diagnostics.navigation.page} (${diagnostics.navigation.route})`
        : diagnostics.navigation.route,
    });
  }
  if (diagnostics.component) {
    rows.push({
      key: "component",
      label: "Selected component",
      detail: `${diagnostics.component.name} (${diagnostics.component.id})`,
    });
    const context = Object.entries(diagnostics.component.context);
    if (context.length > 0) {
      rows.push({
        key: "context",
        label: "Component context",
        detail: context.map(([key, value]) => `${key}: ${value}`).join(", "),
      });
    }
  }
  if (diagnostics.project) {
    rows.push({
      key: "project",
      label: "Project shape",
      detail: describeProject(diagnostics.project),
    });
  }
  if (diagnostics.logs.length > 0) {
    rows.push({
      key: "logs",
      label: `Recent application events (${diagnostics.logs.length})`,
      detail: "Sanitized — file paths, credentials and email addresses removed",
    });
  }
  return rows;
}

/**
 * What is never sent, stated as plainly as what is.
 *
 * This list is a promise, so it says only what the implementation actually
 * guarantees. Credentials cannot be in a report because the frontend has no
 * command that returns one. Project content cannot be, because nothing here
 * reads a draft. Both of those are structural, and both are asserted in
 * `diagnostics.test.ts`.
 */
export const EXCLUDED_ROWS: readonly DiagnosticRow[] = [
  {
    key: "no-credentials",
    label: "GitHub token or any other credential",
    detail: "The app has no way to read one — there is no command that returns a secret",
  },
  {
    key: "no-project-data",
    label: "Project data",
    detail: "No rule, creature, item, player or cluster name is ever collected",
  },
  {
    key: "no-paths",
    label: "File paths",
    detail: "Removed from every log line before it can be attached",
  },
  {
    key: "no-identity",
    label: "Your name, email address or account",
    detail: "The installation id is random and is not derived from this machine",
  },
] as const;

/** The project row's wording. Counts and versions, never a name. */
export function describeProject(project: ProjectDiagnostics): string {
  const parts = [
    `schema v${project.schemaVersion}`,
    `${project.ruleCount} rules`,
    `${project.creatureCount} creatures`,
    `${project.itemCount} items`,
    `${project.mapCount} maps`,
    `${project.sourceCount} sources`,
  ];
  if (project.packages.length > 0) {
    parts.push(project.packages.join(", "));
  }
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Segments that are part of the app's structure rather than somebody's data.
 *
 * A route is only useful in a report if it says which screen was open, and
 * `/production/8f3c-…` says that plus the id of a rule in somebody's cluster.
 * Known segments survive; anything else becomes a parameter.
 */
const KNOWN_SEGMENTS: ReadonlySet<string> = new Set([
  "overview",
  "production",
  "simulator",
  "content",
  "remaps",
  "curseforge",
  "publish",
  "settings",
  "players",
  // Settings category slugs, which are an enum rather than user data and are
  // exactly what a Settings bug report needs to name.
  "project",
  "github",
  "publishing",
  "defaults",
  "discord",
  "feedback",
]);

/**
 * The route with anything identifying replaced by a parameter name.
 *
 * `/production/8f3c…` becomes `/production/:id`. The point is that two reports
 * about the same screen read as the same screen, which is also what makes
 * duplicate detection work at all.
 */
export function routePattern(pathname: string): string {
  const clean = (pathname || "/").split("?")[0].split("#").pop() ?? "/";
  const segments = clean.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  const mapped = segments.map((segment) =>
    KNOWN_SEGMENTS.has(segment.toLowerCase()) ? segment.toLowerCase() : ":id",
  );
  return `/${mapped.join("/")}`;
}

/** The friendly page name for a route, for the diagnostics summary. */
const PAGE_NAMES: Record<string, string> = {
  "/": "Welcome",
  "/overview": "Overview",
  "/production": "Production Rules",
  "/simulator": "Simulator",
  "/content": "Content Sources",
  "/remaps": "Creature Remaps",
  "/curseforge": "CurseForge",
  "/publish": "Publish",
  "/settings": "Settings",
  "/players": "Player Data",
};

export function pageNameFor(pathname: string): string {
  const pattern = routePattern(pathname);
  if (PAGE_NAMES[pattern]) return PAGE_NAMES[pattern];
  // A route with a parameter still belongs to its parent page.
  const parent = `/${pattern.split("/").filter(Boolean)[0] ?? ""}`;
  return PAGE_NAMES[parent] ?? "";
}
