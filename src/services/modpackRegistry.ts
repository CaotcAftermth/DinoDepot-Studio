import {
  iconBaseName,
  ModpackSchema,
  PACK_FILE,
  PACK_ICONS_DIR,
  packDirName,
  packFileName,
  packIconFiles,
  RegistryIndexSchema,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
} from "../model/modpack";

/**
 * Client for the published modpack registry.
 *
 * Reads over plain HTTPS from raw.githubusercontent.com rather than the
 * GitHub API: the registry is public, so no token is involved, and a reader
 * should never be asked to authenticate to install a mod someone else
 * catalogued. It also means this works identically in the desktop app and in
 * browser mock mode.
 */

const RAW = "https://raw.githubusercontent.com";
const API = "https://api.github.com";

/** How many packs to pull when a registry has no index to read. */
const UNINDEXED_LIMIT = 40;

function rawUrl(registry: ModpackRegistry, file: string): string {
  const path = registry.path.replace(/^\/|\/$/g, "");
  return `${RAW}/${registry.owner}/${registry.repo}/${registry.branch}/${
    path ? `${path}/` : ""
  }${file}`;
}

/** A fetch that turns HTTP and network failures into one readable message. */
async function getJson(url: string, what: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: "application/json" } });
  } catch {
    // Offline, DNS, or a blocked request — all indistinguishable from here.
    throw new Error(`Could not reach the registry. Check your connection.`);
  }
  if (res.status === 404) throw new NotFound(what);
  if (res.status === 403) {
    throw new Error(
      "GitHub rate-limited this machine. Try again in a few minutes.",
    );
  }
  if (!res.ok) throw new Error(`${what} — GitHub returned ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${what} is not valid JSON`);
  }
}

/** Distinguishable so callers can fall back rather than report an error. */
export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFound";
  }
}

export interface RegistryListing {
  packs: RegistryEntry[];
  /**
   * True when the folder had no `index.json` and the listing was assembled by
   * reading the pack files directly — slower, and capped.
   */
  unindexed: boolean;
  /** Set when the cap was hit, so the UI can say the list is partial. */
  truncated: boolean;
}

/**
 * Everything the registry publishes.
 *
 * Prefers `index.json` — one request, and it carries the search fields. Falls
 * back to listing the folder and reading each pack, so the feature works the
 * moment a maintainer drops a file in without regenerating the index.
 */
export async function fetchRegistry(
  registry: ModpackRegistry,
): Promise<RegistryListing> {
  try {
    const raw = await getJson(rawUrl(registry, "index.json"), "The registry index");
    const parsed = RegistryIndexSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error("The registry index is malformed");
    }
    return { packs: parsed.data.packs, unindexed: false, truncated: false };
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
  }

  try {
    return await fetchUnindexed(registry);
  } catch (e) {
    // Both routes failed. Say which, because "check your connection" is
    // actively misleading when the real answer is that the registry has not
    // been set up yet.
    const why = e instanceof Error ? e.message : String(e);
    throw new Error(
      `No index.json in ${registry.owner}/${registry.repo}/${registry.path}, ` +
        `and its folder could not be listed either — ${why}`,
    );
  }
}

/** Directory listing + a read of each pack, for a registry with no index. */
async function fetchUnindexed(
  registry: ModpackRegistry,
): Promise<RegistryListing> {
  const path = registry.path.replace(/^\/|\/$/g, "");
  const url = `${API}/repos/${registry.owner}/${registry.repo}/contents/${path}?ref=${registry.branch}`;
  const listing = await getJson(url, "The registry folder");
  if (!Array.isArray(listing)) throw new Error("The registry folder is not a folder");

  const files = listing
    .filter(
      (f): f is { name: string; type: string } =>
        typeof f === "object" &&
        f !== null &&
        (f as { type?: unknown }).type === "file" &&
        typeof (f as { name?: unknown }).name === "string" &&
        (f as { name: string }).name.toLowerCase().endsWith(".json") &&
        (f as { name: string }).name.toLowerCase() !== "index.json",
    )
    .map((f) => f.name);

  const truncated = files.length > UNINDEXED_LIMIT;
  const packs: RegistryEntry[] = [];
  for (const file of files.slice(0, UNINDEXED_LIMIT)) {
    try {
      const pack = await fetchPackFile(registry, file);
      packs.push({
        id: pack.meta.id,
        name: pack.meta.name,
        version: pack.meta.version,
        updatedAt: pack.meta.updatedAt,
        author: pack.meta.author,
        description: pack.meta.description,
        curseforgeId: pack.meta.curseforgeId,
        dir: "",
        file,
        creatureCount: pack.creatures.length,
        itemCount: pack.items.length,
      });
    } catch {
      // One malformed pack must not hide every other pack in the folder.
    }
  }
  return { packs, unindexed: true, truncated };
}

/** Downloads and validates one pack by file name. */
export async function fetchPackFile(
  registry: ModpackRegistry,
  file: string,
): Promise<Modpack> {
  const raw = await getJson(rawUrl(registry, file), `Modpack "${file}"`);
  const parsed = ModpackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Modpack "${file}" does not match the expected format — ${parsed.error.issues[0]?.message ?? "unknown problem"}`,
    );
  }
  return parsed.data;
}

/**
 * Downloads the pack a registry entry points at.
 *
 * Folder layout is preferred — a pack with icons cannot be one file — but the
 * flat `<id>.json` form still resolves, so packs published before icons
 * travelled keep working.
 */
export function fetchPack(
  registry: ModpackRegistry,
  entry: RegistryEntry,
): Promise<Modpack> {
  const dir = entry.dir?.trim();
  return fetchPackFile(registry, dir ? `${dir}/${PACK_FILE}` : packFileName(entry));
}

/** Where a pack's files live inside the registry folder. */
export function packDirFor(entry: RegistryEntry): string {
  return entry.dir?.trim() || "";
}

export interface FetchedIcon {
  /** Bare file name, matching the pack's `file:` icon values. */
  name: string;
  /** Base64 image bytes, ready to write into the project images folder. */
  contentB64: string;
}

/**
 * Downloads a pack's icon images.
 *
 * Failures are collected rather than thrown: a missing icon should cost that
 * one image, not the whole install — the creature still lands, just with its
 * category emoji.
 */
export async function fetchPackIcons(
  registry: ModpackRegistry,
  entry: RegistryEntry,
  pack: Modpack,
): Promise<{ icons: FetchedIcon[]; missing: string[] }> {
  const dir = packDirFor(entry);
  const wanted = packIconFiles(pack);
  if (!dir || wanted.length === 0) return { icons: [], missing: wanted };

  const icons: FetchedIcon[] = [];
  const missing: string[] = [];
  for (const name of wanted) {
    const file = iconBaseName(name);
    try {
      const res = await fetch(rawUrl(registry, `${dir}/${PACK_ICONS_DIR}/${file}`));
      if (!res.ok) {
        missing.push(file);
        continue;
      }
      const buffer = await res.arrayBuffer();
      icons.push({ name: file, contentB64: bytesToBase64(new Uint8Array(buffer)) });
    } catch {
      missing.push(file);
    }
  }
  return { icons, missing };
}

/** Chunked so a large image cannot blow the argument limit of String.fromCharCode. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Suggested folder name for a pack being published. */
export function suggestedPackDir(pack: Modpack): string {
  return packDirName(pack.meta);
}

/** Human-facing URL of the registry folder, for a "browse on GitHub" link. */
export function registryBrowseUrl(registry: ModpackRegistry): string {
  const path = registry.path.replace(/^\/|\/$/g, "");
  return `https://github.com/${registry.owner}/${registry.repo}/tree/${registry.branch}/${path}`;
}
