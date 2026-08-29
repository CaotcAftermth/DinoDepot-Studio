/**
 * Placeholder names offered when a project is being created.
 *
 * The New project card used to arrive with one administrator's own cluster
 * name already typed into it, which had to be cleared before anything could be
 * entered and read like the app had guessed wrong. These are placeholders
 * instead: shown greyed, never submitted, and only there so the two fields
 * demonstrate what belongs in them.
 *
 * Two word lists rather than a list of finished names, so the pool is large
 * enough that two people setting up on the same afternoon are unlikely to be
 * shown the same one. Add words to either list to widen it; nothing else
 * needs to change.
 */

/** First half of a suggestion. Material, colour, weather - nothing literal. */
export const FIRST_WORDS = [
  "Amber",
  "Ashen",
  "Basalt",
  "Cinder",
  "Cobalt",
  "Coral",
  "Driftwood",
  "Dusk",
  "Ember",
  "Frost",
  "Granite",
  "Hollow",
  "Iron",
  "Ivory",
  "Lantern",
  "Marrow",
  "Midnight",
  "Obsidian",
  "Quartz",
  "Rift",
  "Saltwind",
  "Silver",
  "Thunder",
  "Verdant",
] as const;

/** Second half. Places a cluster could plausibly be named after. */
export const SECOND_WORDS = [
  "Atoll",
  "Basin",
  "Bluffs",
  "Canyon",
  "Crossing",
  "Delta",
  "Expanse",
  "Fen",
  "Ford",
  "Gate",
  "Harbour",
  "Hollow",
  "Isle",
  "Landing",
  "Marches",
  "Moor",
  "Outpost",
  "Peaks",
  "Reach",
  "Refuge",
  "Ridge",
  "Shallows",
  "Spire",
  "Vale",
] as const;

export interface NameSuggestion {
  project: string;
  cluster: string;
}

/** How many distinct suggestions the two lists can produce. */
export const SUGGESTION_COUNT = FIRST_WORDS.length * SECOND_WORDS.length;

/**
 * One project and cluster name to show as placeholders.
 *
 * `random` is injectable so a test can pin the result; it is called twice and
 * must return a number in [0, 1).
 */
export function suggestNames(random: () => number = Math.random): NameSuggestion {
  const first = FIRST_WORDS[Math.floor(random() * FIRST_WORDS.length)] ?? FIRST_WORDS[0];
  const second =
    SECOND_WORDS[Math.floor(random() * SECOND_WORDS.length)] ?? SECOND_WORDS[0];
  // "Hollow Hollow" is in the pool and reads badly; the second word carries
  // the place, so the first one gives way.
  const project = first === second ? `${FIRST_WORDS[0]} ${second}` : `${first} ${second}`;
  return { project, cluster: `${project} Cluster` };
}
