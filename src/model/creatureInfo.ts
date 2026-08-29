import { z } from "zod";

/**
 * Creature acquisition workflows.
 *
 * The old model assumed one creature = one tame method = one linear list of
 * steps. ARK does not work that way: Carcharodontosaurus needs a mounted hunt
 * that builds trust, Gigantoraptor wants you to fight alongside it without
 * aggroing it, Rhyniognatha impregnates a host, some creatures are only ever
 * claimed as wild babies, and several have more than one valid route.
 *
 * So a creature has an overall *availability* and any number of *methods*, each of
 * which is a small editorial workflow: tags, requirements, inputs, and ordered
 * phases of steps. Deliberately not a programmable node graph - an admin is
 * writing down how a thing is caught, not authoring a state machine.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Whether the creature can be obtained at all. Deliberately only two values:
 * *what you end up with* varies per route, so that lives on the method.
 *
 * Legacy source taxonomy is per-method (raise-only, craft-only, reward-only,
 * temporary…), and several creatures prove a creature-level category wrong -
 * Carcharodontosaurus is rideable on trust before it is fully tamed, and a
 * Gigantoraptor adult can never be tamed at all, only its baby claimed.
 */
export const AVAILABILITIES = ["acquirable", "unavailable"] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export const AVAILABILITY_LABELS: Record<Availability, string> = {
  acquirable: "Acquirable",
  unavailable: "Unavailable",
};

export const AVAILABILITY_HINTS: Record<Availability, string> = {
  acquirable: "Can be obtained by at least one route below",
  unavailable: "Cannot be obtained by any means",
};

/** What a given route actually leaves you holding. */
export const METHOD_OUTCOMES = [
  "direct-tame",
  "claim",
  "hatch-and-raise",
  "birth-from-host",
  "temporary-control",
  "craft-and-assemble",
  "reward",
  "other",
] as const;
export type MethodOutcome = (typeof METHOD_OUTCOMES)[number];

export const OUTCOME_LABELS: Record<MethodOutcome, string> = {
  "direct-tame": "Direct tame",
  claim: "Claim",
  "hatch-and-raise": "Hatch and raise",
  "birth-from-host": "Birth from host",
  "temporary-control": "Temporary control",
  "craft-and-assemble": "Craft or assemble",
  reward: "Reward",
  other: "Other",
};

export const OUTCOME_HINTS: Record<MethodOutcome, string> = {
  "direct-tame": "Tamed in the world - a taming bar fills",
  claim: "Claimed outright, no taming bar",
  "hatch-and-raise": "From a wild, stolen or bred egg - raised from birth",
  "birth-from-host": "Born from a host creature",
  "temporary-control": "Yours for a limited time, then reverts",
  "craft-and-assemble": "Crafted or assembled rather than tamed",
  reward: "Granted for beating a boss or mission",
  other: "Something else",
};

/** Classification tags for a method. Free-form tags are allowed too. */
export const METHOD_TAGS = [
  "knockout",
  "passive",
  "trust",
  "mounted",
  "minigame",
  "combat-assist",
  "egg-theft",
  "wild-baby",
  "impregnation",
  "environmental",
  "temporary",
] as const;
export type MethodTag = (typeof METHOD_TAGS)[number];

export const TAG_LABELS: Record<MethodTag, string> = {
  knockout: "Knockout",
  passive: "Passive feeding",
  trust: "Trust building",
  mounted: "Mounted",
  minigame: "Minigame",
  "combat-assist": "Combat assistance",
  "egg-theft": "Egg theft",
  "wild-baby": "Wild baby",
  impregnation: "Impregnation / host",
  environmental: "Environmental",
  temporary: "Temporary",
};

/** What an input is *for* - the old model could only express "food". */
export const INPUT_ROLES = [
  "taming-food",
  "offering",
  "bait",
  "sedative",
  "required-buff",
  "catalyst",
  "host-creature",
  "craving",
  "optional-aid",
] as const;
export type InputRole = (typeof INPUT_ROLES)[number];

export const ROLE_LABELS: Record<InputRole, string> = {
  "taming-food": "Taming food",
  offering: "Offering",
  bait: "Bait",
  sedative: "Sedative",
  "required-buff": "Required buff",
  catalyst: "Catalyst",
  "host-creature": "Host creature",
  craving: "Craving",
  "optional-aid": "Optional aid",
};

/**
 * What an input points at. A Rhyniognatha surrogate is a *creature*, not an
 * item, and resolves against the creature catalog; a pheromone is an item.
 * Anything that isn't in either catalog stays free text.
 *
 * This is only for things consumed or supplied by the method - gear, mounts,
 * structures and conditions belong in `requirements`.
 */
export const REFERENCE_TYPES = ["item", "creature", "text"] as const;
export type ReferenceType = (typeof REFERENCE_TYPES)[number];

export const REFERENCE_LABELS: Record<ReferenceType, string> = {
  item: "Item",
  creature: "Creature",
  text: "Free text",
};

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const AcquisitionInputSchema = z.object({
  id: z.string(),
  /** What `bpPath` points at. Free text uses `label` instead. */
  referenceType: z.enum(REFERENCE_TYPES).default("text"),
  /** Catalog item or creature path, per `referenceType`. */
  bpPath: z.string().default(""),
  /** Used for free text, and as a fallback when a path won't resolve. */
  label: z.string().default(""),
  role: z.string().default("taming-food"),
  /**
   * @deprecated No longer edited or published - taming quantities depend on
   * level and server rates, so a fixed number here was misleading more often
   * than it helped. Kept so existing project files round-trip without losing
   * what was written; put anything worth saying in `note`.
   */
  qty: z.string().default(""),
  note: z.string().default(""),
});
export type AcquisitionInput = z.infer<typeof AcquisitionInputSchema>;

export const AcquisitionStepSchema = z.object({
  id: z.string(),
  text: z.string().default(""),
});
export type AcquisitionStep = z.infer<typeof AcquisitionStepSchema>;

export const AcquisitionPhaseSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  steps: z.array(AcquisitionStepSchema).default([]),
  /** Anything about the phase as a whole. */
  note: z.string().default(""),
  /**
   * Per-phase outcomes. A long workflow can loop and reset within a single
   * phase - a Gigantoraptor's nest phase resets on adult aggro while the
   * distraction phase merely needs another egg. All optional, so an ordinary
   * knockout never has to think about them.
   */
  repeatUntil: z.string().default(""),
  completedWhen: z.string().default(""),
  failureOrReset: z.string().default(""),
  transitionNote: z.string().default(""),
});
export type AcquisitionPhase = z.infer<typeof AcquisitionPhaseSchema>;

/** True when a phase has any of its optional outcome fields filled in. */
export function phaseHasOutcomes(phase: AcquisitionPhase): boolean {
  return Boolean(
    phase.repeatUntil.trim() ||
      phase.completedWhen.trim() ||
      phase.failureOrReset.trim() ||
      phase.transitionNote.trim(),
  );
}

export const AcquisitionMethodSchema = z.object({
  id: z.string(),
  name: z.string().default(""),
  /** What this particular route leaves you with. */
  outcome: z.enum(METHOD_OUTCOMES).or(z.literal("")).default(""),
  tags: z.array(z.string()).default([]),
  /** What you need before starting - gear, levels, a mount, a structure. */
  requirements: z.string().default(""),
  inputs: z.array(AcquisitionInputSchema).default([]),
  phases: z.array(AcquisitionPhaseSchema).default([]),
  /** The loop, when there is one ("until the trust bar fills"). */
  repeatUntil: z.string().default(""),
  /** How you know it worked. */
  completion: z.string().default(""),
  /** What resets or ruins it. */
  failure: z.string().default(""),
  /** Rates, multipliers, best-food notes. */
  effectiveness: z.string().default(""),
  /** Free-form advice for this method specifically. */
  strategy: z.string().default(""),
});
export type AcquisitionMethod = z.infer<typeof AcquisitionMethodSchema>;

/**
 * Whether a trait does something on command or is simply true of the creature.
 *
 * The distinction is what a player actually asks: "what can I *do* with it"
 * versus "what do I get for having it". A Yuty's courage roar is a button; its
 * pack bonus is a fact.
 */
export const ABILITY_KINDS = ["active", "passive"] as const;
export type AbilityKind = (typeof ABILITY_KINDS)[number];

export const ABILITY_KIND_LABELS: Record<AbilityKind, string> = {
  active: "Active",
  passive: "Passive",
};

export const ABILITY_KIND_HINTS: Record<AbilityKind, string> = {
  active: "Used deliberately - an attack, a toggle, a rider ability",
  passive: "Always in effect - a resistance, an aura, a stat trait",
};

/**
 * Passive traits that are really per-item tables rather than prose.
 *
 * "Reduces weight" is useless on its own - an Ankylo reduces metal, stone and
 * flint by different amounts, and that is exactly what a player needs. So
 * these effects carry a list of items and numbers instead of a sentence.
 *
 * `none` is every other ability: a plain label and a note.
 */
export const ABILITY_EFFECTS = [
  "none",
  "weight-reduction",
  "preserver",
  "conversion",
] as const;
export type AbilityEffect = (typeof ABILITY_EFFECTS)[number];

export const ABILITY_EFFECT_LABELS: Record<AbilityEffect, string> = {
  none: "Plain description",
  "weight-reduction": "Weight reduction",
  preserver: "Preserver",
  conversion: "Conversion",
};

export const ABILITY_EFFECT_HINTS: Record<AbilityEffect, string> = {
  none: "Just a label and a note",
  "weight-reduction": "Carries listed items for less than their real weight",
  preserver: "Slows spoilage for listed items",
  conversion: "Turns one item into another over time",
};

/**
 * One row of a structured effect. Which fields matter depends on the effect:
 * weight reduction and preserver use the item and the percentage; conversion
 * uses both items and both rates.
 */
export const AbilityEffectRowSchema = z.object({
  id: z.string(),
  /** The affected item, or the input of a conversion. */
  bpPath: z.string().default(""),
  /** Free text fallback when the item is not in the catalog. */
  label: z.string().default(""),
  /** Percentage, however the admin phrases it - "50", "50%", "up to 60%". */
  percent: z.string().default(""),
  /** Conversion output. */
  toBpPath: z.string().default(""),
  toLabel: z.string().default(""),
  /** Conversion amounts, in and out - "3" feces becomes "1" oil. */
  rate: z.string().default(""),
  toRate: z.string().default(""),
  note: z.string().default(""),
});
export type AbilityEffectRow = z.infer<typeof AbilityEffectRowSchema>;

export function emptyAbilityEffectRow(id: string, bpPath = ""): AbilityEffectRow {
  return {
    id,
    bpPath,
    label: "",
    percent: "",
    toBpPath: "",
    toLabel: "",
    rate: "",
    toRate: "",
    note: "",
  };
}

/** Whether an effect wants a percentage, a conversion target, or neither. */
export function effectShape(effect: AbilityEffect): {
  hasPercent: boolean;
  hasConversion: boolean;
  /** Label for the percentage column, when there is one. */
  percentLabel: string;
} {
  switch (effect) {
    case "weight-reduction":
      return { hasPercent: true, hasConversion: false, percentLabel: "reduction %" };
    case "preserver":
      return { hasPercent: true, hasConversion: false, percentLabel: "spoil timer +%" };
    case "conversion":
      return { hasPercent: false, hasConversion: true, percentLabel: "" };
    default:
      return { hasPercent: false, hasConversion: false, percentLabel: "" };
  }
}

export const CreatureAbilitySchema = z.object({
  id: z.string(),
  label: z.string(),
  detail: z.string().default(""),
  /**
   * Records written before the split are passive: that was the sense of
   * nearly every preset, and calling a trait passive understates it far less
   * than promising an active ability that isn't there.
   */
  kind: z.enum(ABILITY_KINDS).default("passive"),
  /** Structured shape, when this trait is a per-item table. */
  effect: z.enum(ABILITY_EFFECTS).default("none"),
  /** The rows of that table. Empty for a plain ability. */
  rows: z.array(AbilityEffectRowSchema).default([]),
});
export type CreatureAbility = z.infer<typeof CreatureAbilitySchema>;

/**
 * Common ARK traits, offered as one-click chips so the ability list stays
 * consistent across creatures instead of ten spellings of "causes bleeding".
 * Anything not here can still be typed in.
 */
export interface AbilityPreset {
  label: string;
  kind: AbilityKind;
  /** Picking this preset starts the structured table it implies. */
  effect?: AbilityEffect;
}

export const ABILITY_PRESETS: AbilityPreset[] = [
  // Things the creature (or its rider) does.
  { label: "Causes bleed", kind: "active" },
  { label: "Applies torpor", kind: "active" },
  { label: "Inflicts poison", kind: "active" },
  { label: "Drains stamina", kind: "active" },
  { label: "Can climb", kind: "active" },
  { label: "Can glide", kind: "active" },
  { label: "Can grapple", kind: "active" },
  { label: "Carries survivors", kind: "active" },
  { label: "Turret mode", kind: "active" },
  { label: "Stealth / cloaking", kind: "active" },
  { label: "Healing", kind: "active" },
  // Things that are simply true of it.
  { label: "Pack bonus", kind: "passive" },
  { label: "Mate boost", kind: "passive" },
  { label: "Damage resistant", kind: "passive" },
  { label: "Immune to radiation", kind: "passive" },
  { label: "Water breathing", kind: "passive" },
  { label: "Rider weapons allowed", kind: "passive" },
  { label: "Harvests efficiently", kind: "passive" },
  // These three are per-item tables rather than descriptions.
  { label: "Weight reduction", kind: "passive", effect: "weight-reduction" },
  { label: "Preserver", kind: "passive", effect: "preserver" },
  { label: "Conversion", kind: "passive", effect: "conversion" },
  { label: "Buff aura", kind: "passive" },
  { label: "Debuff aura", kind: "passive" },
  { label: "Tanks fall damage", kind: "passive" },
];

/** The preset matching a label, case-insensitively. */
export function abilityPresetFor(label: string): AbilityPreset | undefined {
  const key = label.trim().toLowerCase();
  return ABILITY_PRESETS.find((p) => p.label.toLowerCase() === key);
}

export const TechnicalSchema = z.object({
  /** Decides what can carry it and which traps hold it. */
  dragWeight: z.number().min(0).nullable().default(null),
});
export type Technical = z.infer<typeof TechnicalSchema>;

// ---------------------------------------------------------------------------
// Drops
// ---------------------------------------------------------------------------

/**
 * One thing a creature yields. Catalog-backed where possible so the viewer can
 * resolve a real name and icon, free text where it isn't ("a random saddle
 * blueprint").
 */
export const DropEntrySchema = z.object({
  id: z.string(),
  /** Catalog item path. Empty means this is free text carried by `label`. */
  bpPath: z.string().default(""),
  /** Used for free text, and as a fallback when a path won't resolve. */
  label: z.string().default(""),
  /** Free text - "1-3", "x5", "stack of 10". */
  qty: z.string().default(""),
  /**
   * Drop odds, as the admin wants to phrase them ("12%", "1 in 8").
   * Meaningless for harvest and guaranteed loot, so the editor hides it there.
   */
  chance: z.string().default(""),
  /**
   * How often a tamed creature generates this, as an amount and a period -
   * "1" every "5 min". Only production entries have a rate; the other lists
   * describe a single event rather than something recurring.
   */
  rate: z.string().default(""),
  per: z.string().default(""),
  note: z.string().default(""),
});
export type DropEntry = z.infer<typeof DropEntrySchema>;

export const DropsSchema = z.object({
  /** What harvesting the corpse yields. */
  harvest: z.array(DropEntrySchema).default([]),
  /** Special loot that always drops. */
  guaranteed: z.array(DropEntrySchema).default([]),
  /** Special loot that drops by chance - record the odds. */
  random: z.array(DropEntrySchema).default([]),
  /**
   * What a tamed one makes in its own inventory over time - Achatina paste,
   * Dung Beetle oil.
   *
   * This documents the creature's inherent behaviour, and is not the cluster's
   * configured passive production: that lives in the production rules and is
   * published separately. A creature can perfectly well have both.
   */
  production: z.array(DropEntrySchema).default([]),
});
export type Drops = z.infer<typeof DropsSchema>;

export type DropListKey = keyof Drops;

/** The drop lists, in the order they read. Drives the editor and viewer. */
export const DROP_LISTS: {
  key: DropListKey;
  label: string;
  hint: string;
  /** Whether odds are worth asking for - they only mean something for random loot. */
  hasChance: boolean;
  /** Whether this recurs over time, and so needs a rate rather than a quantity. */
  hasRate: boolean;
}[] = [
  {
    key: "harvest",
    label: "Harvest",
    hint: "What harvesting the body yields",
    hasChance: false,
    hasRate: false,
  },
  {
    key: "guaranteed",
    label: "Guaranteed special loot",
    hint: "Always dropped - no roll involved",
    hasChance: false,
    hasRate: false,
  },
  {
    key: "random",
    label: "Random special loot",
    hint: "Dropped by chance - record the odds you know",
    hasChance: true,
    hasRate: false,
  },
  {
    key: "production",
    label: "Production (tamed inventory)",
    hint: "What a tamed one generates over time, in its own inventory",
    hasChance: false,
    hasRate: true,
  },
];

export function emptyDrops(): Drops {
  return { harvest: [], guaranteed: [], random: [], production: [] };
}

export function emptyDropEntry(id: string, bpPath = ""): DropEntry {
  return { id, bpPath, label: "", qty: "", chance: "", rate: "", per: "", note: "" };
}

/** "1 / 5 min", or as much of it as was filled in. */
export function formatRate(entry: DropEntry): string {
  const rate = entry.rate.trim();
  const per = entry.per.trim();
  if (rate && per) return `${rate} / ${per}`;
  return rate || (per ? `per ${per}` : "");
}

/** True once any of the three lists has something in it. */
export function hasDrops(drops: Drops): boolean {
  return DROP_LISTS.some((list) => drops[list.key].length > 0);
}

/** Total entries across all three lists. */
export function dropCount(drops: Drops): number {
  return DROP_LISTS.reduce((n, list) => n + drops[list.key].length, 0);
}

/** The editor's tabs, and the unit of variant inheritance. */
export const INFO_SECTIONS = [
  "acquisition",
  "spawns",
  "abilities",
  "drops",
  "technical",
  "notes",
] as const;
export type InfoSection = (typeof INFO_SECTIONS)[number];

export const SECTION_LABELS: Record<InfoSection, string> = {
  acquisition: "Acquisition",
  spawns: "Spawns",
  abilities: "Abilities",
  drops: "Drops",
  technical: "Technical",
  notes: "Notes",
};

const RawCreatureInfoSchema = z.object({
  availability: z.enum(AVAILABILITIES).or(z.literal("")).default(""),
  methods: z.array(AcquisitionMethodSchema).default([]),
  /**
   * Maps this creature actually spawns on, by name, matching the Maps setting.
   *
   * Distinct from the catalog's single map *of origin*, which is derived from
   * the blueprint path and says only where the content came from. A Scorched
   * Earth wyvern also spawns on Ragnarok, and that is what a player needs to
   * know - so this is a list, kept per creature, and overridable per variant
   * because that is exactly where variants differ.
   */
  spawnMaps: z.array(z.string()).default([]),
  abilities: z.array(CreatureAbilitySchema).default([]),
  drops: DropsSchema.default(() => DropsSchema.parse({})),
  technical: TechnicalSchema.default(() => TechnicalSchema.parse({})),
  /** The one prose field. Published to the viewer. */
  notes: z.string().default(""),
  /**
   * Sections this record owns. Anything not listed is inherited from the
   * parent creature, so an Aberrant variant stores only what differs.
   * Ignored for a creature that has no parent - it owns everything.
   */
  overrides: z.array(z.enum(INFO_SECTIONS)).default([]),
});

/** v1 status -> [availability, the outcome its methods take on]. */
const STATUS_TO_OUTCOME: Record<string, [string, MethodOutcome | ""]> = {
  tameable: ["acquirable", "direct-tame"],
  offspring: ["acquirable", "hatch-and-raise"],
  claimable: ["acquirable", "claim"],
  temporary: ["acquirable", "temporary-control"],
  untameable: ["unavailable", ""],
};

/** Renamed input roles, old -> new. */
const ROLE_RENAMES: Record<string, InputRole> = {
  buff: "required-buff",
  aid: "optional-aid",
  "host-item": "host-creature",
};

/**
 * Brings older records up to date on read. Two shapes came before this one:
 *
 *  v0 - one `tameMethod`, one food list, one flat step list.
 *  v1 - workflows, but a creature-level `status` and item-only inputs.
 *
 * Nothing is rewritten on disk until the record is next saved.
 */
/**
 * Sections a raw record actually holds data for.
 *
 * Used to give a pre-`overrides` record ownership of what it wrote. Reads the
 * raw shape rather than a parsed one because this runs before validation.
 */
function populatedSections(raw: Record<string, unknown>): InfoSection[] {
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const technical = (raw.technical ?? {}) as Record<string, unknown>;
  const drops = (raw.drops ?? {}) as Record<string, unknown>;
  const out: InfoSection[] = [];

  if (raw.availability || raw.status || arr(raw.methods).length > 0) {
    out.push("acquisition");
  }
  if (arr(raw.spawnMaps).length > 0) out.push("spawns");
  if (arr(raw.abilities).length > 0) out.push("abilities");
  if (DROP_LISTS.some((list) => arr(drops[list.key]).length > 0)) {
    out.push("drops");
  }
  // `dragWeight` sat at the top level before it moved under `technical`.
  if (technical.dragWeight != null || raw.dragWeight != null) {
    out.push("technical");
  }
  if (typeof raw.notes === "string" && raw.notes.trim()) out.push("notes");
  return out;
}

function migrateLegacy(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  let raw = value as Record<string, unknown>;

  /**
   * A record written before sections could be owned says nothing about
   * inheritance - but it plainly owns whatever it already contains.
   *
   * Defaulting those to "inherit everything" is not a harmless default: the
   * moment such a creature is detected as a variant, its own methods and notes
   * are hidden behind the parent's, and claiming the section to edit it
   * overwrites the hidden original with a copy of the parent's data.
   *
   * A record that stores `overrides: []` explicitly meant it, and is left
   * alone - that is a variant deliberately following its parent in full.
   */
  const declaresOverrides = "overrides" in raw;

  // ---- v0 -> v1 ----
  // `dragWeight` at the top level is the giveaway for a record that only ever
  // had that set - it must still be lifted into `technical`.
  const isV0 =
    "tameMethod" in raw ||
    "foods" in raw ||
    "steps" in raw ||
    "dragWeight" in raw;

  if (isV0) {
    const legacyMethod = typeof raw.tameMethod === "string" ? raw.tameMethod : "";
    const foods = Array.isArray(raw.foods) ? raw.foods : [];
    const steps = Array.isArray(raw.steps) ? raw.steps : [];

    const tag =
      legacyMethod === "knockout"
        ? "knockout"
        : legacyMethod === "passive"
          ? "passive"
          : "";

    const name =
      legacyMethod === "knockout"
        ? "Knockout tame"
        : legacyMethod === "passive"
          ? "Passive tame"
          : legacyMethod === "unique"
            ? "Unique tame"
            : "Taming";

    const hasWorkflow = Boolean(tag || foods.length || steps.length);
    raw = {
      status:
        legacyMethod === "none" ? "untameable" : legacyMethod ? "tameable" : "",
      methods: hasWorkflow
        ? [
            {
              id: `${name}-migrated`,
              name,
              tags: tag ? [tag] : [],
              inputs: foods.map((f, i) => {
                const food = (f ?? {}) as Record<string, unknown>;
                return {
                  id: typeof food.id === "string" ? food.id : `food-${i}`,
                  bpPath: typeof food.bpPath === "string" ? food.bpPath : "",
                  role: "taming-food",
                  note: typeof food.note === "string" ? food.note : "",
                };
              }),
              phases:
                steps.length > 0
                  ? [
                      {
                        id: "phase-migrated",
                        name: "Process",
                        steps: steps.map((s, i) => {
                          const step = (s ?? {}) as Record<string, unknown>;
                          return {
                            id:
                              typeof step.id === "string" ? step.id : `step-${i}`,
                            text: typeof step.text === "string" ? step.text : "",
                          };
                        }),
                      },
                    ]
                  : [],
            },
          ]
        : [],
      abilities: raw.abilities ?? [],
      technical: { dragWeight: raw.dragWeight ?? null },
      notes: typeof raw.notes === "string" ? raw.notes : "",
      overrides: [],
    };
  }

  // ---- v1 -> v2: status becomes availability + per-method outcome ----
  const hasV1Status = "status" in raw && !("availability" in raw);
  const [availability, outcome] = hasV1Status
    ? (STATUS_TO_OUTCOME[String(raw.status)] ?? ["", ""])
    : ["", ""];

  const methods = Array.isArray(raw.methods) ? raw.methods : [];
  const upgraded = methods.map((m) => {
    const method = { ...((m ?? {}) as Record<string, unknown>) };
    if (hasV1Status && !method.outcome && outcome) method.outcome = outcome;

    const inputs = Array.isArray(method.inputs) ? method.inputs : [];
    method.inputs = inputs.map((x) => {
      const input = { ...((x ?? {}) as Record<string, unknown>) };
      const role = String(input.role ?? "taming-food");
      input.role = ROLE_RENAMES[role] ?? role;
      if (!input.referenceType) {
        // A host was the only creature-shaped input v1 could express.
        input.referenceType =
          input.role === "host-creature"
            ? "creature"
            : input.bpPath
              ? "item"
              : "text";
      }
      return input;
    });
    return method;
  });

  const out: Record<string, unknown> = { ...raw, methods: upgraded };
  if (hasV1Status) {
    out.availability = availability;
    delete out.status;
  }

  // Last, so it sees the fully migrated shape rather than the legacy one.
  if (!declaresOverrides) out.overrides = populatedSections(out);
  return out;
}

export const CreatureInfoSchema = z.preprocess(
  migrateLegacy,
  RawCreatureInfoSchema,
);
export type CreatureInfo = z.infer<typeof RawCreatureInfoSchema>;

export function emptyCreatureInfo(): CreatureInfo {
  return {
    availability: "",
    methods: [],
    spawnMaps: [],
    abilities: [],
    drops: emptyDrops(),
    technical: { dragWeight: null },
    notes: "",
    overrides: [],
  };
}

export function emptyPhase(id: string, name = ""): AcquisitionPhase {
  return {
    id,
    name,
    steps: [],
    note: "",
    repeatUntil: "",
    completedWhen: "",
    failureOrReset: "",
    transitionNote: "",
  };
}

export function emptyMethod(id: string, name = "New method"): AcquisitionMethod {
  return {
    id,
    name,
    outcome: "",
    tags: [],
    requirements: "",
    inputs: [],
    phases: [],
    repeatUntil: "",
    completion: "",
    failure: "",
    effectiveness: "",
    strategy: "",
  };
}

// ---------------------------------------------------------------------------
// Variant inheritance
// ---------------------------------------------------------------------------

export interface ResolvedCreatureInfo {
  info: CreatureInfo;
  /** Blueprint path the inherited sections came from, when any did. */
  inheritedFrom: string | null;
  /** Sections that came from the parent rather than this creature. */
  inheritedSections: InfoSection[];
}

/**
 * A variant's effective info: its own overridden sections, everything else
 * from its parent. One hop only - `variantParent` already resolves a variant
 * straight to its base creature.
 */
export function resolveCreatureInfo(
  own: CreatureInfo | undefined,
  parent: CreatureInfo | undefined,
  parentPath: string | null,
): ResolvedCreatureInfo {
  const mine = own ?? emptyCreatureInfo();
  if (!parent || !parentPath) {
    return { info: mine, inheritedFrom: null, inheritedSections: [] };
  }

  const owns = new Set(mine.overrides);
  const inherited = INFO_SECTIONS.filter((s) => !owns.has(s));
  return {
    info: {
      availability: owns.has("acquisition") ? mine.availability : parent.availability,
      methods: owns.has("acquisition") ? mine.methods : parent.methods,
      spawnMaps: owns.has("spawns") ? mine.spawnMaps : parent.spawnMaps,
      abilities: owns.has("abilities") ? mine.abilities : parent.abilities,
      drops: owns.has("drops") ? mine.drops : parent.drops,
      technical: owns.has("technical") ? mine.technical : parent.technical,
      notes: owns.has("notes") ? mine.notes : parent.notes,
      overrides: mine.overrides,
    },
    inheritedFrom: parentPath,
    inheritedSections: inherited,
  };
}

/**
 * Starts overriding a section, seeding it with what was being inherited so the
 * admin edits a copy rather than an empty form.
 */
export function overrideSection(
  own: CreatureInfo,
  resolved: CreatureInfo,
  section: InfoSection,
): CreatureInfo {
  if (own.overrides.includes(section)) return own;
  const next: CreatureInfo = {
    ...own,
    overrides: [...own.overrides, section],
  };
  if (section === "acquisition") {
    next.availability = resolved.availability;
    next.methods = structuredClone(resolved.methods);
  } else if (section === "spawns") {
    next.spawnMaps = [...resolved.spawnMaps];
  } else if (section === "abilities") {
    next.abilities = structuredClone(resolved.abilities);
  } else if (section === "drops") {
    next.drops = structuredClone(resolved.drops);
  } else if (section === "technical") {
    next.technical = { ...resolved.technical };
  } else {
    next.notes = resolved.notes;
  }
  return next;
}

/** Stops overriding a section, dropping this creature's copy of it. */
export function inheritSection(
  own: CreatureInfo,
  section: InfoSection,
): CreatureInfo {
  const next: CreatureInfo = {
    ...own,
    overrides: own.overrides.filter((s) => s !== section),
  };
  const blank = emptyCreatureInfo();
  if (section === "acquisition") {
    next.availability = blank.availability;
    next.methods = blank.methods;
  } else if (section === "spawns") {
    next.spawnMaps = blank.spawnMaps;
  } else if (section === "abilities") {
    next.abilities = blank.abilities;
  } else if (section === "drops") {
    next.drops = blank.drops;
  } else if (section === "technical") {
    next.technical = blank.technical;
  } else {
    next.notes = blank.notes;
  }
  return next;
}

// ---------------------------------------------------------------------------
// Method templates
// ---------------------------------------------------------------------------

export interface MethodTemplate {
  name: string;
  tags: MethodTag[];
  outcome: MethodOutcome;
  requirements?: string;
  phases: { name: string; steps: string[] }[];
  repeatUntil?: string;
  completion?: string;
  failure?: string;
}

/**
 * Starting shapes for each kind of acquisition. Scaffolds to edit, not
 * authoritative data; retained source records govern each creature.
 */
export const METHOD_TEMPLATES: Record<MethodTag, MethodTemplate> = {
  knockout: {
    name: "Knockout tame",
    tags: ["knockout"],
    outcome: "direct-tame",
    requirements: "Tranq weapon, narcotics, the food below",
    phases: [
      { name: "Prepare", steps: ["Trap it or find safe high ground"] },
      {
        name: "Knock out",
        steps: ["Apply torpor until it drops", "Watch for torpor draining"],
      },
      {
        name: "Feed",
        steps: ["Put the food in its inventory", "Top up torpor as needed"],
      },
    ],
    repeatUntil: "The taming bar fills",
    failure: "It wakes up, or starves before the bar fills",
  },
  passive: {
    name: "Passive tame",
    tags: ["passive"],
    outcome: "direct-tame",
    requirements: "The food below, no weapon drawn",
    phases: [
      { name: "Approach", steps: ["Clear nearby aggro", "Approach unarmed"] },
      {
        name: "Feed",
        steps: ["Put the food in your last hotbar slot", "Feed, then back off"],
      },
    ],
    repeatUntil: "The taming bar fills",
    failure: "It is damaged or spooked and resets",
  },
  trust: {
    name: "Trust building",
    tags: ["trust"],
    outcome: "direct-tame",
    phases: [
      { name: "Earn attention", steps: ["Get it to notice you without hostility"] },
      { name: "Build trust", steps: ["Repeat the trust action", "Keep it alive and unprovoked"] },
    ],
    repeatUntil: "Trust reaches the threshold",
    failure: "Trust decays over time or resets if you attack it",
  },
  mounted: {
    name: "Mounted process",
    tags: ["mounted"],
    outcome: "direct-tame",
    requirements: "A suitable mount",
    phases: [
      { name: "Prepare the mount", steps: ["Bring the required mount in good health"] },
      { name: "Carry out the process", steps: ["Stay mounted throughout"] },
    ],
    failure: "Dismounting, or losing the mount, resets progress",
  },
  minigame: {
    name: "Minigame",
    tags: ["minigame"],
    outcome: "direct-tame",
    phases: [
      { name: "Start", steps: ["Trigger the minigame"] },
      { name: "Play", steps: ["Complete the objective within the time limit"] },
    ],
    completion: "The minigame is completed successfully",
    failure: "Timing out or failing the objective resets it",
  },
  "combat-assist": {
    name: "Combat assistance",
    tags: ["combat-assist"],
    outcome: "direct-tame",
    phases: [
      { name: "Find it fighting", steps: ["Locate it engaged with a target"] },
      {
        name: "Help without aggroing",
        steps: ["Damage its target only", "Never hit the creature itself"],
      },
    ],
    repeatUntil: "Its affinity fills",
    failure: "Hitting the creature resets progress",
  },
  "egg-theft": {
    name: "Egg theft",
    tags: ["egg-theft"],
    outcome: "hatch-and-raise",
    phases: [
      { name: "Find a nest", steps: ["Locate a wild egg"] },
      { name: "Escape", steps: ["Take the egg", "Outrun what comes after you"] },
    ],
    completion: "The egg is secured and can be incubated",
  },
  "wild-baby": {
    name: "Wild baby claim",
    tags: ["wild-baby"],
    outcome: "claim",
    phases: [
      { name: "Find a baby", steps: ["Locate a wild juvenile"] },
      { name: "Claim", steps: ["Claim it", "Have food ready - it needs raising immediately"] },
    ],
    completion: "Claimed, and now an unraised baby",
  },
  impregnation: {
    name: "Impregnation / host",
    tags: ["impregnation"],
    outcome: "birth-from-host",
    requirements: "A suitable host creature",
    phases: [
      { name: "Prepare the host", steps: ["Bring the host to the creature"] },
      { name: "Let it happen", steps: ["Allow the implantation", "Protect the host through gestation"] },
    ],
    completion: "The offspring is born from the host",
    failure: "The host dies before gestation completes",
  },
  environmental: {
    name: "Environmental",
    tags: ["environmental"],
    outcome: "direct-tame",
    phases: [
      { name: "Meet the conditions", steps: ["Satisfy the environmental requirement"] },
      { name: "Complete", steps: ["Carry out the acquisition while conditions hold"] },
    ],
    failure: "Leaving the required conditions resets it",
  },
  temporary: {
    name: "Temporary tame",
    tags: ["temporary"],
    outcome: "temporary-control",
    phases: [
      { name: "Acquire", steps: ["Perform the temporary-tame action"] },
    ],
    completion: "Yours for the duration",
    failure: "Reverts to wild when the timer runs out",
  },
};

export type TemplateMode = "fill-empty" | "merge-missing" | "replace";

export const TEMPLATE_MODE_LABELS: Record<TemplateMode, string> = {
  "fill-empty": "Fill empty sections only",
  "merge-missing": "Add missing phases",
  // Not "everything": applyTemplate keeps inputs, strategy, effectiveness, and
  // any name/outcome/tags already set. Only the fields a template owns go.
  replace: "Replace template-managed fields",
};

/**
 * What applying a template would change, as plain lines for a preview. Empty
 * means nothing would change - templates must never silently overwrite.
 */
export function describeTemplate(
  method: AcquisitionMethod,
  template: MethodTemplate,
  mode: TemplateMode,
): string[] {
  const out: string[] = [];
  const has = (v: string) => Boolean(v.trim());
  const phaseNames = new Set(
    method.phases.map((p) => p.name.trim().toLowerCase()),
  );

  /**
   * Identity fields, which every mode fills the same way - only when empty.
   * These are listed first because they are the changes an admin is least
   * expecting: the preview promises the exact set, so leaving them out made
   * a template silently rename and re-tag the method.
   */
  if (!has(method.name)) out.push(`Set method name to "${template.name}"`);
  if (!method.outcome && template.outcome) {
    out.push(`Set outcome to "${OUTCOME_LABELS[template.outcome]}"`);
  }
  for (const tag of template.tags) {
    if (!method.tags.includes(tag)) {
      out.push(`Add tag "${TAG_LABELS[tag] ?? tag}"`);
    }
  }

  if (mode === "replace") {
    if (method.phases.length > 0) {
      out.push(
        `Remove all ${method.phases.length} existing phase(s) and their steps`,
      );
    }
    for (const p of template.phases) {
      out.push(`Add phase "${p.name}" with ${p.steps.length} step(s)`);
    }
    for (const [label, value] of textFields(template)) {
      if (value) out.push(`Set ${label}`);
    }
    return out;
  }

  for (const p of template.phases) {
    if (!phaseNames.has(p.name.trim().toLowerCase())) {
      out.push(`Add phase "${p.name}" with ${p.steps.length} step(s)`);
    }
  }
  for (const [label, value, current] of textFieldsWithCurrent(method, template)) {
    if (value && !has(current)) out.push(`Fill ${label}`);
  }
  if (mode === "fill-empty" && method.phases.length > 0) {
    // Nothing is added to a method that already has phases.
    return out.filter((line) => !line.startsWith("Add phase"));
  }
  return out;
}

function textFields(t: MethodTemplate): [string, string][] {
  return [
    ["requirements", t.requirements ?? ""],
    ["repeat-until", t.repeatUntil ?? ""],
    ["completion", t.completion ?? ""],
    ["failure/reset", t.failure ?? ""],
  ];
}

function textFieldsWithCurrent(
  m: AcquisitionMethod,
  t: MethodTemplate,
): [string, string, string][] {
  return [
    ["requirements", t.requirements ?? "", m.requirements],
    ["repeat-until", t.repeatUntil ?? "", m.repeatUntil],
    ["completion", t.completion ?? "", m.completion],
    ["failure/reset", t.failure ?? "", m.failure],
  ];
}

/**
 * Applies a template. `newId` is injected so the caller controls id generation
 * (and tests stay deterministic).
 */
export function applyTemplate(
  method: AcquisitionMethod,
  template: MethodTemplate,
  mode: TemplateMode,
  newId: () => string,
): AcquisitionMethod {
  const buildPhases = () =>
    template.phases.map((p) => ({
      ...emptyPhase(newId(), p.name),
      steps: p.steps.map((text) => ({ id: newId(), text })),
    }));

  if (mode === "replace") {
    return {
      ...method,
      name: method.name.trim() || template.name,
      outcome: method.outcome || template.outcome,
      tags: mergeTags(method.tags, template.tags),
      requirements: template.requirements ?? "",
      phases: buildPhases(),
      repeatUntil: template.repeatUntil ?? "",
      completion: template.completion ?? "",
      failure: template.failure ?? "",
    };
  }

  const fill = (current: string, value: string | undefined) =>
    current.trim() ? current : (value ?? "");

  const existing = new Set(
    method.phases.map((p) => p.name.trim().toLowerCase()),
  );
  const addPhases =
    mode === "fill-empty" && method.phases.length > 0
      ? []
      : buildPhases().filter(
          (p) => !existing.has(p.name.trim().toLowerCase()),
        );

  return {
    ...method,
    name: method.name.trim() || template.name,
    outcome: method.outcome || template.outcome,
    tags: mergeTags(method.tags, template.tags),
    requirements: fill(method.requirements, template.requirements),
    phases: [...method.phases, ...addPhases],
    repeatUntil: fill(method.repeatUntil, template.repeatUntil),
    completion: fill(method.completion, template.completion),
    failure: fill(method.failure, template.failure),
  };
}

function mergeTags(current: string[], add: string[]): string[] {
  const out = [...current];
  for (const tag of add) if (!out.includes(tag)) out.push(tag);
  return out;
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

const filled = (...values: string[]) => values.some((v) => v.trim());

/**
 * Drops rows that carry nothing.
 *
 * Adding a row is how you find out what a row wants, so half the rows an admin
 * creates are abandoned the moment they see the columns. Clearing those on
 * save keeps the record honest without nagging during editing - nothing is
 * removed while the modal is open, only when the work is committed.
 *
 * The test is always "is there anything identifying here": a row with only a
 * note but no item is still kept, because the note is content.
 */
export function pruneCreatureInfo(info: CreatureInfo): CreatureInfo {
  return {
    ...info,
    methods: info.methods.map((method) => ({
      ...method,
      inputs: method.inputs.filter((input) =>
        filled(input.bpPath, input.label, input.qty, input.note),
      ),
      phases: method.phases
        .map((phase) => ({
          ...phase,
          steps: phase.steps.filter((step) => filled(step.text)),
        }))
        // A phase is worth keeping if it is named or still has steps, even
        // when its own outcome fields are empty.
        .filter(
          (phase) =>
            filled(phase.name) ||
            phase.steps.length > 0 ||
            phaseHasOutcomes(phase) ||
            filled(phase.note),
        ),
    })),
    spawnMaps: info.spawnMaps.filter((map) => map.trim()),
    abilities: info.abilities
      .filter((ability) => filled(ability.label))
      .map((ability) => ({
        ...ability,
        rows:
          ability.effect === "none"
            ? []
            : ability.rows.filter((row) =>
                filled(
                  row.bpPath,
                  row.label,
                  row.toBpPath,
                  row.toLabel,
                  row.percent,
                  row.rate,
                  row.toRate,
                  row.note,
                ),
              ),
      })),
    drops: DROP_LISTS.reduce((out, list) => {
      out[list.key] = info.drops[list.key].filter((entry) =>
        filled(
          entry.bpPath,
          entry.label,
          entry.qty,
          entry.chance,
          entry.rate,
          entry.per,
          entry.note,
        ),
      );
      return out;
    }, {} as Drops),
  };
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/** True when the admin has recorded anything at all on this record. */
export function hasCreatureInfo(info: CreatureInfo | undefined): boolean {
  if (!info) return false;
  return Boolean(
    info.availability ||
      info.methods.length > 0 ||
      info.spawnMaps.length > 0 ||
      info.abilities.length > 0 ||
      hasDrops(info.drops) ||
      info.technical.dragWeight !== null ||
      info.notes.trim(),
  );
}

/** Display label for a method, falling back to its tags then a placeholder. */
export function methodLabel(method: AcquisitionMethod): string {
  if (method.name.trim()) return method.name.trim();
  const tag = method.tags[0];
  if (tag) return TAG_LABELS[tag as MethodTag] ?? tag;
  return "Untitled method";
}

/** Display label for an input - the catalog name is resolved by the caller. */
export function inputLabel(input: AcquisitionInput, resolved: string): string {
  return input.bpPath ? resolved : input.label.trim() || "(unnamed)";
}

/** One-line digest for the entry list, e.g. "Tameable · 2 methods · DW 150". */
export function creatureInfoSummary(info: CreatureInfo): string {
  const parts: string[] = [];
  if (info.availability) parts.push(AVAILABILITY_LABELS[info.availability]);
  if (info.methods.length > 0) {
    parts.push(
      `${info.methods.length} method${info.methods.length === 1 ? "" : "s"}`,
    );
  }
  if (info.abilities.length > 0) {
    parts.push(
      `${info.abilities.length} abilit${info.abilities.length === 1 ? "y" : "ies"}`,
    );
  }
  const drops = dropCount(info.drops);
  if (drops > 0) parts.push(`${drops} drop${drops === 1 ? "" : "s"}`);
  if (info.spawnMaps.length > 0) {
    parts.push(
      `${info.spawnMaps.length} map${info.spawnMaps.length === 1 ? "" : "s"}`,
    );
  }
  if (info.technical.dragWeight !== null) {
    parts.push(`DW ${info.technical.dragWeight}`);
  }
  return parts.join(" · ");
}

/** Total steps across every phase of a method - used for the method list. */
export function methodStepCount(method: AcquisitionMethod): number {
  return method.phases.reduce((n, p) => n + p.steps.length, 0);
}
