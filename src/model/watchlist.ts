import { z } from "zod";

/** Mod Update Watcher state. */

export const WatchedModSchema = z.object({
  id: z.string(),
  /** CurseForge numeric project id. */
  modId: z.string(),
  name: z.string(),
  url: z.string(),
  /** Last version/date the admin acknowledged as reviewed. */
  knownUpdated: z.string(),
  /** Most recent update date detected by a check. */
  latestUpdated: z.string(),
  lastCheckedAt: z.string().nullable(),
  /** True when latestUpdated differs from knownUpdated and needs admin review. */
  needsReview: z.boolean(),
  notes: z.string(),
  /**
   * Whether checks currently run for this mod. Turning "Watch updates" off in
   * Content Sources sets this false rather than dropping the entry: the
   * acknowledged version is what makes the *next* check meaningful, so
   * discarding it would silently re-baseline on re-watch and swallow any
   * update that landed while the mod was unwatched.
   */
  watching: z.boolean().default(true),
});
export type WatchedMod = z.infer<typeof WatchedModSchema>;

export const WatchlistSchema = z.object({
  schemaVersion: z.literal(1),
  mods: z.array(WatchedModSchema),
});
export type Watchlist = z.infer<typeof WatchlistSchema>;

export function emptyWatchlist(): Watchlist {
  return { schemaVersion: 1, mods: [] };
}
