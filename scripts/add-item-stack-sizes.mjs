/**
 * Adds `stack` (max stack size) to the items already in
 * src/assets/catalog/official-asa.json, read from the same ark.wiki.gg
 * {{Id item|Name|Category|Stack|ItemID|ClassName|Path|…}} rows the catalog
 * was built from.
 *
 * Deliberately a merge rather than a rebuild: names, categories and paths are
 * left exactly as they are, so icon/notes/variant assignments keyed off them
 * survive. Run it after build-official-catalog.mjs, or on its own:
 *   node scripts/add-item-stack-sizes.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://ark.wiki.gg/api.php";
const UA = "DinoDepotStudio/0.1 (catalog builder)";

const ITEM_PAGES = [
  "Item IDs/Resources",
  "Item IDs/Tools",
  "Item IDs/Armor",
  "Item IDs/Saddles",
  "Item IDs/Structures",
  "Item IDs/Vehicles",
  "Item IDs/Dye",
  "Item IDs/Consumables",
  "Item IDs/Recipes",
  "Item IDs/Eggs",
  "Item IDs/Farming",
  "Item IDs/Seeds",
  "Item IDs/Weapons",
  "Item IDs/Ammunition",
  "Item IDs/Skins",
  "Item IDs/Chibi Pets",
  "Item IDs/Artifacts",
  "Item IDs/Trophy",
  "Item IDs/Unobtainable",
];

async function fetchWikitext(page) {
  const url = `${API}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`${page}: HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`${page}: ${data.error.info}`);
  return data.parse.wikitext["*"];
}

function cleanField(field) {
  return (field ?? "")
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** normalized bp path -> stack size, for every {{Id item}} row on a page. */
function parseStacks(wikitext, into) {
  for (const line of wikitext.split("\n")) {
    if (!line.startsWith("{{Id item|")) continue;
    const parts = line
      .slice(2, line.lastIndexOf("}}"))
      .split("|")
      .map(cleanField);
    // parts[0] is the template name, then Name|Category|Stack|ItemID|Class|Path.
    const [, , , stack, , , relPath] = parts;
    if (!relPath || !relPath.includes("/")) continue;
    const n = Number(String(stack).replace(/[^\d]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    into.set(`/game/${relPath}`.toLowerCase(), n);
  }
}

async function main() {
  const stacks = new Map();
  for (const page of ITEM_PAGES) {
    try {
      parseStacks(await fetchWikitext(page), stacks);
      console.log(`  ${page}: ${stacks.size} stack sizes so far`);
    } catch (e) {
      console.warn(`  ${page}: FAILED — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to the wiki
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(
    here,
    "..",
    "src",
    "assets",
    "catalog",
    "official-asa.json",
  );
  const data = JSON.parse(fs.readFileSync(outPath, "utf8"));

  let matched = 0;
  for (const item of data.items) {
    const stack = stacks.get(item.bpPath.toLowerCase());
    if (stack !== undefined) {
      item.stack = stack;
      matched++;
    }
  }

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(
    `\nStack size set on ${matched} of ${data.items.length} items in ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
