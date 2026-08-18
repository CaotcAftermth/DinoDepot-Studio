import {
  iconBaseName,
  ModpackSchema,
  PACK_FILE,
  PACK_ICONS_DIR,
  packIconFiles,
  RegistryEntrySchema,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
  type RegistryVersion,
} from "../model/modpack";
import { ipc } from "./ipc";
import type { FetchedIcon, PackIconFetchResult } from "./modpackRegistry";
import {
  packageBytesToBase64,
  packageHttpGet,
  packageHttpText,
} from "./packageHttp";
import {
  downloadPackageFromManifestUrl,
  readPackageManifestFile,
  type DownloadedPackage,
} from "./packageManager";
import { PackageManifestSchema } from "../model/package";

/**
 * Getting a pack into the project from somewhere other than the search list.
 *
 * The registry search only knows what `index.json` lists, and browsing the
 * registry on GitHub — which is the thing the Browse button does — leaves an
 * admin holding a link to a pack the app could not otherwise install. A pull
 * request under review, a fork, a pack a mod author sent over: all of them are
 * a URL or a file, and both end up here.
 */

export interface PackSource {
  pack: Modpack;
  /** Where it came from, for the confirmation line. */
  from: string;
  /** Icon images, fetched only once the admin commits to installing. */
  icons: () => Promise<PackIconFetchResult>;
}

const RAW = "https://raw.githubusercontent.com";

function githubPageToRaw(
  input: string,
  registry: ModpackRegistry,
): string | null {
  const github = input.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/(.+)$/i,
  );
  if (!github) return null;
  const [, owner, repo, refAndPath] = github;
  const registryPath = registry.path.replace(/^\/|\/$/g, "");
  const marker = registryPath ? `/${registryPath}/` : "";
  const markerIndex = marker
    ? refAndPath.toLowerCase().indexOf(marker.toLowerCase())
    : -1;
  let branch: string;
  let path: string;
  if (markerIndex > 0) {
    // GitHub does not delimit a branch containing `/` from the file path. The
    // configured registry root is the stable boundary that makes PR branches
    // such as `modpack/987274-v2` unambiguous.
    branch = refAndPath.slice(0, markerIndex);
    path = refAndPath.slice(markerIndex + 1);
  } else {
    const slash = refAndPath.indexOf("/");
    if (slash < 1) return null;
    branch = refAndPath.slice(0, slash);
    path = refAndPath.slice(slash + 1);
  }
  return `${RAW}/${owner}/${repo}/${branch}/${path}`;
}

export interface LinkedPackageSource {
  downloaded: DownloadedPackage;
  entry: RegistryEntry;
  exact: RegistryVersion;
  /** Portable fallback for a package linked outside the configured index. */
  manifestUrl?: string;
  /** Offline folder: exact locally, but another machine needs the same folder. */
  localOnly?: boolean;
  /** Package manifest or legacy JSON on this machine. Machine-local only. */
  localSourcePath?: string;
  /** Compatibility JSON used to deterministically reconstruct this package. */
  legacyUrl?: string;
  /** True when the machine-local source is compatibility JSON, not a manifest. */
  legacyLocal?: boolean;
}

/**
 * Resolves only links that unambiguously name an immutable package manifest.
 * Compatibility-pack folders continue through `resolvePackUrls` unchanged.
 */
export function resolvePackageManifestUrl(
  input: string,
  registry: ModpackRegistry,
): string | null {
  const trimmed = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!trimmed) return null;

  let base: string;
  if (/^https?:\/\//i.test(trimmed)) {
    base = githubPageToRaw(trimmed, registry) ?? trimmed;
  } else {
    const path = registry.path.replace(/^\/|\/$/g, "");
    base = `${RAW}/${registry.owner}/${registry.repo}/${registry.branch}/${
      path ? `${path}/` : ""
    }${trimmed.replace(/^\/+/, "")}`;
  }

  if (/\/manifest\.json$/i.test(base)) return base;
  if (/\/versions\/[^/]+$/i.test(base)) return `${base}/manifest.json`;
  return null;
}

/** Reads a directly linked immutable package and creates its exact index row. */
export async function linkedPackageFromUrl(
  input: string,
  registry: ModpackRegistry,
): Promise<LinkedPackageSource | null> {
  const manifestUrl = resolvePackageManifestUrl(input, registry);
  if (!manifestUrl) return null;
  const downloaded = await downloadPackageFromManifestUrl(manifestUrl);
  if (downloaded.manifest.kind !== "modpack") {
    throw new Error("That manifest is an official package, not a modpack");
  }
  return linkedPackageFromDownloaded(downloaded, { manifestUrl });
}

export function linkedPackageFromDownloaded(
  downloaded: DownloadedPackage,
  locator: {
    manifestUrl?: string;
    localOnly?: boolean;
    localSourcePath?: string;
    legacyUrl?: string;
    legacyLocal?: boolean;
  },
): LinkedPackageSource {
  const exact: RegistryVersion = {
    version: downloaded.manifest.version,
    manifest: locator.manifestUrl ?? "manifest.json",
    integrity: downloaded.manifestIntegrity,
    publishedAt: downloaded.manifest.publishedAt,
  };
  const entry = RegistryEntrySchema.parse({
    id: downloaded.manifest.packageId,
    name: downloaded.manifest.meta.name,
    version: downloaded.manifest.version,
    updatedAt: downloaded.manifest.meta.updatedAt,
    author: downloaded.manifest.meta.author,
    description: downloaded.manifest.meta.description,
    curseforgeId: downloaded.manifest.curseforgeId,
    creatureCount: downloaded.content.creatures.length,
    itemCount: downloaded.content.items.length,
    versions: [exact],
  });
  return { downloaded, entry, exact, ...locator };
}

/**
 * Recognizes and verifies a local v2 manifest of either kind; v1 JSON
 * returns null so the compatibility reader can take it.
 *
 * Both kinds are accepted so a locally built official package can be tested
 * without a GitHub round trip. The kind is preserved on the dependency, and
 * the folder is reported separately for machine-local state — it must not
 * reach shared project JSON.
 */
export async function localPackageFromFile(
  path: string,
): Promise<LinkedPackageSource | null> {
  const text = await ipc<string>("read_text_file", { path });
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!PackageManifestSchema.safeParse(raw).success) return null;
  const downloaded = await readPackageManifestFile(path);
  return linkedPackageFromDownloaded(downloaded, {
    localOnly: true,
    localSourcePath: path,
  });
}

/** The modpack-only view of `localPackageFromFile`, for the modpack UI. */
export async function linkedPackageFromFile(
  path: string,
): Promise<LinkedPackageSource | null> {
  const source = await localPackageFromFile(path);
  if (source && source.downloaded.manifest.kind !== "modpack") {
    throw new Error("That manifest is an official package, not a modpack");
  }
  return source;
}

/**
 * The raw URLs a pasted GitHub link points at.
 *
 * Anything a browser address bar can hold is accepted, because that is what
 * people paste: a folder listing, the file itself, a raw link, or just the
 * folder name inside the configured registry.
 */
export function resolvePackUrls(
  input: string,
  registry: ModpackRegistry,
): { packUrl: string; iconsBase: string } {
  const trimmed = input.trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!trimmed) throw new Error("Paste a link to a modpack first");

  let base: string;
  if (/^https?:\/\//i.test(trimmed)) {
    const github = githubPageToRaw(trimmed, registry);
    if (github) {
      base = github;
    } else if (/^https?:\/\/(?:www\.)?github\.com\//i.test(trimmed)) {
      throw new Error(
        "That is a GitHub page rather than a pack — open the pack's folder or its modpack.json and copy that link",
      );
    } else {
      base = trimmed;
    }
  } else {
    // A bare name means "inside the registry this project is pointed at".
    const path = registry.path.replace(/^\/|\/$/g, "");
    base = `${RAW}/${registry.owner}/${registry.repo}/${registry.branch}/${
      path ? `${path}/` : ""
    }${trimmed.replace(/^\/+/, "")}`;
  }

  if (/\.json$/i.test(base)) {
    const dir = base.replace(/\/[^/]+$/, "");
    return { packUrl: base, iconsBase: `${dir}/${PACK_ICONS_DIR}` };
  }
  return {
    packUrl: `${base}/${PACK_FILE}`,
    iconsBase: `${base}/${PACK_ICONS_DIR}`,
  };
}

/** Reads and validates a pack at a URL, wherever the link came from. */
export async function packFromUrl(
  input: string,
  registry: ModpackRegistry,
): Promise<PackSource> {
  const { packUrl, iconsBase } = resolvePackUrls(input, registry);

  let res: Awaited<ReturnType<typeof packageHttpGet>>;
  try {
    res = await packageHttpGet(packUrl);
  } catch {
    throw new Error(`Could not reach ${packUrl}. Check the link and your connection.`);
  }
  if (res.status === 404) {
    throw new Error(
      `Nothing at ${packUrl} — link the pack's folder, or its ${PACK_FILE} directly.`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${packUrl} returned ${res.status}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(packageHttpText(res)) as unknown;
  } catch {
    throw new Error(`${packUrl} is not JSON — that link is not a modpack.`);
  }
  const pack = parsePack(raw, packUrl);
  return {
    pack,
    from: packUrl,
    icons: () => fetchIconsFrom(iconsBase, pack),
  };
}

/** Reads and validates a pack from a file on this machine. */
export async function packFromFile(path: string): Promise<PackSource> {
  const text = await ipc<string>("read_text_file", { path });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("That file is not valid JSON");
  }
  const pack = parsePack(raw, path);
  const dir = path.replace(/[/\\][^/\\]+$/, "");
  return { pack, from: path, icons: () => readIconsBeside(dir, pack) };
}

function parsePack(raw: unknown, where: string): Modpack {
  const parsed = ModpackSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${where} does not match the modpack format — ${
        parsed.error.issues[0]?.message ?? "unknown problem"
      }`,
    );
  }
  return parsed.data;
}

/**
 * Icon images under a base URL. A missing icon costs that one image rather
 * than the install — the entry still lands, with its category emoji.
 */
export async function fetchIconsFrom(
  base: string,
  pack: Modpack,
): Promise<PackIconFetchResult> {
  const icons: FetchedIcon[] = [];
  const missing: string[] = [];
  for (const wanted of packIconFiles(pack)) {
    const name = iconBaseName(wanted);
    const bases = [base];
    if (/\/icons$/i.test(base)) {
      bases.push(base.replace(/\/icons$/i, "/Icons"));
    }
    let found = false;
    for (const candidate of bases) {
      try {
        const res = await packageHttpGet(
          `${candidate}/${encodeURIComponent(name)}`,
        );
        if (res.status < 200 || res.status >= 300) continue;
        icons.push({ name, contentB64: packageBytesToBase64(res.bytes) });
        found = true;
        break;
      } catch {
        /* try the compatibility spelling */
      }
    }
    if (!found) missing.push(name);
  }
  return { icons, missing };
}

/**
 * Icon images beside a pack file: in its `icons/` folder, or failing that
 * loose next to it, which is how a hand-assembled pack usually arrives.
 */
async function readIconsBeside(
  dir: string,
  pack: Modpack,
): Promise<PackIconFetchResult> {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const icons: FetchedIcon[] = [];
  const missing: string[] = [];
  for (const wanted of packIconFiles(pack)) {
    const name = iconBaseName(wanted);
    let found = false;
    for (const folder of [
      `${dir}${sep}${PACK_ICONS_DIR}`,
      `${dir}${sep}Icons`,
      dir,
    ]) {
      try {
        const contentB64 = await ipc<string>("read_file_b64", {
          path: `${folder}${sep}${name}`,
        });
        icons.push({ name, contentB64 });
        found = true;
        break;
      } catch {
        /* try the next place it could reasonably be */
      }
    }
    if (!found) missing.push(name);
  }
  return { icons, missing };
}
