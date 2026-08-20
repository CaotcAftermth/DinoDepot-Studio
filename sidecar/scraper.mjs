/**
 * Dino Depot Studio CurseForge scraper sidecar.
 *
 * Emits NDJSON events on stdout so the Studio UI can stream progress and
 * collect results.
 *
 * Modes:
 *   node scraper.mjs cosmetics [known.json]
 *     Scrapes the full custom-cosmetics category. `known.json` is the
 *     cosmetics already recorded — [{modId, name, url, updated}] — and lets a
 *     repeat run skip detail pages for mods it already knows.
 *     Events: status, pages, page, mod, metrics, done, error
 *
 *   node scraper.mjs watch <path-to-json>
 *     Reads [{modId, name, url}] and scrapes each mod page for its current
 *     Project ID + Updated date.
 *     Events: status, watch, metrics, done, error
 *
 *   node scraper.mjs lookup <path-to-json>
 *     Reads [{modId, url}] and reports what each page calls itself, so a
 *     project ID alone is enough to catalogue a mod by its real name.
 *     Events: status, lookup, metrics, done, error
 *
 * Performance notes (see also the DOM fallbacks below):
 *  - A bounded pool of reusable tabs replaces open/close per mod. Opening a
 *    tab is the single most expensive thing this script does.
 *  - Images, media, fonts and analytics are aborted at the network layer.
 *    Scripts and XHR are left alone: CurseForge renders through hydration and
 *    blocking them empties the page.
 *  - Detail pages are only opened for mods the listing could not settle, so a
 *    second run over a mostly-unchanged category does almost no navigation.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");

const BASE_URL = "https://www.curseforge.com/ark-survival-ascended/search";
const PAGE_SIZE = 20;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36";

/** Detail tabs open at once. Enough to hide latency, few enough to be polite. */
const DETAIL_CONCURRENCY = 6;
/** Watch-mode checks in flight. */
const WATCH_CONCURRENCY = 6;
/** How long a single interactive lookup waits for the Project ID row. */
const LOOKUP_DETAIL_TIMEOUT = 8000;

const LISTING_SELECTOR = 'a.name[href^="/ark-survival-ascended/mods/"]';
const DATE_RE =
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i;

function emit(event) {
  process.stdout.write(JSON.stringify(event) + "\n");
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

const metrics = {
  startedAt: Date.now(),
  listingPages: 0,
  detailPagesOpened: 0,
  reusedFromKnown: 0,
  detailFailures: 0,
  retries: 0,
  blockedRequests: 0,
};

function emitMetrics() {
  emit({
    type: "metrics",
    durationMs: Date.now() - metrics.startedAt,
    listingPages: metrics.listingPages,
    detailPagesOpened: metrics.detailPagesOpened,
    reusedFromKnown: metrics.reusedFromKnown,
    detailFailures: metrics.detailFailures,
    retries: metrics.retries,
    blockedRequests: metrics.blockedRequests,
  });
}

// ---------------------------------------------------------------------------
// URL canonicalization
// ---------------------------------------------------------------------------

/**
 * Canonical form of a CurseForge mod URL, so a stored URL matches a scraped
 * one regardless of scheme, `www.`, trailing slash, query string or casing.
 * Mirrors `canonicalCurseforgeUrl` in src/model/catalogDuplicates.ts — the two
 * run in different processes, so the logic is duplicated deliberately and both
 * sides have tests.
 */
/**
 * Trailing site furniture on a page title, stripped one segment at a time.
 *
 * Matches only a *final* segment that is the site's own name or a category
 * ending in "Mods" — never an interior separator. Mod names contain both
 * hyphens and pipes ("Paleo ARK - Evolution | Apex Predators (Crossplay)"), so
 * splitting at the first separator and keeping the head throws most of the
 * name away.
 */
const SITE_SUFFIX_RE =
  /\s+[-|\u2013\u2014]\s+(?:curseforge|[^-|\u2013\u2014]*\bmods)\s*$/i;

/**
 * The mod's own name, out of a page title.
 *
 * Only for the title fallback: a heading or `og:title` is already the name the
 * author chose and is used untouched.
 */
function cleanModName(raw) {
  const text = (raw || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  let name = text;
  while (SITE_SUFFIX_RE.test(name)) name = name.replace(SITE_SUFFIX_RE, "");
  return name.trim() || text;
}

function canonicalUrl(url) {
  const trimmed = (url || "").trim();
  if (!trimmed) return "";
  let rest = trimmed.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  rest = rest.split("#")[0].split("?")[0];
  return rest.replace(/\/+$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// Browser + page pool
// ---------------------------------------------------------------------------

function resolveChromePath() {
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  for (const path of candidates) {
    if (fs.existsSync(path)) return path;
  }
  throw new Error(
    "System Chrome not found — install Google Chrome to use the scraper",
  );
}

async function launchBrowser() {
  emit({ type: "status", message: "Launching headless Chrome…" });
  return puppeteer.launch({
    headless: true,
    executablePath: resolveChromePath(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-extensions",
      "--mute-audio",
    ],
    defaultViewport: { width: 1280, height: 800 },
  });
}

/**
 * Request types that never affect what we extract.
 *
 * Stylesheets are deliberately *not* blocked: the listing waits on
 * `visible: true` and several fallbacks read `document.body.innerText`, both of
 * which depend on layout. Dropping CSS would change what those see.
 */
const BLOCKED_TYPES = new Set(["image", "media", "font"]);
/** Third parties that only cost time. */
const BLOCKED_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "googlesyndication.com",
  "adservice.google.",
  "facebook.net",
  "hotjar.com",
  "sentry.io",
  "nitropay.com",
  "playwire.com",
  "twitch.tv",
];

async function preparePage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  page.setDefaultNavigationTimeout(60000);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    // Scripts and fetch/XHR are required — CurseForge hydrates its content.
    const type = request.resourceType();
    const url = request.url();
    if (BLOCKED_TYPES.has(type) || BLOCKED_HOSTS.some((h) => url.includes(h))) {
      metrics.blockedRequests++;
      request.abort().catch(() => {});
      return;
    }
    request.continue().catch(() => {});
  });
  return page;
}

/**
 * A fixed set of reusable tabs handed out one at a time. Replaces creating and
 * destroying a tab per mod, which dominated the old run: 20 tabs per listing
 * page, each paying full browser-context setup.
 */
class PagePool {
  constructor(browser, size) {
    this.browser = browser;
    this.size = size;
    this.idle = [];
    this.waiting = [];
    this.created = 0;
  }

  async acquire() {
    const ready = this.idle.pop();
    if (ready) return ready;
    if (this.created < this.size) {
      this.created++;
      return preparePage(this.browser);
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  release(page) {
    const next = this.waiting.shift();
    if (next) next(page);
    else this.idle.push(page);
  }

  async closeAll() {
    for (const page of this.idle) {
      await page.close().catch(() => {});
    }
    this.idle = [];
  }
}

/** Runs `worker` over `items` with at most `limit` in flight, order preserved. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// Detail scraping
// ---------------------------------------------------------------------------

/** Extraction that runs inside the page. Unchanged selectors and fallbacks. */
function extractDetails() {
  const result = {
    projectId: "Not Found",
    updated: "Not Found",
    name: "",
    /** True only when nothing but the tab title was available. */
    nameFromTitle: false,
  };

  function clean(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }
  function isAbsoluteDate(text) {
    return /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i.test(
      text || "",
    );
  }
  function firstAbsoluteDate(text) {
    const match = (text || "").match(
      /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i,
    );
    return match ? match[0] : "";
  }

  const dtElements = document.querySelectorAll("dt");
  for (let i = 0; i < dtElements.length; i++) {
    const label = clean(dtElements[i].textContent).replace(/:$/, "");
    const dd = dtElements[i].nextElementSibling;
    if (!dd) continue;
    if (label === "Project ID") {
      const span = dd.querySelector(".project-id");
      const text = span ? clean(span.textContent) : clean(dd.textContent);
      const match = text.match(/\d+/);
      if (match) result.projectId = match[0];
    }
    if (label === "Updated") {
      const span = dd.querySelector("span");
      const text = span ? clean(span.textContent) : clean(dd.textContent);
      if (text) result.updated = text;
    }
  }

  const lines = (document.body.innerText || "")
    .split("\n")
    .map((line) => clean(line))
    .filter(Boolean);

  function valueAfterLabel(label) {
    const wanted = label.toLowerCase().replace(/:$/, "");
    for (let i = 0; i < lines.length; i++) {
      const current = lines[i].toLowerCase().replace(/:$/, "");
      if (current === wanted) {
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j]) return lines[j];
        }
      }
    }
    return "";
  }

  if (result.projectId === "Not Found") {
    const line = valueAfterLabel("Project ID");
    const match = line.match(/\d+/);
    if (match) result.projectId = match[0];
  }
  if (result.updated === "Not Found") {
    const line = valueAfterLabel("Updated");
    if (line) result.updated = line;
  }

  // Heading first, then og:title: both carry the mod's own name with no site
  // furniture attached, so neither needs editing afterwards. The tab title is
  // the last resort precisely because it does carry the suffix.
  const heading = document.querySelector("h1");
  const ogTitle = document.querySelector('meta[property="og:title"]');
  result.name =
    clean(heading && heading.textContent) ||
    clean(ogTitle && ogTitle.getAttribute("content"));
  if (!result.name) {
    result.name = clean(document.title);
    result.nameFromTitle = true;
  }

  const absoluteDate = firstAbsoluteDate(document.body.innerText || "");
  if (
    absoluteDate &&
    (!isAbsoluteDate(result.updated) || /ago$/i.test(result.updated))
  ) {
    result.updated = absoluteDate;
  }
  return result;
}

/**
 * The project ID as the page's own embedded data reports it.
 *
 * CurseForge ships the project in a JSON blob (Next.js `__NEXT_DATA__`, or a
 * `projectId`/`"id"` field in an inline script) before the DOM that shows it
 * has rendered. Reading it lets the wait finish as soon as the data is there
 * instead of after a fixed sleep. Returns null whenever the shape is anything
 * other than what is expected, so the DOM path stays authoritative.
 */
function extractEmbeddedProject() {
  try {
    const nextData = document.getElementById("__NEXT_DATA__");
    if (nextData && nextData.textContent) {
      const data = JSON.parse(nextData.textContent);
      const project =
        data?.props?.pageProps?.project ?? data?.props?.pageProps?.mod ?? null;
      const rawId = project?.id ?? project?.projectId;
      const id =
        typeof rawId === "number" ||
        (typeof rawId === "string" && /^\d+$/.test(rawId))
          ? String(rawId)
          : "";
      const name = typeof project?.name === "string" ? project.name : "";
      if (id || name) return { id, name };
    }
  } catch {
    /* not the shape we know — fall through to the DOM */
  }
  return null;
}

/**
 * Waits until the page can actually answer, rather than sleeping 750ms and
 * hoping. Resolves as soon as either the Project ID row has rendered or the
 * embedded JSON is parseable; gives up quietly so the DOM fallbacks still run.
 */
async function waitForDetails(page, timeout = 12000) {
  try {
    await page.waitForFunction(
      () => {
        const dts = document.querySelectorAll("dt");
        for (const dt of dts) {
          const label = (dt.textContent || "").replace(/\s+/g, " ").trim();
          if (label.replace(/:$/, "") === "Project ID") {
            const dd = dt.nextElementSibling;
            if (dd && /\d/.test(dd.textContent || "")) return true;
          }
        }
        return Boolean(document.getElementById("__NEXT_DATA__"));
      },
      { timeout, polling: 100 },
    );
  } catch {
    metrics.retries++;
  }
}

async function scrapeModDetails(pool, mod) {
  const page = await pool.acquire();
  try {
    metrics.detailPagesOpened++;
    await page.goto(mod.url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await waitForDetails(page, mod.detailTimeout);

    const details = await page.evaluate(extractDetails);
    const embedded = await page.evaluate(extractEmbeddedProject);
    if (details.projectId === "Not Found" && embedded?.id) {
      details.projectId = embedded.id;
    }
    // The embedded record is the project's own name, so it wins over anything
    // read off the rendered page. Nothing here is trimmed except a tab title.
    const pageName = details.nameFromTitle
      ? cleanModName(details.name)
      : (details.name || "").trim();
    details.name = (embedded?.name || "").trim() || pageName;
    details.resolvedUrl = page.url();

    if (
      mod.updatedFromList &&
      (!details.updated ||
        details.updated === "Not Found" ||
        /ago$/i.test(details.updated))
    ) {
      details.updated = mod.updatedFromList;
    }

    return { ...mod, ...details };
  } catch (err) {
    metrics.detailFailures++;
    emit({
      type: "status",
      message: `Failed to scrape ${mod.name || mod.url}: ${err.message}`,
    });
    return null;
  } finally {
    pool.release(page);
  }
}

// ---------------------------------------------------------------------------
// Cosmetics mode
// ---------------------------------------------------------------------------

/** Reads the listing rows from whatever category page is currently loaded. */
function extractListing() {
  const dateRegex =
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i;
  const anchors = document.querySelectorAll(
    'a.name[href^="/ark-survival-ascended/mods/"]',
  );
  return Array.from(anchors)
    .map((a) => {
      const nameSpan = a.querySelector("span.ellipsis");
      const name = nameSpan?.textContent.trim() || a.textContent.trim();
      let updatedFromList = "";
      let node = a;
      for (let i = 0; i < 10 && node; i++) {
        const text = node.innerText || "";
        const match = text.match(dateRegex);
        if (match) {
          updatedFromList = match[0];
          break;
        }
        node = node.parentElement;
      }
      return {
        name,
        url: "https://www.curseforge.com" + a.getAttribute("href"),
        updatedFromList,
      };
    })
    .filter(
      (mod) =>
        mod.name &&
        mod.name.toLowerCase() !== "copy to clipboard" &&
        mod.url.includes("/ark-survival-ascended/mods/"),
    );
}

/**
 * Whether a listing row plus what we already knew is enough to skip the detail
 * page. Requires a known project ID for that exact URL and an absolute date
 * from the listing that still matches what was recorded — a changed date means
 * the mod was updated and its page is worth reading again.
 */
function canReuseKnown(mod, known) {
  if (!known) return false;
  if (!/^\d+$/.test(String(known.modId || ""))) return false;
  const listed = mod.updatedFromList;
  if (!listed || !DATE_RE.test(listed)) return false;
  return listed === known.updated;
}

async function runCosmetics(knownPath) {
  const known = new Map();
  if (knownPath) {
    try {
      const list = JSON.parse(fs.readFileSync(knownPath, "utf8"));
      for (const entry of list) {
        const key = canonicalUrl(entry.url);
        if (key) known.set(key, entry);
      }
      emit({
        type: "status",
        message: `${known.size} known cosmetic mods available for incremental matching`,
      });
    } catch (err) {
      emit({
        type: "status",
        message: `Could not read known cosmetics (${err.message}) — running a full scrape`,
      });
    }
  }

  const browser = await launchBrowser();
  const pool = new PagePool(browser, DETAIL_CONCURRENCY);
  try {
    const listPage = await preparePage(browser);

    const pageUrlFor = (n) =>
      `${BASE_URL}?page=${n}&pageSize=${PAGE_SIZE}&sortBy=relevancy&class=mods&categories=custom-cosmetics`;

    emit({ type: "status", message: "Loading category page 1…" });
    await listPage.goto(pageUrlFor(1), { waitUntil: "domcontentloaded" });
    await listPage.waitForSelector(LISTING_SELECTOR, {
      visible: true,
      timeout: 30000,
    });

    const totalPages = await listPage.evaluate((pageSize) => {
      const bodyText = document.body.innerText || "";
      const ofMatch = bodyText.match(/\b\d+\s+of\s+(\d+)\b/i);
      if (ofMatch) {
        const pages = parseInt(ofMatch[1], 10);
        if (!isNaN(pages) && pages > 0) return pages;
      }
      const projectsMatch = bodyText.match(/([\d,]+)\s+Projects/i);
      if (projectsMatch) {
        const total = parseInt(projectsMatch[1].replace(/,/g, ""), 10);
        if (!isNaN(total) && total > 0) return Math.ceil(total / pageSize);
      }
      return 1;
    }, PAGE_SIZE);

    emit({ type: "pages", total: totalPages });

    // Page 1 is already loaded — reading it again cost a full navigation.
    let pending = await listPage.evaluate(extractListing);
    metrics.listingPages++;

    const collected = [];
    const seenUrls = new Set();

    const handlePage = async (pageNum, mods) => {
      emit({ type: "page", page: pageNum, total: totalPages });

      const fresh = [];
      for (const mod of mods) {
        const key = canonicalUrl(mod.url);
        // The same mod can appear on two pages while the listing re-sorts.
        if (!key || seenUrls.has(key)) continue;
        seenUrls.add(key);

        const priorEntry = known.get(key);
        if (canReuseKnown(mod, priorEntry)) {
          metrics.reusedFromKnown++;
          const reused = {
            name: mod.name || priorEntry.name,
            projectId: String(priorEntry.modId),
            url: mod.url,
            updated: mod.updatedFromList || priorEntry.updated,
          };
          collected.push(reused);
          // Still emitted: a mod left out of the result set reads as removed
          // from CurseForge on the diff screen.
          emit({ type: "mod", ...reused });
          continue;
        }
        fresh.push(mod);
      }

      const detailed = (
        await mapLimit(fresh, DETAIL_CONCURRENCY, (mod) =>
          scrapeModDetails(pool, mod),
        )
      ).filter(Boolean);

      for (const mod of detailed) {
        if (mod.projectId === "Not Found") continue;
        const record = {
          name: mod.name,
          projectId: mod.projectId,
          url: mod.url,
          updated: mod.updated,
        };
        collected.push(record);
        emit({ type: "mod", ...record });
      }
    };

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      if (pending.length === 0) {
        emit({
          type: "status",
          message: `No mods on page ${pageNum} — ending early`,
        });
        break;
      }

      const mods = pending;
      pending = [];

      // Fetch the next listing page while this page's details are scraped —
      // the listing navigation and the detail tabs no longer wait on each
      // other. The pool bounds total concurrency either way.
      const nextPage =
        pageNum < totalPages
          ? (async () => {
              await listPage.goto(pageUrlFor(pageNum + 1), {
                waitUntil: "domcontentloaded",
              });
              try {
                await listPage.waitForSelector(LISTING_SELECTOR, {
                  visible: true,
                  timeout: 15000,
                });
              } catch {
                return [];
              }
              metrics.listingPages++;
              return listPage.evaluate(extractListing);
            })()
          : Promise.resolve([]);

      const [, next] = await Promise.all([handlePage(pageNum, mods), nextPage]);
      pending = next;

      if (pageNum < totalPages && pending.length === 0) {
        emit({
          type: "status",
          message: `No mods found on page ${pageNum + 1} — ending early`,
        });
        break;
      }
    }

    await listPage.close().catch(() => {});
    emitMetrics();
    emit({ type: "done", count: collected.length });
  } finally {
    await pool.closeAll();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Watch mode
// ---------------------------------------------------------------------------

async function runWatch(listPath) {
  const list = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const browser = await launchBrowser();
  const pool = new PagePool(browser, Math.min(WATCH_CONCURRENCY, list.length || 1));
  try {
    emit({
      type: "status",
      message: `Checking ${list.length} mod${list.length === 1 ? "" : "s"}…`,
    });

    // Checked in parallel, but the results are collected by index and emitted
    // in list order so the event stream stays deterministic.
    const results = await mapLimit(list, WATCH_CONCURRENCY, async (mod) => {
      const details = await scrapeModDetails(pool, {
        name: mod.name,
        url: mod.url,
        updatedFromList: "",
      });
      return {
        type: "watch",
        modId: mod.modId,
        projectId: details?.projectId ?? "Not Found",
        updated: details?.updated ?? "Not Found",
        ok: Boolean(details && details.updated !== "Not Found"),
      };
    });

    for (const result of results) {
      if (!result.ok) {
        emit({
          type: "status",
          message: `No update information found for ${result.modId}`,
        });
      }
      emit(result);
    }
    emitMetrics();
    emit({ type: "done", count: list.length });
  } finally {
    await pool.closeAll();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// Lookup mode
// ---------------------------------------------------------------------------

/**
 * Reports what each page calls itself, given only a link to it.
 *
 * A CurseForge project ID redirects to the mod's real page, so an
 * administrator who has the ID has everything needed to catalogue the mod
 * under its actual name instead of typing one in and hoping it matches.
 */
async function runLookup(listPath) {
  const list = JSON.parse(fs.readFileSync(listPath, "utf8"));
  const browser = await launchBrowser();
  const pool = new PagePool(browser, Math.min(WATCH_CONCURRENCY, list.length || 1));
  try {
    emit({
      type: "status",
      message: `Reading the mod page${list.length === 1 ? "" : "s"}…`,
    });

    const results = await mapLimit(list, WATCH_CONCURRENCY, async (mod) => {
      const details = await scrapeModDetails(pool, {
        name: "",
        url: mod.url,
        updatedFromList: "",
        // Somebody is watching a form for this answer. An unknown project ID
        // has no Project ID row to wait for, so the wait always runs to the
        // end — shorter here than for a background watch sweep.
        detailTimeout: LOOKUP_DETAIL_TIMEOUT,
      });
      return {
        type: "lookup",
        modId: mod.modId,
        name: details?.name ?? "",
        projectId: details?.projectId ?? "Not Found",
        updated: details?.updated ?? "Not Found",
        url: details?.resolvedUrl ?? mod.url,
        // A Project ID row is the proof that a mod page was reached at all. An
        // unknown ID still renders a page, and its title is the bare site name
        // — accepting that would catalogue a mod called "CurseForge".
        ok: Boolean(
          details && details.name && details.projectId !== "Not Found",
        ),
      };
    });

    for (const result of results) {
      if (!result.ok) {
        emit({
          type: "status",
          message: `No mod found for project ID ${result.modId}`,
        });
      }
      emit(result);
    }
    emitMetrics();
    emit({ type: "done", count: list.length });
  } finally {
    await pool.closeAll();
    await browser.close();
  }
}

// ---------------------------------------------------------------------------

// Only when run as a script — the pure helpers below are imported by tests,
// which must not launch Chrome or call process.exit().
const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const [mode, arg] = process.argv.slice(2);
  (async () => {
    try {
      if (mode === "cosmetics") {
        await runCosmetics(arg || null);
      } else if (mode === "watch") {
        if (!arg) throw new Error("watch mode requires a JSON list path");
        await runWatch(arg);
      } else if (mode === "lookup") {
        if (!arg) throw new Error("lookup mode requires a JSON list path");
        await runLookup(arg);
      } else {
        throw new Error(
          `Unknown mode '${mode}' — use 'cosmetics', 'watch' or 'lookup'`,
        );
      }
      process.exit(0);
    } catch (err) {
      emit({ type: "error", message: err.message || String(err) });
      process.exit(1);
    }
  })();
}

export { canonicalUrl, canReuseKnown, cleanModName, mapLimit, PagePool };
