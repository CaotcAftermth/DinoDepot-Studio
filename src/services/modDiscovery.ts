import {
  discoverMod,
  parseModFolderName,
  parseUplugin,
  type DiscoveredMod,
  type RawModFiles,
} from "../model/modDiscovery";
import { ipc, isTauri } from "./ipc";

/**
 * Talking to the installed game files.
 *
 * Deliberately two round trips: listing every installed mod is cheap and gives
 * the review screen something to show at once, while the manifests behind them
 * run to tens of megabytes across a full install and are only worth reading for
 * the mods an admin actually picks.
 */

/** What the Rust side hands back for each installed mod folder. */
interface InstalledModRaw {
  folderName: string;
  shortName: string;
  uplugin: string;
  hasManifest: boolean;
}

export interface InstalledModSummary {
  folderName: string;
  projectId: string;
  /** CurseForge file id - changes when the mod updates. */
  fileId: string;
  shortName: string;
  name: string;
  category: string;
  url: string;
  /** False when the mod ships no manifest, which makes it undiscoverable. */
  hasManifest: boolean;
  /**
   * On the project's Custom Cosmetic Mod list.
   *
   * Cosmetics are already handled by the collector and add nothing a production
   * rule can reference, so the review screen hides them by default. This is the
   * project's own list rather than a guess - nothing in a mod's files reliably
   * distinguishes a cosmetic from a gameplay mod.
   */
  cosmetic: boolean;
}

/** Derives the display row for one installed mod. Pure, so it can be tested. */
export function summarizeInstalledMod(
  raw: InstalledModRaw,
  cosmeticModIds: ReadonlySet<string>,
): InstalledModSummary {
  const folder = parseModFolderName(raw.folderName);
  const meta = parseUplugin(raw.uplugin);
  const projectId = folder?.projectId ?? meta.cfUgcId;
  return {
    folderName: raw.folderName,
    projectId,
    fileId: folder?.fileId ?? "",
    shortName: raw.shortName,
    name: meta.friendlyName.trim() || raw.shortName,
    category: meta.category,
    url: meta.marketplaceUrl,
    hasManifest: raw.hasManifest,
    cosmetic: Boolean(projectId) && cosmeticModIds.has(projectId),
  };
}

const DESKTOP_ONLY =
  "Reading installed mods is only available in the desktop app";

/**
 * Finds the mods folder from whatever path the admin supplied - the game's
 * install root, or the mods folder itself.
 */
export async function resolveModsRoot(dir: string): Promise<string> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  return ipc<string>("resolve_mods_root", { dir });
}

/** Every mod installed under the mods root, cheapest read first. */
export async function listInstalledMods(
  root: string,
  cosmeticModIds: ReadonlySet<string> = new Set(),
): Promise<InstalledModSummary[]> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  const raw = await ipc<InstalledModRaw[]>("list_installed_mods", { root });
  return raw
    .map((mod) => summarizeInstalledMod(mod, cosmeticModIds))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Reads and catalogues the selected mods.
 *
 * `newId` is threaded through from the caller so entry ids come from the same
 * place as the rest of the app's.
 */
export async function discoverInstalledMods(
  root: string,
  folderNames: string[],
  newId: () => string,
): Promise<DiscoveredMod[]> {
  if (!isTauri) throw new Error(DESKTOP_ONLY);
  if (folderNames.length === 0) return [];
  const raw = await ipc<RawModFiles[]>("read_installed_mods", {
    root,
    folderNames,
  });
  return raw.map((files) => discoverMod(files, newId));
}
