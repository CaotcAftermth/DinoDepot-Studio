import { z } from "zod";

/** Publish history, per output family. */

export const OutputFamilySchema = z.enum([
  "production",
  "remaps",
  "cosmetics",
  "viewerData",
  "viewerPage",
  "players",
]);
export type OutputFamily = z.infer<typeof OutputFamilySchema>;

export const OUTPUT_FAMILY_LABELS: Record<OutputFamily, string> = {
  production: "Passive Production",
  remaps: "Creature Type Remaps",
  cosmetics: "Custom Cosmetics",
  viewerData: "Cluster Viewer Data",
  viewerPage: "Cluster Viewer Page",
  players: "Player Data",
};

export const PublishRecordSchema = z.object({
  id: z.string(),
  family: OutputFamilySchema,
  publishedAt: z.string(),
  commitSha: z.string(),
  commitMessage: z.string(),
  path: z.string(),
  rawUrl: z.string(),
  /** Hash of the published content, used to detect unpublished draft changes. */
  contentHash: z.string(),
});
export type PublishRecord = z.infer<typeof PublishRecordSchema>;

export const HistoryFileSchema = z.object({
  schemaVersion: z.literal(1),
  records: z.array(PublishRecordSchema),
});
export type HistoryFile = z.infer<typeof HistoryFileSchema>;

export function emptyHistory(): HistoryFile {
  return { schemaVersion: 1, records: [] };
}

export function lastPublish(
  history: HistoryFile,
  family: OutputFamily,
): PublishRecord | null {
  const records = history.records
    .filter((r) => r.family === family)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return records[0] ?? null;
}
