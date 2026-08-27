import type { AssetRef } from "../model/assetRef";
import { type CatalogFile } from "../model/catalog";
import type { ViewerData } from "../serializers/viewer";
import { resolveAsset } from "./assetResolver";
import { ipc } from "./ipc";

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

type ImageNode = { id?: string; ref?: string; iconKey?: string; img: string | null };

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
    // Only project custom paths are serialized into img. Official/mod keys are
    // resolved by the viewer from the public rights registry at runtime.
    if (node.img && !/^data:/i.test(node.img)) {
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

export function viewerProjectAssetCount(viewer: ViewerData): number {
  return imageNodes(viewer).filter((node) => Boolean(node.img)).length + (viewer.logo ? 1 : 0);
}
