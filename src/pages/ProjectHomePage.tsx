import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useProjectStore } from "../stores/projectStore";
import { pickFolder } from "../services/dialogs";
import { Button, Card, Field, Input } from "../components/ui";
import { toast, ToastContainer } from "../components/toast";
import { ConfirmHost } from "../components/confirm";
import { isTauri } from "../services/ipc";

export function ProjectHomePage() {
  const navigate = useNavigate();
  const { recents, openProject, createProject } = useProjectStore();
  const [creating, setCreating] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [newName, setNewName] = useState("GG Fizz");
  const [newCluster, setNewCluster] = useState("GG Fizz Cluster");

  async function handleOpen(dir?: string) {
    const target =
      dir ?? (await pickFolder("Select an existing project folder"));
    if (!target) return;
    try {
      await openProject(target);
      navigate("/overview");
    } catch (e) {
      toast.error(`Could not open project: ${e instanceof Error ? e.message : e}`);
    }
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
                    <button
                      key={r.dir}
                      onClick={() => handleOpen(r.dir)}
                      className="text-left px-3 py-2 rounded-md hover:bg-ink-800 cursor-pointer"
                    >
                      <div className="text-sm text-ink-100 font-medium">
                        {r.name}
                      </div>
                      <div className="text-xs text-ink-400 truncate">{r.dir}</div>
                    </button>
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
