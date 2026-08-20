import { describe, expect, it } from "vitest";
import {
  AssetRefSchema,
  normalizeAssetPath,
  legacyAssetValue,
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

describe("official asset references", () => {
  it("names base-game art without pinning the release it came from", () => {
    // An administrator picking the stock Rex icon means "the base game's
    // Rex" — pinning 1.1.0 into the value would orphan the assignment the
    // next time Core Content moves.
    expect(
      parseAssetValue("official:creatures/Rex.webp", {
        origin: "project",
        officialVersion: "1.1.0",
      }),
    ).toEqual({
      origin: "official",
      packageVersion: "1.1.0",
      path: "creatures/Rex.webp",
    });
  });

  it("round-trips through the legacy string form", () => {
    const ref = {
      origin: "official" as const,
      packageVersion: "1.1.0",
      path: "creatures/Rex.webp",
    };
    expect(legacyAssetValue(ref)).toBe("official:creatures/Rex.webp");
  });

  it("refuses a path that would escape the package", () => {
    expect(
      parseAssetValue("official:../../etc/passwd", {
        origin: "project",
        officialVersion: "1.1.0",
      }),
    ).toBeNull();
  });

  it("is still a project file when written the old way", () => {
    expect(
      parseAssetValue("file:Rex.webp", {
        origin: "project",
        officialVersion: "1.1.0",
      }),
    ).toEqual({ origin: "project", path: "Rex.webp" });
  });
});

describe("official package asset layout", () => {
  it("keeps its kind in a path segment, not at the start", () => {
    // Real value from the published package: the kind folder sits under
    // `assets/`, so a picker filtering by prefix would show nothing at all.
    const parsed = parseAssetValue("file:assets/creatures/Achatina.webp", {
      origin: "package",
      packageId: "official-asa",
      version: "1.1.0",
    });
    expect(parsed).toEqual({
      origin: "package",
      packageId: "official-asa",
      version: "1.1.0",
      path: "assets/creatures/Achatina.webp",
    });
    const path = (parsed as { path: string }).path;
    expect(path.startsWith("creatures/")).toBe(false);
    expect(path.split("/")).toContain("creatures");
  });
});
