import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectStore, type RecentProject } from "../stores/projectStore";
import { pickFolder } from "../services/dialogs";
import { Badge, Button, Card, Field, Input } from "../components/ui";
import { toast, ToastContainer } from "../components/toast";
import { chooseDialog, confirmDialog, ConfirmHost } from "../components/confirm";
import { ipc, isTauri } from "../services/ipc";
import { isStudioError } from "../model/errors";

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
  const [newDir, setNewDir] = useState("");
  const [newName, setNewName] = useState("GG Fizz");
  const [newCluster, setNewCluster] = useState("GG Fizz Cluster");
  /** Folders in the list that no longer hold a project. */
  const [missing, setMissing] = useState<Record<string, boolean>>({});

  // The stored list is only ever a list of *paths*, so a folder that has been
  // moved, renamed or deleted still looks like a project until it is checked.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await loadRecentProjects().catch(() => {});
      const rows = useProjectStore.getState().recents;
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
    const target =
      dir ?? (await pickFolder("Select an existing project folder"));
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

  async function handleCreate() {
    if (!newDir || !newName) {
      toast.error("Pick a folder and enter a project name first");
      return;
    }
    try {
      await createProject(newDir, newName.trim(), newCluster.trim());
      navigate("/overview");
    } catch (e) {
      toast.error(`Could not create project: ${e instanceof Error ? e.message : e}`);
    }
  }

  return (
    <div className="h-full flex items-center justify-center bg-ink-950">
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
              <Button variant="primary" onClick={() => setCreating(true)}>
                + New project
              </Button>
              <Button onClick={() => handleOpen()}>Open project folder…</Button>
            </div>

            {recents.length > 0 && (
              <div className="mt-5">
                <div className="text-xs font-semibold text-ink-300 uppercase tracking-wide mb-2">
                  Recent projects
                </div>
                <div className="flex flex-col gap-1">
                  {recents.map((r) => (
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
              <Field label="Project folder" hint="An empty folder where the project files will live">
                <div className="flex gap-2">
                  <Input
                    value={newDir}
                    onChange={(e) => setNewDir(e.target.value)}
                    placeholder="C:\\Users\\you\\Documents\\DinoDepot Studio\\GG Fizz"
                  />
                  <Button
                    onClick={async () => {
                      const dir = await pickFolder("Choose a project folder");
                      if (dir) setNewDir(dir);
                    }}
                  >
                    Browse…
                  </Button>
                </div>
              </Field>
              <Field label="Project name">
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} />
              </Field>
              <Field label="Cluster name">
                <Input
                  value={newCluster}
                  onChange={(e) => setNewCluster(e.target.value)}
                />
              </Field>
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" onClick={() => setCreating(false)}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleCreate}>
                  Create project
                </Button>
              </div>
            </div>
          </Card>
        )}
      </div>
      <ToastContainer />
      <ConfirmHost />
    </div>
  );
}
