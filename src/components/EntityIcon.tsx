import { ReactNode, useEffect, useMemo, useState } from "react";
import { useDraftsStore, resolveImagesDir } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import { normalizeBpPath } from "../model/catalog";
import { fallbackIcon } from "../model/officialCatalog";
import { resolveCreatureBase } from "../model/creatureBase";
import { buildImageIndex, freeIconName, matchImage } from "../model/imageMatch";
import { useCatalogIndex, useCreatureNameMap } from "../stores/useCatalogIndex";
import { ipc, isTauri } from "../services/ipc";
import { pickFolder } from "../services/dialogs";
import { toast } from "./toast";
import { Button, cx, Field, Input, Modal } from "./ui";
import { useRemoteIcon } from "./useRemoteIcon";

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
  try {
    return convertFileSrc(`${imagesDir}/${relPath}`);
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
    const assigned = icons[normalizeBpPath(path)];
    if (!assigned) return null;
    if (assigned.startsWith("file:")) {
      const src = fileUrl(imagesDir, assigned.slice(5));
      return src ? { src, emoji } : null;
    }
    if (/^https?:\/\//.test(assigned)) {
      // Null until the cache has it; the emoji shows in the meantime rather
      // than a broken image, and appears for good if it never arrives.
      return { src: path === bpPath ? cachedRemote : null, emoji };
    }
    return { src: null, emoji: assigned };
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
    if (!icon) return null;
    if (icon.startsWith("file:")) return fileUrl(imagesDir, icon.slice(5));
    // A remote URL is deliberately not returned: the page cannot load one, so
    // handing it back would render a broken image. `IconValue` resolves these
    // through the cache instead.
    return null;
  };
}

/** The https URL in an icon value, if it is one. */
export function remoteUrlOf(icon: string | undefined): string | null {
  return icon && /^https?:\/\//.test(icon) ? icon : null;
}

/** Renders an icon value, falling back to a plain glyph when it isn't an image. */
export function IconValue({
  icon,
  size = 20,
  fallback = "🗺️",
  className,
}: {
  icon: string;
  size?: number;
  fallback?: string;
  className?: string;
}) {
  const src = useIconSrc()(icon);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        className={cx("inline-block rounded-sm object-contain shrink-0", className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={cx("inline-block text-center shrink-0 leading-none", className)}
      style={{ fontSize: size - 2, width: size }}
    >
      {icon || fallback}
    </span>
  );
}

/**
 * A second folder the picker can search — one mod's own icon art, kept where
 * the mod put it rather than copied into the project wholesale.
 */
export interface IconFolder {
  /** Whose folder this is, for labels and for de-duplicating file names. */
  label: string;
  /** Absolute path; empty until one has been chosen. */
  dir: string;
  onChangeDir: (dir: string) => void;
}

/** Joins with the separator the folder already uses. */
function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]$/, "")}${sep}${rel.replace(/[/\\]/g, sep)}`;
}

/** The mod-folder half of the picker. Desktop only — it reads real folders. */
function ModFolderIcons({
  folder,
  search,
  current,
  onPicked,
}: {
  folder: IconFolder;
  search: string;
  current: string;
  onPicked: (icon: string) => void;
}) {
  const imagesDir = useImagesDir();
  const imageFiles = useDraftsStore((s) => s.imageFiles);
  const refreshImages = useDraftsStore((s) => s.refreshImages);
  const [files, setFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState("");

  useEffect(() => {
    if (!folder.dir) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError("");
    ipc<string[]>("list_images", { dir: folder.dir })
      .then((names) => {
        if (!cancelled) setFiles(names);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folder.dir]);

  const matches = useMemo(() => {
    const q = search.toLowerCase().replace(/[^a-z0-9]/g, "");
    const list = q
      ? files.filter((f) =>
          f.toLowerCase().replace(/[^a-z0-9]/g, "").includes(q),
        )
      : files;
    return list.slice(0, 24);
  }, [files, search]);

  async function choose() {
    const dir = await pickFolder(`Icon folder for ${folder.label}`);
    if (dir) folder.onChangeDir(dir);
  }

  /**
   * Copies the picked image into the project's images folder and assigns that
   * copy. A `file:` icon is a path inside the images folder — pointing one at
   * a mod folder would resolve here and nowhere else, and would publish to the
   * cluster viewer as a broken image.
   */
  async function use(file: string) {
    if (!imagesDir) {
      toast.error("Set the project's images folder in Settings first");
      return;
    }
    setCopying(file);
    try {
      const contentB64 = await ipc<string>("read_file_b64", {
        path: joinPath(folder.dir, file),
      });
      const name = freeIconName(file, folder.label, imageFiles);
      await ipc("save_file_b64", {
        path: joinPath(imagesDir, name),
        contentB64,
      });
      await refreshImages();
      toast.success(`Copied ${name} into the images folder`);
      onPicked(`file:${name}`);
    } catch (e) {
      toast.error(
        `Could not copy that icon — ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setCopying("");
    }
  }

  return (
    <div className="mb-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
          From {folder.label}'s own folder
          {folder.dir ? ` (${files.length} files)` : ""}
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => void choose()}>
            {folder.dir ? "Change folder…" : "Choose folder…"}
          </Button>
          {folder.dir && (
            <Button variant="ghost" onClick={() => folder.onChangeDir("")}>
              Forget
            </Button>
          )}
        </div>
      </div>
      {!folder.dir ? (
        <p className="text-xs text-ink-400">
          Point this at the mod's icon art — an extracted mod folder, or a
          modpack's <span className="mono">icons\</span> folder. It is
          remembered for {folder.label} and searched alongside the images
          folder. Picking one copies it across.
        </p>
      ) : (
        <>
          <p className="text-xs text-ink-400 mb-2 break-all">
            Scanning <span className="mono">{folder.dir}</span> — the file you
            pick is copied into the images folder so it publishes with
            everything else.
          </p>
          {error && <p className="text-xs text-red-400 mb-2">{error}</p>}
          {loading ? (
            <p className="text-xs text-ink-400">Reading the folder…</p>
          ) : matches.length > 0 ? (
            <div className="grid grid-cols-8 gap-2">
              {matches.map((file) => (
                <button
                  key={file}
                  onClick={() => void use(file)}
                  disabled={Boolean(copying)}
                  title={file}
                  className={cx(
                    "flex flex-col items-center gap-1 p-1.5 rounded-md hover:bg-ink-700 cursor-pointer border border-transparent",
                    copying === file && "border-accent-500",
                    current === `file:${file.split(/[/\\]/).pop()}` &&
                      "border-accent-500",
                  )}
                >
                  <img
                    src={convertFileSrc(joinPath(folder.dir, file))}
                    alt={file}
                    className="w-10 h-10 object-contain"
                  />
                  <span className="text-[10px] text-ink-400 truncate w-full">
                    {file.split(/[/\\]/).pop()}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-xs text-ink-400">
              {files.length === 0
                ? "No images in that folder."
                : "No matches — clear the search to see everything."}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Icon picker over the shared icon format. Offers the images folder (so the
 * official map art can be used once it's dropped in there), a mod's own icon
 * folder when there is one, an emoji palette, and a free-text field for
 * anything else.
 */
export function IconChooserModal({
  title,
  current,
  palette = EMOJI_PALETTE,
  imageSearchSeed = "",
  folder,
  fallbackNote,
  onPick,
  onClose,
}: {
  title: string;
  current: string;
  palette?: string[];
  /** Pre-fills the image search — usually the thing being given an icon. */
  imageSearchSeed?: string;
  /** A mod's own icon folder, searched alongside the images folder. */
  folder?: IconFolder;
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
              From images folder ({imageFiles.length} files)
            </span>
            <Button variant="ghost" onClick={() => refreshImages()}>
              ↻ Refresh
            </Button>
          </div>
          <p className="text-xs text-ink-400 mb-2">
            Scanning <span className="mono">{imagesDir}</span> — change it in
            Settings.
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
                ? "No images found — set the images folder in Settings, or create an images folder inside the project folder."
                : "No matches."}
            </p>
          )}
        </div>
      )}

      {isTauri && folder && (
        <ModFolderIcons
          folder={folder}
          search={imageSearch}
          current={current}
          onPicked={pick}
        />
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
  folder,
  onClose,
}: {
  bpPath: string;
  name: string;
  kind: "creatures" | "items";
  /** The owning mod's icon folder, when the entry came from one. */
  folder?: IconFolder;
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
      folder={folder}
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
