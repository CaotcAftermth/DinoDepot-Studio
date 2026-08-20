import { describe, expect, it } from "vitest";
import {
  DEFAULT_MATERIAL_KEYWORDS,
  iconFileStem,
  isMaterialMap,
  matchesKeyword,
  modFolderPath,
  rankTextures,
} from "./modAssets";

describe("modFolderPath", () => {
  it("builds the installed folder name from the two ids that encode it", () => {
    expect(modFolderPath("C:/ark/Mods/83374", "987274", "6609863")).toBe(
      "C:/ark/Mods/83374/987274_6609863",
    );
  });

  it("tolerates a trailing separator on the root", () => {
    expect(modFolderPath("C:/ark/Mods/83374/", "1", "2")).toBe(
      "C:/ark/Mods/83374/1_2",
    );
    expect(modFolderPath("C:\\ark\\Mods\\83374\\", "1", "2")).toBe(
      "C:\\ark\\Mods\\83374/1_2",
    );
  });
});

describe("iconFileStem", () => {
  it("files an icon under the mod it came from", () => {
    expect(iconFileStem("AAHelicoprion", "Helicoprion AA")).toBe(
      "AAHelicoprion/Helicoprion AA",
    );
  });

  it("keeps two mods' identically named entries apart", () => {
    // The images folder is shared, so "Rex" from two mods would otherwise
    // overwrite each other.
    expect(iconFileStem("ModA", "Rex")).not.toBe(iconFileStem("ModB", "Rex"));
  });

  it("replaces characters a path cannot hold, and never nests deeper", () => {
    const stem = iconFileStem("My/Mod", "Rex: Alpha*");
    expect(stem.split("/")).toHaveLength(2);
    expect(stem).not.toMatch(/[\:*?"<>|]/);
    expect(stem).toContain("Rex");
  });

  it("falls back to a bare file name when there is no group", () => {
    expect(iconFileStem("", "Rex")).toBe("Rex");
    expect(iconFileStem("", "")).toBe("icon");
  });

  it("does not collapse two different entries into one name", () => {
    expect(iconFileStem("Mod", "Rex Alpha")).not.toBe(
      iconFileStem("Mod", "Rex Beta"),
    );
  });

  it("never starts a segment with a dot", () => {
    // A leading dot would be a hidden file, and the backend refuses one.
    for (const segment of iconFileStem(".hidden", ".config").split("/")) {
      expect(segment.startsWith(".")).toBe(false);
    }
  });
});

describe("matchesKeyword", () => {
  it("matches a long keyword anywhere in the name", () => {
    expect(matchesKeyword("T_Rex_BaseColor", "basecolor")).toBe(true);
    expect(matchesKeyword("TRexBasecolor", "basecolor")).toBe(true);
  });

  it("matches a short keyword as a whole word only", () => {
    expect(matchesKeyword("T_Rex_AO", "ao")).toBe(true);
    expect(matchesKeyword("TRexAO", "ao")).toBe(true);
    // Would be a substring hit, and would hide art nobody meant to hide.
    expect(matchesKeyword("Chaos_Emblem", "ao")).toBe(false);
    expect(matchesKeyword("Metalwork_Icon", "metal")).toBe(false);
  });

  it("ignores punctuation and case in the keyword itself", () => {
    expect(matchesKeyword("T_Rex_BaseColor", "  Base-Color  ")).toBe(true);
    expect(matchesKeyword("anything", "   ")).toBe(false);
  });

  it("lets a custom word be added and take effect", () => {
    expect(matchesKeyword("T_Sky_Cubemap", "cubemap")).toBe(true);
    expect(isMaterialMap("T_Sky_Cubemap", ["cubemap"])).toBe(true);
    expect(isMaterialMap("T_Sky_Cubemap", [])).toBe(false);
  });
});

describe("icon markers beat material keywords", () => {
  it("keeps a name that says it is an icon", () => {
    // Real name from the local corpus: a 256x256 icon that "colorize" would
    // otherwise hide.
    expect(isMaterialMap("Icon_COLORIZE_V2_Scifi")).toBe(false);
    expect(isMaterialMap("RogueICON_Top_Belt")).toBe(false);
    expect(isMaterialMap("HUD_Saddle_Mask")).toBe(false);
  });

  it("still hides the surfaces beside them", () => {
    for (const name of [
      "T_ROGUE_SUIT_BaseColor_01",
      "T_ROGUE_SUIT_Emissive",
      "T_ROGUE_SUIT_Normal",
      "T_ROGUE_SUIT_OcclusionRoughnessMetallic",
      "ShortPants_Female_Mask",
    ]) {
      expect(isMaterialMap(name), name).toBe(true);
    }
  });
});

describe("rankTextures", () => {
  const list = [
    { path: "a", name: "T_Rex_BaseColor", width: 4096, height: 4096 },
    { path: "b", name: "Icon_Rex", width: 256, height: 256 },
    { path: "c", name: "Zebra_Portrait", width: 256, height: 256 },
    { path: "d", name: "Big_Banner", width: 2048, height: 512 },
  ];

  it("hides material maps when asked and keeps them when not", () => {
    expect(
      rankTextures(list, {
        query: "",
        excluded: DEFAULT_MATERIAL_KEYWORDS,
      }).map((t) => t.name),
    ).not.toContain("T_Rex_BaseColor");
    expect(
      rankTextures(list, { query: "", excluded: [] }).map((t) => t.name),
    ).toContain("T_Rex_BaseColor");
  });

  it("puts icons and small textures first", () => {
    const names = rankTextures(list, {
      query: "",
      excluded: DEFAULT_MATERIAL_KEYWORDS,
    }).map((t) => t.name);
    expect(names[0]).toBe("Icon_Rex");
    expect(names.at(-1)).toBe("Big_Banner");
  });

  it("searches name and path, case-insensitively", () => {
    expect(
      rankTextures(list, {
        query: "REX",
        excluded: DEFAULT_MATERIAL_KEYWORDS,
      }).map((t) => t.name),
    ).toEqual(["Icon_Rex"]);
    expect(
      rankTextures(list, { query: "nothing here", excluded: [] }),
    ).toEqual([]);
  });

  it("never returns the same path twice", () => {
    // The list is keyed by path. Repeated keys leave React free to skip the
    // re-render a search depends on.
    const doubled = [
      { path: "a", name: "Icon_Rex", width: 256, height: 256 },
      { path: "a", name: "Icon_Rex", width: 256, height: 256 },
      { path: "b", name: "Icon_Raptor", width: 256, height: 256 },
    ];
    const paths = rankTextures(doubled, {
      query: "",
      excluded: DEFAULT_MATERIAL_KEYWORDS,
    }).map((t) => t.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});
