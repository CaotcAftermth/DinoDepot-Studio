import { describe, expect, it } from "vitest";
import {
  findDuplicateRule,
  isUntouchedRule,
  resolveSelectionParent,
} from "./productionSelect";
import { buildCatalogIndex, type ContentSource } from "./catalog";
import { officialSource } from "./officialCatalog";
import type { CreatureRule } from "./production";

const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
const ABERRANT_REX =
  "/Game/Mods/X/Rex_Character_BP_Aberrant.Rex_Character_BP_Aberrant";
const DODO = "/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP";

function rule(over: Partial<CreatureRule> & { id: string }): CreatureRule {
  return {
    enabled: true,
    notes: "",
    dinoType: "",
    chanceToProduce: 1,
    cycles: [{ id: "c1", name: "", intervalSeconds: 300, itemSelectMode: 0, items: [] }],
    ...over,
  };
}

const mod: ContentSource = {
  id: "mod",
  name: "Ark Extras",
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
  creatures: [{ id: "m1", name: "Aberrant Rex", bpPath: ABERRANT_REX }],
  items: [],
};

const index = buildCatalogIndex({ sources: [officialSource, mod] });

describe("findDuplicateRule", () => {
  const existing = rule({ id: "r1", dinoType: REX });

  it("catches an exact duplicate", () => {
    expect(findDuplicateRule([existing], "r2", REX)?.id).toBe("r1");
  });

  it("catches a case-only difference", () => {
    expect(findDuplicateRule([existing], "r2", REX.toUpperCase())?.id).toBe("r1");
  });

  it("treats a trailing _C as the same class", () => {
    expect(findDuplicateRule([existing], "r2", `${REX}_C`)?.id).toBe("r1");
  });

  it("catches the reverse - stored with _C, typed without", () => {
    const withC = rule({ id: "r1", dinoType: `${REX}_C` });
    expect(findDuplicateRule([withC], "r2", REX)?.id).toBe("r1");
  });

  it("trims whitespace", () => {
    expect(findDuplicateRule([existing], "r2", `  ${REX}  `)?.id).toBe("r1");
  });

  it("does not flag a rule against itself", () => {
    expect(findDuplicateRule([existing], "r1", REX)).toBeNull();
  });

  it("does not flag a different creature", () => {
    expect(findDuplicateRule([existing], "r2", DODO)).toBeNull();
  });

  it("ignores rules that have no creature yet", () => {
    const blank = rule({ id: "r1", dinoType: "" });
    expect(findDuplicateRule([blank], "r2", "")).toBeNull();
    expect(findDuplicateRule([blank], "r2", REX)).toBeNull();
  });

  it("catches a duplicate of a disabled rule too", () => {
    const disabled = rule({ id: "r1", dinoType: REX, enabled: false });
    expect(findDuplicateRule([disabled], "r2", REX)?.id).toBe("r1");
  });

  it("treats a parent and its child class as different rules", () => {
    // Intentional variant-specific production stays possible: the variant
    // prompt is what covers this case, not the duplicate check.
    expect(findDuplicateRule([existing], "r2", ABERRANT_REX)).toBeNull();
  });

  it("is the same answer whether the path came from a picker or was typed", () => {
    const picked = findDuplicateRule([existing], "r2", REX);
    const typed = findDuplicateRule([existing], "r2", ` ${REX.toLowerCase()}_C `);
    expect(picked?.id).toBe(typed?.id);
  });
});

describe("isUntouchedRule", () => {
  it("recognises a freshly added rule", () => {
    expect(isUntouchedRule(rule({ id: "r1" }))).toBe(true);
  });

  it("does not discard a rule with a creature, notes, items or extra cycles", () => {
    expect(isUntouchedRule(rule({ id: "r1", dinoType: REX }))).toBe(false);
    expect(isUntouchedRule(rule({ id: "r1", notes: "why" }))).toBe(false);
    expect(
      isUntouchedRule(
        rule({
          id: "r1",
          cycles: [
            {
              id: "c1",
              name: "",
              intervalSeconds: 300,
              itemSelectMode: 0,
              items: [
                {
                  id: "i1",
                  bpPath: "/Game/X/Item.Item",
                  quantityPerDino: 1,
                  maxQuantityPerCycle: 0,
                  maxQuantityInTerminal: 0,
                  alternateSelectMode: 0,
                  alternateItemsChance: 0,
                  alternateItems: [],
                  consumesSelectMode: 0,
                  consumesItemsChance: 0,
                  consumesItems: [],
                },
              ],
            },
          ],
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveSelectionParent", () => {
  it("recognises a catalogued child class", () => {
    const parent = resolveSelectionParent(ABERRANT_REX, index, {});
    expect(parent?.bpPath).toBe(REX);
    expect(parent?.label).toBe("Rex");
  });

  it("returns nothing for the parent itself", () => {
    expect(resolveSelectionParent(REX, index, {})).toBeNull();
  });

  it("recognises a typed path that is in no content source", () => {
    // The class stem is enough - this is the manual-entry case.
    const parent = resolveSelectionParent(
      "/Game/Whatever/Rex_Character_BP_Homebrew.Rex_Character_BP_Homebrew",
      index,
      {},
    );
    expect(parent?.bpPath).toBe(REX);
  });

  it("honours a manually assigned parent over the class heuristics", () => {
    const parent = resolveSelectionParent(
      "/Game/Mods/Y/Mystery_Character_BP.Mystery_Character_BP",
      index,
      { "/game/mods/y/mystery_character_bp.mystery_character_bp": DODO },
    );
    expect(parent?.bpPath).toBe(DODO);
  });

  it("returns nothing for an empty or whitespace path", () => {
    expect(resolveSelectionParent("", index, {})).toBeNull();
    expect(resolveSelectionParent("   ", index, {})).toBeNull();
  });

  it("gives the same answer for a picked and a typed spelling of one class", () => {
    const picked = resolveSelectionParent(ABERRANT_REX, index, {});
    const typed = resolveSelectionParent(
      `  ${ABERRANT_REX.toLowerCase()}_C  `,
      index,
      {},
    );
    expect(typed?.bpPath).toBe(picked?.bpPath);
  });
});
