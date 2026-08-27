import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  ModAssetManifestSchema,
  OfficialAssetManifestSchema,
  RegistryIndexSchema,
  RegistryAssetSchema,
} from "./assetRegistry";

const load = async (path: string) => JSON.parse(await readFile(path, "utf8")) as unknown;

describe("public asset registry schemas", () => {
  it("accepts committed quarantine registries with no active artwork", async () => {
    const root = "Public_Content/Asset_Registry/registry";
    const index = RegistryIndexSchema.parse(await load(`${root}/index.json`));
    const official = OfficialAssetManifestSchema.parse(await load(`${root}/official.json`));
    const mod = ModAssetManifestSchema.parse(await load(`${root}/mods/987274.json`));

    expect(index.mods["987274"].manifest).toBe("/registry/mods/987274.json");
    expect(official.rights.status).toBe("official-reference-policy");
    expect(official.rights.distributionEligible).toBe(false);
    expect(Object.values(official.assets).every((asset) => asset.status === "disabled")).toBe(true);
    expect(mod.rights.status).toBe("not-reviewed");
    expect(Object.values(mod.assets).every((asset) => asset.status === "disabled")).toBe(true);
  });

  it("rejects traversal and mismatched mod paths", () => {
    expect(RegistryAssetSchema.safeParse({
      status: "active",
      path: "/mods/123/creatures/../private.webp",
      version: 1,
      sha256: "a".repeat(64),
    }).success).toBe(false);
    expect(ModAssetManifestSchema.safeParse({
      schemaVersion: 1,
      modId: 123,
      modName: "Example",
      rights: { status: "not-reviewed", scope: [], attribution: {} },
      assets: {
        "creature:rex": {
          status: "disabled",
          path: "/mods/999/creatures/rex.webp",
          version: 1,
          sha256: "a".repeat(64),
        },
      },
    }).success).toBe(false);
  });

  it("requires complete approval evidence", () => {
    expect(ModAssetManifestSchema.safeParse({
      schemaVersion: 1,
      modId: 123,
      modName: "Example",
      rights: {
        status: "author-approved",
        scope: ["creature-icons"],
        attribution: { creator: "Creator", projectUrl: "" },
      },
      assets: {},
    }).success).toBe(false);
  });
});
