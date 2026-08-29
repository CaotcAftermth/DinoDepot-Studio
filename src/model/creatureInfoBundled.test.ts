import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CreatureInfoSchema, hasCreatureInfo } from "./creatureInfo";
import { PackageContentSchema } from "./package";
import officialIndex from "../../Public_Content/Official_Icons/index.json";
import { normalizeBpPath } from "./catalog";
import officialData from "../assets/catalog/official-asa.json";

/** The creature information that ships inside the official package. */

const payload = JSON.parse(
  readFileSync(
    new URL("../assets/catalog/official-creature-info.json", import.meta.url),
    "utf8",
  ),
) as {
  variantParents: Record<string, string>;
  creatureInfo: Record<string, unknown>;
};

const records = Object.entries(payload.creatureInfo);
const officialPaths = new Set(
  officialData.creatures.map((entry) => normalizeBpPath(entry.bpPath)),
);

describe("bundled creature info", () => {
  it("only names creatures the official catalog has", () => {
    expect(records.length).toBeGreaterThan(500);
    for (const [bpPath] of records) {
      expect(officialPaths.has(normalizeBpPath(bpPath))).toBe(true);
    }
  });

  /**
   * A variant that turned out identical to its base creature ships nothing -
   * the parent's record answers for it - so the list is shorter than the
   * catalog rather than matching it one for one.
   */
  it("drops a variant whose record is entirely inherited", () => {
    expect(records.length).toBeLessThan(officialData.creatures.length);
  });

  it("contains no external links or citation markers", () => {
    const blob = JSON.stringify(payload.creatureInfo);
    expect(blob).not.toMatch(/\]\[\d+\]/);
    expect(blob).not.toContain("http");
    expect(blob).not.toContain("utm_source");
  });

  it("points every variant at a creature that exists", () => {
    for (const [child, parent] of Object.entries(payload.variantParents)) {
      expect(officialPaths.has(normalizeBpPath(child))).toBe(true);
      expect(officialPaths.has(normalizeBpPath(parent))).toBe(true);
      expect(child).not.toBe(parent);
    }
  });

  it("is keyed by normalized blueprint paths", () => {
    for (const [bpPath] of records) {
      expect(bpPath).toBe(normalizeBpPath(bpPath));
    }
  });

  it("parses every record against the schema the app reads it with", () => {
    for (const [bpPath, raw] of records) {
      const parsed = CreatureInfoSchema.safeParse(raw);
      // Named so a failure says which creature, not just "record 417".
      expect(parsed.success ? "" : `${bpPath}: ${parsed.error.message}`).toBe("");
    }
  });

  it("carries something for every creature it does ship", () => {
    for (const [bpPath, raw] of records) {
      const info = CreatureInfoSchema.parse(raw);
      expect(`${bpPath}: ${hasCreatureInfo(info)}`).toBe(`${bpPath}: true`);
    }
  });

  /**
   * A variant inherits any section it does not list in `overrides`. A record
   * with data but no overrides would have all of it silently replaced by its
   * parent's, which is the one mistake this format makes easy.
   */
  it("claims every section it fills", () => {
    for (const [bpPath, raw] of records) {
      const info = CreatureInfoSchema.parse(raw);
      const owns = new Set(info.overrides);
      const filled: string[] = [];
      if (info.availability || info.methods.length > 0) filled.push("acquisition");
      if (info.spawnMaps.length > 0) filled.push("spawns");
      if (Object.values(info.drops).some((list) => list.length > 0)) {
        filled.push("drops");
      }
      if (info.technical.dragWeight !== null) filled.push("technical");
      for (const section of filled) {
        expect(`${bpPath} owns ${section}: ${owns.has(section as never)}`).toBe(
          `${bpPath} owns ${section}: true`,
        );
      }
    }
  });

  /** Unavailable creatures must never suggest an acquisition route. */
  it("gives no acquisition method to an unavailable creature", () => {
    for (const [bpPath, raw] of records) {
      const info = CreatureInfoSchema.parse(raw);
      if (info.availability !== "unavailable") continue;
      expect(`${bpPath}: ${info.methods.length}`).toBe(`${bpPath}: 0`);
    }
  });

  it("gives every method an outcome and at least one step or input", () => {
    for (const [bpPath, raw] of records) {
      for (const method of CreatureInfoSchema.parse(raw).methods) {
        expect(`${bpPath}: ${method.outcome}`).toBe(`${bpPath}: direct-tame`);
        const steps = method.phases.reduce((n, p) => n + p.steps.length, 0);
        expect(steps + method.inputs.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps ids unique within a record", () => {
    for (const [bpPath, raw] of records) {
      const info = CreatureInfoSchema.parse(raw);
      const ids: string[] = [];
      for (const method of info.methods) {
        ids.push(method.id);
        for (const input of method.inputs) ids.push(input.id);
        for (const phase of method.phases) {
          ids.push(phase.id);
          for (const step of phase.steps) ids.push(step.id);
        }
      }
      for (const list of Object.values(info.drops)) {
        for (const entry of list) ids.push(entry.id);
      }
      expect(`${bpPath}: ${new Set(ids).size}`).toBe(`${bpPath}: ${ids.length}`);
    }
  });

  /**
   * The built package, read the way the app reads it.
   *
   * The data file above is the input to the build; these are the bytes that
   * actually ship, and they are immutable once published - so this reads the
   * published version through `PackageContentSchema` rather than trusting that
   * the build carried the records across intact.
   */
  it("survives the round trip into the published package", () => {
    const version = officialIndex.package.version;
    const content = PackageContentSchema.parse(
      JSON.parse(
        readFileSync(
          new URL(
            `../../Public_Content/Official_Icons/versions/${version}/content.json`,
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    );

    expect(Object.keys(content.creatureInfo).length).toBe(records.length);
    expect(Object.keys(content.variantParents).length).toBe(
      Object.keys(payload.variantParents).length,
    );

    const rex =
      content.creatureInfo[
        "/game/primalearth/dinos/rex/rex_character_bp.rex_character_bp"
      ];
    expect(rex.availability).toBe("acquirable");
    expect(rex.technical.dragWeight).toBe(550);
    expect(rex.drops.harvest.map((entry) => entry.label)).toContain("Hide");
    expect(rex.methods[0].inputs.map((input) => input.label)).toContain(
      "Raw Prime Meat",
    );
    // The editor groups inputs by role.
    for (const input of rex.methods[0].inputs) {
      expect(input.role).toBe("taming-food");
      expect(input.referenceType).toBe("text");
    }
    expect(rex.methods[0].phases.length).toBeGreaterThan(0);
  });
});
