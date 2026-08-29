import { describe, expect, it } from "vitest";
import {
  MAX_PREFILL_BODY,
  MAX_TITLE,
  debugInfoText,
  escapeUserText,
  fallbackIssueBody,
  findReportMarker,
  issueBody,
  issueTitle,
  markerSearchTerm,
  prefilledIssueUrl,
  reportMarker,
} from "./issue";
import { labelsForReport } from "./labels";
import { FeedbackReportSchema, type FeedbackReport } from "./types";

/**
 * The issue is the deliverable.
 *
 * Two readers have to be able to rely on it: a maintainer triaging, and a
 * coding agent later asked to fix it. Both want the component id, the area,
 * the expected behaviour and the build, always in the same place - so these
 * tests assert on structure as much as on content.
 */

function report(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return FeedbackReportSchema.parse({
    id: "11111111-2222-4333-8444-555555555555",
    type: "bug",
    title: "[Bug] Quantity of zero deletes the creature",
    description: "Setting the quantity to 0 removed the creature from the rule.",
    expectedBehavior: "It should have stayed, with a quantity of 0.",
    reproductionSteps: "1. Open Production Rules\n2. Set Quantity to 0",
    severity: "moderate",
    target: {
      id: "production-rule-cycle-quantity",
      name: "Production Cycle Quantity",
      area: "production-rules",
      hierarchy: ["Production Rules", "Creature Rule", "Production Cycle Quantity"],
      context: { field: "quantity", index: "2" },
    },
    diagnostics: {
      app: { version: "0.6.0", runtime: "desktop" },
      environment: {
        os: "Windows 11",
        osVersion: "10.0.26200",
        architecture: "x86 64-bit",
        webview: "WebView2 131",
        viewport: "1440x900",
      },
      navigation: { route: "/production/:id", page: "Production Rules" },
      component: null,
      project: null,
      logs: [],
    },
    createdAt: "2026-08-22T09:00:00.000Z",
    appVersion: "0.6.0",
    reporterId: "dd-install-abc",
    ...overrides,
  });
}

describe("issueTitle", () => {
  it("prefixes by kind and keeps the reporter's words", () => {
    expect(issueTitle({ type: "bug", title: "Quantity resets" })).toBe(
      "[Bug] Quantity resets",
    );
    expect(issueTitle({ type: "suggestion", title: "Better search" })).toBe(
      "[Suggestion] Better search",
    );
    expect(issueTitle({ type: "feature_request", title: "Spawn presets" })).toBe(
      "[Feature] Spawn presets",
    );
  });

  it("does not duplicate a prefix already carried by a local record", () => {
    expect(issueTitle({ type: "bug", title: "[Bug] Quantity resets" })).toBe(
      "[Bug] Quantity resets",
    );
    expect(
      issueTitle({
        type: "suggestion",
        title: "[Suggestion] Make search clearer",
      }),
    ).toBe("[Suggestion] Make search clearer");
  });

  /** A bug and a suggestion never ask for a title, so one has to be derived. */
  it("falls back to the first sentence when nothing was titled", () => {
    expect(
      issueTitle({
        type: "bug",
        title: "",
        description: "Entering 0 deletes the creature. It also clears the cycle.",
      }),
    ).toBe("[Bug] Entering 0 deletes the creature");
  });

  it("never produces an empty title", () => {
    expect(issueTitle({ type: "bug", title: "", description: "" })).toBe(
      "[Bug] Report from DinoDepot Studio",
    );
  });

  it("stays inside the limit", () => {
    const title = issueTitle({ type: "bug", title: "x".repeat(400) });
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE);
    expect(title.endsWith("…")).toBe(true);
  });

  /** An id in a title makes the issue list unreadable and tells nobody anything. */
  it("keeps the component id out of the title", () => {
    expect(issueTitle(report())).not.toContain("production-rule-cycle-quantity");
  });
});

describe("escapeUserText", () => {
  it("leaves ordinary Markdown alone, because that is how people write", () => {
    const text = "It **breaks** when I:\n\n- set it to `0`\n- press Save";
    expect(escapeUserText(text)).toBe(text);
  });

  /** The report marker is an HTML comment; a forged one would fake an identity. */
  it("neutralizes an HTML comment so the marker cannot be forged", () => {
    const escaped = escapeUserText("<!-- dinodepot-report-id: forged -->");
    expect(escaped).not.toContain("<!--");
    expect(findReportMarker(escaped)).toBeNull();
  });

  it("neutralizes the tags the diagnostics block is built from", () => {
    const escaped = escapeUserText("</details><summary>hi</summary>");
    expect(escaped).not.toContain("</details>");
    expect(escaped).not.toContain("<summary>");
  });

  /** An unclosed fence would swallow every generated section after it. */
  it("closes a code fence the reporter left open", () => {
    const escaped = escapeUserText("here is what I saw:\n```\nerror text");
    expect((escaped.match(/^```/gm) ?? []).length).toBe(2);
  });

  it("leaves a balanced fence exactly as written", () => {
    const text = "log:\n```\nline one\n```";
    expect(escapeUserText(text)).toBe(text);
  });

  it("caps the length", () => {
    expect(escapeUserText("x".repeat(20000), 100).length).toBe(100);
  });
});

describe("issueBody", () => {
  const body = issueBody(report());

  it("puts the component id where a grep will find it", () => {
    expect(body).toContain("**Component ID:** `production-rule-cycle-quantity`");
  });

  it("names the area in the words a person uses", () => {
    expect(body).toContain("**Area:** Production Rules");
    expect(body).toContain(
      "**Component:** Production Rules › Creature Rule › Production Cycle Quantity",
    );
  });

  it("keeps the sections in a fixed order", () => {
    const order = ["## What happened", "## Expected behaviour", "## Steps to reproduce", "## Affected area", "## Severity", "## Environment"];
    let at = -1;
    for (const heading of order) {
      const found = body.indexOf(heading);
      expect(`${heading}: ${found > at}`).toBe(`${heading}: true`);
      at = found;
    }
  });

  it("carries the safe context as its own list", () => {
    expect(body).toContain("- field: quantity");
    expect(body).toContain("- index: 2");
  });

  it("names the build and the machine", () => {
    expect(body).toContain("- DinoDepot Studio: `0.6.0`");
    expect(body).toContain("- OS: Windows 11 10.0.26200 x86 64-bit");
  });

  it("folds the diagnostics away rather than leading with them", () => {
    expect(body).toContain("<details>");
    expect(body).toContain("<summary>Diagnostics</summary>");
    expect(body.indexOf("## What happened")).toBeLessThan(body.indexOf("<details>"));
  });

  it("leaves out a section with nothing in it", () => {
    const sparse = issueBody(
      report({ expectedBehavior: "", reproductionSteps: "", severity: null }),
    );
    expect(sparse).not.toContain("## Expected behaviour");
    expect(sparse).not.toContain("## Steps to reproduce");
    expect(sparse).not.toContain("## Severity");
    expect(sparse).toContain("## What happened");
  });

  it("asks the right questions for each kind of report", () => {
    expect(issueBody(report({ type: "suggestion", benefit: "so it is faster" })))
      .toContain("## How it could be improved");
    expect(
      issueBody(report({ type: "feature_request", benefit: "six maps by hand" })),
    ).toContain("## Why this would be useful");
  });

  /** Severity is a bug's judgement; on a feature request it would mis-sort it. */
  it("omits severity for anything that is not a bug", () => {
    expect(issueBody(report({ type: "suggestion" }))).not.toContain("## Severity");
  });

  it("adds the marker only when the service asks for it", () => {
    expect(issueBody(report())).not.toContain("dinodepot-report-id");
    const marked = issueBody(report(), { marker: true });
    expect(findReportMarker(marked)).toBe("11111111-2222-4333-8444-555555555555");
  });

  it("says when a report came from the browser build rather than the app", () => {
    const mock = report();
    mock.diagnostics.app.runtime = "browser";
    expect(issueBody(mock)).toContain("browser mock build");
  });

  it("credits a contact without publishing an address", () => {
    expect(issueBody(report({ contact: "octocat" }))).toContain("contact @octocat");
  });

  it("links attachments that were stored", () => {
    const withImage = report({
      attachments: [
        {
          id: "a1",
          fileName: "shot.webp",
          contentType: "image/webp",
          sizeBytes: 1000,
          dataB64: "",
          url: "https://cdn.example.com/a/b.webp",
        },
      ],
    });
    expect(issueBody(withImage)).toContain("[shot.webp](https://cdn.example.com/a/b.webp)");
  });
});

describe("the marker", () => {
  it("round-trips", () => {
    expect(findReportMarker(reportMarker("abc12345"))).toBe("abc12345");
  });

  it("finds nothing in a body that has none", () => {
    expect(findReportMarker("## What happened\n\nit broke")).toBeNull();
  });

  it("produces the term the service searches for", () => {
    expect(reportMarker("abc12345")).toContain(markerSearchTerm("abc12345"));
  });
});

describe("the browser fallback", () => {
  it("leaves the diagnostics out of anything that travels in a URL", () => {
    const body = fallbackIssueBody(report());
    expect(body).not.toContain("<details>");
    expect(body).not.toContain("```json");
    expect(body).toContain("## What happened");
    expect(body).toContain("**Component ID:**");
  });

  it("shortens visibly rather than being cut by a proxy", () => {
    // Just under the schema's own per-field cap, and well over what a URL
    // should carry.
    const long = fallbackIssueBody(report({ description: "x".repeat(7900) }));
    expect(long.length).toBeLessThanOrEqual(MAX_PREFILL_BODY);
    expect(long).toContain("shortened");
  });

  it("builds a URL GitHub understands", () => {
    const url = prefilledIssueUrl(
      "https://github.com/o/r/issues/new",
      report(),
      labelsForReport(report()),
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("title")).toBe(issueTitle(report()));
    expect(parsed.searchParams.get("labels")).toContain("bug");
    expect(parsed.searchParams.get("body")).toContain("## What happened");
  });
});

describe("debugInfoText", () => {
  it("says what it is, where it was and which component", () => {
    const text = debugInfoText(report().diagnostics, report().target);
    expect(text).toContain("DinoDepot Studio 0.6.0");
    expect(text).toContain("Route: /production/:id");
    expect(text).toContain("Component ID: production-rule-cycle-quantity");
    expect(text).toContain("field: quantity");
  });

  it("carries no more than the issue would", () => {
    const text = debugInfoText(report().diagnostics, report().target);
    expect(text).not.toContain("dd-install-");
    expect(text.split("\n").length).toBeLessThan(15);
  });
});
