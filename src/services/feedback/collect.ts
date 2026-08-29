import { isTauri } from "../ipc";
import { STUDIO_VERSION } from "../../model/studio";
import { CURRENT_PROJECT_SCHEMA, PROJECT_FORMAT } from "../../model/manifest";
import {
  buildDiagnostics,
  pageNameFor,
  routePattern,
  type DiagnosticsInput,
} from "../../model/feedback/diagnostics";
import { sanitizedLogs } from "../../model/feedback/log";
import { looksUnsafeToPublish } from "../../model/feedback/targets";
import { ProjectDiagnosticsSchema } from "../../model/feedback/types";
import type {
  DiagnosticChoices,
  FeedbackDiagnostics,
  FeedbackTargetSnapshot,
  ProjectDiagnostics,
} from "../../model/feedback/types";

/**
 * The one place that reads live application state for a report.
 *
 * Everything it produces is a count, a version, or a fact about the machine's
 * browser. It never touches a credential store, never reads a file, and never
 * copies anything an administrator typed - the closest it comes is the number
 * of rules a project has.
 *
 * Keeping the reading here and the *rules* in `model/feedback/diagnostics.ts`
 * is what makes the rules testable. This module is the thin, untestable half:
 * it knows about stores and `navigator`, and it does no filtering of its own.
 */

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

interface UserAgentData {
  platform?: string;
  getHighEntropyValues?(hints: string[]): Promise<{
    platform?: string;
    platformVersion?: string;
    architecture?: string;
    bitness?: string;
  }>;
}

/**
 * Windows reports itself as `10.0` forever, so the user agent alone cannot
 * tell 10 from 11.
 *
 * Chromium's high-entropy `platformVersion` can: it reports the build family,
 * and 13 or above is Windows 11. Worth the extra call, because "Windows 10 or
 * 11" is exactly the distinction a rendering bug usually turns on.
 */
function windowsName(platformVersion: string): string {
  const major = Number.parseInt(platformVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major)) return "Windows";
  return major >= 13 ? "Windows 11" : "Windows 10";
}

/** The engine rendering the app, which is what a layout bug is really about. */
function webviewOf(userAgent: string): string {
  const edge = /Edg\/([\d.]+)/.exec(userAgent);
  if (edge) return `WebView2 ${edge[1]}`;
  const chrome = /Chrome\/([\d.]+)/.exec(userAgent);
  if (chrome) return `Chromium ${chrome[1]}`;
  const webkit = /Version\/([\d.]+).*Safari/.exec(userAgent);
  if (webkit) return `WebKit ${webkit[1]}`;
  const gecko = /Firefox\/([\d.]+)/.exec(userAgent);
  if (gecko) return `Gecko ${gecko[1]}`;
  return "";
}

/** Falls back to the user agent when the high-entropy hints are unavailable. */
function osFromUserAgent(userAgent: string): { os: string; osVersion: string } {
  if (/Windows NT 10/.test(userAgent)) return { os: "Windows", osVersion: "10 or 11" };
  if (/Windows/.test(userAgent)) return { os: "Windows", osVersion: "" };
  const mac = /Mac OS X ([\d_]+)/.exec(userAgent);
  if (mac) return { os: "macOS", osVersion: mac[1].replace(/_/g, ".") };
  if (/Linux/.test(userAgent)) return { os: "Linux", osVersion: "" };
  return { os: "", osVersion: "" };
}

export interface EnvironmentFacts {
  os: string;
  osVersion: string;
  architecture: string;
  webview: string;
  viewport: string;
}

/**
 * What the browser will say about itself.
 *
 * Asynchronous because the accurate Windows version is only available through
 * a promise. It resolves quickly and the result is cached for the session, so
 * opening the feedback form does not wait on it twice.
 */
let cachedEnvironment: EnvironmentFacts | null = null;

export async function collectEnvironment(): Promise<EnvironmentFacts> {
  if (cachedEnvironment) return { ...cachedEnvironment, viewport: viewportSize() };

  const navigatorRef =
    typeof navigator === "undefined" ? null : (navigator as Navigator & { userAgentData?: UserAgentData });
  const userAgent = navigatorRef?.userAgent ?? "";
  let os = "";
  let osVersion = "";
  let architecture = "";

  const hints = navigatorRef?.userAgentData;
  if (hints?.getHighEntropyValues) {
    try {
      const values = await hints.getHighEntropyValues([
        "platformVersion",
        "architecture",
        "bitness",
      ]);
      const platform = hints.platform ?? values.platform ?? "";
      if (platform === "Windows") {
        os = windowsName(values.platformVersion ?? "");
        osVersion = values.platformVersion ?? "";
      } else if (platform) {
        os = platform;
        osVersion = values.platformVersion ?? "";
      }
      architecture = [values.architecture, values.bitness ? `${values.bitness}-bit` : ""]
        .filter(Boolean)
        .join(" ");
    } catch {
      // Not supported, or refused. The user agent still answers, less precisely.
    }
  }
  if (!os) {
    const fallback = osFromUserAgent(userAgent);
    os = fallback.os;
    osVersion = fallback.osVersion;
  }

  cachedEnvironment = {
    os,
    osVersion,
    architecture,
    webview: webviewOf(userAgent),
    viewport: viewportSize(),
  };
  return cachedEnvironment;
}

function viewportSize(): string {
  if (typeof window === "undefined") return "";
  return `${window.innerWidth}x${window.innerHeight}`;
}

// ---------------------------------------------------------------------------
// The project
// ---------------------------------------------------------------------------

/**
 * The shape of the open project, with none of its content.
 *
 * Counts and version numbers. Not the project's name, not the cluster's name,
 * not a repository, not a path, not one creature. Anybody reading this
 * function should be able to see at a glance that there is nothing here to
 * leak, which is why it reads specific fields rather than mapping over the
 * stores.
 */
export async function collectProject(): Promise<ProjectDiagnostics | null> {
  // Imported here rather than at the top of the file, and the reason is the
  // launch time this project spent real effort on. The Feedback Center is
  // mounted eagerly - the shortcut and the right-click menu have to work
  // before anything is open - and a static import would drag the project and
  // draft stores, and everything they touch, into the first script the window
  // has to evaluate. Nothing needs them until somebody actually opts into
  // sending project shape.
  const [{ useProjectStore }, { useDraftsStore }] = await Promise.all([
    import("../../stores/projectStore"),
    import("../../stores/draftsStore"),
  ]);

  const project = useProjectStore.getState();
  if (!project.settings) return null;

  const drafts = useDraftsStore.getState();
  const sources = drafts.catalog.sources ?? [];
  const creatureCount =
    sources.reduce((total, source) => total + (source.creatures?.length ?? 0), 0) +
    (drafts.catalog.official?.creatures?.length ?? 0);
  const itemCount =
    sources.reduce((total, source) => total + (source.items?.length ?? 0), 0) +
    (drafts.catalog.official?.items?.length ?? 0);

  return ProjectDiagnosticsSchema.parse({
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    projectFormat: PROJECT_FORMAT,
    ruleCount: drafts.production.rules.length,
    creatureCount,
    itemCount,
    mapCount: project.settings.maps.length,
    sourceCount: sources.length,
    // Package identity and version only. A package id names a published
    // content pack rather than anything about this cluster - but a locally
    // built one is named by whoever built it, so the ids go through the same
    // guard component context does before anything is published.
    packages: (project.settings.packageDependencies ?? [])
      .map((dependency) =>
        dependency.packageId ? `${dependency.packageId}@${dependency.version}` : "",
      )
      .filter((entry) => entry && !looksUnsafeToPublish(entry))
      .slice(0, 30),
  });
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Where the app is, as a pattern rather than as somebody's rule id. */
export function currentRoute(): { route: string; page: string } {
  if (typeof window === "undefined") return { route: "", page: "" };
  // The app uses a hash router, so the path is after the `#`.
  const hash = window.location.hash.replace(/^#/, "") || "/";
  return { route: routePattern(hash), page: pageNameFor(hash) };
}

/**
 * The full bundle for a report.
 *
 * Assembled fresh every time the diagnostics panel is opened or a report is
 * sent, so what the reporter reviewed is what gets sent - a bundle captured
 * when the form opened would go stale the moment they navigated to reproduce
 * the problem.
 */
export async function collectDiagnostics(
  target: FeedbackTargetSnapshot | null,
  choices: DiagnosticChoices,
  logLimit: number,
): Promise<FeedbackDiagnostics> {
  const environment = await collectEnvironment();
  const { route, page } = currentRoute();

  const input: DiagnosticsInput = {
    appVersion: STUDIO_VERSION,
    runtime: isTauri ? "desktop" : "browser",
    ...environment,
    route,
    page,
    target,
    project: await collectProject(),
    logs: sanitizedLogs(logLimit),
  };
  return buildDiagnostics(input, choices, logLimit);
}
