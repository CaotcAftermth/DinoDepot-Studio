import { describe, expect, it, vi } from "vitest";
import {
  packageAssetV3,
  packageFile,
  packageJson,
  PackageManifestSchema,
} from "../model/package";

const fixture = vi.hoisted(() => ({
  text: new Map<string, string>(),
  bytes: new Map<string, Uint8Array>(),
}));

vi.mock("./ipc", () => ({
  isTauri: true,
  ipc: async (command: string, args: { path: string }) => {
    if (command === "read_text_file") {
      const value = fixture.text.get(args.path);
      if (value === undefined) throw new Error("missing text fixture");
      return value;
    }
    if (command === "read_file_b64") {
      const value = fixture.bytes.get(args.path);
      if (!value) throw new Error("missing byte fixture");
      let binary = "";
      for (const byte of value) binary += String.fromCharCode(byte);
      return btoa(binary);
    }
    throw new Error(`Unexpected IPC command ${command}`);
  },
}));

const { readPackageManifestFile } = await import("./packageManager");

/** A minimal but real RIFF/WEBP header — the signature check reads these. */
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  0x56, 0x50, 0x38, 0x20,
]);

describe("offline package folders", () => {
  it("reads and verifies the manifest and content beside it", async () => {
    const root = "C:\\offline\\versions\\1.0.0";
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
      }),
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "offline-pack",
      version: "1.0.0",
      meta: { name: "Offline Pack" },
      content: await packageFile("content.json", content, "application/json"),
    });
    const manifestPath = `${root}\\manifest.json`;
    fixture.text.set(manifestPath, packageJson(manifest));
    fixture.bytes.set(`${root}\\content.json`, content);

    const result = await readPackageManifestFile(manifestPath);

    expect(result.manifest.packageId).toBe("offline-pack");
    expect(result.content.format).toBe("dinodepot.package-content");
    expect(result.files).toHaveLength(1);
  });

  it("imports local official content while quarantining its legacy art", async () => {
    const root = "C:\\dev-packages\\official-asa\\1.0.0";
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: {
          "/Game/PrimalEarth/Dinos/Achatina/Achatina_Character_BP.Achatina_Character_BP":
            "file:assets/creatures/Achatina.webp",
        },
      }),
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "official",
      packageId: "official-asa",
      version: "1.0.0",
      meta: { name: "Official ASA Core Content" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [
        await packageFile("assets/creatures/Achatina.webp", WEBP, "image/webp"),
      ],
    });
    const manifestPath = `${root}\\manifest.json`;
    fixture.text.set(manifestPath, packageJson(manifest));
    fixture.bytes.set(`${root}\\content.json`, content);
    fixture.bytes.set(`${root}\\assets\\creatures\\Achatina.webp`, WEBP);

    const result = await readPackageManifestFile(manifestPath);

    expect(result.manifest.kind).toBe("official");
    expect(result.files.map((file) => file.path)).toEqual(["content.json"]);
  });

  it("does not read locally present v3 artwork blobs", async () => {
    const packageRoot = "C:\\offline\\content-addressed";
    const root = `${packageRoot}\\versions\\1.0.0`;
    const content = new TextEncoder().encode(
      packageJson({
        format: "dinodepot.package-content",
        schemaVersion: 1,
        icons: { "/m/c.c": "file:assets/Icon.webp" },
      }),
    );
    const asset = await packageAssetV3(
      "assets/Icon.webp",
      WEBP,
      "image/webp",
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 3,
      kind: "modpack",
      packageId: "offline-pack",
      version: "1.0.0",
      meta: { name: "Offline Pack" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [asset],
    });
    const manifestPath = `${root}\\manifest.json`;
    fixture.text.set(manifestPath, packageJson(manifest));
    fixture.bytes.set(`${root}\\content.json`, content);
    fixture.bytes.set(
      `${packageRoot}\\${asset.blob.replace(/\//g, "\\")}`,
      WEBP,
    );

    const result = await readPackageManifestFile(manifestPath);

    expect(result.files.map((file) => file.path)).toEqual(["content.json"]);
  });

  it("skips a quarantined legacy image whose bytes do not match", async () => {
    const root = "C:\\dev-packages\\liar\\1.0.0";
    const content = new TextEncoder().encode(
      packageJson({ format: "dinodepot.package-content", schemaVersion: 1 }),
    );
    // A GIF wearing a .png name. Trusting the extension is exactly the hole
    // the signature check exists to close.
    const notAPng = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 1]);
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "liar-pack",
      version: "1.0.0",
      meta: { name: "Liar" },
      content: await packageFile("content.json", content, "application/json"),
      assets: [await packageFile("assets/Icon.png", notAPng, "image/png")],
    });
    const manifestPath = `${root}\\manifest.json`;
    fixture.text.set(manifestPath, packageJson(manifest));
    fixture.bytes.set(`${root}\\content.json`, content);
    fixture.bytes.set(`${root}\\assets\\Icon.png`, notAPng);

    const result = await readPackageManifestFile(manifestPath);
    expect(result.files.map((file) => file.path)).toEqual(["content.json"]);
  });

  it("rejects content whose bytes drifted from the manifest hash", async () => {
    const root = "C:\\dev-packages\\drift\\1.0.0";
    const declared = new TextEncoder().encode(
      packageJson({ format: "dinodepot.package-content", schemaVersion: 1 }),
    );
    const manifest = PackageManifestSchema.parse({
      format: "dinodepot.package",
      formatVersion: 2,
      kind: "modpack",
      packageId: "drift-pack",
      version: "1.0.0",
      meta: { name: "Drift" },
      content: await packageFile("content.json", declared, "application/json"),
    });
    const manifestPath = `${root}\\manifest.json`;
    fixture.text.set(manifestPath, packageJson(manifest));
    fixture.bytes.set(
      `${root}\\content.json`,
      new TextEncoder().encode(
        packageJson({
          format: "dinodepot.package-content",
          schemaVersion: 1,
          iniNotes: "tampered",
        }),
      ),
    );

    await expect(readPackageManifestFile(manifestPath)).rejects.toThrow(
      /failed its integrity check/,
    );
  });
});
