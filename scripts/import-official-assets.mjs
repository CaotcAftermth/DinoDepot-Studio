#!/usr/bin/env node

/**
 * Imports human-named official icon folders into the immutable SHA-256 store.
 * The input root contains creatures/, items/, and/or maps/. It can be a
 * disposable staging directory; only the asset map and unique blobs are kept
 * in Public_Content.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = process.cwd();
const officialRoot = path.join(repository, "Public_Content", "Official_Icons");
const replace = process.argv.includes("--replace");
const inputArg = process.argv
  .slice(2)
  .find((value) => value !== "--replace" && !value.startsWith("--"));
const inputRoot = path.resolve(repository, inputArg ?? officialRoot);
const mapPath = path.join(officialRoot, "assets.json");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mediaType = (file) =>
  file.toLowerCase().endsWith(".webp") ? "image/webp" : "image/png";
const blobPath = (hash, file) => {
  const extension = path.extname(file).slice(1).toLowerCase();
  return `assets/sha256/${hash.slice(0, 2)}/${hash}.${extension}`;
};
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function validImage(file, bytes) {
  if (/\.png$/i.test(file)) {
    return bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  }
  return (
    /\.webp$/i.test(file) &&
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

async function walk(current, relativeRoot, found) {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(absolute, relativeRoot, found);
    } else if (/\.(?:webp|png)$/i.test(entry.name)) {
      found.push(path.relative(relativeRoot, absolute).replaceAll("\\", "/"));
    }
  }
}

let existing = { formatVersion: 1, assets: [] };
try {
  existing = JSON.parse(await readFile(mapPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (existing.formatVersion !== 1 || !Array.isArray(existing.assets)) {
  throw new Error("Official asset map is malformed");
}

const imported = [];
for (const kind of ["creatures", "items", "maps"]) {
  await walk(path.join(inputRoot, kind), inputRoot, imported);
}
if (imported.length === 0) {
  throw new Error(`No PNG or WebP files found below ${inputRoot}`);
}

const assets = new Map(
  (replace ? [] : existing.assets).map((asset) => [asset.path.toLowerCase(), asset]),
);
for (const relative of imported.sort((a, b) => a.localeCompare(b))) {
  const bytes = await readFile(path.join(inputRoot, ...relative.split("/")));
  if (!validImage(relative, bytes)) {
    throw new Error(`${relative} does not match its PNG/WebP extension`);
  }
  const hash = sha256(bytes);
  const blob = blobPath(hash, relative);
  const destination = path.join(officialRoot, ...blob.split("/"));
  try {
    const current = await readFile(destination);
    if (!current.equals(bytes)) {
      throw new Error(`Content-address collision at ${blob}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
  assets.set(relative.toLowerCase(), {
    path: relative,
    blob,
    sha256: hash,
    size: bytes.length,
    mediaType: mediaType(relative),
  });
}

const records = [...assets.values()].sort((a, b) => a.path.localeCompare(b.path));
await writeFile(mapPath, json({ formatVersion: 1, assets: records }));
console.log(
  `Imported ${imported.length} logical icons as ${new Set(records.map((asset) => asset.blob)).size} unique blobs`,
);
console.log(`Updated ${mapPath}`);
