import { ipc, isTauri } from "./ipc";

/** Events emitted by the sidecar scraper (see sidecar/scraper.mjs). */
export type ScraperEvent =
  | { type: "status"; message: string }
  | { type: "stderr"; message: string }
  | { type: "pages"; total: number }
  | { type: "page"; page: number; total: number }
  | { type: "mod"; name: string; projectId: string; url: string; updated: string }
  | { type: "watch"; modId: string; projectId: string; updated: string; ok: boolean }
  /** Emitted once, just before `done` — see ScraperMetrics. */
  | ({ type: "metrics" } & ScraperMetrics)
  | { type: "done"; count: number }
  | { type: "error"; message: string }
  | { type: "exit" };

/**
 * What the run actually did, so two runs can be compared rather than guessed
 * at. `reusedFromKnown` is the incremental win: those are mods whose detail
 * page never had to be opened.
 */
export interface ScraperMetrics {
  durationMs: number;
  listingPages: number;
  detailPagesOpened: number;
  reusedFromKnown: number;
  detailFailures: number;
  retries: number;
  blockedRequests: number;
}

export type ScraperListener = (event: ScraperEvent) => void;

let unlisten: (() => void) | null = null;

async function subscribe(listener: ScraperListener): Promise<void> {
  const { listen } = await import("@tauri-apps/api/event");
  const stop = await listen<string>("scraper-event", (event) => {
    try {
      listener(JSON.parse(event.payload));
    } catch {
      listener({ type: "stderr", message: event.payload });
    }
  });
  unlisten = () => {
    stop();
    unlisten = null;
  };
}

export function unsubscribe(): void {
  if (unlisten) unlisten();
}

/** What the sidecar needs to recognise a mod it has already catalogued. */
export interface KnownCosmetic {
  modId: string;
  name: string;
  url: string;
  updated: string;
}

/**
 * Runs the collector. `known` is the cosmetics already recorded: the sidecar
 * matches listing rows against them by canonical URL and reuses the stored
 * project ID instead of opening the mod's page, which is where a repeat run
 * spends nearly all of its time.
 */
export async function startCosmeticsScrape(
  listener: ScraperListener,
  known: KnownCosmetic[] = [],
): Promise<void> {
  if (!isTauri) throw new Error("The scraper only runs in the desktop app");
  unsubscribe();
  await subscribe(listener);
  await ipc("scraper_start", {
    mode: "cosmetics",
    watchListJson: known.length > 0 ? JSON.stringify(known) : null,
  });
}

export interface WatchTarget {
  modId: string;
  name: string;
  url: string;
}

export async function startWatchCheck(
  targets: WatchTarget[],
  listener: ScraperListener,
): Promise<void> {
  if (!isTauri) throw new Error("The scraper only runs in the desktop app");
  unsubscribe();
  await subscribe(listener);
  await ipc("scraper_start", {
    mode: "watch",
    watchListJson: JSON.stringify(targets),
  });
}

export async function cancelScrape(): Promise<void> {
  await ipc("scraper_cancel", {});
}
