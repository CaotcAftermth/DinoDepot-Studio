import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import officialIndex from "../../Public_Content/Official_Icons/index.json";

/**
 * The staged copy of the official package must be the one the index names.
 *
 * `src-tauri/resources/official-package` is what the desktop app installs
 * Core Content from, and the installer verifies it against the integrity in
 * `index.json`. Rebuilding the package without re-staging leaves the two
 * disagreeing, and the only symptom is the current version reporting itself
 * missing — no error names the stale copy.
 *
 * Staging is build output, so a fresh clone has nothing here yet; the check
 * only runs once something has been staged.
 */

const release = officialIndex.package;
const stagedRoot = new URL(
  "../../src-tauri/resources/official-package/",
  import.meta.url,
);
const stagedManifest = new URL(release.manifest, stagedRoot);

describe("staged official package", () => {
  it("is the version the index points at", () => {
    if (!existsSync(stagedManifest)) return;
    const manifest = JSON.parse(readFileSync(stagedManifest, "utf8")) as {
      packageId: string;
      version: string;
    };
    expect(manifest.packageId).toBe(release.id);
    expect(manifest.version).toBe(release.version);
  });

  it("matches the integrity the installer checks it against", () => {
    if (!existsSync(stagedManifest)) return;
    const bytes = readFileSync(stagedManifest);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      release.integrity.toLowerCase(),
    );
  });
});
