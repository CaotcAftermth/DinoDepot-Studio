import { describe, expect, it } from "vitest";
import {
  assignCanonicalIconKeys,
  blueprintPathSuffix,
  iconSlug,
  parseIconKey,
} from "./iconKey";

describe("icon keys", () => {
  it.each([
    "dds:placeholder:creature",
    "official:creature:rex",
    "official:item:raw-meat",
    "official:map:the-island",
    "mod:123456:creature:alpha-rex",
    "mod:0:item:token",
    "project:cluster-one:custom-rex",
  ])("parses %s", (value) => expect(parseIconKey(value)?.value).toBe(value));

  it.each([
    "",
    "mod:abc:creature:rex",
    "mod:123:map:rex",
    "mod:123:creature",
    "official:creatures:rex",
    "project:My Project:rex",
    "project:one:../rex",
    "dds:placeholder:UPPER",
    " official:item:rex",
  ])("rejects %s", (value) => expect(parseIconKey(value)).toBeNull());

  it("normalizes slugs without traversal", () => {
    expect(iconSlug("  Alpha RÉX ../ ")).toBe("alpha-rex");
  });

  it("assigns stable collision keys and preserves prior assignments", () => {
    const entries = [
      { name: "Rex", bpPath: "/Mods/A/Rex.Rex" },
      { name: "Rex", bpPath: "/Mods/B/Rex.Rex" },
    ];
    const assigned = assignCanonicalIconKeys(entries, "mod:123:creature");
    expect(assigned.map((entry) => entry.iconKey)).toEqual([
      `mod:123:creature:rex-${blueprintPathSuffix(entries[0].bpPath)}`,
      `mod:123:creature:rex-${blueprintPathSuffix(entries[1].bpPath)}`,
    ]);
    expect(
      assignCanonicalIconKeys(
        [{ ...entries[0], iconKey: assigned[0].iconKey, name: "Renamed" }],
        "mod:123:creature",
      )[0].iconKey,
    ).toBe(assigned[0].iconKey);
  });
});
