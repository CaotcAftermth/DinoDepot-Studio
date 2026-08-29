import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { newId } from "../../model/ids";
import {
  curseforgeProjectUrl,
  normalizeBpPath,
  type CatalogEntry,
  type ContentSource,
} from "../../model/catalog";
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
import {
  curseforgeProjectId,
  normalizeCurseforgeId,
} from "../../model/catalogDuplicates";
import { includedActiveModIds } from "../../model/cosmetics";
import {
  applyModpack,
  compareVersions,
  matchModpackSource,
  packIconFiles,
  registryVersion,
  searchRegistry,
  templateModpack,
  templateReadme,
  type Modpack,
  type ModpackRegistry,
  type RegistryEntry,
} from "../../model/modpack";
import {
  fetchPack,
  fetchRegistry,
  registryBrowseUrl,
  registryPackUrl,
  type PackIconFetchResult,
  type RegistryListing,
} from "../../services/modpackRegistry";
import {
  linkedPackageFromUrl,
  linkedPackageFromFile,
  linkedPackageFromDownloaded,
  packFromFile,
  packFromUrl,
  type LinkedPackageSource,
} from "../../services/modpackSource";
import { commitPackageActivation } from "../../services/projectActivation";
import {
  downloadRegistryPackage,
  downloadedAsLegacyInstall,
  installDownloadedPackage,
  listInstalledPackages,
  normalizeLegacyModpackPackage,
  type InstalledPackageInfo,
} from "../../services/packageManager";
import {
  dependencyForRegistryPackage,
  packPresence,
  PackageDependencySchema,
  upsertDependency,
} from "../../model/dependency";
import { useProjectStore } from "../../stores/projectStore";
import { useDraftsStore } from "../../stores/draftsStore";
import { openExternal } from "../../services/openExternal";
import { shortClassName } from "../../services/spawnCommands";
import { lookupModByProjectId, type ModLookup } from "../../services/scraper";
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
 * Discovery comes first because it is the one that works with nothing
 * published: the installed files already list every blueprint path, and
 * reading them beats typing them. The library is next - when somebody has
 * catalogued this mod, repeating that work is exactly what the registry
 * exists to prevent - with a link or a file accepted from any tab, since
 * being sent a pack is not something that happens in one place. Manual entry
 * covers everything else, and the template turns that work into a pack the
 * next admin gets for free.
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
  // Discovery first: it is the route that works without anybody having
  // published anything, and the registry index is small enough that opening on
  // a search box over it says less than a list of the mods already installed.
  const [tab, setTab] = useState<Tab>("discover");
  const install = usePackageInstall({ registry, onInstalled, onClose });

  return (
    <Modal title="Add mod content source" onClose={onClose} wide>
      <div className="flex items-center gap-4 border-b border-ink-700 mb-4">
        {(
          [
            ["discover", "Discover installed"],
            ["registry", "Modpack library"],
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

      {/* Being sent a pack is not something that happens on one tab. */}
      {tab !== "template" && (
        <div className="mb-4">
          <PackLinkInstall registry={registry} install={install} />
        </div>
      )}

      {tab === "registry" && (
        <RegistryTab
          registry={registry}
          install={install}
          onManual={() => setTab("manual")}
          onTemplate={() => setTab("template")}
        />
      )}
      {tab === "discover" && (
        <DiscoverTab
          registry={registry}
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

/**
 * The one install path, shared by every route that leads to a pack.
 *
 * The search list, a pasted link and a file on disk all land the same way,
 * including icons and the "keep what you wrote" rule, so a pack picked up from
 * a pull request is not a second-class install. Held above the tabs because
 * the link and file routes are useful wherever you happen to be.
 */
function usePackageInstall({
  registry,
  onInstalled,
  onClose,
}: {
  registry: ModpackRegistry;
  onInstalled: (sourceId: string, name: string) => void;
  onClose: () => void;
}) {
  const { catalog, setCatalog, refreshDependencies } = useDraftsStore();
  const settings = useProjectStore((s) => s.settings);
  // No `saveSettings` here on purpose: an install's settings write happens
  // inside `commitPackageActivation`, which re-reads them at commit time.
  const [installing, setInstalling] = useState("");

  /**
   * Installs a pack, however it was found.
   *
   * One path for all three routes - the search list, a pasted link, a file on
   * disk - so a pack picked up from a pull request lands exactly as one from
   * the index does, including artwork quarantine and the "keep what you wrote" rule.
   */
  async function installFrom(
    key: string,
    load: () => Promise<{
      pack: Modpack;
      icons: () => Promise<PackIconFetchResult>;
      /** Commits an already verified package download to the shared library. */
      commitPackage?: () => Promise<unknown>;
      linkedPackage?: LinkedPackageSource;
      /** Reconstruction source for compatibility JSON without a manifest. */
      legacySource?: { url?: string; localPath?: string };
    }>,
  ) {
    setInstalling(key);
    try {
      const loaded = await load();
      const { icons, commitPackage } = loaded;
      let linkedPackage = loaded.linkedPackage;
      let pack = loaded.pack;
      const match = matchModpackSource(catalog, pack);
      if (match.ambiguous.length > 0) {
        throw new Error(
          `${match.ambiguous.length} content sources claim this package identity. Resolve those duplicate sources before installing.`,
        );
      }
      const already = match.source;
      if (already) {
        const adopting = match.matchedBy === "curseforgeId";
        const ok = await confirmDialog({
          title: adopting
            ? `Connect "${already.name}" to this package?`
            : `Update "${already.name}" to ${pack.meta.version}?`,
          message: adopting
            ? `Discovery and this package share CurseForge ID ${pack.meta.curseforgeId}. ` +
              "The existing source will be preserved and connected to the exact package version; your per-entry edits are kept."
            : `Installed: ${already.modpackVersion || "unknown"}. ` +
              "The mod's creatures, items and INI settings are replaced with the new version. " +
              "Anything you wrote yourself on its entries is kept.",
          confirmLabel: adopting
            ? `Connect version ${pack.meta.version}`
            : `Update to ${pack.meta.version}`,
        });
        if (!ok) return;
      }

      let fallbackIcons = 0;
      if (!linkedPackage) {
        const normalized = await normalizeLegacyModpackPackage(
          pack,
          await icons(),
        );
        pack = normalized.pack;
        fallbackIcons = normalized.skipped.length;
        if (normalized.downloaded) {
          await installDownloadedPackage(normalized.downloaded);
          linkedPackage = linkedPackageFromDownloaded(normalized.downloaded, {
            legacyUrl: loaded.legacySource?.url,
            localOnly: Boolean(loaded.legacySource?.localPath),
            localSourcePath: loaded.legacySource?.localPath,
            legacyLocal: Boolean(loaded.legacySource?.localPath),
          });
        }
      } else if (commitPackage) {
        await commitPackage();
      }
      // Pack-owned icons stay in the shared managed library either way: a
      // compatibility pack that cannot become a safe package keeps its content
      // but drops its file assignments, so the UI falls back to default icons
      // rather than pointing at bytes this project does not hold.
      const result = applyModpack(catalog, pack, newId);
      const nextCatalog = result.catalog;
      if (linkedPackage) {
        if (!settings) throw new Error("No project is open");
        let dependency = dependencyForRegistryPackage(
          registry,
          linkedPackage.entry,
          linkedPackage.exact,
          linkedPackage.downloaded.manifest,
          linkedPackage.downloaded.manifestIntegrity,
          result.sourceId,
        );
        if (linkedPackage.legacyUrl || linkedPackage.legacyLocal) {
          dependency = {
            ...dependency,
            locator: {
              owner: registry.owner,
              repo: registry.repo,
              branch: registry.branch,
              path: registry.path,
              manifest: "",
              manifestUrl: "",
              sourceFormat: "legacy",
              legacyUrl: linkedPackage.legacyUrl ?? "",
            },
          };
        } else if (linkedPackage.manifestUrl || linkedPackage.localOnly) {
          dependency = {
            ...dependency,
            locator: {
              owner: "",
              repo: "",
              branch: "",
              path: "",
              manifest: "",
              manifestUrl: linkedPackage.manifestUrl ?? "",
              sourceFormat: "package",
              legacyUrl: "",
            },
          };
        }
        // One unit: the catalog and the pin either both land or neither does,
        // and the settings are re-read at commit time rather than taken from
        // the closure this handler started with.
        await commitPackageActivation({
          dependency,
          catalog: nextCatalog,
          localPackageSourcePath: linkedPackage.localSourcePath,
        });
      } else if (settings) {
        const dependency = PackageDependencySchema.parse({
          kind: "modpack",
          packageId: pack.meta.id,
          version: pack.meta.version,
          curseforgeId: pack.meta.curseforgeId,
          sourceId: result.sourceId,
          mode: "materialized",
          addedAt: new Date().toISOString(),
        });
        await commitPackageActivation({ dependency, catalog: nextCatalog });
      } else {
        setCatalog(nextCatalog);
      }
      if (linkedPackage) await refreshDependencies();

      onInstalled(result.sourceId, pack.meta.name);
      toast.success(
        (result.updated
          ? `${pack.meta.name} updated to ${pack.meta.version}` +
            (result.keptLocal > 0
              ? ` · ${result.keptLocal} of your own entries kept`
              : "")
          : `${pack.meta.name} added - ${pack.creatures.length} creatures, ${pack.items.length} items`) +
          (fallbackIcons > 0
            ? ` · ${fallbackIcons} default fallback${fallbackIcons === 1 ? "" : "s"}`
            : ""),
      );
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInstalling("");
    }
  }

  return { installing, installFrom };
}

type PackageInstall = ReturnType<typeof usePackageInstall>;

/**
 * Installing a pack somebody linked or sent, rather than one the index lists.
 *
 * Browsing the registry opens GitHub, and that used to be a dead end: whatever
 * you found there could not be installed unless the index happened to list it.
 * A link or a file is what you come back with, so both install.
 */
function PackLinkInstall({
  registry,
  install,
}: {
  registry: ModpackRegistry;
  install: PackageInstall;
}) {
  /** A pasted link to a pack that the index does not list. */
  const [link, setLink] = useState("");
  const { installing, installFrom } = install;

  /** A pack someone linked - a registry folder, a fork, a pull request. */
  function installLink() {
    return installFrom("link", async () => {
      const linked = await linkedPackageFromUrl(link, registry);
      if (!linked) {
        const legacy = await packFromUrl(link, registry);
        return { ...legacy, legacySource: { url: legacy.from } };
      }
      const legacy = downloadedAsLegacyInstall(linked.downloaded);
      return {
        pack: legacy.pack,
        icons: async () => legacy.icons,
        commitPackage: () => installDownloadedPackage(linked.downloaded),
        linkedPackage: linked,
      };
    });
  }

  /** A pack sitting on this machine, sent over or built by hand. */
  async function installFile() {
    const path = await pickFile("Open a modpack", [
      { name: "Modpack", extensions: ["json"] },
    ]);
    if (!path) return;
    await installFrom("file", async () => {
      const linked = await linkedPackageFromFile(path);
      if (!linked) {
        const legacy = await packFromFile(path);
        return { ...legacy, legacySource: { localPath: path } };
      }
      const legacy = downloadedAsLegacyInstall(linked.downloaded);
      return {
        pack: legacy.pack,
        icons: async () => legacy.icons,
        commitPackage: () => installDownloadedPackage(linked.downloaded),
        linkedPackage: linked,
      };
    });
  }

  return (
    <div className="border border-ink-700 rounded-lg p-3 flex flex-col gap-2">
      <p className="text-xs text-ink-400">
        Found one while browsing, or been sent a pack? Paste the link to its
        folder, <span className="mono">modpack.json</span>, or an immutable
        <span className="mono"> manifest.json</span> - a pull request or fork
        works too - or open one saved on this machine.
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
  );
}

function RegistryTab({
  registry,
  install,
  onManual,
  onTemplate,
}: {
  registry: ModpackRegistry;
  install: PackageInstall;
  onManual: () => void;
  onTemplate: () => void;
}) {
  const { installing, installFrom } = install;
  const { catalog } = useDraftsStore();
  const [listing, setListing] = useState<RegistryListing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");

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

  function installEntry(entry: RegistryEntry) {
    return installFrom(entry.id, async () => {
      const exact = registryVersion(entry, entry.version);
      if (exact) {
        const downloaded = await downloadRegistryPackage(
          registry,
          entry,
          entry.version,
        );
        const legacy = downloadedAsLegacyInstall(downloaded);
        return {
          pack: legacy.pack,
          icons: async () => legacy.icons,
          commitPackage: () => installDownloadedPackage(downloaded),
          linkedPackage: { entry, exact, downloaded },
        };
      }
      const pack = await fetchPack(registry, entry);
      return {
        pack,
        icons: async () => ({ icons: [], missing: packIconFiles(pack) }),
        legacySource: { url: registryPackUrl(registry, entry) },
      };
    });
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
              {listing.truncated && " - only the first 40 are listed"}.
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
                      onClick={() => void installEntry(entry)}
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
 * fact - the listing gives paths, not types, so classification is a naming
 * convention - which is why nothing is written until it has been reviewed.
 */
function DiscoverTab({
  registry,
  onInstalled,
  onClose,
  onManual,
}: {
  registry: ModpackRegistry;
  onInstalled: (sourceId: string, name: string) => void;
  onClose: () => void;
  onManual: () => void;
}) {
  const {
    catalog,
    setCatalog,
    cosmetics,
    production,
    remaps,
    refreshDependencies,
  } = useDraftsStore();
  const updateLocal = useProjectStore((s) => s.updateLocal);
  const settings = useProjectStore((s) => s.settings);
  const saveSettings = useProjectStore((s) => s.saveSettings);
  const root = useProjectStore((s) => s.local?.modsDir)?.trim() ?? "";
  const navigate = useNavigate();

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
  const [packageListing, setPackageListing] =
    useState<RegistryListing | null>(null);
  const [installedPackages, setInstalledPackages] = useState<
    InstalledPackageInfo[]
  >([]);
  const [packageNotice, setPackageNotice] = useState("");

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
    () => includedActiveModIds(cosmetics),
    [cosmetics],
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

  // Package enrichment is deliberately independent from the local scan. A
  // registry outage changes badges and optional actions, never the listing or
  // the ability to apply Discovery by itself.
  useEffect(() => {
    let cancelled = false;
    setPackageNotice("");
    void fetchRegistry(registry)
      .then((result) => {
        if (!cancelled) setPackageListing(result);
      })
      .catch(() => {
        if (!cancelled) {
          setPackageListing(null);
          setPackageNotice("Package availability could not be checked. Local Discovery still works.");
        }
      });
    void listInstalledPackages()
      .then((packages) => {
        if (!cancelled) setInstalledPackages(packages);
      })
      .catch(() => {
        if (!cancelled) setInstalledPackages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [registry.owner, registry.repo, registry.branch, registry.path]);

  const packagesByModId = useMemo(() => {
    const grouped = new Map<string, RegistryEntry[]>();
    for (const entry of packageListing?.packs ?? []) {
      const id = normalizeCurseforgeId(entry.curseforgeId);
      if (!id) continue;
      grouped.set(id, [...(grouped.get(id) ?? []), entry]);
    }
    return grouped;
  }, [packageListing]);
  const installedPackageKeys = useMemo(
    () =>
      new Set(
        installedPackages.map(
          (item) => `${item.kind}:${item.packageId}:${item.version}`,
        ),
      ),
    [installedPackages],
  );
  const projectDependencyByModId = useMemo(
    () =>
      new Map(
        (settings?.packageDependencies ?? [])
          .filter((dependency) => dependency.curseforgeId.trim())
          .map((dependency) => [
            normalizeCurseforgeId(dependency.curseforgeId),
            dependency,
          ]),
      ),
    [settings?.packageDependencies],
  );

  const exactPackageFor = useCallback(
    (projectId: string) => {
      const matches = packagesByModId.get(normalizeCurseforgeId(projectId)) ?? [];
      if (matches.length !== 1) return null;
      const entry = matches[0];
      const exact = registryVersion(entry, entry.version);
      return exact ? { entry, exact } : null;
    },
    [packagesByModId],
  );

  /** Points the project at an install, accepting the game folder or the mods folder. */
  async function chooseFolder() {
    const picked = await pickFolder(
      "Select the Ark: Survival Ascended install folder",
    );
    if (!picked) return;
    setBusy(true);
    setError("");
    try {
      const resolved = await resolveModsRoot(picked);
      // Machine-local: where the game is installed is true of this computer.
      await updateLocal({ modsDir: resolved });
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
  /**
   * Whether this project has ever collected the cosmetics list.
   *
   * Discovery marks a mod as cosmetic by checking it against that list, so
   * until the collector has run every cosmetic mod on the machine sits in this
   * list looking like content worth cataloguing. On a big install that is most
   * of what you scroll past.
   */
  const cosmeticsUncollected = cosmetics.entries.length === 0;

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
      const next = discovered.map((mod) => planDiscovery(catalog, mod));
      setPlans(next);
      // Seed from what this project already decided, so an entry dropped on a
      // previous scan comes back unticked instead of having to be found and
      // dropped again on every rescan.
      const seeded = new Set<string>();
      for (const plan of next) {
        const source = catalog.sources.find(
          (candidate) => candidate.id === plan.existingSourceId,
        );
        if (!source) continue;
        const present = new Set(
          [...plan.mod.creatures, ...plan.mod.items].map((entry) =>
            normalizeBpPath(entry.bpPath),
          ),
        );
        for (const path of source.excludedPaths ?? []) {
          const key = normalizeBpPath(path);
          if (present.has(key)) seeded.add(key);
        }
      }
      setExcluded(seeded);
      setExpanded(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Commits local Discovery first, then optionally enriches matching mods.
   * A failed package request can therefore never undo or prevent the local
   * ShooterGame result the administrator already reviewed.
   */
  async function apply(installMatching: boolean) {
    if (!plans) return;
    setBusy(true);
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

    const discoveredCatalog = next;
    setCatalog(next);
    const failures: string[] = [];
    let packagesAdded = 0;
    let dependencies = [...(settings?.packageDependencies ?? [])];

    if (installMatching) {
      for (const plan of plans) {
        const available = exactPackageFor(plan.mod.projectId);
        if (!available) continue;
        try {
          const downloaded = await downloadRegistryPackage(
            registry,
            available.entry,
            available.entry.version,
          );
          await installDownloadedPackage(downloaded);
          const { pack } = downloadedAsLegacyInstall(downloaded);
          const enriched = applyModpack(next, pack, newId);
          next = enriched.catalog;
          dependencies = upsertDependency(
            dependencies,
            dependencyForRegistryPackage(
              registry,
              available.entry,
              available.exact,
              downloaded.manifest,
              downloaded.manifestIntegrity,
              enriched.sourceId,
            ),
          );
          packagesAdded++;
        } catch (error) {
          failures.push(
            `${plan.mod.name}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      if (packagesAdded > 0) {
        if (!settings) {
          failures.push("The exact package dependencies could not be saved.");
          packagesAdded = 0;
          next = discoveredCatalog;
        } else {
          try {
            await saveSettings({ ...settings, packageDependencies: dependencies });
            setCatalog(next);
            await refreshDependencies();
          } catch (error) {
            failures.push(
              `Exact dependencies: ${error instanceof Error ? error.message : String(error)}`,
            );
            packagesAdded = 0;
            next = discoveredCatalog;
            setCatalog(discoveredCatalog);
          }
        }
      }
    }

    if (firstSource) onInstalled(firstSource.id, firstSource.name);
    toast.success(
      `${plans.length} mod${plans.length === 1 ? "" : "s"} catalogued - ` +
        `${creatures} creatures, ${items} items` +
        (packagesAdded > 0
          ? ` · ${packagesAdded} exact package${packagesAdded === 1 ? "" : "s"} installed`
          : ""),
    );
    if (failures.length > 0) {
      toast.error(
        `Discovery was applied, but package enrichment was unavailable: ${failures.join(" · ")}`,
      );
    }
    if (packagesAdded === 0 && settings?.packageDependencies.length) {
      void refreshDependencies();
    }
    setBusy(false);
    onClose();
  }

  /**
   * Takes one mod straight to the published package version.
   *
   * Reviewing exists for what Discovery *guessed* off disk. A newer published
   * package is not a guess - it is curated content pinned by hash - so an
   * update is a decision about one mod, not a pass over every entry in it. The
   * review route still works for anyone who wants to look first.
   */
  async function updatePack(mod: InstalledModSummary) {
    const available = exactPackageFor(mod.projectId);
    if (!available) return;
    if (!settings) {
      setError("No project is open");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const downloaded = await downloadRegistryPackage(
        registry,
        available.entry,
        available.entry.version,
      );
      await installDownloadedPackage(downloaded);
      const { pack } = downloadedAsLegacyInstall(downloaded);
      const applied = applyModpack(catalog, pack, newId);
      // One unit: the catalog and the pin either both land or neither does.
      await commitPackageActivation({
        dependency: dependencyForRegistryPackage(
          registry,
          available.entry,
          available.exact,
          downloaded.manifest,
          downloaded.manifestIntegrity,
          applied.sourceId,
        ),
        catalog: applied.catalog,
      });
      await refreshDependencies();
      setInstalledPackages(await listInstalledPackages());
      toast.success(`${pack.meta.name} updated to ${pack.meta.version}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  // --- no install configured yet -------------------------------------------
  if (!root) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink-300">
          Reads mods already installed on this machine and catalogues their
          creatures and items automatically - no blueprint paths typed by hand.
        </p>
        <div className="border border-ink-700 rounded-lg p-3">
          <p className="text-sm text-ink-300 mb-2">
            Point this at your Ark: Survival Ascended install - the folder
            containing <span className="mono">ShooterGame</span>. A dedicated
            server install works just as well as the game.
          </p>
          <Button
            variant="primary"
            disabled={!isTauri || busy}
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
    const matchingPackageCount = plans.filter((plan) =>
      exactPackageFor(plan.mod.projectId),
    ).length;
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
            Nothing has been saved yet - this is what applying would do.
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
                  {impact.reference.where} - {" "}
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
              Applying does not rewrite your rules - update these yourself
              afterwards, or go back and leave this mod out for now.
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1.5 max-h-96 overflow-y-auto pr-1">
          {plans.map((plan) => {
            const { mod } = plan;
            const isNew = !plan.existingSourceId;
            const packageOption = exactPackageFor(mod.projectId);
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
                  {packageOption && (
                    <Badge tone="ok">
                      Exact pack {packageOption.entry.version} available
                    </Badge>
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
                  conventions, so being able to read the list - and drop what
                  should not be in a picker - is the point of reviewing at all.
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

        <div className="border border-ink-700 rounded-lg p-3 text-xs text-ink-400">
          <span className="font-medium text-ink-200">Artwork:</span>{" "}
          Permission not established. DDS placeholders will be used; this does not block content creation.
        </div>

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
            {matchingPackageCount > 0 && (
              <Button
                variant="ghost"
                disabled={busy || nothingToDo}
                onClick={() => void apply(false)}
              >
                Add without pack
              </Button>
            )}
            <Button
              variant="primary"
              disabled={busy || (nothingToDo && matchingPackageCount === 0)}
              onClick={() => void apply(matchingPackageCount > 0)}
            >
              {busy
                ? "Applying…"
                : matchingPackageCount > 0
                  ? `Apply + install ${matchingPackageCount} pack${matchingPackageCount === 1 ? "" : "s"}`
                  : nothingToDo
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

      {packageNotice && (
        <p className="text-xs text-ink-400">{packageNotice}</p>
      )}

      {cosmeticsUncollected && (listing?.length ?? 0) > 0 && (
        <div className="border border-ink-700 rounded-lg p-3 flex items-start justify-between gap-3">
          <p className="text-xs text-ink-400 min-w-0">
            Custom cosmetic mods are not being filtered out of this list -
            nothing has collected them yet. The CurseForge collector sweeps the
            cosmetics category once, after which Discovery can tell them apart
            from content mods.
          </p>
          <Button
            className="shrink-0"
            onClick={() => {
              onClose();
              navigate("/curseforge");
            }}
          >
            Open the collector
          </Button>
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
            const packageMatches =
              packagesByModId.get(normalizeCurseforgeId(mod.projectId)) ?? [];
            const packageOption = exactPackageFor(mod.projectId);
            const dependency = projectDependencyByModId.get(
              normalizeCurseforgeId(mod.projectId),
            );
            const dependencyInstalled = dependency
              ? installedPackageKeys.has(
                  `${dependency.kind}:${dependency.packageId}:${dependency.version}`,
                )
              : false;
            const latestInstalled = packageOption
              ? installedPackageKeys.has(
                  `modpack:${packageOption.entry.id}:${packageOption.entry.version}`,
                )
              : false;
            const presence = packPresence({
              pinnedVersion: dependency?.version ?? "",
              pinnedInstalled: dependencyInstalled,
              publishedVersion: packageOption?.entry.version ?? "",
              publishedInstalled: latestInstalled,
            });
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
                {/* Name and folder on the left, status on the right: the
                    badges used to sit between the two and pushed the folder
                    line away from the name it belongs to. */}
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink-100 truncate">
                    {mod.name}
                  </div>
                  <div className="text-xs text-ink-500 truncate">
                    <span className="mono">/{mod.shortName}/</span>
                    {mod.projectId && ` · CF ${mod.projectId}`}
                  </div>
                </div>

                <div className="flex items-center gap-2 justify-end flex-wrap shrink-0 max-w-[55%]">
                  {already && <Badge tone="ok">Added</Badge>}
                  {presence && (
                    <Badge tone={presence.tone}>{presence.label}</Badge>
                  )}
                  {packageMatches.length > 1 && (
                    <Badge tone="warn">Package identity conflict</Badge>
                  )}
                  {!packageOption &&
                    packageMatches.length === 1 &&
                    !dependency && <Badge>Legacy pack available</Badge>}
                  {packageListing &&
                    mod.projectId &&
                    packageMatches.length === 0 &&
                    !dependency && <Badge>No DD-S pack</Badge>}
                  {mod.cosmetic && <Badge>Cosmetic</Badge>}
                  {!mod.hasManifest && <Badge tone="warn">No manifest</Badge>}
                  {dependency &&
                    packageOption &&
                    compareVersions(
                      packageOption.entry.version,
                      dependency.version,
                    ) > 0 && (
                      <Button
                        variant="primary"
                        className="shrink-0 py-0.5"
                        disabled={busy}
                        // Inside the row's label, so a click would otherwise
                        // tick the checkbox on its way through.
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          void updatePack(mod);
                        }}
                      >
                        {busy
                          ? "Updating…"
                          : `Update pack to ${packageOption.entry.version}`}
                      </Button>
                    )}
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
 * than paginates - scrolling 2,000 rows to find the three that look wrong is
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
              {/* Same shape as the Content Sources entry list: the name is
                  what is being decided about, the class is context, and the
                  full blueprint path is a hover away rather than in the way. */}
              <span className="min-w-0">
                <span className="text-sm text-ink-100 block truncate">
                  {entry.name}
                </span>
                <span
                  className="text-xs text-ink-500 mono block truncate"
                  title={entry.bpPath}
                >
                  {shortClassName(entry.bpPath)}
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
          Showing {shown.length} of {matching.length} - filter to narrow it down.
          “None” still applies to all {matching.length}.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/**
 * Hand entry, starting from the one thing that identifies the mod.
 *
 * The project ID comes first because everything else follows from it:
 * CurseForge redirects `/projects/<id>` to the mod's real page, so the URL is
 * derived rather than asked for, and the name is a label this cluster owns and
 * can change at any time. Asking for all three up front made the two fields
 * that can be wrong mandatory and the one that cannot optional.
 */
function ManualTab({
  findIdConflict,
  onAdd,
  onClose,
}: {
  findIdConflict: (curseforgeId: string) => ContentSource | null;
  onAdd: (source: ContentSource) => void;
  onClose: () => void;
}) {
  const [cfId, setCfId] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [looking, setLooking] = useState(false);
  const [progress, setProgress] = useState("");
  /** What the lookup matched, so the ID can be checked without leaving here. */
  const [found, setFound] = useState<ModLookup | null>(null);
  const [lookupError, setLookupError] = useState("");

  const typed = normalizeCurseforgeId(cfId);
  const projectId = curseforgeProjectId(typed);
  const malformed = Boolean(typed) && !projectId;
  const pastedPage = malformed && /^https?:\/\//i.test(typed);
  const idConflict = findIdConflict(projectId);
  const derivedUrl = projectId ? curseforgeProjectUrl(projectId) : "";
  const finalName = name.trim() || (projectId ? `Mod ${projectId}` : "");

  /**
   * Asks CurseForge what this project is called.
   *
   * Behind a button rather than behind typing: it launches Chrome and loads a
   * page, which is far too much to do on every keystroke. The name it returns
   * is a starting point, not a decision - this cluster's label stays editable
   * here and on the source afterwards.
   */
  async function lookUp() {
    if (!projectId) return;
    setLooking(true);
    setLookupError("");
    setFound(null);
    setProgress("Starting…");
    try {
      const result = await lookupModByProjectId(projectId, {
        onStatus: setProgress,
      });
      setFound(result);
      setName(result.name);
    } catch (error) {
      setLookupError(error instanceof Error ? error.message : String(error));
    } finally {
      setLooking(false);
      setProgress("");
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-ink-400">
        For a mod nobody has published a pack for yet. You catalogue its
        creatures and items here as usual - and can export the result as a
        modpack afterwards.
      </p>

      <Field
        label="CurseForge project ID"
        hint="Shown on the mod page under 'Project ID'. The page link follows from it."
      >
        <Input
          value={cfId}
          onChange={(e) => {
            setCfId(e.target.value);
            setFound(null);
            setLookupError("");
          }}
          placeholder="e.g. 972253 - or paste the mod page link"
          autoFocus
          onKeyDown={(event) => {
            // Type an ID, press Enter, get the name - the whole point of
            // asking for the ID first.
            if (event.key !== "Enter" || !projectId || looking) return;
            event.preventDefault();
            void lookUp();
          }}
        />
      </Field>

      {malformed && (
        <p className="text-xs text-amber-400 -mt-2">
          {pastedPage
            ? "That is the mod page, not its project ID. Put it in Mod page URL below, or copy the number shown under “Project ID” on that page."
            : "No project ID in that. Paste the number shown under “Project ID” on the mod page."}
        </p>
      )}

      {derivedUrl && !idConflict && (
        <div className="flex items-center gap-2 -mt-2">
          <p className="text-xs text-ink-400 min-w-0 truncate">
            Links to <span className="mono">{derivedUrl}</span>
          </p>
          <Button
            variant="ghost"
            className="shrink-0"
            disabled={!isTauri || looking}
            title={
              isTauri
                ? "Read this mod's name off its CurseForge page"
                : "Reading the mod page only works in the desktop app"
            }
            onClick={() => void lookUp()}
          >
            {looking ? progress || "Looking up…" : "Look up name"}
          </Button>
          <Button
            variant="ghost"
            className="shrink-0"
            onClick={() => void openExternal(derivedUrl)}
            title="Check this is the right mod before adding it"
          >
            Open ↗
          </Button>
        </div>
      )}

      {found && (
        <p className="text-xs text-ink-400 -mt-2 min-w-0 truncate">
          CurseForge calls this <span className="text-ink-200">{found.name}</span>
          {found.updated && ` · updated ${found.updated}`} - {" "}
          <span className="mono">{found.url}</span>
        </p>
      )}

      {lookupError && (
        <p className="text-xs text-amber-400 -mt-2">
          {lookupError}. You can still name it yourself.
        </p>
      )}

      {idConflict && (
        <p className="text-xs rounded-lg border border-danger/30 bg-danger/5 text-red-300 px-3 py-2 -mt-2">
          "{idConflict.name}" already uses project ID {projectId}. Two sources
          sharing an ID repeat it in the enabled-mod list and give the watcher
          an ambiguous entry.
        </p>
      )}

      <Field
        label="Mod name"
        hint="Optional - this cluster's own label, changeable here or on the source afterwards"
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={projectId ? `Mod ${projectId}` : "e.g. Ports of Atlas"}
        />
      </Field>

      <Field
        label="Mod page URL"
        hint={
          derivedUrl
            ? "Only needed to point somewhere other than the project link above"
            : "Used for the link and the Mod Update Watcher"
        }
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={
            derivedUrl || "https://www.curseforge.com/ark-survival-ascended/mods/…"
          }
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
          disabled={!finalName || Boolean(idConflict)}
          onClick={() =>
            onAdd({
              id: newId(),
              name: finalName,
              kind: "mod",
              curseforgeId: projectId,
              // Left empty on purpose when it would only repeat the project
              // link: `sourceCurseforgeUrl` derives that, and a stored copy is
              // one more thing to be wrong later.
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
      toast.success("Template saved - edit modpack.json and open a PR");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-300">
        A modpack is one mod's catalogued data - creatures, items,
        INI settings and the taming write-ups - in a single file. Publishing
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
