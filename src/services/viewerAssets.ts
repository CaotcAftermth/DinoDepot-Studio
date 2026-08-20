import type { AssetRef } from "../model/assetRef";
import { normalizeBpPath, type CatalogFile } from "../model/catalog";
import type { ViewerData } from "../serializers/viewer";
import { resolveAsset } from "./assetResolver";
import { packageRootKey } from "./dependencyManager";
import { ipc } from "./ipc";
import { OFFICIAL_PACKAGE_ID } from "./officialContent";
import {
  packageBytesToBase64,
  packageHttpGet,
} from "./packageHttp";

const MAX_EMBEDDED_IMAGE_B64 = 12 * 1024 * 1024;

function mediaType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  return (
    {
      png: "image/png",
      webp: "image/webp",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

function downloadedImageType(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

type ImageNode = { id?: string; ref?: string; img: string | null };

function imageNodes(root: unknown): ImageNode[] {
  const nodes: ImageNode[] = [];
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      Object.prototype.hasOwnProperty.call(record, "img") &&
      (record.img === null || typeof record.img === "string")
    ) {
      nodes.push(record as ImageNode);
    }
    Object.values(record).forEach(visit);
  };
  visit(root);
  return nodes;
}

/**
 * Makes viewer images self-contained data URLs.
 *
 * The delivery site must not depend on a private project repository or on one
 * administrator's package cache. Only the bytes cross the public boundary;
 * absolute local paths never enter generated JSON.
 */
export async function vendorViewerAssets(
  viewer: ViewerData,
  options: {
    catalog: CatalogFile;
    packageAssets: Record<string, AssetRef>;
    packageRoots: Record<string, string>;
    projectImagesDir: string;
    /**
     * Official package version this project pins.
     *
     * An `official:` icon carries no version of its own, so without this every
     * base-game icon an administrator assigned would resolve to nothing and be
     * quietly dropped from the published viewer.
     */
    officialVersion?: string;
    /** Called once per image that could not be embedded. Publication continues. */
    onSkipped?: (logicalPath: string, reason: string) => void;
  },
): Promise<ViewerData> {
  const cache = new Map<string, Promise<string>>();
  const remoteCache = new Map<string, Promise<string>>();
  const packageRoot = (packageId: string, version: string) =>
    options.packageRoots[packageRootKey("modpack", packageId, version)] ?? null;
  const officialRoot = (version: string) =>
    options.packageRoots[
      packageRootKey("official", OFFICIAL_PACKAGE_ID, version)
    ] ?? null;

  const embed = (absolutePath: string, logicalPath: string) => {
    const existing = cache.get(absolutePath);
    if (existing) return existing;
    const pending = ipc<string>("read_file_b64", { path: absolutePath }).then(
      (contentB64) => {
        const cleaned = contentB64.replace(/\s/g, "");
        if (cleaned.length > MAX_EMBEDDED_IMAGE_B64) {
          throw new Error(`Viewer image ${logicalPath} is too large to embed`);
        }
        return `data:${mediaType(logicalPath)};base64,${cleaned}`;
      },
    );
    cache.set(absolutePath, pending);
    return pending;
  };
  const embedRemote = (url: string) => {
    const existing = remoteCache.get(url);
    if (existing) return existing;
    const pending = packageHttpGet(url).then((response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Remote viewer image returned ${response.status}`);
      }
      const type = downloadedImageType(response.bytes);
      if (!type) throw new Error("Remote viewer image has an unsupported file signature");
      const contentB64 = packageBytesToBase64(response.bytes);
      if (contentB64.length > MAX_EMBEDDED_IMAGE_B64) {
        throw new Error("Remote viewer image is too large to embed");
      }
      return `data:${type};base64,${contentB64}`;
    });
    remoteCache.set(url, pending);
    return pending;
  };

  // A missing or malformed image is nonfatal: the entry keeps its glyph and
  // the cluster still publishes. Only the reason is reported.
  const skip = (logicalPath: string, error: unknown) => {
    options.onSkipped?.(
      logicalPath,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  };

  for (const node of imageNodes(viewer)) {
    const bpPath = node.id || node.ref || "";
    const key = bpPath ? normalizeBpPath(bpPath) : "";
    const assigned = key
      ? (options.catalog.icons[key] ?? options.packageAssets[key])
      : null;
    if (assigned) {
      const resolved = resolveAsset(assigned, {
        projectImagesDir: options.projectImagesDir,
        legacy: {
          origin: "project",
          officialVersion: options.officialVersion,
        },
        packageRoot,
        officialRoot,
      });
      if (resolved.kind === "remote") {
        node.img = await embedRemote(resolved.url).catch((error) =>
          skip(resolved.url, error),
        );
        continue;
      }
      if (resolved.kind === "local") {
        const path =
          "path" in resolved.ref ? resolved.ref.path : resolved.absolutePath;
        node.img = await embed(resolved.absolutePath, path).catch((error) =>
          skip(path, error),
        );
        continue;
      }
    }

    if (node.img && !/^(?:data:|https?:\/\/)/i.test(node.img)) {
      const relativePath = node.img;
      const resolved = resolveAsset(`file:${relativePath}`, {
        projectImagesDir: options.projectImagesDir,
      });
      node.img =
        resolved.kind === "local"
          ? await embed(resolved.absolutePath, relativePath).catch((error) =>
              skip(relativePath, error),
            )
          : skip(relativePath, new Error("path is unsafe or unresolvable"));
    }
  }

  if (viewer.logo && !/^(?:data:|https?:\/\/)/i.test(viewer.logo)) {
    const logoPath = viewer.logo;
    const logo = resolveAsset(`file:${logoPath}`, {
      projectImagesDir: options.projectImagesDir,
    });
    viewer.logo =
      logo.kind === "local"
        ? await embed(logo.absolutePath, logoPath).catch((error) =>
            skip(logoPath, error),
          )
        : skip(logoPath, new Error("path is unsafe or unresolvable"));
  }
  return viewer;
}
