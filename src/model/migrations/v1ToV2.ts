import { PROJECT_FORMAT } from "../manifest";
import { remoteUrlFor } from "../localState";
import { PROJECT_FILE } from "../project";
import type { MigrationOutcome, MigrationStep, ProjectFiles } from "./types";

/**
 * Schema 1 → 2.
 *
 * Three things change, and all three exist because schema 1 stored things in
 * the project that were never true of the project:
 *
 * 1. The project gains an immutable `projectId`. Until now a project was
 *    identified by its folder path and its repository name, both of which
 *    change — a rename orphaned every binding that pointed at it.
 * 2. The GitHub repository and the two local folder paths move out to
 *    machine-local state. Sharing a project meant sharing one administrator's
 *    `C:\Users\…` paths, and the first save on the other machine overwrote
 *    them right back.
 * 3. `github.paths` becomes `outputPaths`. The layout inside the repository is
 *    genuinely shared; the repository is not, and keeping them in one object
 *    is what made the mistake easy to make.
 *
 * The recorded IP is stripped from stored profile summaries at the same time.
 * It is personal data that a shared project has no business carrying, and this
 * is the last moment before the roster starts synchronizing.
 */
export const v1ToV2: MigrationStep = {
  from: 1,
  to: 2,
  describe: "Give the project a permanent id and separate machine settings from shared ones",

  run(files: ProjectFiles, context): MigrationOutcome {
    const notes: string[] = [];
    const next: ProjectFiles = { ...files };

    const raw = JSON.parse(files[PROJECT_FILE.settings]) as Record<string, unknown>;
    const github = asRecord(raw.github);
    const paths = asRecord(github.paths);

    // Unknown keys are carried through rather than dropped: a field this build
    // has never heard of belongs to somebody, and a migration is the worst
    // possible place to decide it does not matter.
    const {
      github: _github,
      imagesDir: _imagesDir,
      modsDir: _modsDir,
      schemaVersion: _schemaVersion,
      ...carried
    } = raw;

    const manifest = {
      format: PROJECT_FORMAT,
      projectId: context.projectId,
      // Adjacent migrations must never point at the moving current constants:
      // this step permanently produces schema 2, even after schema 3 ships.
      schemaVersion: 2,
      minimumStudioVersion: "0.2.0",
      // Schema 1 never recorded when a project was made. Stamping the
      // migration time is honest — it is the oldest moment we can prove.
      createdAt: context.now.toISOString(),
      capabilities: {},
      ...carried,
      outputPaths: paths,
    };
    next[PROJECT_FILE.settings] = `${JSON.stringify(manifest, null, 2)}\n`;
    notes.push(`Gave the project its permanent id (${context.projectId})`);

    const owner = asString(github.owner);
    const repo = asString(github.repo);
    const branch = asString(github.branch) || "main";
    const localHints: MigrationOutcome["localHints"] = {
      imagesDir: asString(raw.imagesDir),
      modsDir: asString(raw.modsDir),
    };
    if (owner && repo) {
      // Bound by name only — schema 1 never knew GitHub's numeric id. The
      // binding is completed the first time the repository is reached, which
      // is also when a rename since the last session gets noticed.
      localHints.source = {
        githubId: "",
        owner,
        name: repo,
        remoteUrl: remoteUrlFor(owner, repo),
        branch,
        isPrivate: true,
        hasPages: false,
      };
      notes.push(`Remembered ${owner}/${repo} as this machine's project repository`);
    }
    if (localHints.imagesDir || localHints.modsDir) {
      notes.push("Moved the image and mod folder settings to this machine only");
    }

    const playersText = files[PROJECT_FILE.players];
    if (playersText) {
      const stripped = stripLastKnownIp(playersText);
      if (stripped.removed > 0) {
        next[PROJECT_FILE.players] = stripped.text;
        notes.push(
          `Removed the recorded IP address from ${stripped.removed} stored profile ${
            stripped.removed === 1 ? "summary" : "summaries"
          }`,
        );
      }
    }

    return { files: next, localHints, notes };
  },
};

/**
 * Drops `lastKnownIp` wherever it appears in the roster.
 *
 * Walks the tree rather than reaching into `players[].profile.summary`,
 * because the field also lands on clean-slate summaries — and a privacy sweep
 * that only covers the places it was expected is not a sweep.
 */
function stripLastKnownIp(text: string): { text: string; removed: number } {
  let removed = 0;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "lastKnownIp") {
        if (typeof child === "string" && child.trim()) removed++;
        continue;
      }
      out[key] = walk(child);
    }
    return out;
  };
  const cleaned = walk(JSON.parse(text));
  return { text: `${JSON.stringify(cleaned, null, 2)}\n`, removed };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
