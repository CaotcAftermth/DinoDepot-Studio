import { describe, expect, it } from "vitest";
import {
  classStem,
  detectSourceTag,
  matchOfficialByClass,
  proposeCleanName,
  resolveCreatureBase,
  variantParent,
} from "./creatureBase";
import { normalizeBpPath, type ContentSource } from "./catalog";
import { baseCreatureName } from "./variants";

/** Real paths taken from the GG Fizz test catalogs. */
const ARKOLOGY_ACHATINA =
  "/ARKOLOGY_NEWENCOUNTERS/ARKOLOGY/Variants/Achatina/ARKOLOGY_Achatina_Character_BP.ARKOLOGY_Achatina_Character_BP_C";
const ARKOLOGY_SPIDER =
  "/ARKOLOGY_NEWENCOUNTERS/ARKOLOGY/Variants/SpiderS/ARKOLOGY_SpiderS_Character_BP.ARKOLOGY_SpiderS_Character_BP_C";
const ZYTHARIAN_ACHATINA =
  "/Zytharian_Critters_Tek_Collection/Creatures/Tek_Achatina/Achatina_Character_BP_Tek.Achatina_Character_BP_Tek_C";
const NOUNTAMEABLE_AMMONITE =
  "/NoUntameables/Ammonite/Ammonite_Character_Tameable.Ammonite_Character_Tameable";
const NOUNTAMEABLE_AMMONITE_AB =
  "/NoUntameables/Ammonite/Ammonite_Character_Aberrant_Tameable.Ammonite_Character_Aberrant_Tameable";
const VANILLA_ACHATINA =
  "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP";
const VANILLA_ABERRANT_ACHATINA =
  "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP_Aberrant.Achatina_Character_BP_Aberrant";

const entry = (name: string, bpPath: string) => ({ id: name, name, bpPath });

describe("classStem", () => {
  it("takes the class name and drops the _C suffix", () => {
    expect(classStem(ARKOLOGY_ACHATINA)).toBe("ARKOLOGY_Achatina_Character_BP");
    expect(classStem(VANILLA_ACHATINA)).toBe("Achatina_Character_BP");
  });
});

describe("matchOfficialByClass", () => {
  it("resolves a mod prefix convention", () => {
    expect(matchOfficialByClass(ARKOLOGY_ACHATINA)?.name).toBe("Achatina");
  });

  it("resolves a mod suffix convention", () => {
    expect(matchOfficialByClass(ZYTHARIAN_ACHATINA)?.name).toBe("Achatina");
    expect(matchOfficialByClass(NOUNTAMEABLE_AMMONITE)?.name).toBe("Ammonite");
    expect(matchOfficialByClass(NOUNTAMEABLE_AMMONITE_AB)?.name).toBe("Ammonite");
  });

  it("recovers the real creature when the display name is meaningless", () => {
    // ARKOLOGY SpiderS -> Araneo, which no name-based heuristic could find.
    expect(matchOfficialByClass(ARKOLOGY_SPIDER)?.name).toBe("Araneo");
  });

  it("respects token boundaries so MegaRex is not a Rex", () => {
    const mega = matchOfficialByClass(
      "/Game/PrimalEarth/Dinos/Rex/MegaRex_Character_BP.MegaRex_Character_BP",
    );
    expect(mega?.name).toBe("Alpha T-Rex");
  });

  it("returns null for content with no vanilla counterpart", () => {
    expect(
      matchOfficialByClass("/SomeMod/Dinos/Wyvernlord_Character_BP.Wyvernlord_Character_BP"),
    ).toBeNull();
  });
});

describe("resolveCreatureBase", () => {
  const keyOf = (bpPath: string) => normalizeBpPath(bpPath);

  it("groups modded variants under the vanilla creature", () => {
    const arkology = resolveCreatureBase(entry("ARKOLOGY Achatina", ARKOLOGY_ACHATINA));
    const zytharian = resolveCreatureBase(entry("Achatina", ZYTHARIAN_ACHATINA));
    expect(arkology.label).toBe("Achatina");
    expect(arkology.key).toBe(keyOf(VANILLA_ACHATINA));
    expect(zytharian.key).toBe(arkology.key);
  });

  it("gives vanilla variants the same key as modded ones", () => {
    const aberrant = resolveCreatureBase(
      entry("Aberrant Achatina", VANILLA_ABERRANT_ACHATINA),
    );
    const arkology = resolveCreatureBase(entry("ARKOLOGY Achatina", ARKOLOGY_ACHATINA));
    expect(aberrant.key).toBe(arkology.key);
  });

  it("exposes the base blueprint path for icon inheritance", () => {
    const resolved = resolveCreatureBase(entry("ARKOLOGY SpiderS", ARKOLOGY_SPIDER));
    expect(resolved.label).toBe("Araneo");
    expect(resolved.bpPath).toContain("SpiderS_Character_BP");
  });

  it("lets a manual parent win over everything", () => {
    const resolved = resolveCreatureBase(
      entry("ARKOLOGY Achatina", ARKOLOGY_ACHATINA),
      { parentPath: "/Mod/Dinos/Custom_BP.Custom_BP", parentName: "Custom" },
    );
    expect(resolved.label).toBe("Custom");
  });

  it("falls back to the tag-stripped name for non-vanilla content", () => {
    const resolved = resolveCreatureBase(
      entry("ARKOLOGY Wyvernlord", "/ARKOLOGY/Dinos/Wyvernlord_BP.Wyvernlord_BP"),
      { variantTag: "ARKOLOGY" },
    );
    expect(resolved.label).toBe("Wyvernlord");
    expect(resolved.bpPath).toBeNull();
  });
});

describe("baseCreatureName", () => {
  it("strips any trailing parenthetical", () => {
    expect(baseCreatureName("Anomalocaris (TSW)")).toBe("Anomalocaris");
    expect(baseCreatureName("Broodmother Lysrix (Gamma)")).toBe("Broodmother Lysrix");
  });

  it("strips a supplied mod tag as prefix or suffix", () => {
    expect(baseCreatureName("ARKOLOGY Achatina", "ARKOLOGY")).toBe("Achatina");
    expect(baseCreatureName("Achatina Tek", "Tek")).toBe("Achatina");
  });

  it("still strips vanilla prefixes", () => {
    expect(baseCreatureName("Aberrant Achatina")).toBe("Achatina");
  });
});

describe("detectSourceTag", () => {
  const source = (creatures: { name: string; bpPath: string }[]): ContentSource => ({
    id: "s",
    name: "Test",
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
    creatures: creatures.map((c) => ({ id: c.name, ...c })),
    items: [],
  });

  it("finds a display-name prefix tag", () => {
    const tag = detectSourceTag(
      source([
        { name: "ARKOLOGY Achatina", bpPath: ARKOLOGY_ACHATINA },
        { name: "ARKOLOGY SpiderS", bpPath: ARKOLOGY_SPIDER },
        { name: "ARKOLOGY Basilisk", bpPath: "/ARKOLOGY_NEWENCOUNTERS/ARKOLOGY/Variants/Basilisk/ARKOLOGY_Basilisk_Character_BP.ARKOLOGY_Basilisk_Character_BP_C" },
      ]),
    );
    expect(tag?.toUpperCase()).toBe("ARKOLOGY");
  });

  it("finds a class-only suffix tag", () => {
    const tag = detectSourceTag(
      source([
        { name: "Achatina", bpPath: ZYTHARIAN_ACHATINA },
        { name: "Ankylo", bpPath: "/Zytharian_Critters_Tek_Collection/Creatures/Tek_Anky/Ankylo_Character_BP_Tek.Ankylo_Character_BP_Tek_C" },
        { name: "Baryonyx", bpPath: "/Zytharian_Critters_Tek_Collection/Creatures/Tek_Bary/Baryonyx_Character_BP_Tek.Baryonyx_Character_BP_Tek_C" },
      ]),
    );
    expect(tag?.toLowerCase()).toBe("tek");
  });

  it("returns null for a source with too few entries", () => {
    expect(detectSourceTag(source([{ name: "Achatina", bpPath: VANILLA_ACHATINA }]))).toBeNull();
  });
});

describe("proposeCleanName", () => {
  it("replaces a class-derived name with the real creature, keeping the tag", () => {
    expect(
      proposeCleanName(entry("ARKOLOGY SpiderS", ARKOLOGY_SPIDER), "ARKOLOGY"),
    ).toBe("ARKOLOGY Araneo");
  });

  it("keeps meaningful qualifiers from the class", () => {
    expect(
      proposeCleanName(
        entry("Ammonite Character Aberrant Tameable", NOUNTAMEABLE_AMMONITE_AB),
        "Tameable",
      ),
    ).toBe("Ammonite (Aberrant)");
  });

  it("proposes nothing when the name is already right", () => {
    expect(proposeCleanName(entry("Achatina", ZYTHARIAN_ACHATINA), "Tek")).toBeNull();
  });

  it("proposes nothing for official creatures", () => {
    expect(proposeCleanName(entry("Achatina", VANILLA_ACHATINA), "")).toBeNull();
  });
});


describe("variantParent", () => {
  it("resolves a modded variant to the official creature", () => {
    const parent = variantParent(entry("ARKOLOGY Achatina", ARKOLOGY_ACHATINA));
    expect(parent?.label).toBe("Achatina");
    expect(normalizeBpPath(parent!.bpPath!)).toBe(
      normalizeBpPath(VANILLA_ACHATINA),
    );
  });

  it("resolves a vanilla variant to its base creature", () => {
    expect(
      variantParent(entry("Aberrant Achatina", VANILLA_ABERRANT_ACHATINA))?.label,
    ).toBe("Achatina");
  });

  it("is null for the base creature itself", () => {
    expect(variantParent(entry("Achatina", VANILLA_ACHATINA))).toBeNull();
  });

  it("honours a manually assigned parent", () => {
    const parent = variantParent(entry("Odd One", "/Game/Mods/X/Odd.Odd"), {
      parentPath: VANILLA_ACHATINA,
      parentName: "Achatina",
    });
    expect(parent?.label).toBe("Achatina");
  });

  it("is null when nothing resolves", () => {
    expect(
      variantParent(entry("Wholly Invented", "/Game/Mods/X/Nope_BP.Nope_BP")),
    ).toBeNull();
  });
});
