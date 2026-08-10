import { newId } from "../model/ids";
import {
  PublishedRemaps,
  PublishedRemapsSchema,
  RemapsDraft,
} from "../model/remaps";

/** Converts the internal remap draft to the published dinoMappings object (active entries only). */
export function serializeRemaps(draft: RemapsDraft): PublishedRemaps {
  return {
    dinoMappings: draft.entries
      .filter((entry) => entry.active)
      .map(({ fromClass, toClass }) => ({ fromClass, toClass })),
  };
}

export function remapsToText(draft: RemapsDraft): string {
  return JSON.stringify(serializeRemaps(draft), null, 2);
}

/** Parses a published remap file into the internal draft model (importer). */
export function parseRemaps(text: string): RemapsDraft {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  const result = PublishedRemapsSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `Not a valid remap file: ${issue.path.join(".")} — ${issue.message}`,
    );
  }
  return {
    schemaVersion: 1,
    entries: result.data.dinoMappings.map((m) => ({
      id: newId(),
      active: true,
      fromClass: m.fromClass,
      toClass: m.toClass,
      fromSourceId: null,
      toSourceId: null,
      intentional: false,
      notes: "",
    })),
  };
}
