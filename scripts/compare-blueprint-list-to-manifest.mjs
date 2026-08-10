import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [listArg, manifestArg, outputArg] = process.argv.slice(2);

if (!listArg || !manifestArg) {
  console.error(
    "Usage: node scripts/compare-blueprint-list-to-manifest.mjs <blueprint-list.txt> <manifest.txt> [output-directory]",
  );
  process.exit(1);
}

const listPath = resolve(listArg);
const manifestPath = resolve(manifestArg);
const outputDir = resolve(outputArg ?? resolve(repoRoot, "exports"));
const officialCatalogPath = resolve(
  repoRoot,
  "src/assets/catalog/official-asa.json",
);

const normalizeSlashes = (value) => value.replaceAll("\\", "/").replace(/\/{2,}/g, "/");
const keyOf = (value) => normalizeSlashes(value).toLowerCase();

function unwrapBlueprintPath(value) {
  const trimmed = value.trim().replace(/^\uFEFF/, "");
  const wrapped = trimmed.match(/^(?:Blueprint|Class)'(.+)'$/i);
  return normalizeSlashes(wrapped ? wrapped[1] : trimmed);
}

function packagePathOf(blueprintPath) {
  const dot = blueprintPath.lastIndexOf(".");
  const slash = blueprintPath.lastIndexOf("/");
  return dot > slash ? blueprintPath.slice(0, dot) : blueprintPath;
}

function expectedManifestPathOf(blueprintPath) {
  const packagePath = packagePathOf(blueprintPath);
  if (packagePath.toLowerCase().startsWith("/game/")) {
    return `ShooterGame/Content/${packagePath.slice(6)}.uasset`;
  }
  return `${packagePath.replace(/^\/+/, "")}.uasset`;
}

const csvCell = (value) => {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

const toCsv = (headers, rows) =>
  `\uFEFF${[headers, ...rows]
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`;

const [listText, manifestText, catalogText] = await Promise.all([
  readFile(listPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(officialCatalogPath, "utf8"),
]);

const manifestPaths = new Map();
const manifestAssetsByFilename = new Map();

for (const line of manifestText.split(/\r?\n/)) {
  if (!line) continue;
  const tab = line.indexOf("\t");
  const path = normalizeSlashes(tab >= 0 ? line.slice(0, tab) : line);
  manifestPaths.set(keyOf(path), path);

  if (path.toLowerCase().endsWith(".uasset")) {
    const filename = basename(path).toLowerCase();
    const matches = manifestAssetsByFilename.get(filename) ?? [];
    matches.push(path);
    manifestAssetsByFilename.set(filename, matches);
  }
}

const officialCatalog = JSON.parse(catalogText);
const officialByPath = new Map(
  officialCatalog.items.map((item) => [keyOf(item.bpPath), item]),
);

const blueprintPaths = listText
  .split(/\r?\n/)
  .map(unwrapBlueprintPath)
  .filter(Boolean);

const results = blueprintPaths.map((blueprintPath, index) => {
  const expectedManifestPath = expectedManifestPathOf(blueprintPath);
  const exactPath = manifestPaths.get(keyOf(expectedManifestPath));
  const alternatePaths = exactPath
    ? []
    : (manifestAssetsByFilename.get(basename(expectedManifestPath).toLowerCase()) ?? []);
  const official = officialByPath.get(keyOf(blueprintPath));
  const status = exactPath
    ? "present"
    : alternatePaths.length > 0
      ? "listed-path-absent; same-filename-found-elsewhere"
      : "no-manifest-match";

  return {
    number: index + 1,
    name: official?.name ?? "",
    category: official?.category ?? "",
    blueprintPath,
    expectedManifestPath,
    status,
    alternatePaths,
  };
});

const noMatch = results.filter((result) => result.status === "no-manifest-match");
const stalePaths = results.filter(
  (result) => result.status === "listed-path-absent; same-filename-found-elsewhere",
);
const present = results.filter((result) => result.status === "present");

const headers = [
  "List Number",
  "Name",
  "Category",
  "Blueprint Path",
  "Expected Manifest Path",
  "Status",
  "Alternate Manifest Paths",
];
const rowOf = (result) => [
  result.number,
  result.name,
  result.category,
  result.blueprintPath,
  result.expectedManifestPath,
  result.status,
  result.alternatePaths.join(" | "),
];

const reportLines = [
  "# Official item list vs. ARK manifest",
  "",
  `- Input entries: ${results.length}`,
  `- Present at the listed path: ${present.length}`,
  `- No same-named asset anywhere in the manifest: ${noMatch.length}`,
  `- Listed path absent, but same filename found elsewhere: ${stalePaths.length}`,
  `- Total listed paths absent from the manifest: ${noMatch.length + stalePaths.length}`,
  "",
  "## No manifest match",
  "",
  ...noMatch.map(
    (result) =>
      `${result.number}. ${result.name || "(name unavailable)"} — \`${result.blueprintPath}\``,
  ),
  "",
  "## Listed path absent; same filename found elsewhere",
  "",
  ...stalePaths.flatMap((result) => [
    `${result.number}. ${result.name || "(name unavailable)"}`,
    `   - Listed: \`${result.blueprintPath}\``,
    ...result.alternatePaths.map((path) => `   - Manifest: \`${path}\``),
  ]),
  "",
];

await mkdir(outputDir, { recursive: true });
await Promise.all([
  writeFile(
    resolve(outputDir, "official-items-found-in-manifest-bp-paths.txt"),
    `${present.map((result) => result.blueprintPath).join("\r\n")}\r\n`,
    "utf8",
  ),
  writeFile(
    resolve(outputDir, "official-items-manifest-comparison.csv"),
    toCsv(headers, results.map(rowOf)),
    "utf8",
  ),
  writeFile(
    resolve(outputDir, "official-items-no-manifest-match.csv"),
    toCsv(headers, noMatch.map(rowOf)),
    "utf8",
  ),
  writeFile(
    resolve(outputDir, "official-items-stale-manifest-paths.csv"),
    toCsv(headers, stalePaths.map(rowOf)),
    "utf8",
  ),
  writeFile(
    resolve(outputDir, "official-items-manifest-report.md"),
    reportLines.join("\r\n"),
    "utf8",
  ),
]);

console.log(`Compared ${results.length} blueprint paths.`);
console.log(`Present at listed path: ${present.length}`);
console.log(`No manifest match: ${noMatch.length}`);
console.log(`Same filename elsewhere: ${stalePaths.length}`);
console.log(`Reports written to ${outputDir}`);
