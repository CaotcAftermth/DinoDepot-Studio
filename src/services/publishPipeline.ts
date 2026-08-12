import * as git from "./gitRepo";
import { ipc } from "./ipc";
import { asStudioError, StudioError } from "../model/errors";
import { newId } from "../model/ids";
import { encodeCommitMessage, StructuredActionSchema } from "../model/commitActions";
import {
  buildArtifact,
  describeViolation,
  isDeployed,
  PUBLIC_ROOT,
  scanPublicBoundary,
  type ArtifactInput,
  type BuildManifest,
  type PublicFiles,
} from "../model/publishArtifact";
import type { LocalProjectState } from "../model/localState";
import type { ValidationReport } from "../validation/project";

/**
 * Publish: turning a synchronized project into the public site.
 *
 * Three things make this different from Sync:
 *
 * 1. It requires **synchronized source**. Publishing from unsynchronized work
 *    would put a site on the web that no repository can explain, and the
 *    manifest's `sourceRevision` would name a commit nobody else has.
 * 2. Generated output is **replaced, not merged**. A creature removed from the
 *    project must disappear from the site, and two machines' generated files
 *    have no authorship to reconcile.
 * 3. It is **one commit**. The old path wrote each output separately, so a
 *    failure halfway left a site that was half last week's.
 */

/** How long to wait for GitHub Pages before saying so. */
const DEPLOY_TIMEOUT_MS = 5 * 60 * 1000;
const DEPLOY_POLL_MS = 10_000;

export type PublishStage =
  | "checking"
  | "generating"
  | "scanning"
  | "sending"
  | "waiting-for-pages"
  | "live"
  | "timed-out"
  | "blocked";

export const PUBLISH_STAGE_LABELS: Record<PublishStage, string> = {
  checking: "Checking the project",
  generating: "Building the site",
  scanning: "Checking nothing private is included",
  sending: "Publishing",
  "waiting-for-pages": "Waiting for GitHub Pages",
  live: "Live",
  "timed-out": "Published — GitHub Pages is taking a while",
  blocked: "Cannot publish yet",
};

export interface PublishContext {
  /** Working copy of the *delivery* repository. Not the project folder. */
  deliveryDir: string;
  local: LocalProjectState;
  /** The source commit the project is synchronized to. */
  sourceRevision: string;
  projectId: string;
  /** Runs the whole project validation. */
  validate(): ValidationReport;
  /** Generates the viewer. Called only after validation passes. */
  generate(): Omit<ArtifactInput, "projectId" | "sourceRevision" | "publishOperationId">;
  accountId(): Promise<string>;
  saveLocal(patch: Partial<LocalProjectState>): Promise<void>;
  /** Whether the administrator has accepted the outstanding warnings. */
  warningsAcknowledged?: boolean;
  onStage?(stage: PublishStage): void;
  /** Fetches the live manifest. Absent skips deployment polling. */
  fetchLiveManifest?(): Promise<unknown>;
  /** Overridable so tests do not wait five minutes. */
  now?(): number;
  sleep?(ms: number): Promise<void>;
}

export interface PublishOutcome {
  stage: PublishStage;
  message: string;
  /** The delivery commit, once pushed. */
  commit: string;
  sourceRevision: string;
  manifest: BuildManifest | null;
  error: StudioError | null;
}

function outcome(over: Partial<PublishOutcome>): PublishOutcome {
  return {
    stage: "blocked",
    message: "",
    commit: "",
    sourceRevision: "",
    manifest: null,
    error: null,
    ...over,
  };
}

function failed(error: StudioError): PublishOutcome {
  return outcome({ stage: "blocked", message: error.message, error });
}

/**
 * Runs one Publish.
 *
 * Resolves rather than throws: every failure is something the administrator is
 * shown, and a failed Publish must leave the synchronized source intact and the
 * previous site still live.
 */
export async function publishProject(context: PublishContext): Promise<PublishOutcome> {
  const stage = (s: PublishStage) => context.onStage?.(s);
  const operationId = newId();

  // --- 1. may this project publish at all --------------------------------
  stage("checking");

  if (!context.sourceRevision) {
    return failed(
      new StudioError(
        "publish.sourceNotSynchronized",
        "Share your changes first. The public site records which version of the project it was built from, so it can only be built from a shared one.",
      ),
    );
  }

  const binding = deliveryBinding(context.local);
  if (!binding) {
    return failed(
      new StudioError(
        "repo.unavailable",
        "Choose the public site repository before publishing.",
      ),
    );
  }

  const report = context.validate();
  if (!report.publishable) {
    return failed(
      new StudioError(
        "validation.failed",
        `The project has ${report.errors} problem${report.errors === 1 ? "" : "s"} that must be fixed before it can be published.`,
        { detail: report.issues.filter((i) => i.level === "error").map((i) => `${i.where}: ${i.message}`).join("; ") },
      ),
    );
  }
  if (report.warnings > 0 && !context.warningsAcknowledged) {
    return failed(
      new StudioError(
        "validation.failed",
        `The project has ${report.warnings} warning${report.warnings === 1 ? "" : "s"}. Review them, then publish again to go ahead anyway.`,
        { detail: report.issues.filter((i) => i.level === "warning").map((i) => i.message).join("; ") },
      ),
    );
  }

  let accountId: string;
  try {
    accountId = await context.accountId();
  } catch (e) {
    return failed(asStudioError(e, "auth.missing", "Connect your GitHub account first."));
  }
  if (!accountId) {
    return failed(new StudioError("auth.missing", "Connect your GitHub account first."));
  }

  // --- 2. generate into staging ------------------------------------------
  stage("generating");
  let files: PublicFiles;
  let manifest: BuildManifest;
  try {
    const generated = context.generate();
    const built = buildArtifact({
      ...generated,
      projectId: context.projectId,
      sourceRevision: context.sourceRevision,
      publishOperationId: operationId,
    });
    files = built.files;
    manifest = built.manifest;
  } catch (e) {
    return failed(asStudioError(e, "unknown", "The public site could not be built."));
  }

  // --- 3. the boundary check ---------------------------------------------
  stage("scanning");
  const violations = scanPublicBoundary(files);
  if (violations.length > 0) {
    // Nothing has left this computer: the scan runs over the staged files.
    return failed(
      new StudioError(
        "publish.privacyViolation",
        "Publishing was stopped because the site would have included private information. Nothing has been uploaded.",
        { detail: violations.map(describeViolation).join(" ") },
      ),
    );
  }

  // --- 4. one commit, pushed without force -------------------------------
  stage("sending");
  await context.saveLocal({
    pending: {
      operationId,
      kind: "publish",
      startedAt: new Date().toISOString(),
      stage: "sending",
      recoveryRef: "",
    },
  });

  let commit: string;
  try {
    commit = await pushArtifact(context, binding.branch, accountId, files, operationId);
  } catch (e) {
    // The source is untouched and the previous site is still live.
    return failed(asStudioError(e, "unknown", "The public site could not be published."));
  }

  await context.saveLocal({
    lastPublishedCommit: commit,
    lastPublishedAt: new Date().toISOString(),
    lastPublishedSourceCommit: context.sourceRevision,
    pending: null,
  });

  // --- 5. wait for Pages --------------------------------------------------
  if (!context.fetchLiveManifest) {
    return outcome({
      stage: "live",
      message: "The public site has been published.",
      commit,
      sourceRevision: context.sourceRevision,
      manifest,
    });
  }

  stage("waiting-for-pages");
  const live = await waitForDeployment(context, manifest);
  return outcome({
    stage: live ? "live" : "timed-out",
    message: live
      ? "The public site is live."
      : "Published. GitHub Pages has not finished building yet — it usually appears within a few minutes.",
    commit,
    sourceRevision: context.sourceRevision,
    manifest,
  });
}

function deliveryBinding(local: LocalProjectState) {
  return local.topology === "single-private" ? local.source : local.delivery;
}

/**
 * Replaces the published tree and commits it as one change.
 *
 * On a rejection the answer is to fetch, take the remote wholesale, and
 * regenerate — never to merge. Generated files have no authorship, so combining
 * two machines' output would produce a site neither of them built.
 */
async function pushArtifact(
  context: PublishContext,
  branch: string,
  accountId: string,
  files: PublicFiles,
  operationId: string,
): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await git.fetch(context.deliveryDir, branch, accountId);
    await git.fastForward(context.deliveryDir, branch);

    await ipc("git_replace_dir", {
      dir: context.deliveryDir,
      prefix: PUBLIC_ROOT,
      files,
    });

    const message = encodeCommitMessage({
      projectId: context.projectId,
      schemaVersion: 0,
      operationId,
      subject: "Published the cluster viewer",
      actions: [
        StructuredActionSchema.parse({
          type: "site.published",
          id: context.sourceRevision,
          label: "cluster viewer",
        }),
      ],
    });

    const commit = await git.commit(context.deliveryDir, branch, message);
    const push = await git.push(context.deliveryDir, branch, accountId);
    if (push.pushed) return commit;
    if (!push.rejected) {
      throw new StudioError("unknown", "The public site could not be published.");
    }
    // Someone else published between our fetch and our push. Round again.
  }
  throw new StudioError(
    "repo.conflict",
    "The public site is being published from somewhere else at the same time. Try again in a moment.",
  );
}

/**
 * Waits for the manifest we just published to be the one being served.
 *
 * Matched by operation id, because a delivery commit is known the moment it is
 * pushed while "is it live" is a question only the served file answers.
 */
async function waitForDeployment(
  context: PublishContext,
  manifest: BuildManifest,
): Promise<boolean> {
  const now = context.now ?? (() => Date.now());
  const sleep = context.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + DEPLOY_TIMEOUT_MS;

  while (now() < deadline) {
    try {
      const served = await context.fetchLiveManifest!();
      if (isDeployed(served, manifest)) return true;
    } catch {
      // A 404 is the normal state of a site that has never been published.
    }
    await sleep(DEPLOY_POLL_MS);
  }
  return false;
}
