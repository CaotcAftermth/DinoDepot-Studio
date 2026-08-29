import type { CreatureInfo, MethodTag } from "./creatureInfo";

/**
 * Verified acquisition fixtures.
 *
 * Records retain source revisions from the legacy fixture dataset. They exist
 * to exercise the schema end to end: every availability, outcome, tag, input
 * reference type and role, phase-level outcome, and variant inheritance.
 */

export interface FixtureSource {
  /** Legacy source page title. */
  page: string;
  /** Revision the text was read at - the anchor for reimport comparison. */
  revisionId: number;
  /** Which game the information applies to. */
  game: "ASA" | "ASE" | "both";
  /** Mod that adds the creature, when it isn't base game. */
  mod?: string;
}

export interface CreatureFixture {
  /** Blueprint path, or "" when the creature isn't in the bundled catalog. */
  bpPath: string;
  name: string;
  /** Which representative case this fixture is here to cover. */
  covers: string;
  source: FixtureSource;
  info: Partial<CreatureInfo>;
}

let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

/** Terser fixture authoring - the defaults are filled in by the schema. */
function phase(
  name: string,
  steps: string[],
  extra: Partial<{
    note: string;
    repeatUntil: string;
    completedWhen: string;
    failureOrReset: string;
    transitionNote: string;
  }> = {},
) {
  return {
    id: id("ph"),
    name,
    note: "",
    repeatUntil: "",
    completedWhen: "",
    failureOrReset: "",
    transitionNote: "",
    ...extra,
    steps: steps.map((text) => ({ id: id("st"), text })),
  };
}

function item(bpPath: string, role: string, qty = "", note = "") {
  return { id: id("in"), referenceType: "item" as const, bpPath, label: "", role, qty, note };
}
function creature(bpPath: string, role: string, qty = "", note = "") {
  return { id: id("in"), referenceType: "creature" as const, bpPath, label: "", role, qty, note };
}
function text(label: string, role: string, qty = "", note = "") {
  return { id: id("in"), referenceType: "text" as const, bpPath: "", label, role, qty, note };
}

function method(
  name: string,
  outcome: CreatureInfo["methods"][number]["outcome"],
  tags: MethodTag[],
  rest: Partial<Omit<CreatureInfo["methods"][number], "id" | "name" | "outcome" | "tags">> = {},
) {
  return {
    id: id("m"),
    name,
    outcome,
    tags: tags as string[],
    requirements: "",
    inputs: [],
    phases: [],
    repeatUntil: "",
    completion: "",
    failure: "",
    effectiveness: "",
    strategy: "",
    ...rest,
  };
}

// Paths that exist in the bundled official catalog.
const P = {
  rex: "/Game/PrimalEarth/Dinos/Rex/Rex_Character_BP.Rex_Character_BP",
  dodo: "/Game/PrimalEarth/Dinos/Dodo/Dodo_Character_BP.Dodo_Character_BP",
  diplo: "/Game/PrimalEarth/Dinos/Diplodocus/Diplodocus_Character_BP.Diplodocus_Character_BP",
  carcha: "/Game/PrimalEarth/Dinos/Carcharodontosaurus/Carcha_Character_BP.Carcha_Character_BP",
  giganto: "/Game/ASA/Dinos/Gigantoraptor/Gigantoraptor_Character_BP.Gigantoraptor_Character_BP",
  equus: "/Game/PrimalEarth/Dinos/Equus/Equus_Character_BP.Equus_Character_BP",
  hyaeno: "/Game/PrimalEarth/Dinos/Hyaenodon/Hyaenodon_Character_BP.Hyaenodon_Character_BP",
  chalico: "/Game/PrimalEarth/Dinos/Chalicotherium/Chalico_Character_BP.Chalico_Character_BP",
  andrew: "/Game/Fjordur/Dinos/Andrewsarchus/Andrewsarchus_Character_BP.Andrewsarchus_Character_BP",
  mantis: "/Game/ScorchedEarth/Dinos/Mantis/Mantis_Character_BP.Mantis_Character_BP",
  pego: "/Game/PrimalEarth/Dinos/Pegomastax/Pegomastax_Character_BP.Pegomastax_Character_BP",
  troodon: "/Game/PrimalEarth/Dinos/Troodon/Troodon_Character_BP.Troodon_Character_BP",
  gacha: "/Game/Extinction/Dinos/Gacha/Gacha_Character_BP.Gacha_Character_BP",
  phoenix: "/Game/ScorchedEarth/Dinos/Phoenix/Phoenix_Character_BP.Phoenix_Character_BP",
  lio: "/Game/PrimalEarth/Dinos/Liopleurodon/Liopleurodon_Character_BP.Liopleurodon_Character_BP",
  troodonKibble:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_Kibble_TroodonEgg.PrimalItemConsumable_Kibble_TroodonEgg",
  cake:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_SweetVeggieCake.PrimalItemConsumable_SweetVeggieCake",
  honey:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_Honey.PrimalItemConsumable_Honey",
  beer:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_BeerJar.PrimalItemConsumable_BeerJar",
  rockarrot:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_Veggie_Rockarrot.PrimalItemConsumable_Veggie_Rockarrot",
  narcotic:
    "/Game/PrimalEarth/CoreBlueprints/Items/Consumables/PrimalItemConsumable_Narcotic.PrimalItemConsumable_Narcotic",
  ghillie:
    "/Game/PrimalEarth/CoreBlueprints/Items/Armor/Ghillie/PrimalItemArmor_GhillieShirt.PrimalItemArmor_GhillieShirt",
};

export const CREATURE_FIXTURES: CreatureFixture[] = [
  // ---- 1. ordinary knockout -------------------------------------------
  {
    bpPath: P.rex,
    name: "Rex",
    covers: "ordinary knockout",
    source: { page: "Rex", revisionId: 585582, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Knockout tame", "direct-tame", ["knockout"], {
          requirements: "Tranq weapon, narcotics, a trap or safe high ground",
          inputs: [item(P.narcotic, "sedative", "", "keep torpor up while it eats")],
          phases: [
            phase("Prepare", ["Trap it or find safe high ground"]),
            phase("Knock out", ["Apply torpor until it drops"]),
            phase("Feed", ["Put the food in its inventory"], {
              repeatUntil: "the taming bar fills",
              failureOrReset: "it wakes up",
            }),
          ],
        }),
      ],
      technical: { dragWeight: 550 },
    },
  },

  // ---- 2. ordinary passive --------------------------------------------
  {
    bpPath: P.dodo,
    name: "Dodo",
    covers: "ordinary passive - the simplest possible record",
    source: { page: "Dodo", revisionId: 586871, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Passive tame", "direct-tame", ["passive"], {
          phases: [phase("Feed", ["Feed it from your last hotbar slot"])],
          repeatUntil: "the taming bar fills",
        }),
      ],
    },
  },

  // ---- 3. MULTIPLE ROUTES ---------------------------------------------
  {
    bpPath: P.diplo,
    name: "Diplodocus",
    covers: "two valid routes on one creature from the legacy source text",
    source: { page: "Diplodocus", revisionId: 585428, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Knockout tame", "direct-tame", ["knockout"], {
          phases: [phase("Knock out", ["Apply torpor until it drops"])],
        }),
        method("Passive tame", "direct-tame", ["passive"], {
          strategy:
            "Its nudge deals no direct damage - the risk is fall damage on uneven terrain. Standing at the base of its neck or under its belly keeps you out of nudge range.",
          phases: [
            phase("Feed", ["Feed from the last hotbar slot"], {
              failureOrReset: "hitting it loses taming effectiveness",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 4. trust + mounted, outcome shifts mid-route --------------------
  {
    bpPath: P.carcha,
    name: "Carcharodontosaurus",
    covers: "trust building + mounted; temporary control resolves into a full tame",
    source: { page: "Carcharodontosaurus", revisionId: 595730, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Carcass feeding and trust ride", "direct-tame", ["trust", "mounted"], {
          requirements: "Carcasses to feed it; somewhere to fight safely",
          inputs: [text("Creature carcasses", "offering", "", "feed it enough to earn the Friend Buff")],
          phases: [
            phase("Earn the Friend Buff", ["Give it enough carcass to feed on"], {
              completedWhen: "it grants the Friend Buff",
            }),
            phase("Ride on trust", ["Mount and ride while it still trusts you"], {
              repeatUntil: "it is fully tamed",
              failureOrReset: "it stops trusting you, or dies",
              transitionNote:
                "This is the temporary-control stage - it ends by becoming a full tame.",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 5. CORRECTED: nest / baby minigame ------------------------------
  {
    bpPath: P.giganto,
    name: "Gigantoraptor",
    covers: "nest + baby mimicry minigame; adult is untameable - corrected from combat-assist",
    source: { page: "Gigantoraptor", revisionId: 593622, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Nest baby claim", "claim", ["wild-baby", "minigame"], {
          requirements:
            "A nest with both an adult and a baby alive; fertilized eggs to throw; Ghillie recommended",
          inputs: [
            text("Fertilized eggs", "bait", "several", "larger eggs distract the adult for longer"),
            item(P.ghillie, "optional-aid", "", "reduces the chance of being detected"),
          ],
          phases: [
            phase(
              "Distract the adult",
              [
                "Throw a fertilized egg away from the nest",
                "Wait for the adult to go and crack it open",
              ],
              {
                note: "The parent must be awake and able to return - traps are not viable.",
                completedWhen: "the adult is occupied with the egg",
                failureOrReset:
                  "if the egg actually hatches the adult aggros and kills the babies",
                transitionNote:
                  "Once it destroys the egg it returns to the nest - leave, run off, and throw another.",
              },
            ),
            phase(
              "Mimic the baby",
              [
                "Use 'Hide in Gigantoraptor Nest'",
                "The baby runs up, does a jump-flap, then Spins, Bows or Flaps",
                "Perform the same action within about 2 seconds",
              ],
              {
                repeatUntil: "the taming percentage fills",
                failureOrReset:
                  "too slow loses a little effectiveness; the wrong action drops it dramatically; adult aggro resets the attempt; leaving render distance can reset progress",
              },
            ),
          ],
          completion: "The baby is claimed and imprinted on",
          strategy:
            "Keep spare fertilized eggs in range, on a tame parked away from the nest. Clear nearby threats first - anything attacking you, the adult or the baby can ruin it. Killing the parents prevents imprinting on their babies.",
        }),
      ],
    },
  },

  // ---- 6. COMBAT ASSISTANCE (mod) --------------------------------------
  {
    bpPath: "",
    name: "Edmontonia",
    covers: "combat assistance - you fight alongside it without attacking it (mod creature)",
    source: {
      page: "Mod:Additions Ascended/Edmontonia",
      revisionId: 588874,
      game: "ASA",
      mod: "Additions Ascended (ARK Additions)",
    },
    info: {
      availability: "acquirable",
      methods: [
        method("Powder cloud and fire assist", "direct-tame", ["combat-assist", "passive"], {
          requirements:
            "A Torch to initiate; a reliable fire source such as a Flamethrower; open ground with room for creatures to spawn",
          inputs: [
            text("Torch", "catalyst", "1", "required to start the process"),
            text("Flamethrower", "optional-aid", "", "a more reliable source of fire damage"),
            item(P.cake, "optional-aid", "", "heals it between attacks"),
          ],
          phases: [
            phase(
              "Initiate at a powder cloud",
              [
                "Wait for it to sneeze out a floating powder cloud",
                "Approach the cloud with a torch equipped until it turns to face you",
                "Interact with the cloud",
              ],
              { completedWhen: "it starts following you" },
            ),
            phase(
              "Fight alongside it",
              [
                "Wait for the notice that it wants to fight something",
                "A carnivore spawns at a level matching the Edmontonia",
                "Deal fire damage to the attacker until it dies",
              ],
              {
                note: "The spawned creature fixates on the Edmontonia and will not deliberately attack you.",
                repeatUntil: "the Edmontonia is tamed",
                failureOrReset:
                  "failing to contribute enough fire damage before the target dies reduces effectiveness - it prompts a warning first",
              },
            ),
          ],
          effectiveness:
            "Affinity is based on how much fire damage you personally contributed. Damage the Edmontonia takes does not affect effectiveness.",
          strategy:
            "A Fire Wyvern cannot be used - the fire damage has to come from the player. Heal it with Sweet Vegetable Cake between waves.",
        }),
      ],
    },
  },

  // ---- 7. egg theft and raising ----------------------------------------
  {
    bpPath: "",
    name: "Wyvern",
    covers: "egg theft then raise - adults cannot be tamed",
    source: { page: "Wyvern", revisionId: 587899, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Steal an egg and raise it", "hatch-and-raise", ["egg-theft"], {
          requirements: "A fast mount and somewhere safe to incubate",
          phases: [
            phase("Raid a nest", ["Take a Wyvern egg from a nest"], {
              failureOrReset: "the alpha and nearby wyverns aggro on theft",
            }),
            phase("Escape and incubate", ["Outrun the pursuit", "Incubate the egg"]),
            phase("Raise it", ["Raise the hatchling on Wyvern Milk"]),
          ],
          completion: "The hatchling is yours once raised",
        }),
      ],
    },
  },

  // ---- 8. HOST / IMPREGNATION - creature reference ---------------------
  {
    bpPath: "",
    name: "Rhyniognatha",
    covers: "impregnation with a CREATURE input gated on drag weight",
    source: { page: "Rhyniognatha", revisionId: 588992, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Host impregnation", "birth-from-host", ["impregnation"], {
          requirements:
            "A sacrificial tamed creature with drag weight 300+ (900+ gives 100% host size); a male Rhyniognatha for the pheromone",
          inputs: [
            text("Rhyniognatha Pheromone", "catalyst", "1", "dropped by a male Rhyniognatha"),
            creature(P.rex, "host-creature", "drag weight 300+", "killed when the baby is born"),
          ],
          phases: [
            phase("Get the pheromone", ["Take the pheromone dropped by a male"]),
            phase(
              "Impregnate the host",
              [
                "Weaken a female below 10% HP",
                "Use the pheromone on the creature you're sacrificing",
              ],
              { completedWhen: "the female impregnates the host" },
            ),
            phase("Protect the host", ["Keep the host alive through gestation"], {
              failureOrReset: "the host dying before birth loses the tame",
            }),
            phase("Imprint the baby", ["Imprint on it after birth"]),
          ],
          completion: "The baby is born and imprinted on",
          effectiveness:
            "Anything above 900 drag weight gives 100% host size; stats are randomly inherited from the host.",
          strategy:
            "Wild Rhyniognatha cannot be tamed and tamed ones cannot be bred. One female can impregnate several hosts if trapped.",
        }),
      ],
      technical: { dragWeight: 300 },
    },
  },

  // ---- 9. wild baby claim (second route on the same creature) ----------
  {
    bpPath: "",
    name: "Gigantoraptor (orphan route)",
    covers: "wild-baby claim via a tamed Gigantoraptor's Baby Call",
    source: { page: "Gigantoraptor", revisionId: 593622, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Orphan claim with Baby Call", "claim", ["wild-baby"], {
          requirements: "A tamed, imprinted Gigantoraptor",
          phases: [
            phase("Mark the babies", ["Roar to trigger Baby Call"], {
              note: "Marks wild babies within stasis range for 1 minute.",
            }),
            phase("Claim", ["Imprint on an orphaned wild baby"]),
          ],
          effectiveness:
            "Bonus wild levels scale with the Gigantoraptor's level and taming effectiveness.",
        }),
      ],
    },
  },

  // ---- 10. special / unique knockout -----------------------------------
  {
    bpPath: "",
    name: "Fasolasuchus",
    covers: "unique knockout - no tranquilizers involved",
    source: { page: "Fasolasuchus", revisionId: 593540, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Buried mound detonation ride", "direct-tame", ["knockout", "mounted"], {
          requirements: "C4 or a grenade",
          inputs: [text("C4 charge or grenade", "catalyst", "1", "detonate on the mound")],
          phases: [
            phase("Flush it out", [
              "Wait until it buries itself",
              "Detonate C4 or a grenade on the mound",
            ], { completedWhen: "it emerges disoriented" }),
            phase(
              "Ride it into rocks",
              [
                "Interact to ride it while disoriented",
                "Drive it into rock resources to build torpor",
              ],
              {
                note: "Metal, crystal and raw salt give more torpor than plain rock. Trees give none.",
                repeatUntil: "it is knocked out",
                failureOrReset:
                  "the control bar hitting 0, or going airborne off a cliff, dismounts you - lose aggro and wait for it to bury again",
              },
            ),
          ],
        }),
      ],
    },
  },

  // ---- 11. environmental ------------------------------------------------
  {
    bpPath: P.phoenix,
    name: "Phoenix",
    covers: "environmental - only exists during a specific weather event",
    source: { page: "Phoenix", revisionId: 595665, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Burn during a Heat Wave", "direct-tame", ["environmental"], {
          requirements: "Scorched Earth during a Heat Wave; a fire weapon",
          inputs: [
            text("Flamethrower, Flame Arrows or Fire Wyvern breath", "catalyst", "", "any fire source"),
          ],
          phases: [
            phase("Find it", ["Look high in the sky during a Heat Wave"]),
            phase("Burn it", ["Strike it with fire repeatedly"], {
              repeatUntil: "the taming bar fills",
              failureOrReset:
                "if the Heat Wave ends first it disintegrates into ash and respawns next Heat Wave",
            }),
          ],
          effectiveness:
            "Damage does not undo progress, but waiting too long between fire hits loses effectiveness.",
        }),
      ],
    },
  },

  // ---- 12. temporary tame ----------------------------------------------
  {
    bpPath: P.lio,
    name: "Liopleurodon",
    covers: "temporary control - reverts on a timer",
    source: { page: "Liopleurodon", revisionId: 586858, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Honey feeding", "temporary-control", ["passive", "temporary"], {
          inputs: [item(P.honey, "taming-food", "", "fed by hand from the last slot")],
          phases: [phase("Feed", ["Feed it Giant Bee Honey by hand"])],
          completion: "Yours for 30 minutes",
          failure: "It disappears after 30 minutes and cannot be cryopodded",
        }),
      ],
    },
  },

  // ---- 13. untameable ---------------------------------------------------
  {
    bpPath: "",
    name: "Alpha Rex",
    covers: "unavailable - nothing to record beyond that",
    source: { page: "Alpha Rex", revisionId: 265022, game: "both" },
    info: { availability: "unavailable" },
  },

  // ---- 14. INHERITED VARIANT -------------------------------------------
  {
    bpPath: "",
    name: "Aberrant Gigantoraptor",
    covers:
      "variant inheritance from legacy source text; stores nothing itself",
    source: { page: "Gigantoraptor", revisionId: 593622, game: "ASA" },
    info: {
      // Deliberately empty: it inherits every section from Gigantoraptor.
      overrides: [],
      abilities: [],
    },
  },

  // ---- 15. passive + minigame ------------------------------------------
  {
    bpPath: P.equus,
    name: "Equus",
    covers: "passive feeding that becomes a mounted minigame",
    source: { page: "Equus", revisionId: 585447, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Feed and ride", "direct-tame", ["passive", "minigame", "mounted"], {
          requirements: "Ghillie recommended - it flees when startled",
          inputs: [
            item(P.rockarrot, "taming-food", "", "in the far-right hotbar slot"),
            item(P.troodonKibble, "taming-food", "31 for a level 150", "best food"),
          ],
          phases: [
            phase("Feed", ["Feed it one food item when the prompt appears"], {
              transitionNote: "Then mount it immediately - it must be ridden to continue.",
            }),
            phase("Stay mounted", ["Calm it with food each time it tries to buck you off"], {
              repeatUntil: "the taming bar fills",
              failureOrReset: "being thrown off, or startling it into fleeing",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 16. unique non-violent, forced ride + minigame -------------------
  {
    bpPath: P.andrew,
    name: "Andrewsarchus",
    covers: "distract-then-ride with a directional minigame",
    source: { page: "Andrewsarchus", revisionId: 585333, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Honey distraction ride", "direct-tame", ["passive", "mounted", "minigame"], {
          inputs: [item(P.honey, "bait", "", "thrown from the hotbar, not the inventory")],
          phases: [
            phase("Distract", ["Throw Giant Bee Honey near it"], {
              completedWhen: "it starts eating",
              transitionNote: "Approach and mount it while it eats.",
            }),
            phase(
              "Ride the minigame",
              [
                "Two arrows appear between it",
                "Hold the prompted direction when the arrow glows green",
                "Release immediately when it glows red",
              ],
              { failureOrReset: "mistiming throws you off" },
            ),
          ],
          strategy:
            "Clear other Andrewsarchus and hostiles first - Giganotosaurus spawn alongside them and will kill it.",
        }),
      ],
    },
  },

  // ---- 17. petting, no food --------------------------------------------
  {
    bpPath: P.hyaeno,
    name: "Hyaenodon",
    covers: "trust building with no input at all",
    source: { page: "Hyaenodon", revisionId: 585475, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Petting", "direct-tame", ["trust", "passive"], {
          requirements: "Must be far enough from the pack leader to get the prompt",
          phases: [
            phase("Pet it", ["Crouch and pet it when prompted, every 30 seconds"], {
              repeatUntil: "the taming bar fills",
              failureOrReset:
                "missing a prompt drops the taming percentage very quickly",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 18. slow-drip passive -------------------------------------------
  {
    bpPath: P.chalico,
    name: "Chalicotherium",
    covers: "passive with a hunger gate between feeds",
    source: { page: "Chalicotherium", revisionId: 596273, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Beer feeding", "direct-tame", ["passive"], {
          inputs: [item(P.beer, "taming-food", "", "last hotbar slot")],
          phases: [
            phase("Feed on a timer", ["Feed a Beer Jar when it will accept one"], {
              repeatUntil: "the taming meter fills",
              note: "It only accepts more every few minutes, once hungry again.",
            }),
          ],
          strategy: "Ghillie and approach from behind.",
        }),
      ],
    },
  },

  // ---- 19. horn-based passive ------------------------------------------
  {
    bpPath: P.mantis,
    name: "Mantis",
    covers: "passive gated on a specific resource",
    source: { page: "Mantis", revisionId: 588094, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Horn feeding", "direct-tame", ["passive"], {
          inputs: [text("Deathworm Horn or Woolly Rhino Horn", "taming-food", "", "last hotbar slot")],
          phases: [
            phase("Feed", ["Feed a horn when it approaches"], {
              repeatUntil: "the taming meter fills",
              note: "Wait a few minutes between feeds.",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 20. pickpocket passive ------------------------------------------
  {
    bpPath: P.pego,
    name: "Pegomastax",
    covers: "passive where the creature takes from you rather than being fed",
    source: { page: "Pegomastax", revisionId: 595563, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Let it pickpocket", "direct-tame", ["passive"], {
          inputs: [text("Berries or kibble", "taming-food", "", "prioritises the last inventory slot")],
          phases: [
            phase("Be robbed", ["Let it steal the item instead of feeding it"], {
              repeatUntil: "the taming bar fills",
              note: "Stealing takes the whole stack and deals minor damage, then it runs off before it can be robbed again.",
              failureOrReset: "with no items at all it turns conventionally aggressive",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 21. drop-anything passive ---------------------------------------
  {
    bpPath: P.gacha,
    name: "Gacha",
    covers: "passive fed by dropping items on the ground",
    source: { page: "Gacha", revisionId: 586876, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Drop items", "direct-tame", ["passive"], {
          requirements: "A happy Gacha - sad ones ignore you",
          inputs: [text("Anything droppable", "offering", "", "rarer items give a higher level")],
          phases: [
            phase("Drop it", ["Drop items on the ground near it"], {
              repeatUntil: "it is tamed",
              note: "Larger quantities tame faster. It eats everything dropped.",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 22. taming by losing tames --------------------------------------
  {
    bpPath: P.troodon,
    name: "Troodon",
    covers: "passive paid for in sacrificed tames rather than food",
    source: { page: "Troodon", revisionId: 589010, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Sacrifice tames", "direct-tame", ["passive"], {
          inputs: [text("Your own tames", "offering", "", "must belong to you or your tribe")],
          phases: [
            phase("Let it kill", ["Allow it to kill your tames for combat experience"], {
              repeatUntil: "affinity is met - 343 + (32 × level)",
              note: "Only kills of your own or tribe creatures count. Requirement drops to 40% at night.",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 23. unique knockout, stun window --------------------------------
  {
    bpPath: "",
    name: "Yi Ling",
    covers: "knockout where tranquilizers do nothing - a timed stun window instead",
    source: { page: "Yi Ling", revisionId: 593265, game: "ASA" },
    info: {
      availability: "acquirable",
      methods: [
        method("Stun dive and narcotics", "direct-tame", ["knockout", "minigame"], {
          requirements: "Plant Species Z Fruit; a shield helps",
          inputs: [
            text("Plant Species Z Fruit", "catalyst", "", "thrown to stun mid-dive"),
            item(P.narcotic, "sedative", "", "Bio Toxin is best at 300 torpor per feed"),
          ],
          phases: [
            phase(
              "Build feather stacks",
              [
                "Let it fly up and shoot at you",
                "Avoid or shield its bite when it lands",
              ],
              {
                repeatUntil: "you have at least 30 stacks of feathers",
                completedWhen: "its wings glow faintly red while gliding",
              },
            ),
            phase("Stun it", ["Throw Plant Species Z Fruit as it dives at you"], {
              note: "It can only be stunned during the dive animation.",
              failureOrReset: "missing the window means waiting for another dive",
            }),
            phase("Feed narcotics", ["Feed narcotics from the last slot while stunned"], {
              repeatUntil: "it is downed",
            }),
          ],
        }),
      ],
    },
  },

  // ---- 24. craft and assemble ------------------------------------------
  {
    bpPath: "",
    name: "Enforcer",
    covers: "craft-and-assemble - never tamed at all",
    source: { page: "Enforcer", revisionId: 586878, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Craft from a blueprint", "craft-and-assemble", [], {
          requirements: "A City Terminal or Tek Replicator",
          inputs: [
            text("Enforcer Blueprint", "catalyst", "", "dropped by roaming Enforcers on death"),
          ],
          phases: [
            phase("Get a blueprint", ["Kill a roaming Enforcer in the Sanctuary"], {
              note: "Blueprint quality ranges Primitive to Ascendant with the Enforcer's level.",
            }),
            phase("Craft it", ["Craft at a City Terminal or Tek Replicator"]),
          ],
          completion: "A crafted Enforcer - level 1 without a better blueprint",
        }),
      ],
    },
  },

  // ---- 25. reward -------------------------------------------------------
  {
    bpPath: "",
    name: "Fenrir",
    covers: "reward - obtained only by beating a boss",
    source: { page: "Fenrir", revisionId: 587905, game: "both" },
    info: {
      availability: "acquirable",
      methods: [
        method("Defeat Fenrisúlfr", "reward", [], {
          requirements: "Access to the Fenrisúlfr boss fight",
          phases: [
            phase("Beat the boss", ["Defeat Fenrisúlfr at any difficulty"], {
              completedWhen: "a Cryopod is awarded",
              note: "Only the survivor who initiated the fight reliably receives it.",
            }),
          ],
          completion: "A Fenrir in a Cryopod, with random stats",
          failure: "Fenrir cannot be bred",
        }),
      ],
    },
  },
];
