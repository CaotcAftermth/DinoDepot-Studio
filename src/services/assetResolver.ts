import {
  normalizeAssetPath,
  parseAssetValue,
  type AssetRef,
  type LegacyAssetContext,
} from "../model/assetRef";

export type AssetResolution =
  | { kind: "local"; absolutePath: string; ref: AssetRef }
  | { kind: "remote"; url: string; ref: AssetRef }
  | { kind: "glyph"; value: string }
  | { kind: "missing"; reason: string };

export interface AssetResolverContext {
  legacy?: LegacyAssetContext;
  projectImagesDir?: string | null;
  packageRoot?: (packageId: string, version: string) => string | null;
  officialRoot?: (version: string) => string | null;
}

function joinAssetRoot(root: string, relativePath: string): string | null {
  const path = normalizeAssetPath(relativePath);
  if (!root.trim() || !path) return null;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root.replace(/[/\\]+$/, "")}${separator}${path.replace(/\//g, separator)}`;
}

/** Resolves origin and ownership; display adapters turn local paths into URLs. */
export function resolveAsset(
  value: string | AssetRef | null | undefined,
  context: AssetResolverContext = {},
): AssetResolution {
  const parsed = parseAssetValue(value, context.legacy);
  if (!parsed) return { kind: "missing", reason: "Invalid or empty asset reference" };
  if (parsed.origin === "glyph") return { kind: "glyph", value: parsed.value };
  if (parsed.origin === "remote") {
    return { kind: "remote", url: parsed.url, ref: parsed };
  }

  let root: string | null | undefined;
  if (parsed.origin === "project") root = context.projectImagesDir;
  else if (parsed.origin === "package") {
    root = context.packageRoot?.(parsed.packageId, parsed.version);
  } else {
    root = context.officialRoot?.(parsed.packageVersion);
  }
  if (!root) {
    return { kind: "missing", reason: `${parsed.origin} asset root is unavailable` };
  }
  const absolutePath = joinAssetRoot(root, parsed.path);
  return absolutePath
    ? { kind: "local", absolutePath, ref: parsed }
    : { kind: "missing", reason: "Asset path is unsafe" };
}

export function remoteAssetUrl(
  value: string | AssetRef | null | undefined,
): string | null {
  const resolved = resolveAsset(value);
  return resolved.kind === "remote" ? resolved.url : null;
}
