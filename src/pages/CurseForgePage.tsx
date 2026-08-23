import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDraftsStore, recordActivity } from "../stores/draftsStore";
import { useProjectStore } from "../stores/projectStore";
import {
  activeEntries,
  CosmeticEntry,
  deprecatedEntries,
  type ScrapedMod,
  type ScrapeResult,
} from "../model/cosmetics";
import { serializeCosmetics } from "../serializers/cosmetics";
import { OUTPUT_FAMILY_LABELS } from "../model/history";
import { isWatched, sourceCurseforgeUrl } from "../model/catalog";
import { normalizeCurseforgeId } from "../model/catalogDuplicates";
import { DiscordFormatSchema } from "../model/project";
import {
  DISCORD_WEBHOOK_LIMIT,
  discordLimit,
  renderDiscordPost,
  splitDiscordPost,
} from "../model/discordPost";
import { WatchedMod } from "../model/watchlist";
import { newId } from "../model/ids";
import {
  cancelScrape,
  ScraperEvent,
  ScraperMetrics,
  startCosmeticsScrape,
  startWatchCheck,
  unsubscribe,
} from "../services/scraper";
import { isTauri, ipc } from "../services/ipc";
import { pickFile } from "../services/dialogs";
import { importCosmeticsText } from "../services/importers";
import {
  Badge,
  Button,
  Card,
  cx,
  EmptyState,
  Input,
  Modal,
  PageHeader,
} from "../components/ui";
import { toast } from "../components/toast";
import { confirmDialog } from "../components/confirm";
import { OutputPreviewModal } from "../components/OutputPreviewModal";
import { feedbackTarget } from "../model/feedback/targets";

/**
 * A scrape is only allowed to deprecate anything if it actually finished and
 * came back with a plausible catalogue. A cancelled run, a crashed browser or
 * a CurseForge layout change all produce a short list, and treating that as
 * "these mods are gone" would quietly strip the published CCM list.
 */
const MIN_TRUSTWORTHY_SCRAPE = 25;

async function copyDiscordText(content: string, success: string) {
  try {
    await navigator.clipboard.writeText(content);
    toast.success(success);
  } catch {
    toast.error(
      "Could not reach the clipboard. Select the message and copy it instead.",
    );
  }
}

export function CurseForgePage() {
  const [tab, setTab] = useState<"collector" | "watcher">("collector");
  const { hydrate } = useDraftsStore();
  useEffect(hydrate, [hydrate]);
  useEffect(() => unsubscribe, []);

  return (
    <div {...feedbackTarget("curseforge")}>
      <PageHeader
        title="CurseForge"
        subtitle="Custom cosmetics collection and mod update watching"
      />
      <div className="flex gap-1 mb-5">
        {(
          [
            ["collector", "Custom Cosmetics Collector"],
            ["watcher", "Mod Update Watcher"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              "px-4 py-2 rounded-t-lg text-sm font-medium cursor-pointer border-b-2",
              tab === key
                ? "text-white border-accent-500 bg-ink-900"
                : "text-ink-400 border-transparent hover:text-ink-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "collector" ? <Collector /> : <Watcher />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6A — Custom Cosmetics Collector
// ---------------------------------------------------------------------------

function Collector() {
  const { cosmetics, setCosmetics } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  /** The post's wording lives in Settings → Discord post format. */
  const discordFormat = settings?.discord ?? DiscordFormatSchema.parse({});
  const discordPostForNewMods = (mods: ScrapedMod[]) =>
    renderDiscordPost(discordFormat, mods, { cluster: settings?.cluster ?? "" });
  /**
   * A list of a few dozen new mods runs past Discord's per-message limit, and
   * an over-long message is not truncated — it becomes a `message.txt`
   * attachment nobody opens. So it goes out as several messages instead, cut
   * on line boundaries. The webhook is capped at 2000 whatever the admin's own
   * plan is; the Nitro setting only widens the post they copy and paste.
   */
  const copySegments = (mods: ScrapedMod[]) =>
    splitDiscordPost(discordPostForNewMods(mods), discordLimit(discordFormat.nitro));
  const webhookSegments = (mods: ScrapedMod[]) =>
    splitDiscordPost(discordPostForNewMods(mods), DISCORD_WEBHOOK_LIMIT);
  const [running, setRunning] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ page: number; total: number } | null>(null);
  const [scraped, setScraped] = useState<Map<string, ScrapedMod> | null>(null);
  const [showPrevious, setShowPrevious] = useState(false);
  /** Messages of a post too long to paste in one go, shown for copying. */
  const [copySplit, setCopySplit] = useState<string[] | null>(null);
  const [showOutput, setShowOutput] = useState(false);
  const [metrics, setMetrics] = useState<ScraperMetrics | null>(null);
  const scrapedRef = useRef(new Map<string, ScrapedMod>());
  /** Persisted with the project, so it outlives both navigation and restarts. */
  const previous = cosmetics.lastScrape;

  function pushLog(message: string) {
    setLog((prev) => [...prev.slice(-200), message]);
  }

  function handleEvent(event: ScraperEvent) {
    switch (event.type) {
      case "status":
      case "stderr":
        pushLog(event.message);
        break;
      case "pages":
        setProgress({ page: 0, total: event.total });
        pushLog(`Found ${event.total} category pages`);
        break;
      case "page":
        setProgress({ page: event.page, total: event.total });
        break;
      case "mod":
        scrapedRef.current.set(event.projectId, {
          name: event.name,
          projectId: event.projectId,
          url: event.url,
          updated: event.updated,
        });
        break;
      case "metrics":
        setMetrics(event);
        pushLog(
          `${Math.round(event.durationMs / 1000)}s · ${event.listingPages} listing pages · ` +
            `${event.detailPagesOpened} detail pages opened · ${event.reusedFromKnown} reused` +
            (event.detailFailures > 0 ? ` · ${event.detailFailures} failed` : ""),
        );
        break;
      case "done":
        pushLog(`Scrape complete — ${event.count} mods collected`);
        setScraped(new Map(scrapedRef.current));
        break;
      case "error":
        pushLog(`ERROR: ${event.message}`);
        toast.error(`Scraper error: ${event.message}`);
        break;
      case "exit":
        setRunning(false);
        break;
    }
  }

  async function run() {
    scrapedRef.current = new Map();
    setScraped(null);
    setLog([]);
    setProgress(null);
    setMetrics(null);
    setRunning(true);
    try {
      // Everything already recorded, so the sidecar can skip detail pages for
      // mods whose listing row still matches what we have.
      await startCosmeticsScrape(
        handleEvent,
        cosmetics.entries.map((e) => ({
          modId: e.modId,
          name: e.name,
          url: e.url,
          updated: e.updated,
        })),
      );
    } catch (e) {
      setRunning(false);
      toast.error(`${e instanceof Error ? e.message : e}`);
    }
  }

  async function cancel() {
    try {
      await cancelScrape();
      pushLog("Cancelled by user");
    } catch {
      /* already finished */
    }
    setRunning(false);
  }

  async function importCcmFile() {
    const path = await pickFile("Select your live CCM list file (pipe-delimited)");
    if (!path) return;
    try {
      const text = await ipc<string>("read_text_file", { path });
      const draft = importCosmeticsText(text);
      if (cosmetics.entries.length > 0) {
        const ok = await confirmDialog({
          title: "Replace cosmetic entries?",
          message: `The current ${cosmetics.entries.length} entries will be replaced by ${draft.entries.length} imported ones.`,
          confirmLabel: "Replace",
          danger: true,
        });
        if (!ok) return;
      }
      setCosmetics(draft);
      toast.success(`Imported ${draft.entries.length} cosmetic mod entries`);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const diff = useMemo(() => {
    if (!scraped) return null;
    const draftIds = new Map(cosmetics.entries.map((e) => [e.modId, e]));
    const added: ScrapedMod[] = [];
    const changed: { entry: CosmeticEntry; mod: ScrapedMod }[] = [];
    for (const mod of scraped.values()) {
      const existing = draftIds.get(mod.projectId);
      if (!existing) {
        added.push(mod);
      } else if (
        existing.updated !== mod.updated ||
        existing.name !== mod.name
      ) {
        changed.push({ entry: existing, mod });
      }
    }
    // Active entries only: something already deprecated staying missing is
    // not news, and re-reporting it every run would never let the list settle.
    const missing = activeEntries(cosmetics).filter((e) => !scraped.has(e.modId));
    // Anything deprecated that turned up again is simply back.
    const returned = deprecatedEntries(cosmetics).filter((e) =>
      scraped.has(e.modId),
    );
    // A short result is far more likely to be a broken run than a mass
    // delisting, so it is allowed to add and update but never to deprecate.
    const trustworthy = scraped.size >= MIN_TRUSTWORTHY_SCRAPE;
    return { added, changed, missing, returned, trustworthy };
  }, [scraped, cosmetics]);

  function applyScrape() {
    if (!scraped || !diff) return;
    const now = new Date().toISOString();
    const deprecating = new Set(
      diff.trustworthy ? diff.missing.map((e) => e.modId) : [],
    );

    const entries: CosmeticEntry[] = cosmetics.entries.map((entry) => {
      const mod = scraped.get(entry.modId);
      if (mod) {
        return {
          ...entry,
          name: mod.name || entry.name,
          url: mod.url || entry.url,
          updated: mod.updated || entry.updated,
          // Found again — whatever happened last time, it is listed now.
          deprecatedAt: null,
        };
      }
      return deprecating.has(entry.modId)
        ? { ...entry, deprecatedAt: now }
        : entry;
    });

    const additions: CosmeticEntry[] = diff.added.map((mod) => ({
      id: newId(),
      modId: mod.projectId,
      enableDynamicDownload: true,
      allowNonDataOnlyBlueprints: true,
      included: true,
      name: mod.name,
      url: mod.url,
      updated: mod.updated,
      notes: "",
      deprecatedAt: null,
    }));

    setCosmetics({
      schemaVersion: 1,
      entries: [...entries, ...additions],
      lastScrapeAt: now,
      lastScrape: {
        at: now,
        added: diff.added,
        deprecated: [...deprecating].map((modId) => {
          const entry = cosmetics.entries.find((e) => e.modId === modId);
          return {
            modId,
            projectId: modId,
            name: entry?.name ?? modId,
            url: entry?.url ?? "",
            updated: entry?.updated ?? "",
          } as ScrapedMod;
        }),
        changedCount: diff.changed.length,
      },
    });
    setScraped(null);
    recordActivity({
      kind: "cosmetics",
      title: `Cosmetics scan completed — ${scraped.size} entries`,
      detail: [
        `${additions.length} added`,
        `${diff.changed.length} updated`,
        deprecating.size > 0 ? `${deprecating.size} deprecated` : "",
      ]
        .filter(Boolean)
        .join(", "),
    });
    toast.success(
      `Applied scrape: ${additions.length} added, ${diff.changed.length} updated` +
        (deprecating.size > 0 ? `, ${deprecating.size} deprecated` : "") +
        (diff.returned.length > 0
          ? `, ${diff.returned.length} back on CurseForge`
          : "") +
        (!diff.trustworthy && diff.missing.length > 0
          ? ` — ${diff.missing.length} missing left active (scrape too small to trust)`
          : ""),
    );
  }

  async function copyDiscordPost(mods: ScrapedMod[]) {
    const segments = copySegments(mods);
    if (segments.length === 0) return;
    if (segments.length === 1) {
      await copyDiscordText(
        segments[0],
        `Discord post for ${mods.length} new mods copied`,
      );
      return;
    }
    // Too long for one message. Copying the lot would just hand Discord a
    // paste it turns into a message.txt attachment, so the split is shown
    // instead and each message is copied on its own.
    setCopySplit(segments);
  }

  async function postToDiscord(mods: ScrapedMod[]) {
    const segments = webhookSegments(mods);
    if (segments.length === 0) return;
    const ok = await confirmDialog({
      title: "Post to Discord?",
      message:
        `${mods.length} new cosmetic mod(s) will be posted to the stored webhook` +
        (segments.length > 1
          ? ` as ${segments.length} messages — the list is longer than Discord's ${DISCORD_WEBHOOK_LIMIT.toLocaleString()}-character limit.`
          : "."),
      confirmLabel: "Post",
    });
    if (!ok) return;
    try {
      await ipc("discord_post", { segments });
      toast.success(
        segments.length === 1
          ? "Posted to Discord"
          : `Posted to Discord in ${segments.length} messages`,
      );
    } catch (e) {
      toast.error(`Discord post failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  const active = activeEntries(cosmetics);
  const deprecated = deprecatedEntries(cosmetics);
  const included = active.filter((e) => e.included).length;

  return (
    <div className="grid grid-cols-[380px_minmax(0,1fr)] gap-5 items-start">
      <div className="flex flex-col gap-4">
        <Card title="Scrape CurseForge">
          <p className="text-xs text-ink-400 mb-3">
            Sweeps every page of the ASA custom-cosmetics category and collects
            mod IDs, names, URLs, and update dates. Takes several minutes.
          </p>
          <div className="flex gap-2 mb-3">
            <Button variant="primary" onClick={run} disabled={running || !isTauri}>
              {running ? "Scraping…" : "Run collector"}
            </Button>
            {running && (
              <Button variant="danger" onClick={cancel}>
                Cancel
              </Button>
            )}
            <Button onClick={importCcmFile} disabled={running}>
              Import CCM file…
            </Button>
          </div>
          {/* Its own row, not tucked in with the run buttons: this is the way
              back to a Discord post the admin walked away from, and it has to
              be findable without remembering where it was. */}
          <div className="flex gap-2 mb-3">
            <Button
              variant={previous ? "secondary" : "ghost"}
              disabled={!previous}
              onClick={() => setShowPrevious(true)}
              title={
                previous
                  ? `Reopen the results of the scrape applied ${new Date(previous.at).toLocaleString()}`
                  : "No scrape has been applied to this project yet"
              }
            >
              Previous Scrape
              {previous && previous.added.length > 0
                ? ` (${previous.added.length} new)`
                : ""}
            </Button>
          </div>
          {!isTauri && (
            <p className="text-xs text-amber-400">
              The scraper only runs in the desktop app.
            </p>
          )}
          {progress && progress.total > 0 && (
            <div>
              <div className="flex justify-between text-xs text-ink-400 mb-1">
                <span>
                  Page {progress.page} of {progress.total}
                </span>
                <span>{scrapedRef.current.size} mods</span>
              </div>
              <div className="h-2 bg-ink-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-600 transition-all"
                  style={{ width: `${(progress.page / progress.total) * 100}%` }}
                />
              </div>
            </div>
          )}
          {metrics && (
            <div className="mt-3 text-xs text-ink-400 border border-ink-700 rounded-md p-2">
              <div className="text-ink-200 mb-1">
                Ran in {(metrics.durationMs / 1000).toFixed(1)}s
              </div>
              <div>
                {metrics.listingPages} listing pages ·{" "}
                {metrics.detailPagesOpened} detail pages opened ·{" "}
                <span className={metrics.reusedFromKnown > 0 ? "text-accent-400" : ""}>
                  {metrics.reusedFromKnown} reused from what you already had
                </span>
              </div>
              {(metrics.detailFailures > 0 || metrics.retries > 0) && (
                <div className="text-amber-400/80">
                  {metrics.detailFailures} failed · {metrics.retries} slow
                  pages fell back to a timeout
                </div>
              )}
            </div>
          )}
          {log.length > 0 && (
            <pre className="mono bg-ink-950 border border-ink-700 rounded-md p-2 mt-3 max-h-48 overflow-y-auto text-ink-300 text-xs whitespace-pre-wrap">
              {log.slice(-30).join("\n")}
            </pre>
          )}
        </Card>

        {diff && (
          <Card
            title="Scrape results"
            actions={
              <Button variant="primary" onClick={applyScrape}>
                Apply to draft
              </Button>
            }
          >
            <div className="flex flex-col gap-1 text-sm">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone="ok">{diff.added.length} new</Badge>
                <Badge tone="info">{diff.changed.length} updated</Badge>
                <Badge tone="warn">
                  {diff.missing.length}{" "}
                  {diff.trustworthy ? "to deprecate" : "missing"}
                </Badge>
                {diff.returned.length > 0 && (
                  <Badge tone="ok">{diff.returned.length} back</Badge>
                )}
                {diff.added.length > 0 && (
                  <>
                    <Button variant="ghost" onClick={() => copyDiscordPost(diff.added)}>
                      Copy Discord post
                    </Button>
                    {isTauri && (
                      <Button variant="ghost" onClick={() => postToDiscord(diff.added)}>
                        Post to Discord
                      </Button>
                    )}
                  </>
                )}
              </div>
              {diff.added.slice(0, 20).map((mod) => (
                <div key={mod.projectId} className="text-ink-300 text-xs">
                  + {mod.name}{" "}
                  <span className="text-ink-400">[{mod.projectId}]</span>
                </div>
              ))}
              {diff.added.length > 20 && (
                <div className="text-xs text-ink-400">
                  …and {diff.added.length - 20} more new mods
                </div>
              )}
              {!diff.trustworthy && (
                <div className="text-xs rounded-md border border-amber-flag/30 bg-amber-flag/5 text-amber-300 px-2 py-1.5 mt-1">
                  Only {scraped?.size ?? 0} mods came back — below the{" "}
                  {MIN_TRUSTWORTHY_SCRAPE} needed to trust a result. New and
                  updated mods will still be applied, but nothing will be
                  deprecated: a run that was cancelled or broke partway looks
                  exactly like a mass delisting.
                </div>
              )}
              {diff.missing.slice(0, 10).map((entry) => (
                <div key={entry.modId} className="text-amber-400/80 text-xs">
                  − {entry.name || entry.modId}{" "}
                  {diff.trustworthy
                    ? "no longer on CurseForge — will be deprecated"
                    : "not found in scrape"}
                </div>
              ))}
              {diff.missing.length > 10 && (
                <div className="text-xs text-ink-400">
                  …and {diff.missing.length - 10} more
                </div>
              )}
            </div>
          </Card>
        )}

        {!diff && previous && (
          <Card title="Last applied scrape">
            {/* Stacked, not a single row: this card lives in a 380px column,
                and three buttons beside a sentence pushed the last one off
                the edge. */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge tone="ok">{previous.added.length} new</Badge>
                <Badge tone="info">{previous.changedCount} updated</Badge>
                {previous.deprecated.length > 0 && (
                  <Badge tone="warn">
                    {previous.deprecated.length} deprecated
                  </Badge>
                )}
              </div>
              <span className="text-xs text-ink-500">
                {new Date(previous.at).toLocaleString()}
              </span>
              <div className="flex gap-1.5 flex-wrap">
                <Button onClick={() => setShowPrevious(true)}>View</Button>
                <Button
                  variant="ghost"
                  disabled={previous.added.length === 0}
                  onClick={() => copyDiscordPost(previous.added)}
                >
                  Copy post
                </Button>
                {isTauri && (
                  <Button
                    variant="ghost"
                    disabled={previous.added.length === 0}
                    onClick={() => postToDiscord(previous.added)}
                  >
                    Post to Discord
                  </Button>
                )}
              </div>
            </div>
          </Card>
        )}
      </div>

      <div className="flex flex-col gap-4 min-w-0">
        <Card
          title={`Cosmetic mod entries (${included} included of ${active.length})`}
          actions={
            <>
              {cosmetics.lastScrapeAt && (
                <span className="text-xs text-ink-400">
                  Last scrape:{" "}
                  {new Date(cosmetics.lastScrapeAt).toLocaleString()}
                </span>
              )}
              <Button variant="ghost" onClick={() => setShowOutput(true)}>
                Preview output
              </Button>
            </>
          }
        >
          <CosmeticsTable />
        </Card>

        {deprecated.length > 0 && (
          <Card
            title={
              <span className="flex items-center gap-2">
                Deprecated Custom Cosmetics
                <Badge tone="warn">{deprecated.length}</Badge>
              </span>
            }
            className="border-amber-flag/30"
          >
            <p className="text-xs text-ink-400 mb-3">
              A completed scrape no longer found these on CurseForge. Everything
              known about them is kept — id, name, last-seen date — but they are
              left out of the published CCM list, because a delisted mod is a
              download every client retries and fails. If one comes back, the
              next scrape reactivates it automatically.
            </p>
            <DeprecatedCosmetics />
          </Card>
        )}
      </div>

      {showPrevious && previous && (
        <PreviousScrapeModal
          scrape={previous}
          segments={copySegments(previous.added)}
          onCopy={() => copyDiscordPost(previous.added)}
          onPost={() => postToDiscord(previous.added)}
          onClose={() => setShowPrevious(false)}
        />
      )}

      {showOutput && (
        <OutputPreviewModal
          label={OUTPUT_FAMILY_LABELS.cosmetics}
          content={serializeCosmetics(cosmetics)}
          onClose={() => setShowOutput(false)}
        />
      )}

      {copySplit && (
        <Modal
          title={`Discord post — ${copySplit.length} messages`}
          onClose={() => setCopySplit(null)}
          wide
          footer={
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => setCopySplit(null)}>
                Done
              </Button>
            </div>
          }
        >
          <DiscordMessages segments={copySplit} />
        </Modal>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * The new mods from the most recent applied scrape, with the Discord post
 * ready to copy — the thing an admin comes back for after navigating away.
 */
/**
 * The post as Discord will actually receive it: one block per message, each
 * copied on its own. A post that outgrows the character limit has to be
 * pasted in pieces, and guessing where to cut it by hand is how a masked link
 * or a bold marker ends up straddling two messages.
 */
function DiscordMessages({ segments }: { segments: string[] }) {
  const single = segments.length === 1;
  return (
    <div className="flex flex-col gap-3">
      {!single && (
        <p className="text-xs text-ink-400">
          Longer than one Discord message. Pasted whole it would arrive as a{" "}
          <span className="mono">message.txt</span> attachment, so it is split
          on line boundaries — copy and send these in order.
        </p>
      )}
      {segments.map((segment, i) => (
        <div key={i}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-semibold text-ink-300 uppercase tracking-wide">
              {single ? "Discord post" : `Message ${i + 1} of ${segments.length}`}
              <span className="ml-2 text-ink-500 normal-case font-normal">
                · {segment.length.toLocaleString()} characters
              </span>
            </span>
            <Button
              onClick={() => {
                void copyDiscordText(
                  segment,
                  single ? "Discord post copied" : `Message ${i + 1} copied`,
                );
              }}
            >
              Copy
            </Button>
          </div>
          <pre className="mono bg-ink-950 border border-ink-700 rounded-md p-3 max-h-60 overflow-auto text-ink-200 text-xs whitespace-pre-wrap">
            {segment}
          </pre>
        </div>
      ))}
    </div>
  );
}

function PreviousScrapeModal({
  scrape,
  segments,
  onCopy,
  onPost,
  onClose,
}: {
  scrape: ScrapeResult;
  segments: string[];
  onCopy: () => void;
  onPost: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title={`Previous scrape — applied ${new Date(scrape.at).toLocaleString()}`}
      onClose={onClose}
      wide
      footer={
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-500">
            Saved with the project — this stays available after a restart.
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            {isTauri && scrape.added.length > 0 && (
              <Button onClick={onPost}>Post to Discord</Button>
            )}
            {/* Only while it is one message — a split post is copied from the
                per-message buttons beside each block, and a second modal
                stacked on this one would say the same thing twice. */}
            {segments.length === 1 && (
              <Button variant="primary" onClick={onCopy}>
                Copy Discord post
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="flex items-center gap-1.5 flex-wrap mb-3">
        <Badge tone="ok">{scrape.added.length} new</Badge>
        <Badge tone="info">{scrape.changedCount} updated</Badge>
        {scrape.deprecated.length > 0 && (
          <Badge tone="warn">{scrape.deprecated.length} deprecated</Badge>
        )}
      </div>

      {scrape.deprecated.length > 0 && (
        <div className="mb-4">
          <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
            Moved to Deprecated Custom Cosmetics
          </span>
          <div className="flex flex-col gap-0.5 max-h-32 overflow-y-auto border border-ink-700 rounded-md p-2">
            {scrape.deprecated.map((mod) => (
              <div key={mod.projectId} className="text-xs text-amber-400/80">
                − {mod.name} <span className="text-ink-500">[{mod.projectId}]</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {scrape.added.length === 0 ? (
        <EmptyState title="That scrape added no new mods">
          Nothing to post — every mod on CurseForge was already in the list.
        </EmptyState>
      ) : (
        <>
          <p className="text-xs text-ink-400 mb-2">
            {scrape.added.length === 1
              ? "1 new mod was"
              : `${scrape.added.length} new mods were`}{" "}
            added to the draft.
          </p>
          <div className="flex flex-col gap-0.5 max-h-52 overflow-y-auto mb-4 border border-ink-700 rounded-md p-2">
            {scrape.added.map((mod) => (
              <div key={mod.projectId} className="text-xs text-ink-300">
                + {mod.name}{" "}
                <span className="text-ink-500">[{mod.projectId}]</span>
              </div>
            ))}
          </div>
          <DiscordMessages segments={segments} />
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

/**
 * Cosmetics a completed scrape stopped finding. Kept whole — the id and name
 * are what an admin needs when a player asks where their skin went — but out
 * of the published list until CurseForge lists them again.
 */
function DeprecatedCosmetics() {
  const { cosmetics, setCosmetics } = useDraftsStore();
  const entries = useMemo(() => deprecatedEntries(cosmetics), [cosmetics]);

  function restore(entry: CosmeticEntry) {
    setCosmetics({
      ...cosmetics,
      entries: cosmetics.entries.map((e) =>
        e.id === entry.id ? { ...e, deprecatedAt: null } : e,
      ),
    });
    toast.success(`${entry.name || entry.modId} moved back to active`);
  }

  async function forget(entry: CosmeticEntry) {
    const ok = await confirmDialog({
      title: `Forget ${entry.name || entry.modId}?`,
      message:
        "Deletes the record entirely. It comes back as a new entry if a later scrape finds the mod again.",
      confirmLabel: "Forget",
      danger: true,
    });
    if (!ok) return;
    setCosmetics({
      ...cosmetics,
      entries: cosmetics.entries.filter((e) => e.id !== entry.id),
    });
  }

  return (
    <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
      {entries.map((entry) => (
        <div
          key={entry.id}
          className="flex items-center gap-2 border border-ink-700 rounded-md px-2.5 py-1.5 bg-ink-850 group"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm text-ink-200 truncate">
              {entry.name || `Mod ${entry.modId}`}
              <span className="mono text-xs text-ink-500 ml-1.5">
                [{entry.modId}]
              </span>
            </div>
            <div className="text-xs text-ink-500">
              Deprecated{" "}
              {entry.deprecatedAt
                ? new Date(entry.deprecatedAt).toLocaleDateString()
                : "—"}
              {entry.updated && ` · last updated ${entry.updated}`}
            </div>
          </div>
          {entry.url && (
            <a
              href={entry.url}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-ink-400 hover:text-accent-400 shrink-0"
            >
              CurseForge ↗
            </a>
          )}
          <span className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              onClick={() => restore(entry)}
              title="Put this back in the active list and the published output"
            >
              Restore
            </Button>
            <Button variant="ghost" onClick={() => forget(entry)}>
              Forget
            </Button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

const PAGE_SIZE = 100;

function parseUpdatedDate(s: string): number {
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function CosmeticsTable() {
  const { cosmetics, setCosmetics } = useDraftsStore();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);

  // Deprecated entries have their own card — this table is the active list.
  const entries = useMemo(() => activeEntries(cosmetics), [cosmetics]);

  const sorted = useMemo(
    () =>
      [...entries].sort(
        (a, b) =>
          parseUpdatedDate(b.updated) - parseUpdatedDate(a.updated) ||
          a.name.localeCompare(b.name),
      ),
    [entries],
  );

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (e) => e.name.toLowerCase().includes(q) || e.modId.includes(q),
    );
  }, [sorted, search]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageEntries = filtered.slice(
    clampedPage * PAGE_SIZE,
    (clampedPage + 1) * PAGE_SIZE,
  );

  function update(id: string, patch: Partial<CosmeticEntry>) {
    setCosmetics({
      ...cosmetics,
      entries: cosmetics.entries.map((e) =>
        e.id === id ? { ...e, ...patch } : e,
      ),
    });
  }

  if (entries.length === 0) {
    return (
      <EmptyState title="No active cosmetic mods">
        Run the collector or import your live CCM file.
      </EmptyState>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <Input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          placeholder={`Search ${entries.length} entries (newest first)…`}
          className="flex-1"
        />
        <Pager page={clampedPage} pageCount={pageCount} onPage={setPage} />
      </div>
      <div className="max-h-[calc(100vh-330px)] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-ink-900 z-10">
            <tr className="text-left text-xs text-ink-400 uppercase tracking-wide">
              <th className="pb-2 w-16">Incl.</th>
              <th className="pb-2">Mod</th>
              <th className="pb-2">Updated</th>
              <th className="pb-2 w-40" title="Enable Dynamic Download / Allow Non-Data-Only Blueprints">
                Permissions (DD · NDO)
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-800">
            {pageEntries.map((entry) => (
              <tr key={entry.id} className={cx(!entry.included && "opacity-40")}>
                <td className="py-1.5">
                  <input
                    type="checkbox"
                    checked={entry.included}
                    onChange={(e) => update(entry.id, { included: e.target.checked })}
                    className="accent-(--color-accent-500) w-4 h-4"
                    title="Include in published CCM list"
                  />
                </td>
                <td className="py-1.5">
                  <div className="text-ink-100">
                    {entry.url ? (
                      <a
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:text-accent-400"
                      >
                        {entry.name || `Mod ${entry.modId}`}
                      </a>
                    ) : (
                      entry.name || `Mod ${entry.modId}`
                    )}
                  </div>
                  <div className="mono text-ink-400">{entry.modId}</div>
                </td>
                <td className="py-1.5 text-ink-300 text-xs">
                  {entry.updated || "—"}
                </td>
                <td className="py-1.5">
                  <span className="inline-flex items-center gap-3">
                    <label
                      className="inline-flex items-center gap-1 cursor-pointer"
                      title="Enable Dynamic Download"
                    >
                      <input
                        type="checkbox"
                        checked={entry.enableDynamicDownload}
                        onChange={(e) =>
                          update(entry.id, { enableDynamicDownload: e.target.checked })
                        }
                        className="accent-(--color-accent-500)"
                      />
                      <span className="text-xs text-ink-400">DD</span>
                    </label>
                    <label
                      className="inline-flex items-center gap-1 cursor-pointer"
                      title="Allow Non-Data-Only Blueprints"
                    >
                      <input
                        type="checkbox"
                        checked={entry.allowNonDataOnlyBlueprints}
                        onChange={(e) =>
                          update(entry.id, {
                            allowNonDataOnlyBlueprints: e.target.checked,
                          })
                        }
                        className="accent-(--color-accent-500)"
                      />
                      <span className="text-xs text-ink-400">NDO</span>
                    </label>
                    {(!entry.enableDynamicDownload ||
                      !entry.allowNonDataOnlyBlueprints) && (
                      <span className="mono text-xs text-amber-400">
                        {entry.enableDynamicDownload ? 1 : 0}|
                        {entry.allowNonDataOnlyBlueprints ? 1 : 0}
                      </span>
                    )}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex justify-end mt-2">
        <Pager page={clampedPage} pageCount={pageCount} onPage={setPage} />
      </div>
    </div>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  if (pageCount <= 1) return null;
  return (
    <span className="flex items-center gap-2 shrink-0 text-sm text-ink-300">
      <Button variant="ghost" disabled={page === 0} onClick={() => onPage(page - 1)}>
        ← Prev
      </Button>
      Page {page + 1} of {pageCount}
      <Button
        variant="ghost"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// 6B — Mod Update Watcher (every enabled mod in Content Sources is watched)
// ---------------------------------------------------------------------------

/**
 * The enabled mods' CurseForge IDs, the enabled mods that have none, and any
 * ID claimed by more than one source.
 *
 * Content Sources blocks new duplicate IDs, but a project saved before that
 * check can still hold them — and a repeated ID in the server's `-mods=`
 * argument is exactly the kind of thing that is painful to spot by eye. The
 * list is emitted once per ID; the duplicates are named instead.
 */
function useEnabledModIds() {
  const catalog = useDraftsStore((s) => s.catalog);
  return useMemo(() => {
    const ids: string[] = [];
    const missing: string[] = [];
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const source of catalog.sources) {
      if (!source.enabled) continue;
      const id = normalizeCurseforgeId(source.curseforgeId);
      if (!id) {
        missing.push(source.name);
        continue;
      }
      const owner = seen.get(id);
      if (owner) {
        duplicates.push(`${id} (${owner} and ${source.name})`);
        continue;
      }
      seen.set(id, source.name);
      ids.push(id);
    }
    return { ids, missing, duplicates };
  }, [catalog.sources]);
}

/**
 * The cluster's enabled mods as a comma-separated ID list — the shape the
 * server's `-mods=` launch argument and CurseForge's bulk tools both want.
 */
function EnabledModIdsModal({ onClose }: { onClose: () => void }) {
  const { ids, missing, duplicates } = useEnabledModIds();
  const list = ids.join(",");

  return (
    <Modal title={`Enabled mod IDs (${ids.length})`} onClose={onClose} wide>
      <p className="text-xs text-ink-400 mb-3">
        Every mod marked Enabled in{" "}
        <Link to="/content" className="text-accent-400 hover:underline">
          Content Sources
        </Link>
        , comma-separated — ready to paste into the server's mod list.
      </p>
      {ids.length === 0 ? (
        <EmptyState title="No enabled mods with a CurseForge ID" />
      ) : (
        <textarea
          readOnly
          value={list}
          rows={4}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          className="w-full bg-ink-950 border border-ink-700 rounded-md p-3 mono text-ink-200 focus:outline-none focus:border-accent-500/60 resize-none"
        />
      )}
      {missing.length > 0 && (
        <p className="text-xs text-amber-400 mt-2">
          Left out — no CurseForge ID recorded: {missing.join(", ")}
        </p>
      )}
      {duplicates.length > 0 && (
        <p className="text-xs text-amber-400 mt-2">
          Listed once each — these project IDs are on more than one source in{" "}
          <Link to="/content" className="text-accent-400 hover:underline">
            Content Sources
          </Link>
          : {duplicates.join(", ")}
        </p>
      )}
      <div className="flex justify-end gap-2 mt-3">
        <Button
          variant="primary"
          disabled={ids.length === 0}
          onClick={() => {
            navigator.clipboard.writeText(list);
            toast.success(`Copied ${ids.length} mod IDs`);
          }}
        >
          Copy all
        </Button>
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}

function Watcher() {
  const { catalog, setCatalog, watchlist, setWatchlist } = useDraftsStore();
  const [running, setRunning] = useState(false);
  const [idsOpen, setIdsOpen] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const { ids: enabledIds } = useEnabledModIds();
  const resultsRef = useRef(new Map<string, { updated: string; ok: boolean }>());

  const watchedSources = useMemo(
    () => catalog.sources.filter(isWatched),
    [catalog.sources],
  );

  /**
   * Keeps watchlist entries in step with the watched content sources. Entries
   * for mods that are no longer watched are kept and flagged instead of
   * dropped, so re-watching resumes from the version the admin last
   * acknowledged rather than starting blind.
   */
  useEffect(() => {
    const current = watchlist.mods;
    const watchedIds = new Set(
      watchedSources.map((s) => s.curseforgeId || s.id),
    );

    const next: WatchedMod[] = watchedSources.map((source) => {
      const modId = source.curseforgeId || source.id;
      const url = sourceCurseforgeUrl(source) ?? "";
      const existing = current.find((m) => m.modId === modId);
      if (existing) {
        return existing.name !== source.name ||
          existing.url !== url ||
          !existing.watching
          ? { ...existing, name: source.name, url, watching: true }
          : existing;
      }
      return {
        id: newId(),
        modId,
        name: source.name,
        url,
        knownUpdated: "",
        latestUpdated: "",
        lastCheckedAt: null,
        needsReview: false,
        notes: "",
        watching: true,
      };
    });

    // Everything else keeps its history, parked.
    for (const mod of current) {
      if (watchedIds.has(mod.modId)) continue;
      next.push(mod.watching ? { ...mod, watching: false } : mod);
    }

    const changed =
      next.length !== current.length || next.some((m, i) => m !== current[i]);
    if (changed) {
      setWatchlist({ ...watchlist, mods: next });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedSources]);

  function pushLog(message: string) {
    setLog((prev) => [...prev.slice(-100), message]);
  }

  function handleEvent(event: ScraperEvent) {
    switch (event.type) {
      case "status":
      case "stderr":
        pushLog(event.message);
        break;
      case "watch":
        resultsRef.current.set(event.modId, {
          updated: event.updated,
          ok: event.ok,
        });
        break;
      case "metrics":
        pushLog(
          `Checked in ${(event.durationMs / 1000).toFixed(1)}s` +
            (event.detailFailures > 0
              ? ` — ${event.detailFailures} could not be read`
              : ""),
        );
        break;
      case "error":
        pushLog(`ERROR: ${event.message}`);
        toast.error(`Watcher error: ${event.message}`);
        break;
      case "done":
        applyResults();
        break;
      case "exit":
        setRunning(false);
        break;
    }
  }

  function applyResults() {
    const results = resultsRef.current;
    const now = new Date().toISOString();
    const current = useDraftsStore.getState().watchlist;
    let flagged = 0;
    const mods = current.mods.map((mod) => {
      const result = results.get(mod.modId);
      if (!result || !result.ok) return { ...mod, lastCheckedAt: now };
      const first = !mod.knownUpdated;
      const changed = !first && result.updated !== mod.knownUpdated;
      if (changed) flagged++;
      return {
        ...mod,
        lastCheckedAt: now,
        latestUpdated: result.updated,
        knownUpdated: first ? result.updated : mod.knownUpdated,
        needsReview: mod.needsReview || changed,
      };
    });
    setWatchlist({ ...current, mods });
    pushLog(
      flagged > 0
        ? `${flagged} mod(s) have new versions and need review`
        : "No new updates detected",
    );
    if (flagged > 0) toast.info(`${flagged} watched mod(s) need review`);
  }

  async function checkNow() {
    if (active.length === 0) {
      toast.error(
        "No watched mods — enable a mod in Content Sources and give it a CurseForge URL or project ID",
      );
      return;
    }
    resultsRef.current = new Map();
    setLog([]);
    setRunning(true);
    try {
      await startWatchCheck(
        active.map((m) => ({ modId: m.modId, name: m.name, url: m.url })),
        handleEvent,
      );
    } catch (e) {
      setRunning(false);
      toast.error(`${e instanceof Error ? e.message : e}`);
    }
  }

  function update(id: string, patch: Partial<WatchedMod>) {
    setWatchlist({
      ...watchlist,
      mods: watchlist.mods.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    });
  }

  /**
   * Watching follows the mod's Enabled state, so the only way to stop watching
   * is to disable the mod — which is a much bigger statement than it used to
   * be, and the dialog has to say so plainly rather than bury it.
   */
  async function stopWatching(mod: WatchedMod) {
    const source = catalog.sources.find(
      (s) => (s.curseforgeId || s.id) === mod.modId,
    );
    if (!source) return;
    const ok = await confirmDialog({
      title: `Disable "${source.name}" to stop watching it?`,
      message:
        "Update checks follow a mod's Enabled state, so this marks the mod as not running on the cluster — the same as switching it off in Content Sources.",
      details: [
        "Its creatures and items stay catalogued and keep working in rules and remaps",
        "The acknowledged version and your review notes are kept, so re-enabling picks up where you left off",
      ],
      confirmLabel: "Disable mod",
      danger: true,
    });
    if (!ok) return;
    setCatalog({
      ...catalog,
      sources: catalog.sources.map((s) =>
        s.id === source.id ? { ...s, enabled: false } : s,
      ),
    });
  }

  const active = watchlist.mods.filter((m) => m.watching);
  const parked = watchlist.mods.filter((m) => !m.watching);
  const needingReview = active.filter((m) => m.needsReview).length;

  async function forget(mod: WatchedMod) {
    const ok = await confirmDialog({
      title: `Forget "${mod.name}"?`,
      message:
        "Discards the acknowledged version and review notes kept for this mod. If it is watched again later, it starts from scratch.",
      confirmLabel: "Forget",
      danger: true,
    });
    if (!ok) return;
    setWatchlist({
      ...watchlist,
      mods: watchlist.mods.filter((m) => m.id !== mod.id),
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            Watched mods ({active.length})
            {needingReview > 0 && (
              <Badge tone="warn">{needingReview} need review</Badge>
            )}
          </span>
        }
        actions={
          <>
            <Button onClick={() => setIdsOpen(true)}>
              Enabled mod IDs ({enabledIds.length})…
            </Button>
            <Button variant="primary" onClick={checkNow} disabled={running || !isTauri}>
              {running ? "Checking…" : "Check now"}
            </Button>
            {running && (
              <Button
                variant="danger"
                onClick={async () => {
                  await cancelScrape().catch(() => {});
                  setRunning(false);
                }}
              >
                Cancel
              </Button>
            )}
          </>
        }
      >
        <p className="text-xs text-ink-400 mb-3">
          Every mod you have enabled in{" "}
          <Link to="/content" className="text-accent-400 hover:underline">
            Content Sources
          </Link>{" "}
          is watched, as long as it has a CurseForge URL or project ID to check
          against. Disable a mod there to stop watching it.
        </p>
        {!isTauri && (
          <p className="text-xs text-amber-400 mb-3">
            Update checks only run in the desktop app.
          </p>
        )}
        {active.length === 0 ? (
          <EmptyState title="No watched mods">
            Add your cluster's mods in Content Sources. Each one that is enabled
            and has a CurseForge URL or project ID shows up here.
          </EmptyState>
        ) : (
          <div className="flex flex-col divide-y divide-ink-800">
            {active.map((mod) => (
              <div key={mod.id} className="py-3 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <a
                      href={mod.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm font-medium text-ink-100 hover:text-accent-400"
                    >
                      {mod.name}
                    </a>
                    <span className="mono text-xs text-ink-400">{mod.modId}</span>
                    {mod.needsReview ? (
                      <Badge tone="warn">Update detected — review</Badge>
                    ) : mod.lastCheckedAt ? (
                      <Badge tone="ok">Up to date</Badge>
                    ) : (
                      <Badge tone="neutral">Never checked</Badge>
                    )}
                  </div>
                  <div className="text-xs text-ink-400 mt-1">
                    Known: {mod.knownUpdated || "—"}
                    {mod.latestUpdated &&
                      mod.latestUpdated !== mod.knownUpdated &&
                      ` → Latest: ${mod.latestUpdated}`}
                    {mod.lastCheckedAt &&
                      ` · Checked ${new Date(mod.lastCheckedAt).toLocaleString()}`}
                  </div>
                  <Input
                    value={mod.notes}
                    onChange={(e) => update(mod.id, { notes: e.target.value })}
                    placeholder="Review notes (new creatures? new items? balance changes?)"
                    className="mt-2 text-xs"
                  />
                </div>
                <div className="flex flex-col gap-1.5 shrink-0">
                  {mod.needsReview && (
                    <Button
                      variant="primary"
                      onClick={() => {
                        update(mod.id, {
                          needsReview: false,
                          knownUpdated: mod.latestUpdated || mod.knownUpdated,
                        });
                        recordActivity({
                          kind: "watchlist",
                          title: `Reviewed ${mod.name}`,
                          detail: mod.latestUpdated
                            ? `updated ${mod.latestUpdated}`
                            : "",
                        });
                      }}
                    >
                      Mark reviewed
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => stopWatching(mod)}>
                    Stop watching
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        {log.length > 0 && (
          <pre className="mono bg-ink-950 border border-ink-700 rounded-md p-2 mt-3 max-h-40 overflow-y-auto text-ink-300 text-xs whitespace-pre-wrap">
            {log.slice(-15).join("\n")}
          </pre>
        )}
      </Card>

      {parked.length > 0 && (
        <Card title={`Not currently watched (${parked.length})`}>
          <p className="text-xs text-ink-400 mb-3">
            Mods that are disabled, or have no CurseForge URL or project ID to
            check. Their history is kept: re-enable one in{" "}
            <Link to="/content" className="text-accent-400 hover:underline">
              Content Sources
            </Link>{" "}
            and the next check compares against the version below — so an update
            released while it was unwatched still gets flagged.
          </p>
          <div className="flex flex-col divide-y divide-ink-800">
            {parked.map((mod) => (
              <div
                key={mod.id}
                className="py-2 flex items-center justify-between gap-4"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-ink-200">{mod.name}</span>
                    <span className="mono text-xs text-ink-500">{mod.modId}</span>
                  </div>
                  <div className="text-xs text-ink-400">
                    Acknowledged: {mod.knownUpdated || "—"}
                    {mod.lastCheckedAt &&
                      ` · Last checked ${new Date(mod.lastCheckedAt).toLocaleDateString()}`}
                    {mod.notes && ` · ${mod.notes}`}
                  </div>
                </div>
                <Button variant="ghost" onClick={() => forget(mod)}>
                  Forget
                </Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {idsOpen && <EnabledModIdsModal onClose={() => setIdsOpen(false)} />}
    </div>
  );
}
