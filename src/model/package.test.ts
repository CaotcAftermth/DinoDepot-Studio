import { describe, expect, it } from "vitest";
import { templateModpack } from "./modpack";
import {
  modpackFromPackage,
  PackageContentSchema,
  packageContentFromModpack,
  packageFile,
  PackageManifestSchema,
  sha256Hex,
} from "./package";

describe("package v2", () => {
  it("round-trips current modpack content without changing its meaning", async () => {
    const pack = templateModpack();
    const content = packageContentFromModpack(pack);
    content.icons["/test/icon.icon"] = "file:assets/Rex.png";
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: pack.meta.id,
      version: pack.meta.version,
      curseforgeId: pack.meta.curseforgeId,
      meta: {
        name: pack.meta.name,
        updatedAt: pack.meta.updatedAt,
        author: pack.meta.author,
        description: pack.meta.description,
        url: pack.meta.url,
        docsUrl: pack.meta.docsUrl,
        discordUrl: pack.meta.discordUrl,
        variantTag: pack.meta.variantTag,
      },
      content: await packageFile("content.json", bytes, "application/json"),
      assets: [],
    });

    const restored = modpackFromPackage(manifest, content);
    expect(restored.meta).toEqual(pack.meta);
    expect(restored.creatures).toEqual(pack.creatures);
    expect(restored.creatureInfo).toEqual(pack.creatureInfo);
    expect(restored.icons["/test/icon.icon"]).toBe("file:Rex.png");
  });

  it("refuses paths outside the canonical package layout", () => {
    expect(
      PackageManifestSchema.safeParse({
        format: "dinodepot.package",
        formatVersion: 2,
        kind: "modpack",
        packageId: "pack",
        version: "1.0.0",
        meta: { name: "Pack" },
        content: { path: "../content.json", sha256: "0".repeat(64), size: 0 },
      }).success,
    ).toBe(false);
  });

  it("uses real SHA-256 integrity", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("parses content independently of the manifest", () => {
    expect(
      PackageContentSchema.safeParse({
        format: "dinodepot.package-content",
        schemaVersion: 1,
      }).success,
    ).toBe(true);
  });

  it("accepts only WebP and PNG package images", async () => {
    const content = new TextEncoder().encode("{}");
    const base = {
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "pack",
      version: "1.0.0",
      meta: { name: "Pack" },
      content: await packageFile("content.json", content, "application/json"),
    };
    expect(
      PackageManifestSchema.safeParse({
        ...base,
        assets: [
          await packageFile("assets/Icon.webp", new Uint8Array(), "image/webp"),
          await packageFile("assets/Icon.png", new Uint8Array(), "image/png"),
        ],
      }).success,
    ).toBe(true);
    expect(
      PackageManifestSchema.safeParse({
        ...base,
        assets: [
          await packageFile("assets/Icon.jpg", new Uint8Array(), "image/jpeg"),
        ],
      }).success,
    ).toBe(false);
  });

  it("refuses to flatten two different icons onto one file name", () => {
    const pack = templateModpack();
    pack.icons["/test/a.a"] = "file:creatures/Rex.png";
    pack.icons["/test/b.b"] = "file:items/Rex.png";
    expect(() => packageContentFromModpack(pack)).toThrow(/Rex\.png/);

    pack.icons["/test/b.b"] = "file:creatures/Rex.png";
    expect(() => packageContentFromModpack(pack)).not.toThrow();
  });
});
