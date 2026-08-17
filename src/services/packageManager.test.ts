import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultModpackRegistry, RegistryEntrySchema } from "../model/modpack";
import {
  packageAssetV3,
  packageFile,
  packageJson,
  PackageManifestSchema,
  sha256Hex,
} from "../model/package";
import {
  downloadRegistryPackage,
  downloadedAsLegacyInstall,
} from "./packageManager";

afterEach(() => vi.unstubAllGlobals());

describe("exact package downloads", () => {
  it("verifies the manifest, content, and assets before returning", async () => {
    const registry = defaultModpackRegistry();
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: { "/m/c.c": "file:assets/Creature.png" },
      }),
    );
    const icon = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "test-pack",
      version: "1.0.0",
      curseforgeId: "12345",
      meta: { name: "Test Pack" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [await packageFile("assets/Creature.png", icon, "image/png")],
    });
    const manifestBytes = new TextEncoder().encode(packageJson(manifest));
    const entry = RegistryEntrySchema.parse({
      id: "test-pack",
      name: "Test Pack",
      version: "1.0.0",
      curseforgeId: "12345",
      versions: [
        {
          version: "1.0.0",
          manifest: "test-pack/versions/1.0.0/manifest.json",
          integrity: await sha256Hex(manifestBytes),
        },
      ],
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const bytes = url.endsWith("manifest.json")
        ? manifestBytes
        : url.endsWith("content.json")
          ? content
          : icon;
      return new Response(bytes, { status: 200 });
    });
    vi.stubGlobal("fetch", fetch);

    const downloaded = await downloadRegistryPackage(
      registry,
      entry,
      "1.0.0",
    );
    const legacy = downloadedAsLegacyInstall(downloaded);

    expect(downloaded.files).toHaveLength(2);
    expect(legacy.pack.meta.id).toBe("test-pack");
    expect(legacy.pack.icons["/m/c.c"]).toBe("file:Creature.png");
    expect(legacy.icons.missing).toEqual([]);
  });

  it("never substitutes latest when an exact version is absent", async () => {
    const entry = RegistryEntrySchema.parse({
      id: "pack",
      name: "Pack",
      version: "2.0.0",
      versions: [],
    });
    await expect(
      downloadRegistryPackage(defaultModpackRegistry(), entry, "1.0.0"),
    ).rejects.toThrow(/not available as an immutable package/i);
  });

  it("refuses a registry package that requires a newer Studio", async () => {
    const entry = RegistryEntrySchema.parse({
      id: "future-pack",
      name: "Future Pack",
      version: "9.0.0",
      versions: [
        {
          version: "9.0.0",
          manifest: "future-pack/versions/9.0.0/manifest.json",
          integrity: "1".repeat(64),
          packageFormat: 3,
          minStudioVersion: "9.0.0",
        },
      ],
    });

    await expect(
      downloadRegistryPackage(defaultModpackRegistry(), entry, "9.0.0"),
    ).rejects.toThrow(/requires DinoDepot Studio 9\.0\.0/i);
  });

  it("downloads v3 assets from the package-root blob store", async () => {
    const registry = defaultModpackRegistry();
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: { "/m/c.c": "file:assets/Creature.png" },
      }),
    );
    const icon = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const asset = await packageAssetV3(
      "assets/Creature.png",
      icon,
      "image/png",
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 3,
      kind: "modpack",
      packageId: "test-pack",
      version: "2.0.0",
      curseforgeId: "12345",
      meta: { name: "Test Pack" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [asset],
    });
    const manifestBytes = new TextEncoder().encode(packageJson(manifest));
    const entry = RegistryEntrySchema.parse({
      id: "test-pack",
      name: "Test Pack",
      version: "2.0.0",
      curseforgeId: "12345",
      versions: [
        {
          version: "2.0.0",
          manifest: "test-pack/versions/2.0.0/manifest.json",
          integrity: await sha256Hex(manifestBytes),
          packageFormat: 3,
        },
      ],
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(
        url.endsWith("manifest.json")
          ? manifestBytes
          : url.endsWith("content.json")
            ? content
            : icon,
      );
    });
    vi.stubGlobal("fetch", fetch);

    await downloadRegistryPackage(registry, entry, "2.0.0");

    expect(fetch.mock.calls.map(([input]) => String(input))).toContain(
      `https://raw.githubusercontent.com/${registry.owner}/${registry.repo}/${registry.branch}/${registry.path}/test-pack/${asset.blob}`,
    );
  });

  it("refuses content that references an asset omitted from the manifest", async () => {
    const registry = defaultModpackRegistry();
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: { "/m/c.c": "file:assets/Missing.png" },
      }),
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "test-pack",
      version: "1.0.0",
      meta: { name: "Test Pack" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [],
    });
    const manifestBytes = new TextEncoder().encode(packageJson(manifest));
    const entry = RegistryEntrySchema.parse({
      id: "test-pack",
      name: "Test Pack",
      version: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          manifest: "test-pack/versions/1.0.0/manifest.json",
          integrity: await sha256Hex(manifestBytes),
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        new Response(String(input).endsWith("manifest.json") ? manifestBytes : content),
      ),
    );

    await expect(
      downloadRegistryPackage(registry, entry, "1.0.0"),
    ).rejects.toThrow(/absent from its manifest/i);
  });

  it("refuses a package image whose bytes do not match PNG/WebP", async () => {
    const registry = defaultModpackRegistry();
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: { "/m/c.c": "file:assets/Creature.png" },
      }),
    );
    const wrongImage = new TextEncoder().encode("not a png");
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "test-pack",
      version: "1.0.0",
      meta: { name: "Test Pack" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [
        await packageFile("assets/Creature.png", wrongImage, "image/png"),
      ],
    });
    const manifestBytes = new TextEncoder().encode(packageJson(manifest));
    const entry = RegistryEntrySchema.parse({
      id: "test-pack",
      name: "Test Pack",
      version: "1.0.0",
      versions: [
        {
          version: "1.0.0",
          manifest: "test-pack/versions/1.0.0/manifest.json",
          integrity: await sha256Hex(manifestBytes),
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return new Response(
          url.endsWith("manifest.json")
            ? manifestBytes
            : url.endsWith("content.json")
              ? content
              : wrongImage,
        );
      }),
    );

    await expect(
      downloadRegistryPackage(registry, entry, "1.0.0"),
    ).rejects.toThrow(/does not match.*PNG\/WebP/i);
  });
});
