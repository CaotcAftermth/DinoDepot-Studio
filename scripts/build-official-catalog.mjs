/**
 * Builds src/assets/catalog/official-asa.json from ark.wiki.gg data.
 *
 * Parses {{Id creature|Name|Category|NameTag|EntityID|Path}} and
 * {{Id item|Name|Category|Stack|ItemID|ClassName|Path|...}} template rows
 * from the wiki's Entity ID pages via the MediaWiki API.
 *
 * Run manually when the official content set needs refreshing:
 *   node scripts/build-official-catalog.mjs
 */

import fs from "node:fs";
import { withFertilizedEggs } from "./fertilized-eggs.mjs";
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
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, "$1") // [[link|text]] -> text
    .replace(/<[^>]+>/g, "")
    .trim();
}

/** Splits template args on top-level pipes (template has no nested {{ }} in practice). */
function templateArgs(line, templateName) {
  const inner = line.slice(2, line.lastIndexOf("}}"));
  const parts = inner.split("|").map(cleanField);
  if (parts[0]?.toLowerCase() !== templateName.toLowerCase()) return null;
  return parts.slice(1);
}

function parseCreatures(wikitext) {
  const creatures = [];
  for (const line of wikitext.split("\n")) {
    if (!line.startsWith("{{Id creature|")) continue;
    const args = templateArgs(line, "Id creature");
    if (!args) continue;
    const [name, category, , , relPath] = args;
    if (!name || !relPath || !relPath.includes("/")) continue;
    creatures.push({
      name,
      category: category || "",
      bpPath: `/Game/${relPath}`,
    });
  }
  return creatures;
}

function parseItems(wikitext, fallbackCategory) {
  const items = [];
  for (const line of wikitext.split("\n")) {
    if (!line.startsWith("{{Id item|")) continue;
    const args = templateArgs(line, "Id item");
    if (!args) continue;
    const [name, category, , , , relPath] = args;
    if (!name || !relPath || !relPath.includes("/")) continue;
    items.push({
      name,
      category: category || fallbackCategory,
      bpPath: `/Game/${relPath}`,
    });
  }
  return items;
}

function dedupeByPath(entries) {
  const seen = new Map();
  for (const entry of entries) {
    const key = entry.bpPath.toLowerCase();
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function main() {
  console.log("Fetching Creature IDs…");
  const creatures = parseCreatures(await fetchWikitext("Creature_IDs"));
  console.log(`  ${creatures.length} creatures`);

  let items = [];
  for (const page of ITEM_PAGES) {
    const category = page.split("/")[1];
    try {
      const pageItems = parseItems(await fetchWikitext(page), category);
      console.log(`  ${page}: ${pageItems.length} items`);
      items.push(...pageItems);
    } catch (e) {
      console.warn(`  ${page}: FAILED — ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 300)); // be polite to the wiki
  }

  // The wiki lists the egg a creature lays, never the fertilized counterpart
  // ARK also ships. Derived here so a rebuild keeps them rather than dropping
  // 80 entries that production rules may already reference.
  const { fertilizedEggsAdded, ...output } = withFertilizedEggs({
    source: "ark.wiki.gg Entity ID pages",
    generatedAt: new Date().toISOString(),
    creatures: dedupeByPath(creatures),
    items: dedupeByPath(items),
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const outPath = path.join(here, "..", "src", "assets", "catalog", "official-asa.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(
    `\nWrote ${output.creatures.length} creatures and ${output.items.length} items to ${outPath}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
