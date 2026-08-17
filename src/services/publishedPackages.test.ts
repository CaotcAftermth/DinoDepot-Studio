import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Verifies the published packages exactly as a checkout produces them.
 *
 * This runs against the working tree, so on CI it runs against a fresh clone —
 * which is the case that matters. Package integrity is a SHA-256 over literal
 * bytes, so anything that rewrites those bytes in transit breaks it. Git's
 * end-of-line translation did exactly that: with core.autocrlf=true and no
 * .gitattributes rule, every manifest checked out with CRLF, changing both its
 * length and its hash. A release build would then bundle an official package
 * that failed its own integrity check and fell back to default icons, while
 * the developer's own working tree stayed fine.
 */

const root = path.resolve(__dirname, "../../Public_Content");
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
}

interface Manifest {
  packageId: string;
  version: string;
  content: ManifestFile;
  assets?: ManifestFile[];
}

/** Every failure this package would hit at install time, as plain strings. */
function verify(manifestPath: string, expectedIntegrity: string): string[] {
  const problems: string[] = [];
  if (!existsSync(manifestPath)) return [`missing manifest ${manifestPath}`];

  const raw = readFileSync(manifestPath);
  if (sha256(raw) !== expectedIntegrity.toLowerCase()) {
    problems.push("manifest does not match the integrity pinned in its index");
  }
  const manifest = JSON.parse(raw.toString("utf8")) as Manifest;
  const dir = path.dirname(manifestPath);

  for (const file of [manifest.content, ...(manifest.assets ?? [])]) {
    const filePath = path.join(dir, file.path);
    if (!existsSync(filePath)) {
      problems.push(`missing file ${file.path}`);
      continue;
    }
    const bytes = readFileSync(filePath);
    if (bytes.length !== file.size) {
      problems.push(`${file.path} is ${bytes.length} bytes, manifest says ${file.size}`);
    } else if (sha256(bytes) !== file.sha256.toLowerCase()) {
      problems.push(`${file.path} does not match its manifest hash`);
    }
  }

  const content = JSON.parse(
    readFileSync(path.join(dir, manifest.content.path)).toString("utf8"),
  ) as { icons?: Record<string, string> };
  const assets = new Set(
    (manifest.assets ?? []).map((asset) => asset.path.toLowerCase()),
  );
  for (const [key, value] of Object.entries(content.icons ?? {})) {
    if (typeof value !== "string" || !value.startsWith("file:")) continue;
    if (!assets.has(value.slice(5).toLowerCase())) {
      problems.push(`icon ${key} references an asset absent from the manifest`);
    }
  }
  return problems;
}

describe("published official package", () => {
  const index = JSON.parse(
    readFileSync(path.join(root, "Official_Icons/index.json"), "utf8"),
  ) as {
    package: {
      version: string;
      integrity: string;
      versions: { version: string; manifest: string; integrity: string }[];
    };
  };

  it("advertises a version that has an immutable entry", () => {
    expect(
      index.package.versions.some(
        (entry) => entry.version === index.package.version,
      ),
    ).toBe(true);
  });

  it.each(index.package.versions.map((entry) => [entry.version, entry] as const))(
    "verifies byte-for-byte as checked out: official-asa@%s",
    (_version, entry) => {
      expect(
        verify(path.join(root, "Official_Icons", entry.manifest), entry.integrity),
      ).toEqual([]);
    },
  );
});

describe("published modpack registry", () => {
  const index = JSON.parse(
    readFileSync(path.join(root, "ModPacks/index.json"), "utf8"),
  ) as {
    packs: {
      id: string;
      version: string;
      versions: { version: string; manifest: string; integrity: string }[];
    }[];
  };

  const rows = index.packs.flatMap((pack) =>
    (pack.versions ?? []).map(
      (entry) => [`${pack.id}@${entry.version}`, entry] as const,
    ),
  );

  it("advertises only versions that have an immutable entry", () => {
    for (const pack of index.packs) {
      expect(
        (pack.versions ?? []).some((entry) => entry.version === pack.version),
        pack.id,
      ).toBe(true);
    }
  });

  it.each(rows)("verifies byte-for-byte as checked out: %s", (_name, entry) => {
    expect(
      verify(path.join(root, "ModPacks", entry.manifest), entry.integrity),
    ).toEqual([]);
  });
});

describe("repository configuration", () => {
  it("disables end-of-line translation for published packages", () => {
    // Without this the manifests above pass locally and fail on every fresh
    // clone, including the one a release build makes.
    const attributes = readFileSync(
      path.resolve(__dirname, "../../.gitattributes"),
      "utf8",
    );
    expect(attributes).toMatch(/^Public_Content\/\*\*\s+-text$/m);
  });
});
