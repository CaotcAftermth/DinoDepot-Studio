import { iconBaseName, packIconFiles, type Modpack } from "../model/modpack";
import { ipc, isTauri } from "./ipc";
import type { FetchedIcon, PackIconFetchResult } from "./modpackRegistry";

const MAX_ICON_BYTES = 8 * 1024 * 1024;
const SAFE_ICON = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.(?:webp|png)$/i;

function decodeIcon(icon: FetchedIcon): Uint8Array {
  if (icon.contentB64.length > Math.ceil((MAX_ICON_BYTES * 4) / 3) + 8) {
    throw new Error(`Icon "${icon.name}" is larger than 8 MB`);
  }
  let binary: string;
  try {
    binary = atob(icon.contentB64);
  } catch {
    throw new Error(`Icon "${icon.name}" is not valid base64`);
  }
  if (binary.length === 0) throw new Error(`Icon "${icon.name}" is empty`);
  if (binary.length > MAX_ICON_BYTES) {
    throw new Error(`Icon "${icon.name}" is larger than 8 MB`);
  }
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function hasExpectedSignature(name: string, bytes: Uint8Array): boolean {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png":
      return (
        bytes.length >= 8 &&
        bytes[0] === 0x89 &&
        ascii(bytes, 1, 3) === "PNG" &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case "webp":
      return (
        bytes.length >= 12 &&
        ascii(bytes, 0, 4) === "RIFF" &&
        ascii(bytes, 8, 4) === "WEBP"
      );
    default:
      return false;
  }
}

export interface PreparedPackIcons {
  /** The same pack with unavailable/unsupported file assignments removed. */
  pack: Modpack;
  /** Valid PNG/WebP bytes safe to install. */
  icons: FetchedIcon[];
  /** Optional icon references that will use the normal fallback instead. */
  skipped: string[];
}

/**
 * Validates optional pack icons without making icon availability a condition
 * of adding the mod. Structural package errors remain fatal elsewhere; an
 * absent or malformed picture is simply omitted so the resolver falls back.
 */
export function preparePackIcons(
  pack: Modpack,
  fetched: PackIconFetchResult,
): PreparedPackIcons {
  const expected = new Map<string, string>();
  const skipped = new Set<string>();
  for (const reference of packIconFiles(pack)) {
    const name = iconBaseName(reference);
    if (reference !== name || !SAFE_ICON.test(name)) {
      skipped.add(reference);
      continue;
    }
    const key = name.toLowerCase();
    if (expected.has(key) && expected.get(key) !== name) {
      skipped.add(expected.get(key)!);
      skipped.add(name);
      expected.delete(key);
      continue;
    }
    expected.set(key, name);
  }

  const provided = new Map<string, FetchedIcon>();
  for (const icon of fetched.icons) {
    const key = icon.name.toLowerCase();
    if (!expected.has(key) || provided.has(key)) continue;
    if (icon.name !== expected.get(key) || !SAFE_ICON.test(icon.name)) {
      skipped.add(expected.get(key)!);
      continue;
    }
    try {
      const bytes = decodeIcon(icon);
      if (!hasExpectedSignature(icon.name, bytes)) {
        skipped.add(icon.name);
        continue;
      }
      provided.set(key, icon);
    } catch {
      skipped.add(icon.name);
    }
  }

  for (const [key, name] of expected) {
    if (!provided.has(key)) skipped.add(name);
  }

  const icons = Object.fromEntries(
    Object.entries(pack.icons).filter(([, value]) => {
      if (!value.startsWith("file:")) return true;
      const reference = value.slice(5);
      const name = iconBaseName(reference);
      return (
        reference === name &&
        SAFE_ICON.test(name) &&
        provided.has(name.toLowerCase())
      );
    }),
  );
  return {
    pack: { ...pack, icons },
    icons: [...provided.values()],
    skipped: [...skipped].sort((left, right) => left.localeCompare(right)),
  };
}

/** Compatibility name retained for callers that only need the valid bytes. */
export function validatePackIcons(
  pack: Modpack,
  fetched: PackIconFetchResult,
): FetchedIcon[] {
  return preparePackIcons(pack, fetched).icons;
}

/** Writes a validated set as one native filesystem transaction. */
export async function installPackIcons(
  imagesDir: string,
  pack: Modpack,
  fetched: PackIconFetchResult,
): Promise<{ written: number; pack: Modpack; skipped: string[] }> {
  const prepared = preparePackIcons(pack, fetched);
  if (prepared.icons.length === 0 || !isTauri) {
    return { written: 0, pack: prepared.pack, skipped: prepared.skipped };
  }
  if (!imagesDir.trim()) {
    throw new Error("This project has no images directory configured");
  }
  const written = await ipc<number>("write_package_icons", {
    dir: imagesDir,
    files: prepared.icons,
  });
  return { written, pack: prepared.pack, skipped: prepared.skipped };
}
