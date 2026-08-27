import { describe, expect, it } from "vitest";
import { afterEach, vi } from "vitest";
import { packFromUrl, resolvePackageManifestUrl, resolvePackUrls } from "./modpackSource";
import { defaultModpackRegistry } from "../model/modpack";

const registry = defaultModpackRegistry();
const RAW = "https://raw.githubusercontent.com";
const base = `${RAW}/${registry.owner}/${registry.repo}/${registry.branch}/${registry.path}`;

afterEach(() => vi.unstubAllGlobals());

describe("resolving a link someone pasted", () => {
  it("recognizes a GitHub immutable-version folder as a v2 manifest", () => {
    expect(
      resolvePackageManifestUrl(
        `https://github.com/${registry.owner}/${registry.repo}/tree/main/${registry.path}/987-Pack/versions/1.2.3`,
        registry,
      ),
    ).toBe(
      `${base}/987-Pack/versions/1.2.3/manifest.json`,
    );
  });

  it("does not mistake a compatibility pack folder for a v2 manifest", () => {
    expect(
      resolvePackageManifestUrl(
        `https://github.com/${registry.owner}/${registry.repo}/tree/main/${registry.path}/987-Pack`,
        registry,
      ),
    ).toBeNull();
  });

  it("takes the folder listing you land on when browsing", () => {
    expect(
      resolvePackUrls(
        `https://github.com/${registry.owner}/${registry.repo}/tree/main/${registry.path}/972253-Ports_of_Atlas`,
        registry,
      ),
    ).toEqual({
      packUrl: `${base}/972253-Ports_of_Atlas/modpack.json`,
      iconsBase: `${base}/972253-Ports_of_Atlas/icons`,
    });
  });

  it("takes the pack file itself", () => {
    const { packUrl, iconsBase } = resolvePackUrls(
      `https://github.com/${registry.owner}/${registry.repo}/blob/main/${registry.path}/972253-Ports_of_Atlas/modpack.json`,
      registry,
    );
    expect(packUrl).toBe(`${base}/972253-Ports_of_Atlas/modpack.json`);
    expect(iconsBase).toBe(`${base}/972253-Ports_of_Atlas/icons`);
  });

  it("works for a fork or a branch under review, which is the whole point", () => {
    const { packUrl } = resolvePackUrls(
      "https://github.com/someone/DinoDepot_Production_Studio/tree/modpack/972253-Ports_of_Atlas/Public_Content/ModPacks/972253-Ports_of_Atlas",
      registry,
    );
    expect(packUrl).toBe(
      `${RAW}/someone/DinoDepot_Production_Studio/modpack/972253-Ports_of_Atlas/Public_Content/ModPacks/972253-Ports_of_Atlas/modpack.json`,
    );
  });

  it("leaves a raw link alone", () => {
    expect(
      resolvePackUrls(`${base}/pack.json`, registry).packUrl,
    ).toBe(`${base}/pack.json`);
  });

  it("reads a bare name as a folder in this project's own registry", () => {
    expect(resolvePackUrls("972253-Ports_of_Atlas", registry)).toEqual({
      packUrl: `${base}/972253-Ports_of_Atlas/modpack.json`,
      iconsBase: `${base}/972253-Ports_of_Atlas/icons`,
    });
  });

  it("ignores the line and anchor fragments GitHub adds", () => {
    expect(
      resolvePackUrls(
        `https://github.com/${registry.owner}/${registry.repo}/blob/main/${registry.path}/p/modpack.json#L4-L20`,
        registry,
      ).packUrl,
    ).toBe(`${base}/p/modpack.json`);
  });

  it("says so when the link is a GitHub page rather than a pack", () => {
    expect(() =>
      resolvePackUrls(
        `https://github.com/${registry.owner}/${registry.repo}/pulls`,
        registry,
      ),
    ).toThrow(/GitHub page/);
  });

  it("says so when nothing was pasted", () => {
    expect(() => resolvePackUrls("   ", registry)).toThrow(/Paste a link/);
  });

  it("imports legacy content without requesting its artwork", async () => {
    const pack = {
      meta: { id: "legacy-pack", name: "Legacy Pack", curseforgeId: "123" },
      icons: { "/m/c.c": "file:Creature.png" },
    };
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify(pack), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    const source = await packFromUrl(`${base}/legacy-pack/modpack.json`, registry);
    const artwork = await source.icons();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(artwork).toEqual({ icons: [], missing: ["Creature.png"] });
  });
});
