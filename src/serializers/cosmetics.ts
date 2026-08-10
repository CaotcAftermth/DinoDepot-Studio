import { CosmeticEntry, CosmeticsDraft, isActive } from "../model/cosmetics";
import { newId } from "../model/ids";

/**
 * Serializes the cosmetics draft to the pipe-delimited published format:
 *   `modId|1|1|,modId|1|1|`  (final pipe required, comma between entries,
 *   no trailing comma, no spaces).
 *
 * Deprecated entries are held back as firmly as excluded ones: a mod that is
 * no longer on CurseForge cannot be downloaded, so publishing its id only
 * gives every client a download to retry and fail.
 */
export function serializeCosmetics(draft: CosmeticsDraft): string {
  return draft.entries
    .filter((e) => e.included && isActive(e))
    .map(
      (e) =>
        `${e.modId}|${e.enableDynamicDownload ? 1 : 0}|${e.allowNonDataOnlyBlueprints ? 1 : 0}|`,
    )
    .join(",");
}

const ENTRY_RE = /^(\d+)\|([01])\|([01])\|$/;

/** Parses a published CCM list into draft entries (importer). */
export function parseCosmetics(text: string): CosmeticsDraft {
  const trimmed = text.trim();
  const entries: CosmeticEntry[] = [];
  if (trimmed !== "") {
    const parts = trimmed.split(",");
    const seen = new Set<string>();
    for (const part of parts) {
      const match = ENTRY_RE.exec(part.trim());
      if (!match) {
        throw new Error(
          `Invalid CCM entry '${part}'. Expected format: <modId>|<0-or-1>|<0-or-1>|`,
        );
      }
      const [, modId, dynamicDownload, nonDataOnly] = match;
      if (seen.has(modId)) {
        throw new Error(`Duplicate mod ID in CCM list: ${modId}`);
      }
      seen.add(modId);
      entries.push({
        id: newId(),
        modId,
        enableDynamicDownload: dynamicDownload === "1",
        allowNonDataOnlyBlueprints: nonDataOnly === "1",
        included: true,
        name: "",
        url: `https://www.curseforge.com/ark-survival-ascended/search?search=${modId}`,
        updated: "",
        notes: "",
        deprecatedAt: null,
      });
    }
  }
  return { schemaVersion: 1, entries, lastScrapeAt: null, lastScrape: null };
}

/** Validates a serialized CCM string; returns a list of problems (empty = valid). */
export function validateCosmeticsText(text: string): string[] {
  const problems: string[] = [];
  if (text === "") return problems;
  if (/\s/.test(text)) problems.push("Output contains whitespace");
  if (text.endsWith(",")) problems.push("Trailing comma after final entry");
  const seen = new Set<string>();
  for (const part of text.split(",")) {
    const match = ENTRY_RE.exec(part);
    if (!match) {
      problems.push(`Malformed entry: '${part}'`);
      continue;
    }
    if (seen.has(match[1])) problems.push(`Duplicate mod ID: ${match[1]}`);
    seen.add(match[1]);
  }
  return problems;
}
