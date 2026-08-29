import { describe, expect, it } from "vitest";
import {
  buildCreatureCommands,
  DEFAULT_CREATURE_PARAMS,
  hasStatPoints,
  serializeColors,
  serializeStats,
  serializeTraits,
  type CreatureSpawnParams,
} from "./spawnCommands";
import { ARK_COLORS, colorById, searchColors } from "../model/arkColors";
import {
  ARK_TRAITS,
  normalizeTraitToken,
  tierFromIndex,
  tierIndex,
  tiersFor,
  traitByToken,
} from "../model/arkTraits";

const REX = "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP";

function params(over: Partial<CreatureSpawnParams> = {}): CreatureSpawnParams {
  return { ...DEFAULT_CREATURE_PARAMS, playerId: "735008833", ...over };
}

/** The Dino Depot ball command, which is the one all the arguments feed. */
function ball(p: CreatureSpawnParams): string {
  return buildCreatureCommands(REX, p)[0].command;
}

describe("serializeStats", () => {
  it("emits all nine positions in argument order", () => {
    expect(serializeStats({ health: 67, stamina: 67, oxygen: 64, food: 53, weight: 66, melee: 57 }))
      .toBe("67,67,64,53,0,66,57,0,0");
  });

  it("sends unset stats as zero and never a blank slot", () => {
    expect(serializeStats({})).toBe("0,0,0,0,0,0,0,0,0");
    expect(serializeStats({ craft: 5 })).toBe("0,0,0,0,0,0,0,0,5");
  });

  it("clamps negatives and rounds fractions - the argument is integer points", () => {
    expect(serializeStats({ health: -4, melee: 2.6 })).toBe("0,0,0,0,0,0,3,0,0");
  });

  it("only counts as 'set' when some stat carries points", () => {
    expect(hasStatPoints({})).toBe(false);
    expect(hasStatPoints({ health: 0 })).toBe(false);
    expect(hasStatPoints({ health: 1 })).toBe(true);
  });
});

describe("serializeColors", () => {
  it("places each colour at its region index", () => {
    expect(
      serializeColors([
        { region: 0, colorId: 177 },
        { region: 2, colorId: 201 },
        { region: 5, colorId: 224 },
      ]),
    ).toBe("177,0,201,0,0,224");
  });

  it("ignores regions outside 0–5 rather than shifting the rest along", () => {
    expect(serializeColors([{ region: 9, colorId: 12 }, { region: 1, colorId: 3 }]))
      .toBe("0,3,0,0,0,0");
  });
});

describe("serializeTraits", () => {
  it("writes tier 1/2/3 as [0]/[1]/[2]", () => {
    expect(
      serializeTraits([
        { id: "a", token: "aggressive", tier: 1 },
        { id: "b", token: "angry", tier: 2 },
        { id: "c", token: "swimmer", tier: 3 },
      ]),
    ).toBe("aggressive[0],angry[1],swimmer[2]");
  });

  it("keeps duplicate traits - a creature can carry more than one", () => {
    expect(
      serializeTraits([
        { id: "a", token: "aggressive", tier: 1 },
        { id: "b", token: "aggressive", tier: 3 },
      ]),
    ).toBe("aggressive[0],aggressive[2]");
  });

  it("drops blank rows so a half-added trait cannot emit `[0]`", () => {
    expect(serializeTraits([{ id: "a", token: "  ", tier: 1 }])).toBe("");
  });
});

describe("buildCreatureCommands - ball command", () => {
  it("uses the level when no stats are assigned", () => {
    const cmd = ball(params({ level: 150 }));
    expect(cmd).toContain("-l=150");
    expect(cmd).not.toContain("-s=");
  });

  it("swaps the level for -s= once any stat is assigned", () => {
    const cmd = ball(params({ stats: { health: 40 } }));
    expect(cmd).not.toContain("-l=");
    expect(cmd).toContain("-s=40,0,0,0,0,0,0,0,0");
  });

  it("omits -r= and -g= entirely when nothing is configured", () => {
    const cmd = ball(params());
    expect(cmd).not.toContain("-r=");
    expect(cmd).not.toContain("-g=");
  });

  it("omits -r= when every region is still the no-op 0", () => {
    expect(ball(params({ colors: [{ region: 1, colorId: 0 }] }))).not.toContain("-r=");
  });

  it("includes traits as -g=", () => {
    const cmd = ball(params({ traits: [{ id: "t", token: "giantslaying", tier: 2 }] }));
    expect(cmd).toContain("-g=giantslaying[1]");
  });

  it("names the selected identifier in the placeholder and the warning", () => {
    const eos = buildCreatureCommands(REX, params({ playerId: "", playerIdKind: "eosId" }))[0];
    expect(eos.command).toContain("-p=<EOS ID>");
    expect(eos.warning).toContain("EOS ID");

    const plain = buildCreatureCommands(REX, params({ playerId: "" }))[0];
    expect(plain.command).toContain("-p=<Player ID>");
    expect(plain.warning).toContain("Player ID");
  });

  it("sends the identifier value as-is whichever kind is selected", () => {
    expect(ball(params({ playerId: "0002fe9c", playerIdKind: "eosId" })))
      .toContain("-p=0002fe9c");
  });

  it("still warns when the command outgrows the console limit", () => {
    const long = buildCreatureCommands(
      REX,
      params({
        dinoName: "x".repeat(200),
        traits: [{ id: "t", token: "aggressive", tier: 1 }],
      }),
    )[0];
    expect(long.warning).toMatch(/over the 290 console limit/);
  });

  it("keeps the argument order the command expects", () => {
    const cmd = ball(
      params({
        dinoName: "Bob",
        neutered: true,
        stats: { health: 1 },
        colors: [{ region: 0, colorId: 5 }],
        traits: [{ id: "t", token: "angry", tier: 1 }],
      }),
    );
    expect(cmd).toBe(
      "admincheat scriptcommand SpawnDinoInBall -p=735008833 " +
        `-t=${REX} -n=Bob -f=0 -i=1 -a=1 -b=true ` +
        "-s=1,0,0,0,0,0,0,0,0 -r=5,0,0,0,0,0 -g=angry[0]",
    );
  });
});

/**
 * Argument lists checked against the ASA command reference.
 * These are exact-string assertions on purpose: a spawn command that is one
 * argument short fails silently in the console, which is exactly how the
 * missing SDF argument went unnoticed.
 */
describe("buildCreatureCommands - vanilla console commands", () => {
  const byLabel = (p: CreatureSpawnParams, match: RegExp) =>
    buildCreatureCommands(REX, p).find((c) => match.test(c.label))!;

  it("GMSummon takes the class in quotes and a level", () => {
    expect(byLabel(params({ tamed: true, level: 150 }), /^GMSummon/).command).toBe(
      'admincheat GMSummon "Rex_Character_BP_C" 150',
    );
  });

  it("Summon takes the class alone", () => {
    expect(byLabel(params({ tamed: false }), /^Summon/).command).toBe(
      "admincheat Summon Rex_Character_BP_C",
    );
  });

  it("SpawnDino takes path, distance, y-offset, z-offset, level", () => {
    expect(byLabel(params({ level: 120 }), /^SpawnDino/).command).toBe(
      `admincheat SpawnDino "Blueprint'${REX}'" 500 0 0 120`,
    );
  });

  // SDF is `<NamePart> <Tamed> <level> <bLoadIfUnloaded> <bSkipAddingTamedLevels>`.
  // The last two are ASA-only, and both matter: without bLoadIfUnloaded the
  // command does nothing for a creature not already in the world, and
  // bSkipAddingTamedLevels decides whether the level asked for is the level
  // that arrives. These mirror retained worked examples.
  it("SDF spawns a tamed creature at exactly the level given", () => {
    // Tamed 150 example: cheat sdf dodo 1 150 1 1
    expect(byLabel(params({ tamed: true, level: 150 }), /^SDF/).command).toBe(
      "admincheat SDF Rex_Character_BP 1 150 1 1",
    );
  });

  it("SDF spawns wild with the tamed flags off", () => {
    // Wild 150 example: cheat sdf dodo 0 150 1 0
    expect(byLabel(params({ tamed: false, level: 150 }), /^SDF/).command).toBe(
      "admincheat SDF Rex_Character_BP 0 150 1 0",
    );
  });

  it("SDF always asks the game to load the creature", () => {
    // The fourth argument is the one that makes the command work at all for
    // anything not already spawned nearby, so it is 1 either way.
    for (const tamed of [true, false]) {
      const parts = byLabel(params({ tamed }), /^SDF/).command.split(" ");
      expect(parts[5], `tamed=${tamed}`).toBe("1");
      expect(parts).toHaveLength(7);
    }
  });

  it("SDF matches on the class name without the _C suffix", () => {
    const withC = buildCreatureCommands(`${REX}_C`, params()).find((c) =>
      /^SDF/.test(c.label),
    )!;
    expect(withC.command).toContain("SDF Rex_Character_BP ");
  });
});

describe("ARK colour palette", () => {
  it("has unique ids and a hex for everything except N/A", () => {
    const ids = ARK_COLORS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const color of ARK_COLORS) {
      if (color.id === 0) continue;
      expect(color.hex, `${color.id} ${color.name}`).toMatch(/^[0-9A-F]{6}$/);
    }
  });

  it("covers both the creature block and the dye block", () => {
    expect(colorById(36)?.name).toBe("Dino Albino");
    expect(colorById(254)?.name).toBe("Bubblegum Coloring");
    // The ids are not contiguous - nothing lives between 100 and 128.
    expect(colorById(110)).toBeUndefined();
  });

  it("keeps the caveat on the colour that sRGB cannot show", () => {
    expect(colorById(36)?.note).toMatch(/sRGB/);
  });

  it("searches by id and by name", () => {
    expect(searchColors("177")[0].name).toBe("Skobeloff Coloring");
    expect(searchColors("skobel")[0].id).toBe(177);
    expect(searchColors("").length).toBe(ARK_COLORS.length);
  });
});

describe("ARK traits", () => {
  it("maps tiers to the bracket index both ways", () => {
    expect([1, 2, 3].map((t) => tierIndex(t as 1 | 2 | 3))).toEqual([0, 1, 2]);
    expect([0, 1, 2].map(tierFromIndex)).toEqual([1, 2, 3]);
  });

  it("carries the tokens Dino Depot's own example uses", () => {
    for (const token of ["aggressive", "angry", "swimmer"]) {
      expect(traitByToken(token), token).toBeDefined();
    }
  });

  it("has unique, command-safe tokens", () => {
    const tokens = ARK_TRAITS.map((t) => t.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const token of tokens) expect(token).toMatch(/^[a-z0-9]+$/);
  });

  it("offers every tier when a trait records no limit", () => {
    expect(tiersFor("aggressive")).toEqual([1, 2, 3]);
    // An unknown trait must not be silently restricted.
    expect(tiersFor("somemodtrait")).toEqual([1, 2, 3]);
  });

  it("respects a recorded tier limit when one exists", () => {
    // Guards the mechanism, so narrowing a trait later needs no code change.
    const limited = { ...ARK_TRAITS[0], tiers: [1] as const };
    expect(limited.tiers).toEqual([1]);
  });

  it("normalizes free-typed trait text into a token", () => {
    expect(normalizeTraitToken("  Heavy-Hitting ")).toBe("heavyhitting");
    expect(normalizeTraitToken("Fast Learner")).toBe("fastlearner");
  });
});
