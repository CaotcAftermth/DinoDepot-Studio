import { curseforgeProjectUrl } from "../model/catalog";
import { ipc, isTauri } from "./ipc";

/** Events emitted by the sidecar scraper (see sidecar/scraper.mjs). */
export type ScraperEvent =
  | { type: "status"; message: string }
  | { type: "stderr"; message: string }
  | { type: "pages"; total: number }
  | { type: "page"; page: number; total: number }
  | { type: "mod"; name: string; projectId: string; url: string; updated: string }
  | { type: "watch"; modId: string; projectId: string; updated: string; ok: boolean }
  | {
      type: "lookup";
      modId: string;
      name: string;
      projectId: string;
      updated: string;
      /** The page actually landed on, after CurseForge resolved the redirect. */
      url: string;
      ok: boolean;
    }
  /** Emitted once, just before `done` - see ScraperMetrics. */
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

/** What one mod page said about itself. */
export interface ModLookup {
  name: string;
  projectId: string;
  updated: string;
  url: string;
}

/**
 * Reads a mod's own name off its CurseForge page, given only its project ID.
 *
 * `/projects/<id>` redirects to the mod's real page, so the ID is enough to
 * ask. Resolved as a promise rather than an event stream because there is one
 * answer and a form is waiting for it.
 *
 * Costs a Chrome launch, so this belongs behind something the administrator
 * pressed - never behind typing.
 */
export async function lookupModByProjectId(
  projectId: string,
  {
    timeoutMs = 90_000,
    onStatus,
  }: { timeoutMs?: number; onStatus?: (message: string) => void } = {},
): Promise<ModLookup> {
  if (!isTauri) throw new Error("Looking a mod up only works in the desktop app");
  const id = projectId.trim();
  if (!id) throw new Error("No project ID to look up");
  // Checked before subscribing: taking over the event listener and *then*
  // failing would leave the collector or watcher talking to nobody.
  if (await ipc<boolean>("scraper_running", {})) {
    throw new Error("A scraper run is already in progress");
  }

  return new Promise<ModLookup>((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      run();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          void cancelScrape().catch(() => {});
          reject(new Error("Looking up the mod took too long"));
        }),
      timeoutMs,
    );

    void (async () => {
      try {
        unsubscribe();
        await subscribe((event) => {
          if (event.type === "lookup" && event.modId === id) {
            if (!event.ok) {
              finish(() =>
                reject(new Error(`CurseForge had no mod for project ID ${id}`)),
              );
              return;
            }
            finish(() =>
              resolve({
                name: event.name,
                projectId:
                  event.projectId === "Not Found" ? id : event.projectId,
                updated: event.updated === "Not Found" ? "" : event.updated,
                url: event.url,
              }),
            );
          } else if (event.type === "status") {
            // Launching Chrome is most of the wait. Saying so beats a button
            // that reads the same for eight seconds.
            onStatus?.(event.message);
          } else if (event.type === "error") {
            finish(() => reject(new Error(event.message)));
          } else if (event.type === "exit") {
            finish(() =>
              reject(new Error("The lookup ended without an answer")),
            );
          }
        });
        await ipc("scraper_start", {
          mode: "lookup",
          watchListJson: JSON.stringify([
            { modId: id, url: curseforgeProjectUrl(id) },
          ]),
        });
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error(String(error))),
        );
      }
    })();
  });
}
