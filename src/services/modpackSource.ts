import {
  iconBaseName,
  ModpackSchema,
  PACK_FILE,
  PACK_ICONS_DIR,
  packIconFiles,
  type Modpack,
  type ModpackRegistry,
} from "../model/modpack";
import { ipc } from "./ipc";
import type { FetchedIcon } from "./modpackRegistry";

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
  icons: () => Promise<FetchedIcon[]>;
}

const RAW = "https://raw.githubusercontent.com";

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
    const github = trimmed.match(
      /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)$/i,
    );
    if (github) {
      const [, owner, repo, branch, path] = github;
      base = `${RAW}/${owner}/${repo}/${branch}/${path}`;
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

  let res: Response;
  try {
    res = await fetch(packUrl, { headers: { Accept: "application/json" } });
  } catch {
    throw new Error(`Could not reach ${packUrl}. Check the link and your connection.`);
  }
  if (res.status === 404) {
    throw new Error(
      `Nothing at ${packUrl} — link the pack's folder, or its ${PACK_FILE} directly.`,
    );
  }
  if (!res.ok) throw new Error(`${packUrl} returned ${res.status}`);

  let raw: unknown;
  try {
    raw = await res.json();
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
): Promise<FetchedIcon[]> {
  const icons: FetchedIcon[] = [];
  for (const wanted of packIconFiles(pack)) {
    const name = iconBaseName(wanted);
    try {
      const res = await fetch(`${base}/${encodeURIComponent(name)}`);
      if (!res.ok) continue;
      const buffer = await res.arrayBuffer();
      icons.push({ name, contentB64: bytesToBase64(new Uint8Array(buffer)) });
    } catch {
      /* keep going — the pack is worth more than one icon */
    }
  }
  return icons;
}

/**
 * Icon images beside a pack file: in its `icons/` folder, or failing that
 * loose next to it, which is how a hand-assembled pack usually arrives.
 */
async function readIconsBeside(dir: string, pack: Modpack): Promise<FetchedIcon[]> {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  const icons: FetchedIcon[] = [];
  for (const wanted of packIconFiles(pack)) {
    const name = iconBaseName(wanted);
    for (const folder of [`${dir}${sep}${PACK_ICONS_DIR}`, dir]) {
      try {
        const contentB64 = await ipc<string>("read_file_b64", {
          path: `${folder}${sep}${name}`,
        });
        icons.push({ name, contentB64 });
        break;
      } catch {
        /* try the next place it could reasonably be */
      }
    }
  }
  return icons;
}

/** Chunked so a large image cannot blow the argument limit of fromCharCode. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
