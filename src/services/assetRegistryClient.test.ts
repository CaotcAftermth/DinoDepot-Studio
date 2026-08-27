import { describe, expect, it, vi } from "vitest";
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
