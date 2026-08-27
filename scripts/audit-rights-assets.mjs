import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repo = process.cwd();
const reportDir = path.join(repo, "docs", "rights-assets");
const registryRoot = path.join(repo, "Public_Content", "Asset_Registry", "registry");
const officialRoot = "Public_Content/Official_Icons";
const modRoot = "Public_Content/ModPacks";
const IMAGE = /\.(?:png|jpe?g|webp|gif|svg)$/i;

const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).replace(/\r/g, "");
const tracked = new Set(git("ls-files").split("\n").filter(Boolean));
const relevantTracked = [...tracked].filter((file) => IMAGE.test(file) && (file.startsWith(officialRoot) || file.startsWith(modRoot)));

const history = new Map();
let commit = null;
for (const line of git(
  "log", "--all", "--diff-filter=A", "--name-only",
  "--pretty=format:@@%H|%aI|%s", "--", officialRoot, modRoot,
).split("\n")) {
  if (line.startsWith("@@")) {
    const [hash, at, ...subject] = line.slice(2).split("|");
    commit = { hash, at, subject: subject.join("|") };
  } else if (commit && IMAGE.test(line) && (line.startsWith(officialRoot) || line.startsWith(modRoot))) {
    const rows = history.get(line) ?? [];
    if (!rows.some((row) => row.hash === commit.hash)) rows.push(commit);
    history.set(line, rows);
  }
}

const officialMap = JSON.parse(await readFile(path.join(repo, officialRoot, "assets.json"), "utf8"));
const logicalByBlob = new Map(officialMap.assets.map((asset) => [`${officialRoot}/${asset.blob}`, asset]));
const officialByLogical = new Map(officialMap.assets.map((asset) => [`${officialRoot}/${asset.path}`, asset]));

function slug(value) {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/\(mod\)/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "asset";
}
function suffix(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(value.toLowerCase())) { hash ^= byte; hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash.toString(16).padStart(8, "0");
}
async function sha256(file) {
  if (!(await stat(path.join(repo, file)).catch(() => null))?.isFile()) return null;
  return createHash("sha256").update(await readFile(path.join(repo, file))).digest("hex");
}
function modLogical(file) {
  const base = path.basename(file).replace(/\.[^.]+$/, "");
  const type = /saddle|cocktail|meat|item|ui_/i.test(base) ? "item" : "creature";
  const named = base
    .replace(/^ui_/i, "").replace(/hud[-_ ]?icon$/i, "")
    .replace(/_entry$/i, "").replace(/^anomalo$/i, "anomalocaris")
    .replace(/anomalo/ig, "anomalocaris");
  return { type, assetId: slug(named) };
}

const allPaths = new Set([...relevantTracked, ...history.keys()]);
const entries = [];
for (const source of [...allPaths].sort()) {
  const officialAsset = officialByLogical.get(source) ?? logicalByBlob.get(source);
  const isOfficial = source.startsWith(officialRoot);
  const modMatch = /^Public_Content\/ModPacks\/([0-9]+)-/.exec(source);
  const modId = modMatch?.[1] ?? null;
  let targetKey;
  let logicalAssetPath = null;
  if (isOfficial) {
    const logical = officialAsset?.path ?? path.basename(source);
    logicalAssetPath = logical;
    const folder = logical.split("/")[0];
    const type = folder === "creatures" ? "creature" : folder === "items" ? "item" : "map";
    const base = slug(path.basename(logical).replace(/\.[^.]+$/, ""));
    targetKey = `official:${type}:${base}`;
  } else {
    const logical = modLogical(source);
    targetKey = `mod:${modId ?? "unknown"}:${logical.type}:${logical.assetId}`;
  }
  entries.push({
    source,
    currentPath: tracked.has(source) ? source : null,
    logicalAssetPath,
    git: {
      tracked: tracked.has(source),
      addedBy: history.get(source) ?? [],
      recoverableFromGit: true,
    },
    owner: isOfficial ? "official ARK/ASA reference; ownership/provenance review pending" : "third-party mod creator/licensor; exact owner unverified",
    modId,
    targetKey,
    provenance: isOfficial ? "unprovenanced-official-reference" : "mod-extracted-or-package-copied",
    sha256: officialAsset?.sha256 ?? await sha256(source),
    rightsState: "not-reviewed",
    publishEligible: false,
    publicExposure: {
      repository: "CaotcAftermth/DinoDepot-Studio",
      repositoryVisibility: "public",
      currentTree: tracked.has(source),
      history: (history.get(source)?.length ?? 0) > 0,
      indexedRepositoryOrCdnReferenceFound: false,
      externalCdnAndCacheLogs: "unverified",
    },
    action: "quarantine-do-not-display-do-not-upload",
  });
}

await mkdir(reportDir, { recursive: true });
await writeFile(path.join(reportDir, "legacy-asset-inventory.json"), `${JSON.stringify({
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  repository: { slug: "CaotcAftermth/DinoDepot-Studio", visibility: "public", historyRewritePerformed: false },
  summary: {
    trackedOfficialImages: entries.filter((entry) => entry.source.startsWith(officialRoot) && entry.git.tracked).length,
    trackedModImages: entries.filter((entry) => entry.modId && entry.git.tracked).length,
    uniqueHistoricalModPaths: entries.filter((entry) => entry.modId).length,
    publishEligible: 0,
  },
  entries,
}, null, 2)}\n`);

const officialAssets = {};
for (const asset of officialMap.assets) {
  const folder = asset.path.split("/")[0];
  const type = folder === "creatures" ? "creature" : folder === "items" ? "item" : "map";
  const key = `${type}:${slug(path.basename(asset.path).replace(/\.[^.]+$/, ""))}`;
  const unique = officialAssets[key] ? `${key}-${suffix(asset.path)}` : key;
  const assetId = unique.slice(unique.indexOf(":") + 1);
  officialAssets[unique] = {
    status: "disabled",
    path: `/official/${folder}/${assetId}.webp`,
    version: 1,
    sha256: asset.sha256,
  };
}

const modAssets = {};
for (const entry of entries.filter((value) => value.modId === "987274" && value.git.tracked)) {
  const parsed = /^mod:[^:]+:(creature|item):(.+)$/.exec(entry.targetKey);
  if (!parsed) continue;
  const key = `${parsed[1]}:${parsed[2]}`;
  if (modAssets[key]) continue;
  modAssets[key] = {
    status: "disabled",
    path: `/mods/987274/${parsed[1] === "creature" ? "creatures" : "items"}/${parsed[2]}.webp`,
    version: 1,
    sha256: entry.sha256,
  };
}

await mkdir(path.join(registryRoot, "mods"), { recursive: true });
await writeFile(path.join(registryRoot, "index.json"), `${JSON.stringify({
  schemaVersion: 1,
  registryVersion: 1,
  generatedAt: new Date().toISOString(),
  official: { manifest: "/registry/official.json", version: 1 },
  mods: { "987274": { manifest: "/registry/mods/987274.json", version: 1 } },
}, null, 2)}\n`);
await writeFile(path.join(registryRoot, "official.json"), `${JSON.stringify({
  schemaVersion: 1,
  rights: {
    status: "official-reference-policy",
    policyId: "DDS-OFFICIAL-REFERENCE-QUARANTINE-v1",
    reviewedAt: "2026-08-27",
    reviewState: "not-reviewed",
    distributionEligible: false,
    scope: [],
  },
  assets: officialAssets,
}, null, 2)}\n`);
await writeFile(path.join(registryRoot, "mods", "987274.json"), `${JSON.stringify({
  schemaVersion: 1,
  modId: 987274,
  modName: "Additions Ascended Anomalocaris",
  rights: { status: "not-reviewed", scope: [], attribution: { creator: "", projectUrl: "" } },
  assets: modAssets,
}, null, 2)}\n`);

console.log(`Inventoried ${entries.length} current/historical asset paths; all default-denied.`);
