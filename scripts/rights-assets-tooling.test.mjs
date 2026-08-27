import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { after, test } from "node:test";
import {
  prepareRevocation,
  RIGHTS_ASSET_CACHE_CONTROL,
  RIGHTS_REGISTRY_CACHE_CONTROL,
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
      permissionId: "permission-123",
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
    publicOrigin: "https://assets.dinodepot.app",
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
