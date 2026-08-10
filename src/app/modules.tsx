import type { ReactElement } from "react";
import type { ProjectSettings } from "../model/project";
import { PlayerDataPage } from "../pages/PlayerDataPage";

/**
 * Optional pages that sit below the separator in the sidebar — functionality
 * beyond the production studio itself, off unless the admin turns it on in
 * Settings.
 *
 * To add one: append an entry here and give it a `element`. The route, the
 * nav link and the Settings toggle all follow from this list, so nothing else
 * needs touching.
 */
export interface AppModule {
  /** Stable key stored in settings.modules — never rename it. */
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
