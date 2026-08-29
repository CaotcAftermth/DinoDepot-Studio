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
  it("accepts the empty public registry", async () => {
    const root = "Public_Content/Asset_Registry/registry";
    const index = RegistryIndexSchema.parse(await load(`${root}/index.json`));
    const official = OfficialAssetManifestSchema.parse(await load(`${root}/official.json`));

    expect(index.mods).toEqual({});
    expect(official.rights.status).toBe("official-reference-policy");
    expect(official.rights.distributionEligible).toBe(false);
    expect(official.assets).toEqual({});
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
