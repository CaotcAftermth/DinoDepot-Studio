import { describe, expect, it } from "vitest";
import {
  MANAGED_LABELS,
  SOURCE_LABEL,
  TRIAGE_LABEL,
  areaLabelFor,
  labelSetupCommands,
  labelsForReport,
  severityLabelFor,
} from "./labels";
import { FEEDBACK_AREAS } from "./targets";
import { BUG_SEVERITIES } from "./types";

describe("labelsForReport", () => {
  it("carries kind, source, triage state and area", () => {
    expect(
      labelsForReport({
        type: "bug",
        severity: "major",
        target: { area: "production-rules" },
      }),
    ).toEqual([
      "bug",
      SOURCE_LABEL,
      TRIAGE_LABEL,
      "area:production-rules",
      "severity:major",
    ]);
  });

  it("uses a hyphen for the feature label, matching the repository", () => {
    expect(labelsForReport({ type: "feature_request" })).toContain("feature-request");
  });

  /** A "blocking" feature request would sort into a queue it does not belong in. */
  it("labels severity for bugs only", () => {
    expect(
      labelsForReport({ type: "suggestion", severity: "blocking" }),
    ).not.toContain("severity:blocking");
  });

  it("leaves the area off when nothing was selected", () => {
    const labels = labelsForReport({ type: "bug" });
    expect(labels.some((label) => label.startsWith("area:"))).toBe(false);
    expect(labels).toContain("bug");
  });

  it("is stable and free of duplicates", () => {
    const once = labelsForReport({ type: "bug", target: { area: "settings" } });
    const twice = labelsForReport({ type: "bug", target: { area: "settings" } });
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(once.length);
  });

  it("builds label names from slugs consistently", () => {
    expect(areaLabelFor("overview")).toBe("area:overview");
    expect(areaLabelFor("")).toBe("");
    expect(severityLabelFor("minor")).toBe("severity:minor");
    expect(severityLabelFor(null)).toBe("");
  });
});

/**
 * The documented set and the emitted set have to be the same set.
 *
 * A label this code emits but nobody created is silently dropped by the
 * service; one documented but never emitted is a line in a setup guide that
 * wastes somebody's time. Both are invisible without this.
 */
describe("the managed label list", () => {
  const names = new Set(MANAGED_LABELS.map((label) => label.name));

  it("covers every area the target registry has", () => {
    for (const slug of Object.keys(FEEDBACK_AREAS)) {
      expect(`${slug}: ${names.has(`area:${slug}`)}`).toBe(`${slug}: true`);
    }
  });

  it("covers every severity", () => {
    for (const severity of BUG_SEVERITIES) {
      expect(names.has(`severity:${severity}`)).toBe(true);
    }
  });

  it("covers everything a report is actually labelled with", () => {
    for (const type of ["bug", "suggestion", "feature_request"] as const) {
      for (const label of labelsForReport({
        type,
        severity: "moderate",
        target: { area: "overview" },
      })) {
        expect(`${label}: ${names.has(label)}`).toBe(`${label}: true`);
      }
    }
  });

  it("covers the progress labels the status mapping reads", () => {
    for (const label of [
      "confirmed",
      "in-progress",
      "planned",
      "fixed",
      "wont-fix",
      "duplicate",
    ]) {
      expect(`${label}: ${names.has(label)}`).toBe(`${label}: true`);
    }
  });

  it("gives every label a colour GitHub accepts and a description", () => {
    for (const label of MANAGED_LABELS) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
      expect(label.description.length).toBeGreaterThan(3);
    }
  });

  it("has no duplicates", () => {
    expect(names.size).toBe(MANAGED_LABELS.length);
  });

  it("produces one setup command per label", () => {
    const commands = labelSetupCommands("owner/repo");
    expect(commands.length).toBe(MANAGED_LABELS.length);
    expect(commands[0]).toContain("gh label create");
    expect(commands[0]).toContain("--repo owner/repo");
  });
});
