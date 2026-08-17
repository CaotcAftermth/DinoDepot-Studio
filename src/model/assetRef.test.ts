import { describe, expect, it } from "vitest";
import {
  AssetRefSchema,
  normalizeAssetPath,
  parseAssetValue,
} from "./assetRef";

describe("asset paths", () => {
  it("normalizes separators but never accepts traversal or absolute paths", () => {
    expect(normalizeAssetPath("creatures\\Rex.png")).toBe("creatures/Rex.png");
    for (const unsafe of [
      "../Rex.png",
      "creatures/../Rex.png",
      "/images/Rex.png",
      "C:\\images\\Rex.png",
      "creatures//Rex.png",
      "Rex.png:stream",
    ]) {
      expect(normalizeAssetPath(unsafe), unsafe).toBeNull();
    }
  });
});

describe("asset references", () => {
  it("accepts each new explicit origin", () => {
    for (const ref of [
      { origin: "project", path: "creatures/Rex.png" },
      {
        origin: "package",
        packageId: "pack",
        version: "1.0.0",
        path: "assets/Rex.webp",
      },
      { origin: "official", packageVersion: "1", path: "Rex.webp" },
      { origin: "remote", url: "https://example.com/Rex.webp" },
    ]) {
      expect(AssetRefSchema.safeParse(ref).success, JSON.stringify(ref)).toBe(true);
    }
  });

  it("adapts legacy file values using their explicit read context", () => {
    expect(parseAssetValue("file:Rex.png")).toEqual({
      origin: "project",
      path: "Rex.png",
    });
    expect(
      parseAssetValue("file:Rex.png", {
        origin: "package",
        packageId: "pack",
        version: "1.0.0",
      }),
    ).toEqual({
      origin: "package",
      packageId: "pack",
      version: "1.0.0",
      path: "Rex.png",
    });
  });

  it("keeps glyphs and legacy URLs distinguishable", () => {
    expect(parseAssetValue("🦖")).toEqual({ origin: "glyph", value: "🦖" });
    expect(parseAssetValue("https://example.com/Rex.webp")).toEqual({
      origin: "remote",
      url: "https://example.com/Rex.webp",
    });
  });
});
