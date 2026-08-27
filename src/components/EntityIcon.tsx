import { ReactNode, useMemo, useState } from "react";
import { useDraftsStore, resolveImagesDir } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  assignedIconKey,
  catalogLegacyIconValues,
  normalizeBpPath,
} from "../model/catalog";
import { iconSlug, parseIconKey, type IconKey } from "../model/iconKey";
import { useCatalogIndex } from "../stores/useCatalogIndex";
import { isTauri } from "../services/ipc";
import { IconImportPanel } from "./IconImportPanel";
import { Button, cx, Field, Input, Modal } from "./ui";
import { resolveAsset } from "../services/assetResolver";
import { ContentIcon } from "./ContentIcon";
import {
  iconFileStem,
  modFolderPath,
  writeProjectIcon,
  type ModTexture,
} from "../services/modAssets";
import { TexturePickerModal } from "../pages/content/TexturePickerModal";
import { toast } from "./toast";

// convertFileSrc is a pure string transform (asset: URL); safe to import in
// browser mock mode too — we just never render file icons there.
import { convertFileSrc } from "@tauri-apps/api/core";

/** Absolute folder currently scanned for icon images. */
export function useImagesDir(): string | null {
  const dir = useProjectStore((s) => s.dir);
  const imagesDir = useProjectStore((s) => s.local?.imagesDir);
  if (!dir) return null;
  return resolveImagesDir(dir, imagesDir);
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
  const catalog = useDraftsStore((state) => state.catalog);
  const index = useCatalogIndex();
  const type = kind === "creatures" ? "creature" : "item";
  const entry = index[kind].get(normalizeBpPath(bpPath))?.entry;
  const iconKey = assignedIconKey(catalog, bpPath) ?? entry?.iconKey ??
    (`dds:placeholder:${type}` as IconKey);
  return <ContentIcon iconKey={iconKey} type={type} alt={name ?? entry?.name ?? ""} size={size} className={className} />;
}

/** Assigns/clears an icon for a blueprint path (persists to catalog.icons). */
export function useAssignIcon() {
  const { catalog, setCatalog } = useDraftsStore();
  const projectId = useProjectStore((state) => state.settings?.projectId ?? "project");
  const catalogIndex = useCatalogIndex();
  return (bpPath: string, icon: string) => {
    const key = normalizeBpPath(bpPath);
    if (catalog.schemaVersion === 1) {
      const icons = { ...catalog.icons };
      if (icon) icons[key] = icon;
      else delete icons[key];
      setCatalog({ ...catalog, icons });
      return;
    }
    const iconOverrides = { ...catalog.iconOverrides };
    const projectAssets = { ...catalog.projectAssets };
    const legacyIconRefs = { ...catalog.legacyIconRefs };
    const parsed = parseIconKey(icon);
    if (!icon) {
      delete iconOverrides[key];
      delete legacyIconRefs[key];
    } else if (parsed) {
      iconOverrides[key] = parsed.value;
      delete legacyIconRefs[key];
    } else if (icon.startsWith("official:")) {
      const path = icon.slice(9);
      const assetId = iconSlug(path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "asset");
      const type = catalogIndex.creatures.has(key) ? "creature" : "item";
      iconOverrides[key] = `official:${type}:${assetId}` as IconKey;
      delete legacyIconRefs[key];
    } else if (icon.startsWith("file:")) {
      const path = icon.slice(5).replace(/\\/g, "/");
      const assetId = `${iconSlug(path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "asset")}-${Math.abs(hashPath(key)).toString(16)}`;
      projectAssets[assetId] = path;
      iconOverrides[key] = `project:${iconSlug(projectId, "project")}:${assetId}` as IconKey;
      delete legacyIconRefs[key];
    } else {
      delete iconOverrides[key];
      legacyIconRefs[key] = {
        kind: /^https?:\/\//i.test(icon) ? "remote" : "glyph",
        value: icon,
      };
    }
    setCatalog({ ...catalog, icons: {}, iconOverrides, projectAssets, legacyIconRefs });
  };
}

function hashPath(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
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
    const resolved = resolveAsset(icon, {
      projectImagesDir: imagesDir,
    });
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

/** Renders an icon value, falling back to a plain glyph when it isn't an image. */
export function IconValue({
  icon,
  size = 20,
  fallback = "🗺️",
  officialMap: _officialMap,
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
  const src = localSrc;
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
 * Icon picker over project-owned images and map emoji.
 * Global official/mod artwork appears only through current rights manifests.
 */
export function IconChooserModal({
  title,
  current,
  palette = EMOJI_PALETTE,
  officialArtwork = false,
  officialKind,
  iconGroup,
  imageSearchSeed = "",
  fallbackNote,
  onExtractTexture,
  onPick,
  onClose,
}: {
  title: string;
  current: string;
  palette?: string[];
  /**
   * Creature/item mode. Official package artwork is deliberately unavailable;
   * project-owned custom import remains available.
   */
  officialArtwork?: boolean;
  /**
   * Restricts the base game list to one folder of the package.
   *
   * Creature art and item art are both in there, and searching "Rex" while
   * assigning an item icon should not turn up the animal.
   */
  officialKind?: "creatures" | "items";
  /** Folder the import panel files a new icon under, usually the mod's name. */
  iconGroup?: string;
  /** Pre-fills the image search — usually the thing being given an icon. */
  imageSearchSeed?: string;
  /** Shown bottom-left, e.g. what happens with no assignment. */
  fallbackNote?: ReactNode;
  /** Explicit project-custom extraction; never uploads to global asset service. */
  onExtractTexture?: () => void;
  onPick: (icon: string) => void;
  onClose: () => void;
}) {
  const imageFiles = useDraftsStore((s) => s.imageFiles);
  const refreshImages = useDraftsStore((s) => s.refreshImages);
  const imagesDir = useImagesDir();
  const [custom, setCustom] = useState(
    current.startsWith("file:") || current.startsWith("official:")
      ? ""
      : current,
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
      <div className="flex gap-4 items-start">
        <div className="min-w-0 flex-1">
      {isTauri && (
        <div className="mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
              Project-owned images ({imageFiles.length} files)
            </span>
            <div className="flex gap-1">
              {onExtractTexture && (
                <Button variant="ghost" onClick={onExtractTexture}>
                  Extract installed mod texture…
                </Button>
              )}
              <Button variant="ghost" onClick={() => refreshImages()}>
                ↻ Refresh
              </Button>
            </div>
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

      {officialArtwork && (
        <div className="mb-4">
          <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
            Approved {officialKind === "items" ? "item" : "creature"} artwork
          </span>
          <p className="text-xs text-ink-400 mt-1">
            Permission not established for bundled reference art. Approved
            registry artwork resolves automatically; use project-owned custom
            art below when you control publication rights.
          </p>
        </div>
      )}

      <div className="border-t border-ink-700 pt-3">
        {!officialArtwork && (
          <>
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
              label="Custom emoji"
              hint="Remote image URLs are quarantined compatibility refs and cannot be newly assigned."
            >
              <div className="flex gap-2">
                <Input
                  value={custom}
                  onChange={(e) => setCustom(e.target.value)}
                  placeholder="🐌"
                />
                <Button
                  variant="primary"
                  disabled={!custom.trim() || /^https?:\/\//i.test(custom.trim())}
                  onClick={() => pick(custom.trim())}
                >
                  Set
                </Button>
              </div>
            </Field>
          </>
        )}
      </div>

      <div className="flex justify-between items-center mt-4">
        <span className="text-xs text-ink-400">{fallbackNote}</span>
        {current && (
          <Button variant="ghost" onClick={() => pick("")}>
            Reset to default
          </Button>
        )}
      </div>
        </div>

        {officialArtwork && (
          <IconImportPanel
            group={iconGroup ?? ""}
            entryName={imageSearchSeed}
            onSaved={(icon: string) => pick(icon)}
          />
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
  const catalog = useDraftsStore((s) => s.catalog);
  const icons = catalogLegacyIconValues(catalog);
  const catalogIndex = useCatalogIndex();
  const projectDir = useProjectStore((state) => state.dir);
  const imagesDirOverride = useProjectStore((state) => state.local?.imagesDir) ?? "";
  const modsDir = useProjectStore((state) => state.local?.modsDir)?.trim() ?? "";
  const [extracting, setExtracting] = useState(false);
  const current = assignedIconKey(catalog, bpPath) ?? icons[normalizeBpPath(bpPath)] ?? "";
  // An imported icon is filed under the source that owns the entry, so the
  // images folder groups the same way the catalog does.
  const ownerSource = catalogIndex[kind].get(normalizeBpPath(bpPath))?.source;
  const owner = ownerSource?.name ?? "";
  const discovery = ownerSource?.discovery;
  const canExtract = Boolean(
    projectDir &&
    modsDir &&
    ownerSource?.kind === "mod" &&
    /^\d+$/.test(ownerSource.curseforgeId) &&
    discovery?.fileId,
  );

  if (extracting && canExtract && projectDir && ownerSource && discovery) {
    return (
      <TexturePickerModal
        modDir={modFolderPath(modsDir, ownerSource.curseforgeId, discovery.fileId)}
        modName={ownerSource.name}
        entryName={name}
        onClose={() => setExtracting(false)}
        onPick={async (texture: ModTexture, pngB64: string, invert: boolean) => {
          const relative = await writeProjectIcon(
            projectDir,
            imagesDirOverride,
            iconFileStem(discovery.shortName || ownerSource.name, name),
            pngB64,
            invert,
          );
          assign(bpPath, `file:${relative}`);
          toast.success(`${texture.name} saved as project-custom artwork`);
        }}
      />
    );
  }

  return (
    <IconChooserModal
      title={`Icon for ${name}`}
      current={current}
      officialArtwork
      officialKind={kind}
      iconGroup={owner}
      imageSearchSeed={name}
      onExtractTexture={canExtract ? () => setExtracting(true) : undefined}
      onPick={(icon) => assign(bpPath, icon)}
      onClose={onClose}
      fallbackNote={
        <>
          Import or select project-owned artwork only when you control its
          publication rights. With nothing assigned, entry shows approved
          registry art or bundled placeholder.
        </>
      }
    />
  );
}

export { MAP_EMOJI_PALETTE };
