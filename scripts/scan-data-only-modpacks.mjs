import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const roots = process.argv.slice(2);
if (roots.length === 0) roots.push("Public_Content/ModPacks");

const failures = [];

async function filesBelow(root) {
  const out = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await filesBelow(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

for (const requested of roots) {
  const root = path.resolve(requested);
  if (!(await stat(root).catch(() => null))?.isDirectory()) continue;
  const allFiles = await filesBelow(root);
  const manifests = allFiles.filter((file) => path.basename(file).toLowerCase() === "modpack.json");
  for (const manifestPath of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      failures.push(`${manifestPath}: invalid JSON (${error.message})`);
      continue;
    }
    if (Number(manifest.formatVersion) < 2) continue;
    const packRoot = path.dirname(manifestPath);
    for (const file of allFiles.filter((candidate) => candidate === packRoot || candidate.startsWith(`${packRoot}${path.sep}`))) {
      if (FORBIDDEN.test(file)) failures.push(`${file}: artwork forbidden in format-2 modpack`);
    }
    if (manifest.icons && Object.keys(manifest.icons).length > 0) {
      failures.push(`${manifestPath}: format-2 icons map must be empty`);
    }
    for (const [kind, entries] of [["creatures", manifest.creatures], ["items", manifest.items]]) {
      for (const [index, entry] of (Array.isArray(entries) ? entries : []).entries()) {
        if (typeof entry?.iconKey !== "string") {
          failures.push(`${manifestPath}: ${kind}[${index}] lacks iconKey`);
        }
        for (const field of ["icon", "iconPath", "image", "imageUrl"]) {
          if (field in (entry ?? {})) failures.push(`${manifestPath}: ${kind}[${index}].${field} is forbidden`);
        }
      }
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Data-only modpack boundary passed.");
}
