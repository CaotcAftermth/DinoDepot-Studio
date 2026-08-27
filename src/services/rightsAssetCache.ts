import { convertFileSrc } from "@tauri-apps/api/core";
import type { IconKey } from "../model/iconKey";
import { ipc } from "./ipc";
import type { RegistryCache, RegistryCacheRecord, RegistryFetch, RegistryResponse } from "./assetRegistryClient";
import type { CachedAsset, RightsAwareAssetCache } from "./rightsAwareAssetResolver";

interface NativeAssetResult {
  path: string;
  cached: boolean;
  assetVersion: number;
  sha256: string;
  lastRightsVerifiedAt: number;
}

function cached(value: NativeAssetResult): CachedAsset | null {
  if (!value.cached || !value.path) return null;
  return {
    localPath: value.path,
    url: convertFileSrc(value.path),
    assetVersion: value.assetVersion,
    sha256: value.sha256,
  };
}

/** Native cache: app-data/asset-cache, never a project or modpack folder. */
export class TauriRightsAssetCache implements RightsAwareAssetCache {
  async find(iconKey: IconKey, assetVersion: number, sha256: string): Promise<CachedAsset | null> {
    return cached(await ipc<NativeAssetResult>("asset_cache_get", { iconKey, assetVersion, sha256 }));
  }

  async downloadVerifyAndStore(input: {
    iconKey: IconKey;
    assetVersion: number;
    sha256: string;
    url: string;
  }): Promise<CachedAsset> {
    const value = await ipc<NativeAssetResult>("asset_cache_fetch_and_put", input);
    const result = cached(value);
    if (!result) throw new Error("Verified asset was not promoted to cache");
    return result;
  }

  async purge(iconKey: IconKey): Promise<void> {
    await ipc("asset_cache_purge", { iconKey });
  }
}

/** Native registry metadata cache, isolated from image bytes. */
export class TauriRegistryCache implements RegistryCache {
  async get(key: string): Promise<RegistryCacheRecord | null> {
    return ipc<RegistryCacheRecord | null>("registry_cache_get", { key });
  }
  async set(key: string, value: RegistryCacheRecord): Promise<void> {
    await ipc("registry_cache_put", { key, value });
  }
  async delete(key: string): Promise<void> {
    await ipc("registry_cache_delete", { key });
  }
}

export const tauriRegistryFetch: RegistryFetch = async (url, etag): Promise<RegistryResponse> => {
  const parsed = new URL(url);
  return ipc<RegistryResponse>("registry_fetch", { path: parsed.pathname, etag: etag ?? "" });
};
