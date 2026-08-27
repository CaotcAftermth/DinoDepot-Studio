import { describe, expect, it, vi } from "vitest";
import type { ModAssetManifest, OfficialAssetManifest, RightsStatus } from "../model/assetRegistry";
import { parseIconKey, type IconKey } from "../model/iconKey";
import {
  RightsAwareAssetResolver,
  type RightsAwareAssetCache,
  type RightsAwareRegistry,
} from "./rightsAwareAssetResolver";

const HASH = "a".repeat(64);

function modManifest(status: RightsStatus = "author-approved", assetStatus = "active"): ModAssetManifest {
  return {
    schemaVersion: 1,
    modId: 123,
    modName: "Example",
    rights: {
      status,
      permissionId: status.endsWith("approved") ? "PERM-123-1" : undefined,
      permissionVersion: status.endsWith("approved") ? "DDS-ICON-PERMISSION-v1.0" : undefined,
      approvedAt: status.endsWith("approved") ? "2026-08-27" : undefined,
      scope: ["creature-icons", "item-icons"],
      attribution: { creator: "Creator", projectUrl: "" },
    },
    assets: {
      "creature:rex": {
        status: assetStatus as "active",
        path: "/mods/123/creatures/rex.webp",
        version: 2,
        sha256: HASH,
      },
    },
  };
}

function officialManifest(): OfficialAssetManifest {
  return {
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
        sha256: HASH,
      },
    },
  };
}

function registry(manifest: ModAssetManifest | OfficialAssetManifest | null): RightsAwareRegistry {
  return { manifestFor: vi.fn(async () => manifest) };
}

function cache(hit = false): RightsAwareAssetCache & { purge: ReturnType<typeof vi.fn> } {
  return {
    find: vi.fn(async (_key, version, sha256) => hit ? {
      localPath: "C:\\cache\\rex.webp", url: "asset://rex", assetVersion: version, sha256,
    } : null),
    downloadVerifyAndStore: vi.fn(async ({ assetVersion, sha256 }) => ({
      localPath: "C:\\cache\\rex.webp", url: "asset://rex", assetVersion, sha256,
    })),
    purge: vi.fn(async () => undefined),
  };
}

describe("rights-aware asset resolver", () => {
  it("resolves bundled DDS placeholders without registry access", async () => {
    const source = registry(null);
    const result = await new RightsAwareAssetResolver(source).resolveIcon({
      iconKey: "dds:placeholder:creature", expectedType: "creature",
    });
    expect(result.source).toBe("bundled");
    expect(source.manifestFor).not.toHaveBeenCalled();
  });

  it("resolves approved official and mod assets", async () => {
    const official = await new RightsAwareAssetResolver(registry(officialManifest())).resolveIcon({
      iconKey: "official:creature:rex", expectedType: "creature",
    });
    const mod = await new RightsAwareAssetResolver(registry(modManifest())).resolveIcon({
      iconKey: "mod:123:creature:rex", expectedType: "creature",
    });
    expect(official.url).toBe("https://assets.dinodepot.app/official/creatures/rex.webp");
    expect(mod.url).toBe("https://assets.dinodepot.app/mods/123/creatures/rex.webp");
  });

  it.each(["not-reviewed", "requested", "declined", "revoked", "ownership-unclear"] as RightsStatus[])(
    "denies and purges %s rights before cache lookup",
    async (status) => {
      const local = cache(true);
      const result = await new RightsAwareAssetResolver(registry(modManifest(status)), local).resolveIcon({
        iconKey: "mod:123:creature:rex", expectedType: "creature",
      });
      expect(result.fallbackReason).toBe("rights-denied");
      expect(local.find).not.toHaveBeenCalled();
      expect(local.purge).toHaveBeenCalledWith("mod:123:creature:rex");
    },
  );

  it.each(["disabled", "replaced", "withdrawn"])("denies %s assets", async (status) => {
    const local = cache(true);
    const result = await new RightsAwareAssetResolver(registry(modManifest("author-approved", status)), local).resolveIcon({
      iconKey: "mod:123:creature:rex", expectedType: "creature",
    });
    expect(result.fallbackReason).toBe("asset-inactive");
    expect(local.find).not.toHaveBeenCalled();
  });

  it("uses an exact-version/hash cache hit after current rights", async () => {
    const local = cache(true);
    const result = await new RightsAwareAssetResolver(registry(modManifest()), local).resolveIcon({
      iconKey: "mod:123:creature:rex", expectedType: "creature",
    });
    expect(local.find).toHaveBeenCalledWith("mod:123:creature:rex", 2, HASH);
    expect(result.source).toBe("cache");
  });

  it("rejects failed download/integrity promotion", async () => {
    const local = cache(false);
    vi.mocked(local.downloadVerifyAndStore).mockRejectedValueOnce(new Error("SHA-256 mismatch"));
    const result = await new RightsAwareAssetResolver(registry(modManifest()), local).resolveIcon({
      iconKey: "mod:123:creature:rex", expectedType: "creature",
    });
    expect(result.fallbackReason).toBe("cache-failure");
    expect(local.purge).toHaveBeenCalled();
  });

  it("resolves project paths only for the active project", async () => {
    const resolver = new RightsAwareAssetResolver(registry(null));
    const result = await resolver.resolveIcon({
      iconKey: "project:cluster-one:rex", expectedType: "creature",
      projectId: "Cluster One", projectRoot: "C:\\project\\images", projectAssets: { rex: "custom/rex.webp" },
    });
    expect(result.source).toBe("project");
    expect(result.localPath).toBe("C:\\project\\images\\custom\\rex.webp");
  });

  it("fails closed for malformed, missing, and type-mismatched keys", async () => {
    const resolver = new RightsAwareAssetResolver(registry(null));
    expect((await resolver.resolveIcon({ iconKey: "../rex", expectedType: "creature" })).source).toBe("fallback");
    expect((await resolver.resolveIcon({ iconKey: "mod:123:item:rex", expectedType: "creature" })).fallbackReason).toBe("type-mismatch");
    expect(parseIconKey("mod:123:creature:rex")?.value as IconKey).toBe("mod:123:creature:rex");
  });
});
