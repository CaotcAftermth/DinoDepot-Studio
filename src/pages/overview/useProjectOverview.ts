import { useEffect, useMemo } from "react";
import { useDraftsStore } from "../../stores/draftsStore";
import { useProjectStore } from "../../stores/projectStore";
import { useCatalogIndex } from "../../stores/useCatalogIndex";
import { useGithubStatus } from "../../services/githubStatus";
import { isTauri } from "../../services/ipc";
import { buildOutputStates } from "../../model/outputs";
import { githubReadiness } from "../../model/githubReadiness";
import { buildOverview, type OverviewModel } from "../../model/projectOverview";
import { recentActivity, type ActivityEvent } from "../../model/activity";

/** How many events Overview's Recent Activity shows. */
const ACTIVITY_SHOWN = 8;

export interface ProjectOverview extends OverviewModel {
  projectName: string;
  clusterName: string;
  activity: ActivityEvent[];
}

/**
 * Everything the Overview page renders, assembled from the shared models.
 *
 * Subscribes to the individual draft slices rather than the whole store, so
 * editing an unrelated slice does not re-run the output build — which
 * serializes the entire catalog for the viewer data and is the most expensive
 * thing on the page.
 */
export function useProjectOverview(): ProjectOverview {
  const hydrate = useDraftsStore((s) => s.hydrate);
  const production = useDraftsStore((s) => s.production);
  const remaps = useDraftsStore((s) => s.remaps);
  const cosmetics = useDraftsStore((s) => s.cosmetics);
  const catalog = useDraftsStore((s) => s.catalog);
  const players = useDraftsStore((s) => s.players);
  const history = useDraftsStore((s) => s.history);
  const watchlist = useDraftsStore((s) => s.watchlist);
  const imageFiles = useDraftsStore((s) => s.imageFiles);
  const activityFile = useDraftsStore((s) => s.activity);
  const settings = useProjectStore((s) => s.settings);
  const index = useCatalogIndex();

  const tokenPresent = useGithubStatus((s) => s.tokenPresent);
  const connectionState = useGithubStatus((s) => s.connection);
  const connectionTarget = useGithubStatus((s) => s.connectionTarget);
  const ensureToken = useGithubStatus((s) => s.ensureToken);

  useEffect(hydrate, [hydrate]);
  // Read once per session, never during render — Overview re-renders on every
  // keystroke elsewhere in the app and this reaches the credential store.
  useEffect(ensureToken, [ensureToken]);

  const outputs = useMemo(
    () =>
      buildOutputStates({
        production,
        remaps,
        cosmetics,
        catalog,
        players,
        history,
        imageFiles,
        settings,
        index,
      }),
    [production, remaps, cosmetics, catalog, players, history, imageFiles, settings, index],
  );

  const github = useMemo(() => {
    const config = settings?.github ?? null;
    const target = config
      ? `${config.owner}/${config.repo}@${config.branch}`
      : "";
    return githubReadiness({
      github: config,
      outputs,
      tokenPresent,
      desktop: isTauri,
      // A result recorded against a different destination says nothing about
      // this one.
      connection: connectionTarget === target ? connectionState : "unknown",
    });
  }, [settings, outputs, tokenPresent, connectionState, connectionTarget]);

  const model = useMemo(
    () =>
      buildOverview({
        production,
        remaps,
        cosmetics,
        catalog,
        watchlist,
        outputs,
        github,
      }),
    [production, remaps, cosmetics, catalog, watchlist, outputs, github],
  );

  const activity = useMemo(
    () => recentActivity(activityFile, ACTIVITY_SHOWN),
    [activityFile],
  );

  return {
    ...model,
    projectName: settings?.name ?? "",
    clusterName: settings?.cluster ?? "",
    activity,
  };
}
