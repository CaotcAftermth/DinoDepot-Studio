import { describe, expect, it } from "vitest";
import { validateProduction } from "./production";
import { buildCatalogIndex } from "../model/catalog";
import {
  CreatureRule,
  emptyProductionDraft,
  PrimaryItem,
} from "../model/production";

function makeItem(overrides: Partial<PrimaryItem> = {}): PrimaryItem {
  return {
    id: "item-1",
    bpPath:
      "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Hide.PrimalItemResource_Hide",
    quantityPerDino: 5,
    maxQuantityPerCycle: 0,
    maxQuantityInTerminal: 0,
    alternateSelectMode: 0,
    alternateItemsChance: 0,
    alternateItems: [],
    consumesSelectMode: 0,
    consumesItemsChance: 0,
    consumesItems: [],
    ...overrides,
  };
}

function makeRule(overrides: Partial<CreatureRule> = {}): CreatureRule {
  return {
    id: "rule-1",
    enabled: true,
    notes: "",
    dinoType:
      "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP",
    chanceToProduce: 1,
    cycles: [
      {
        id: "cycle-1",
        name: "",
        intervalSeconds: 300,
        itemSelectMode: 0,
        items: [makeItem()],
      },
    ],
    ...overrides,
  };
}

function draftWith(...rules: CreatureRule[]) {
  return { ...emptyProductionDraft(), rules };
}

const TEST_CATALOG = buildCatalogIndex({
  sources: [
    {
      id: "src-1",
      name: "Test Mod",
      kind: "mod",
      curseforgeId: "",
      url: "",
      docsUrl: "",
      discordUrl: "",
      iconsDir: "",
      iniNotes: "",
      iniSettings: [],
      iniBuild: {},
      variantTag: "",
      modpackId: "",
      modpackVersion: "",
      enabled: true,
      removed: false,
      notes: "",
      creatures: [
        {
          id: "c1",
          name: "Achatina",
          bpPath:
            "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP",
        },
      ],
      items: [
        {
          id: "i1",
          name: "Hide",
          bpPath:
            "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Hide.PrimalItemResource_Hide",
        },
      ],
    },
    {
      id: "src-removed",
      name: "Removed Mod",
      kind: "mod",
      curseforgeId: "",
      url: "",
      docsUrl: "",
      discordUrl: "",
      iconsDir: "",
      iniNotes: "",
      iniSettings: [],
      iniBuild: {},
      variantTag: "",
      modpackId: "",
      modpackVersion: "",
      enabled: true,
      removed: true,
      notes: "",
      creatures: [
        {
          id: "c2",
          name: "OldDino",
          bpPath: "/OldMod/Dinos/OldDino_Character_BP.OldDino_Character_BP",
        },
      ],
      items: [],
    },
  ],
});

describe("validateProduction", () => {
  it("passes a clean draft", () => {
    const issues = validateProduction(draftWith(makeRule()), TEST_CATALOG);
    expect(issues).toEqual([]);
  });

  it("flags duplicate dinoTypes as errors", () => {
    const issues = validateProduction(
      draftWith(makeRule(), makeRule({ id: "rule-2" })),
      TEST_CATALOG,
    );
    expect(issues.some((i) => i.level === "error" && /Duplicate/.test(i.message))).toBe(true);
  });

  it("ignores disabled rules", () => {
    const issues = validateProduction(
      draftWith(makeRule({ enabled: false, dinoType: "" })),
      TEST_CATALOG,
    );
    expect(issues).toEqual([]);
  });

  it("catches duplicates that differ only by case or a trailing _C", () => {
    const base = makeRule();
    for (const variant of [
      base.dinoType.toUpperCase(),
      `${base.dinoType}_C`,
      `  ${base.dinoType}  `,
    ]) {
      const issues = validateProduction(
        draftWith(base, makeRule({ id: "rule-2", dinoType: variant })),
        TEST_CATALOG,
      );
      expect(
        issues.some((i) => i.level === "error" && /Duplicate creature/.test(i.message)),
        variant,
      ).toBe(true);
    }
  });

  it("warns when an enabled rule shares a creature with a disabled one", () => {
    // The editor won't let this be created, but an imported file can carry it.
    const issues = validateProduction(
      draftWith(
        makeRule(),
        makeRule({ id: "rule-2", enabled: false }),
      ),
      TEST_CATALOG,
    );
    const warning = issues.find((i) => /A disabled rule/.test(i.message));
    expect(warning?.level).toBe("warning");
    // Still not an error — a disabled rule publishes nothing.
    expect(issues.some((i) => i.level === "error")).toBe(false);
  });

  it("does not warn about a disabled rule for a different creature", () => {
    const issues = validateProduction(
      draftWith(
        makeRule(),
        makeRule({
          id: "rule-2",
          enabled: false,
          dinoType:
            "/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP",
        }),
      ),
      TEST_CATALOG,
    );
    expect(issues.some((i) => /A disabled rule/.test(i.message))).toBe(false);
  });

  it("flags out-of-range chances", () => {
    const issues = validateProduction(
      draftWith(makeRule({ chanceToProduce: 1.5 })),
      TEST_CATALOG,
    );
    expect(issues.some((i) => i.level === "error" && /chanceToProduce/.test(i.message))).toBe(true);
  });

  it("flags bad interval", () => {
    const rule = makeRule();
    rule.cycles[0].intervalSeconds = 0;
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => i.level === "error" && /intervalSeconds/.test(i.message))).toBe(true);
  });

  it("flags malformed blueprint paths", () => {
    const rule = makeRule({ dinoType: "not a path" });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => i.level === "error" && /blueprint path/.test(i.message))).toBe(true);
  });

  it("warns when creature is not in catalog", () => {
    const rule = makeRule({
      dinoType: "/Unknown/Dinos/Mystery_BP.Mystery_BP",
    });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => i.level === "warning" && /not in the catalog/.test(i.message))).toBe(true);
  });

  it("warns when creature belongs to a removed source", () => {
    const rule = makeRule({
      dinoType: "/OldMod/Dinos/OldDino_Character_BP.OldDino_Character_BP",
    });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => i.level === "warning" && /being removed/.test(i.message))).toBe(true);
  });

  it("warns on per-cycle cap exceeding terminal cap", () => {
    const rule = makeRule();
    rule.cycles[0].items[0] = makeItem({
      maxQuantityPerCycle: 100,
      maxQuantityInTerminal: 50,
    });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => /exceeds maxQuantityInTerminal/.test(i.message))).toBe(true);
  });

  it("warns on alternate chance without alternates", () => {
    const rule = makeRule();
    rule.cycles[0].items[0] = makeItem({ alternateItemsChance: 0.5 });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.some((i) => /no alternate items/.test(i.message))).toBe(true);
  });

  it("accepts class paths with _C suffix against the catalog", () => {
    const rule = makeRule({
      dinoType:
        "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP_C",
    });
    const issues = validateProduction(draftWith(rule), TEST_CATALOG);
    expect(issues.filter((i) => /not in the catalog/.test(i.message))).toEqual([]);
  });
});
