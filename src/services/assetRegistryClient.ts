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

interface RegistrySchema<T> {
  safeParse(value: unknown):
    | { success: true; data: T }
    | { success: false };
}

interface LoadedRegistryDocument {
  record: RegistryCacheRecord;
  data: unknown;
}

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
  /**
   * Parsed read-through cache for this app session.
   *
   * A registry manifest can contain thousands of icons. Resolving every row
   * must not re-read that same document through IPC or re-run its full Zod
   * validation. The persisted cache still owns restart durability; this map
   * only keeps its already-validated value while the process is alive.
   */
  private readonly loaded = new Map<string, LoadedRegistryDocument>();
  private readonly inflight = new Map<string, Promise<unknown | null>>();

  constructor(
    private readonly cache: RegistryCache = new MemoryRegistryCache(),
    private readonly request: RegistryFetch = fetchRegistryJson,
    private readonly now: () => number = Date.now,
  ) {}

  async manifestFor(
    parsed: ParsedIconKey,
  ): Promise<ModAssetManifest | OfficialAssetManifest | null> {
    if (parsed.namespace !== "official" && parsed.namespace !== "mod") return null;
    const index = await this.load<AssetRegistryIndex>(
      "/registry/index.json",
      RegistryIndexSchema,
    );
    if (!index) return null;
    if (parsed.namespace === "official") {
      if (!index.official) return null;
      return this.load<OfficialAssetManifest>(
        index.official.manifest,
        OfficialAssetManifestSchema,
      );
    }
    const row = index.mods[parsed.modId];
    if (!row) return null;
    const manifest = await this.load<ModAssetManifest>(
      row.manifest,
      ModAssetManifestSchema,
    );
    if (!manifest) return null;
    return manifest.modId === Number(parsed.modId) ? manifest : null;
  }

  private async load<T>(
    path: string,
    schema: RegistrySchema<T>,
  ): Promise<T | null> {
    const current = this.loaded.get(path);
    if (
      current &&
      this.now() - current.record.fetchedAt <= REGISTRY_REFRESH_MS
    ) {
      return current.data as T;
    }
    const pending = this.inflight.get(path);
    if (pending) return pending as Promise<T | null>;
    const task = this.loadCurrent(path, schema).finally(() =>
      this.inflight.delete(path),
    );
    this.inflight.set(path, task);
    return task;
  }

  private async loadCurrent<T>(
    path: string,
    schema: RegistrySchema<T>,
  ): Promise<T | null> {
    const loaded = this.loaded.get(path);
    const current = loaded?.record ?? await this.cache.get(path);
    const age = current
      ? this.now() - current.fetchedAt
      : Number.POSITIVE_INFINITY;
    const parsedCurrent = loaded
      ? loaded.data as T
      : current
        ? parsed(schema, current.body)
        : null;

    if (current && age <= REGISTRY_REFRESH_MS) {
      if (parsedCurrent !== null) {
        this.loaded.set(path, { record: current, data: parsedCurrent });
      }
      return parsedCurrent;
    }

    try {
      const response = await this.request(`${ASSET_SERVICE_ORIGIN}${path}`, current?.etag);
      const next = response.status === 304 && current
        ? { ...current, fetchedAt: this.now(), etag: response.etag ?? current.etag }
        : { body: response.body, fetchedAt: this.now(), etag: response.etag ?? "" };
      const nextData = parsed(schema, next.body);
      if (nextData === null) {
        await this.cache.delete(path);
        this.loaded.delete(path);
        assetDiagnostic({ code: "registry-failure", key: path, detail: "unsupported or invalid schema" });
        return null;
      }
      await this.cache.set(path, next);
      this.loaded.set(path, { record: next, data: nextData });
      return nextData;
    } catch (error) {
      if (
        current &&
        age <= REGISTRY_OFFLINE_MAX_MS &&
        parsedCurrent !== null
      ) {
        this.loaded.set(path, { record: current, data: parsedCurrent });
        return parsedCurrent;
      }
      assetDiagnostic({
        code: "registry-failure",
        key: path,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

function parsed<T>(schema: RegistrySchema<T>, value: unknown): T | null {
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}
