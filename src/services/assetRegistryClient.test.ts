import { describe, expect, it, vi } from "vitest";
import {
  OfficialAssetManifestSchema,
  RegistryIndexSchema,
} from "../model/assetRegistry";
import { parseIconKey } from "../model/iconKey";
import {
  AssetRegistryClient,
  MemoryRegistryCache,
  REGISTRY_OFFLINE_MAX_MS,
  REGISTRY_REFRESH_MS,
  type RegistryFetch,
} from "./assetRegistryClient";

const index = {
  schemaVersion: 1,
  registryVersion: 1,
  generatedAt: "2026-08-27T18:00:00Z",
  mods: { "123": { manifest: "/registry/mods/123.json", version: 1 } },
};
const manifest = {
  schemaVersion: 1,
  modId: 123,
  modName: "Example",
  rights: {
    status: "author-approved",
    permissionId: "PERM-123-1",
    permissionVersion: "DDS-ICON-PERMISSION-v1.0",
    approvedAt: "2026-08-27",
    scope: ["creature-icons"],
    attribution: { creator: "Creator", projectUrl: "" },
  },
  assets: {},
};

const officialIndex = {
  ...index,
  official: { manifest: "/registry/official.json", version: 1 },
};
const officialManifest = {
  schemaVersion: 1,
  rights: {
    status: "official-reference-policy",
    policyId: "DDS-OFFICIAL-REF-v1",
    reviewedAt: "2026-08-27",
    reviewState: "approved",
    distributionEligible: true,
    scope: ["creature-icons"],
  },
  assets: {
    "creature:rex": {
      status: "active",
      path: "/official/creatures/rex.webp",
      version: 1,
      sha256: "a".repeat(64),
    },
  },
};

describe("asset registry client", () => {
  it("fetches only the index and relevant mod manifest and deduplicates requests", async () => {
    const request = vi.fn<RegistryFetch>(async (url) => ({
      status: 200,
      body: url.endsWith("index.json") ? index : manifest,
      etag: "v1",
    }));
    const client = new AssetRegistryClient(new MemoryRegistryCache(), request);
    const parsed = parseIconKey("mod:123:creature:rex")!;
    const [left, right] = await Promise.all([client.manifestFor(parsed), client.manifestFor(parsed)]);
    expect(left).toEqual(right);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([url]) => url)).not.toContain(expect.stringContaining("official.json"));
  });

  it("reads and validates shared registry documents once across many icons", async () => {
    const cache = new MemoryRegistryCache();
    const cacheGet = vi.spyOn(cache, "get");
    const indexParse = vi.spyOn(RegistryIndexSchema, "safeParse");
    const manifestParse = vi.spyOn(OfficialAssetManifestSchema, "safeParse");
    const request = vi.fn<RegistryFetch>(async (url) => ({
      status: 200,
      body: url.endsWith("index.json") ? officialIndex : officialManifest,
      etag: "v1",
    }));
    const client = new AssetRegistryClient(cache, request);
    const icon = parseIconKey("official:creature:rex")!;

    await Promise.all(
      Array.from({ length: 500 }, () => client.manifestFor(icon)),
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(cacheGet).toHaveBeenCalledTimes(2);
    expect(indexParse).toHaveBeenCalledTimes(1);
    expect(manifestParse).toHaveBeenCalledTimes(1);
  });

  it("uses fresh metadata for 15 minutes then makes conditional requests", async () => {
    let now = 0;
    const request = vi.fn<RegistryFetch>(async (url, etag) => etag
      ? { status: 304, etag }
      : { status: 200, body: url.endsWith("index.json") ? index : manifest, etag: "v1" });
    const client = new AssetRegistryClient(new MemoryRegistryCache(), request, () => now);
    const parsed = parseIconKey("mod:123:creature:rex")!;
    await client.manifestFor(parsed);
    now = REGISTRY_REFRESH_MS - 1;
    await client.manifestFor(parsed);
    expect(request).toHaveBeenCalledTimes(2);
    now = REGISTRY_REFRESH_MS + 1;
    await client.manifestFor(parsed);
    expect(request).toHaveBeenCalledTimes(4);
    expect(request.mock.calls.at(-1)?.[1]).toBe("v1");
  });

  it("fails closed when offline metadata is older than 24 hours", async () => {
    let now = 0;
    let offline = false;
    const request: RegistryFetch = async (url) => {
      if (offline) throw new Error("offline");
      return { status: 200, body: url.endsWith("index.json") ? index : manifest, etag: "v1" };
    };
    const client = new AssetRegistryClient(new MemoryRegistryCache(), request, () => now);
    const parsed = parseIconKey("mod:123:creature:rex")!;
    expect(await client.manifestFor(parsed)).not.toBeNull();
    offline = true;
    now = REGISTRY_OFFLINE_MAX_MS + 1;
    expect(await client.manifestFor(parsed)).toBeNull();
  });

  it("rejects unsupported schemas instead of retaining them", async () => {
    const request: RegistryFetch = async () => ({ status: 200, body: { ...index, schemaVersion: 2 } });
    const client = new AssetRegistryClient(new MemoryRegistryCache(), request);
    expect(await client.manifestFor(parseIconKey("mod:123:creature:rex")!)).toBeNull();
  });
});
