#!/usr/bin/env node

throw new Error(
  "Artwork-bearing official packages are retired. Run npm run build:official-data instead.",
);

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  creatureInfoFor,
  CREATURE_VARIANT_PARENTS,
} from "./creature-info.mjs";

const repository = process.cwd();
const sourceRoot = path.join(repository, "Public_Content", "Official_Icons");
const catalogPath = path.join(repository, "src", "assets", "catalog", "official-asa.json");
const metadata = JSON.parse(await readFile(path.join(sourceRoot, "official.json"), "utf8"));
const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const assetMap = JSON.parse(await readFile(path.join(sourceRoot, "assets.json"), "utf8"));
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

if (assetMap.formatVersion !== 1 || !Array.isArray(assetMap.assets)) {
  throw new Error("Official asset map is malformed");
}
const mappedAssets = assetMap.assets.sort((a, b) => {
  const aPath = String(a.path ?? "");
  const bPath = String(b.path ?? "");
  const aBase = aPath.replace(/\.(?:webp|png)$/i, "").toLowerCase();
  const bBase = bPath.replace(/\.(?:webp|png)$/i, "").toLowerCase();
  if (aBase === bBase) {
    return Number(/\.png$/i.test(aPath)) - Number(/\.png$/i.test(bPath));
  }
  return aPath.localeCompare(bPath);
});

const byKind = { creatures: new Map(), items: new Map() };
for (const kind of ["creatures", "items"]) {
  for (const { path: file } of mappedAssets.filter((candidate) =>
    String(candidate.path ?? "").startsWith(`${kind}/`),
  )) {
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
  // Creature variants, so a variant's record can hold only what differs and
  // inherit the rest. The compiled catalog declares parents for items only.
  variantParents: CREATURE_VARIANT_PARENTS,
  itemInfo: {},
  // Imported availability, spawn, drop, and acquisition defaults. See
  // scripts/creature-info.mjs. Administrator edits win, and none of these
  // defaults land in a project file.
  creatureInfo: creatureInfoFor(catalog),
};

const versionRoot = path.join(sourceRoot, "versions", version);
await mkdir(versionRoot, { recursive: true });

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
const seenLogical = new Set();
for (const mapped of mappedAssets) {
  const relative = String(mapped.path ?? "");
  const blob = String(mapped.blob ?? "");
  const expectedHash = String(mapped.sha256 ?? "").toLowerCase();
  if (!/^(?:creatures|items|maps)\/.+\.(?:webp|png)$/i.test(relative)) {
    throw new Error(`Unsafe official logical asset path: ${relative}`);
  }
  if (!/^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png)$/.test(blob)) {
    throw new Error(`Unsafe official blob path: ${blob}`);
  }
  if (seenLogical.has(relative.toLowerCase())) {
    throw new Error(`Duplicate official logical asset path: ${relative}`);
  }
  seenLogical.add(relative.toLowerCase());
  const bytes = await readFile(path.join(sourceRoot, ...blob.split("/")));
  if (!validImage(relative, bytes)) throw new Error(`${relative} does not match its PNG/WebP extension`);
  const hash = sha256(bytes);
  if (hash !== expectedHash || !blob.includes(`/${hash.slice(0, 2)}/${hash}.`)) {
    throw new Error(`${relative} does not match its content-addressed blob`);
  }
  if (Number(mapped.size) !== bytes.length || mapped.mediaType !== mediaType(relative)) {
    throw new Error(`${relative} metadata does not match its blob`);
  }
  assets.push({
    path: `assets/${relative}`,
    blob,
    sha256: hash,
    size: bytes.length,
    mediaType: mediaType(relative),
  });
}

const manifest = {
  format: "dinodepot.package",
  formatVersion: 3,
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
  packageFormat: 3,
  minStudioVersion: "0.4.0",
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

console.log(
  `Built official-asa@${version} with ${Object.keys(icons).length} matched icons, ${Object.keys(content.creatureInfo).length} creature records, ${assets.length} logical assets, and ${new Set(assets.map((asset) => asset.blob)).size} unique blobs`,
);

// Re-stage immediately. The staged copy under src-tauri/resources is what the
// desktop app installs from, and it is verified against the integrity in
// index.json - so a rebuild that leaves it behind makes the current version
// read as missing, with nothing to say why. Building and staging are one act.
await import("./stage-bundled-official.mjs");
