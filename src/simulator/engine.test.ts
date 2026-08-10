import { describe, expect, it } from "vitest";
import { simulate, SimConfig } from "./engine";
import {
  CreatureRule,
  emptyProductionDraft,
  PrimaryItem,
} from "../model/production";

const HIDE = "/Game/X/PrimalItemResource_Hide.PrimalItemResource_Hide";
const KERATIN = "/Game/X/PrimalItemResource_Keratin.PrimalItemResource_Keratin";
const BERRY = "/Game/X/PrimalItemConsumable_Berry.PrimalItemConsumable_Berry";

function item(overrides: Partial<PrimaryItem> = {}): PrimaryItem {
  return {
    id: "i1",
    bpPath: HIDE,
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

function rule(overrides: Partial<CreatureRule> = {}): CreatureRule {
  return {
    id: "r1",
    enabled: true,
    notes: "",
    dinoType: "/Game/X/Dino_Character_BP.Dino_Character_BP",
    chanceToProduce: 1,
    cycles: [
      {
        id: "c1",
        name: "",
        intervalSeconds: 3600, // 1/hour
        itemSelectMode: 0,
        items: [item()],
      },
    ],
    ...overrides,
  };
}

function config(overrides: Partial<SimConfig> = {}): SimConfig {
  return {
    mode: "hours",
    hours: 24,
    counts: {},
    defaultCount: 10,
    highOutputPerHour: 100000,
    lowOutputPerHour: 0,
    ...overrides,
  };
}

function draftWith(...rules: CreatureRule[]) {
  return { ...emptyProductionDraft(), rules };
}

describe("simulate", () => {
  it("computes simple deterministic output", () => {
    // 10 dinos × 5 hide × 24 attempts (hourly for 24h) = 1200
    const result = simulate(draftWith(rule()), config());
    expect(result.totals).toHaveLength(1);
    expect(result.totals[0].bpPath).toBe(HIDE);
    expect(result.totals[0].produced).toBe(1200);
    expect(result.totals[0].perHour).toBe(50);
  });

  it("applies chanceToProduce as expected value", () => {
    const result = simulate(
      draftWith(rule({ chanceToProduce: 0.5 })),
      config(),
    );
    expect(result.totals[0].produced).toBe(600);
  });

  it("splits output across items in Random mode", () => {
    const r = rule();
    r.cycles[0].itemSelectMode = 1;
    r.cycles[0].items = [item(), item({ id: "i2", bpPath: KERATIN })];
    const result = simulate(draftWith(r), config());
    // Each item gets half the attempts: 1200/2 = 600
    const hide = result.totals.find((t) => t.bpPath === HIDE)!;
    expect(hide.produced).toBe(600);
  });

  it("clamps per-cycle output at maxQuantityPerCycle", () => {
    const r = rule();
    // 10 dinos × 5 = 50 per cycle, capped at 20 → 20 × 24 = 480
    r.cycles[0].items = [item({ maxQuantityPerCycle: 20 })];
    const result = simulate(draftWith(r), config());
    expect(result.totals[0].produced).toBe(480);
  });

  it("caps totals at maxQuantityInTerminal and reports time-to-cap", () => {
    const r = rule();
    // 50/cycle hourly; terminal cap 100 → reached after 2 cycles (2h)
    r.cycles[0].items = [item({ maxQuantityInTerminal: 100 })];
    const result = simulate(draftWith(r), config());
    expect(result.totals[0].produced).toBe(100);
    expect(result.totals[0].terminalCapped).toBe(true);
    const flow = result.rules[0].cycles[0].flows[0];
    expect(flow.hoursToTerminalCap).toBe(2);
  });

  it("estimates alternates with chance and selection weight", () => {
    const r = rule();
    r.cycles[0].items = [
      item({
        alternateItemsChance: 0.5,
        alternateSelectMode: 1,
        alternateItems: [
          {
            id: "a1",
            bpPath: KERATIN,
            quantityPerItem: 2,
            maxQuantityPerCycle: 0,
            maxQuantityInTerminal: 0,
          },
          {
            id: "a2",
            bpPath: BERRY,
            quantityPerItem: 2,
            maxQuantityPerCycle: 0,
            maxQuantityInTerminal: 0,
          },
        ],
      }),
    ];
    // events/cycle = 10; alt chance 0.5; random of 2 → weight 0.5; qty 2
    // per cycle per alt = 10 × 0.5 × 0.5 × 2 = 5 → 120 over 24h
    const result = simulate(draftWith(r), config());
    const keratin = result.totals.find((t) => t.bpPath === KERATIN)!;
    expect(keratin.produced).toBe(120);
  });

  it("estimates consumption and net output", () => {
    const r = rule();
    r.cycles[0].items = [
      item({
        consumesItemsChance: 1,
        consumesItems: [
          {
            id: "co1",
            bpPath: BERRY,
            quantityPerItem: 2,
            maxQuantityPerCycle: 0,
            maxQuantityInTerminal: 0,
          },
        ],
      }),
    ];
    const result = simulate(draftWith(r), config());
    const berry = result.totals.find((t) => t.bpPath === BERRY)!;
    // 10 events/cycle × 2 = 20/cycle × 24 = 480 consumed
    expect(berry.consumed).toBe(480);
    expect(berry.net).toBe(-480);
    // Berries are supplied by players, never produced here — not a warning.
    expect(
      result.warnings.some((w) => /outpaces production/.test(w.message)),
    ).toBe(false);
  });

  it("warns only when a produced item is consumed faster than it is made", () => {
    // Creature A makes 5 hide/hour; creature B eats 20 hide/hour.
    const producer = rule({ id: "prod" });
    const consumer = rule({
      id: "cons",
      dinoType: "/Game/X/Other_Character_BP.Other_Character_BP",
      cycles: [
        {
          id: "c2",
          name: "",
          intervalSeconds: 3600,
          itemSelectMode: 0,
          items: [
            item({
              bpPath: KERATIN,
              consumesItemsChance: 1,
              consumesItems: [
                {
                  id: "co2",
                  bpPath: HIDE,
                  quantityPerItem: 20,
                  maxQuantityPerCycle: 0,
                  maxQuantityInTerminal: 0,
                },
              ],
            }),
          ],
        },
      ],
    });
    const result = simulate(draftWith(producer, consumer), config());
    const hide = result.totals.find((t) => t.bpPath === HIDE)!;
    expect(hide.produced).toBeGreaterThan(0);
    expect(hide.net).toBeLessThan(0);
    expect(
      result.warnings.some(
        (w) => w.bpPath === HIDE && /outpaces production/.test(w.message),
      ),
    ).toBe(true);
  });

  it("skips disabled rules and contributes nothing for zero-count rules", () => {
    const result = simulate(
      draftWith(rule({ enabled: false }), rule({ id: "r2" })),
      config({ counts: { r2: 0 } }),
    );
    expect(result.totals).toHaveLength(0);
    // The zero-count rule stays in the breakdown so its count field survives
    // being set to 0; only the disabled rule drops out.
    expect(result.rules.map((r) => r.ruleId)).toEqual(["r2"]);
    expect(result.rules[0].creatureCount).toBe(0);
    expect(
      result.rules[0].cycles.flatMap((c) => c.flows).every((f) => f.produced === 0),
    ).toBe(true);
  });

  it("recovers a rule's output when its count goes back above zero", () => {
    const draft = draftWith(rule());
    expect(simulate(draft, config({ counts: { r1: 0 } })).totals).toHaveLength(0);
    const back = simulate(draft, config({ counts: { r1: 4 } }));
    // 4 dinos × 5 hide × 24 attempts
    expect(back.totals[0].produced).toBe(480);
  });

  it("runs every cycle exactly once in singleCycle mode", () => {
    // 10 dinos × 5 hide × 1 attempt = 50, regardless of interval
    const result = simulate(
      draftWith(rule()),
      config({ mode: "singleCycle" }),
    );
    expect(result.totals[0].produced).toBe(50);
    expect(result.rules[0].cycles[0].attempts).toBe(1);
    // no per-hour thresholds in singleCycle mode
    expect(result.warnings).toHaveLength(0);
  });

  it("warns on high output", () => {
    const result = simulate(
      draftWith(rule()),
      config({ highOutputPerHour: 10 }),
    );
    expect(result.warnings.some((w) => /High output/.test(w.message))).toBe(true);
  });

  it("lets an item's own threshold raise the bar above the default", () => {
    // 50/hour, over the 10/hour default but under this item's own 100.
    const result = simulate(
      draftWith(rule()),
      config({
        highOutputPerHour: 10,
        highOutputPerItem: { [HIDE.toLowerCase()]: 100 },
      }),
    );
    expect(result.warnings.some((w) => /High output/.test(w.message))).toBe(
      false,
    );
  });

  it("lets an item's own threshold lower the bar below the default", () => {
    const result = simulate(
      draftWith(rule()),
      config({
        highOutputPerHour: 100000,
        highOutputPerItem: { [HIDE.toLowerCase()]: 10 },
      }),
    );
    const warning = result.warnings.find((w) => /High output/.test(w.message));
    expect(warning?.message).toContain("10/hour threshold set for this item");
  });

  it("ignores a threshold set for a different item", () => {
    const result = simulate(
      draftWith(rule()),
      config({
        highOutputPerHour: 10,
        highOutputPerItem: { "/game/somethingelse": 100 },
      }),
    );
    expect(result.warnings.some((w) => /High output/.test(w.message))).toBe(true);
  });
});
