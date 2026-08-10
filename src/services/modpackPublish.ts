import {
  iconBaseName,
  PACK_FILE,
  PACK_ICONS_DIR,
  packDirName,
  packIconFiles,
  registryEntryFor,
  type Modpack,
  type ModpackRegistry,
} from "../model/modpack";
import { ipc } from "./ipc";

/**
 * Getting a modpack out of the app and into the registry.
 *
 * Two routes, one shape: a folder holding `modpack.json` and an `icons/`
 * subfolder. Saving it to disk and opening a pull request produce byte-identical
 * content, so what a submitter reviews locally is exactly what gets proposed.
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
}

/**
 * Gathers a pack and its icon images into one set of files.
 *
 * An icon that cannot be read is reported rather than aborting: the pack is
 * still worth publishing without it, and silently shipping a `file:` reference
 * to an image that is not there would be worse than saying so.
 */
export async function assemblePack(
  pack: Modpack,
  imagesDir: string,
): Promise<AssembledPack> {
  const files: PackFile[] = [
    { path: PACK_FILE, text: JSON.stringify(pack, null, 2) },
  ];
  const missingIcons: string[] = [];

  for (const icon of packIconFiles(pack)) {
    const name = iconBaseName(icon);
    if (!imagesDir) {
      missingIcons.push(name);
      continue;
    }
    try {
      const contentB64 = await ipc<string>("read_file_b64", {
        path: joinPath(imagesDir, name),
      });
      files.push({ path: `${PACK_ICONS_DIR}/${name}`, contentB64 });
    } catch {
      missingIcons.push(name);
    }
  }

  return { dir: packDirName(pack.meta), files, missingIcons };
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
  const info = await ipc<{ canPush: boolean; defaultBranch: string }>(
    "github_repo_info",
    { owner: registry.owner, repo: registry.repo },
  );
  const login = await ipc<string>("github_me", {});
  const forked = !info.canPush;
  const headOwner = forked ? login : registry.owner;
  const branch = `modpack/${pack.dir}`;
  const base = registry.branch || info.defaultBranch;
  const root = registry.path.replace(/^\/|\/$/g, "");

  return {
    headOwner,
    headRepo: registry.repo,
    branch,
    head: `${headOwner}:${branch}`,
    forked,
    baseBranch: base,
    paths: pack.files.map((f) => `${root}/${pack.dir}/${f.path}`),
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
  let done = 0;
  for (const file of pack.files) {
    done++;
    say(`Uploading ${file.path} (${done}/${pack.files.length})…`);
    const path = `${root}/${pack.dir}/${file.path}`;
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
  const entry = registryEntryFor({ meta } as Modpack);
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
