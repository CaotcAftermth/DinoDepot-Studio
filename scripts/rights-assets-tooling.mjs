import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ASSET_CACHE = "public, max-age=604800";
const REGISTRY_CACHE = "public, max-age=300";
const PRIVATE_FIELDS = new Set([
  "authorityConfirmed",
  "formatConversion",
  "grantor",
  "maxResolution",
  "requestedAt",
  "terms",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function object(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function safeObjectKey(value, label) {
  invariant(typeof value === "string" && value.length > 0, `${label} must be a non-empty string`);
  invariant(!value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."), `${label} is unsafe`);
  return value;
}

function localPath(root, value) {
  invariant(typeof value === "string" && value.length > 0 && !isAbsolute(value), "localFile must be a safe relative path");
  const full = resolve(root, value);
  const rel = relative(root, full);
  invariant(rel !== "" && !rel.startsWith("..") && !isAbsolute(rel), `localFile escapes staging root: ${value}`);
  return full;
}

function rejectPrivateFields(value, path = "manifest") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectPrivateFields(item, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    invariant(!PRIVATE_FIELDS.has(key), `${path}.${key} is private and cannot be published`);
    rejectPrivateFields(item, `${path}.${key}`);
  }
}

async function jsonFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} is invalid JSON: ${error.message}`);
  }
}

function validateApprovedManifest(manifest) {
  object(manifest, "manifest");
  invariant(manifest.schemaVersion === 1, "unsupported mod manifest schema");
  invariant(Number.isSafeInteger(manifest.modId) && manifest.modId > 0, "manifest modId must be numeric");
  const rights = object(manifest.rights, "manifest rights");
  invariant(["author-approved", "license-approved"].includes(rights.status), "manifest rights are not approved");
  invariant(Array.isArray(rights.scope) && rights.scope.length > 0, "manifest rights scope is empty");
  invariant(rights.scope.every((entry) => ["creature-icons", "item-icons"].includes(entry)), "manifest has unsupported rights scope");
  object(rights.attribution, "manifest attribution");
  const assets = object(manifest.assets, "manifest assets");
  invariant(Object.keys(assets).length > 0, "manifest has no assets");
  for (const [assetKey, asset] of Object.entries(assets)) {
    invariant(/^(creature|item):[a-z0-9]+(?:-[a-z0-9]+)*$/.test(assetKey), `invalid manifest asset key: ${assetKey}`);
    object(asset, `manifest asset ${assetKey}`);
    invariant(["active", "replaced", "withdrawn", "disabled"].includes(asset.status), `invalid asset state: ${assetKey}`);
    invariant(Number.isSafeInteger(asset.version) && asset.version > 0, `invalid asset version: ${assetKey}`);
    invariant(/^[a-f0-9]{64}$/.test(asset.sha256), `invalid asset hash: ${assetKey}`);
  }
  rejectPrivateFields(manifest);
  return manifest;
}

export async function validatePublishPlan(planPath, stagingRoot = dirname(resolve(planPath))) {
  const root = resolve(stagingRoot);
  const plan = object(await jsonFile(resolve(planPath), "publish plan"), "publish plan");
  invariant(plan.schemaVersion === 1, "unsupported publish plan schema");
  invariant(plan.bucket === "dinodepot-assets", "publish plan targets the wrong bucket");
  invariant(plan.publicOrigin === "https://assets.dinodepot.app", "publish plan targets the wrong public origin");
  invariant(plan.defaultDenyValidated === true, "publish plan did not pass default-deny validation");
  invariant(Array.isArray(plan.operations) && plan.operations.length >= 3, "publish plan operations are incomplete");

  let phase = "asset";
  let manifestOperation;
  let indexOperation;
  const operations = [];
  for (const [index, rawOperation] of plan.operations.entries()) {
    const operation = object(rawOperation, `operation ${index + 1}`);
    invariant(operation.order === index + 1, "publish operation order must be contiguous");
    invariant(["asset", "manifest", "index"].includes(operation.kind), `unsupported operation kind: ${operation.kind}`);
    if (operation.kind === "asset") invariant(phase === "asset", "all assets must publish before registry metadata");
    if (operation.kind === "manifest") {
      invariant(phase !== "index" && !manifestOperation, "publish plan must contain one manifest before the index");
      phase = "manifest";
      manifestOperation = operation;
    }
    if (operation.kind === "index") {
      invariant(index === plan.operations.length - 1 && manifestOperation && !indexOperation, "registry index must publish once and last");
      phase = "index";
      indexOperation = operation;
    }
    const objectKey = safeObjectKey(operation.objectKey, `operation ${index + 1} objectKey`);
    const absoluteFile = localPath(root, operation.localFile);
    const expectedCache = operation.kind === "asset" ? ASSET_CACHE : REGISTRY_CACHE;
    invariant(operation.cacheControl === expectedCache, `incorrect Cache-Control for ${objectKey}`);
    operations.push({ ...operation, objectKey, absoluteFile });
  }
  invariant(manifestOperation && indexOperation, "publish plan requires manifest and index operations");
  invariant(indexOperation.objectKey === "registry/index.json", "registry index object key is invalid");

  const manifest = validateApprovedManifest(await jsonFile(localPath(root, manifestOperation.localFile), "mod manifest"));
  invariant(manifestOperation.objectKey === `registry/mods/${manifest.modId}.json`, "manifest object key does not match numeric Mod ID");
  const index = object(await jsonFile(localPath(root, indexOperation.localFile), "registry index"), "registry index");
  invariant(index.schemaVersion === 1 && object(index.mods, "registry index mods"), "unsupported registry index schema");
  invariant(index.mods[String(manifest.modId)]?.manifest === `/registry/mods/${manifest.modId}.json`, "registry index does not reference the reviewed manifest");

  const assetOperations = operations.filter((operation) => operation.kind === "asset");
  invariant(assetOperations.length > 0, "publish plan has no assets");
  for (const operation of assetOperations) {
    const match = /^mods\/(\d+)\/(creatures|items)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.v(\d+)\.([a-f0-9]{64})\.webp$/.exec(operation.objectKey);
    invariant(match, `asset object path is not version/hash qualified: ${operation.objectKey}`);
    const [, modId, folder, slug, versionText, pathHash] = match;
    invariant(Number(modId) === manifest.modId, "asset object path Mod ID does not match manifest");
    const assetKey = `${folder === "creatures" ? "creature" : "item"}:${slug}`;
    const asset = manifest.assets[assetKey];
    invariant(asset, `manifest does not contain ${assetKey}`);
    invariant(asset.status === "active", `published asset is not active: ${assetKey}`);
    invariant(asset.path === `/${operation.objectKey}`, `manifest path does not match ${assetKey}`);
    invariant(asset.version === Number(versionText), `manifest version does not match ${assetKey}`);
    invariant(asset.sha256 === pathHash, `object path hash does not match ${assetKey}`);
    const bytes = await readFile(operation.absoluteFile);
    invariant(bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP", `asset is not WebP: ${operation.localFile}`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    invariant(actualHash === asset.sha256, `asset SHA-256 does not match ${assetKey}`);
    const requiredScope = folder === "creatures" ? "creature-icons" : "item-icons";
    invariant(manifest.rights.scope.includes(requiredScope), `rights scope does not cover ${assetKey}`);
  }

  return { ...plan, operations };
}

export async function prepareRevocation(manifestPath, outputDirectory, publicOrigin = "https://assets.dinodepot.app") {
  invariant(publicOrigin === "https://assets.dinodepot.app", "revocation origin must be the production custom domain");
  const source = object(await jsonFile(resolve(manifestPath), "mod manifest"), "mod manifest");
  invariant(source.schemaVersion === 1 && Number.isSafeInteger(source.modId) && source.modId > 0, "unsupported mod manifest");
  const manifest = structuredClone(source);
  manifest.rights = { ...object(manifest.rights, "manifest rights"), status: "revoked" };
  const assetPaths = [];
  for (const asset of Object.values(object(manifest.assets, "manifest assets"))) {
    object(asset, "manifest asset");
    if (typeof asset.path === "string" && asset.path.startsWith("/")) assetPaths.push(asset.path);
    asset.status = "withdrawn";
  }
  const output = resolve(outputDirectory);
  const manifestRelative = `registry/mods/${manifest.modId}.json`;
  await mkdir(resolve(output, "registry", "mods"), { recursive: true });
  await writeFile(resolve(output, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const operations = [
    { order: 1, kind: "denied-metadata", localFile: manifestRelative, objectKey: manifestRelative, cacheControl: REGISTRY_CACHE },
    ...[...new Set(assetPaths)].map((path, index) => ({ order: index + 2, kind: "delete", objectKey: safeObjectKey(path.slice(1), "asset path") })),
  ];
  const purgeOrder = operations.length + 1;
  operations.push({ order: purgeOrder, kind: "purge-urls", urls: [...new Set(assetPaths)].map((path) => `${publicOrigin}${path}`) });
  operations.push({ order: purgeOrder + 1, kind: "verify-placeholders", iconKeys: Object.keys(manifest.assets).map((key) => `mod:${manifest.modId}:${key}`) });
  const plan = {
    schemaVersion: 1,
    bucket: "dinodepot-assets",
    publicOrigin,
    defaultDenyValidated: true,
    operations,
    note: "Execute only with separate authorization: publish denied metadata first, delete objects, purge custom-domain URLs, then verify placeholders.",
  };
  await writeFile(resolve(output, "revocation-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  return plan;
}

export const RIGHTS_ASSET_CACHE_CONTROL = ASSET_CACHE;
export const RIGHTS_REGISTRY_CACHE_CONTROL = REGISTRY_CACHE;
