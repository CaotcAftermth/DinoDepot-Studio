import { ipc } from "./ipc";
import { asStudioError, StudioError } from "../model/errors";

/**
 * Shared modpack icons, cached on disk.
 *
 * Project icons load from the synchronized checkout and need none of this.
 * Managed package icons now resolve directly from the immutable package
 * library. This cache remains for remote previews and legacy HTTPS overrides;
 * accepted bytes are WebP (preferred) or PNG.
 *
 * Content-addressed, so the key changes when the image does and a stale hit is
 * impossible. One request per icon per change, never one per render.
 */

export interface CachedIcon {
  /** Absolute path for the asset protocol. Empty when not cached. */
  path: string;
  cached: boolean;
  etag: string;
}

export interface CacheStats {
  files: number;
  bytes: number;
  limit: number;
}

/**
 * The cache key for an icon.
 *
 * A Git blob SHA where one is known - the registry publishes them and they are
 * already content hashes. Otherwise the URL is hashed, which is weaker but
 * still changes when the pack version does, because the registry versions its
 * folders.
 */
export function cacheKey(input: { blobSha?: string; url: string }): string {
  if (input.blobSha && /^[0-9a-f]{7,64}$/i.test(input.blobSha)) {
    return input.blobSha.toLowerCase();
  }
  return `url-${hashText(input.url)}`;
}

/** FNV-1a, 8 hex characters. Not security; a collision costs one re-fetch. */
function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * In-flight fetches, so a page rendering forty icons at once makes one request
 * per icon rather than forty per icon.
 */
const inFlight = new Map<string, Promise<CachedIcon>>();

/** Whatever is already on disk. Never touches the network. */
export async function lookup(key: string): Promise<CachedIcon> {
  try {
    return await ipc<CachedIcon>("icon_cache_get", { key });
  } catch {
    // A cache that cannot be read is a cache miss, not a failure - the icon
    // falls back to its emoji and the app carries on.
    return { path: "", cached: false, etag: "" };
  }
}

export interface FetchResult {
  /** Base64 body. Empty when the server said "not modified". */
  contentB64: string;
  etag: string;
  /** True when the server answered 304. */
  notModified: boolean;
}

/**
 * Returns an icon's local path, fetching it only if it is not already cached.
 *
 * `fetcher` is passed in rather than imported so the network layer stays out of
 * this module - and so the conditional-request behaviour is testable without
 * one. It is given the stored ETag, and answering "not modified" refreshes the
 * cached copy's place in the eviction order without transferring bytes.
 */
export async function resolveIcon(
  key: string,
  fetcher: (etag: string) => Promise<FetchResult>,
): Promise<CachedIcon> {
  // Checked before anything is awaited. Looking the cache up first would let
  // every caller past this point before any of them registered - which is
  // precisely the case it exists for, a page rendering forty icons at once.
  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = (async () => {
    // Declared out here so the catch below can still fall back to it - the
    // whole point of that branch is serving a cached icon when the fetch fails.
    let existing: CachedIcon = { path: "", cached: false, etag: "" };
    try {
      existing = await lookup(key);
      if (existing.cached && !existing.etag) return existing;

      const result = await fetcher(existing.etag);

      // Nothing changed - the copy on disk is current, and `lookup` has already
      // marked it as used.
      if (result.notModified) {
        return existing.cached ? existing : { path: "", cached: false, etag: "" };
      }
      if (!result.contentB64) {
        return existing;
      }
      return await ipc<CachedIcon>("icon_cache_put", {
        key,
        contentB64: result.contentB64,
        etag: result.etag,
      });
    } catch (e) {
      // Offline, or the registry is down. A cached copy is still perfectly
      // good; without one the icon falls back to its emoji.
      if (existing.cached) return existing;
      throw asStudioError(e, "network.offline", "That icon could not be loaded.");
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, work);
  return work;
}

export async function stats(): Promise<CacheStats> {
  try {
    return await ipc<CacheStats>("icon_cache_stats", {});
  } catch (e) {
    throw asStudioError(e, "unknown", "The icon cache could not be read.");
  }
}

/** Empties the cache. Everything in it is re-fetchable, so this is always safe. */
export async function clear(): Promise<number> {
  try {
    return await ipc<number>("icon_cache_clear", {});
  } catch (e) {
    throw asStudioError(e, "unknown", "The icon cache could not be cleared.");
  }
}

/** Human-readable size, for the Settings line. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export { StudioError };
export const __testing = { inFlight, hashText };
