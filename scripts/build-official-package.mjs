#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = process.cwd();
const sourceRoot = path.join(repository, "Public_Content", "Official_Icons");
const catalogPath = path.join(repository, "src", "assets", "catalog", "official-asa.json");
const metadata = JSON.parse(await readFile(path.join(sourceRoot, "official.json"), "utf8"));
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const version = String(metadata.version ?? "");
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) {
  throw new Error(`Unsafe official package version: ${version}`);
}

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const normalizedName = (value) => value.toLowerCase().replace(/\.[^.]+$/, "").replace(/[^a-z0-9]/g, "");
const mediaType = (file) => file.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";

function validImage(file, bytes) {
  if (/\.png$/i.test(file)) return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (/\.webp$/i.test(file)) {
    return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

async function imageFiles(folder) {
  const root = path.join(sourceRoot, folder);
  const found = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (/\.(?:webp|png)$/i.test(entry.name)) {
        found.push(path.relative(sourceRoot, absolute).replaceAll("\\", "/"));
      }
    }
  }
  await walk(root);
  return found;
}

const relativeImages = (
  await Promise.all(["creatures", "items", "maps"].map(imageFiles))
).flat().sort((a, b) => {
  const aBase = a.replace(/\.(?:webp|png)$/i, "").toLowerCase();
  const bBase = b.replace(/\.(?:webp|png)$/i, "").toLowerCase();
  if (aBase === bBase) {
    return Number(/\.png$/i.test(a)) - Number(/\.png$/i.test(b));
  }
  return a.localeCompare(b);
});

const byKind = { creatures: new Map(), items: new Map() };
for (const kind of ["creatures", "items"]) {
  for (const file of relativeImages.filter((candidate) => candidate.startsWith(`${kind}/`))) {
    const stem = file.split("/").at(-1) ?? file;
    const keys = new Set([
      normalizedName(stem),
      normalizedName(stem.replace(/\s*\([^)]*\)(?=\.[^.]+$)/, "")),
    ]);
    for (const key of keys) {
      if (key && !byKind[kind].has(key)) byKind[kind].set(key, file);
    }
  }
}

const icons = {};
for (const kind of ["creatures", "items"]) {
  for (const entry of catalog[kind] ?? []) {
    const file = byKind[kind].get(normalizedName(String(entry.name ?? "")));
    if (file) icons[String(entry.bpPath)] = `file:assets/${file}`;
  }
}

const content = {
  format: "dinodepot.package-content",
  schemaVersion: 1,
  iniNotes: "",
  iniSettings: [],
  creatures: [],
  items: [],
  icons,
  notes: {},
  maps: {},
  variantParents: {},
  itemInfo: {},
  creatureInfo: {},
};

const versionRoot = path.join(sourceRoot, "versions", version);
const assetsRoot = path.join(versionRoot, "assets");
await mkdir(assetsRoot, { recursive: true });

async function writeImmutable(file, bytes) {
  try {
    const existing = await readFile(file);
    if (!existing.equals(Buffer.from(bytes))) {
      throw new Error(`Immutable official package file already exists with different bytes: ${file}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}

const contentBytes = Buffer.from(json(content));
await writeImmutable(path.join(versionRoot, "content.json"), contentBytes);

const assets = [];
for (const relative of relativeImages) {
  const bytes = await readFile(path.join(sourceRoot, relative));
  if (!validImage(relative, bytes)) throw new Error(`${relative} does not match its PNG/WebP extension`);
  await writeImmutable(path.join(assetsRoot, relative), bytes);
  assets.push({
    path: `assets/${relative}`,
    sha256: sha256(bytes),
    size: bytes.length,
    mediaType: mediaType(relative),
  });
}

const manifest = {
  format: "dinodepot.package",
  formatVersion: 2,
  kind: "official",
  packageId: "official-asa",
  version,
  curseforgeId: "",
  publishedAt: String(metadata.publishedAt ?? ""),
  meta: {
    name: String(metadata.name ?? "Official ASA Core Content"),
    updatedAt: String(metadata.publishedAt ?? ""),
    author: String(metadata.author ?? "DinoDepot Studio"),
    description: String(metadata.description ?? ""),
    url: "",
    docsUrl: "",
    discordUrl: "",
    variantTag: "",
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
await writeImmutable(path.join(versionRoot, "manifest.json"), manifestBytes);

const indexPath = path.join(sourceRoot, "index.json");
let existing = { formatVersion: 1, package: { versions: [] } };
try {
  existing = JSON.parse(await readFile(indexPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
const versions = (existing.package?.versions ?? []).filter((entry) => entry.version !== version);
versions.push({
  version,
  manifest: `versions/${version}/manifest.json`,
  integrity: sha256(manifestBytes),
  publishedAt: String(metadata.publishedAt ?? ""),
});
versions.sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
await writeFile(indexPath, json({
  formatVersion: 1,
  package: {
    id: "official-asa",
    name: String(metadata.name ?? "Official ASA Core Content"),
    version,
    manifest: `versions/${version}/manifest.json`,
    integrity: sha256(manifestBytes),
    publishedAt: String(metadata.publishedAt ?? ""),
    versions,
  },
}));

console.log(`Built official-asa@${version} with ${Object.keys(icons).length} matched icons and ${assets.length} assets`);
