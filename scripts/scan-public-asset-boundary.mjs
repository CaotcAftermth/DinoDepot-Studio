import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const FORBIDDEN = /\.(?:png|jpe?g|webp|gif|svg)$/i;
const PUBLIC_ART_ROOTS = [
  "Public_Content/ModPacks/",
  "Public_Content/Official_Icons/",
];
const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((file) => file.replace(/\\/g, "/"))
  .filter(Boolean);
const failures = [];

for (const file of tracked) {
  if (existsSync(file) && PUBLIC_ART_ROOTS.some((root) => file.startsWith(root)) && FORBIDDEN.test(file)) {
    failures.push(`${file}: third-party artwork is forbidden at the public data boundary`);
  }
}

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
for (const file of tracked.filter((candidate) =>
  /^Public_Content\/Official_Icons\/versions\/[^/]+\/manifest\.json$/.test(candidate),
)) {
  const manifest = await json(file);
  if (manifest.formatVersion === 4 && (!Array.isArray(manifest.assets) || manifest.assets.length !== 0)) {
    failures.push(`${file}: package v4 assets must be empty`);
  }
}

for (const file of tracked.filter((candidate) =>
  /^Public_Content\/Asset_Registry\/registry\/mods\/[0-9]+\.json$/.test(candidate),
)) {
  const manifest = await json(file);
  const approved = ["author-approved", "license-approved"].includes(manifest?.rights?.status);
  if (!approved && Object.values(manifest?.assets ?? {}).some((asset) => asset?.status === "active")) {
    failures.push(`${file}: unapproved mod manifest contains an active asset`);
  }
}

const officialPath = path.join("Public_Content", "Asset_Registry", "registry", "official.json");
const official = await json(officialPath).catch(() => null);
if (official) {
  const eligible = official.rights?.status === "official-reference-policy"
    && official.rights?.reviewState === "approved"
    && official.rights?.distributionEligible === true;
  if (!eligible && Object.values(official.assets ?? {}).some((asset) => asset?.status === "active")) {
    failures.push(`${officialPath}: ineligible official policy contains an active asset`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("Public rights-aware asset boundary passed.");
}
