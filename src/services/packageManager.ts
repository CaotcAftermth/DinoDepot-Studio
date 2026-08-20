import {
  modpackFromPackage,
  PACKAGE_CONTENT_FORMAT,
  PACKAGE_FORMAT,
  PACKAGE_FORMAT_VERSION,
  packageAssetV3,
  packageContentAssetPaths,
  packageContentFromModpack,
  packageFile,
  packageJson,
  PackageContentSchema,
  PackageManifestSchema,
  sha256Hex,
  type PackageContent,
  type PackageAssetV3,
  type PackageManifest,
} from "../model/package";
import {
  iconBaseName,
  registryVersion,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
} from "../model/modpack";
import { ipc, isTauri } from "./ipc";
import type { PackIconFetchResult } from "./modpackRegistry";
import { registryFileUrl } from "./modpackRegistry";
import { preparePackIcons } from "./modpackInstall";
import { studioSatisfies } from "../model/studio";
import {
  packageBase64ToBytes,
  packageBytesToBase64,
  packageHttpGet,
  packageHttpText,
} from "./packageHttp";

export interface DownloadedPackageFile {
  path: string;
  bytes: Uint8Array;
  contentB64: string;
}

export interface DownloadedPackage {
  manifest: PackageManifest;
  manifestJson: string;
  manifestIntegrity: string;
  content: PackageContent;
  files: DownloadedPackageFile[];
}

export interface NormalizedLegacyModpack {
  /** Null only when a legacy identity cannot safely address managed storage. */
  downloaded: DownloadedPackage | null;
  /** Pack with unavailable icon assignments removed. */
  pack: Modpack;
  /** Icon names that will use the normal default fallback. */
  skipped: string[];
}

const SAFE_PACKAGE_ID = /^[a-z0-9][a-z0-9._-]*$/;
const SAFE_PACKAGE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function withoutFileIcons(pack: Modpack): Modpack {
  return {
    ...pack,
    icons: Object.fromEntries(
      Object.entries(pack.icons).filter(([, value]) => !value.startsWith("file:")),
    ),
  };
}

/**
 * Converts a compatibility `modpack.json` and its optional images into an
 * ordinary content-addressed package download.
 *
 * The conversion is deterministic: another machine reading the same legacy
 * bytes produces the same manifest integrity pin. Missing or malformed images
 * are omitted, while the mod content remains installable with default icons.
 */
export async function normalizeLegacyModpackPackage(
  pack: Modpack,
  fetched: PackIconFetchResult,
): Promise<NormalizedLegacyModpack> {
  const prepared = preparePackIcons(pack, fetched);
  const skipped = new Set(prepared.skipped);

  if (
    !SAFE_PACKAGE_ID.test(prepared.pack.meta.id) ||
    !SAFE_PACKAGE_VERSION.test(prepared.pack.meta.version)
  ) {
    for (const value of Object.values(prepared.pack.icons)) {
      if (value.startsWith("file:")) skipped.add(iconBaseName(value.slice(5)));
    }
    return {
      downloaded: null,
      pack: withoutFileIcons(prepared.pack),
      skipped: [...skipped].sort((left, right) => left.localeCompare(right)),
    };
  }

  try {
    const content = packageContentFromModpack(prepared.pack);
    const contentJson = packageJson(content);
    const contentBytes = new TextEncoder().encode(contentJson);
    const contentRecord = await packageFile(
      "content.json",
      contentBytes,
      "application/json",
    );
    const files: DownloadedPackageFile[] = [
      {
        path: contentRecord.path,
        bytes: contentBytes,
        contentB64: packageBytesToBase64(contentBytes),
      },
    ];
    const assets: PackageAssetV3[] = [];
    for (const icon of prepared.icons) {
      const logicalPath = `assets/${icon.name}`;
      const bytes = packageBase64ToBytes(icon.contentB64.replace(/\s/g, ""));
      const mediaType = /\.webp$/i.test(icon.name) ? "image/webp" : "image/png";
      assets.push(await packageAssetV3(logicalPath, bytes, mediaType));
      files.push({
        path: logicalPath,
        bytes,
        contentB64: packageBytesToBase64(bytes),
      });
    }

    const {
      id: packageId,
      version,
      curseforgeId,
      updatedAt,
      ...meta
    } = prepared.pack.meta;
    const manifest = PackageManifestSchema.parse({
      format: PACKAGE_FORMAT,
      formatVersion: PACKAGE_FORMAT_VERSION,
      kind: "modpack",
      packageId,
      version,
      curseforgeId,
      publishedAt: updatedAt,
      meta: { ...meta, updatedAt },
      content: contentRecord,
      assets,
    });
    const manifestJson = packageJson(manifest);
    return {
      downloaded: {
        manifest,
        manifestJson,
        manifestIntegrity: await sha256Hex(new TextEncoder().encode(manifestJson)),
        content: PackageContentSchema.parse({
          ...content,
          format: PACKAGE_CONTENT_FORMAT,
        }),
        files,
      },
      pack: prepared.pack,
      skipped: [...skipped].sort((left, right) => left.localeCompare(right)),
    };
  } catch {
    // Compatibility content that predates package identity/shape constraints
    // must remain addable. Only its package-owned images are unavailable.
    for (const value of Object.values(prepared.pack.icons)) {
      if (value.startsWith("file:")) skipped.add(iconBaseName(value.slice(5)));
    }
    return {
      downloaded: null,
      pack: withoutFileIcons(prepared.pack),
      skipped: [...skipped].sort((left, right) => left.localeCompare(right)),
    };
  }
}

export interface InstalledPackageInfo {
  kind: "modpack" | "official";
  packageId: string;
  version: string;
  path: string;
  installedAt: string;
}

interface NativePackageReadResult {
  manifestJson: string;
  contentJson: string;
  info: InstalledPackageInfo;
}

export interface InstalledPackage {
  manifest: PackageManifest;
  manifestIntegrity: string;
  content: PackageContent;
  info: InstalledPackageInfo;
}

function verifyContentAssetCoverage(
  manifest: PackageManifest,
  content: PackageContent,
): void {
  const assets = new Set(manifest.assets.map((asset) => asset.path.toLowerCase()));
  const missing = [...packageContentAssetPaths(content)].filter(
    (path) => !assets.has(path),
  );
  if (missing.length > 0) {
    throw new Error(
      `Package content references assets absent from its manifest: ${missing.join(", ")}`,
    );
  }
}

function hasPackageImageSignature(path: string, bytes: Uint8Array): boolean {
  if (/\.png$/i.test(path)) {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    /\.webp$/i.test(path) &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

async function downloadFile(
  url: string,
  expected: { path: string; sha256: string; size: number },
): Promise<DownloadedPackageFile> {
  const response = await packageHttpGet(url);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Package file "${expected.path}" returned ${response.status}`);
  }
  if (response.bytes.length !== expected.size) {
    throw new Error(`Package file "${expected.path}" has the wrong size`);
  }
  if ((await sha256Hex(response.bytes)) !== expected.sha256.toLowerCase()) {
    throw new Error(`Package file "${expected.path}" failed its integrity check`);
  }
  if (
    expected.path.startsWith("assets/") &&
    !hasPackageImageSignature(expected.path, response.bytes)
  ) {
    throw new Error(
      `Package image "${expected.path}" does not match its PNG/WebP extension`,
    );
  }
  return {
    path: expected.path,
    bytes: response.bytes,
    contentB64: packageBytesToBase64(response.bytes),
  };
}

interface ExpectedPackageIdentity {
  packageId?: string;
  version?: string;
  curseforgeId?: string;
  integrity?: string;
}

function storedAssetPath(
  manifest: PackageManifest,
  record: PackageManifest["assets"][number],
): string {
  return manifest.formatVersion === 3
    ? (record as PackageAssetV3).blob
    : record.path;
}

async function downloadPackageManifest(
  manifestUrl: string,
  expected: ExpectedPackageIdentity,
): Promise<DownloadedPackage> {
  const response = await packageHttpGet(manifestUrl);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Package manifest returned ${response.status}`);
  }
  const manifestJson = packageHttpText(response);
  const manifestIntegrity = await sha256Hex(response.bytes);
  if (
    expected.integrity &&
    expected.integrity.toLowerCase() !== manifestIntegrity
  ) {
    throw new Error("Package manifest failed the registry integrity check");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new Error("Package manifest is not valid JSON");
  }
  const parsed = PackageManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Package manifest is malformed: ${parsed.error.issues[0]?.message ?? "unknown problem"}`,
    );
  }
  const manifest = parsed.data;
  if (
    (expected.packageId && manifest.packageId !== expected.packageId) ||
    (expected.version && manifest.version !== expected.version)
  ) {
    throw new Error("Package manifest identity does not match the registry index");
  }
  if (
    expected.curseforgeId &&
    manifest.curseforgeId &&
    expected.curseforgeId.trim() !== manifest.curseforgeId.trim()
  ) {
    throw new Error("Package CurseForge ID does not match the registry index");
  }

  if (manifest.formatVersion === 3) {
    const segments = new URL(manifestUrl).pathname
      .split("/")
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    if (
      segments.at(-3) !== "versions" ||
      segments.at(-2) !== manifest.version ||
      segments.at(-1) !== "manifest.json"
    ) {
      throw new Error(
        "Package v3 manifests must remain below versions/<exact-version>/",
      );
    }
  }

  const base = new URL(".", manifestUrl);
  const packageRoot = new URL("../../", manifestUrl);
  const files = await Promise.all([
    downloadFile(new URL(manifest.content.path, base).toString(), manifest.content),
    ...manifest.assets.map((record) =>
      downloadFile(
        new URL(
          storedAssetPath(manifest, record),
          manifest.formatVersion === 3 ? packageRoot : base,
        ).toString(),
        record,
      ),
    ),
  ]);
  const contentFile = files.find((file) => file.path === manifest.content.path)!;
  let contentRaw: unknown;
  try {
    contentRaw = JSON.parse(new TextDecoder().decode(contentFile.bytes)) as unknown;
  } catch {
    throw new Error("Package content is not valid JSON");
  }
  const contentParsed = PackageContentSchema.safeParse(contentRaw);
  if (!contentParsed.success) {
    throw new Error(
      `Package content is malformed: ${contentParsed.error.issues[0]?.message ?? "unknown problem"}`,
    );
  }
  verifyContentAssetCoverage(manifest, contentParsed.data);
  return {
    manifest,
    manifestJson,
    manifestIntegrity,
    content: contentParsed.data,
    files,
  };
}

/** Downloads one exact immutable registry version and verifies every byte. */
export async function downloadRegistryPackage(
  registry: ModpackRegistry,
  entry: RegistryEntry,
  version: string,
): Promise<DownloadedPackage> {
  const exact = registryVersion(entry, version);
  if (!exact) {
    throw new Error(
      `${entry.name} version ${version} is not available as an immutable package`,
    );
  }
  if (
    exact.minStudioVersion &&
    !studioSatisfies(exact.minStudioVersion)
  ) {
    throw new Error(
      `${entry.name} version ${version} requires DinoDepot Studio ${exact.minStudioVersion} or newer`,
    );
  }
  return downloadPackageManifest(registryFileUrl(registry, exact.manifest), {
    packageId: entry.id,
    version: exact.version,
    curseforgeId: entry.curseforgeId,
    integrity: exact.integrity,
  });
}

/**
 * Downloads an exact package manifest the administrator linked directly.
 * The returned manifest hash becomes the project's immutable integrity pin.
 */
export function downloadPackageFromManifestUrl(
  manifestUrl: string,
): Promise<DownloadedPackage> {
  return downloadPackageManifest(manifestUrl, {});
}

/** Reads and verifies an ordinary offline v2 or content-addressed v3 package. */
export async function readPackageManifestFile(
  manifestPath: string,
): Promise<DownloadedPackage> {
  const manifestJson = await ipc<string>("read_text_file", {
    path: manifestPath,
  });
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestJson) as unknown;
  } catch {
    throw new Error("Package manifest is not valid JSON");
  }
  const manifest = PackageManifestSchema.parse(manifestRaw);
  const manifestIntegrity = await sha256Hex(
    new TextEncoder().encode(manifestJson),
  );
  const separator =
    manifestPath.includes("\\") && !manifestPath.includes("/") ? "\\" : "/";
  const directory = manifestPath.replace(/[/\\][^/\\]+$/, "");
  const parent = (value: string) => value.replace(/[/\\][^/\\]+$/, "");
  if (manifest.formatVersion === 3) {
    const segments = directory.split(/[/\\]/).filter(Boolean);
    if (
      segments.at(-2) !== "versions" ||
      segments.at(-1) !== manifest.version
    ) {
      throw new Error(
        "Package v3 manifests must remain below versions/<exact-version>/",
      );
    }
  }
  const packageRoot = parent(parent(directory));
  const files: DownloadedPackageFile[] = [];
  const records = [
    {
      record: manifest.content,
      storedRoot: directory,
      storedPath: manifest.content.path,
    },
    ...manifest.assets.map((record) => ({
      record,
      storedRoot: manifest.formatVersion === 3 ? packageRoot : directory,
      storedPath: storedAssetPath(manifest, record),
    })),
  ];
  for (const { record, storedRoot, storedPath } of records) {
    const contentB64 = await ipc<string>("read_file_b64", {
      path: `${storedRoot}${separator}${storedPath.replace(/\//g, separator)}`,
    });
    const bytes = packageBase64ToBytes(contentB64.replace(/\s/g, ""));
    if (
      bytes.length !== record.size ||
      (await sha256Hex(bytes)) !== record.sha256.toLowerCase()
    ) {
      throw new Error(`Package file "${record.path}" failed its integrity check`);
    }
    if (
      record.path.startsWith("assets/") &&
      !hasPackageImageSignature(record.path, bytes)
    ) {
      throw new Error(
        `Package image "${record.path}" does not match its PNG/WebP extension`,
      );
    }
    files.push({ path: record.path, bytes, contentB64 });
  }
  const contentFile = files.find(
    (file) => file.path === manifest.content.path,
  )!;
  let contentRaw: unknown;
  try {
    contentRaw = JSON.parse(new TextDecoder().decode(contentFile.bytes)) as unknown;
  } catch {
    throw new Error("Package content is not valid JSON");
  }
  const content = PackageContentSchema.parse(contentRaw);
  verifyContentAssetCoverage(manifest, content);
  return {
    manifest,
    manifestJson,
    manifestIntegrity,
    content,
    files,
  };
}

/** Commits a completely verified download to the reconstructable app library. */
export async function installDownloadedPackage(
  downloaded: DownloadedPackage,
): Promise<InstalledPackageInfo> {
  if (!isTauri) {
    return {
      kind: downloaded.manifest.kind,
      packageId: downloaded.manifest.packageId,
      version: downloaded.manifest.version,
      path: "",
      installedAt: "browser-preview",
    };
  }
  return ipc<InstalledPackageInfo>("package_library_install", {
    manifestJson: downloaded.manifestJson,
    manifestIntegrity: downloaded.manifestIntegrity,
    files: downloaded.files.map((file) => ({
      path: file.path,
      contentB64: file.contentB64,
    })),
  });
}

export async function installRegistryPackage(
  registry: ModpackRegistry,
  entry: RegistryEntry,
  version: string,
): Promise<{ downloaded: DownloadedPackage; installed: InstalledPackageInfo }> {
  const downloaded = await downloadRegistryPackage(registry, entry, version);
  const installed = await installDownloadedPackage(downloaded);
  return { downloaded, installed };
}

/** Compatibility view for applying a linked package to a materialized project. */
export function downloadedAsLegacyInstall(downloaded: DownloadedPackage): {
  pack: Modpack;
  icons: PackIconFetchResult;
} {
  const pack = modpackFromPackage(downloaded.manifest, downloaded.content);
  const assets = new Map(
    downloaded.files
      .filter((file) => file.path.startsWith("assets/"))
      .map((file) => [file.path.toLowerCase(), file]),
  );
  const icons = downloaded.manifest.assets
    .filter((record) => /\.(?:webp|png)$/i.test(record.path))
    .map((record) => ({
      name: iconBaseName(record.path),
      contentB64: assets.get(record.path.toLowerCase())!.contentB64,
    }));
  return { pack, icons: { icons, missing: [] } };
}

/**
 * Installs any supported local package folder — `modpack` or `official`.
 *
 * Same verification as a download: manifest shape and identity, per-file size
 * and SHA-256, traversal safety, and PNG/WebP file signatures. The path itself
 * is transient; it is never written into shared project JSON.
 */
export async function installLocalPackageManifest(
  manifestPath: string,
): Promise<{ downloaded: DownloadedPackage; installed: InstalledPackageInfo }> {
  const downloaded = await readPackageManifestFile(manifestPath);
  const installed = await installDownloadedPackage(downloaded);
  return { downloaded, installed };
}

/**
 * Installs the official package this build ships with, if it ships with one.
 *
 * Returns null rather than throwing when the resource is absent: a build
 * without it must still open projects and fall back to default icons.
 */
export async function installBundledOfficialPackage(
  version: string,
): Promise<InstalledPackage | null> {
  if (!isTauri) return null;
  // Installed natively: the files are already on this disk, and carrying a
  // few thousand of them through IPC as base64 — once out to be hashed, once
  // back to be written — was seconds of first-launch delay for no gain. Every
  // file is still verified against the manifest, and the manifest against the
  // project's pin, by whoever reads the installed copy back.
  const info = await ipc<InstalledPackageInfo | null>(
    "package_library_install_bundled",
    { version },
  );
  if (!info) return null;
  if (info.kind !== "official" || info.version !== version) {
    throw new Error("The bundled official package does not match its index");
  }
  return readInstalledPackage("official", info.packageId, version);
}

export async function listInstalledPackages(): Promise<InstalledPackageInfo[]> {
  return isTauri
    ? ipc<InstalledPackageInfo[]>("package_library_list")
    : [];
}

/** Reads and re-verifies an exact version from the shared package library. */
export async function readInstalledPackage(
  kind: "modpack" | "official",
  packageId: string,
  version: string,
): Promise<InstalledPackage | null> {
  if (!isTauri) return null;
  const raw = await ipc<NativePackageReadResult | null>("package_library_read", {
    kind,
    packageId,
    version,
  });
  if (!raw) return null;
  let manifestRaw: unknown;
  let contentRaw: unknown;
  try {
    manifestRaw = JSON.parse(raw.manifestJson) as unknown;
    contentRaw = JSON.parse(raw.contentJson) as unknown;
  } catch {
    throw new Error(`Installed package ${packageId}@${version} contains invalid JSON`);
  }
  const manifest = PackageManifestSchema.parse(manifestRaw);
  const content = PackageContentSchema.parse(contentRaw);
  if (
    manifest.kind !== kind ||
    manifest.packageId !== packageId ||
    manifest.version !== version
  ) {
    throw new Error(`Installed package ${packageId}@${version} has the wrong identity`);
  }
  verifyContentAssetCoverage(manifest, content);
  return {
    manifest,
    manifestIntegrity: await sha256Hex(new TextEncoder().encode(raw.manifestJson)),
    content,
    info: raw.info,
  };
}
