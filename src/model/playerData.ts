import { z } from "zod";
import type { Player, StoredProfile } from "./players";

/**
 * Policy for ageing .arkprofile saves.
 *
 * Nothing here ever deletes a file. A stored profile is frequently the only
 * surviving copy of a player's character - an admin keeps it precisely so that
 * a wipe, a rollback or a corrupt save can be undone months later - so age is
 * only ever a *label*, and the strongest automatic action on offer is moving a
 * save out of the default view. Deleting stays a deliberate, confirmed act.
 *
 * These live on the project rather than in global Settings because the Player
 * Data page can be switched off entirely; its policy is meaningless when the
 * module is not running, and belongs with the page that owns it.
 */
export const PlayerDataSettingsSchema = z.object({
  /**
   * Days after which a stored profile is called stale. 0 turns the whole
   * staleness notion off.
   */
  staleAfterDays: z.number().min(0).max(3650).default(90),
  /**
   * Move stale profiles out of the default roster view. They stay on disk,
   * stay backed up and stay one filter change away - this is a tidy-up, not a
   * retention policy.
   */
  autoArchiveStale: z.boolean().default(false),
  /**
   * Flag saves written in an older save format than the cluster's current maps
   * use - most importantly the pre-Lost Colony format, which has no skill tree
   * data at all.
   */
  warnOnSaveVersion: z.boolean().default(true),
});
export type PlayerDataSettings = z.infer<typeof PlayerDataSettingsSchema>;

export function defaultPlayerDataSettings(): PlayerDataSettings {
  return PlayerDataSettingsSchema.parse({});
}

/**
 * The save version the Unreal 5.5 maps write. Lost Colony shipped this format
 * along with the skill trees, so a save below it predates both.
 *
 * Mirrors TAGGED_SAVE_VERSION in the .arkprofile serializer, restated here so
 * the model layer does not depend on the binary reader.
 */
export const SKILL_TREE_SAVE_VERSION = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days since the profile was stored, or null if it carries no date. */
export function profileAgeDays(
  profile: StoredProfile,
  now: number = Date.now(),
): number | null {
  const stored = Date.parse(profile.storedAt);
  if (!Number.isFinite(stored)) return null;
  return Math.max(0, Math.floor((now - stored) / DAY_MS));
}

/** True once a profile is older than the configured threshold. */
export function profileIsStale(
  profile: StoredProfile,
  settings: PlayerDataSettings,
  now: number = Date.now(),
): boolean {
  if (settings.staleAfterDays <= 0) return false;
  const age = profileAgeDays(profile, now);
  return age !== null && age >= settings.staleAfterDays;
}

/**
 * Whether a profile should sit outside the default roster view: the admin
 * archived it by hand, or the policy archives stale saves and this one is.
 */
export function profileIsArchived(
  profile: StoredProfile,
  settings: PlayerDataSettings,
  now: number = Date.now(),
): boolean {
  if (profile.archivedAt) return true;
  return settings.autoArchiveStale && profileIsStale(profile, settings, now);
}

export type SaveVersionWarning = {
  /** Short label for a badge. */
  label: string;
  /** The full explanation, for a tooltip. */
  detail: string;
};

/**
 * What is worth saying about this profile's save format.
 *
 * The case that matters is a version 5 save: it was written before the Lost
 * Colony update, so it has no skill tree section whatsoever. Restoring one
 * onto a current map gives the player their character back with every tree at
 * zero - recoverable, but not silently.
 */
export function saveVersionWarning(
  profile: StoredProfile,
  settings: PlayerDataSettings,
): SaveVersionWarning | null {
  if (!settings.warnOnSaveVersion) return null;
  if (!profile.summary) {
    return {
      label: "Save format unknown",
      detail:
        "This profile was stored before the app could read save data, so its format was never recorded. Re-upload it to find out what it is.",
    };
  }
  const version = profile.summary.saveVersion;
  if (version >= SKILL_TREE_SAVE_VERSION) return null;
  return {
    label: `Pre-skill-tree save (v${version})`,
    detail:
      `Written in save format v${version}, before the Lost Colony update introduced skill trees - ` +
      "this file has no skill tree data at all. Restoring it returns the character with every tree back at zero, " +
      "and the newer maps cannot read the older format directly.",
  };
}

/** Every stored profile on the roster, paired with its owner. */
export function storedProfiles(
  players: Player[],
): { player: Player; profile: StoredProfile }[] {
  return players.flatMap((player) =>
    player.profile ? [{ player, profile: player.profile }] : [],
  );
}

export interface RosterHealth {
  stale: number;
  archived: number;
  outdatedFormat: number;
}

/** Counts for the page header, so the admin sees the shape of the problem at a glance. */
export function rosterHealth(
  players: Player[],
  settings: PlayerDataSettings,
  now: number = Date.now(),
): RosterHealth {
  let stale = 0;
  let archived = 0;
  let outdatedFormat = 0;
  for (const { profile } of storedProfiles(players)) {
    if (profileIsStale(profile, settings, now)) stale++;
    if (profileIsArchived(profile, settings, now)) archived++;
    if (saveVersionWarning(profile, settings)) outdatedFormat++;
  }
  return { stale, archived, outdatedFormat };
}
