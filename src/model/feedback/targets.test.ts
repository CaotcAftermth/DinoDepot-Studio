import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  ALLOWED_CONTEXT_KEYS,
  FEEDBACK_AREAS,
  FEEDBACK_TARGETS,
  FEEDBACK_TARGET_IDS,
  MAX_CONTEXT_ENTRIES,
  MAX_CONTEXT_VALUE,
  feedbackTarget,
  isKnownArea,
  looksUnsafeToPublish,
  parseTargetContext,
  sanitizeTargetContext,
  targetDefinition,
} from "./targets";

/**
 * The registry is data, and data drifts.
 *
 * These are the rules the naming standard states in prose, asserted so a new
 * entry that breaks one fails here rather than producing an issue nobody can
 * search for six months later.
 */

/** Every source file under `src/`, so the scan cannot miss a call site. */
function readdirDeep(dir: URL | string): string[] {
  const root = typeof dir === "string" ? dir : fileURLToPath(dir);
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out.push(...readdirDeep(path));
    else out.push(path);
  }
  return out;
}

describe("the target registry", () => {
  it("names an area that exists, for every entry", () => {
    for (const [id, definition] of Object.entries(FEEDBACK_TARGETS)) {
      expect(`${id}: ${isKnownArea(definition.area)}`).toBe(`${id}: true`);
    }
  });

  it("uses lowercase kebab-case ids throughout", () => {
    for (const id of FEEDBACK_TARGET_IDS) {
      expect(id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });

  /** An index in an id is the exact fragility the registry exists to avoid. */
  it("keeps positions and entity ids out of the ids themselves", () => {
    for (const id of FEEDBACK_TARGET_IDS) {
      expect(id).not.toMatch(/\d/);
      expect(id).not.toMatch(/(^|-)(first|second|third|last|top|bottom|left|right)(-|$)/);
    }
  });

  it("gives every target a friendly name a person would say out loud", () => {
    for (const [id, definition] of Object.entries(FEEDBACK_TARGETS)) {
      expect(`${id}: ${definition.name.length > 2}`).toBe(`${id}: true`);
      // The name is what a reporter reads, so it must not be the id again.
      // A kebab-case run is the tell.
      expect(`${id}: ${/[a-z]-[a-z]/.test(definition.name)}`).toBe(`${id}: false`);
      expect(definition.name).not.toBe(id);
    }
  });

  it("covers every area with at least one target", () => {
    const covered = new Set(
      Object.values(FEEDBACK_TARGETS).map((definition) => definition.area),
    );
    for (const slug of Object.keys(FEEDBACK_AREAS)) {
      expect(`${slug}: ${covered.has(slug as never)}`).toBe(`${slug}: true`);
    }
  });

  /**
   * The registry has to be the set of components that actually exist.
   *
   * A registered id with no call site is worse than no entry at all: it
   * promises coverage the interface does not have, it can never appear in a
   * report, and the duplicate search would happily look for issues about a
   * component nobody can select. This caught 27 such entries the first time it
   * ran.
   */
  it("registers nothing the interface does not use", () => {
    const source = readdirDeep(new URL("../../", import.meta.url))
      .filter((file) => file.endsWith(".tsx") || file.endsWith(".ts"))
      .filter((file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    // Both spellings: the direct call, and an id chosen by a conditional.
    const used = new Set([
      ...[...source.matchAll(/feedbackTarget\(\s*\n?\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
      ...[...source.matchAll(/\?\s*"([a-z0-9-]+)"\s*\n?\s*:\s*"([a-z0-9-]+)"/g)].flatMap(
        (m) => [m[1], m[2]],
      ),
    ]);

    for (const id of FEEDBACK_TARGET_IDS) {
      expect(`${id} used: ${used.has(id)}`).toBe(`${id} used: true`);
    }
  });

  it("resolves a registered id and refuses an unregistered one", () => {
    expect(targetDefinition("production-rule-cycle-quantity")?.name).toBe(
      "Production Cycle Quantity",
    );
    expect(targetDefinition("something-invented")).toBeNull();
  });
});

describe("feedbackTarget", () => {
  it("takes the name and area from the registry, not the call site", () => {
    const props = feedbackTarget("spawn-command-color-selector");
    expect(props["data-feedback-id"]).toBe("spawn-command-color-selector");
    expect(props["data-feedback-name"]).toBe("Spawn Command Color Selector");
    expect(props["data-feedback-area"]).toBe("spawn-commands");
  });

  it("leaves the context attribute off entirely when there is none", () => {
    expect(feedbackTarget("overview")["data-feedback-context"]).toBeUndefined();
    expect(
      feedbackTarget("overview", { creature: "" })["data-feedback-context"],
    ).toBeUndefined();
  });

  it("round-trips context through the attribute", () => {
    const props = feedbackTarget("production-rule-cycle-editor", {
      index: 2,
      field: "quantity",
    });
    expect(parseTargetContext(props["data-feedback-context"] ?? null)).toEqual({
      index: "2",
      field: "quantity",
    });
  });
});

describe("context sanitization", () => {
  it("drops a key that is not on the allowlist", () => {
    expect(
      sanitizeTargetContext({ creature: "Rex", projectPath: "somewhere" }),
    ).toEqual({});
  });

  it("accepts numbers and booleans, and drops everything else", () => {
    expect(
      sanitizeTargetContext({
        count: 4,
        state: true,
        index: null,
        field: undefined,
      }),
    ).toEqual({ count: "4", state: "true" });
  });

  it("stops at the entry limit rather than growing", () => {
    const context = sanitizeTargetContext({
      category: "a",
      field: "b",
      tab: "c",
      kind: "d",
      count: "e",
      index: "f",
      state: "g",
    });
    expect(Object.keys(context).length).toBe(MAX_CONTEXT_ENTRIES);
  });

  it("truncates a long value rather than refusing it", () => {
    const context = sanitizeTargetContext({ field: "x".repeat(200) });
    expect(context.field.length).toBe(MAX_CONTEXT_VALUE);
  });

  it("collapses whitespace so an attribute stays one line", () => {
    expect(sanitizeTargetContext({ field: "  Quantity   Input\nField " })).toEqual({
      field: "Quantity Input Field",
    });
  });

  /**
   * The case this exists for: somebody passes the wrong variable, and a drive
   * path or a webhook would otherwise be published in an issue.
   */
  it("drops a value that must never be published", () => {
    for (const value of [
      "C:\\Users\\jane\\projects\\cluster",
      "C:/Users/jane/projects",
      "https://discord.com/api/webhooks/1/abc",
      "ghp_abcdefghijklmnopqrstuvwxyz012345",
      "\\\\fileserver\\share",
      "my api_key is here",
      "/Users/jane/Documents",
    ]) {
      expect(`${value} => ${looksUnsafeToPublish(value)}`).toBe(`${value} => true`);
      expect(sanitizeTargetContext({ field: value })).toEqual({});
    }
  });

  it("leaves ordinary creature and item names alone", () => {
    for (const value of [
      "Argentavis",
      "Raw Prime Meat",
      "Tek Rex",
      "Aberrant Doedicurus",
      "Metal Production",
    ]) {
      expect(`${value} => ${looksUnsafeToPublish(value)}`).toBe(`${value} => false`);
    }
  });

  it("re-sanitizes on the way back out of the DOM", () => {
    // The attribute is a string in a document by then, and nothing guarantees
    // it is the one `feedbackTarget` wrote.
    expect(parseTargetContext('{"field":"Quantity","token":"ghp_x"}')).toEqual({
      field: "Quantity",
    });
    expect(parseTargetContext("not json")).toEqual({});
    expect(parseTargetContext("[1,2,3]")).toEqual({});
    expect(parseTargetContext(null)).toEqual({});
  });

  it("keeps the allowlist free of anything that names a location or a secret", () => {
    for (const key of ALLOWED_CONTEXT_KEYS) {
      expect(key).not.toMatch(/path|dir|folder|url|token|secret|key|password|webhook|user/);
    }
  });
});
