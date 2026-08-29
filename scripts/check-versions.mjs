#!/usr/bin/env node
/**
 * Checks that every place this app states its version agrees.
 *
 * Four files carry it, and they are updated by hand: package.json, Cargo.toml,
 * tauri.conf.json, and the STUDIO_VERSION constant the UI and the project
 * manifest read. A disagreement between them is not cosmetic - the updater
 * compares the version in `latest.json` against the one baked into the running
 * binary, so a mismatch is how an installer ships a build that then offers to
 * "update" the user back to what they already have, or refuses a real update.
 *
 * Run before any release build:
 *
 *     node scripts/check-versions.mjs
 *
 * With `--set <version>` it writes the version to all four instead of checking.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/** Each source of truth, and how to read the version out of it. */
const SOURCES = [
  {
    label: "package.json",
    file: "package.json",
    read: (text) => JSON.parse(text).version,
    write: (text, version) =>
      text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    label: "src-tauri/Cargo.toml",
    file: "src-tauri/Cargo.toml",
    // Only the [package] version - the first one in the file. A dependency's
    // `version = "2"` must not be mistaken for the app's.
    read: (text) => /^version\s*=\s*"([^"]+)"/m.exec(text)?.[1],
    write: (text, version) =>
      text.replace(/^version\s*=\s*"[^"]+"/m, `version = "${version}"`),
  },
  {
    label: "src-tauri/tauri.conf.json",
    file: "src-tauri/tauri.conf.json",
    read: (text) => JSON.parse(text).version,
    write: (text, version) =>
      text.replace(/("version":\s*")[^"]+(")/, `$1${version}$2`),
  },
  {
    label: "src/model/studio.ts",
    file: "src/model/studio.ts",
    read: (text) => /STUDIO_VERSION\s*=\s*"([^"]+)"/.exec(text)?.[1],
    write: (text, version) =>
      text.replace(
        /(STUDIO_VERSION\s*=\s*")[^"]+(")/,
        `$1${version}$2`,
      ),
  },
];

const setIndex = process.argv.indexOf("--set");
const target = setIndex === -1 ? null : process.argv[setIndex + 1];

if (target !== null) {
  if (!SEMVER.test(target)) {
    console.error(`'${target}' is not a SemVer version (expected e.g. 1.2.3).`);
    process.exit(1);
  }
  for (const source of SOURCES) {
    const path = join(root, source.file);
    const text = readFileSync(path, "utf8");
    const next = source.write(text, target);
    if (next === text && source.read(text) !== target) {
      console.error(`Could not set the version in ${source.label}.`);
      process.exit(1);
    }
    writeFileSync(path, next);
    console.log(`  ${source.label} -> ${target}`);
  }
  console.log(`\nAll four now say ${target}.`);
  process.exit(0);
}

const found = SOURCES.map((source) => ({
  label: source.label,
  version: source.read(readFileSync(join(root, source.file), "utf8")),
}));

let failed = false;
for (const entry of found) {
  if (!entry.version) {
    console.error(`✗ ${entry.label}: no version found`);
    failed = true;
  } else if (!SEMVER.test(entry.version)) {
    console.error(`✗ ${entry.label}: '${entry.version}' is not SemVer`);
    failed = true;
  }
}

const distinct = new Set(found.map((e) => e.version));
if (distinct.size > 1) {
  console.error("✗ These files disagree about the version:");
  for (const entry of found) console.error(`    ${entry.label}: ${entry.version}`);
  failed = true;
}

if (failed) {
  console.error(
    "\nFix the versions before building a release - the updater compares this " +
      "against what is in latest.json.",
  );
  process.exit(1);
}

console.log(`✓ All four agree: ${found[0].version}`);
