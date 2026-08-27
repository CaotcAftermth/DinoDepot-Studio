import missingCreatureIcon from "../assets/icons/Missing_Creature_Icon.webp";
import missingItemIcon from "../assets/icons/Missing_Item_Icon.webp";
import {
  absoluteAssetUrl,
  modRightsAllowDistribution,
  rightsScopeFor,
  type ModAssetManifest,
  type OfficialAssetManifest,
  type RegistryAsset,
} from "../model/assetRegistry";
import { normalizeAssetPath } from "../model/assetRef";
import { iconSlug, parseIconKey, type IconKey, type ParsedIconKey } from "../model/iconKey";
import type { LegacyIconRef } from "../model/catalog";
import { assetDiagnostic } from "./assetDiagnostics";

export type ContentIconType = "creature" | "item" | "map";
export type IconFallbackReason =
  | "malformed-key"
  | "type-mismatch"
  | "missing-dds-asset"
  | "project-mismatch"
  | "missing-project-asset"
  | "registry-unavailable"
  | "rights-denied"
  | "scope-denied"
  | "missing-asset"
  | "asset-inactive"
  | "invalid-asset-url"
  | "cache-failure"
  | "legacy-quarantined";

export interface ResolvedIcon {
  iconKey: IconKey | null;
  source: "bundled" | "project" | "cache" | "remote" | "fallback";
  url: string;
  localPath: string | null;
  version: number | null;
  sha256: string | null;
  fallbackReason: IconFallbackReason | null;
}

export interface CachedAsset {
  localPath: string;
  url: string;
  assetVersion: number;
  sha256: string;
}

export interface RightsAwareAssetCache {
  find(iconKey: IconKey, assetVersion: number, sha256: string): Promise<CachedAsset | null>;
  downloadVerifyAndStore(input: {
    iconKey: IconKey;
    assetVersion: number;
    sha256: string;
    url: string;
  }): Promise<CachedAsset>;
  purge(iconKey: IconKey): Promise<void>;
}

export interface RightsAwareRegistry {
  manifestFor(parsed: ParsedIconKey): Promise<ModAssetManifest | OfficialAssetManifest | null>;
}

export interface ResolveIconInput {
  iconKey: unknown;
  expectedType: ContentIconType;
  projectId?: string;
  projectRoot?: string;
  projectAssets?: Record<string, string>;
  legacyRef?: LegacyIconRef;
}

const bundled: Record<string, string> = {
  "dds:placeholder:creature": missingCreatureIcon,
  "dds:placeholder:item": missingItemIcon,
  "dds:placeholder:map": missingItemIcon,
};

export class RightsAwareAssetResolver {
  constructor(
    private readonly registry: RightsAwareRegistry,
    private readonly cache?: RightsAwareAssetCache,
  ) {}

  async resolveIcon(input: ResolveIconInput): Promise<ResolvedIcon> {
    const parsed = parseIconKey(input.iconKey);
    if (!parsed) {
      if (input.legacyRef) {
        assetDiagnostic({ code: "legacy-reference", key: input.legacyRef.value, detail: "quarantined compatibility reference" });
      } else {
        assetDiagnostic({ code: "malformed-key", key: String(input.iconKey ?? ""), detail: "using bundled placeholder" });
      }
      return this.fallback(input.expectedType, input.legacyRef ? "legacy-quarantined" : "malformed-key");
    }
    if (!typeMatches(parsed, input.expectedType)) {
      return this.fallback(input.expectedType, "type-mismatch", parsed.value);
    }
    if (parsed.namespace === "dds") return this.resolveBundled(parsed, input.expectedType);
    if (parsed.namespace === "project") return this.resolveProject(parsed, input);
    return this.resolveRegistry(parsed, input.expectedType);
  }

  private resolveBundled(parsed: Extract<ParsedIconKey, { namespace: "dds" }>, type: ContentIconType): ResolvedIcon {
    const url = bundled[parsed.value];
    return url
      ? resolved(parsed.value, "bundled", url, null, null, null)
      : this.fallback(type, "missing-dds-asset", parsed.value);
  }

  private resolveProject(
    parsed: Extract<ParsedIconKey, { namespace: "project" }>,
    input: ResolveIconInput,
  ): ResolvedIcon {
    if (!input.projectId || iconSlug(input.projectId, "project") !== parsed.projectId) {
      return this.fallback(input.expectedType, "project-mismatch", parsed.value);
    }
    const relative = input.projectAssets?.[parsed.assetId];
    const safe = relative ? normalizeAssetPath(relative) : null;
    if (!safe || !input.projectRoot) {
      return this.fallback(input.expectedType, "missing-project-asset", parsed.value);
    }
    const localPath = `${input.projectRoot.replace(/[\\/]+$/, "")}\\${safe.replace(/\//g, "\\")}`;
    return resolved(parsed.value, "project", localPath, localPath, null, null);
  }

  private async resolveRegistry(
    parsed: Extract<ParsedIconKey, { namespace: "official" | "mod" }>,
    type: ContentIconType,
  ): Promise<ResolvedIcon> {
    const manifest = await this.registry.manifestFor(parsed);
    if (!manifest) return this.fallback(type, "registry-unavailable", parsed.value);
    const key = `${parsed.type}:${parsed.assetId}`;

    if (parsed.namespace === "mod") {
      const modManifest = manifest as ModAssetManifest;
      if (!modRightsAllowDistribution(modManifest.rights)) {
        await this.purge(parsed.value, "rights denied or revoked");
        return this.fallback(type, "rights-denied", parsed.value);
      }
      if (!modManifest.rights.scope.includes(rightsScopeFor(parsed.type) as "creature-icons" | "item-icons")) {
        await this.purge(parsed.value, "asset type outside approved scope");
        return this.fallback(type, "scope-denied", parsed.value);
      }
    } else {
      const official = manifest as OfficialAssetManifest;
      if (!official.rights.distributionEligible || official.rights.reviewState !== "approved") {
        await this.purge(parsed.value, "official reference policy is not distribution-eligible");
        return this.fallback(type, "rights-denied", parsed.value);
      }
      if (!official.rights.scope.includes(rightsScopeFor(parsed.type) as "creature-icons" | "item-icons" | "map-icons")) {
        await this.purge(parsed.value, "official reference type outside policy scope");
        return this.fallback(type, "scope-denied", parsed.value);
      }
    }

    const asset = manifest.assets[key] as RegistryAsset | undefined;
    if (!asset) {
      await this.purge(parsed.value, "asset removed from manifest");
      return this.fallback(type, "missing-asset", parsed.value);
    }
    if (asset.status !== "active") {
      await this.purge(parsed.value, `asset state ${asset.status}`);
      return this.fallback(type, "asset-inactive", parsed.value);
    }
    const url = absoluteAssetUrl(asset.path);
    if (!url) return this.fallback(type, "invalid-asset-url", parsed.value);

    if (!this.cache) return resolved(parsed.value, "remote", url, null, asset.version, asset.sha256);
    const cached = await this.cache.find(parsed.value, asset.version, asset.sha256);
    if (cached) {
      return resolved(parsed.value, "cache", cached.url, cached.localPath, asset.version, asset.sha256);
    }
    try {
      const stored = await this.cache.downloadVerifyAndStore({
        iconKey: parsed.value,
        assetVersion: asset.version,
        sha256: asset.sha256,
        url,
      });
      return resolved(parsed.value, "cache", stored.url, stored.localPath, asset.version, asset.sha256);
    } catch (error) {
      assetDiagnostic({
        code: "hash-failure",
        key: parsed.value,
        detail: error instanceof Error ? error.message : String(error),
      });
      await this.purge(parsed.value, "download or integrity verification failed");
      return this.fallback(type, "cache-failure", parsed.value);
    }
  }

  private async purge(iconKey: IconKey, detail: string): Promise<void> {
    if (!this.cache) return;
    await this.cache.purge(iconKey);
    assetDiagnostic({ code: "revocation-purge", key: iconKey, detail });
  }

  private fallback(type: ContentIconType, reason: IconFallbackReason, iconKey: IconKey | null = null): ResolvedIcon {
    const url = type === "creature" ? missingCreatureIcon : missingItemIcon;
    return { iconKey, source: "fallback", url, localPath: null, version: null, sha256: null, fallbackReason: reason };
  }
}

function typeMatches(parsed: ParsedIconKey, expected: ContentIconType): boolean {
  if (parsed.namespace === "official" || parsed.namespace === "mod") return parsed.type === expected;
  if (parsed.namespace === "dds" && parsed.className === "placeholder") return parsed.assetId === expected;
  return true;
}

function resolved(
  iconKey: IconKey,
  source: ResolvedIcon["source"],
  url: string,
  localPath: string | null,
  version: number | null,
  sha256: string | null,
): ResolvedIcon {
  return { iconKey, source, url, localPath, version, sha256, fallbackReason: null };
}

let defaultResolver: RightsAwareAssetResolver | null = null;

export function configureIconResolver(resolver: RightsAwareAssetResolver): void {
  defaultResolver = resolver;
}

export async function resolveIcon(input: ResolveIconInput): Promise<ResolvedIcon> {
  if (!defaultResolver) {
    return new RightsAwareAssetResolver({ manifestFor: async () => null }).resolveIcon(input);
  }
  return defaultResolver.resolveIcon(input);
}
