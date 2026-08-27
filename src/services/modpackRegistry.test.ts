import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultModpackRegistry,
  ModpackSchema,
  type RegistryEntry,
} from "../model/modpack";
import { fetchRegistry, registryPackUrl } from "./modpackRegistry";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("unindexed registry compatibility", () => {
  it("discovers folder packs as well as legacy JSON files", async () => {
    const registry = defaultModpackRegistry();
    const pack = ModpackSchema.parse({
      meta: {
        id: "folder-pack",
        name: "Folder Pack",
        version: "1.2.3",
        curseforgeId: "12345",
      },
      creatures: [{ id: "c1", name: "Creature", bpPath: "/M/C.C" }],
    });
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/index.json")) return json({}, 404);
      if (url.includes("api.github.com")) {
        return json([
          { name: "12345-Folder_Pack", type: "dir" },
          { name: "legacy.json", type: "file" },
          { name: "README.md", type: "file" },
        ]);
      }
      if (url.endsWith("12345-Folder_Pack/modpack.json")) return json(pack);
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetch);

    const listing = await fetchRegistry(registry);

    expect(listing.unindexed).toBe(true);
    expect(listing.packs).toEqual([
      expect.objectContaining({
        id: "folder-pack",
        version: "1.2.3",
        dir: "12345-Folder_Pack",
        file: "",
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("12345-Folder_Pack/modpack.json"),
      expect.anything(),
    );
  });
});

describe("legacy registry compatibility", () => {
  it("exposes the exact compatibility URL used for cache reconstruction", () => {
    const registry = defaultModpackRegistry();
    expect(
      registryPackUrl(registry, {
        id: "pack",
        name: "Pack",
        version: "1.0.0",
        dir: "123-Pack",
      } as RegistryEntry),
    ).toBe(
      `https://raw.githubusercontent.com/${registry.owner}/${registry.repo}/${registry.branch}/${registry.path}/123-Pack/modpack.json`,
    );
  });

});

describe("published modpack registry index", () => {
  it("never advertises a development build to other administrators", async () => {
    // The regression this guards: a build run without --dev put 1.0.1-dev.1
    // into the index as the advertised latest version.
    const index = (
      await import("../../Public_Content/ModPacks/index.json")
    ).default as {
      packs: { id: string; version: string; versions: { version: string }[] }[];
    };
    for (const pack of index.packs) {
      expect(pack.version, pack.id).not.toMatch(/-dev\./);
      for (const entry of pack.versions ?? []) {
        expect(entry.version, pack.id).not.toMatch(/-dev\./);
      }
      expect(
        (pack.versions ?? []).some((entry) => entry.version === pack.version),
        `${pack.id} advertises a version with no immutable entry`,
      ).toBe(true);
    }
  });
});
