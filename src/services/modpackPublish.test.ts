import { describe, expect, it, vi } from "vitest";
import { templateModpack, type RegistryEntry } from "../model/modpack";
import { assemblePack, mergeRegistryIndex } from "./modpackPublish";

const fixture = vi.hoisted(() => ({
  files: new Map<string, string>(),
}));

vi.mock("./ipc", () => ({
  ipc: async (command: string, args: { path: string }) => {
    if (command !== "read_file_b64") throw new Error(`Unexpected ${command}`);
    const value = fixture.files.get(args.path);
    if (!value) throw new Error(`Missing fixture ${args.path}`);
    return value;
  },
}));

describe("content-addressed modpack publication", () => {
  it("exports the legacy alias and an immutable exact-version package", async () => {
    const assembled = await assemblePack(templateModpack(), "");

    expect(assembled.missingIcons).toEqual([]);
    expect(assembled.files.map((file) => file.path)).toEqual([
      "modpack.json",
      "versions/1.0.0/content.json",
      "versions/1.0.0/manifest.json",
    ]);
    expect(assembled.registryVersion?.manifest).toBe(
      "0-Your_Mod_Name/versions/1.0.0/manifest.json",
    );
    expect(assembled.registryVersion?.integrity).toMatch(/^[a-f0-9]{64}$/);
  });

  it("publishes without a missing icon so consumers use the fallback", async () => {
    const pack = templateModpack();
    pack.icons[pack.creatures[0].bpPath] = "file:Missing.png";

    const assembled = await assemblePack(pack, "");

    expect(assembled.missingIcons).toEqual([]);
    expect(assembled.registryEntry).not.toBeNull();
    expect(assembled.files.map((file) => file.path)).toEqual([
      "modpack.json",
      "versions/1.0.0/content.json",
      "versions/1.0.0/manifest.json",
    ]);
    const legacy = JSON.parse(assembled.files[0].text ?? "") as { icons: object };
    expect(Object.values(legacy.icons)).toEqual([]);
  });

  it("emits no artwork even when legacy icon bytes are available", async () => {
    const png = Uint8Array.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    let binary = "";
    for (const byte of png) binary += String.fromCharCode(byte);
    fixture.files.set("C:\\icons\\A.png", btoa(binary));
    fixture.files.set("C:\\icons\\B.png", btoa(binary));
    const pack = templateModpack();
    pack.icons["/test/a.a"] = "file:A.png";
    pack.icons["/test/b.b"] = "file:B.png";

    const assembled = await assemblePack(pack, "C:\\icons");
    const manifestFile = assembled.files.find((file) =>
      file.path.endsWith("/manifest.json"),
    );
    const manifest = JSON.parse(manifestFile?.text ?? "") as {
      formatVersion: number;
      assets: unknown[];
    };

    expect(manifest.formatVersion).toBe(4);
    expect(manifest.assets).toEqual([]);
    expect(
      assembled.files.filter((file) => /\.(?:png|webp)$/i.test(file.path)),
    ).toHaveLength(0);
  });

  it("merges exact versions without discarding history", () => {
    const base: RegistryEntry = {
      id: "pack",
      name: "Pack",
      version: "1.0.0",
      updatedAt: "2026-01-01",
      author: "",
      description: "",
      curseforgeId: "123",
      dir: "123-Pack",
      file: "",
      creatureCount: 1,
      itemCount: 0,
      versions: [
        {
          version: "1.0.0",
          manifest: "123-Pack/versions/1.0.0/manifest.json",
          integrity: "1".repeat(64),
          publishedAt: "2026-01-01",
        },
      ],
    };
    const incoming: RegistryEntry = {
      ...base,
      version: "2.0.0",
      versions: [
        {
          version: "2.0.0",
          manifest: "123-Pack/versions/2.0.0/manifest.json",
          integrity: "2".repeat(64),
          publishedAt: "2026-02-01",
        },
      ],
    };

    const merged = mergeRegistryIndex(
      { formatVersion: 1, packs: [base] },
      incoming,
    );

    expect(merged.formatVersion).toBe(3);
    expect(merged.packs[0].versions?.map((version) => version.version)).toEqual([
      "1.0.0",
      "2.0.0",
    ]);
  });

  it("rejects changed bytes for a published exact version", () => {
    const entry = (integrity: string): RegistryEntry => ({
      id: "pack",
      name: "Pack",
      version: "1.0.0",
      updatedAt: "",
      author: "",
      description: "",
      curseforgeId: "123",
      dir: "123-Pack",
      file: "",
      creatureCount: 0,
      itemCount: 0,
      versions: [
        {
          version: "1.0.0",
          manifest: "123-Pack/versions/1.0.0/manifest.json",
          integrity,
          publishedAt: "",
        },
      ],
    });

    expect(() =>
      mergeRegistryIndex(
        { formatVersion: 2, packs: [entry("1".repeat(64))] },
        entry("2".repeat(64)),
      ),
    ).toThrow(/different bytes/);
  });
});
