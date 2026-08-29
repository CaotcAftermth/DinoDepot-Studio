import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

const ASSET_CACHE = "public, max-age=604800";
const REGISTRY_CACHE = "public, max-age=300";
const PUBLIC_ORIGIN = "https://assets.dinodepot-studio.app";
const ASSET_STATES = new Set(["active", "replaced", "withdrawn", "disabled"]);
const MOD_RIGHTS_STATES = new Set([
  "not-reviewed",
  "requested",
  "author-approved",
  "license-approved",
  "declined",
  "revoked",
  "ownership-unclear",
]);
const MOD_SCOPES = new Set(["creature-icons", "item-icons"]);
const OFFICIAL_SCOPES = new Set(["creature-icons", "item-icons", "map-icons"]);
const PRIVATE_FIELDS = new Set([
  "authorityConfirmed",
  "formatConversion",
  "grantor",
  "maxResolution",
  "requestedAt",
  "source",
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

async function optionalJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function scopeForType(type) {
  return `${type}-icons`;
}

function folderForType(type) {
  return type === "creature" ? "creatures" : type === "item" ? "items" : "maps";
}

function validateAsset(assetKey, asset, namespace, modId) {
  const match = /^(creature|item|map):([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(assetKey);
  invariant(match, `invalid manifest asset key: ${assetKey}`);
  const [, type, slug] = match;
  if (namespace === "mod") invariant(type !== "map", `mod assets cannot use map type: ${assetKey}`);
  object(asset, `manifest asset ${assetKey}`);
  invariant(ASSET_STATES.has(asset.status), `invalid asset state: ${assetKey}`);
  invariant(Number.isSafeInteger(asset.version) && asset.version > 0, `invalid asset version: ${assetKey}`);
  invariant(/^[a-f0-9]{64}$/.test(asset.sha256), `invalid asset hash: ${assetKey}`);
  const prefix = namespace === "mod"
    ? `/mods/${modId}/${folderForType(type)}/`
    : `/official/${folderForType(type)}/`;
  invariant(
    typeof asset.path === "string"
      && asset.path.startsWith(prefix)
      && asset.path.endsWith(".webp")
      && !asset.path.includes("..")
      && !asset.path.includes("//"),
    `asset path does not match ${assetKey}`,
  );
  if (asset.status === "active") {
    const qualified = new RegExp(`^${prefix.replaceAll("/", "\\/")}${slug}\\.v${asset.version}\\.${asset.sha256}\\.webp$`);
    invariant(qualified.test(asset.path), `active asset path is not version/hash qualified: ${assetKey}`);
  }
  return { type, slug };
}

function validateModManifest(manifest, requireApproved = false) {
  object(manifest, "manifest");
  invariant(manifest.schemaVersion === 1, "unsupported mod manifest schema");
  invariant(Number.isSafeInteger(manifest.modId) && manifest.modId > 0, "manifest modId must be numeric");
  invariant(typeof manifest.modName === "string" && manifest.modName.length > 0, "manifest modName is required");
  const rights = object(manifest.rights, "manifest rights");
  invariant(MOD_RIGHTS_STATES.has(rights.status), "manifest rights status is invalid");
  invariant(Array.isArray(rights.scope) && rights.scope.every((entry) => MOD_SCOPES.has(entry)), "manifest has unsupported rights scope");
  const attribution = object(rights.attribution, "manifest attribution");
  const approved = ["author-approved", "license-approved"].includes(rights.status);
  if (requireApproved) invariant(approved, "manifest rights are not approved");
  if (approved) {
    invariant(/^[A-Z0-9][A-Z0-9._-]*$/.test(rights.permissionId ?? ""), "approved rights require a public permission id");
    invariant(/^DDS-ICON-PERMISSION-v[0-9]+\.[0-9]+$/.test(rights.permissionVersion ?? ""), "approved rights require a permission terms version");
    invariant(/^\d{4}-\d{2}-\d{2}$/.test(rights.approvedAt ?? ""), "approved rights require an approval date");
    invariant(rights.scope.length > 0, "approved rights scope is empty");
    invariant(typeof attribution.creator === "string" && attribution.creator.length > 0, "approved rights require creator attribution");
    invariant(/^https:\/\//.test(attribution.projectUrl ?? ""), "approved rights require an HTTPS project URL");
  }
  const assets = object(manifest.assets, "manifest assets");
  invariant(Object.keys(assets).length > 0, "manifest has no assets");
  for (const [assetKey, asset] of Object.entries(assets)) {
    const { type } = validateAsset(assetKey, asset, "mod", manifest.modId);
    if (asset.status === "active") {
      invariant(approved, `active asset has denied mod rights: ${assetKey}`);
      invariant(rights.scope.includes(scopeForType(type)), `rights scope does not cover ${assetKey}`);
    }
  }
  rejectPrivateFields(manifest);
  return { namespace: "mod", manifest };
}

function validateOfficialManifest(manifest, requireApproved = false) {
  object(manifest, "manifest");
  invariant(manifest.schemaVersion === 1, "unsupported official manifest schema");
  const rights = object(manifest.rights, "manifest rights");
  invariant(rights.status === "official-reference-policy", "official manifest policy status is invalid");
  invariant(typeof rights.policyId === "string" && rights.policyId.length > 0, "official policy id is required");
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(rights.reviewedAt ?? ""), "official policy review date is required");
  invariant(["not-reviewed", "approved", "declined"].includes(rights.reviewState), "official review state is invalid");
  invariant(typeof rights.distributionEligible === "boolean", "official distribution eligibility is required");
  invariant(Array.isArray(rights.scope) && rights.scope.every((entry) => OFFICIAL_SCOPES.has(entry)), "official policy has unsupported scope");
  const approved = rights.reviewState === "approved" && rights.distributionEligible;
  if (requireApproved) invariant(approved, "official policy is not approved for distribution");
  const assets = object(manifest.assets, "manifest assets");
  invariant(Object.keys(assets).length > 0, "official manifest has no assets");
  for (const [assetKey, asset] of Object.entries(assets)) {
    const { type } = validateAsset(assetKey, asset, "official");
    if (asset.status === "active") {
      invariant(approved, `active asset has denied official policy: ${assetKey}`);
      invariant(rights.scope.includes(scopeForType(type)), `official policy scope does not cover ${assetKey}`);
    }
  }
  rejectPrivateFields(manifest);
  return { namespace: "official", manifest };
}

export function validatePublicManifest(manifest, requireApproved = false) {
  return Number.isSafeInteger(manifest?.modId)
    ? validateModManifest(manifest, requireApproved)
    : validateOfficialManifest(manifest, requireApproved);
}

function validateIndex(index) {
  object(index, "registry index");
  invariant(index.schemaVersion === 1, "unsupported registry index schema");
  invariant(Number.isSafeInteger(index.registryVersion) && index.registryVersion >= 0, "invalid registry version");
  object(index.mods, "registry index mods");
  return index;
}

function validateAssetOperation(operation, manifestInfo) {
  const { namespace, manifest } = manifestInfo;
  const pattern = namespace === "mod"
    ? /^mods\/(\d+)\/(creatures|items)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.v(\d+)\.([a-f0-9]{64})\.webp$/
    : /^official\/(creatures|items|maps)\/([a-z0-9]+(?:-[a-z0-9]+)*)\.v(\d+)\.([a-f0-9]{64})\.webp$/;
  const match = pattern.exec(operation.objectKey);
  invariant(match, `asset object path is not version/hash qualified: ${operation.objectKey}`);
  let folder;
  let slug;
  let versionText;
  let pathHash;
  if (namespace === "mod") {
    const [, modId, matchedFolder, matchedSlug, matchedVersion, matchedHash] = match;
    invariant(Number(modId) === manifest.modId, "asset object path Mod ID does not match manifest");
    [folder, slug, versionText, pathHash] = [matchedFolder, matchedSlug, matchedVersion, matchedHash];
  } else {
    [, folder, slug, versionText, pathHash] = match;
  }
  const type = folder === "creatures" ? "creature" : folder === "items" ? "item" : "map";
  const assetKey = `${type}:${slug}`;
  const asset = manifest.assets[assetKey];
  invariant(asset, `manifest does not contain ${assetKey}`);
  invariant(asset.status === "active", `published asset is not active: ${assetKey}`);
  invariant(asset.path === `/${operation.objectKey}`, `manifest path does not match ${assetKey}`);
  invariant(asset.version === Number(versionText), `manifest version does not match ${assetKey}`);
  invariant(asset.sha256 === pathHash, `object path hash does not match ${assetKey}`);
  invariant(manifest.rights.scope.includes(scopeForType(type)), `rights scope does not cover ${assetKey}`);
  return assetKey;
}

export async function validatePublishPlan(planPath, stagingRoot = dirname(resolve(planPath))) {
  const root = resolve(stagingRoot);
  const plan = object(await jsonFile(resolve(planPath), "publish plan"), "publish plan");
  invariant(plan.schemaVersion === 1, "unsupported publish plan schema");
  invariant(plan.bucket === "dinodepot-assets", "publish plan targets the wrong bucket");
  invariant(plan.publicOrigin === PUBLIC_ORIGIN, "publish plan targets the wrong public origin");
  invariant(plan.defaultDenyValidated === true, "publish plan did not pass default-deny validation");
  const mode = plan.mode ?? "asset-publish";
  invariant(["asset-publish", "metadata"].includes(mode), "unsupported publish plan mode");
  invariant(Array.isArray(plan.operations) && plan.operations.length >= (mode === "metadata" ? 2 : 3), "publish plan operations are incomplete");

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

  const manifestInfo = validatePublicManifest(
    await jsonFile(localPath(root, manifestOperation.localFile), "public manifest"),
    mode === "asset-publish",
  );
  const index = validateIndex(await jsonFile(localPath(root, indexOperation.localFile), "registry index"));
  if (manifestInfo.namespace === "mod") {
    const id = manifestInfo.manifest.modId;
    invariant(manifestOperation.objectKey === `registry/mods/${id}.json`, "manifest object key does not match numeric Mod ID");
    invariant(index.mods[String(id)]?.manifest === `/registry/mods/${id}.json`, "registry index does not reference the reviewed manifest");
  } else {
    invariant(manifestOperation.objectKey === "registry/official.json", "official manifest object key is invalid");
    invariant(index.official?.manifest === "/registry/official.json", "registry index does not reference official manifest");
  }

  const assetOperations = operations.filter((operation) => operation.kind === "asset");
  invariant(mode === "metadata" ? assetOperations.length === 0 : assetOperations.length > 0, mode === "metadata" ? "metadata plan cannot upload assets" : "publish plan has no assets");
  for (const operation of assetOperations) {
    validateAssetOperation(operation, manifestInfo);
    const bytes = await readFile(operation.absoluteFile);
    invariant(bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP", `asset is not WebP: ${operation.localFile}`);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    invariant(operation.objectKey.includes(`.${actualHash}.webp`), `asset SHA-256 does not match ${operation.objectKey}`);
  }

  return { ...plan, mode, operations };
}

function incrementIndex(index, namespace, modId) {
  const next = structuredClone(validateIndex(index));
  next.registryVersion += 1;
  next.generatedAt = new Date().toISOString();
  if (namespace === "official") {
    const current = next.official?.version ?? 0;
    next.official = { manifest: "/registry/official.json", version: current + 1 };
  } else {
    const key = String(modId);
    const current = next.mods[key]?.version ?? 0;
    next.mods[key] = { manifest: `/registry/mods/${modId}.json`, version: current + 1 };
  }
  return next;
}

async function writeStagedRegistry(output, manifestRelative, manifest, index, mode = "asset-publish") {
  await mkdir(dirname(resolve(output, manifestRelative)), { recursive: true });
  await mkdir(resolve(output, "registry"), { recursive: true });
  await writeFile(resolve(output, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(resolve(output, "registry/index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  if (mode === "metadata") {
    const plan = {
      schemaVersion: 1,
      mode,
      bucket: "dinodepot-assets",
      publicOrigin: PUBLIC_ORIGIN,
      defaultDenyValidated: true,
      operations: [
        { order: 1, kind: "manifest", localFile: manifestRelative, objectKey: manifestRelative, cacheControl: REGISTRY_CACHE },
        { order: 2, kind: "index", localFile: "registry/index.json", objectKey: "registry/index.json", cacheControl: REGISTRY_CACHE },
      ],
    };
    await writeFile(resolve(output, "publish-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  }
}

export async function stagePreparedAsset(outputDirectory, registryDirectory) {
  const output = resolve(outputDirectory);
  const registry = resolve(registryDirectory);
  const fragment = object(await jsonFile(resolve(output, "metadata/sanitized-fragment.json"), "sanitized fragment"), "sanitized fragment");
  invariant(fragment.schemaVersion === 1, "unsupported sanitized fragment schema");
  const index = await jsonFile(resolve(registry, "index.json"), "registry index");
  if (Number.isSafeInteger(fragment.modId)) {
    const manifestPath = resolve(registry, "mods", `${fragment.modId}.json`);
    const existing = await optionalJsonFile(manifestPath);
    if (existing && Object.values(existing.assets ?? {}).some((asset) => asset.status === "active")) {
      invariant(existing.rights?.permissionId === fragment.rights?.permissionId, "active mod assets use a different permission record");
      invariant(existing.rights?.permissionVersion === fragment.rights?.permissionVersion, "active mod assets use a different permission terms version");
      invariant(existing.rights?.status === fragment.rights?.status, "active mod assets use a different approval basis");
      invariant(existing.rights?.approvedAt === fragment.rights?.approvedAt, "active mod assets use a different approval date");
      invariant(existing.rights?.attribution?.creator === fragment.rights?.attribution?.creator, "active mod assets use different creator attribution");
      invariant(existing.rights?.attribution?.projectUrl === fragment.rights?.attribution?.projectUrl, "active mod assets use a different project URL");
      invariant(
        [...(existing.rights?.scope ?? [])].sort().join(",") === [...(fragment.rights?.scope ?? [])].sort().join(","),
        "active mod assets use a different approved scope",
      );
    }
    const manifest = {
      schemaVersion: 1,
      modId: fragment.modId,
      modName: fragment.modName,
      rights: fragment.rights,
      assets: { ...(existing?.assets ?? {}), [fragment.assetKey]: fragment.asset },
    };
    validateModManifest(manifest, true);
    const manifestRelative = `registry/mods/${fragment.modId}.json`;
    const nextIndex = incrementIndex(index, "mod", fragment.modId);
    await writeStagedRegistry(output, manifestRelative, manifest, nextIndex);
    return { namespace: "mod", manifestRelative, manifest, index: nextIndex };
  }

  const existing = await jsonFile(resolve(registry, "official.json"), "official manifest");
  if (Object.values(existing.assets ?? {}).some((asset) => asset.status === "active")) {
    invariant(existing.rights?.policyId === fragment.rights?.policyId, "active official assets use a different reference policy");
    invariant(existing.rights?.reviewedAt === fragment.rights?.reviewedAt, "active official assets use a different policy review date");
    invariant(
      [...(existing.rights?.scope ?? [])].sort().join(",") === [...(fragment.rights?.scope ?? [])].sort().join(","),
      "active official assets use a different policy scope",
    );
  }
  const manifest = {
    schemaVersion: 1,
    rights: fragment.rights,
    assets: { ...existing.assets, [fragment.assetKey]: fragment.asset },
  };
  validateOfficialManifest(manifest, true);
  const nextIndex = incrementIndex(index, "official");
  await writeStagedRegistry(output, "registry/official.json", manifest, nextIndex);
  return { namespace: "official", manifestRelative: "registry/official.json", manifest, index: nextIndex };
}

function applyAssetStates(manifest, changes) {
  for (const [key, state] of Object.entries(changes ?? {})) {
    invariant(ASSET_STATES.has(state), `invalid requested asset state: ${key}`);
    invariant(manifest.assets[key], `manifest does not contain ${key}`);
    manifest.assets[key].status = state;
  }
}

export async function prepareStatusChange(namespace, registryDirectory, outputDirectory, change) {
  invariant(["official", "mod"].includes(namespace), "status namespace must be official or mod");
  const registry = resolve(registryDirectory);
  const output = resolve(outputDirectory);
  const index = await jsonFile(resolve(registry, "index.json"), "registry index");
  if (namespace === "official") {
    invariant(
      change.reviewState !== undefined
        || change.distributionEligible !== undefined
        || change.scope !== undefined
        || Object.keys(change.assets ?? {}).length > 0,
      "no official status changes requested",
    );
    const manifest = structuredClone(await jsonFile(resolve(registry, "official.json"), "official manifest"));
    const current = structuredClone(object(manifest.rights, "official rights"));
    const next = { ...current };
    if (change.reviewState !== undefined) next.reviewState = change.reviewState;
    if (change.distributionEligible !== undefined) next.distributionEligible = change.distributionEligible;
    if (change.scope !== undefined) next.scope = change.scope;
    if (next.reviewState === "approved" && current.reviewState !== "approved") {
      throw new Error("official approval must come from a validated official prepare command");
    }
    if (next.distributionEligible && !current.distributionEligible) {
      throw new Error("official distribution eligibility must come from a validated official prepare command");
    }
    if ((change.scope ?? []).some((entry) => !current.scope.includes(entry))) {
      throw new Error("official scope expansion must come from a validated official prepare command");
    }
    manifest.rights = next;
    applyAssetStates(manifest, change.assets);
    if (next.reviewState !== "approved" || !next.distributionEligible) {
      const deniedState = next.reviewState === "declined" ? "withdrawn" : "disabled";
      for (const asset of Object.values(manifest.assets)) if (asset.status === "active") asset.status = deniedState;
    }
    validateOfficialManifest(manifest);
    const nextIndex = incrementIndex(index, "official");
    await writeStagedRegistry(output, "registry/official.json", manifest, nextIndex, "metadata");
    return { manifest, index: nextIndex };
  }

  invariant(Number.isSafeInteger(change.modId) && change.modId > 0, "mod status requires numeric Mod ID");
  invariant(
    change.rightsStatus !== undefined || change.scope !== undefined || Object.keys(change.assets ?? {}).length > 0,
    "no mod status changes requested",
  );
  const manifestRelative = `registry/mods/${change.modId}.json`;
  const manifest = structuredClone(await jsonFile(resolve(registry, "mods", `${change.modId}.json`), "mod manifest"));
  const current = structuredClone(object(manifest.rights, "mod rights"));
  const next = { ...current };
  if (change.rightsStatus !== undefined) next.status = change.rightsStatus;
  if (change.scope !== undefined) next.scope = change.scope;
  const approved = ["author-approved", "license-approved"];
  if (approved.includes(next.status) && next.status !== current.status) {
    throw new Error("mod approval or approval-basis change must come from a validated mod prepare command");
  }
  if ((change.scope ?? []).some((entry) => !current.scope.includes(entry))) {
    throw new Error("mod scope expansion must come from a validated mod prepare command");
  }
  manifest.rights = next;
  applyAssetStates(manifest, change.assets);
  if (!approved.includes(next.status)) {
    const deniedState = ["declined", "revoked"].includes(next.status) ? "withdrawn" : "disabled";
    for (const asset of Object.values(manifest.assets)) if (asset.status === "active") asset.status = deniedState;
  }
  validateModManifest(manifest);
  const nextIndex = incrementIndex(index, "mod", change.modId);
  await writeStagedRegistry(output, manifestRelative, manifest, nextIndex, "metadata");
  return { manifest, index: nextIndex };
}

export async function prepareRevocation(manifestPath, outputDirectory, publicOrigin = PUBLIC_ORIGIN) {
  invariant(publicOrigin === PUBLIC_ORIGIN, "revocation origin must be the production custom domain");
  const source = object(await jsonFile(resolve(manifestPath), "public manifest"), "public manifest");
  const manifest = structuredClone(source);
  const isMod = Number.isSafeInteger(manifest.modId);
  if (isMod) {
    manifest.rights = { ...object(manifest.rights, "manifest rights"), status: "revoked" };
  } else {
    manifest.rights = {
      ...object(manifest.rights, "manifest rights"),
      reviewState: "declined",
      distributionEligible: false,
    };
  }
  const assetPaths = [];
  for (const asset of Object.values(object(manifest.assets, "manifest assets"))) {
    object(asset, "manifest asset");
    if (typeof asset.path === "string" && asset.path.startsWith("/")) assetPaths.push(asset.path);
    asset.status = "withdrawn";
  }
  validatePublicManifest(manifest);
  const output = resolve(outputDirectory);
  const manifestRelative = isMod ? `registry/mods/${manifest.modId}.json` : "registry/official.json";
  await mkdir(dirname(resolve(output, manifestRelative)), { recursive: true });
  await writeFile(resolve(output, manifestRelative), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const operations = [
    { order: 1, kind: "denied-metadata", localFile: manifestRelative, objectKey: manifestRelative, cacheControl: REGISTRY_CACHE },
    ...[...new Set(assetPaths)].map((path, index) => ({ order: index + 2, kind: "delete", objectKey: safeObjectKey(path.slice(1), "asset path") })),
  ];
  const purgeOrder = operations.length + 1;
  operations.push({ order: purgeOrder, kind: "purge-urls", urls: [...new Set(assetPaths)].map((path) => `${publicOrigin}${path}`) });
  const prefix = isMod ? `mod:${manifest.modId}:` : "official:";
  operations.push({ order: purgeOrder + 1, kind: "verify-placeholders", iconKeys: Object.keys(manifest.assets).map((key) => `${prefix}${key}`) });
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
export const RIGHTS_ASSET_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
