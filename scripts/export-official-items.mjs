import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(
  repoRoot,
  "src/assets/catalog/official-asa.json",
);
const outputDir = resolve(repoRoot, "exports");

const catalog = JSON.parse(await readFile(sourcePath, "utf8"));
const items = catalog.items;

if (!Array.isArray(items)) {
  throw new Error("Official catalog does not contain an item array.");
}

const csvCell = (value) => {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const csvRows = [
  ["Number", "Name", "Category", "Blueprint Path", "Stack Size"],
  ...items.map((item, index) => [
    index + 1,
    item.name,
    item.category,
    item.bpPath,
    item.stack,
  ]),
];

const csv = `\uFEFF${csvRows
  .map((row) => row.map(csvCell).join(","))
  .join("\r\n")}\r\n`;

const names = [
  `Official ASA items (${items.length})`,
  `Source: ${catalog.source}`,
  `Catalog generated: ${catalog.generatedAt}`,
  "",
  ...items.map((item, index) => `${index + 1}. ${item.name}`),
  "",
].join("\r\n");

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(resolve(outputDir, "official-asa-items.csv"), csv, "utf8"),
  writeFile(
    resolve(outputDir, "official-asa-item-names.txt"),
    names,
    "utf8",
  ),
]);

console.log(`Exported ${items.length} Official ASA items to ${outputDir}`);
