import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";
import { validatePublishPlan } from "./rights-assets-tooling.mjs";

const temporaryDirectories = [];

after(async () => {
  for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true });
});

function run(args) {
  const result = spawnSync(process.execPath, [resolve("scripts/rights-assets-cli.mjs"), ...args], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function runFailure(args) {
  const result = spawnSync(process.execPath, [resolve("scripts/rights-assets-cli.mjs"), ...args], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0, "command should have failed closed");
  return `${result.stdout}\n${result.stderr}`;
}

async function inputs() {
  const root = await mkdtemp(resolve(tmpdir(), "dds-maintainer-cli-"));
  temporaryDirectories.push(root);
  const registry = resolve(root, "registry");
  await mkdir(resolve(registry, "mods"), { recursive: true });
  const index = {
    schemaVersion: 1,
    registryVersion: 1,
    generatedAt: "2026-08-27T00:00:00Z",
    official: { manifest: "/registry/official.json", version: 1 },
    mods: {},
  };
  const official = {
    schemaVersion: 1,
    rights: {
      status: "official-reference-policy",
      policyId: "QUARANTINE",
      reviewedAt: "2026-08-27",
      reviewState: "not-reviewed",
      distributionEligible: false,
      scope: [],
    },
    assets: {},
  };
  await writeFile(resolve(registry, "index.json"), JSON.stringify(index));
  await writeFile(resolve(registry, "official.json"), JSON.stringify(official));

  const modTerms = resolve(root, "DDS-ICON-PERMISSION-v1.0.md");
  const officialTerms = resolve(root, "DDS-OFFICIAL-REFERENCE-POLICY-v1.0.md");
  await writeFile(modTerms, "immutable mod terms");
  await writeFile(officialTerms, "immutable official policy");
  const modRecord = {
    permissionId: "MOD-PERMISSION-123",
    approvalBasis: "license-approved",
    mod: { id: 123, name: "Test Mod", projectUrl: "https://example.invalid/mod" },
    grantor: { displayName: "Test Creator", platform: "test" },
    terms: {
      version: "DDS-ICON-PERMISSION-v1.0",
      sha256: createHash("sha256").update("immutable mod terms").digest("hex"),
      scope: ["creature-icons"],
      desktopApp: true,
      webViewer: true,
      maxResolution: "160x160",
      formatConversion: ["webp"],
    },
    requestedAt: "2026-08-26",
    approvedAt: "2026-08-27",
    authorityConfirmed: true,
    status: "active",
  };
  const officialRecord = {
    policyId: "OFFICIAL-POLICY-123",
    source: { displayName: "Official reference", referenceUrl: "https://example.invalid/reference" },
    terms: {
      version: "DDS-OFFICIAL-REFERENCE-POLICY-v1.0",
      sha256: createHash("sha256").update("immutable official policy").digest("hex"),
      scope: ["creature-icons"],
      desktopApp: true,
      webViewer: true,
      maxResolution: "160x160",
      formatConversion: ["webp"],
    },
    reviewedAt: "2026-08-27",
    reviewState: "approved",
    distributionEligible: true,
    status: "active",
  };
  const modRecordPath = resolve(root, "mod-record.json");
  const officialRecordPath = resolve(root, "official-record.json");
  await writeFile(modRecordPath, JSON.stringify(modRecord));
  await writeFile(officialRecordPath, JSON.stringify(officialRecord));
  return {
    root,
    registry,
    modTerms,
    officialTerms,
    modRecordPath,
    officialRecordPath,
    source: resolve("src/assets/icons/Missing_Creature_Icon.webp"),
  };
}

test("maintainer CLI prepares mod and official assets without remote mutation", async () => {
  const value = await inputs();
  const mismatch = runFailure([
    "mod", "prepare", value.modRecordPath, value.modTerms, value.source,
    "creature", "test-rex", "1", resolve(value.root, "mismatch"),
    "--rights-status", "author-approved", "--registry", value.registry,
  ]);
  assert.match(mismatch, /does not match the private permission record/);

  const modOutput = resolve(value.root, "mod-output");
  run([
    "mod", "prepare", value.modRecordPath, value.modTerms, value.source,
    "creature", "test-rex", "1", modOutput,
    "--rights-status", "license-approved", "--registry", value.registry,
  ]);
  const modPlan = await validatePublishPlan(resolve(modOutput, "publish-plan.json"));
  assert.equal(modPlan.operations.map((entry) => entry.kind).join(","), "asset,manifest,index");
  const modManifest = JSON.parse(await readFile(resolve(modOutput, "registry/mods/123.json"), "utf8"));
  assert.equal(modManifest.rights.status, "license-approved");
  assert.equal(modManifest.assets["creature:test-rex"].status, "active");
  const modStatusOutput = resolve(value.root, "mod-status-output");
  run([
    "mod", "status", "123", modStatusOutput,
    "--rights-status", "requested", "--registry", resolve(modOutput, "registry"),
  ]);
  assert.equal((await validatePublishPlan(resolve(modStatusOutput, "publish-plan.json"))).mode, "metadata");

  const officialOutput = resolve(value.root, "official-output");
  run([
    "official", "prepare", value.officialRecordPath, value.officialTerms, value.source,
    "creature", "official-rex", "1", officialOutput, "--registry", value.registry,
  ]);
  const officialPlan = await validatePublishPlan(resolve(officialOutput, "publish-plan.json"));
  assert.equal(officialPlan.operations.map((entry) => entry.kind).join(","), "asset,manifest,index");
  const officialManifest = JSON.parse(await readFile(resolve(officialOutput, "registry/official.json"), "utf8"));
  assert.equal(officialManifest.rights.reviewState, "approved");
  assert.equal(officialManifest.assets["creature:official-rex"].status, "active");
  const officialStatusOutput = resolve(value.root, "official-status-output");
  run([
    "official", "status", officialStatusOutput,
    "--asset", "creature:official-rex=disabled", "--registry", resolve(officialOutput, "registry"),
  ]);
  assert.equal((await validatePublishPlan(resolve(officialStatusOutput, "publish-plan.json"))).mode, "metadata");
  run(["publish", resolve(officialOutput, "publish-plan.json")]);
});
