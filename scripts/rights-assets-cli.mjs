import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  prepareRevocation,
  prepareStatusChange,
  stagePreparedAsset,
  validatePublishPlan,
} from "./rights-assets-tooling.mjs";

const DEFAULT_REGISTRY = "Public_Content/Asset_Registry/registry";
const VALUE_OPTIONS = new Set([
  "asset",
  "distribution-eligible",
  "registry",
  "review-state",
  "rights-status",
  "scope",
]);

function usage() {
  console.error(`usage:
  npm run rights:assets -- mod prepare <record.json> <terms.md> <source-image> <creature|item> <asset-id> <version> <output-dir> --rights-status <author-approved|license-approved> [--registry <dir>]
  npm run rights:assets -- official prepare <policy.json> <terms.md> <source-image> <creature|item|map> <asset-id> <version> <output-dir> [--registry <dir>]
  npm run rights:assets -- mod status <ModID> <output-dir> [--rights-status <state>] [--scope <csv>] [--asset <key=state>]... [--registry <dir>]
  npm run rights:assets -- official status <output-dir> [--review-state <state>] [--distribution-eligible <true|false>] [--scope <csv>] [--asset <key=state>]... [--registry <dir>]
  npm run rights:assets -- <mod|official> revoke [ModID] <output-dir> [--registry <dir>]
  npm run rights:assets -- publish <publish-plan.json> [--execute]`);
  process.exit(2);
}

function parse(raw) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < raw.length; index += 1) {
    const value = raw[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "execute") {
      options.set(key, ["true"]);
      continue;
    }
    if (!VALUE_OPTIONS.has(key) || index + 1 >= raw.length || raw[index + 1].startsWith("--")) usage();
    const values = options.get(key) ?? [];
    values.push(raw[index + 1]);
    options.set(key, values);
    index += 1;
  }
  return { positional, options };
}

function one(options, key, fallback) {
  const values = options.get(key);
  if (!values) return fallback;
  if (values.length !== 1) throw new Error(`--${key} may be supplied once`);
  return values[0];
}

function allowOnly(options, allowed) {
  for (const key of options.keys()) {
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for this command`);
  }
}

function scopes(options) {
  const value = one(options, "scope");
  if (value === undefined) return undefined;
  const result = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (result.length === 0) throw new Error("--scope cannot be empty");
  return result;
}

function assets(options) {
  const result = {};
  for (const value of options.get("asset") ?? []) {
    const separator = value.lastIndexOf("=");
    if (separator <= 0 || separator === value.length - 1) throw new Error(`invalid --asset value: ${value}`);
    result[value.slice(0, separator)] = value.slice(separator + 1);
  }
  return result;
}

function booleanOption(options, key) {
  const value = one(options, key);
  if (value === undefined) return undefined;
  if (value !== "true" && value !== "false") throw new Error(`--${key} must be true or false`);
  return value === "true";
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: resolve("."), env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with status ${result.status}`);
}

async function prepare(namespace, positional, options) {
  if (positional.length !== 7) usage();
  allowOnly(options, new Set(namespace === "mod" ? ["registry", "rights-status"] : ["registry"]));
  const registry = resolve(one(options, "registry", DEFAULT_REGISTRY));
  const output = resolve(positional[6]);
  const rustArgs = [
    "run",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--bin",
    "rights_asset_publisher",
    "--",
    namespace,
    "prepare",
    ...positional,
  ];
  if (namespace === "mod") {
    const rightsStatus = one(options, "rights-status");
    if (!rightsStatus) throw new Error("mod prepare requires --rights-status matching the private record approvalBasis");
    rustArgs.push(rightsStatus);
  }
  run("cargo", rustArgs);
  const staged = await stagePreparedAsset(output, registry);
  const plan = await validatePublishPlan(resolve(output, "publish-plan.json"));
  console.log(`Staged ${staged.namespace} asset and validated ${plan.operations.length} registry-last operations at ${output}.`);
}

async function status(namespace, positional, options) {
  allowOnly(
    options,
    new Set(namespace === "mod"
      ? ["asset", "registry", "rights-status", "scope"]
      : ["asset", "distribution-eligible", "registry", "review-state", "scope"]),
  );
  const registry = resolve(one(options, "registry", DEFAULT_REGISTRY));
  if (namespace === "mod") {
    if (positional.length !== 2 || !/^\d+$/.test(positional[0])) usage();
    await prepareStatusChange("mod", registry, resolve(positional[1]), {
      modId: Number(positional[0]),
      rightsStatus: one(options, "rights-status"),
      scope: scopes(options),
      assets: assets(options),
    });
    await validatePublishPlan(resolve(positional[1], "publish-plan.json"));
    console.log(`Prepared validated mod metadata plan at ${resolve(positional[1])}. No remote state changed.`);
    return;
  }
  if (positional.length !== 1) usage();
  await prepareStatusChange("official", registry, resolve(positional[0]), {
    reviewState: one(options, "review-state"),
    distributionEligible: booleanOption(options, "distribution-eligible"),
    scope: scopes(options),
    assets: assets(options),
  });
  await validatePublishPlan(resolve(positional[0], "publish-plan.json"));
  console.log(`Prepared validated official metadata plan at ${resolve(positional[0])}. No remote state changed.`);
}

async function revoke(namespace, positional, options) {
  allowOnly(options, new Set(["registry"]));
  const registry = resolve(one(options, "registry", DEFAULT_REGISTRY));
  if (namespace === "mod") {
    if (positional.length !== 2 || !/^\d+$/.test(positional[0])) usage();
    await prepareRevocation(resolve(registry, "mods", `${positional[0]}.json`), resolve(positional[1]));
    console.log(`Prepared mod revocation plan at ${resolve(positional[1])}. No remote state changed.`);
    return;
  }
  if (positional.length !== 1) usage();
  await prepareRevocation(resolve(registry, "official.json"), resolve(positional[0]));
  console.log(`Prepared official revocation plan at ${resolve(positional[0])}. No remote state changed.`);
}

async function main() {
  const namespace = process.argv[2];
  const action = process.argv[3];
  if (namespace === "publish") {
    const { positional, options } = parse(process.argv.slice(3));
    allowOnly(options, new Set(["execute"]));
    if (positional.length !== 1) usage();
    const args = [resolve("scripts/publish-rights-assets.mjs"), resolve(positional[0])];
    if (options.has("execute")) args.push("--execute");
    run(process.execPath, args);
    return;
  }
  if (!["mod", "official"].includes(namespace) || !["prepare", "status", "revoke"].includes(action)) usage();
  const { positional, options } = parse(process.argv.slice(4));
  if (action === "prepare") return prepare(namespace, positional, options);
  if (action === "status") return status(namespace, positional, options);
  return revoke(namespace, positional, options);
}

main().catch((error) => {
  console.error(`REJECT MAINTAINER ACTION: ${error.message}`);
  process.exit(1);
});
