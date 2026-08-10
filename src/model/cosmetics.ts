import { z } from "zod";

/**
 * Internal model for the Custom Cosmetic Mod list.
 * Published format is pipe-delimited text: `modId|1|1|,modId|1|1|` — see
 * StructureExample/Custom Cosmetic Mod List — Improved Commented Structure Guide.
 */

export const CosmeticEntrySchema = z.object({
  id: z.string(),
  /** Numeric CurseForge project id, stored as string to preserve exact digits. */
  modId: z.string(),
  enableDynamicDownload: z.boolean(),
  allowNonDataOnlyBlueprints: z.boolean(),
  /** Excluded from published output when false. */
  included: z.boolean(),
  // Metadata from the scraper (not published):
  name: z.string(),
  url: z.string(),
  updated: z.string(),
  notes: z.string(),
  /**
   * When a completed scrape last failed to find this mod on CurseForge; null
   * while it is still listed.
   *
   * Deprecated entries keep everything known about them — the id, the name,
   * the last-seen date — because "this mod used to be in our list" is exactly
   * the thing an admin needs when a player asks why their skin vanished. They
   * are simply held back from the published list, since a delisted mod in the
   * CCM list is a download every client retries and fails.
   *
   * Defaulted rather than required so cosmetics files written before this
   * existed still load.
   */
  deprecatedAt: z.string().nullable().default(null),
});
export type CosmeticEntry = z.infer<typeof CosmeticEntrySchema>;

/** One mod as a completed scrape saw it. */
export const ScrapedModSchema = z.object({
  name: z.string(),
  projectId: z.string(),
  url: z.string(),
  updated: z.string(),
});
export type ScrapedMod = z.infer<typeof ScrapedModSchema>;

/**
 * What the last applied scrape changed, kept so its Discord post can be
 * recovered after navigating away — a collector run takes several minutes and
 * the post is the whole point of it.
 */
export const ScrapeResultSchema = z.object({
  at: z.string(),
  added: z.array(ScrapedModSchema).default([]),
  /** Mods the scrape no longer found, moved to the deprecated list. */
  deprecated: z.array(ScrapedModSchema).default([]),
  changedCount: z.number().default(0),
});
export type ScrapeResult = z.infer<typeof ScrapeResultSchema>;

export const CosmeticsDraftSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(CosmeticEntrySchema),
  lastScrapeAt: z.string().nullable(),
  /** The most recent applied scrape; survives restarts with the project. */
  lastScrape: ScrapeResultSchema.nullable().default(null),
});
export type CosmeticsDraft = z.infer<typeof CosmeticsDraftSchema>;

export function emptyCosmeticsDraft(): CosmeticsDraft {
  return { schemaVersion: 1, entries: [], lastScrapeAt: null, lastScrape: null };
}

/** True when the entry is still listed on CurseForge. */
export function isActive(entry: CosmeticEntry): boolean {
  return entry.deprecatedAt === null;
}

export function activeEntries(draft: CosmeticsDraft): CosmeticEntry[] {
  return draft.entries.filter(isActive);
}

export function deprecatedEntries(draft: CosmeticsDraft): CosmeticEntry[] {
  return draft.entries.filter((e) => !isActive(e));
}
