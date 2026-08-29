import { resolve } from "node:path";
import { prepareRevocation } from "./rights-assets-tooling.mjs";

if (process.argv.length !== 4) {
  console.error("usage: npm run prepare:rights-revocation -- <approved-public-manifest.json> <output-dir>");
  process.exit(2);
}

try {
  const plan = await prepareRevocation(resolve(process.argv[2]), resolve(process.argv[3]));
  console.log(`Prepared ${plan.operations.length} ordered revocation operations. No remote state changed.`);
} catch (error) {
  console.error(`REJECT REVOCATION PLAN: ${error.message}`);
  process.exit(1);
}
