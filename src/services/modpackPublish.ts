import {
  compareVersions,
  iconBaseName,
  PACK_FILE,
  PACK_ICONS_DIR,
  packDirName,
  packIconFiles,
  RegistryIndexSchema,
  registryEntryFor,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
  type RegistryIndex,
  type RegistryVersion,
} from "../model/modpack";
import {
  PACKAGE_FORMAT_VERSION,
  PackageManifestSchema,
  packageAssetV3,
  packageContentFromModpack,
  packageFile,
  packageJson,
  sha256Hex,
} from "../model/package";
import { ipc } from "./ipc";

/**
 * Getting a modpack out of the app and into the registry.
 *
 * Two routes, one assembled shape: the permanent `modpack.json`/`icons/`
 * compatibility alias plus one immutable content-addressed version. Saving it to disk and
 * opening a pull request produce byte-identical package content.
 */

/** One file of an assembled pack, ready to write or upload. */
export interface PackFile {
  /** Path relative to the pack folder. */
  path: string;
  /** Text content, for `modpack.json`. */
  text?: string;
  /** Base64 bytes, for icon images. */
  contentB64?: string;
}

export interface AssembledPack {
  dir: string;
  files: PackFile[];
  /** Icons the pack references but whose image could not be read. */
  missingIcons: string[];
  /** Exact immutable version added to index.json. */
  registryVersion: RegistryVersion | null;
  /** Complete index row, including this immutable version. */
  registryEntry: RegistryEntry | null;
  /** Byte-exact manifest, used to reject an immutable-version overwrite. */
  manifestText: string | null;
}

/**
 * Gathers a pack and its icon images into one set of files.
 *
 * Icons are optional enrichment. Missing, unsupported, or malformed pictures
 * are reported and omitted from both formats; their entries use the normal
 * default icon without preventing export or publication.
 */
export async function assemblePack(
  pack: Modpack,
  imagesDir: string,
): Promise<AssembledPack> {
  const files: PackFile[] = [];
  const missingIcons: string[] = [];
  const assetBytes = new Map<string, Uint8Array>();

  for (const icon of packIconFiles(pack)) {
    const name = iconBaseName(icon);
    if (icon !== name || !/\.(?:webp|png)$/i.test(name)) {
      missingIcons.push(icon);
      continue;
    }
    const collision = [...assetBytes.keys()].find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    if (collision) {
      throw new Error(
        `Two icon references collapse to the same package file: ${collision} and ${name}`,
      );
    }
    if (!imagesDir) {
      missingIcons.push(name);
      continue;
    }
    try {
      const contentB64 = await ipc<string>("read_file_b64", {
        path: joinPath(imagesDir, name),
      });
      const bytes = bytesFromBase64(contentB64);
      if (!hasImageSignature(name, bytes)) {
        missingIcons.push(name);
        continue;
      }
      files.push({ path: `${PACK_ICONS_DIR}/${name}`, contentB64 });
      assetBytes.set(name, bytes);
    } catch {
      missingIcons.push(name);
    }
  }

  const dir = packDirName(pack.meta);
  const available = new Set(
    [...assetBytes.keys()].map((name) => name.toLowerCase()),
  );
  const packaged = {
    ...pack,
    icons: Object.fromEntries(
      Object.entries(pack.icons).filter(([, value]) => {
        if (!value.startsWith("file:")) return true;
        const reference = value.slice(5);
        const name = iconBaseName(reference);
        return (
          reference === name &&
          /\.(?:webp|png)$/i.test(name) &&
          available.has(name.toLowerCase())
        );
      }),
    ),
  };
  files.unshift({ path: PACK_FILE, text: JSON.stringify(packaged, null, 2) });

  const content = packageContentFromModpack(packaged);
  const contentText = packageJson(content);
  const contentBytes = new TextEncoder().encode(contentText);
  const assetEntries = await Promise.all(
    [...assetBytes.entries()].map(async ([name, bytes]) => ({
      bytes,
      record: await packageAssetV3(
        `assets/${name}`,
        bytes,
        mediaTypeFor(name),
      ),
    })),
  );
  const assets = assetEntries.map(({ record }) => record);
  assets.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = PackageManifestSchema.parse({
    format: "dinodepot.package",
    formatVersion: PACKAGE_FORMAT_VERSION,
    kind: "modpack",
    packageId: pack.meta.id,
    version: pack.meta.version,
    curseforgeId: pack.meta.curseforgeId,
    publishedAt: pack.meta.updatedAt,
    meta: {
      name: pack.meta.name,
      updatedAt: pack.meta.updatedAt,
      author: pack.meta.author,
      description: pack.meta.description,
      url: pack.meta.url,
      docsUrl: pack.meta.docsUrl,
      discordUrl: pack.meta.discordUrl,
      variantTag: pack.meta.variantTag,
    },
    content: await packageFile("content.json", contentBytes, "application/json"),
    assets,
  });
  const manifestText = packageJson(manifest);
  const versionRoot = `versions/${pack.meta.version}`;
  files.push({ path: `${versionRoot}/content.json`, text: contentText });
  const emittedBlobs = new Set<string>();
  for (const { record, bytes } of assetEntries) {
    if (emittedBlobs.has(record.blob)) continue;
    emittedBlobs.add(record.blob);
    files.push({ path: record.blob, contentB64: base64FromBytes(bytes) });
  }
  files.push({ path: `${versionRoot}/manifest.json`, text: manifestText });

  const registryVersion: RegistryVersion = {
    version: pack.meta.version,
    manifest: `${dir}/${versionRoot}/manifest.json`,
    integrity: await sha256Hex(new TextEncoder().encode(manifestText)),
    publishedAt: pack.meta.updatedAt,
    packageFormat: PACKAGE_FORMAT_VERSION,
    minStudioVersion: "0.4.0",
  };
  const registryEntry: RegistryEntry = {
    ...registryEntryFor(pack),
    versions: [registryVersion],
  };

  return {
    dir,
    files,
    missingIcons,
    registryVersion,
    registryEntry,
    manifestText,
  };
}

function bytesFromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hasImageSignature(name: string, bytes: Uint8Array): boolean {
  if (/\.png$/i.test(name)) {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      String.fromCharCode(...bytes.subarray(1, 4)) === "PNG" &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    /\.webp$/i.test(name) &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  );
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const input = new Uint8Array(header.length + bytes.length);
  input.set(header);
  input.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", input as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mediaTypeFor(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase();
  return (
    {
      png: "image/png",
      webp: "image/webp",
    }[extension ?? ""] ?? "application/octet-stream"
  );
}

/** Joins with the separator already in use, so Windows paths stay Windows paths. */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[/\\]$/, "")}${sep}${name}`;
}

/** Writes an assembled pack into a folder on disk. */
export async function writePackToDisk(
  pack: AssembledPack,
  targetDir: string,
): Promise<void> {
  const immutableManifest = pack.files.find(
    (file) => /^versions\/[^/]+\/manifest\.json$/.test(file.path),
  );
  if (immutableManifest?.text !== undefined) {
    const path = joinPath(
      targetDir,
      immutableManifest.path.replace(/\//g, pathSep(targetDir)),
    );
    try {
      const existing = await ipc<string>("read_text_file", { path });
      if (existing !== immutableManifest.text) {
        throw new Error(
          "That exact package version already exists with different bytes",
        );
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /already exists with different bytes/.test(error.message)
      ) {
        throw error;
      }
      // A missing destination is the ordinary first-export case. Other read
      // failures will be surfaced by the writes below without partial claims
      // that an immutable version was successfully replaced.
    }
  }
  for (const file of pack.files) {
    const path = joinPath(targetDir, file.path.replace(/\//g, pathSep(targetDir)));
    if (file.text !== undefined) {
      await ipc("save_text_file", { path, contents: file.text });
    } else if (file.contentB64 !== undefined) {
      await ipc("save_file_b64", { path, contentB64: file.contentB64 });
    }
  }
}

function pathSep(dir: string): string {
  return dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
}

// ---------------------------------------------------------------------------
// Pull request
// ---------------------------------------------------------------------------

export interface PublishPlan {
  /** Repo the branch and commits land on — a fork unless the user can push. */
  headOwner: string;
  headRepo: string;
  branch: string;
  /** `owner:branch`, as GitHub's pull request API wants it. */
  head: string;
  forked: boolean;
  baseBranch: string;
  /** Full repo paths each file will occupy, for the confirmation step. */
  paths: string[];
}

export interface PublishResult extends PublishPlan {
  url: string;
  number: number;
}

interface GithubTextFile {
  exists: boolean;
  sha: string | null;
  content: string | null;
}

function requirePublishable(pack: AssembledPack): asserts pack is AssembledPack & {
  registryVersion: RegistryVersion;
  registryEntry: RegistryEntry;
  manifestText: string;
} {
  if (!pack.registryVersion || !pack.registryEntry || !pack.manifestText) {
    throw new Error("The immutable package could not be assembled");
  }
}

function repoPath(root: string, path: string): string {
  return root ? `${root}/${path}` : path;
}

/**
 * Adds one exact immutable version while preserving all published history.
 * A package id and a non-empty CurseForge id are both unique identities.
 */
export function mergeRegistryIndex(
  current: unknown,
  incoming: RegistryEntry,
): RegistryIndex {
  const parsed = RegistryIndexSchema.safeParse(current);
  if (!parsed.success) {
    throw new Error("The registry index is malformed; refusing to replace it");
  }
  const next = parsed.data;
  const identityConflict = next.packs.find(
    (entry) =>
      entry.id !== incoming.id &&
      Boolean(entry.curseforgeId) &&
      Boolean(incoming.curseforgeId) &&
      entry.curseforgeId === incoming.curseforgeId,
  );
  if (identityConflict) {
    throw new Error(
      `CurseForge project ${incoming.curseforgeId} is already owned by package ${identityConflict.id}`,
    );
  }

  const existing = next.packs.find((entry) => entry.id === incoming.id);
  if (
    existing?.curseforgeId &&
    incoming.curseforgeId &&
    existing.curseforgeId !== incoming.curseforgeId
  ) {
    throw new Error(
      `Package ${incoming.id} cannot change CurseForge identity from ${existing.curseforgeId} to ${incoming.curseforgeId}`,
    );
  }

  const incomingVersion = incoming.versions?.[0];
  if (!incomingVersion) {
    throw new Error(`Package ${incoming.id} has no immutable version record`);
  }
  const versions = [...(existing?.versions ?? [])];
  const sameVersion = versions.find(
    (candidate) => candidate.version === incomingVersion.version,
  );
  if (
    sameVersion &&
    sameVersion.integrity &&
    incomingVersion.integrity &&
    sameVersion.integrity !== incomingVersion.integrity
  ) {
    throw new Error(
      `Immutable package ${incoming.id}@${incomingVersion.version} already has different bytes`,
    );
  }
  if (!sameVersion) versions.push(incomingVersion);
  versions.sort((left, right) => compareVersions(left.version, right.version));

  if (existing && compareVersions(incoming.version, existing.version) < 0) {
    throw new Error(
      `Cannot publish ${incoming.id}@${incoming.version} as the compatibility alias because ${existing.version} is already newer`,
    );
  }

  const merged: RegistryEntry = {
    ...(existing ?? {}),
    ...incoming,
    versions,
  };
  return RegistryIndexSchema.parse({
    formatVersion: Math.max(3, next.formatVersion),
    packs: existing
      ? next.packs.map((entry) => (entry.id === incoming.id ? merged : entry))
      : [...next.packs, merged],
  });
}

/**
 * Works out where a submission would go, without changing anything.
 *
 * Separate from `publishPack` so the app can show exactly which repository,
 * branch and files are about to be touched *before* anything public happens —
 * opening a pull request is not something to discover after the fact.
 */
export async function planPublish(
  registry: ModpackRegistry,
  pack: AssembledPack,
): Promise<PublishPlan> {
  requirePublishable(pack);
  const info = await ipc<{ canPush: boolean; defaultBranch: string }>(
    "github_repo_info",
    { owner: registry.owner, repo: registry.repo },
  );
  const login = await ipc<string>("github_me", {});
  const forked = !info.canPush;
  const headOwner = forked ? login : registry.owner;
  const branch = `modpack/${pack.dir}-${pack.registryVersion.version}`;
  const base = registry.branch || info.defaultBranch;
  const root = registry.path.replace(/^\/|\/$/g, "");

  return {
    headOwner,
    headRepo: registry.repo,
    branch,
    head: `${headOwner}:${branch}`,
    forked,
    baseBranch: base,
    paths: [
      ...pack.files.map((file) => repoPath(root, `${pack.dir}/${file.path}`)),
      repoPath(root, "index.json"),
    ],
  };
}

/**
 * Forks if needed, commits the pack on its own branch, and opens the PR.
 *
 * Every step is idempotent — an existing fork, branch or open PR is reused —
 * so a resubmission after a failure part-way through does not leave debris or
 * open a second pull request for the same pack.
 */
export async function publishPack(
  registry: ModpackRegistry,
  pack: AssembledPack,
  plan: PublishPlan,
  meta: Modpack["meta"],
  onProgress?: (step: string) => void,
): Promise<PublishResult> {
  requirePublishable(pack);
  const say = (s: string) => onProgress?.(s);

  if (plan.forked) {
    say("Forking the registry…");
    const fork = await ipc<{ owner: string; repo: string }>("github_fork", {
      owner: registry.owner,
      repo: registry.repo,
    });
    plan = { ...plan, headOwner: fork.owner, headRepo: fork.repo, head: `${fork.owner}:${plan.branch}` };

    // A fork made months ago still points at old history; branching from a
    // stale tip would put unrelated changes in the pull request.
    say("Syncing the fork…");
    await ipc("github_sync_branch", {
      owner: plan.headOwner,
      repo: plan.headRepo,
      branch: plan.baseBranch,
      upstreamOwner: registry.owner,
      upstreamRepo: registry.repo,
      upstreamBranch: plan.baseBranch,
    }).catch(() => {
      /* a fresh fork is already current; a protected default branch is not
         ours to force — either way the branch below still works */
    });
  }

  say("Creating the branch…");
  await ipc("github_create_branch", {
    owner: plan.headOwner,
    repo: plan.headRepo,
    fromBranch: plan.baseBranch,
    branch: plan.branch,
  });

  const root = registry.path.replace(/^\/|\/$/g, "");
  const manifestPath = repoPath(root, pack.registryVersion.manifest);
  const existingManifest = await ipc<GithubTextFile>("github_get_file", {
    owner: plan.headOwner,
    repo: plan.headRepo,
    branch: plan.branch,
    path: manifestPath,
  });
  if (
    existingManifest.exists &&
    existingManifest.content !== pack.manifestText
  ) {
    throw new Error(
      `Immutable package ${meta.id}@${meta.version} already exists with different bytes`,
    );
  }

  const indexPath = repoPath(root, "index.json");
  const remoteIndex = await ipc<GithubTextFile>("github_get_file", {
    owner: plan.headOwner,
    repo: plan.headRepo,
    branch: plan.branch,
    path: indexPath,
  });
  let currentIndex: unknown = { formatVersion: 3, packs: [] };
  if (remoteIndex.exists) {
    try {
      currentIndex = JSON.parse(remoteIndex.content ?? "");
    } catch {
      throw new Error("The registry index is not valid JSON; refusing to replace it");
    }
  }
  const nextIndex = mergeRegistryIndex(currentIndex, pack.registryEntry);

  let done = 0;
  for (const file of pack.files) {
    done++;
    say(`Uploading ${file.path} (${done}/${pack.files.length})…`);
    const path = repoPath(root, `${pack.dir}/${file.path}`);
    const message = `Modpack: ${meta.name} ${meta.version} — ${file.path}`;
    if (file.text !== undefined) {
      await ipc("github_put_file", {
        owner: plan.headOwner,
        repo: plan.headRepo,
        branch: plan.branch,
        path,
        content: file.text,
        message,
      });
    } else if (file.contentB64 !== undefined) {
      if (file.path.startsWith("assets/sha256/")) {
        const existing = await ipc<GithubTextFile>("github_get_file", {
          owner: plan.headOwner,
          repo: plan.headRepo,
          branch: plan.branch,
          path,
        });
        if (existing.exists) {
          const expected = await gitBlobSha(bytesFromBase64(file.contentB64));
          if (existing.sha?.toLowerCase() !== expected) {
            throw new Error(`Content-addressed asset ${file.path} already exists with different bytes`);
          }
          continue;
        }
      }
      await ipc("github_put_file_b64", {
        owner: plan.headOwner,
        repo: plan.headRepo,
        branch: plan.branch,
        path,
        contentB64: file.contentB64,
        message,
      });
    }
  }

  say("Updating the registry index…");
  await ipc("github_put_file", {
    owner: plan.headOwner,
    repo: plan.headRepo,
    branch: plan.branch,
    path: indexPath,
    content: packageJson(nextIndex),
    message: `Registry: ${meta.name} ${meta.version}`,
  });

  say("Opening the pull request…");
  const pr = await ipc<{ url: string; number: number }>("github_open_pr", {
    owner: registry.owner,
    repo: registry.repo,
    head: plan.head,
    base: plan.baseBranch,
    title: `Modpack: ${meta.name} ${meta.version}`,
    body: prBody(meta, pack),
  });

  return { ...plan, url: pr.url, number: pr.number };
}

/** The pull request description — what a reviewer needs, in review order. */
function prBody(meta: Modpack["meta"], pack: AssembledPack): string {
  const entry = pack.registryEntry ?? registryEntryFor({ meta } as Modpack);
  const icons = pack.files.filter((f) => f.path.startsWith(`${PACK_ICONS_DIR}/`));
  const lines = [
    `**${meta.name}** \`${meta.version}\``,
    "",
    meta.description || "_No description given._",
    "",
    "| | |",
    "|---|---|",
    `| Pack id | \`${meta.id}\` |`,
    `| CurseForge | ${meta.curseforgeId ? `\`${meta.curseforgeId}\`` : "—"} |`,
    `| Mod page | ${meta.url || "—"} |`,
    `| Author | ${meta.author || "—"} |`,
    `| Icons | ${icons.length} |`,
    "",
    "### Index entry",
    "",
    "```json",
    JSON.stringify(entry, null, 2),
    "```",
    "",
    "_Submitted from Dino Depot Production Studio._",
  ];
  if (pack.missingIcons.length > 0) {
    lines.splice(
      4,
      0,
      `> ⚠ ${pack.missingIcons.length} icon image(s) could not be read and are not included: ${pack.missingIcons.join(", ")}`,
      "",
    );
  }
  return lines.join("\n");
}
