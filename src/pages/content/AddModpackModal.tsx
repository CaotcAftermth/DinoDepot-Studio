import { useCallback, useEffect, useMemo, useState } from "react";
import { newId } from "../../model/ids";
import { normalizeBpPath, type CatalogEntry, type ContentSource } from "../../model/catalog";
import {
  applyDiscovery,
  impactedReferences,
  planDiscovery,
  referencedBlueprintPaths,
  type DiscoveryPlan,
} from "../../model/modDiscovery";
import {
  discoverInstalledMods,
  listInstalledMods,
  resolveModsRoot,
  type InstalledModSummary,
} from "../../services/modDiscovery";
import { normalizeCurseforgeId } from "../../model/catalogDuplicates";
import {
  applyModpack,
  compareVersions,
  searchRegistry,
  templateModpack,
  templateReadme,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
} from "../../model/modpack";
import {
  fetchPack,
  fetchPackIcons,
  fetchRegistry,
  registryBrowseUrl,
  type FetchedIcon,
  type RegistryListing,
} from "../../services/modpackRegistry";
import { packFromFile, packFromUrl } from "../../services/modpackSource";
import { useProjectStore } from "../../stores/projectStore";
import { useDraftsStore } from "../../stores/draftsStore";
import { openExternal } from "../../services/openExternal";
import { pickFile, pickFolder, pickSavePath } from "../../services/dialogs";
import { ipc, isTauri } from "../../services/ipc";
import {
  Badge,
  Button,
  cx,
  Field,
  Input,
  Modal,
  Toggle,
} from "../../components/ui";
import { toast } from "../../components/toast";
import { confirmDialog } from "../../components/confirm";

type Tab = "registry" | "discover" | "manual" | "template";

/**
 * Adding a mod, four ways.
 *
 * Search comes first because it is the one that should usually work: someone
 * has already catalogued this mod, and repeating that work is the thing the
 * registry exists to prevent. Discovery is next — for a mod nobody has
 * published, reading the installed files beats typing every blueprint path by
 * hand. Manual entry stays exactly as it was for everything else, and the
 * template turns that manual work into a pack the next admin gets for free.
 */
export function AddModpackModal({
  registry,
  findIdConflict,
  onAddManual,
  onInstalled,
  onClose,
}: {
  registry: ModpackRegistry;
  findIdConflict: (curseforgeId: string) => ContentSource | null;
  onAddManual: (source: ContentSource) => void;
  onInstalled: (sourceId: string, name: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("registry");

  return (
    <Modal title="Add mod content source" onClose={onClose} wide>
      <div className="flex items-center gap-4 border-b border-ink-700 mb-4">
        {(
          [
            ["registry", "Search modpacks"],
            ["discover", "Discover installed"],
            ["manual", "Add manually"],
            ["template", "Build a modpack"],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cx(
              "cursor-pointer pb-2 border-b-2 text-sm",
              tab === key
                ? "text-white border-accent-500"
                : "text-ink-400 border-transparent hover:text-ink-200",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "registry" && (
        <RegistryTab
          registry={registry}
          onInstalled={onInstalled}
          onClose={onClose}
          onManual={() => setTab("manual")}
          onTemplate={() => setTab("template")}
        />
      )}
      {tab === "discover" && (
        <DiscoverTab
          onInstalled={onInstalled}
          onClose={onClose}
          onManual={() => setTab("manual")}
        />
      )}
      {tab === "manual" && (
        <ManualTab
          findIdConflict={findIdConflict}
          onAdd={onAddManual}
          onClose={onClose}
        />
      )}
      {tab === "template" && <TemplateTab registry={registry} />}
    </Modal>
  );
}

// ---------------------------------------------------------------------------

function RegistryTab({
  registry,
  onInstalled,
  onClose,
  onManual,
  onTemplate,
}: {
  registry: ModpackRegistry;
  onInstalled: (sourceId: string, name: string) => void;
  onClose: () => void;
  onManual: () => void;
  onTemplate: () => void;
}) {
  const { catalog, setCatalog, refreshImages } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const projectDir = useProjectStore((s) => s.dir);
  const imagesDir =
    settings?.imagesDir?.trim() || (projectDir ? `${projectDir}/images` : "");
  const [listing, setListing] = useState<RegistryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [installing, setInstalling] = useState("");
  /** A pasted link to a pack that the index does not list. */
  const [link, setLink] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetchRegistry(registry)
      .then((result) => {
        if (!cancelled) setListing(result);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [registry]);

  const results = useMemo(
    () => searchRegistry(listing?.packs ?? [], query),
    [listing, query],
  );

  /** What this project already has installed, by pack id. */
  const installed = useMemo(() => {
    const map = new Map<string, ContentSource>();
    for (const source of catalog.sources) {
      if (source.modpackId) map.set(source.modpackId, source);
    }
    return map;
  }, [catalog.sources]);

  /**
   * Installs a pack, however it was found.
   *
   * One path for all three routes — the search list, a pasted link, a file on
   * disk — so a pack picked up from a pull request lands exactly as one from
   * the index does, including its icons and the "keep what you wrote" rule.
   */
  async function installFrom(
    key: string,
    load: () => Promise<{
      pack: Modpack;
      icons: () => Promise<FetchedIcon[]>;
    }>,
  ) {
    setInstalling(key);
    try {
      const { pack, icons } = await load();
      const already = installed.get(pack.meta.id);
      if (already) {
        const ok = await confirmDialog({
          title: `Update "${already.name}" to ${pack.meta.version}?`,
          message:
            `Installed: ${already.modpackVersion || "unknown"}. ` +
            "The mod's creatures, items and INI settings are replaced with the new version. " +
            "Anything you wrote yourself on its entries is kept.",
          confirmLabel: `Update to ${pack.meta.version}`,
        });
        if (!ok) return;
      }

      const result = applyModpack(catalog, pack, newId);
      setCatalog(result.catalog);

      // Icons are image files rather than data, so they land in the project's
      // images folder — the same place the icon picker already reads from.
      // A failure here costs icons, never the install.
      let iconsWritten = 0;
      if (isTauri && imagesDir) {
        try {
          for (const icon of await icons()) {
            const sep = imagesDir.includes("\\") && !imagesDir.includes("/") ? "\\" : "/";
            await ipc("save_file_b64", {
              path: `${imagesDir.replace(/[/\\]$/, "")}${sep}${icon.name}`,
              contentB64: icon.contentB64,
            });
            iconsWritten++;
          }
          if (iconsWritten > 0) void refreshImages();
        } catch {
          /* the pack is installed; icons fall back to category emoji */
        }
      }

      onInstalled(result.sourceId, pack.meta.name);
      toast.success(
        (result.updated
          ? `${pack.meta.name} updated to ${pack.meta.version}` +
            (result.keptLocal > 0
              ? ` · ${result.keptLocal} of your own entries kept`
              : "")
          : `${pack.meta.name} added — ${pack.creatures.length} creatures, ${pack.items.length} items`) +
          (iconsWritten > 0 ? ` · ${iconsWritten} icons` : ""),
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling("");
    }
  }

  function install(entry: RegistryEntry) {
    return installFrom(entry.id, async () => {
      const pack = await fetchPack(registry, entry);
      return {
        pack,
        icons: async () => (await fetchPackIcons(registry, entry, pack)).icons,
      };
    });
  }

  /** A pack someone linked — a registry folder, a fork, a pull request. */
  function installLink() {
    return installFrom("link", () => packFromUrl(link, registry));
  }

  /** A pack sitting on this machine, sent over or built by hand. */
  async function installFile() {
    const path = await pickFile("Open a modpack", [
      { name: "Modpack", extensions: ["json"] },
    ]);
    if (!path) return;
    await installFrom("file", () => packFromFile(path));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by mod name or CurseForge ID…"
        />
        <Button
          className="shrink-0"
          onClick={() => void openExternal(registryBrowseUrl(registry))}
          title="Browse the published modpacks on GitHub"
        >
          Browse ↗
        </Button>
      </div>

      {/*
        Browsing opens GitHub, and until now that was a dead end: whatever you
        found there could not be installed unless the index happened to list
        it. A link or a file is what you come back with, so both install.
      */}
      <div className="border border-ink-700 rounded-lg p-3 flex flex-col gap-2">
        <p className="text-xs text-ink-400">
          Found one while browsing, or been sent a pack? Paste the link to its
          folder or <span className="mono">modpack.json</span> — a pull request
          or a fork works too — or open one saved on this machine.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder="https://github.com/…/ModPacks/972253-Ports_of_Atlas"
          />
          <Button
            variant="primary"
            className="shrink-0"
            disabled={!link.trim() || Boolean(installing)}
            onClick={() => void installLink()}
          >
            {installing === "link" ? "Adding…" : "Add from link"}
          </Button>
          <Button
            className="shrink-0"
            disabled={!isTauri || Boolean(installing)}
            title={
              isTauri
                ? "Open a modpack.json saved on this machine"
                : "Reading files only works in the desktop app"
            }
            onClick={() => void installFile()}
          >
            {installing === "file" ? "Adding…" : "Add from file…"}
          </Button>
        </div>
      </div>

      {loading && (
        <p className="text-sm text-ink-400 py-8 text-center">
          Loading the modpack registry…
        </p>
      )}

      {!loading && error && (
        <div className="border border-danger/30 bg-danger/5 rounded-lg p-3">
          <p className="text-sm text-red-300">{error}</p>
          <p className="text-xs text-ink-400 mt-1">
            You can still add this mod by hand, or build a pack for it.
          </p>
          <div className="flex gap-2 mt-2">
            <Button onClick={onManual}>Add manually</Button>
            <Button variant="ghost" onClick={onTemplate}>
              Build a modpack
            </Button>
          </div>
        </div>
      )}

      {!loading && !error && listing && (
        <>
          {listing.unindexed && (
            <p className="text-xs text-ink-500">
              This registry has no <span className="mono">index.json</span>, so
              packs were read one by one
              {listing.truncated && " — only the first 40 are listed"}.
            </p>
          )}

          {results.length === 0 ? (
            <div className="border border-dashed border-ink-700 rounded-lg px-4 py-6 text-center">
              <p className="text-sm text-ink-300">
                {query.trim()
                  ? `No published modpack matches "${query.trim()}".`
                  : "No modpacks published yet."}
              </p>
              <p className="text-xs text-ink-400 mt-1">
                Add the mod by hand, or start a pack for it so the next admin
                gets it for free.
              </p>
              <div className="flex gap-2 justify-center mt-3">
                <Button variant="primary" onClick={onManual}>
                  Add manually
                </Button>
                <Button onClick={onTemplate}>Build a modpack</Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto pr-1">
              {results.map((entry) => {
                const already = installed.get(entry.id);
                const outdated =
                  already &&
                  compareVersions(entry.version, already.modpackVersion) > 0;
                return (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 border border-ink-700 rounded-lg px-3 py-2 min-w-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm text-ink-100">{entry.name}</span>
                        <span className="text-xs text-ink-500">
                          v{entry.version}
                        </span>
                        {already && !outdated && (
                          <Badge tone="ok">Installed</Badge>
                        )}
                        {outdated && <Badge tone="warn">Update available</Badge>}
                      </div>
                      {entry.description && (
                        <div className="text-xs text-ink-400 truncate">
                          {entry.description}
                        </div>
                      )}
                      <div className="text-xs text-ink-500">
                        {entry.creatureCount} creature
                        {entry.creatureCount === 1 ? "" : "s"} ·{" "}
                        {entry.itemCount} item
                        {entry.itemCount === 1 ? "" : "s"}
                        {entry.author && ` · by ${entry.author}`}
                        {entry.curseforgeId && ` · CF ${entry.curseforgeId}`}
                      </div>
                    </div>
                    <Button
                      variant={already && !outdated ? "ghost" : "primary"}
                      className="shrink-0"
                      disabled={
                        installing === entry.id || Boolean(already && !outdated)
                      }
                      onClick={() => void install(entry)}
                    >
                      {installing === entry.id
                        ? "Adding…"
                        : outdated
                          ? "Update"
                          : already
                            ? "Added"
                            : "Add"}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Cataloguing a mod from the copy already installed on this machine.
 *
 * An installed ASA mod ships a plain-text listing of everything it cooked, so
 * its creatures and items can be read straight off disk instead of typed in one
 * blueprint path at a time. What comes back is a strong first draft rather than
 * fact — the listing gives paths, not types, so classification is a naming
 * convention — which is why nothing is written until it has been reviewed.
 */
function DiscoverTab({
  onInstalled,
  onClose,
  onManual,
}: {
  onInstalled: (sourceId: string, name: string) => void;
  onClose: () => void;
  onManual: () => void;
}) {
  const { catalog, setCatalog, cosmetics, production, remaps } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  const saveSettings = useProjectStore((s) => s.saveSettings);
  const root = settings?.modsDir?.trim() ?? "";

  const [listing, setListing] = useState<InstalledModSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showCosmetics, setShowCosmetics] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Non-null once discovery has run: the review stage. */
  const [plans, setPlans] = useState<DiscoveryPlan[] | null>(null);
  const [keepUnmatched, setKeepUnmatched] = useState(true);
  const [busy, setBusy] = useState(false);
  /** Normalized paths unticked during review, across every mod being applied. */
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  /** Which per-mod entry lists are open, keyed `<shortName>:<kind>`. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const setExclusion = useCallback((paths: string[], drop: boolean) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      for (const path of paths) {
        if (drop) next.add(normalizeBpPath(path));
        else next.delete(normalizeBpPath(path));
      }
      return next;
    });
  }, []);

  /** The mod ids the project already treats as cosmetics. */
  const cosmeticIds = useMemo(
    () => new Set(cosmetics.entries.map((e) => e.modId).filter(Boolean)),
    [cosmetics.entries],
  );

  /** CurseForge ids already catalogued, so a re-scan reads as an update. */
  const existingIds = useMemo(
    () =>
      new Set(
        catalog.sources
          .filter((s) => s.kind === "mod" && s.curseforgeId.trim())
          .map((s) => s.curseforgeId.trim()),
      ),
    [catalog.sources],
  );

  const load = useCallback(
    async (from: string) => {
      setLoading(true);
      setError("");
      try {
        setListing(await listInstalledMods(from, cosmeticIds));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setListing(null);
      } finally {
        setLoading(false);
      }
    },
    [cosmeticIds],
  );

  useEffect(() => {
    if (root) void load(root);
  }, [root, load]);

  /** Points the project at an install, accepting the game folder or the mods folder. */
  async function chooseFolder() {
    const picked = await pickFolder(
      "Select the Ark: Survival Ascended install folder",
    );
    if (!picked || !settings) return;
    setBusy(true);
    setError("");
    try {
      const resolved = await resolveModsRoot(picked);
      await saveSettings({ ...settings, modsDir: resolved });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (listing ?? []).filter((mod) => {
      if (!showCosmetics && mod.cosmetic) return false;
      if (!q) return true;
      return (
        mod.name.toLowerCase().includes(q) ||
        mod.shortName.toLowerCase().includes(q) ||
        mod.projectId.includes(q)
      );
    });
  }, [listing, query, showCosmetics]);

  const hiddenCosmetics = (listing ?? []).filter((m) => m.cosmetic).length;

  function toggle(folderName: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(folderName)) next.delete(folderName);
      else next.add(folderName);
      return next;
    });
  }

  /** Reads the selected mods and works out what applying them would do. */
  async function review() {
    setBusy(true);
    setError("");
    try {
      const discovered = await discoverInstalledMods(root, [...selected], newId);
      setPlans(discovered.map((mod) => planDiscovery(catalog, mod)));
      setExcluded(new Set());
      setExpanded(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /** Commits the reviewed plans, threading the catalog through each one. */
  function apply() {
    if (!plans) return;
    let next = catalog;
    let firstSource: { id: string; name: string } | null = null;
    let creatures = 0;
    let items = 0;

    const kept = (entries: { bpPath: string }[]) =>
      entries.filter((e) => !excluded.has(normalizeBpPath(e.bpPath))).length;

    for (const plan of plans) {
      const result = applyDiscovery(next, plan, newId, {
        keepUnmatched,
        exclude: excluded,
      });
      next = result.catalog;
      creatures += kept(plan.mod.creatures);
      items += kept(plan.mod.items);
      if (!firstSource) firstSource = { id: result.sourceId, name: plan.mod.name };
    }

    setCatalog(next);
    if (firstSource) onInstalled(firstSource.id, firstSource.name);
    toast.success(
      `${plans.length} mod${plans.length === 1 ? "" : "s"} catalogued — ` +
        `${creatures} creatures, ${items} items`,
    );
    onClose();
  }

  // --- no install configured yet -------------------------------------------
  if (!root) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-300">
          Reads mods already installed on this machine and catalogues their
          creatures and items automatically — no blueprint paths typed by hand.
        </p>
        <div className="border border-ink-700 rounded-lg p-3">
          <p className="text-sm text-ink-300 mb-2">
            Point this at your Ark: Survival Ascended install — the folder
            containing <span className="mono">ShooterGame</span>. A dedicated
            server install works just as well as the game.
          </p>
          <Button
            variant="primary"
            disabled={!isTauri || busy || !settings}
            title={
              isTauri
                ? "Choose the install folder"
                : "Reading installed mods only works in the desktop app"
            }
            onClick={() => void chooseFolder()}
          >
            {busy ? "Checking…" : "Choose install folder…"}
          </Button>
          {!isTauri && (
            <p className="text-xs text-amber-400 mt-2">
              Reading installed mods only works in the desktop app.
            </p>
          )}
          {error && <p className="text-xs text-red-300 mt-2">{error}</p>}
        </div>
        <p className="text-xs text-ink-400">
          Only have the mod's page rather than the files?{" "}
          <button className="underline cursor-pointer" onClick={onManual}>
            Add it by hand
          </button>{" "}
          instead.
        </p>
      </div>
    );
  }

  // --- review stage ---------------------------------------------------------
  if (plans) {
    const nothingToDo = plans.every((p) => p.noChanges);
    /**
     * Config this update would orphan. Worth seeing before applying: a rule
     * pointing at a moved path keeps validating while producing nothing, and
     * afterwards all the validation can say is that the path is unknown.
     */
    const impacts = impactedReferences(
      referencedBlueprintPaths(production, remaps),
      plans.flatMap((p) => [p.creatures, p.items]),
    );

    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm text-ink-300">
            Nothing has been saved yet — this is what applying would do.
          </p>
          <Button variant="ghost" onClick={() => setPlans(null)}>
            ← Back to the list
          </Button>
        </div>

        {impacts.length > 0 && (
          <div className="border border-danger/30 bg-danger/5 rounded-lg p-3">
            <p className="text-sm text-red-300">
              This affects {impacts.length} place
              {impacts.length === 1 ? "" : "s"} in your config.
            </p>
            <div className="flex flex-col gap-0.5 mt-1.5 max-h-32 overflow-y-auto">
              {impacts.map((impact) => (
                <div
                  key={`${impact.reference.where}:${impact.reference.bpPath}`}
                  className="text-xs text-ink-300"
                >
                  <span className="text-ink-400">
                    {impact.reference.kind === "remap" ? "Remap" : "Rule"}
                  </span>{" "}
                  {impact.reference.where} —{" "}
                  {impact.movedTo ? (
                    <>
                      moved to <span className="mono">{impact.movedTo}</span>
                    </>
                  ) : (
                    <span className="text-red-300">
                      no longer exists in the mod
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-ink-400 mt-1.5">
              Applying does not rewrite your rules — update these yourself
              afterwards, or go back and leave this mod out for now.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto pr-1">
          {plans.map((plan) => {
            const { mod } = plan;
            const isNew = !plan.existingSourceId;
            return (
              <div
                key={mod.shortName}
                className="border border-ink-700 rounded-lg px-3 py-2"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-ink-100">{mod.name}</span>
                  {isNew ? (
                    <Badge tone="ok">New source</Badge>
                  ) : plan.noChanges ? (
                    <Badge>No changes</Badge>
                  ) : (
                    <Badge tone="warn">Update</Badge>
                  )}
                  {mod.variantTag && (
                    <span className="text-xs text-ink-500">
                      variant tag “{mod.variantTag}”
                    </span>
                  )}
                </div>

                <div className="text-xs text-ink-400 mt-0.5">
                  {isNew ? (
                    <>
                      {mod.creatures.length} creature
                      {mod.creatures.length === 1 ? "" : "s"} ·{" "}
                      {mod.items.length} item
                      {mod.items.length === 1 ? "" : "s"}
                    </>
                  ) : (
                    <>
                      creatures +{plan.creatures.added.length} −
                      {plan.creatures.removed.length}
                      {plan.creatures.renamed.length > 0 &&
                        ` ↻${plan.creatures.renamed.length}`}{" "}
                      · items +{plan.items.added.length} −
                      {plan.items.removed.length}
                      {plan.items.renamed.length > 0 &&
                        ` ↻${plan.items.renamed.length}`}
                    </>
                  )}
                  {mod.counts.engram > 0 && ` · ${mod.counts.engram} engrams skipped`}
                </div>

                {/*
                  A rename is the case worth reading carefully: config pointing
                  at the old path keeps validating while doing nothing in game.
                */}
                {[...plan.creatures.renamed, ...plan.items.renamed]
                  .slice(0, 3)
                  .map((r) => (
                    <div key={r.from.bpPath} className="text-xs text-amber-400 mt-1">
                      moved: {r.from.name} → <span className="mono">{r.to.bpPath}</span>
                    </div>
                  ))}

                {mod.warnings.map((w) => (
                  <div key={w} className="text-xs text-amber-400 mt-1">
                    {w}
                  </div>
                ))}

                {/*
                  The actual entries. Classification is a guess from naming
                  conventions, so being able to read the list — and drop what
                  should not be in a picker — is the point of reviewing at all.
                */}
                <div className="flex gap-2 mt-2">
                  {(
                    [
                      ["creatures", mod.creatures],
                      ["items", mod.items],
                    ] as const
                  ).map(([kind, entries]) =>
                    entries.length === 0 ? null : (
                      <Button
                        key={kind}
                        variant="ghost"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            const key = `${mod.shortName}:${kind}`;
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            return next;
                          })
                        }
                      >
                        {expanded.has(`${mod.shortName}:${kind}`) ? "▾" : "▸"}{" "}
                        {entries.length} {kind}
                      </Button>
                    ),
                  )}
                </div>

                {(
                  [
                    ["creatures", mod.creatures],
                    ["items", mod.items],
                  ] as const
                ).map(([kind, entries]) =>
                  expanded.has(`${mod.shortName}:${kind}`) ? (
                    <EntryReviewList
                      key={kind}
                      entries={entries}
                      excluded={excluded}
                      onSetExclusion={setExclusion}
                    />
                  ) : null,
                )}
              </div>
            );
          })}
        </div>

        {plans.some(
          (p) => p.unmatchedCreatures.length > 0 || p.unmatchedItems.length > 0,
        ) && (
          <Toggle
            checked={keepUnmatched}
            onChange={setKeepUnmatched}
            label="Keep entries discovery didn't find"
          />
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-ink-400">
            {(() => {
              const total = plans.reduce(
                (n, p) => n + p.mod.creatures.length + p.mod.items.length,
                0,
              );
              const dropped = excluded.size;
              return dropped > 0
                ? `${total - dropped} of ${total} entries selected`
                : `${total} entries`;
            })()}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={nothingToDo} onClick={apply}>
              {nothingToDo
                ? "Nothing to apply"
                : `Apply to ${plans.length} mod${plans.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // --- pick stage -----------------------------------------------------------
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search installed mods by name or project ID…"
        />
        <Button className="shrink-0" disabled={loading} onClick={() => void load(root)}>
          {loading ? "Reading…" : "Rescan"}
        </Button>
        <Button className="shrink-0" onClick={() => void chooseFolder()}>
          Change folder…
        </Button>
      </div>

      <p className="text-xs text-ink-500 mono truncate" title={root}>
        {root}
      </p>

      {error && (
        <div className="border border-danger/30 bg-danger/5 rounded-lg p-3">
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {hiddenCosmetics > 0 && (
        <Toggle
          checked={showCosmetics}
          onChange={setShowCosmetics}
          label={`Show ${hiddenCosmetics} custom cosmetic mod${hiddenCosmetics === 1 ? "" : "s"}`}
        />
      )}

      {loading && (
        <p className="text-sm text-ink-400 py-8 text-center">
          Reading installed mods…
        </p>
      )}

      {!loading && listing && visible.length === 0 && (
        <p className="text-sm text-ink-400 py-8 text-center">
          {query.trim()
            ? `No installed mod matches "${query.trim()}".`
            : "No installed mods found in that folder."}
        </p>
      )}

      {!loading && visible.length > 0 && (
        <div className="flex flex-col gap-1.5 max-h-80 overflow-y-auto pr-1">
          {visible.map((mod) => {
            const already = existingIds.has(mod.projectId);
            return (
              <label
                key={mod.folderName}
                className={cx(
                  "flex items-center gap-3 border rounded-lg px-3 py-2 min-w-0 cursor-pointer",
                  selected.has(mod.folderName)
                    ? "border-accent-500"
                    : "border-ink-700",
                  !mod.hasManifest && "opacity-50",
                )}
              >
                <input
                  type="checkbox"
                  className="shrink-0"
                  disabled={!mod.hasManifest}
                  checked={selected.has(mod.folderName)}
                  onChange={() => toggle(mod.folderName)}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-ink-100">{mod.name}</span>
                    {already && <Badge tone="ok">Added</Badge>}
                    {mod.cosmetic && <Badge>Cosmetic</Badge>}
                    {!mod.hasManifest && <Badge tone="warn">No manifest</Badge>}
                  </div>
                  <div className="text-xs text-ink-500 truncate">
                    <span className="mono">/{mod.shortName}/</span>
                    {mod.projectId && ` · CF ${mod.projectId}`}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={selected.size === 0 || busy}
          onClick={() => void review()}
        >
          {busy
            ? "Reading…"
            : `Review ${selected.size || ""} mod${selected.size === 1 ? "" : "s"}`.trim()}
        </Button>
      </div>
    </div>
  );
}

/** How many rows render at once before the list asks to be filtered instead. */
const REVIEW_ROW_CAP = 250;

/**
 * The entries one mod contributes, with a tick for each.
 *
 * A big overhaul mod runs to thousands of items, so the list filters rather
 * than paginates — scrolling 2,000 rows to find the three that look wrong is
 * not reviewing, and rendering them all makes the modal crawl.
 */
function EntryReviewList({
  entries,
  excluded,
  onSetExclusion,
}: {
  entries: CatalogEntry[];
  excluded: Set<string>;
  onSetExclusion: (paths: string[], drop: boolean) => void;
}) {
  const [filter, setFilter] = useState("");

  const matching = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) || e.bpPath.toLowerCase().includes(q),
    );
  }, [entries, filter]);

  const shown = matching.slice(0, REVIEW_ROW_CAP);

  return (
    <div className="border border-ink-700 rounded-lg mt-2 p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${entries.length}…`}
        />
        {/* Scoped to what the filter shows, so "None" cannot silently drop
            entries the admin is not currently looking at. */}
        <Button
          variant="ghost"
          className="shrink-0"
          onClick={() => onSetExclusion(matching.map((e) => e.bpPath), false)}
        >
          All
        </Button>
        <Button
          variant="ghost"
          className="shrink-0"
          onClick={() => onSetExclusion(matching.map((e) => e.bpPath), true)}
        >
          None
        </Button>
      </div>

      <div className="flex flex-col max-h-56 overflow-y-auto pr-1">
        {shown.map((entry) => {
          const dropped = excluded.has(normalizeBpPath(entry.bpPath));
          return (
            <label
              key={entry.bpPath}
              className={cx(
                "flex items-start gap-2 py-0.5 cursor-pointer min-w-0",
                dropped && "opacity-40",
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5 shrink-0"
                checked={!dropped}
                onChange={() => onSetExclusion([entry.bpPath], !dropped)}
              />
              <span className="min-w-0">
                <span className="text-xs text-ink-200">{entry.name}</span>
                <span className="text-xs text-ink-500 mono block truncate">
                  {entry.bpPath}
                </span>
              </span>
            </label>
          );
        })}

        {matching.length === 0 && (
          <p className="text-xs text-ink-500 py-2">
            Nothing matches “{filter.trim()}”.
          </p>
        )}
      </div>

      {matching.length > shown.length && (
        <p className="text-xs text-ink-500">
          Showing {shown.length} of {matching.length} — filter to narrow it down.
          “None” still applies to all {matching.length}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/** The original hand-entry form, unchanged in behaviour. */
function ManualTab({
  findIdConflict,
  onAdd,
  onClose,
}: {
  findIdConflict: (curseforgeId: string) => ContentSource | null;
  onAdd: (source: ContentSource) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [cfId, setCfId] = useState("");
  const [url, setUrl] = useState("");
  const idConflict = findIdConflict(cfId);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-400">
        For a mod nobody has published a pack for yet. You catalogue its
        creatures and items here as usual — and can export the result as a
        modpack afterwards.
      </p>
      <Field label="Mod name">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Ports of Atlas"
          autoFocus
        />
      </Field>
      <Field
        label="CurseForge project ID"
        hint="Shown on the mod page under 'Project ID'"
      >
        <Input
          value={cfId}
          onChange={(e) => setCfId(e.target.value)}
          placeholder="e.g. 972253"
        />
      </Field>
      {idConflict && (
        <p className="text-xs rounded-lg border border-danger/30 bg-danger/5 text-red-300 px-3 py-2 -mt-2">
          "{idConflict.name}" already uses project ID{" "}
          {normalizeCurseforgeId(cfId)}. Two sources sharing an ID repeat it in
          the enabled-mod list and give the watcher an ambiguous entry.
        </p>
      )}
      <Field
        label="CurseForge mod page URL"
        hint="Used for the link and the Mod Update Watcher"
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.curseforge.com/ark-survival-ascended/mods/…"
        />
      </Field>
      {/* No watch switch: an enabled mod with a CurseForge id is watched, and
          a newly added mod is enabled. */}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!name.trim() || Boolean(idConflict)}
          onClick={() =>
            onAdd({
              id: newId(),
              name: name.trim(),
              kind: "mod",
              curseforgeId: normalizeCurseforgeId(cfId),
              url: url.trim(),
              docsUrl: "",
              discordUrl: "",
              iconsDir: "",
              iniNotes: "",
              iniSettings: [],
              iniBuild: {},
              variantTag: "",
              enabled: true,
              removed: false,
              notes: "",
              creatures: [],
              items: [],
              modpackId: "",
              modpackVersion: "",
            })
          }
        >
          Add source
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function TemplateTab({ registry }: { registry: ModpackRegistry }) {
  const [saving, setSaving] = useState(false);

  async function saveTemplate() {
    setSaving(true);
    try {
      const dir = await pickSavePath(
        "Save the modpack template",
        "modpack.json",
      );
      if (!dir) return;
      const pack = templateModpack();
      await ipc("save_text_file", {
        path: dir,
        contents: JSON.stringify(pack, null, 2),
      });
      // The README sits beside it, named from the chosen file.
      const readmePath = dir.replace(/[^/\\]+$/, "README.md");
      await ipc("save_text_file", {
        path: readmePath,
        contents: templateReadme(),
      }).catch(() => {
        /* the pack is the deliverable; a missing README is not worth failing */
      });
      toast.success("Template saved — edit modpack.json and open a PR");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-300">
        A modpack is one mod's catalogued content — creatures, items, icons,
        INI settings and the taming write-ups — in a single file. Publishing
        one means the next admin running this mod adds it in a click instead of
        cataloguing it again.
      </p>

      <div className="border border-ink-700 rounded-lg p-3">
        <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
          The quick way
        </h4>
        <p className="text-sm text-ink-300">
          Add the mod under <b>Add manually</b>, catalogue it as you normally
          would, then use <b>Export modpack…</b> on that mod. Everything you
          entered comes out in the right shape, already filled in.
        </p>
      </div>

      <div className="border border-ink-700 rounded-lg p-3">
        <h4 className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
          Or start from a template
        </h4>
        <p className="text-sm text-ink-300 mb-2">
          A worked example with one creature, one item and one INI setting, plus
          a README describing every field.
        </p>
        <div className="flex gap-2">
          <Button
            variant="primary"
            onClick={saveTemplate}
            disabled={!isTauri || saving}
            title={
              isTauri
                ? "Save modpack.json and README.md"
                : "Saving files only works in the desktop app"
            }
          >
            {saving ? "Saving…" : "Download template…"}
          </Button>
          <Button onClick={() => void openExternal(registryBrowseUrl(registry))}>
            Browse published packs ↗
          </Button>
        </div>
        {!isTauri && (
          <p className="text-xs text-amber-400 mt-2">
            Saving files only works in the desktop app.
          </p>
        )}
      </div>

      <p className="text-xs text-ink-400">
        Submit by opening a pull request adding{" "}
        <span className="mono">&lt;id&gt;.json</span> to{" "}
        <span className="mono">{registry.path}</span> on{" "}
        <span className="mono">
          {registry.owner}/{registry.repo}
        </span>
        . A maintainer reviews it before it shows up in search.
      </p>
    </div>
  );
}
