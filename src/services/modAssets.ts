import { ipc, isTauri } from "./ipc";

/**
 * Artwork read out of a mod already installed on this machine.
 *
 * Discovery catalogues a mod's creatures and items from its manifest, which is
 * plain text and says nothing about what any asset *is*. Icons need the real
 * containers opened, which is what the asset sidecar does. Matching icons to
 * entries automatically does not work - measured across the local corpus, only
 * 5.5% of items have a name-matching icon - so the administrator picks, and
 * these functions are what a picker is built on.
 */

export interface ModTexture {
  /** Container-relative asset path; the handle an export takes. */
  path: string;
  name: string;
  width: number;
  height: number;
}

/** The installed mod folder for a discovered mod, `<root>/<project>_<file>`. */
export function modFolderPath(
  modsRoot: string,
  projectId: string,
  fileId: string,
): string {
  const root = modsRoot.replace(/[/\\]+$/, "");
  return `${root}/${projectId}_${fileId}`;
}

/**
 * Every texture one mod carries, without decoding any of them.
 *
 * Seconds, not instant: the largest mod on the test corpus - 3,294 assets -
 * takes about 7 seconds, a small one about one. Worth caching per mod for as
 * long as a picker is open.
 */
export async function listModTextures(modDir: string): Promise<ModTexture[]> {
  if (!isTauri) return [];
  return ipc<ModTexture[]>("mod_textures", { modDir, gamePaksDir: "" });
}

/** One texture, decoded, as base64 PNG. */
export async function modTexturePng(
  modDir: string,
  assetPath: string,
): Promise<string> {
  if (!isTauri) throw new Error("Reading mod artwork only works in the desktop app");
  return ipc<string>("mod_texture_png", {
    modDir,
    gamePaksDir: "",
    assetPath,
  });
}

/**
 * Writes an image into the project as a 160x160 lossless WebP.
 *
 * Returns the file name, which is what a `file:` icon stores. The conversion
 * lives in the backend so the rule holds however the image was obtained - a
 * mod texture, a file on disk, anything later.
 */
export async function writeProjectIcon(
  projectDir: string,
  imagesDirOverride: string,
  fileStem: string,
  pngB64: string,
  invert = false,
): Promise<string> {
  if (!isTauri) throw new Error("Saving an icon only works in the desktop app");
  return ipc<string>("project_icon_write", {
    projectDir,
    imagesDirOverride,
    fileStem,
    imageB64: pngB64,
    invert,
  });
}

/**
 * Where an entry's icon is filed inside the project images folder.
 *
 * Grouped one level deep by the mod it came from - `AAHelicoprion/Rex` - so a
 * project that has assigned a few hundred icons stays navigable, and two mods
 * both shipping a "Rex" cannot overwrite each other. Anything the filesystem
 * dislikes is replaced rather than dropped, so two distinct names cannot
 * collapse into one.
 */
export function iconFileStem(group: string, entryName: string): string {
  const clean = (value: string) =>
    value
      .trim()
      .replace(/[^A-Za-z0-9 _-]+/g, "_")
      .replace(/\s+/g, " ")
      .slice(0, 60)
      .replace(/^\.+/, "")
      .trim();
  const folder = clean(group);
  const file = clean(entryName) || "icon";
  return folder ? `${folder}/${file}` : file;
}

/**
 * Words that mark a texture as part of a material rather than a picture of
 * something.
 *
 * A mod's art is overwhelmingly these: for every icon there are a dozen
 * 4096x4096 surfaces feeding a shader. Excluding them by default is the
 * difference between a list somebody can read and one they have to dig
 * through - but which words those are is a judgement about how mod authors
 * happen to name things, so the list is a starting point the administrator
 * edits rather than a rule.
 */
export const DEFAULT_MATERIAL_KEYWORDS: readonly string[] = [
  "ao",
  "alpha",
  "basecolor",
  "bump",
  "cavity",
  "colorize",
  "curvature",
  "diffuse",
  "disp",
  "displacement",
  "emissive",
  "gloss",
  "gradient",
  "height",
  "lut",
  "mask",
  "metal",
  "metallic",
  "mrao",
  "noise",
  "normal",
  "occlusion",
  "opacity",
  "orm",
  "packed",
  "rough",
  "roughness",
  "spec",
  "specular",
  "subsurface",
  "translucency",
];

/** Below this length a keyword is only matched as a whole word. */
const TOKEN_ONLY_LENGTH = 6;

/** `T_Rex_BaseColor` becomes ["t","rex","base","color"]. */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
}

/**
 * Whether one keyword marks this texture.
 *
 * Short keywords match whole words only. `ao` as a substring would hit
 * "Chaos", and `metal` would hit "Metalwork" - hiding art somebody wanted is
 * worse than showing a surface map they can skip past.
 */
export function matchesKeyword(name: string, keyword: string): boolean {
  const needle = keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!needle) return false;
  if (needle.length >= TOKEN_ONLY_LENGTH) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(needle);
  }
  return nameTokens(name).includes(needle);
}

/**
 * Names that say outright what they are, whatever else they contain.
 *
 * Real example from the corpus: `Icon_COLORIZE_V2_Scifi` is a 256x256 icon
 * that the "colorize" keyword would otherwise hide. An author who put "icon"
 * in the name has already answered the question the keywords are guessing at.
 */
const ICON_MARKERS = ["icon", "hud"];

export function isMaterialMap(
  name: string,
  keywords: readonly string[] = DEFAULT_MATERIAL_KEYWORDS,
): boolean {
  const tokens = nameTokens(name);
  if (
    ICON_MARKERS.some(
      (marker) =>
        tokens.includes(marker) ||
        tokens.some((token) => token.includes(marker)),
    )
  ) {
    return false;
  }
  return keywords.some((keyword) => matchesKeyword(name, keyword));
}

export interface TextureFilter {
  query: string;
  /** Keywords currently ticked. Empty shows everything. */
  excluded: readonly string[];
}

/**
 * The list a picker shows: excluded keywords dropped, search applied, then
 * ordered so the plausible icons are at the top.
 *
 * Pure and separate from the component so the ordering can be argued about in
 * a test rather than by scrolling a modal.
 */
export function rankTextures(
  textures: ModTexture[],
  { query, excluded }: TextureFilter,
): ModTexture[] {
  const q = query.trim().toLowerCase();
  const score = (texture: ModTexture) =>
    (/icon/i.test(texture.name) ? 0 : 1) +
    (texture.width <= 512 && texture.height <= 512 ? 0 : 2);

  // Deduplicated by path first. The list is rendered keyed by path, and React
  // does not define what a list with repeated keys does on re-render - the
  // observed symptom was a search box that filtered nothing, because the
  // rendered rows never reconciled.
  const distinct = [...new Map(textures.map((t) => [t.path, t])).values()];

  return distinct
    .filter((texture) => !isMaterialMap(texture.name, excluded))
    .filter(
      (texture) =>
        !q ||
        texture.name.toLowerCase().includes(q) ||
        texture.path.toLowerCase().includes(q),
    )
    .sort(
      (left, right) =>
        score(left) - score(right) || left.name.localeCompare(right.name),
    );
}

/**
 * The keyword list this machine uses, kept between sessions.
 *
 * A UI preference rather than project data: it describes how one
 * administrator likes to sift textures, and syncing it between two people
 * editing the same cluster would be meddling.
 */
const KEYWORDS_KEY = "ddstudio.textureKeywords";

export function loadMaterialKeywords(): string[] {
  try {
    const saved = localStorage.getItem(KEYWORDS_KEY);
    if (!saved) return [...DEFAULT_MATERIAL_KEYWORDS];
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return [...DEFAULT_MATERIAL_KEYWORDS];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [...DEFAULT_MATERIAL_KEYWORDS];
  }
}

export function saveMaterialKeywords(keywords: readonly string[]): void {
  try {
    localStorage.setItem(KEYWORDS_KEY, JSON.stringify([...keywords]));
  } catch {
    // A browser with storage disabled still gets the defaults every time.
  }
}
