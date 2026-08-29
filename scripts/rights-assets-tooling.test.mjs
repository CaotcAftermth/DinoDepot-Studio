import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import {
  prepareStatusChange,
  prepareRevocation,
  RIGHTS_ASSET_CACHE_CONTROL,
  RIGHTS_REGISTRY_CACHE_CONTROL,
  stagePreparedAsset,
  validatePublishPlan,
} from "./rights-assets-tooling.mjs";

const temporaryDirectories = [];

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dds-rights-tooling-"));
  temporaryDirectories.push(root);
  const bytes = Buffer.alloc(20);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(12, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `mods/123/creatures/rex.v2.${hash}.webp`;
  await mkdir(resolve(root, "mods", "123", "creatures"), { recursive: true });
  await mkdir(resolve(root, "registry", "mods"), { recursive: true });
  await writeFile(resolve(root, objectKey), bytes);
  const manifest = {
    schemaVersion: 1,
    modId: 123,
    modName: "Example Mod",
    rights: {
      status: "author-approved",
      permissionId: "PERMISSION-123",
      permissionVersion: "DDS-ICON-PERMISSION-v1.0",
      approvedAt: "2026-08-27",
      scope: ["creature-icons"],
      attribution: { creator: "Example Creator", projectUrl: "https://example.invalid/mod" },
    },
    assets: {
      "creature:rex": { status: "active", path: `/${objectKey}`, version: 2, sha256: hash },
    },
  };
  const index = {
    schemaVersion: 1,
    registryVersion: 2,
    generatedAt: "2026-08-27T00:00:00Z",
    official: { manifest: "/registry/official.json", version: 1 },
    mods: { "123": { manifest: "/registry/mods/123.json", version: 2 } },
  };
  const plan = {
    schemaVersion: 1,
    bucket: "dinodepot-assets",
    publicOrigin: "https://assets.dinodepot-studio.app",
    defaultDenyValidated: true,
    operations: [
      { order: 1, kind: "asset", localFile: objectKey, objectKey, cacheControl: RIGHTS_ASSET_CACHE_CONTROL },
      { order: 2, kind: "manifest", localFile: "registry/mods/123.json", objectKey: "registry/mods/123.json", cacheControl: RIGHTS_REGISTRY_CACHE_CONTROL },
      { order: 3, kind: "index", localFile: "registry/index.json", objectKey: "registry/index.json", cacheControl: RIGHTS_REGISTRY_CACHE_CONTROL },
    ],
  };
  await writeFile(resolve(root, "registry", "mods", "123.json"), JSON.stringify(manifest));
  await writeFile(resolve(root, "registry", "index.json"), JSON.stringify(index));
  await writeFile(resolve(root, "publish-plan.json"), JSON.stringify(plan));
  return { root, manifest, plan };
}

test("validates a rights-approved, registry-last publish plan", async () => {
  const { root } = await fixture();
  const result = await validatePublishPlan(resolve(root, "publish-plan.json"));
  assert.deepEqual(result.operations.map((operation) => operation.kind), ["asset", "manifest", "index"]);
  assert.ok(result.operations.every((operation) => operation.absoluteFile.startsWith(root)));
});

test("rejects an index that is not published last", async () => {
  const { root, plan } = await fixture();
  plan.operations = [plan.operations[0], plan.operations[2], plan.operations[1]].map((operation, index) => ({ ...operation, order: index + 1 }));
  await writeFile(resolve(root, "publish-plan.json"), JSON.stringify(plan));
  await assert.rejects(validatePublishPlan(resolve(root, "publish-plan.json")), /index must publish once and last/);
});

test("rejects private rights-record fields from public manifests", async () => {
  const { root, manifest } = await fixture();
  manifest.rights.authorityConfirmed = true;
  await writeFile(resolve(root, "registry", "mods", "123.json"), JSON.stringify(manifest));
  await assert.rejects(validatePublishPlan(resolve(root, "publish-plan.json")), /private and cannot be published/);
});

test("prepares metadata-first revocation without remote mutation", async () => {
  const { root } = await fixture();
  const output = resolve(root, "revocation");
  const plan = await prepareRevocation(resolve(root, "registry", "mods", "123.json"), output);
  assert.equal(plan.operations[0].kind, "denied-metadata");
  assert.equal(plan.operations[1].kind, "delete");
  assert.equal(plan.operations.at(-2).kind, "purge-urls");
  assert.equal(plan.operations.at(-1).kind, "verify-placeholders");
  const revoked = JSON.parse(await readFile(resolve(output, "registry", "mods", "123.json"), "utf8"));
  assert.equal(revoked.rights.status, "revoked");
  assert.equal(revoked.assets["creature:rex"].status, "withdrawn");
});

async function officialFixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dds-official-tooling-"));
  temporaryDirectories.push(root);
  const bytes = Buffer.alloc(20);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(12, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8L", 12, "ascii");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const objectKey = `official/creatures/rex.v1.${hash}.webp`;
  await mkdir(resolve(root, "official", "creatures"), { recursive: true });
  await mkdir(resolve(root, "registry"), { recursive: true });
  await writeFile(resolve(root, objectKey), bytes);
  const manifest = {
    schemaVersion: 1,
    rights: {
      status: "official-reference-policy",
      policyId: "OFFICIAL-POLICY-1",
      reviewedAt: "2026-08-27",
      reviewState: "approved",
      distributionEligible: true,
      scope: ["creature-icons"],
    },
    assets: {
      "creature:rex": { status: "active", path: `/${objectKey}`, version: 1, sha256: hash },
    },
  };
  const index = {
    schemaVersion: 1,
    registryVersion: 2,
    generatedAt: "2026-08-27T00:00:00Z",
    official: { manifest: "/registry/official.json", version: 2 },
    mods: {},
  };
  const plan = {
    schemaVersion: 1,
    bucket: "dinodepot-assets",
    publicOrigin: "https://assets.dinodepot-studio.app",
    defaultDenyValidated: true,
    operations: [
      { order: 1, kind: "asset", localFile: objectKey, objectKey, cacheControl: RIGHTS_ASSET_CACHE_CONTROL },
      { order: 2, kind: "manifest", localFile: "registry/official.json", objectKey: "registry/official.json", cacheControl: RIGHTS_REGISTRY_CACHE_CONTROL },
      { order: 3, kind: "index", localFile: "registry/index.json", objectKey: "registry/index.json", cacheControl: RIGHTS_REGISTRY_CACHE_CONTROL },
    ],
  };
  await writeFile(resolve(root, "registry/official.json"), JSON.stringify(manifest));
  await writeFile(resolve(root, "registry/index.json"), JSON.stringify(index));
  await writeFile(resolve(root, "publish-plan.json"), JSON.stringify(plan));
  return { root, manifest, index, hash, objectKey };
}

test("validates an approved official registry-last publish plan", async () => {
  const { root } = await officialFixture();
  const result = await validatePublishPlan(resolve(root, "publish-plan.json"));
  assert.equal(result.operations[0].kind, "asset");
  assert.equal(result.operations[1].objectKey, "registry/official.json");
});

test("prepares fail-closed official and mod metadata status plans", async () => {
  const official = await officialFixture();
  const officialOutput = resolve(official.root, "official-status");
  const officialResult = await prepareStatusChange("official", resolve(official.root, "registry"), officialOutput, {
    assets: { "creature:rex": "disabled" },
  });
  assert.equal(officialResult.manifest.assets["creature:rex"].status, "disabled");
  assert.equal((await validatePublishPlan(resolve(officialOutput, "publish-plan.json"))).mode, "metadata");

  const mod = await fixture();
  const modOutput = resolve(mod.root, "mod-status");
  const modResult = await prepareStatusChange("mod", resolve(mod.root, "registry"), modOutput, {
    modId: 123,
    rightsStatus: "requested",
  });
  assert.equal(modResult.manifest.rights.status, "requested");
  assert.equal(modResult.manifest.assets["creature:rex"].status, "disabled");
  assert.equal((await validatePublishPlan(resolve(modOutput, "publish-plan.json"))).mode, "metadata");
});

test("status commands cannot manufacture approval", async () => {
  const { root, manifest } = await officialFixture();
  manifest.rights.reviewState = "not-reviewed";
  manifest.rights.distributionEligible = false;
  manifest.rights.scope = [];
  manifest.assets["creature:rex"].status = "disabled";
  await writeFile(resolve(root, "registry/official.json"), JSON.stringify(manifest));
  await assert.rejects(
    prepareStatusChange("official", resolve(root, "registry"), resolve(root, "status"), {
      reviewState: "approved",
      distributionEligible: true,
    }),
    /approval must come from a validated official prepare command/,
  );
});

test("stages sanitized official fragments into complete registry files", async () => {
  const { root, manifest, index, hash, objectKey } = await officialFixture();
  const staging = resolve(root, "staging");
  const registry = resolve(root, "source-registry");
  await mkdir(resolve(staging, "metadata"), { recursive: true });
  await mkdir(registry, { recursive: true });
  const disabled = structuredClone(manifest);
  disabled.rights = {
    status: "official-reference-policy",
    policyId: "QUARANTINE",
    reviewedAt: "2026-08-27",
    reviewState: "not-reviewed",
    distributionEligible: false,
    scope: [],
  };
  disabled.assets["creature:rex"].status = "disabled";
  await writeFile(resolve(registry, "official.json"), JSON.stringify(disabled));
  await writeFile(resolve(registry, "index.json"), JSON.stringify(index));
  await writeFile(resolve(staging, "metadata/sanitized-fragment.json"), JSON.stringify({
    schemaVersion: 1,
    rights: manifest.rights,
    assetKey: "creature:rex",
    asset: { status: "active", path: `/${objectKey}`, version: 1, sha256: hash },
  }));
  const result = await stagePreparedAsset(staging, registry);
  assert.equal(result.manifest.rights.policyId, "OFFICIAL-POLICY-1");
  assert.equal(result.manifest.assets["creature:rex"].status, "active");
  assert.equal(result.index.official.version, index.official.version + 1);
});
