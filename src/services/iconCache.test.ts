import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The shared-icon cache.
 *
 * What matters: one request per icon per change and never one per render, a
 * cached icon still works with no network, and a conditional request that comes
 * back "not modified" transfers nothing.
 */

let disk: Record<string, { etag: string }> = {};
let calls: string[] = [];
let failCommands = false;

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push(cmd);
    if (failCommands) throw new Error("no backend");
    switch (cmd) {
      case "icon_cache_get": {
        const key = args.key as string;
        const entry = disk[key];
        return entry
          ? { path: `C:\\cache\\${key}.webp`, cached: true, etag: entry.etag }
          : { path: "", cached: false, etag: "" };
      }
      case "icon_cache_put": {
        const key = args.key as string;
        disk[key] = { etag: args.etag as string };
        return { path: `C:\\cache\\${key}.webp`, cached: true, etag: args.etag };
      }
      case "icon_cache_stats":
        return { files: Object.keys(disk).length, bytes: 1024, limit: 64 * 1024 * 1024 };
      case "icon_cache_clear": {
        const count = Object.keys(disk).length;
        disk = {};
        return count;
      }
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));

const { cacheKey, clear, formatBytes, lookup, resolveIcon, stats, __testing } =
  await import("./iconCache");

beforeEach(() => {
  disk = {};
  calls = [];
  failCommands = false;
  __testing.inFlight.clear();
});

describe("cache keys", () => {
  /** The registry publishes blob shas, which are already content hashes. */
  it("uses the blob sha when there is one", () => {
    expect(cacheKey({ blobSha: "A1B2C3D4E5F6", url: "https://x/y.webp" })).toBe(
      "a1b2c3d4e5f6",
    );
  });

  it("falls back to hashing the URL", () => {
    const key = cacheKey({ url: "https://x/y.webp" });
    expect(key).toMatch(/^url-[0-9a-f]{8}$/);
    expect(cacheKey({ url: "https://x/y.webp" })).toBe(key);
  });

  it("gives different URLs different keys", () => {
    expect(cacheKey({ url: "https://x/a.webp" })).not.toBe(
      cacheKey({ url: "https://x/b.webp" }),
    );
  });

  it("ignores a blob sha that is not one", () => {
    expect(cacheKey({ blobSha: "not a sha", url: "https://x/y.webp" })).toMatch(/^url-/);
  });

  /** A changed image means a changed key, so a stale hit is impossible. */
  it("changes when the content does", () => {
    expect(cacheKey({ blobSha: "aaaaaaa", url: "u" })).not.toBe(
      cacheKey({ blobSha: "bbbbbbb", url: "u" }),
    );
  });
});

describe("resolving an icon", () => {
  const fetcher = (result: Partial<{ contentB64: string; etag: string; notModified: boolean }>) =>
    vi.fn(async () => ({
      contentB64: "UklGRgAAAABXRUJQ",
      etag: '"v1"',
      notModified: false,
      ...result,
    }));

  it("fetches and stores on a miss", async () => {
    const fetch = fetcher({});
    const icon = await resolveIcon("abcdefgh", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(icon.cached).toBe(true);
    expect(calls).toContain("icon_cache_put");
  });

  /** The whole point: no request per render. */
  it("does not fetch when the icon is cached and has no ETag", async () => {
    disk.abcdefgh = { etag: "" };
    const fetch = fetcher({});
    const icon = await resolveIcon("abcdefgh", fetch);
    expect(fetch).not.toHaveBeenCalled();
    expect(icon.cached).toBe(true);
  });

  it("sends the stored ETag on a conditional request", async () => {
    disk.abcdefgh = { etag: '"v1"' };
    const fetch = fetcher({ notModified: true });
    await resolveIcon("abcdefgh", fetch);
    expect(fetch).toHaveBeenCalledWith('"v1"');
  });

  /** 304 means the copy on disk is current; nothing is written. */
  it("keeps the cached copy on a not-modified answer", async () => {
    disk.abcdefgh = { etag: '"v1"' };
    const icon = await resolveIcon("abcdefgh", fetcher({ notModified: true }));
    expect(icon.cached).toBe(true);
    expect(calls).not.toContain("icon_cache_put");
  });

  it("stores the new body when the icon has changed", async () => {
    disk.abcdefgh = { etag: '"v1"' };
    const icon = await resolveIcon(
      "abcdefgh",
      fetcher({ contentB64: "UklGRgAAAABXRUJQbmV3", etag: '"v2"' }),
    );
    expect(icon.etag).toBe('"v2"');
    expect(disk.abcdefgh.etag).toBe('"v2"');
  });

  /** Forty icons on a page must not become forty requests for the same one. */
  it("shares one request between concurrent callers", async () => {
    let resolveFetch: (v: unknown) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise<{ contentB64: string; etag: string; notModified: boolean }>((r) => {
          resolveFetch = r as (v: unknown) => void;
        }),
    );

    const a = resolveIcon("abcdefgh", fetch);
    const b = resolveIcon("abcdefgh", fetch);
    // The fetcher runs after the cache lookup, so it has not been called — and
    // `resolveFetch` not yet assigned — until the microtask queue drains.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    resolveFetch({ contentB64: "UklGRgAAAABXRUJQ", etag: '"v1"', notModified: false });

    expect(await a).toEqual(await b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("allows a later request once the first has finished", async () => {
    const fetch = fetcher({});
    await resolveIcon("abcdefgh", fetch);
    disk = {};
    await resolveIcon("abcdefgh", fetch);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe("offline", () => {
    /** A cached icon is still perfectly good with no network. */
    it("serves the cached copy when the fetch fails", async () => {
      disk.abcdefgh = { etag: '"v1"' };
      const icon = await resolveIcon("abcdefgh", async () => {
        throw new Error("offline");
      });
      expect(icon.cached).toBe(true);
    });

    it("reports a failure only when there is nothing cached", async () => {
      await expect(
        resolveIcon("abcdefgh", async () => {
          throw new Error("offline");
        }),
      ).rejects.toMatchObject({ code: "network.offline" });
    });
  });

  it("treats an unreadable cache as a miss rather than a failure", async () => {
    failCommands = true;
    const icon = await lookup("abcdefgh");
    expect(icon.cached).toBe(false);
  });
});

describe("managing the cache", () => {
  it("reports what is stored and the limit", async () => {
    disk.abcdefgh = { etag: "" };
    const result = await stats();
    expect(result.files).toBe(1);
    expect(result.limit).toBe(64 * 1024 * 1024);
  });

  /** Everything in it is re-fetchable, so clearing is always safe. */
  it("empties the cache and says how much went", async () => {
    disk.abcdefgh = { etag: "" };
    disk.ijklmnop = { etag: "" };
    expect(await clear()).toBe(2);
    expect(disk).toEqual({});
  });

  it("reports a size a person can read", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
