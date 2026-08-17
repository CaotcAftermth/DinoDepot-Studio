import { describe, expect, it } from "vitest";
import { templateModpack, type RegistryEntry } from "../model/modpack";
import { assemblePack, mergeRegistryIndex } from "./modpackPublish";

describe("v2 modpack publication", () => {
  it("exports the legacy alias and an immutable exact-version package", async () => {
    const assembled = await assemblePack(templateModpack(), "");

    expect(assembled.missingIcons).toEqual([]);
    expect(assembled.files.map((file) => file.path)).toEqual([
      "modpack.json",
      "versions/1.0.0/content.json",
      "versions/1.0.0/manifest.json",
    ]);
    expect(assembled.registryVersion?.manifest).toBe(
      "000000-Your_Mod_Name/versions/1.0.0/manifest.json",
    );
    expect(assembled.registryVersion?.integrity).toMatch(/^[a-f0-9]{64}$/);
  });

  it("publishes without a missing icon so consumers use the fallback", async () => {
    const pack = templateModpack();
    pack.icons[pack.creatures[0].bpPath] = "file:Missing.png";

    const assembled = await assemblePack(pack, "");

    expect(assembled.missingIcons).toEqual(["Missing.png"]);
    expect(assembled.registryEntry).not.toBeNull();
    expect(assembled.files.map((file) => file.path)).toEqual([
      "modpack.json",
      "versions/1.0.0/content.json",
      "versions/1.0.0/manifest.json",
    ]);
    const legacy = JSON.parse(assembled.files[0].text ?? "") as { icons: object };
    expect(Object.values(legacy.icons)).toEqual(["🦖"]);
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

    expect(merged.formatVersion).toBe(2);
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
