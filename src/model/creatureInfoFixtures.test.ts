import { describe, expect, it } from "vitest";
import { CREATURE_FIXTURES } from "./creatureInfoFixtures";
import {
  CreatureInfoSchema,
  INPUT_ROLES,
  METHOD_OUTCOMES,
  METHOD_TAGS,
  REFERENCE_TYPES,
  type CreatureInfo,
} from "./creatureInfo";
import { buildCatalogIndex, normalizeBpPath } from "./catalog";
import { officialSource } from "./officialCatalog";

const parsed = CREATURE_FIXTURES.map((f) => ({
  fixture: f,
  info: CreatureInfoSchema.parse(f.info) as CreatureInfo,
}));

const index = buildCatalogIndex({ sources: [officialSource] });

describe("fixture set", () => {
  it("has the 25 representative cases", () => {
    expect(CREATURE_FIXTURES).toHaveLength(25);
  });

  it("every fixture is valid against the live schema", () => {
    for (const f of CREATURE_FIXTURES) {
      const result = CreatureInfoSchema.safeParse(f.info);
      expect(result.success, `${f.name}: ${JSON.stringify(result.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it("covers a mod creature", () => {
    const edmontonia = CREATURE_FIXTURES.find((f) => f.name === "Edmontonia")!;
    expect(edmontonia.info.methods?.[0]?.tags).toContain("combat-assist");
  });
});

describe("schema coverage", () => {
  const allMethods = parsed.flatMap((p) => p.info.methods);

  it("exercises both availabilities", () => {
    const seen = new Set(parsed.map((p) => p.info.availability).filter(Boolean));
    expect([...seen].sort()).toEqual(["acquirable", "unavailable"]);
  });

  it("exercises every method outcome", () => {
    const seen = new Set(allMethods.map((m) => m.outcome).filter(Boolean));
    for (const outcome of METHOD_OUTCOMES) {
      if (outcome === "other") continue; // catch-all, deliberately unused
      expect(seen, `outcome ${outcome} is not covered`).toContain(outcome);
    }
  });

  it("exercises every classification tag", () => {
    const seen = new Set(allMethods.flatMap((m) => m.tags));
    for (const tag of METHOD_TAGS) {
      expect(seen, `tag ${tag} is not covered`).toContain(tag);
    }
  });

  it("exercises every input reference type", () => {
    const seen = new Set(
      allMethods.flatMap((m) => m.inputs).map((i) => i.referenceType),
    );
    for (const t of REFERENCE_TYPES) {
      expect(seen, `reference type ${t} is not covered`).toContain(t);
    }
  });

  it("exercises a representative spread of input roles", () => {
    const seen = new Set(allMethods.flatMap((m) => m.inputs).map((i) => i.role));
    for (const role of [
      "taming-food",
      "offering",
      "bait",
      "sedative",
      "catalyst",
      "host-creature",
      "optional-aid",
    ]) {
      expect(seen, `role ${role} is not covered`).toContain(role);
    }
    // Everything used must still be a known role.
    for (const role of seen) expect(INPUT_ROLES).toContain(role as never);
  });

  it("exercises phase-level outcome fields", () => {
    const phases = allMethods.flatMap((m) => m.phases);
    expect(phases.some((p) => p.repeatUntil)).toBe(true);
    expect(phases.some((p) => p.completedWhen)).toBe(true);
    expect(phases.some((p) => p.failureOrReset)).toBe(true);
    expect(phases.some((p) => p.transitionNote)).toBe(true);
  });

  it("keeps simple methods simple - not every phase carries outcomes", () => {
    const phases = allMethods.flatMap((m) => m.phases);
    const bare = phases.filter(
      (p) => !p.repeatUntil && !p.completedWhen && !p.failureOrReset && !p.transitionNote,
    );
    expect(bare.length).toBeGreaterThan(0);
  });
});

describe("representative cases", () => {
  const byName = (n: string) => parsed.find((p) => p.fixture.name === n)!;

  it("Diplodocus carries two parallel routes", () => {
    const { info } = byName("Diplodocus");
    expect(info.methods).toHaveLength(2);
    expect(info.methods.map((m) => m.tags[0]).sort()).toEqual([
      "knockout",
      "passive",
    ]);
    // Two methods, same outcome - the case that proved outcome belongs on
    // the method rather than the creature.
    expect(new Set(info.methods.map((m) => m.outcome))).toEqual(
      new Set(["direct-tame"]),
    );
  });

  it("Gigantoraptor is a wild-baby minigame, not combat assistance", () => {
    const { info } = byName("Gigantoraptor");
    const m = info.methods[0];
    expect(m.tags).toEqual(["wild-baby", "minigame"]);
    expect(m.tags).not.toContain("combat-assist");
    expect(m.outcome).toBe("claim");
  });

  it("Gigantoraptor's two phases reset for different reasons", () => {
    const [distract, nest] = byName("Gigantoraptor").info.methods[0].phases;
    expect(distract.failureOrReset).toContain("hatches");
    expect(nest.failureOrReset).toContain("wrong action");
    expect(distract.failureOrReset).not.toBe(nest.failureOrReset);
  });

  it("Edmontonia is the combat-assist case and comes from a mod", () => {
    const { info } = byName("Edmontonia");
    expect(info.methods[0].tags).toContain("combat-assist");
    expect(info.methods[0].effectiveness).toContain("fire damage");
  });

  it("Rhyniognatha's host is a creature reference, not an item", () => {
    const host = byName("Rhyniognatha")
      .info.methods[0].inputs.find((i) => i.role === "host-creature")!;
    expect(host.referenceType).toBe("creature");
    expect(host.qty).toContain("300");
    expect(index.creatures.has(normalizeBpPath(host.bpPath))).toBe(true);
  });

  it("Carcharodontosaurus records the temporary stage inside a full tame", () => {
    const m = byName("Carcharodontosaurus").info.methods[0];
    expect(m.outcome).toBe("direct-tame");
    expect(m.phases[1].transitionNote).toContain("temporary-control");
  });

  it("the untameable fixture records nothing but its availability", () => {
    const { info } = byName("Alpha Rex");
    expect(info.availability).toBe("unavailable");
    expect(info.methods).toEqual([]);
  });

  it("the inherited variant stores nothing of its own", () => {
    const { info } = byName("Aberrant Gigantoraptor");
    expect(info.overrides).toEqual([]);
    expect(info.methods).toEqual([]);
    expect(info.availability).toBe("");
  });
});

describe("catalog references", () => {
  it("every catalog-backed input resolves against the right catalog", () => {
    const unresolved: string[] = [];
    for (const { fixture, info } of parsed) {
      for (const m of info.methods) {
        for (const i of m.inputs) {
          if (i.referenceType === "text" || !i.bpPath) continue;
          const kind = i.referenceType === "creature" ? "creatures" : "items";
          if (!index[kind].has(normalizeBpPath(i.bpPath))) {
            unresolved.push(`${fixture.name}: ${i.bpPath} (${kind})`);
          }
        }
      }
    }
    expect(unresolved).toEqual([]);
  });

  it("every fixture bpPath that is set exists in the official catalog", () => {
    const missing = CREATURE_FIXTURES.filter(
      (f) => f.bpPath && !index.creatures.has(normalizeBpPath(f.bpPath)),
    ).map((f) => `${f.name}: ${f.bpPath}`);
    expect(missing).toEqual([]);
  });
});
