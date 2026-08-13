import { create } from "zustand";
import { ipc } from "../services/ipc";
import * as git from "../services/gitRepo";
import { publishProject, type PublishOutcome, type PublishStage } from "../services/publishPipeline";
import { validateProject, type ValidationReport } from "../validation/project";
import { serializeViewerData } from "../serializers/viewer";
import { buildViewerHtml } from "../viewer/template";
import { rawImagesUrl, rawUrl } from "../services/publish";
import { effectiveGithubConfig } from "../model/project";
import { PUBLIC_ROOT } from "../model/publishArtifact";
import { asStudioError, StudioError } from "../model/errors";
import { useDraftsStore } from "./draftsStore";
import { currentGithubConfig, useProjectStore } from "./projectStore";
import { useSyncStore } from "./syncStore";

/**
 * Publishing, driven from the stores.
 *
 * The pipeline itself is a pure-ish function; this is the part that gathers its
 * inputs, prepares the delivery working copy, and holds the result. Keeping
 * them apart is what lets the whole sequence — including the privacy scan and
 * the refusals — be tested without a project or a repository.
 */

interface PublishState {
  stage: PublishStage | "idle";
  running: boolean;
  last: PublishOutcome | null;
  /** The validation as of the last check. Null until something has run. */
  report: ValidationReport | null;
  /** Set once the administrator has seen the warnings and chosen to go ahead. */
  warningsAcknowledged: boolean;

  /** Runs validation without publishing, for the page to show. */
  check(): ValidationReport;
  publish(): Promise<PublishOutcome>;
  /** Sync first, then publish — the combined action. */
  syncAndPublish(): Promise<PublishOutcome>;
  acknowledgeWarnings(): void;
}

export const usePublishStore = create<PublishState>((set, get) => ({
  stage: "idle",
  running: false,
  last: null,
  report: null,
  warningsAcknowledged: false,

  check() {
    const report = validateProject(validationInput());
    set({ report });
    return report;
  },

  async publish() {
    if (get().running) return get().last ?? blocked("Already publishing.");
    set({ running: true, stage: "checking" });
    try {
      const result = await runPublish(get().warningsAcknowledged, (stage) => set({ stage }));
      set({ last: result, stage: result.stage, report: validateProject(validationInput()) });
      return result;
    } finally {
      set({ running: false });
    }
  },

  /**
   * The combined action.
   *
   * Two operations, presented as one: a source Sync commit, then a delivery
   * Publish commit. They are not atomic across the two repositories and are not
   * pretended to be — the source lands first, and the site is only built from a
   * revision that is already shared.
   */
  async syncAndPublish() {
    if (get().running) return get().last ?? blocked("Already publishing.");

    const sync = await useSyncStore.getState().sync();
    if (sync.kind === "needs-decision") {
      return blocked(
        "Your changes and somebody else's need sorting out before the site can be published.",
      );
    }
    if (sync.error) {
      return blocked(sync.message);
    }
    return get().publish();
  },

  acknowledgeWarnings() {
    set({ warningsAcknowledged: true });
  },
}));

function blocked(message: string): PublishOutcome {
  return {
    stage: "blocked",
    message,
    commit: "",
    sourceRevision: "",
    manifest: null,
    error: new StudioError("validation.failed", message),
  };
}

/** Everything the validators need, from wherever it currently lives. */
function validationInput() {
  const project = useProjectStore.getState();
  const drafts = useDraftsStore.getState();
  return {
    settings: project.settings,
    production: drafts.production,
    remaps: drafts.remaps,
    cosmetics: drafts.cosmetics,
    catalog: drafts.catalog,
    players: drafts.players,
    index: null,
    imageFiles: drafts.imageFiles,
  };
}

async function runPublish(
  warningsAcknowledged: boolean,
  onStage: (stage: PublishStage) => void,
): Promise<PublishOutcome> {
  const project = useProjectStore.getState();
  const { settings, local } = project;
  if (!settings || !local) return blocked("No project is open.");

  let deliveryDir: string;
  try {
    deliveryDir = await prepareDelivery(local.projectId, local);
  } catch (e) {
    const error = asStudioError(e, "repo.unavailable", "The public site repository is not ready.");
    return { ...blocked(error.message), error };
  }

  return publishProject({
    deliveryDir,
    local,
    // Only a synchronized revision may be published from — this is the value
    // that ends up in the manifest as `sourceRevision`.
    sourceRevision: local.lastSyncedCommit,
    projectId: settings.projectId,
    validate: () => validateProject(validationInput()),
    generate: () => generateSite(),
    accountId: async () => useProjectStore.getState().local?.githubAccountId ?? "",
    saveLocal: async (patch) => {
      await useProjectStore.getState().updateLocal(patch);
    },
    warningsAcknowledged,
    onStage,
    fetchLiveManifest: () => fetchLiveManifest(local),
  });
}

/**
 * Makes sure there is a working copy of the delivery repository to build into.
 *
 * Initialised and fetched rather than cloned: `git_fetch` plus a fast-forward
 * reaches the same state, works when the repository is empty — which a brand
 * new site repository always is — and reuses the code the Sync path already
 * relies on.
 */
async function prepareDelivery(
  projectId: string,
  local: { topology: string; source: unknown; delivery: unknown },
): Promise<string> {
  const binding = (local.topology === "single-private" ? local.source : local.delivery) as
    | { remoteUrl: string; branch: string }
    | null;
  if (!binding?.remoteUrl) {
    throw new StudioError(
      "repo.unavailable",
      "Choose the public site repository before publishing.",
    );
  }

  const dir = await ipc<string>("delivery_dir", { projectId });
  await git.setRemote(dir, binding.remoteUrl);
  return dir;
}

/** The viewer, built from the current project. */
function generateSite() {
  const project = useProjectStore.getState();
  const drafts = useDraftsStore.getState();
  const settings = project.settings!;
  const github = currentGithubConfig();
  const clusterName = settings.cluster || settings.name || "ASA Cluster";

  const viewerData = serializeViewerData(
    drafts.production,
    drafts.catalog,
    clusterName,
    drafts.imageFiles,
    settings,
  );

  return {
    indexHtml: buildViewerHtml({
      clusterName,
      // Relative, because the page and its data now ship together in the same
      // published tree — the old absolute raw URL pointed at the *source*
      // repository, which under the recommended topology is private.
      dataUrl: "./data/viewer.json",
      imagesUrl: rawImagesUrl(github),
    }),
    data: { "viewer.json": `${JSON.stringify(viewerData, null, 2)}\n` },
  };
}

/**
 * Fetches the manifest the public site is currently serving.
 *
 * Read from GitHub Pages rather than from the repository: the repository has
 * the commit the instant it is pushed, and the question being asked is whether
 * the *site* has caught up.
 */
async function fetchLiveManifest(local: {
  delivery: { owner: string; name: string } | null;
  source: { owner: string; name: string } | null;
  topology: string;
}): Promise<unknown> {
  const binding = local.topology === "single-private" ? local.source : local.delivery;
  if (!binding) throw new StudioError("repo.unavailable", "No public site repository.");

  const url = `https://${binding.owner}.github.io/${binding.name}/dinodepot-build.json`;
  const response = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new StudioError("repo.unavailable", "The public site is not answering yet.");
  }
  return response.json();
}

/** Where the published site will be, for the "view it" link. */
export function publicSiteUrl(): string {
  const local = useProjectStore.getState().local;
  if (!local) return "";
  const binding = local.topology === "single-private" ? local.source : local.delivery;
  if (!binding?.owner || !binding.name) return "";
  return `https://${binding.owner}.github.io/${binding.name}/`;
}

export { PUBLIC_ROOT, effectiveGithubConfig, rawUrl };
