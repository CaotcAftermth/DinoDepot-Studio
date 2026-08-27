import {
  ASSET_SERVICE_ORIGIN,
  ModAssetManifestSchema,
  OfficialAssetManifestSchema,
  RegistryIndexSchema,
  type AssetRegistryIndex,
  type ModAssetManifest,
  type OfficialAssetManifest,
} from "../model/assetRegistry";
import type { ParsedIconKey } from "../model/iconKey";
import { assetDiagnostic } from "./assetDiagnostics";

export const REGISTRY_REFRESH_MS = 15 * 60 * 1_000;
export const REGISTRY_OFFLINE_MAX_MS = 24 * 60 * 60 * 1_000;

export interface RegistryCacheRecord {
  body: unknown;
  etag: string;
  fetchedAt: number;
}

export interface RegistryCache {
  get(key: string): Promise<RegistryCacheRecord | null>;
  set(key: string, value: RegistryCacheRecord): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RegistryResponse {
  status: 200 | 304;
  body?: unknown;
  etag?: string;
}

export type RegistryFetch = (url: string, etag?: string) => Promise<RegistryResponse>;

export class MemoryRegistryCache implements RegistryCache {
  private readonly values = new Map<string, RegistryCacheRecord>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async set(key: string, value: RegistryCacheRecord) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}

export async function fetchRegistryJson(url: string, etag?: string): Promise<RegistryResponse> {
  const response = await fetch(url, {
    headers: etag ? { "If-None-Match": etag } : {},
    cache: "no-cache",
  });
  if (response.status === 304) return { status: 304, etag: response.headers.get("etag") ?? etag };
  if (!response.ok) throw new Error(`registry HTTP ${response.status}`);
  return {
    status: 200,
    body: await response.json(),
    etag: response.headers.get("etag") ?? "",
  };
}

export class AssetRegistryClient {
  private readonly inflight = new Map<string, Promise<RegistryCacheRecord | null>>();

  constructor(
    private readonly cache: RegistryCache = new MemoryRegistryCache(),
    private readonly request: RegistryFetch = fetchRegistryJson,
    private readonly now: () => number = Date.now,
  ) {}

  async manifestFor(
    parsed: ParsedIconKey,
  ): Promise<ModAssetManifest | OfficialAssetManifest | null> {
    if (parsed.namespace !== "official" && parsed.namespace !== "mod") return null;
    const indexRecord = await this.load("/registry/index.json", RegistryIndexSchema);
    if (!indexRecord) return null;
    const index = RegistryIndexSchema.parse(indexRecord.body) as AssetRegistryIndex;
    if (parsed.namespace === "official") {
      if (!index.official) return null;
      const record = await this.load(index.official.manifest, OfficialAssetManifestSchema);
      return record ? OfficialAssetManifestSchema.parse(record.body) : null;
    }
    const row = index.mods[parsed.modId];
    if (!row) return null;
    const record = await this.load(row.manifest, ModAssetManifestSchema);
    if (!record) return null;
    const manifest = ModAssetManifestSchema.parse(record.body);
    return manifest.modId === Number(parsed.modId) ? manifest : null;
  }

  private async load(path: string, schema: { safeParse(value: unknown): { success: boolean } }): Promise<RegistryCacheRecord | null> {
    const current = await this.cache.get(path);
    const age = current ? this.now() - current.fetchedAt : Number.POSITIVE_INFINITY;
    if (current && age <= REGISTRY_REFRESH_MS) {
      return schema.safeParse(current.body).success ? current : null;
    }
    const pending = this.inflight.get(path);
    if (pending) return pending;
    const task = this.refresh(path, current, schema).finally(() => this.inflight.delete(path));
    this.inflight.set(path, task);
    return task;
  }

  private async refresh(
    path: string,
    current: RegistryCacheRecord | null,
    schema: { safeParse(value: unknown): { success: boolean } },
  ): Promise<RegistryCacheRecord | null> {
    try {
      const response = await this.request(`${ASSET_SERVICE_ORIGIN}${path}`, current?.etag);
      const next = response.status === 304 && current
        ? { ...current, fetchedAt: this.now(), etag: response.etag ?? current.etag }
        : { body: response.body, fetchedAt: this.now(), etag: response.etag ?? "" };
      if (!schema.safeParse(next.body).success) {
        await this.cache.delete(path);
        assetDiagnostic({ code: "registry-failure", key: path, detail: "unsupported or invalid schema" });
        return null;
      }
      await this.cache.set(path, next);
      return next;
    } catch (error) {
      if (
        current &&
        this.now() - current.fetchedAt <= REGISTRY_OFFLINE_MAX_MS &&
        schema.safeParse(current.body).success
      ) return current;
      assetDiagnostic({
        code: "registry-failure",
        key: path,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
