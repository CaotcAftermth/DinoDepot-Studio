import { create } from "zustand";
import {
  cancelScrape,
  startCosmeticsScrape,
  unsubscribe,
  type KnownCosmetic,
  type ScraperEvent,
  type ScraperMetrics,
} from "../services/scraper";
import type { ScrapedMod } from "../model/cosmetics";

/**
 * A cosmetics collector run, held outside the page that started it.
 *
 * The run takes several minutes and sweeps every page of the category. It used
 * to live in the Collector component's state, with the event listener released
 * on unmount — so opening Settings to check something mid-run detached the
 * stream, dropped the log and the partial results, and left the sidecar
 * grinding away with nobody listening. The work was gone even though the
 * browser was still doing it.
 *
 * Here the listener is attached when the run starts and released when the
 * sidecar exits, whatever is or is not on screen in between. Coming back to
 * the page re-reads the same state and the progress is still counting.
 *
 * Deliberately not persisted: a run cannot survive the app closing — the
 * sidecar goes with it — so writing it to disk would only produce a stuck
 * "Scraping…" on the next launch.
 */

export interface ScrapeState {
  /** True from the moment a run starts until the sidecar exits. */
  running: boolean;
  /** Rolling log, newest last, capped so a long run cannot grow forever. */
  log: string[];
  progress: { page: number; total: number } | null;
  metrics: ScraperMetrics | null;
  /**
   * The finished catalogue, or null while a run is in flight or after the
   * result has been applied. Keyed by CurseForge project id.
   */
  result: Map<string, ScrapedMod> | null;
  /** Set when the run ended without a `done` — cancelled, crashed, blocked. */
  endedWithoutResult: boolean;
  /** Mods seen so far this run. Drives the progress readout mid-sweep. */
  collectedCount: number;

  start(known: KnownCosmetic[]): Promise<void>;
  cancel(): Promise<void>;
  /** Drops a finished result once it has been applied to the draft. */
  clearResult(): void;
  /** Errors the page should surface as a toast, consumed once. */
  takeError(): string | null;
}

const LOG_LIMIT = 200;

export const useScrapeStore = create<ScrapeState>((set, get) => {
  /** Accumulated between `mod` events; only published on `done`. */
  let collected = new Map<string, ScrapedMod>();
  /** Last error message, handed to whichever page asks for it first. */
  let pendingError: string | null = null;

  function pushLog(message: string) {
    set((s) => ({ log: [...s.log.slice(-LOG_LIMIT), message] }));
  }

  function handleEvent(event: ScraperEvent) {
    switch (event.type) {
      case "status":
      case "stderr":
        pushLog(event.message);
        break;
      case "pages":
        set({ progress: { page: 0, total: event.total } });
        pushLog(`Found ${event.total} category pages`);
        break;
      case "page":
        set({ progress: { page: event.page, total: event.total } });
        break;
      case "mod":
        collected.set(event.projectId, {
          name: event.name,
          projectId: event.projectId,
          url: event.url,
          updated: event.updated,
        });
        set({ collectedCount: collected.size });
        break;
      case "metrics":
        set({ metrics: event });
        pushLog(
          `${Math.round(event.durationMs / 1000)}s · ${event.listingPages} listing pages · ` +
            `${event.detailPagesOpened} detail pages opened · ${event.reusedFromKnown} reused` +
            (event.detailFailures > 0 ? ` · ${event.detailFailures} failed` : ""),
        );
        break;
      case "done":
        pushLog(`Scrape complete — ${event.count} mods collected`);
        set({ result: new Map(collected), endedWithoutResult: false });
        break;
      case "error":
        pushLog(`ERROR: ${event.message}`);
        pendingError = event.message;
        break;
      case "exit":
        // The listener is this run's, and the run is over. Releasing it here
        // rather than on unmount is the whole point: navigation no longer
        // decides whether the events have anywhere to land.
        unsubscribe();
        set((s) => ({ running: false, endedWithoutResult: s.result === null }));
        break;
    }
  }

  return {
    running: false,
    log: [],
    progress: null,
    metrics: null,
    result: null,
    endedWithoutResult: false,
    collectedCount: 0,

    async start(known) {
      if (get().running) return;
      collected = new Map();
      pendingError = null;
      set({
        running: true,
        log: [],
        progress: null,
        metrics: null,
        result: null,
        endedWithoutResult: false,
        collectedCount: 0,
      });
      try {
        await startCosmeticsScrape(handleEvent, known);
      } catch (e) {
        unsubscribe();
        set({ running: false });
        throw e;
      }
    },

    async cancel() {
      try {
        await cancelScrape();
        pushLog("Cancelled by user");
      } catch {
        // Already finished: `exit` has been or is about to be delivered, and
        // that is what clears `running`.
      }
    },

    clearResult() {
      set({ result: null });
    },

    takeError() {
      const error = pendingError;
      pendingError = null;
      return error;
    },
  };
});
