import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { validatePublishPlan } from "./rights-assets-tooling.mjs";

function usage() {
  console.error("usage: npm run publish:rights-assets -- <staging-dir>/publish-plan.json [--execute]");
  process.exit(2);
}

const args = process.argv.slice(2);
const execute = args.includes("--execute");
const positional = args.filter((arg) => arg !== "--execute");
if (positional.length !== 1 || args.some((arg) => arg.startsWith("--") && arg !== "--execute")) usage();

try {
  const plan = await validatePublishPlan(resolve(positional[0]));
  console.log(`Validated ${plan.operations.length} registry-last operations for ${plan.bucket}.`);
  for (const operation of plan.operations) console.log(`${operation.order}. ${operation.kind}: ${operation.objectKey}`);
  if (!execute) {
    console.log("Dry run only. Add --execute in an authorized maintainer environment to upload.");
    process.exit(0);
  }
  if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
    throw new Error("--execute requires CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID");
  }
  const wrangler = resolve("node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wrangler)) throw new Error("bundled Wrangler is unavailable; run npm ci");
  for (const operation of plan.operations) {
    const contentType = operation.kind === "asset" ? "image/webp" : "application/json; charset=utf-8";
    const result = spawnSync(process.execPath, [
      wrangler,
      "r2",
      "object",
      "put",
      `${plan.bucket}/${operation.objectKey}`,
      "--file",
      operation.absoluteFile,
      "--content-type",
      contentType,
      "--cache-control",
      operation.cacheControl,
      "--remote",
    ], { env: process.env, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`upload failed before operation ${operation.order} completed`);
  }
  console.log("Asset, manifest, and index uploaded in validated order.");
} catch (error) {
  console.error(`REJECT PUBLICATION: ${error.message}`);
  process.exit(1);
}
