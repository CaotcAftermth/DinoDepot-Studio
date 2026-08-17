#!/usr/bin/env node

/**
 * Builds one content-addressed package version from a legacy-compatible
 * modpack authoring folder. Logical icon names stay in content.json while the
 * bytes are stored once under assets/sha256 and reused by every version.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const argv = process.argv.slice(2);
const dev = argv.includes("--dev");
const inputDir = argv.find((value) => !value.startsWith("--")) ?? "";
if (!inputDir) {
  throw new Error(
    "Usage: node scripts/build-package-v3.mjs [--dev] Public_Content/ModPacks/<pack-dir>",
  );
}

const repository = process.cwd();
const packDir = path.resolve(repository, inputDir);
const registryDir = path.resolve(repository, "Public_Content", "ModPacks");
const relativePackDir = path.relative(registryDir, packDir).replaceAll("\\", "/");
if (
  relativePackDir.startsWith("../") ||
  relativePackDir.includes("/") ||
  !relativePackDir
) {
  throw new Error("The pack directory must be directly below Public_Content/ModPacks");
}

const pack = JSON.parse(await readFile(path.join(packDir, "modpack.json"), "utf8"));
const packageId = String(pack.meta?.id ?? "");
const version = String(pack.meta?.version ?? "");
if (!/^[a-z0-9][a-z0-9._-]*$/.test(packageId)) {
  throw new Error(`Unsafe package id: ${packageId}`);
}
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
  throw new Error(`Unsafe package version: ${version}`);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const basename = (value) => value.split(/[\\/]/).at(-1) ?? value;
const mediaType = (file) =>
  file.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
const blobPath = (hash, file) => {
  const extension = path.extname(file).slice(1).toLowerCase();
  return `assets/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
};

const packageRoot = dev
  ? path.join(repository, "dev-packages", packageId)
  : packDir;
const versionDir = path.join(packageRoot, "versions", version);
await mkdir(versionDir, { recursive: true });

async function writeImmutable(file, bytes) {
  try {
    const existing = await readFile(file);
    if (!existing.equals(Buffer.from(bytes))) {
      throw new Error(`Immutable package file already exists with different bytes: ${file}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

const referencedAssets = [
  ...new Set(
    Object.values(pack.icons ?? {})
      .filter((value) => typeof value === "string" && value.startsWith("file:"))
      .map((value) => basename(value.slice(5))),
  ),
].sort((a, b) => a.localeCompare(b));

const assets = [];
for (const name of referencedAssets) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.(webp|png)$/i.test(name)) {
    console.warn(`Skipping unsupported package icon: ${name}`);
    continue;
  }
  const candidates = [
    path.join(packDir, "icons", name),
    path.join(packDir, "Icons", name),
    path.join(packDir, name),
  ];
  let source = "";
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        source = candidate;
        break;
      }
    } catch {
      // Try the compatibility location.
    }
  }
  if (!source) {
    console.warn(`Skipping missing package icon: ${name}`);
    continue;
  }
  const bytes = await readFile(source);
  const signatureOk = /\.png$/i.test(name)
    ? bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
    : bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (!signatureOk) {
    console.warn(`Skipping malformed package icon: ${name}`);
    continue;
  }
  const hash = sha256(bytes);
  const blob = blobPath(hash, name);
  await writeImmutable(path.join(packageRoot, ...blob.split("/")), bytes);
  assets.push({
    path: `assets/${name}`,
    blob,
    sha256: hash,
    size: bytes.length,
    mediaType: mediaType(name),
  });
}

const available = new Set(assets.map((asset) => basename(asset.path).toLowerCase()));
const content = {
  format: "dinodepot.package-content",
  schemaVersion: 1,
  iniNotes: pack.iniNotes ?? "",
  iniSettings: pack.iniSettings ?? [],
  creatures: pack.creatures ?? [],
  items: pack.items ?? [],
  icons: Object.fromEntries(
    Object.entries(pack.icons ?? {}).flatMap(([key, value]) => {
      if (typeof value !== "string" || !value.startsWith("file:")) {
        return [[key, value]];
      }
      const reference = value.slice(5);
      const name = basename(reference);
      return reference === name && available.has(name.toLowerCase())
        ? [[key, `file:assets/${name}`]]
        : [];
    }),
  ),
  notes: pack.notes ?? {},
  maps: pack.maps ?? {},
  variantParents: pack.variantParents ?? {},
  itemInfo: pack.itemInfo ?? {},
  creatureInfo: pack.creatureInfo ?? {},
};
const contentBytes = Buffer.from(json(content));
await writeImmutable(path.join(versionDir, "content.json"), contentBytes);

const manifest = {
  format: "dinodepot.package",
  formatVersion: 3,
  kind: "modpack",
  packageId,
  version,
  curseforgeId: String(pack.meta?.curseforgeId ?? ""),
  publishedAt: String(pack.meta?.updatedAt ?? ""),
  meta: {
    name: String(pack.meta?.name ?? packageId),
    updatedAt: String(pack.meta?.updatedAt ?? ""),
    author: String(pack.meta?.author ?? ""),
    description: String(pack.meta?.description ?? ""),
    url: String(pack.meta?.url ?? ""),
    docsUrl: String(pack.meta?.docsUrl ?? ""),
    discordUrl: String(pack.meta?.discordUrl ?? ""),
    variantTag: String(pack.meta?.variantTag ?? ""),
  },
  content: {
    path: "content.json",
    sha256: sha256(contentBytes),
    size: contentBytes.length,
    mediaType: "application/json",
  },
  assets,
};
const manifestBytes = Buffer.from(json(manifest));
await writeImmutable(path.join(versionDir, "manifest.json"), manifestBytes);

if (dev) {
  console.log(`Built development ${packageId}@${version}`);
  console.log(`Install it from: ${path.join(versionDir, "manifest.json")}`);
  process.exit(0);
}

const indexPath = path.join(registryDir, "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
index.formatVersion = Math.max(3, Number(index.formatVersion ?? 1));
const entry = index.packs.find((candidate) => candidate.id === packageId);
if (!entry) throw new Error(`Registry index has no row for ${packageId}`);
entry.name = String(pack.meta?.name ?? entry.name ?? packageId);
entry.version = version;
entry.updatedAt = String(pack.meta?.updatedAt ?? "");
entry.author = String(pack.meta?.author ?? "");
entry.description = String(pack.meta?.description ?? "");
entry.curseforgeId = String(pack.meta?.curseforgeId ?? "");
entry.creatureCount = (pack.creatures ?? []).length;
entry.itemCount = (pack.items ?? []).length;
entry.versions = (entry.versions ?? []).filter(
  (candidate) => candidate.version !== version,
);
entry.versions.push({
  version,
  manifest: `${relativePackDir}/versions/${version}/manifest.json`,
  integrity: sha256(manifestBytes),
  publishedAt: String(pack.meta?.updatedAt ?? ""),
  packageFormat: 3,
  minStudioVersion: "0.4.0",
});
entry.versions.sort((a, b) =>
  a.version.localeCompare(b.version, undefined, { numeric: true }),
);
await writeFile(indexPath, json(index));

console.log(`Built ${packageId}@${version} with ${assets.length} logical assets`);
