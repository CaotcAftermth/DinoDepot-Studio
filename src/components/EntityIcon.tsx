import { ReactNode, useMemo, useState } from "react";
import { useDraftsStore, resolveImagesDir } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { normalizeBpPath } from "../model/catalog";
import { fallbackIcon, officialMapAssetPath } from "../model/officialCatalog";
import { resolveCreatureBase } from "../model/creatureBase";
import { buildImageIndex, matchImage } from "../model/imageMatch";
import { useCatalogIndex, useCreatureNameMap } from "../stores/useCatalogIndex";
import { isTauri } from "../services/ipc";
import { Button, cx, Field, Input, Modal } from "./ui";
import { useRemoteIcon } from "./useRemoteIcon";
import {
  remoteAssetUrl,
  resolveAsset,
} from "../services/assetResolver";
import { packageRootKey } from "../services/dependencyManager";
import { OFFICIAL_PACKAGE_ID } from "../services/officialContent";

// convertFileSrc is a pure string transform (asset: URL); safe to import in
// browser mock mode too — we just never render file icons there.
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Icon resolution for creatures/items, in priority order:
 * 1. explicit assignment in catalog.icons (emoji, https URL, or `file:<rel path>`)
 * 2. name-matched image in the images folder (e.g. creatures/Achatina.png)
 * 3. for creature variants: the parent creature's icon (manual parent
 *    assignment first, then the naming heuristic — so Aberrant Achatina
 *    inherits Achatina.png automatically)
 * 4. category-based emoji, then kind fallback
 */

export { fallbackIcon };

/** Absolute folder currently scanned for icon images. */
export function useImagesDir(): string | null {
  const dir = useProjectStore((s) => s.dir);
  const imagesDir = useProjectStore((s) => s.local?.imagesDir);
  if (!dir) return null;
  return resolveImagesDir(dir, imagesDir);
}

/**
 * Cached on the file list's identity — like the catalog index, this is read
 * once per rendered icon, so a per-component `useMemo` rebuilt it hundreds of
 * times for a single list.
 */
let imageIndexKey: string[] | null = null;
let imageIndexValue: ReturnType<typeof buildImageIndex>;

export function useImageIndex() {
  const imageFiles = useDraftsStore((s) => s.imageFiles);
  if (imageIndexKey !== imageFiles) {
    imageIndexKey = imageFiles;
    imageIndexValue = buildImageIndex(imageFiles);
  }
  return imageIndexValue;
}

function fileUrl(imagesDir: string | null, relPath: string): string | null {
  if (!imagesDir || !isTauri) return null;
  const resolved = resolveAsset(`file:${relPath}`, {
    projectImagesDir: imagesDir,
  });
  if (resolved.kind !== "local") return null;
  try {
    return convertFileSrc(resolved.absolutePath);
  } catch {
    return null;
  }
}

function classNameCandidate(bpPath: string): string {
  const cls = bpPath.split(".").pop() ?? "";
  return cls.replace(/_C$/, "").replace(/_Character_BP.*/i, "");
}

/**
 * Resolves the display icon for a blueprint path.
 * Returns { src } for images or { emoji } for text icons.
 */
export function useResolvedIcon(
  bpPath: string,
  kind: "creatures" | "items",
  entityName?: string,
): { src: string | null; emoji: string } {
  const icons = useDraftsStore((s) => s.catalog.icons);
  const packageAssets = useDraftsStore((s) => s.packageAssets);
  const packageRoots = useDraftsStore((s) => s.packageRoots);
  // A remote icon cannot be rendered from its URL — see `useRemoteIcon`. This
  // resolves the assignment for *this* entry through the on-disk cache.
  const assignedUrl = remoteUrlOf(icons[normalizeBpPath(bpPath)]);
  const cachedRemote = useRemoteIcon(assignedUrl);
  const variantParents = useDraftsStore((s) => s.catalog.variantParents);
  const imagesDir = useImagesDir();
  const imageIndex = useImageIndex();
  const catalogIndex = useCatalogIndex();
  const nameMap = useCreatureNameMap();
  const emoji = fallbackIcon(bpPath, kind);

  function fromAssignment(path: string): { src: string | null; emoji: string } | null {
    const key = normalizeBpPath(path);
    const assigned = icons[key] ?? packageAssets[key];
    if (!assigned) return null;
    const resolved = resolveAsset(assigned, {
      projectImagesDir: imagesDir,
      packageRoot: (packageId, version) =>
        packageRoots[packageRootKey("modpack", packageId, version)] ?? null,
      officialRoot: (version) =>
        packageRoots[packageRootKey("official", OFFICIAL_PACKAGE_ID, version)] ??
        null,
    });
    if (resolved.kind === "local") {
      let src: string | null = null;
      if (isTauri) {
        try {
          src = convertFileSrc(resolved.absolutePath);
        } catch {
          src = null;
        }
      }
      return src ? { src, emoji } : null;
    }
    if (resolved.kind === "remote") {
      // Null until the cache has it; the emoji shows in the meantime rather
      // than a broken image, and appears for good if it never arrives.
      return { src: path === bpPath ? cachedRemote : null, emoji };
    }
    return resolved.kind === "glyph"
      ? { src: null, emoji: resolved.value }
      : null;
  }

  function fromImages(candidates: string[]): { src: string | null; emoji: string } | null {
    const file = matchImage(imageIndex, kind, candidates);
    if (!file) return null;
    const src = fileUrl(imagesDir, file);
    return src ? { src, emoji } : null;
  }

  const name =
    entityName ??
    catalogIndex[kind].get(normalizeBpPath(bpPath))?.entry.name ??
    "";

  // 1–2: own assignment, then own image match.
  const own =
    fromAssignment(bpPath) ??
    fromImages([name, classNameCandidate(bpPath)]);
  if (own) return own;

  // 3: variant inheritance (creatures only) — manual parent, official
  // class-stem match, then the tag/prefix-stripped name.
  if (kind === "creatures") {
    const hit = catalogIndex.creatures.get(normalizeBpPath(bpPath));
    const parentPath = variantParents[normalizeBpPath(bpPath)] ?? null;
    const base = resolveCreatureBase(
      { id: "", name: name || classNameCandidate(bpPath), bpPath },
      {
        parentPath,
        parentName: parentPath
          ? (catalogIndex.creatures.get(normalizeBpPath(parentPath))?.entry.name ??
            classNameCandidate(parentPath))
          : undefined,
        variantTag: hit?.source.variantTag,
      },
    );
    const basePath =
      base.bpPath ?? nameMap.get(base.label.toLowerCase()) ?? null;
    const isSelf =
      basePath !== null &&
      normalizeBpPath(basePath) === normalizeBpPath(bpPath);
    if (!isSelf) {
      const inherited =
        (basePath ? fromAssignment(basePath) : null) ??
        fromImages([
          base.label,
          basePath ? classNameCandidate(basePath) : "",
        ]);
      if (inherited) return inherited;
    }
  }

  // 4: the "missing icon" placeholder image, if one exists in the folder.
  const placeholder = imageIndex.missing[kind];
  if (placeholder) {
    const src = fileUrl(imagesDir, placeholder);
    if (src) return { src, emoji };
  }

  return { src: null, emoji };
}

export function EntityIcon({
  bpPath,
  kind,
  name,
  size = 18,
  className,
}: {
  bpPath: string;
  kind: "creatures" | "items";
  /** Display name — improves images-folder matching (e.g. Achatina.png). */
  name?: string;
  size?: number;
  className?: string;
}) {
  const { src, emoji } = useResolvedIcon(bpPath, kind, name);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        className={cx("inline-block rounded-sm object-contain shrink-0", className)}
        style={{ width: size, height: size }}
        onError={(e) => {
          // Broken image (file removed) — swap to the emoji fallback.
          const el = e.currentTarget;
          el.outerHTML = `<span style="font-size:${size - 2}px;width:${size}px" class="inline-block text-center shrink-0 leading-none">${emoji}</span>`;
        }}
      />
    );
  }
  return (
    <span
      className={cx("inline-block text-center shrink-0 leading-none", className)}
      style={{ fontSize: size - 2, width: size }}
    >
      {emoji}
    </span>
  );
}

/** Assigns/clears an icon for a blueprint path (persists to catalog.icons). */
export function useAssignIcon() {
  const { catalog, setCatalog } = useDraftsStore();
  return (bpPath: string, icon: string) => {
    const key = normalizeBpPath(bpPath);
    const icons = { ...catalog.icons };
    if (icon) icons[key] = icon;
    else delete icons[key];
    setCatalog({ ...catalog, icons });
  };
}

const EMOJI_PALETTE = [
  "🦖", "🦕", "🐉", "🦅", "🐻", "🐟", "🦎", "🐸", "🦂", "🐌", "🐢", "🦇",
  "🐺", "🦄", "🐘", "🦍", "🐙", "🦑", "🦀", "🐝", "🕷️", "🤖", "👹", "💀",
  "⛏️", "🔨", "🛡️", "🐎", "🏗️", "🎨", "🍖", "🥚", "🌱", "⚔️", "🏹", "👕",
  "🏺", "🏆", "💎", "🔮", "🧪", "🧬", "⚙️", "🔥", "❄️", "⚡", "🌋", "🪵",
  "🪨", "🧵", "🫧", "🍯", "🥩", "🍄", "🌾", "💊", "🗝️", "📦", "🎁", "✨",
];

const MAP_EMOJI_PALETTE = [
  "🗺️", "🏝️", "🌋", "🏜️", "⚔️", "🍄", "🏙️", "🗻", "🧬", "💎",
  "🚀", "🧭", "🛡️", "🌌", "⛏️", "🎪", "🎉", "❄️", "🌊", "🌲",
  "🏔️", "🕳️", "🌑", "☄️", "🔮", "🏛️", "🧊", "🔥", "🌴", "🪐",
];

/**
 * An icon value in the app's shared format — an emoji, `file:<relative path>`
 * into the images folder, or an https image URL.
 */
export function useIconSrc(): (icon: string) => string | null {
  const imagesDir = useImagesDir();
  return (icon: string) => {
    const resolved = resolveAsset(icon, { projectImagesDir: imagesDir });
    if (resolved.kind === "local" && isTauri) {
      try {
        return convertFileSrc(resolved.absolutePath);
      } catch {
        return null;
      }
    }
    // A remote URL is deliberately not returned: the page cannot load one, so
    // handing it back would render a broken image. `IconValue` resolves these
    // through the cache instead.
    return null;
  };
}

/** The https URL in an icon value, if it is one. */
export function remoteUrlOf(icon: string | undefined): string | null {
  return remoteAssetUrl(icon);
}

/** Renders an icon value, falling back to a plain glyph when it isn't an image. */
export function IconValue({
  icon,
  size = 20,
  fallback = "🗺️",
  officialMap,
  className,
}: {
  icon: string;
  size?: number;
  fallback?: string;
  /** Map name used to resolve managed Core Content art automatically. */
  officialMap?: string;
  className?: string;
}) {
  const localSrc = useIconSrc()(icon);
  const remoteSrc = useRemoteIcon(remoteUrlOf(icon));
  const packageRoots = useDraftsStore((state) => state.packageRoots);
  const officialVersion = useDraftsStore((state) => state.officialVersion);
  const managedPath =
    officialMap && officialVersion
      ? officialMapAssetPath(officialMap, icon)
      : null;
  const managed = managedPath
    ? resolveAsset(
        {
          origin: "official",
          packageVersion: officialVersion,
          path: managedPath,
        },
        {
          officialRoot: (version) =>
            packageRoots[
              packageRootKey("official", OFFICIAL_PACKAGE_ID, version)
            ] ?? null,
        },
      )
    : null;
  let managedSrc: string | null = null;
  if (managed?.kind === "local" && isTauri) {
    try {
      managedSrc = convertFileSrc(managed.absolutePath);
    } catch {
      managedSrc = null;
    }
  }
  const src = localSrc ?? remoteSrc ?? managedSrc;
  const resolved = resolveAsset(icon);
  const glyph = resolved.kind === "glyph" ? resolved.value : fallback;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className={cx("inline-block rounded-sm object-contain shrink-0", className)}
        style={{ width: size, height: size }}
        onError={(event) => {
          const element = event.currentTarget;
          element.outerHTML = `<span style="font-size:${size - 2}px;width:${size}px" class="inline-block text-center shrink-0 leading-none">${glyph}</span>`;
        }}
      />
    );
  }
  return (
    <span
      className={cx("inline-block text-center shrink-0 leading-none", className)}
      style={{ fontSize: size - 2, width: size }}
    >
      {glyph}
    </span>
  );
}

/**
 * Icon picker over project-owned images, emoji, and remote overrides.
 * Managed official/modpack images resolve automatically and are not exposed
 * as folders the administrator has to configure.
 */
export function IconChooserModal({
  title,
  current,
  palette = EMOJI_PALETTE,
  imageSearchSeed = "",
  fallbackNote,
  onPick,
  onClose,
}: {
  title: string;
  current: string;
  palette?: string[];
  /** Pre-fills the image search — usually the thing being given an icon. */
  imageSearchSeed?: string;
  /** Shown bottom-left, e.g. what happens with no assignment. */
  fallbackNote?: ReactNode;
  onPick: (icon: string) => void;
  onClose: () => void;
}) {
  const imageFiles = useDraftsStore((s) => s.imageFiles);
  const refreshImages = useDraftsStore((s) => s.refreshImages);
  const imagesDir = useImagesDir();
  const [custom, setCustom] = useState(
    current.startsWith("file:") ? "" : current,
  );
  const [imageSearch, setImageSearch] = useState(imageSearchSeed);

  const matchingImages = useMemo(() => {
    const q = imageSearch.toLowerCase().replace(/[^a-z0-9]/g, "");
    const list = q
      ? imageFiles.filter((f) =>
          f.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q),
        )
      : imageFiles;
    return list.slice(0, 24);
  }, [imageFiles, imageSearch]);

  function pick(icon: string) {
    onPick(icon);
    onClose();
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      {isTauri && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
              Project-owned images ({imageFiles.length} files)
            </span>
            <Button variant="ghost" onClick={() => refreshImages()}>
              ↻ Refresh
            </Button>
          </div>
          <p className="text-xs text-ink-400 mb-2">
            Scanning the project's managed <span className="mono">images</span>
            folder. WebP is preferred; PNG is also accepted.
          </p>
          <Input
            value={imageSearch}
            onChange={(e) => setImageSearch(e.target.value)}
            placeholder="Search images…"
            className="mb-2"
          />
          {matchingImages.length > 0 ? (
            <div className="grid grid-cols-8 gap-2">
              {matchingImages.map((file) => (
                <button
                  key={file}
                  onClick={() => pick(`file:${file}`)}
                  title={file}
                  className={cx(
                    "flex flex-col items-center gap-1 p-1.5 rounded-md hover:bg-ink-700 cursor-pointer border",
                    current === `file:${file}`
                      ? "border-accent-500"
                      : "border-transparent",
                  )}
                >
                  <img
                    src={imagesDir ? convertFileSrc(`${imagesDir}/${file}`) : ""}
                    alt={file}
                    className="w-10 h-10 object-contain"
                  />
                  <span className="text-[10px] text-ink-400 truncate w-full">
                    {file}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-400">
              {imageFiles.length === 0
                ? "No project images found. Add a .webp or .png file to the project's images folder."
                : "No matches."}
            </p>
          )}
        </div>
      )}

      <div className="border-t border-ink-700 pt-3">
        <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
          Emoji
        </span>
        <div className="grid grid-cols-12 gap-1 mb-4">
          {palette.map((emoji) => (
            <button
              key={emoji}
              onClick={() => pick(emoji)}
              className={cx(
                "text-xl p-1 rounded-md hover:bg-ink-700 cursor-pointer",
                current === emoji && "bg-ink-700 ring-1 ring-accent-500",
              )}
            >
              {emoji}
            </button>
          ))}
        </div>
        <Field
          label="Custom emoji or image URL"
          hint="Paste any emoji, or an https:// image URL (e.g. a wiki icon)"
        >
          <div className="flex gap-2">
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="🐌 or https://…/icon.png"
            />
            <Button
              variant="primary"
              disabled={!custom.trim()}
              onClick={() => pick(custom.trim())}
            >
              Set
            </Button>
          </div>
        </Field>
      </div>

      <div className="flex justify-between items-center mt-4">
        <span className="text-xs text-ink-400">{fallbackNote}</span>
        {current && (
          <Button variant="ghost" onClick={() => pick("")}>
            Reset to default
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/** Icon assignment for a catalog entry, stored in catalog.icons. */
export function IconPickerModal({
  bpPath,
  name,
  kind,
  onClose,
}: {
  bpPath: string;
  name: string;
  kind: "creatures" | "items";
  onClose: () => void;
}) {
  const assign = useAssignIcon();
  const icons = useDraftsStore((s) => s.catalog.icons);
  const current = icons[normalizeBpPath(bpPath)] ?? "";
  const fallback = useMemo(() => fallbackIcon(bpPath, kind), [bpPath, kind]);

  return (
    <IconChooserModal
      title={`Icon for ${name}`}
      current={current}
      imageSearchSeed={name}
      onPick={(icon) => assign(bpPath, icon)}
      onClose={onClose}
      fallbackNote={
        <>
          Files named after the creature/item (e.g.{" "}
          <span className="mono">creatures\Achatina.png</span>) are used
          automatically — variants inherit their parent's icon. Default:{" "}
          <span className="text-base">{fallback}</span>
        </>
      }
    />
  );
}

export { MAP_EMOJI_PALETTE };
