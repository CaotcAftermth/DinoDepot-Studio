import { describe, expect, it } from "vitest";
import { remoteAssetUrl, resolveAsset } from "./assetResolver";

describe("asset resolver", () => {
  it("resolves a legacy project file under the configured image root", () => {
    expect(
      resolveAsset("file:creatures/Rex.png", {
        projectImagesDir: "C:\\Project\\images",
      }),
    ).toMatchObject({
      kind: "local",
      absolutePath: "C:\\Project\\images\\creatures\\Rex.png",
    });
  });

  it("resolves exact package and official roots", () => {
    expect(
      resolveAsset(
        {
          origin: "package",
          packageId: "pack",
          version: "2.0.0",
          path: "assets/Rex.webp",
        },
        { packageRoot: (id, version) => `C:\\content\\${id}\\${version}` },
      ),
    ).toMatchObject({
      kind: "local",
      absolutePath: "C:\\content\\pack\\2.0.0\\assets\\Rex.webp",
    });
    expect(
      resolveAsset(
        { origin: "official", packageVersion: "5", path: "Rex.webp" },
        { officialRoot: (version) => `C:\\official\\${version}` },
      ).kind,
    ).toBe("local");
  });

  it("reports unavailable package roots without guessing", () => {
    expect(
      resolveAsset({
        origin: "package",
        packageId: "pack",
        version: "1.0.0",
        path: "Rex.webp",
      }),
    ).toEqual({ kind: "missing", reason: "package asset root is unavailable" });
  });

  it("recognizes remote references without returning them as glyphs", () => {
    expect(remoteAssetUrl("https://example.com/Rex.webp")).toBe(
      "https://example.com/Rex.webp",
    );
  });
});
