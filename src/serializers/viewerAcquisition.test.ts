import { describe, expect, it } from "vitest";
import { serializeViewerData } from "./viewer";
import { emptyCatalog, normalizeBpPath, type CatalogFile } from "../model/catalog";
import { emptyProductionDraft, type ProductionDraft } from "../model/production";
import {
  emptyAbilityEffectRow,
  emptyCreatureInfo,
  emptyDropEntry,
  emptyDrops,
  emptyMethod,
  emptyPhase,
} from "../model/creatureInfo";
import {
  defaultMaps,
  defaultProjectSettings,
  type ProjectSettings,
} from "../model/project";
import { newId } from "../model/ids";

/** Two real official paths so the catalog index resolves names. */
const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";
const ABERRANT_REX =
  "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP_Aberrant.Rex_Character_BP_Aberrant";
const CAKE =
  "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_SweetVeggieCake.PrimalItemConsumable_SweetVeggieCake";

function draftWith(...paths: string[]): ProductionDraft {
  return {
    ...emptyProductionDraft(),
    rules: paths.map((dinoType) => ({
      id: newId(),
      enabled: true,
      notes: "",
      dinoType,
      chanceToProduce: 1,
      cycles: [],
    })),
  };
}

function catalogWith(
  path: string,
  info: Partial<ReturnType<typeof emptyCreatureInfo>>,
): CatalogFile {
  const catalog = emptyCatalog();
  catalog.creatureInfo[normalizeBpPath(path)] = {
    ...emptyCreatureInfo(),
    ...info,
  };
  return catalog;
}

const knockout = () => ({
  ...emptyMethod("m1", "Knockout tame"),
  outcome: "direct-tame" as const,
  tags: ["knockout"],
  requirements: "Tranq arrows",
  inputs: [
    {
      id: "i1",
      referenceType: "item" as const,
      bpPath: CAKE,
      label: "",
      role: "taming-food",
      qty: "8",
      note: "best",
    },
    {
      id: "i2",
      referenceType: "creature" as const,
      bpPath: REX,
      label: "",
      role: "host-creature",
      qty: "drag weight 300+",
      note: "",
    },
    {
      id: "i3",
      referenceType: "text" as const,
      bpPath: "",
      label: "Ghillie armour",
      role: "optional-aid",
      qty: "",
      note: "",
    },
  ],
  phases: [
    {
      ...emptyPhase("p1", "Knock out"),
      note: "watch torpor",
      steps: [
        { id: "s1", text: "Trap it" },
        { id: "s2", text: "Tranq it" },
      ],
      failureOrReset: "adult aggro resets it",
    },
    {
      ...emptyPhase("p2", "Feed"),
      steps: [{ id: "s3", text: "Feed it" }],
    },
  ],
  repeatUntil: "The bar fills",
  failure: "It wakes up",
});

describe("viewer acquisition", () => {
  it("publishes the structured workflow", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    const data = serializeViewerData(draftWith(REX), catalog, "GG Fizz");
    const acq = data.creatures[0].acq!;

    expect(acq.availability).toBe("Acquirable");
    expect(acq.methods).toHaveLength(1);
    expect(acq.methods[0].name).toBe("Knockout tame");
    expect(acq.methods[0].tags).toEqual(["Knockout"]);
    expect(acq.methods[0].phases[0].steps).toEqual(["Trap it", "Tranq it"]);
    expect(acq.methods[0].repeatUntil).toBe("The bar fills");
  });

  it("resolves item, creature and free-text inputs against the right source", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    const data = serializeViewerData(draftWith(REX), catalog, "GG Fizz");
    const inputs = data.creatures[0].acq!.methods[0].inputs;

    // item -> item catalog
    expect(inputs[0].name).toBe("Sweet Vegetable Cake");
    expect(inputs[0].role).toBe("Taming food");
    // creature -> creature catalog, which is the whole point of correction 2
    expect(inputs[1].name).toBe("Rex");
    expect(inputs[1].role).toBe("Host creature");
    // free text -> its own label
    expect(inputs[2].name).toBe("Ghillie armour");
    expect(inputs[2].role).toBe("Optional aid");
  });

  it("publishes the method outcome", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    const acq = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .acq!;
    expect(acq.methods[0].outcome).toBe("Direct tame");
  });

  it("carries phase outcomes only for phases that use them", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    const phases = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .acq!.methods[0].phases;

    expect(phases[0].failureOrReset).toBe("adult aggro resets it");
    // The plain phase stays lean - no empty outcome keys published.
    expect(phases[1].failureOrReset).toBeUndefined();
    expect(phases[1].repeatUntil).toBeUndefined();
  });

  it("publishes abilities and drag weight", () => {
    const catalog = catalogWith(REX, {
      abilities: [{ id: "a", label: "Causes bleed", detail: "stacks 3x", kind: "active" as const, effect: "none" as const, rows: []  }],
      technical: { dragWeight: 550 },
    });
    const creature = serializeViewerData(draftWith(REX), catalog, "c").creatures[0];
    expect(creature.abilities).toEqual([
      {
        label: "Causes bleed",
        detail: "stacks 3x",
        kind: "active",
        effect: "none",
        rows: [],
      },
    ]);
    expect(creature.dragWeight).toBe(550);
  });

  it("omits acquisition entirely when nothing is recorded", () => {
    const data = serializeViewerData(draftWith(REX), emptyCatalog(), "c");
    expect(data.creatures[0].acq).toBeNull();
  });

  it("gives a variant its parent's workflow without duplicating the record", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    // The Aberrant variant stores nothing of its own.
    const data = serializeViewerData(
      draftWith(ABERRANT_REX),
      catalog,
      "GG Fizz",
    );
    const acq = data.creatures[0].acq!;
    expect(acq.methods[0].phases[0].steps).toEqual(["Trap it", "Tranq it"]);
    expect(acq.inheritedFrom).toBe("Rex");
  });

  it("lets a variant override its parent's workflow", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    catalog.creatureInfo[normalizeBpPath(ABERRANT_REX)] = {
      ...emptyCreatureInfo(),
      overrides: ["acquisition"],
      availability: "unavailable" as const,
      methods: [],
    };
    const acq = serializeViewerData(draftWith(ABERRANT_REX), catalog, "c")
      .creatures[0].acq!;
    expect(acq.availability).toBe("Unavailable");
    expect(acq.methods).toEqual([]);
    expect(acq.inheritedFrom).toBe("");
  });

  it("prefers structured notes but still publishes pre-redesign ones", () => {
    const structured = catalogWith(REX, { notes: "new notes" });
    expect(
      serializeViewerData(draftWith(REX), structured, "c").creatures[0].info,
    ).toBe("new notes");

    const legacy = emptyCatalog();
    legacy.notes[normalizeBpPath(REX)] = "old notes";
    expect(
      serializeViewerData(draftWith(REX), legacy, "c").creatures[0].info,
    ).toBe("old notes");
  });
});

// ---------------------------------------------------------------------------

describe("drops and maps", () => {
  const settingsWith = (disabled: string[]): ProjectSettings => ({
    ...defaultProjectSettings("p", "c", "test-project"),
    maps: defaultMaps().map((m) => ({
      ...m,
      enabled: !disabled.includes(m.name),
    })),
  });

  it("publishes the three drop lists, resolving catalog item names", () => {
    const catalog = catalogWith(REX, {
      drops: {
        harvest: [{ ...emptyDropEntry("d1", CAKE), qty: "2" }],
        guaranteed: [{ ...emptyDropEntry("d2"), label: "Rex Trophy" }],
        random: [{ ...emptyDropEntry("d3", CAKE), chance: "12%" }],
        production: [],
      },
    });
    const drops = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .drops;
    expect(drops.harvest[0].name).toBe("Sweet Vegetable Cake");
    expect(drops.harvest[0].qty).toBe("2");
    // Free text still publishes, just without a catalog reference.
    expect(drops.guaranteed[0]).toMatchObject({ ref: "", name: "Rex Trophy" });
    expect(drops.random[0].chance).toBe("12%");
  });

  it("never publishes odds on a list that has no odds", () => {
    const catalog = catalogWith(REX, {
      drops: {
        // Odds set on harvest would read as a guarantee being hedged.
        harvest: [{ ...emptyDropEntry("d1", CAKE), chance: "50%" }],
        guaranteed: [{ ...emptyDropEntry("d2", CAKE), chance: "50%" }],
        random: [],
        production: [],
      },
    });
    const drops = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .drops;
    expect(drops.harvest[0].chance).toBe("");
    expect(drops.guaranteed[0].chance).toBe("");
  });

  it("publishes spawn maps, falling back to the map of origin", () => {
    const withSpawns = catalogWith(REX, {
      spawnMaps: ["Ragnarok", "The Island"],
    });
    expect(
      serializeViewerData(draftWith(REX), withSpawns, "c").creatures[0].maps
        .spawns,
    ).toEqual(["Ragnarok", "The Island"]);

    // Nothing recorded: origin is derived from the blueprint path.
    const bare = serializeViewerData(draftWith(REX), emptyCatalog(), "c")
      .creatures[0].maps;
    expect(bare.spawns).toEqual([]);
    expect(bare.origin).toBe("The Island");
  });

  it("cautions only when every map it is known from is switched off", () => {
    const catalog = catalogWith(REX, {
      spawnMaps: ["Scorched Earth", "Ragnarok"],
    });
    const mapsOf = (disabled: string[]) =>
      serializeViewerData(
        draftWith(REX),
        catalog,
        "c",
        [],
        settingsWith(disabled),
      ).creatures[0].maps;

    // One running map is enough - it is plainly obtainable.
    expect(mapsOf(["Scorched Earth"]).caution).toBe(false);
    expect(mapsOf(["Scorched Earth", "Ragnarok"]).caution).toBe(true);
    expect(mapsOf([]).caution).toBe(false);
  });

  it("never cautions without settings to say which maps are off", () => {
    const catalog = catalogWith(REX, { spawnMaps: ["Scorched Earth"] });
    expect(
      serializeViewerData(draftWith(REX), catalog, "c").creatures[0].maps
        .caution,
    ).toBe(false);
  });

  it("cautions on the map of origin when there are no spawn maps", () => {
    const maps = serializeViewerData(
      draftWith(REX),
      emptyCatalog(),
      "c",
      [],
      settingsWith(["The Island"]),
    ).creatures[0].maps;
    expect(maps.caution).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("what reaches the public page", () => {
  it("publishes a creature nobody produces with, on the strength of its record", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    // No production rule at all - this is a lookup page, not only an atlas.
    const data = serializeViewerData(emptyProductionDraft(), catalog, "c");
    expect(data.creatures.map((c) => c.name)).toEqual(["Rex"]);
    expect(data.creatures[0].produces).toBe(false);
    expect(data.creatures[0].chance).toBe(0);
    expect(data.creatures[0].cycles).toEqual([]);
  });

  it("publishes a creature whose only record is a keeper note", () => {
    const catalog = emptyCatalog();
    catalog.notes[normalizeBpPath(REX)] = "Ours are kept at the north pen.";
    const data = serializeViewerData(emptyProductionDraft(), catalog, "c");
    expect(data.creatures).toHaveLength(1);
    expect(data.creatures[0].info).toBe("Ours are kept at the north pen.");
  });

  it("leaves out a record that says nothing", () => {
    // Claiming a section and then writing nothing in it must not put an empty
    // card on the public page.
    const catalog = catalogWith(REX, { overrides: ["acquisition"] });
    expect(
      serializeViewerData(emptyProductionDraft(), catalog, "c").creatures,
    ).toEqual([]);
  });

  it("gives a producing creature with a record a single card", () => {
    const catalog = catalogWith(REX, {
      availability: "acquirable" as const,
      methods: [knockout()],
    });
    const data = serializeViewerData(draftWith(REX), catalog, "c");
    expect(data.creatures).toHaveLength(1);
    expect(data.creatures[0].produces).toBe(true);
  });

  it("ignores a record for something the catalog has never heard of", () => {
    const catalog = catalogWith("/Game/Mods/Gone/Ghost.Ghost", {
      availability: "acquirable" as const,
    });
    expect(
      serializeViewerData(emptyProductionDraft(), catalog, "c").creatures,
    ).toEqual([]);
  });
});

describe("resources reached from creature drops", () => {
  it("lists an item that is only ever a drop, and says which list it came from", () => {
    const catalog = catalogWith(REX, {
      drops: {
        ...emptyDrops(),
        harvest: [{ ...emptyDropEntry("d1", CAKE), qty: "2" }],
        random: [{ ...emptyDropEntry("d2", CAKE), chance: "5%" }],
      },
    });
    const data = serializeViewerData(emptyProductionDraft(), catalog, "c");
    expect(data.items).toHaveLength(1);
    expect(data.items[0].name).toBe("Sweet Vegetable Cake");
    expect(data.items[0].from.harvest).toEqual([REX]);
    expect(data.items[0].from.random).toEqual([REX]);
    expect(data.items[0].from.guaranteed).toEqual([]);
    // Drops are not production rules, and must not pretend to be.
    expect(data.items[0].producedBy).toEqual([]);
  });

  it("keeps one resource when a rule and a drop spell the path differently", () => {
    const catalog = catalogWith(REX, {
      drops: {
        ...emptyDrops(),
        harvest: [emptyDropEntry("d1", CAKE.toUpperCase())],
      },
    });
    const production = draftWith(REX);
    production.rules[0].cycles = [
      {
        id: "cy",
        name: "",
        intervalSeconds: 60,
        itemSelectMode: 0,
        items: [
          {
            id: "it",
            bpPath: CAKE,
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
    ];
    const data = serializeViewerData(production, catalog, "c");
    expect(data.items).toHaveLength(1);
    // The rule's spelling wins, so the cycle's reference still resolves.
    expect(data.items[0].id).toBe(CAKE);
    expect(data.items[0].from.harvest).toEqual([REX]);
    expect(data.items[0].producedBy).toEqual([REX]);
  });

  it("publishes the item facts an admin recorded", () => {
    const catalog = catalogWith(REX, {
      drops: { ...emptyDrops(), harvest: [emptyDropEntry("d1", CAKE)] },
    });
    catalog.itemInfo[normalizeBpPath(CAKE)] = {
      type: "Consumables",
      rarity: "Rare",
      stackSize: 100,
      highOutputPerHour: null,
    };
    const item = serializeViewerData(emptyProductionDraft(), catalog, "c")
      .items[0];
    expect(item.type).toBe("Consumables");
    expect(item.rarity).toBe("Rare");
    expect(item.stack).toBe(100);
  });
});

// ---------------------------------------------------------------------------

describe("production and ability effects", () => {
  it("publishes a formatted rate for production, and no bare quantity", () => {
    const catalog = catalogWith(REX, {
      drops: {
        ...emptyDrops(),
        production: [
          { ...emptyDropEntry("p1", CAKE), qty: "9", rate: "1", per: "5 min" },
        ],
      },
    });
    const entry = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .drops.production[0];
    expect(entry.rate).toBe("1 / 5 min");
    // A quantity on something that recurs would contradict the rate.
    expect(entry.qty).toBe("");
    expect(entry.name).toBe("Sweet Vegetable Cake");
  });

  it("never publishes a rate on a list that does not recur", () => {
    const catalog = catalogWith(REX, {
      drops: {
        ...emptyDrops(),
        harvest: [{ ...emptyDropEntry("d1", CAKE), rate: "1", per: "5 min" }],
      },
    });
    expect(
      serializeViewerData(draftWith(REX), catalog, "c").creatures[0].drops
        .harvest[0].rate,
    ).toBe("");
  });

  it("resolves a weight reduction table to real item names", () => {
    const catalog = catalogWith(REX, {
      abilities: [
        {
          id: "a",
          label: "Weight reduction",
          detail: "",
          kind: "passive" as const,
          effect: "weight-reduction" as const,
          rows: [{ ...emptyAbilityEffectRow("r", CAKE), percent: "50%" }],
        },
      ],
    });
    const ability = serializeViewerData(draftWith(REX), catalog, "c")
      .creatures[0].abilities[0];
    expect(ability.effect).toBe("weight-reduction");
    expect(ability.rows[0].item.name).toBe("Sweet Vegetable Cake");
    expect(ability.rows[0].percent).toBe("50%");
    // No conversion target on a reduction.
    expect(ability.rows[0].to).toBeNull();
  });

  it("publishes both sides of a conversion", () => {
    const catalog = catalogWith(REX, {
      abilities: [
        {
          id: "a",
          label: "Conversion",
          detail: "",
          kind: "passive" as const,
          effect: "conversion" as const,
          rows: [
            {
              ...emptyAbilityEffectRow("r", CAKE),
              rate: "3",
              toBpPath: CAKE,
              toLabel: "Oil",
              toRate: "1",
              // A percentage is meaningless here and must not leak out.
              percent: "50%",
            },
          ],
        },
      ],
    });
    const row = serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
      .abilities[0].rows[0];
    expect(row.rate).toBe("3");
    expect(row.to?.name).toBe("Oil");
    expect(row.toRate).toBe("1");
    expect(row.percent).toBe("");
  });

  it("publishes no table for a plain ability", () => {
    const catalog = catalogWith(REX, {
      abilities: [
        {
          id: "a",
          label: "Pack bonus",
          detail: "",
          kind: "passive" as const,
          effect: "none" as const,
          rows: [emptyAbilityEffectRow("r", CAKE)],
        },
      ],
    });
    expect(
      serializeViewerData(draftWith(REX), catalog, "c").creatures[0]
        .abilities[0].rows,
    ).toEqual([]);
  });
});
