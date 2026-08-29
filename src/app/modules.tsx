import { lazy, type ReactElement } from "react";
import type { ProjectSettings } from "../model/project";

/**
 * Optional pages load on demand, like the core sections.
 *
 * The sidebar reads this list on every render, so a static import here put
 * every optional page - and everything it touches, the official catalog
 * included - into the first script the window has to evaluate, whether or not
 * the module was even switched on.
 */
const loadPlayerData = () => import("../pages/PlayerDataPage");
const PlayerDataPage = lazy(async () => ({
  default: (await loadPlayerData()).PlayerDataPage,
}));

/** Warms the optional pages once the window is up. See `prefetchSections`. */
export function prefetchModules(): void {
  void loadPlayerData();
}

/**
 * Optional pages that sit below the separator in the sidebar - functionality
 * beyond the production studio itself, off unless the admin turns it on in
 * Settings.
 *
 * To add one: append an entry here and give it a `element`. The route, the
 * nav link and the Settings toggle all follow from this list, so nothing else
 * needs touching.
 */
export interface AppModule {
  /** Stable key stored in settings.modules - never rename it. */
  id: string;
  to: string;
  label: string;
  icon: string;
  /** One line explaining what turning it on gets you. */
  description: string;
  element: ReactElement;
}

export const APP_MODULES: AppModule[] = [
  {
    id: "player-data",
    to: "/players",
    label: "Player Data",
    icon: "☺",
    description:
      "Roster of Discord/Steam names, EOS and Player IDs, and each player's most recent .arkprofile.",
    element: <PlayerDataPage />,
  },
];

/** Modules the project has switched on, in registry order. */
export function enabledModules(settings: ProjectSettings | null): AppModule[] {
  if (!settings) return [];
  return APP_MODULES.filter((m) => settings.modules[m.id] === true);
}
