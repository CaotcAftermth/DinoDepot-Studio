#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { creatureInfoFor, CREATURE_VARIANT_PARENTS } from "./creature-info.mjs";

const repository = process.cwd();
const root = path.join(repository, "Public_Content", "Official_Icons");
const catalog = JSON.parse(await readFile(path.join(repository, "src", "assets", "catalog", "official-asa.json"), "utf8"));
const metadata = JSON.parse(await readFile(path.join(root, "official.json"), "utf8"));
const version = String(metadata.version ?? "");
if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(version)) throw new Error("Unsafe official version");

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const content = {
  format: "dinodepot.package-content",
  schemaVersion: 2,
  iniNotes: "",
  iniSettings: [],
  creatures: [],
  items: [],
  icons: {},
  notes: {},
  maps: {},
  variantParents: CREATURE_VARIANT_PARENTS,
  itemInfo: {},
  creatureInfo: creatureInfoFor(catalog),
};
const contentBytes = Buffer.from(json(content));
const manifest = {
  format: "dinodepot.package",
  formatVersion: 4,
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
  assets: [],
};
const manifestBytes = Buffer.from(json(manifest));
const versionRoot = path.join(root, "versions", version);
await mkdir(versionRoot, { recursive: true });

async function immutable(file, bytes) {
  try {
    const existing = await readFile(file);
    if (!existing.equals(bytes)) throw new Error(`Immutable package file differs: ${file}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(file, bytes);
  }
}
await immutable(path.join(versionRoot, "content.json"), contentBytes);
await immutable(path.join(versionRoot, "manifest.json"), manifestBytes);

const indexPath = path.join(root, "index.json");
const index = JSON.parse(await readFile(indexPath, "utf8"));
const versions = (index.package?.versions ?? []).filter((entry) => entry.version !== version);
versions.push({
  version,
  manifest: `versions/${version}/manifest.json`,
  integrity: sha256(manifestBytes),
  publishedAt: String(metadata.publishedAt ?? ""),
  packageFormat: 4,
  minStudioVersion: "0.9.0",
});
versions.sort((left, right) => left.version.localeCompare(right.version, undefined, { numeric: true }));
await writeFile(indexPath, json({
  formatVersion: 1,
  package: {
    id: "official-asa",
    name: manifest.meta.name,
    version,
    manifest: `versions/${version}/manifest.json`,
    integrity: sha256(manifestBytes),
    publishedAt: manifest.publishedAt,
    versions,
  },
}));

console.log(`Built data-only official-asa@${version}: ${Object.keys(content.creatureInfo).length} creature records, 0 assets`);
await import("./stage-bundled-official.mjs");
