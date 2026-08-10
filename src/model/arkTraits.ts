/**
 * ASA creature traits, for the Dino Depot `-g=` argument.
 *
 * Provenance, because it matters when a wrong token produces a silently
 * broken command: the names come from the official wiki's creature-traits
 * table (ark.wiki.gg/wiki/Traits). The `token` — what actually goes into the
 * command — is only *confirmed* for the three in Dino Depot's own example
 * (`aggressive`, `angry`, `swimmer`); the rest are the wiki name lowercased
 * with punctuation stripped, which is the pattern those three follow.
 *
 * So the editor never forces a choice from this list: an unknown trait can be
 * typed in directly, and the token that will be emitted is always shown. Fix
 * a wrong token here and every command builder picks it up.
 */

export interface ArkTrait {
  /** Exactly what is written into `-g=`. */
  token: string;
  /** Human name, as the wiki lists it. */
  name: string;
  category: TraitCategory;
  /**
   * Tiers this trait actually has, as 1/2/3. Absent means "unknown" — the
   * editor then offers all three rather than pretending to know better.
   * Narrow this per trait as tier limits are confirmed.
   */
  tiers?: readonly (1 | 2 | 3)[];
  hint?: string;
}

export type TraitCategory =
  | "combat"
  | "movement"
  | "survival"
  | "breeding"
  | "utility";

export const TRAIT_CATEGORY_LABELS: Record<TraitCategory, string> = {
  combat: "Combat",
  movement: "Movement",
  survival: "Survival",
  breeding: "Breeding",
  utility: "Utility",
};

/** Tier as the command writes it: tier 1 is `[0]`. */
export function tierIndex(tier: 1 | 2 | 3): 0 | 1 | 2 {
  return (tier - 1) as 0 | 1 | 2;
}

/** Inverse of {@link tierIndex}, for parsing an existing `-g=` value. */
export function tierFromIndex(index: number): 1 | 2 | 3 {
  return Math.min(3, Math.max(1, index + 1)) as 1 | 2 | 3;
}

export const ALL_TIERS = [1, 2, 3] as const;

export const ARK_TRAITS: ArkTrait[] = [
  // --- Combat
  { token: "aggressive", name: "Aggressive", category: "combat", hint: "Increased damage dealt" },
  { token: "angry", name: "Angry", category: "combat", hint: "Damage scales up as health drops" },
  { token: "giantslaying", name: "Giantslaying", category: "combat", hint: "Bonus damage to bosses and alphas" },
  { token: "kingslaying", name: "Kingslaying", category: "combat", hint: "Boss-specific damage, with a penalty" },
  { token: "heavyhitting", name: "Heavy-Hitting", category: "combat", hint: "More damage, slower attacks" },
  { token: "quickhitting", name: "Quick-Hitting", category: "combat", hint: "Faster attacks, less damage" },
  { token: "vampiric", name: "Vampiric", category: "combat", hint: "Heals from damage dealt" },
  { token: "distracting", name: "Distracting", category: "combat", hint: "Reduces enemy damage" },

  // --- Movement
  { token: "swimmer", name: "Aquatic (Swimmer)", category: "movement", hint: "Aquatic movement and efficiency" },
  { token: "carefree", name: "Carefree", category: "movement", hint: "Movement speed until damaged" },
  { token: "cowardly", name: "Cowardly", category: "movement", hint: "Movement speed when hurt" },
  { token: "sprinter", name: "Sprinter (High Endurance)", category: "movement", hint: "Cheaper sprint stamina" },
  { token: "athletic", name: "Athletic", category: "movement", hint: "Health and stamina regeneration" },
  { token: "excitable", name: "Excitable", category: "movement", hint: "Reduced ability cooldowns" },

  // --- Survival
  { token: "warm", name: "Warm", category: "survival", hint: "Cold resistance" },
  { token: "cold", name: "Cold", category: "survival", hint: "Heat resistance" },
  { token: "tenacious", name: "Tenacious", category: "survival", hint: "Damage reduction at low health" },
  { token: "protective", name: "Protective", category: "survival", hint: "Reduces damage taken by the rider" },
  { token: "fatty", name: "Fatty", category: "survival", hint: "Armour derived from the food stat" },
  { token: "numb", name: "Numb", category: "survival", hint: "Delays incoming damage" },
  { token: "frenetic", name: "Frenetic", category: "survival", hint: "Faster torpor recovery" },
  { token: "nocturnal", name: "Nocturnal", category: "survival", hint: "Stamina efficiency at night" },
  { token: "diurnal", name: "Diurnal", category: "survival", hint: "Stamina efficiency in daylight" },

  // --- Breeding
  { token: "robust", name: "Robust", category: "breeding", hint: "Better stat inheritance" },
  { token: "frail", name: "Frail", category: "breeding", hint: "Worse stat inheritance" },
  { token: "mutable", name: "Mutable", category: "breeding", hint: "Increased mutation chance" },

  // --- Utility
  { token: "carrier", name: "Bearing (Carrier)", category: "utility", hint: "Weight reduction by category" },
  { token: "fastlearner", name: "Fast Learner", category: "utility", hint: "Increased experience gain" },
  { token: "slowmetabolism", name: "Slow Metabolism", category: "utility", hint: "Eats less" },
];

const BY_TOKEN = new Map(ARK_TRAITS.map((t) => [t.token, t]));

export function traitByToken(token: string): ArkTrait | undefined {
  return BY_TOKEN.get(token.trim().toLowerCase());
}

/**
 * Tiers the editor may offer for a token. Unknown traits, and known ones with
 * no recorded tier limit, get all three — guessing narrower would block a
 * legitimate command.
 */
export function tiersFor(token: string): readonly (1 | 2 | 3)[] {
  return traitByToken(token)?.tiers ?? ALL_TIERS;
}

/** Matches on token, display name or category label. */
export function searchTraits(query: string): ArkTrait[] {
  const q = query.trim().toLowerCase();
  if (!q) return ARK_TRAITS;
  return ARK_TRAITS.filter(
    (t) =>
      t.token.includes(q) ||
      t.name.toLowerCase().includes(q) ||
      TRAIT_CATEGORY_LABELS[t.category].toLowerCase().includes(q),
  );
}

/** Normalizes free-typed text into something usable as a command token. */
export function normalizeTraitToken(text: string): string {
  return text.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
