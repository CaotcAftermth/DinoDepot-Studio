import { describe, expect, it } from "vitest";
import {
  EXCLUDED_ROWS,
  buildDiagnostics,
  describeProject,
  includedRows,
  pageNameFor,
  routePattern,
  type DiagnosticsInput,
} from "./diagnostics";
import { defaultDiagnosticChoices } from "./types";

/**
 * The allowlist, checked as an allowlist.
 *
 * The tests that matter here are the negative ones: a field nobody wrote a
 * line for must not appear in the output, whatever is put into the input. That
 * is the property that makes this design different from collecting everything
 * and redacting afterwards.
 */

const FULL: DiagnosticsInput = {
  appVersion: "0.6.0",
  runtime: "desktop",
  os: "Windows 11",
  osVersion: "10.0.26200",
  architecture: "x86 64-bit",
  webview: "WebView2 131.0.2903.86",
  viewport: "1440x900",
  route: "/production/:id",
  page: "Production Rules",
  target: {
    id: "production-rule-cycle-quantity",
    name: "Production Cycle Quantity",
    area: "production-rules",
    hierarchy: ["Production Rules", "Production Cycle Quantity"],
    context: { field: "quantity" },
  },
  project: {
    schemaVersion: 3,
    projectFormat: "dinodepot.project",
    ruleCount: 12,
    creatureCount: 640,
    itemCount: 310,
    mapCount: 6,
    sourceCount: 4,
    packages: ["official-asa@1.3.0"],
  },
  logs: [
    { at: "2026-08-22T09:00:00Z", level: "error", scope: "sync", message: "no", code: "" },
  ],
};

const ALL_ON = { app: true, component: true, logs: true, project: true };

describe("buildDiagnostics", () => {
  it("carries only the fields this module names", () => {
    const extra = { ...FULL, projectName: "GG Fizz", githubToken: "ghp_x" };
    const built = buildDiagnostics(extra as DiagnosticsInput, ALL_ON, 50);
    const blob = JSON.stringify(built);
    expect(blob).not.toContain("GG Fizz");
    expect(blob).not.toContain("ghp_");
    expect(blob).not.toContain("projectName");
  });

  it("always says which build the report came from", () => {
    const built = buildDiagnostics(FULL, {
      app: false,
      component: false,
      logs: false,
      project: false,
    }, 50);
    expect(built.app.version).toBe("0.6.0");
    expect(built.environment.os).toBe("");
    expect(built.navigation.route).toBe("");
    expect(built.component).toBeNull();
    expect(built.project).toBeNull();
    expect(built.logs).toEqual([]);
  });

  /**
   * The category that describes the administrator's own work, rather than the
   * application, must not be on unless it was switched on.
   */
  it("leaves the project out by default", () => {
    const built = buildDiagnostics(FULL, defaultDiagnosticChoices(), 50);
    expect(built.project).toBeNull();
    expect(built.environment.os).toBe("Windows 11");
    expect(built.component?.id).toBe("production-rule-cycle-quantity");
  });

  it("honours the log limit", () => {
    const many = {
      ...FULL,
      logs: Array.from({ length: 80 }, (_, index) => ({
        at: "",
        level: "info" as const,
        scope: "x",
        message: `n${index}`,
        code: "",
      })),
    };
    const built = buildDiagnostics(many, ALL_ON, 25);
    expect(built.logs.length).toBe(25);
    expect(built.logs[24].message).toBe("n79");
  });

  it("produces a valid bundle from nothing at all", () => {
    const built = buildDiagnostics({}, ALL_ON, 50);
    expect(built.app.version).toBe("");
    expect(built.logs).toEqual([]);
  });
});

describe("the review screen", () => {
  it("shows the value, not just the category name", () => {
    const rows = includedRows(buildDiagnostics(FULL, ALL_ON, 50));
    const os = rows.find((row) => row.key === "os");
    expect(os?.detail).toBe("Windows 11 10.0.26200 x86 64-bit");
    const component = rows.find((row) => row.key === "component");
    expect(component?.detail).toContain("production-rule-cycle-quantity");
  });

  it("lists nothing for a category that was switched off", () => {
    const rows = includedRows(
      buildDiagnostics(FULL, { ...ALL_ON, project: false, logs: false }, 50),
    );
    expect(rows.map((row) => row.key)).not.toContain("project");
    expect(rows.map((row) => row.key)).not.toContain("logs");
  });

  it("states what is never included", () => {
    const labels = EXCLUDED_ROWS.map((row) => row.label.toLowerCase()).join(" ");
    expect(labels).toContain("credential");
    expect(labels).toContain("project data");
  });

  it("describes a project by shape and never by name", () => {
    const description = describeProject(FULL.project!);
    expect(description).toContain("12 rules");
    expect(description).toContain("schema v3");
    expect(description).toContain("official-asa@1.3.0");
  });
});

describe("routePattern", () => {
  it("replaces anything identifying with a parameter", () => {
    expect(routePattern("/production/8f3c1e2a-4b5d-4c6e-9a0b-1234567890ab")).toBe(
      "/production/:id",
    );
    expect(routePattern("/overview")).toBe("/overview");
    expect(routePattern("/")).toBe("/");
  });

  /** Settings categories are an enum, and which one is exactly what a report needs. */
  it("keeps the settings category, which is not user data", () => {
    expect(routePattern("/settings/github")).toBe("/settings/github");
    expect(routePattern("/settings/feedback")).toBe("/settings/feedback");
  });

  it("copes with a hash route and a query string", () => {
    expect(routePattern("#/production/abc")).toBe("/production/:id");
    expect(routePattern("/content?tab=2")).toBe("/content");
  });

  it("names the page a route belongs to", () => {
    expect(pageNameFor("/production/abc")).toBe("Production Rules");
    expect(pageNameFor("/settings/github")).toBe("Settings");
    expect(pageNameFor("/")).toBe("Welcome");
    expect(pageNameFor("/nowhere")).toBe("");
  });
});
