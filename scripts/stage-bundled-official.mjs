#!/usr/bin/env node

/** Stages only the current verified official package for the Tauri bundle. */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repository = process.cwd();
const officialRoot = path.join(repository, "Public_Content", "Official_Icons");
const outputRoot = path.join(
  repository,
  "src-tauri",
  "resources",
  "official-package",
);
const index = JSON.parse(
  await readFile(path.join(officialRoot, "index.json"), "utf8"),
);
const release = index.package;
const manifestRelative = String(release?.manifest ?? "");
if (!/^versions\/[A-Za-z0-9][A-Za-z0-9._+-]*\/manifest\.json$/.test(manifestRelative)) {
  throw new Error("Official index has an unsafe current manifest path");
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifestSource = path.join(officialRoot, ...manifestRelative.split("/"));
const manifestBytes = await readFile(manifestSource);
if (sha256(manifestBytes) !== String(release.integrity ?? "").toLowerCase()) {
  throw new Error("Current official manifest does not match index integrity");
}
const manifest = JSON.parse(manifestBytes.toString("utf8"));
if (
  manifest.format !== "dinodepot.package" ||
  ![2, 3].includes(manifest.formatVersion) ||
  manifest.kind !== "official" ||
  manifest.packageId !== "official-asa" ||
  manifest.version !== release.version
) {
  throw new Error("Current official manifest identity is invalid");
}

const versionSource = path.dirname(manifestSource);
const versionOutput = path.join(outputRoot, "versions", manifest.version);
const copiedBlobs = new Set();

async function verifiedCopy(source, destination, record) {
  const bytes = await readFile(source);
  if (
    bytes.length !== Number(record.size) ||
    sha256(bytes) !== String(record.sha256).toLowerCase()
  ) {
    throw new Error(`${record.path} failed integrity while staging`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(versionOutput, { recursive: true });
await writeFile(
  path.join(outputRoot, ".gitkeep"),
  "Generated package files in this directory are intentionally ignored.\n",
);
await writeFile(path.join(versionOutput, "manifest.json"), manifestBytes);
await verifiedCopy(
  path.join(versionSource, manifest.content.path),
  path.join(versionOutput, manifest.content.path),
  manifest.content,
);

for (const asset of manifest.assets ?? []) {
  const logical = String(asset.path ?? "");
  if (!/^assets\/.+\.(?:webp|png)$/i.test(logical)) {
    throw new Error(`Unsafe official logical asset path: ${logical}`);
  }
  if (manifest.formatVersion === 2) {
    await verifiedCopy(
      path.join(versionSource, ...logical.split("/")),
      path.join(versionOutput, ...logical.split("/")),
      asset,
    );
    continue;
  }
  const blob = String(asset.blob ?? "");
  if (!/^assets\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.(?:webp|png)$/.test(blob)) {
    throw new Error(`Unsafe official blob path: ${blob}`);
  }
  if (copiedBlobs.has(blob)) continue;
  copiedBlobs.add(blob);
  await verifiedCopy(
    path.join(officialRoot, ...blob.split("/")),
    path.join(outputRoot, ...blob.split("/")),
    asset,
  );
}

console.log(
  `Staged official-asa@${manifest.version}: ${manifest.assets?.length ?? 0} logical assets, ${copiedBlobs.size || manifest.assets?.length || 0} bundled files`,
);
