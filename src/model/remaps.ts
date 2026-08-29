import { z } from "zod";

/**
 * Internal editor model for creature type remaps.
 * Published format: {"dinoMappings":[{"fromClass","toClass"}]} - see
 * StructureExample/Passive Production Remap Structure.json5
 */

export const RemapEntrySchema = z.object({
  id: z.string(),
  /** Inactive entries are kept in the draft but excluded from published output. */
  active: z.boolean(),
  fromClass: z.string(),
  toClass: z.string(),
  /** Optional catalog source ids for attribution/validation (not published). */
  fromSourceId: z.string().nullable(),
  toSourceId: z.string().nullable(),
  /**
   * Marks the remap as deliberate even though the source creature's content
   * source is still enabled (e.g. remapping one vanilla creature to another).
   * Suppresses the "source is still active" validation warning.
   */
  intentional: z.boolean().default(false),
  notes: z.string(),
});
export type RemapEntry = z.infer<typeof RemapEntrySchema>;

export const RemapsDraftSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(RemapEntrySchema),
});
export type RemapsDraft = z.infer<typeof RemapsDraftSchema>;

export function emptyRemapsDraft(): RemapsDraft {
  return { schemaVersion: 1, entries: [] };
}

export const PublishedRemapsSchema = z.object({
  dinoMappings: z.array(
    z.object({ fromClass: z.string(), toClass: z.string() }),
  ),
});
export type PublishedRemaps = z.infer<typeof PublishedRemapsSchema>;
