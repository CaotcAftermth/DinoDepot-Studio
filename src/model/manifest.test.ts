import { describe, expect, it } from "vitest";
import {
  assessCompatibility,
  CURRENT_PROJECT_SCHEMA,
  newProjectHeader,
  PROJECT_FORMAT,
  readProjectHeader,
} from "./manifest";
import { SCHEMA_V1_PROJECT } from "./migrations/__fixtures__/schema-v1";
import { PROJECT_FILE } from "./project";

function manifest(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: PROJECT_FORMAT,
    projectId: "11111111-2222-4333-8444-555555555555",
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    minimumStudioVersion: "0.2.0",
    ...over,
  });
}

describe("readProjectHeader", () => {
  it("reads a current manifest", () => {
    const header = readProjectHeader(manifest());
    expect(header.kind).toBe("manifest");
    expect(header.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA);
    expect(header.projectId).toBe("11111111-2222-4333-8444-555555555555");
  });

  /**
   * The point of reading the header separately: a project from a newer build
   * has fields this one has never seen, and running the current schema over it
   * first would report it as corrupt.
   */
  it("reads a manifest from a schema this build does not know", () => {
    const header = readProjectHeader(
      manifest({ schemaVersion: 99, somethingNew: { nested: true } }),
    );
    expect(header.kind).toBe("manifest");
    expect(header.schemaVersion).toBe(99);
  });

  it("recognises a released schema-1 project", () => {
    const header = readProjectHeader(SCHEMA_V1_PROJECT[PROJECT_FILE.settings]);
    expect(header.kind).toBe("legacy-v1");
    expect(header.schemaVersion).toBe(1);
    expect(header.projectId).toBeNull();
  });

  /** `schemaVersion: 1` alone would claim half the JSON files in the world. */
  it("does not claim unrelated JSON that happens to carry a schemaVersion", () => {
    const header = readProjectHeader(
      JSON.stringify({ schemaVersion: 1, records: [] }),
    );
    expect(header.kind).toBe("not-a-project");
  });

  it("reports unreadable JSON as unreadable, with a reason", () => {
    const header = readProjectHeader("{ not json at all");
    expect(header.kind).toBe("unreadable");
    expect(header.reason).not.toBe("");
  });

  it("rejects JSON that is not an object", () => {
    expect(readProjectHeader("[]").kind).toBe("not-a-project");
    expect(readProjectHeader("null").kind).toBe("not-a-project");
    expect(readProjectHeader('"a string"').kind).toBe("not-a-project");
  });

  it("defaults a missing minimumStudioVersion to the oldest", () => {
    const header = readProjectHeader(
      manifest({ minimumStudioVersion: undefined }),
    );
    expect(header.minimumStudioVersion).toBe("0.0.0");
  });
});

describe("assessCompatibility", () => {
  const assess = (text: string, studio = "0.2.0") =>
    assessCompatibility(readProjectHeader(text), studio);

  it("opens a project at the current schema", () => {
    expect(assess(manifest()).compatibility).toBe("open");
  });

  it("migrates an older schema", () => {
    const result = assess(SCHEMA_V1_PROJECT[PROJECT_FILE.settings]);
    expect(result.compatibility).toBe("migrate");
    expect(result.fromSchema).toBe(1);
    expect(result.toSchema).toBe(CURRENT_PROJECT_SCHEMA);
  });

  /**
   * The rule that matters most. An older Studio writing to a newer schema
   * cannot know what it is dropping, and the project is shared — the loss
   * lands on somebody else's machine.
   */
  it("opens a newer schema read-only rather than refusing or writing to it", () => {
    const result = assess(manifest({ schemaVersion: CURRENT_PROJECT_SCHEMA + 1 }));
    expect(result.compatibility).toBe("read-only");
    expect(result.message).toContain("newer");
  });

  it("opens read-only when the project demands a newer Studio", () => {
    const result = assess(manifest({ minimumStudioVersion: "9.0.0" }), "0.2.0");
    expect(result.compatibility).toBe("read-only");
    expect(result.message).toContain("9.0.0");
  });

  it("opens normally when this build satisfies the requirement exactly", () => {
    expect(assess(manifest({ minimumStudioVersion: "0.2.0" }), "0.2.0").compatibility)
      .toBe("open");
  });

  it("refuses a folder that is not a project", () => {
    expect(assess('{"hello":"world"}').compatibility).toBe("reject");
    expect(assess("{ broken").compatibility).toBe("reject");
  });

  it("refuses a manifest with no schema version", () => {
    const result = assess(manifest({ schemaVersion: "two" }));
    expect(result.compatibility).toBe("reject");
  });

  it("never speaks in schema numbers in the message an admin sees", () => {
    const result = assess(manifest({ schemaVersion: CURRENT_PROJECT_SCHEMA + 1 }));
    expect(result.message).not.toMatch(/schema/i);
    // The number is available, but only under Advanced Details.
    expect(result.detail).toMatch(/schema/i);
  });
});

describe("newProjectHeader", () => {
  it("stamps the format, the schema and the time", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const header = newProjectHeader("abc", now);
    expect(header.format).toBe(PROJECT_FORMAT);
    expect(header.projectId).toBe("abc");
    expect(header.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA);
    expect(header.createdAt).toBe(now.toISOString());
  });

  it("produces a header this build reads back as current", () => {
    const header = newProjectHeader("abc");
    expect(assessCompatibility(readProjectHeader(JSON.stringify(header))).compatibility)
      .toBe("open");
  });
});
