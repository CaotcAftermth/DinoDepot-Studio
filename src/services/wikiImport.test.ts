import { describe, expect, it } from "vitest";
import {
  buildImportRecord,
  buildNameIndex,
  classify,
  collectRefs,
  detectGame,
  detectMod,
  extractSections,
  findStaleRefs,
  importFixtures,
  pickAcquisitionSection,
  proposedSections,
  resolveRef,
  stripMarkup,
  toSteps,
  type WikiPage,
} from "./wikiImport";
import { buildCatalogIndex, normalizeBpPath, type ContentSource } from "../model/catalog";
import { officialSource } from "../model/officialCatalog";
import { CREATURE_FIXTURES } from "../model/creatureInfoFixtures";
import { CreatureInfoSchema, emptyCreatureInfo, type CreatureInfo } from "../model/creatureInfo";
import { mergeReimport } from "../model/creatureImport";

const catalogIndex = buildCatalogIndex({ sources: [officialSource] });
const nameIndex = buildNameIndex([officialSource as ContentSource]);

const opts = {
  nameIndex,
  creatureIndex: nameIndex.creatures,
};

function page(over: Partial<WikiPage> = {}): WikiPage {
  return {
    page: "Rex",
    wikitext: "",
    revisionId: 1234,
    url: "https://ark.wiki.gg/wiki/Rex",
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("extractSections", () => {
  it("splits on headings and keeps the lead", () => {
    const s = extractSections("intro text\n\n== Taming ==\nknock it out\n\n== Notes ==\nfast");
    expect(s.Lead).toBe("intro text");
    expect(s.Taming).toBe("knock it out");
    expect(s.Notes).toBe("fast");
  });

  it("folds subsections into their parent so a section stays whole", () => {
    const s = extractSections("== Taming ==\nlead\n=== Strategy ===\nuse a trap");
    expect(s.Taming).toContain("lead");
    expect(s.Taming).toContain("use a trap");
    expect(s.Strategy).toBeUndefined();
  });

  it("does not invent sections for an empty body", () => {
    expect(extractSections("== Empty ==\n\n")).toEqual({});
  });
});

describe("pickAcquisitionSection", () => {
  it("prefers Taming over the other candidates", () => {
    const picked = pickAcquisitionSection({ Utility: "carries stuff", Taming: "tranq it" });
    expect(picked).toEqual({ name: "Taming", text: "tranq it" });
  });

  it("matches case-insensitively", () => {
    expect(pickAcquisitionSection({ TAMING: "x" })?.name).toBe("TAMING");
  });

  it("returns null when the page has no acquisition section", () => {
    expect(pickAcquisitionSection({ Lead: "a big lizard" })).toBeNull();
  });
});

describe("collectRefs", () => {
  it("types references from the markup that names them", () => {
    const refs = collectRefs("{{ItemLink|Narcotic}} and {{DinoLink|Rex}}");
    expect(refs).toContainEqual({ name: "Narcotic", kind: "item" });
    expect(refs).toContainEqual({ name: "Rex", kind: "creature" });
  });

  it("leaves a plain link untyped", () => {
    expect(collectRefs("[[Raw Meat]]")).toEqual([{ name: "Raw Meat", kind: "unknown" }]);
  });

  it("uses a link's target, not its display text", () => {
    expect(collectRefs("[[Raw Meat|some meat]]")).toEqual([
      { name: "Raw Meat", kind: "unknown" },
    ]);
  });

  it("lets a typed link win over an untyped one for the same name", () => {
    expect(collectRefs("[[Narcotic]] ... {{ItemLink|Narcotic}}")).toEqual([
      { name: "Narcotic", kind: "item" },
    ]);
  });

  it("ignores namespaced links", () => {
    expect(collectRefs("[[File:Rex.png]] [[Category:Creatures]]")).toEqual([]);
  });
});

describe("stripMarkup", () => {
  it("unwraps links, templates, bold and refs", () => {
    const out = stripMarkup(
      "'''Rex''' eats {{ItemLink|Raw Meat}} from [[Meat|the meat]].<ref>cite</ref>",
    );
    expect(out).toBe("Rex eats Raw Meat from the meat.");
  });

  it("drops comments and stray tags", () => {
    expect(stripMarkup("a<!-- hidden -->b<br/>c")).toBe("abc");
  });
});

describe("toSteps", () => {
  it("turns bullets into steps and drops table noise", () => {
    const steps = toSteps("* Trap it\n* Tranq it\n| style=x |\n");
    expect(steps).toEqual(["Trap it", "Tranq it"]);
  });

  it("caps runaway sections", () => {
    const long = Array.from({ length: 40 }, (_, i) => `* step ${i}`).join("\n");
    expect(toSteps(long)).toHaveLength(12);
  });
});

// ---------------------------------------------------------------------------

describe("classify", () => {
  it("reads a knockout tame from the wiki's own vocabulary", () => {
    const c = classify("The Rex must be knocked out with tranquilizer arrows to raise torpor.");
    expect(c.availability).toBe("acquirable");
    expect(c.tags).toContain("knockout");
    expect(c.outcome).toBe("direct-tame");
  });

  it("reads an untameable creature and proposes no method", () => {
    const c = classify("The Alpha Rex cannot be tamed.");
    expect(c.availability).toBe("unavailable");
    expect(c.tags).toEqual([]);
    expect(c.outcome).toBe("");
  });

  it("flags rather than guesses when no method is recognisable", () => {
    const c = classify("A large herbivore found in the redwoods.");
    expect(c.tags).toEqual([]);
    expect(c.ambiguities.join(" ")).toMatch(/no taming method/i);
  });

  it("flags conflicting outcomes instead of silently picking one", () => {
    const c = classify("It can be claimed as a wild baby, or hatched from an incubated egg.");
    expect(c.ambiguities.some((a) => /conflicting outcomes/i.test(a))).toBe(true);
  });

  it("flags a page that reads like more than one route", () => {
    const c = classify(
      "It can be knocked out with torpor, passively tamed by hand feeding, or " +
        "tamed while mounted after building trust.",
    );
    expect(c.tags.length).toBeGreaterThan(2);
    expect(c.ambiguities.some((a) => /more than one route/i.test(a))).toBe(true);
  });
});

describe("detectGame", () => {
  it("marks a page that names both games", () => {
    expect(detectGame("Added in Survival Evolved, present in Survival Ascended")).toBe("both");
  });

  it("marks an ASE-only creature as ASE, not ASA", () => {
    expect(detectGame("This creature is not yet available in ARK: Survival Ascended.")).toBe(
      "ASE",
    );
  });

  it("admits when it cannot tell", () => {
    expect(detectGame("A big lizard.")).toBe("unknown");
  });
});

describe("detectMod", () => {
  it("reads the mod out of a Mod: page title", () => {
    expect(detectMod("Mod:Additions Ascended/Edmontonia")).toBe("Additions Ascended");
  });

  it("returns nothing for base-game pages", () => {
    expect(detectMod("Rex")).toBe("");
  });
});

// ---------------------------------------------------------------------------

describe("resolveRef", () => {
  it("resolves an item link against the item catalog", () => {
    const r = resolveRef({ name: "Narcotic", kind: "item" }, nameIndex);
    expect(r.referenceType).toBe("item");
    expect(catalogIndex.items.has(normalizeBpPath(r.bpPath))).toBe(true);
  });

  it("resolves a creature link against the creature catalog", () => {
    const r = resolveRef({ name: "Rex", kind: "creature" }, nameIndex);
    expect(r.referenceType).toBe("creature");
    expect(catalogIndex.creatures.has(normalizeBpPath(r.bpPath))).toBe(true);
  });

  it("never resolves an item link to a creature", () => {
    // "Rex" is a creature; asked for as an item it must not resolve at all.
    expect(resolveRef({ name: "Rex", kind: "item" }, nameIndex)).toEqual({
      bpPath: "",
      referenceType: "text",
    });
  });

  it("leaves an ambiguous untyped name unresolved rather than guessing", () => {
    const both = buildNameIndex([
      {
        ...(officialSource as ContentSource),
        creatures: [{ id: "c", name: "Ambergris", bpPath: "/Game/C.C" }],
        items: [{ id: "i", name: "Ambergris", bpPath: "/Game/I.I" }],
      },
    ]);
    expect(resolveRef({ name: "Ambergris", kind: "unknown" }, both)).toEqual({
      bpPath: "",
      referenceType: "text",
    });
  });

  it("leaves an unknown name as free text", () => {
    expect(resolveRef({ name: "Nonexistent Thing", kind: "unknown" }, nameIndex).bpPath).toBe(
      "",
    );
  });
});

describe("findStaleRefs", () => {
  it("reports a catalog reference that no longer exists", () => {
    const info: CreatureInfo = {
      ...emptyCreatureInfo(),
      methods: [
        {
          id: "m",
          name: "Knockout tame",
          outcome: "direct-tame",
          tags: [],
          requirements: "",
          inputs: [
            {
              id: "i",
              referenceType: "item",
              bpPath: "/Game/Removed/Mod_Item.Mod_Item",
              label: "Mod Item",
              role: "taming-food",
              qty: "",
              note: "",
            },
          ],
          phases: [],
          repeatUntil: "",
          completion: "",
          failure: "",
          effectiveness: "",
          strategy: "",
        },
      ],
    };
    expect(findStaleRefs(info, catalogIndex)).toEqual([
      { kind: "item", name: "Mod Item", where: "Knockout tame → inputs" },
    ]);
  });

  it("says nothing about free-text inputs", () => {
    const info: CreatureInfo = {
      ...emptyCreatureInfo(),
      methods: [
        {
          ...CreatureInfoSchema.parse({
            methods: [{ id: "m", name: "x" }],
          }).methods[0],
          inputs: [
            {
              id: "i",
              referenceType: "text",
              bpPath: "",
              label: "A fully grown Rex",
              role: "host-creature",
              qty: "",
              note: "",
            },
          ],
        },
      ],
    };
    expect(findStaleRefs(info, catalogIndex)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("buildImportRecord", () => {
  const rexPage = page({
    wikitext: [
      "The '''Rex''' is a large carnivore.",
      "",
      "== Taming ==",
      "The Rex must be knocked out to raise its torpor, then fed.",
      "* Shoot it with tranquilizer arrows",
      "* Feed it {{ItemLink|Raw Meat}} and keep {{ItemLink|Narcotic}} handy",
    ].join("\n"),
  });

  it("stages a pending proposal, never a live record", () => {
    const r = buildImportRecord(rexPage, opts);
    expect(r.status).toBe("pending");
    expect(r.reviewedAt).toBeNull();
  });

  it("records the provenance a reviewer needs", () => {
    const r = buildImportRecord(rexPage, opts);
    expect(r.source.page).toBe("Rex");
    expect(r.source.revisionId).toBe(1234);
    expect(r.source.section).toBe("Taming");
    expect(r.source.url).toContain("ark.wiki.gg");
    expect(Date.parse(r.source.importedAt)).not.toBeNaN();
  });

  it("keeps the original wiki text for comparison", () => {
    const r = buildImportRecord(rexPage, opts);
    expect(r.rawText.Taming).toContain("{{ItemLink|Raw Meat}}");
  });

  it("maps the text into the acquisition schema", () => {
    const r = buildImportRecord(rexPage, opts);
    expect(r.proposed.availability).toBe("acquirable");
    expect(r.proposed.methods[0].tags).toContain("knockout");
    expect(r.proposed.methods[0].phases[0].steps.length).toBeGreaterThan(0);
    expect(CreatureInfoSchema.safeParse(r.proposed).success).toBe(true);
  });

  it("resolves item links against the item catalog", () => {
    const r = buildImportRecord(rexPage, opts);
    const paths = r.proposed.methods[0].inputs.map((i) => normalizeBpPath(i.bpPath));
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(catalogIndex.items.has(p)).toBe(true);
  });

  it("never claims high confidence for a parsed page", () => {
    // Roles are always defaulted, so there is always something to check.
    expect(buildImportRecord(rexPage, opts).confidence).toBe("needs-review");
    expect(buildImportRecord(rexPage, opts).ambiguities.join(" ")).toMatch(/set each role/i);
  });

  it("reports an item link the catalog does not have", () => {
    const r = buildImportRecord(
      page({ wikitext: "== Taming ==\nknock it out, then feed {{ItemLink|Void Wyrm Pheromone}}" }),
      opts,
    );
    expect(r.unresolved).toContainEqual({
      kind: "item",
      name: "Void Wyrm Pheromone",
      where: "Taming section",
    });
  });

  it("proposes nothing but availability for an untameable creature", () => {
    const r = buildImportRecord(
      page({ wikitext: "== Taming ==\nThe Alpha Rex cannot be tamed." }),
      opts,
    );
    expect(r.proposed.availability).toBe("unavailable");
    expect(r.proposed.methods).toEqual([]);
  });

  it("flags a page with no acquisition section instead of inventing one", () => {
    const r = buildImportRecord(page({ wikitext: "just a lead paragraph" }), opts);
    expect(r.proposed.methods).toEqual([]);
    expect(r.ambiguities.join(" ")).toMatch(/no taming or acquisition section/i);
  });

  it("flags a creature it cannot attach to the catalog", () => {
    const r = buildImportRecord(page({ page: "Notacreature" }), opts);
    expect(r.bpPath).toBe("");
    expect(r.ambiguities.join(" ")).toMatch(/does not match any creature/i);
  });

  it("names the mod for a modded page and uses the creature, not the mod, as the target", () => {
    const r = buildImportRecord(
      page({ page: "Mod:Additions Ascended/Edmontonia", wikitext: "== Taming ==\nhelp it fight" }),
      opts,
    );
    expect(r.source.mod).toBe("Additions Ascended");
    expect(r.creatureName).toBe("Edmontonia");
  });

  it("flags a variant whose proposal only duplicates what it inherits", () => {
    const parent = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
    const first = buildImportRecord(rexPage, opts);
    const child = buildImportRecord(rexPage, {
      ...opts,
      variantParents: { [normalizeBpPath(first.bpPath)]: parent },
      creatureInfo: { [normalizeBpPath(parent)]: first.proposed },
    });
    expect(child.duplicatesParent).toBe(true);
    expect(child.ambiguities.join(" ")).toMatch(/already inherits/i);
  });
});

// ---------------------------------------------------------------------------

describe("fixture import", () => {
  const records = importFixtures(CREATURE_FIXTURES, { catalogIndex });

  it("stages every fixture as a pending proposal", () => {
    expect(records).toHaveLength(CREATURE_FIXTURES.length);
    expect(records.every((r) => r.status === "pending")).toBe(true);
  });

  it("every proposal is valid against the live schema", () => {
    for (const r of records) {
      expect(CreatureInfoSchema.safeParse(r.proposed).success, r.creatureName).toBe(true);
    }
  });

  it("carries wiki provenance onto every record", () => {
    for (const r of records) {
      expect(r.source.page, r.creatureName).toBeTruthy();
      expect(r.source.revisionId, r.creatureName).toBeGreaterThan(0);
      expect(r.source.url).toContain("ark.wiki.gg");
    }
  });

  it("finds no stale references in the verified set", () => {
    const stale = records.flatMap((r) =>
      r.unresolved.map((u) => `${r.creatureName}: ${u.name}`),
    );
    expect(stale).toEqual([]);
  });

  it("flags the inherited variant instead of staging a duplicate record", () => {
    const aberrant = records.find((r) => r.creatureName === "Aberrant Gigantoraptor")!;
    expect(aberrant.duplicatesParent).toBe(true);
    expect(aberrant.proposed.methods).toEqual([]);
    expect(aberrant.proposed.overrides).toEqual([]);
  });

  it("does not flag an ordinary creature as an inherited duplicate", () => {
    expect(records.find((r) => r.creatureName === "Rex")!.duplicatesParent).toBe(false);
  });

  it("distinguishes modded content from base game", () => {
    const edmontonia = records.find((r) => r.creatureName === "Edmontonia")!;
    expect(edmontonia.source.mod).toBeTruthy();
    expect(records.find((r) => r.creatureName === "Rex")!.source.mod).toBe("");
  });

  it("reports which sections a record actually proposes", () => {
    const rex = records.find((r) => r.creatureName === "Rex")!;
    expect(proposedSections(rex)).toContain("acquisition");
    expect(proposedSections(records.find((r) => r.creatureName === "Aberrant Gigantoraptor")!))
      .toEqual([]);
  });

  it("a second identical run supersedes nothing — reviews survive reimport", () => {
    const again = importFixtures(CREATURE_FIXTURES, { catalogIndex });
    const merged = mergeReimport(records, again);
    expect(merged.superseded).toEqual([]);
    expect(merged.unchanged).toHaveLength(records.length);
    expect(merged.records).toHaveLength(records.length);
  });

  it("a newer wiki revision supersedes the old proposal instead of replacing it", () => {
    const bumped = importFixtures(
      [{ ...CREATURE_FIXTURES[0], source: { ...CREATURE_FIXTURES[0].source, revisionId: 999999 } }],
      { catalogIndex },
    );
    const merged = mergeReimport(records, bumped);
    expect(merged.superseded).toHaveLength(1);
    expect(merged.records.filter((r) => r.creatureName === CREATURE_FIXTURES[0].name)).toHaveLength(
      2,
    );
  });
});
