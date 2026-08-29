import { describe, expect, it } from "vitest";
import {
  parseProduction,
  productionToText,
  serializeProduction,
} from "./production";
import { parseRemaps, remapsToText, serializeRemaps } from "./remaps";
import {
  parseCosmetics,
  serializeCosmetics,
  validateCosmeticsText,
} from "./cosmetics";
import {
  activeEntries,
  CosmeticsDraftSchema,
  deprecatedEntries,
} from "../model/cosmetics";

const SAMPLE_PRODUCTION = {
  version: 2,
  production: [
    {
      dinoType:
        "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP",
      chanceToProduce: 1.0,
      produces: [
        {
          name: "Achatina Paste Production",
          intervalSeconds: 120,
          itemSelectMode: 0,
          items: [
            {
              bpPath:
                "/Game/PrimalEarth/Dinos/Achatina/PrimalItemResource_SnailPaste.PrimalItemResource_SnailPaste",
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
        {
          // No name on this cycle - name must stay absent after round-trip.
          intervalSeconds: 3600,
          itemSelectMode: 1,
          items: [
            {
              bpPath:
                "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Crystal.PrimalItemResource_Crystal",
              quantityPerDino: 2,
              maxQuantityPerCycle: 20,
              maxQuantityInTerminal: 200,
              alternateSelectMode: 1,
              alternateItemsChance: 0.25,
              alternateItems: [
                {
                  bpPath:
                    "/Game/PrimalEarth/CoreBlueprints/Resources/PrimalItemResource_Keratin.PrimalItemResource_Keratin",
                  quantityPerItem: 2,
                  maxQuantityPerCycle: 20,
                  maxQuantityInTerminal: 200,
                },
              ],
              consumesSelectMode: 0,
              consumesItemsChance: 1,
              consumesItems: [
                {
                  bpPath:
                    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_Berry_Mejoberry.PrimalItemConsumable_Berry_Mejoberry",
                  quantityPerItem: 2,
                  maxQuantityPerCycle: 0,
                  maxQuantityInTerminal: 0,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("production serializer", () => {
  it("round-trips a published file without semantic changes", () => {
    const text = JSON.stringify(SAMPLE_PRODUCTION, null, 2);
    const draft = parseProduction(text);
    const output = serializeProduction(draft);
    expect(output).toEqual(SAMPLE_PRODUCTION);
  });

  it("omits disabled rules from output", () => {
    const draft = parseProduction(JSON.stringify(SAMPLE_PRODUCTION));
    draft.rules[0].enabled = false;
    expect(serializeProduction(draft).production).toHaveLength(0);
  });

  it("omits empty cycle names but keeps non-empty ones", () => {
    const draft = parseProduction(JSON.stringify(SAMPLE_PRODUCTION));
    const output = serializeProduction(draft);
    expect(output.production[0].produces[0].name).toBe(
      "Achatina Paste Production",
    );
    expect("name" in output.production[0].produces[1]).toBe(false);
  });

  it("rejects files with the wrong version", () => {
    expect(() =>
      parseProduction(JSON.stringify({ version: 1, production: [] })),
    ).toThrow(/version/);
  });

  it("rejects non-JSON input", () => {
    expect(() => parseProduction("nonsense{")).toThrow(/Not valid JSON/);
  });

  it("emits stable key order in text output", () => {
    const draft = parseProduction(JSON.stringify(SAMPLE_PRODUCTION));
    const text = productionToText(draft);
    const dinoTypeIdx = text.indexOf('"dinoType"');
    const chanceIdx = text.indexOf('"chanceToProduce"');
    const producesIdx = text.indexOf('"produces"');
    expect(dinoTypeIdx).toBeGreaterThan(-1);
    expect(chanceIdx).toBeGreaterThan(dinoTypeIdx);
    expect(producesIdx).toBeGreaterThan(chanceIdx);
  });
});

const SAMPLE_REMAPS = {
  dinoMappings: [
    {
      fromClass:
        "/AAHelicoprion/Dinos/HelicoprionAA_Character_BP.HelicoprionAA_Character_BP_C",
      toClass:
        "/Game/ASA/Dinos/Helicoprion/Helicoprion_Character_BP.Helicoprion_Character_BP_C",
    },
    {
      fromClass:
        "/PortsOfAtlas/Creatures/GrandTortugar/GrandTortugar_Character_BP.GrandTortugar_Character_BP_C",
      toClass:
        "/Game/ASA/Dinos/GrandTortugar/GrandTortugar_Character_BP.GrandTortugar_Character_BP_C",
    },
  ],
};

describe("remaps serializer", () => {
  it("round-trips a published remap file", () => {
    const draft = parseRemaps(JSON.stringify(SAMPLE_REMAPS));
    expect(serializeRemaps(draft)).toEqual(SAMPLE_REMAPS);
  });

  it("excludes inactive entries", () => {
    const draft = parseRemaps(JSON.stringify(SAMPLE_REMAPS));
    draft.entries[0].active = false;
    const output = serializeRemaps(draft);
    expect(output.dinoMappings).toHaveLength(1);
    expect(output.dinoMappings[0].fromClass).toContain("PortsOfAtlas");
  });

  it("produces stable text output", () => {
    const draft = parseRemaps(JSON.stringify(SAMPLE_REMAPS));
    expect(JSON.parse(remapsToText(draft))).toEqual(SAMPLE_REMAPS);
  });
});

describe("cosmetics serializer", () => {
  const SAMPLE = "1380750|1|1|,975527|1|1|,1039530|1|0|";

  it("round-trips a published CCM list", () => {
    const draft = parseCosmetics(SAMPLE);
    expect(serializeCosmetics(draft)).toBe(SAMPLE);
  });

  it("parses toggles correctly", () => {
    const draft = parseCosmetics(SAMPLE);
    expect(draft.entries[2].allowNonDataOnlyBlueprints).toBe(false);
    expect(draft.entries[2].enableDynamicDownload).toBe(true);
  });

  it("excludes non-included entries", () => {
    const draft = parseCosmetics(SAMPLE);
    draft.entries[1].included = false;
    expect(serializeCosmetics(draft)).toBe("1380750|1|1|,1039530|1|0|");
  });

  it("rejects malformed entries", () => {
    expect(() => parseCosmetics("1380750|1|1")).toThrow(/Invalid CCM entry/);
    expect(() => parseCosmetics("1380750|2|1|")).toThrow(/Invalid CCM entry/);
    expect(() => parseCosmetics("1380750|1|1|975527|1|1|")).toThrow(
      /Invalid CCM entry/,
    );
  });

  it("rejects duplicate mod ids", () => {
    expect(() => parseCosmetics("1|1|1|,1|1|1|")).toThrow(/Duplicate/);
  });

  it("validateCosmeticsText flags problems", () => {
    expect(validateCosmeticsText(SAMPLE)).toEqual([]);
    expect(validateCosmeticsText("123|1|1|,")).toContain(
      "Trailing comma after final entry",
    );
  });

  it("handles empty input", () => {
    const draft = parseCosmetics("");
    expect(draft.entries).toHaveLength(0);
    expect(serializeCosmetics(draft)).toBe("");
  });

  it("holds deprecated entries out of the published list", () => {
    const draft = parseCosmetics(SAMPLE);
    draft.entries[1].deprecatedAt = "2026-08-08T00:00:00.000Z";
    expect(serializeCosmetics(draft)).toBe("1380750|1|1|,1039530|1|0|");
  });

  it("keeps a deprecated entry excluded even though it is still 'included'", () => {
    // The two flags mean different things: `included` is the admin's choice,
    // `deprecatedAt` is CurseForge's. Either one alone must hold it back.
    const draft = parseCosmetics(SAMPLE);
    for (const entry of draft.entries) {
      entry.deprecatedAt = "2026-08-08T00:00:00.000Z";
      expect(entry.included).toBe(true);
    }
    expect(serializeCosmetics(draft)).toBe("");
  });

  it("publishes a restored entry again", () => {
    const draft = parseCosmetics(SAMPLE);
    draft.entries[0].deprecatedAt = "2026-08-08T00:00:00.000Z";
    expect(serializeCosmetics(draft)).not.toContain("1380750");
    draft.entries[0].deprecatedAt = null;
    expect(serializeCosmetics(draft)).toBe(SAMPLE);
  });

  it("splits entries into active and deprecated", () => {
    const draft = parseCosmetics(SAMPLE);
    draft.entries[2].deprecatedAt = "2026-08-08T00:00:00.000Z";
    expect(activeEntries(draft).map((e) => e.modId)).toEqual([
      "1380750",
      "975527",
    ]);
    expect(deprecatedEntries(draft).map((e) => e.modId)).toEqual(["1039530"]);
  });

  it("loads a cosmetics file written before deprecation existed", () => {
    // Old projects have no `deprecatedAt` and no `lastScrape`; they must parse
    // and keep publishing exactly what they published before.
    const legacy = {
      schemaVersion: 1,
      lastScrapeAt: null,
      entries: [
        {
          id: "a",
          modId: "1380750",
          enableDynamicDownload: true,
          allowNonDataOnlyBlueprints: true,
          included: true,
          name: "Old",
          url: "",
          updated: "",
          notes: "",
        },
      ],
    };
    const parsed = CosmeticsDraftSchema.parse(legacy);
    expect(parsed.entries[0].deprecatedAt).toBeNull();
    expect(parsed.lastScrape).toBeNull();
    expect(serializeCosmetics(parsed)).toBe("1380750|1|1|");
  });
});
