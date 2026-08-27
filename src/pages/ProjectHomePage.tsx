import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectStore, type RecentProject } from "../stores/projectStore";
import { pickFolder } from "../services/dialogs";
import { Badge, Button, Card, Field, HelpDot, Input } from "../components/ui";
import { toast, ToastContainer } from "../components/toast";
import { chooseDialog, confirmDialog, ConfirmHost } from "../components/confirm";
import { ipc, isTauri } from "../services/ipc";
import { FeedbackHost } from "../components/feedback/FeedbackHost";
import { useFeedback } from "../components/feedback/useFeedback";
import { feedbackTarget } from "../model/feedback/targets";
import { isStudioError } from "../model/errors";
import { suggestNames, type NameSuggestion } from "../model/nameSuggestions";
import {
  folderNameFor,
  joinPath,
  loadProjectsRoot,
  PROJECTS_FOLDER_NAME,
  projectDirFor,
  projectsRootIn,
  saveProjectsRoot,
} from "../services/projectsRoot";
import {
  EXAMPLE_PROJECT_CLUSTER,
  EXAMPLE_PROJECT_NAME,
  isExampleProjectName,
  markExampleOfficialCatalog,
  needsExampleOfficialCatalogUpgrade,
  upgradeExampleProjectFiles,
} from "../model/exampleProject";

const RECENT_PROJECT_LIMIT = 5;

export function ProjectHomePage() {
  const navigate = useNavigate();
  const {
    recents,
    openProject,
    createProject,
    loadRecentProjects,
    forgetProject,
    dropRecentEntry,
  } = useProjectStore();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCluster, setNewCluster] = useState("");
  /**
   * The folder every project is made inside. Empty until first asked for, and
   * empty for the moment it takes to read it back off disk — the New project
   * card is not on screen yet when that read starts.
   */
  const [root, setRoot] = useState("");
  const [suggestion, setSuggestion] = useState<NameSuggestion>(suggestNames);
  const [busy, setBusy] = useState(false);
  /** Folders in the list that no longer hold a project. */
  const [missing, setMissing] = useState<Record<string, boolean>>({});
  const { enabled: feedbackEnabled, openFeedback } = useFeedback();
  const shownRecents = recents
    .filter((recent) => !isExampleProjectName(recent.name))
    .slice(0, RECENT_PROJECT_LIMIT);

  const targetDir = projectDirFor(root, newName.trim());
  /**
   * What the card shows for the destination. An unnamed project still has a
   * folder to show — its parent — so the naming is visibly what decides it.
   */
  const shownDir =
    targetDir || (root ? joinPath(root, folderNameFor(newName.trim()) || "…") : "");

  // Machine-local, and read from disk rather than the webview's storage, which
  // is why it is asked for asynchronously instead of straight out of `useState`.
  useEffect(() => {
    let cancelled = false;
    void loadProjectsRoot().then((stored) => {
      if (cancelled || !stored) return;
      // `current ||` so a folder chosen while the read was in flight wins.
      setRoot((current) => current || stored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The stored list is only ever a list of *paths*, so a folder that has been
  // moved, renamed or deleted still looks like a project until it is checked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadRecentProjects().catch(() => {});
      const rows = useProjectStore
        .getState()
        .recents.slice(0, RECENT_PROJECT_LIMIT);
      const found = await Promise.all(
        rows.map((r) =>
          ipc<boolean>("project_exists", { dir: r.dir }).catch(() => true),
        ),
      );
      if (cancelled) return;
      setMissing(
        Object.fromEntries(rows.map((r, i) => [r.dir, !found[i]])),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [loadRecentProjects]);

  async function handleOpen(dir?: string) {
    // Started at the projects folder, because that is where every project this
    // machine made already is. The dialog otherwise reopens whereever it was
    // last used, which after importing a live file is the game's config folder.
    const target =
      dir ??
      (await pickFolder(
        "Select an existing project folder",
        root || (await loadProjectsRoot()),
      ));
    if (!target) return;
    try {
      await openProject(target);
      navigate("/overview");
    } catch (e) {
      // A lock another instance holds is the one failure with a way out: the
      // backend refuses to take it, and only the administrator can say whether
      // the other instance is really still there.
      if (isStudioError(e) && e.code === "project.locked") {
        await offerTakeover(target, e.message);
        return;
      }
      toast.error(`Could not open project: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function offerTakeover(dir: string, message: string) {
    const answer = await chooseDialog({
      title: "This project is open elsewhere",
      message,
      options: [
        {
          key: "force",
          label: "Open anyway and take over",
          variant: "danger",
          hint: "The other instance stops saving. Use this when it is not really running any more.",
        },
      ],
      cancelLabel: "Cancel",
    });
    if (answer !== "force") return;
    try {
      await openProject(dir, { force: true });
      navigate("/overview");
    } catch (e) {
      toast.error(`Could not open project: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** A recent whose folder has gone: re-link it, or drop it from the list. */
  async function handleMissing(recent: RecentProject) {
    const answer = await chooseDialog({
      title: "That project folder is not there any more",
      message: `${recent.name} was last seen at:\n${recent.dir}\n\nIt may have been moved, renamed, or deleted.`,
      options: [
        {
          key: "relink",
          label: "Find the folder…",
          variant: "primary",
          hint: "Point DinoDepot Studio at where the project lives now.",
        },
        {
          key: "forget",
          label: "Forget this project",
          variant: "danger",
          hint: "Removes it from this list only. Nothing on disk is deleted.",
        },
      ],
      cancelLabel: "Cancel",
    });
    if (answer === "forget") {
      await forgetProject(recent.dir);
      setMissing((m) => ({ ...m, [recent.dir]: false }));
      toast.info(`${recent.name} was removed from Recent projects`);
      return;
    }
    if (answer !== "relink") return;

    const target = await pickFolder(`Where is ${recent.name} now?`);
    if (!target) return;
    try {
      await openProject(target);
    } catch (e) {
      if (isStudioError(e) && e.code === "project.locked") {
        await offerTakeover(target, e.message);
        return;
      }
      toast.error(`Could not open project: ${e instanceof Error ? e.message : e}`);
      return;
    }
    // The machine-local record is keyed by project id and has already followed
    // the folder. Only the row naming the old path is stale — and only when it
    // is the same project, so picking a different one leaves the original entry
    // alone rather than silently discarding it.
    const opened = useProjectStore.getState().settings;
    if (!recent.projectId || opened?.projectId === recent.projectId) {
      dropRecentEntry(recent.dir);
    } else {
      toast.info(
        `That folder holds a different project (${opened?.name ?? "unknown"}). ${recent.name} is still listed as missing.`,
      );
    }
    navigate("/overview");
  }

  async function handleForget(recent: RecentProject) {
    const ok = await confirmDialog({
      title: "Forget this project?",
      message: `${recent.name} is removed from Recent projects on this computer.`,
      details: [
        "Nothing in the project folder is deleted.",
        "Open the folder again at any time to bring it back.",
      ],
      confirmLabel: "Forget",
      danger: true,
    });
    if (!ok) return;
    await forgetProject(recent.dir);
  }

  /**
   * Asks where projects should live and remembers the answer.
   *
   * Returns the chosen folder, or "" when the dialog was dismissed.
   */
  async function chooseRoot(): Promise<string> {
    const parent = await pickFolder(
      `Where should the "${PROJECTS_FOLDER_NAME}" folder go?`,
    );
    if (!parent) return "";
    const chosen = projectsRootIn(parent);
    setRoot(chosen);
    await saveProjectsRoot(chosen);
    return chosen;
  }

  /**
   * The projects folder, asking for it if this machine has never been told.
   *
   * Reads the stored answer itself rather than trusting `root` to have arrived:
   * the welcome screen is clickable before the first read comes back, and
   * asking again would make a second projects folder beside the real one.
   */
  async function ensureRoot(): Promise<string> {
    if (root) return root;
    const stored = await loadProjectsRoot();
    if (stored) {
      setRoot(stored);
      return stored;
    }
    return chooseRoot();
  }

  function startCreate() {
    setSuggestion(suggestNames());
    setCreating(true);
  }

  /** Opens the one reserved example, creating it only on first use. */
  async function upgradeOpenedExample(dir: string) {
    const state = useProjectStore.getState();
    if (state.dir !== dir || !needsExampleOfficialCatalogUpgrade(state.settings)) return;
    try {
      const upgraded = upgradeExampleProjectFiles(state.files);
      for (const [fileName, content] of Object.entries(upgraded)) {
        await useProjectStore.getState().saveFile(
          fileName as keyof typeof upgraded,
          content,
        );
      }
      await useProjectStore.getState().updateSettings(markExampleOfficialCatalog);
      toast.info("Example project updated to Official ASA catalog entries.");
    } catch (error) {
      toast.error(
        `Example opened, but its Official ASA examples could not be updated: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async function handleExampleProject() {
    const base = await ensureRoot();
    if (!base) return;
    setBusy(true);
    try {
      const dir = projectDirFor(base, EXAMPLE_PROJECT_NAME);
      const exists = await ipc<boolean>("project_exists", { dir }).catch(
        () => false,
      );
      if (exists) {
        await handleOpen(dir);
        await upgradeOpenedExample(dir);
        return;
      }
      await createProject(
        dir,
        EXAMPLE_PROJECT_NAME,
        EXAMPLE_PROJECT_CLUSTER,
        { example: true },
      );
      navigate("/overview");
    } catch (e) {
      toast.error(
        `Could not open the example project: ${e instanceof Error ? e.message : e}`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) {
      toast.error("Enter a project name first");
      return;
    }
    if (!root) {
      toast.error(
        `Choose where the "${PROJECTS_FOLDER_NAME}" folder should go first`,
      );
      return;
    }
    if (!targetDir) {
      toast.error(
        "That name leaves nothing a folder can be called — try another, or choose a folder yourself",
      );
      return;
    }
    setBusy(true);
    try {
      await createProject(targetDir, name, newCluster.trim() || `${name} Cluster`);
      navigate("/overview");
    } catch (e) {
      toast.error(`Could not create project: ${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="h-full flex items-center justify-center bg-ink-950"
      {...feedbackTarget("project-home")}
    >
      <div className="w-[520px]">
        <div className="text-center mb-8">
          <div className="text-xs font-bold tracking-widest text-accent-400 uppercase mb-1">
            Dino Depot
          </div>
          <h1 className="text-2xl font-bold text-white">
            Passive Production Studio
          </h1>
          <p className="text-ink-400 text-sm mt-1">
            Server configuration studio for ASA clusters
            {!isTauri && " — running in browser mock mode"}
          </p>
        </div>

        {!creating ? (
          <Card>
            <div className="flex flex-col gap-2">
              <Button variant="primary" onClick={startCreate} disabled={busy}>
                + New project
              </Button>
              <Button onClick={() => handleOpen()} disabled={busy}>
                Open project folder…
              </Button>
              <Button onClick={() => void handleExampleProject()} disabled={busy}>
                Example project
              </Button>
            </div>
            <p className="text-xs text-ink-400 mt-2">
              Explore real Official ASA catalog entries with a guided walkthrough. The example
              is created once in your projects folder and never connects to a
              repository or publishes anything unless you configure it yourself.
            </p>

            {shownRecents.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
                  Recent projects
                </div>
                <div className="flex flex-col gap-1">
                  {shownRecents.map((r) => (
                    <div
                      key={r.dir}
                      className="group flex items-center gap-1 rounded-md hover:bg-ink-800"
                    >
                      <button
                        onClick={() =>
                          missing[r.dir] ? handleMissing(r) : handleOpen(r.dir)
                        }
                        className="flex-1 min-w-0 text-left px-3 py-2 cursor-pointer"
                      >
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-ink-100 font-medium truncate">
                            {r.name}
                          </span>
                          {missing[r.dir] && <Badge tone="warn">Missing</Badge>}
                        </div>
                        <div className="text-xs text-ink-400 truncate">
                          {r.dir}
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        title={`Remove ${r.name} from this list`}
                        aria-label={`Forget ${r.name}`}
                        onClick={() => handleForget(r)}
                        className="mr-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                      >
                        ×
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </Card>
        ) : (
          <Card title="New project">
            <div className="flex flex-col gap-4">
              <Field label="Project name">
                <Input
                  autoFocus
                  value={newName}
                  placeholder={suggestion.project}
                  onChange={(e) => setNewName(e.target.value)}
                />
              </Field>
              <Field
                label="Cluster name"
                hint="Used in the files this project writes. Left blank, it follows the project name."
              >
                <Input
                  value={newCluster}
                  placeholder={suggestion.cluster}
                  onChange={(e) => setNewCluster(e.target.value)}
                />
              </Field>
              {/* Where the project lands: the path once there is one, and the
                  one button that changes it. What the folder *is* stays in the
                  `?` rather than a paragraph nobody reads twice. */}
              <div>
                <span className="block text-xs font-semibold text-ink-300 uppercase tracking-wide mb-1">
                  Folder
                </span>
                {shownDir && (
                  <div className="text-sm text-ink-100 break-all mono mb-2">
                    {shownDir}
                  </div>
                )}
                <div className="flex items-center gap-2">
                  <Button onClick={() => void chooseRoot()}>
                    {root
                      ? "Use a different projects folder…"
                      : "Choose where projects live…"}
                  </Button>
                  <HelpDot
                    label="What the projects folder is"
                    text={`A folder named "${PROJECTS_FOLDER_NAME}" is made where you choose, and every project after this one goes inside it.`}
                  />
                </div>
              </div>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void handleCreate()}
                >
                  {busy ? "Creating…" : "Create project"}
                </Button>
              </div>
            </div>
          </Card>
        )}
        {/* Reachable before any project is open: a problem on this screen is
            still a problem, and there is nowhere else to say so from. */}
        {feedbackEnabled && (
          <div className="mt-6 text-center">
            <button
              onClick={openFeedback}
              className="text-xs text-ink-500 hover:text-ink-200 cursor-pointer"
            >
              Report a problem or suggest an improvement
            </button>
          </div>
        )}
      </div>
      <ToastContainer />
      <ConfirmHost />
      <FeedbackHost />
    </div>
  );
}
