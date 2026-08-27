import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultModpackRegistry,
  ModpackSchema,
  RegistryEntrySchema,
} from "../model/modpack";
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
  normalizeLegacyModpackPackage,
} from "./packageManager";

afterEach(() => vi.unstubAllGlobals());

describe("exact package downloads", () => {
  it("verifies content without downloading quarantined legacy assets", async () => {
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

    expect(downloaded.files).toHaveLength(1);
    expect(legacy.pack.meta.id).toBe("test-pack");
    expect(legacy.pack.icons["/m/c.c"]).toBe("file:Creature.png");
    expect(legacy.icons.missing).toEqual(["Creature.png"]);
    expect(fetch.mock.calls.map(([input]) => String(input)).some((url) => url.endsWith("Creature.png"))).toBe(false);
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

  it("does not download v3 artwork blobs", async () => {
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

    expect(fetch.mock.calls.map(([input]) => String(input))).not.toContain(
      `https://raw.githubusercontent.com/${registry.owner}/${registry.repo}/${registry.branch}/${registry.path}/test-pack/${asset.blob}`,
    );
  });

  it("imports legacy content when its optional artwork is absent", async () => {
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

    const downloaded = await downloadRegistryPackage(registry, entry, "1.0.0");
    expect(downloaded.files.map((file) => file.path)).toEqual(["content.json"]);
    expect(downloadedAsLegacyInstall(downloaded).icons.missing).toEqual([]);
  });

  it("does not request malformed legacy artwork", async () => {
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
    const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        return new Response(
          url.endsWith("manifest.json")
            ? manifestBytes
            : url.endsWith("content.json")
              ? content
              : wrongImage,
        );
      });
    vi.stubGlobal("fetch", fetch);

    const downloaded = await downloadRegistryPackage(registry, entry, "1.0.0");
    expect(downloaded.files).toHaveLength(1);
    expect(fetch.mock.calls.map(([input]) => String(input)).some((url) => url.endsWith("Creature.png"))).toBe(false);
  });
});

describe("legacy modpack normalization", () => {
  const png = "iVBORw0KGgo=";

  it("converts compatibility content into a data-only v4 package", async () => {
    const pack = ModpackSchema.parse({
      meta: {
        id: "legacy-pack",
        name: "Legacy Pack",
        version: "1.2.3",
        updatedAt: "2026-08-17",
        curseforgeId: "123",
      },
      icons: { "/m/c.c": "file:Creature.png" },
    });

    const normalized = await normalizeLegacyModpackPackage(pack, {
      icons: [{ name: "Creature.png", contentB64: png }],
      missing: [],
    });

    expect(normalized.downloaded).not.toBeNull();
    expect(normalized.downloaded?.manifest).toMatchObject({
      formatVersion: 4,
      packageId: "legacy-pack",
      version: "1.2.3",
      assets: [],
    });
    expect(normalized.downloaded?.content.schemaVersion).toBe(2);
    expect(normalized.downloaded?.content.icons).toEqual({});
    expect(normalized.downloaded?.files.map((file) => file.path)).toEqual([
      "content.json",
    ]);
    expect(normalized.skipped).toEqual(["Creature.png"]);
  });

  it("keeps missing icons non-fatal and removes their assignments", async () => {
    const pack = ModpackSchema.parse({
      meta: {
        id: "legacy-pack",
        name: "Legacy Pack",
        version: "1.0.0",
        curseforgeId: "123",
      },
      icons: { "/m/c.c": "file:Missing.webp" },
    });

    const normalized = await normalizeLegacyModpackPackage(pack, {
      icons: [],
      missing: ["Missing.webp"],
    });

    expect(normalized.downloaded).not.toBeNull();
    expect(normalized.pack.icons).toEqual({});
    expect(normalized.downloaded?.manifest.assets).toEqual([]);
    expect(normalized.skipped).toEqual(["Missing.webp"]);
  });

  it("adds unsafe historical identities without copying their file icons", async () => {
    const pack = ModpackSchema.parse({
      meta: { id: "Unsafe Legacy ID", name: "Legacy Pack", version: "release one" },
      icons: { "/m/c.c": "file:Creature.png" },
    });

    const normalized = await normalizeLegacyModpackPackage(pack, {
      icons: [{ name: "Creature.png", contentB64: png }],
      missing: [],
    });

    expect(normalized.downloaded).toBeNull();
    expect(normalized.pack.icons).toEqual({});
    expect(normalized.skipped).toEqual(["Creature.png"]);
  });
});
