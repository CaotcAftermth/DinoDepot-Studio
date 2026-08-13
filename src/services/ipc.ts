/**
 * IPC layer. All Tauri `invoke` calls go through here so the entire UI can
 * also run in a plain browser (mock mode) for fast iteration and UI checks.
 */

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Args = Record<string, unknown>;

export async function ipc<T>(cmd: string, args?: Args): Promise<T> {
  if (isTauri) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(cmd, args);
  }
  return mockInvoke<T>(cmd, args ?? {});
}

// ---------------------------------------------------------------------------
// Browser mock backend: an in-memory "filesystem" persisted to localStorage.
// ---------------------------------------------------------------------------

const MOCK_KEY = "ddstudio.mockfs";

/**
 * Keeps mock-stored profiles out of the project file map, which `load_project`
 * hands to the draft parsers. The real backend keeps them in a subfolder; this
 * is the same separation with a key prefix.
 */
const MOCK_PROFILE_PREFIX = "profiles/";

/** Mirrors the real backend's snapshot folder, and is excluded the same way. */
const MOCK_SNAPSHOT_PREFIX = "backups/snapshots/";

/**
 * Machine-local project records. In the desktop app these live in the OS
 * application-data folder; here `localStorage` stands in for it, which keeps
 * them out of the mock project filesystem exactly as the real split does.
 */
const LOCAL_STATE_PREFIX = "ddstudio.localState.";

function localStateKey(projectId: string): string {
  return `${LOCAL_STATE_PREFIX}${projectId}`;
}

/** Mirrors `profile_file_name` in project_io.rs. */
function mockProfileName(playerId: string): string {
  const safe = (playerId ?? "")
    .replace(/[^a-zA-Z0-9\-_]/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${safe || "player"}.arkprofile`;
}

type MockFs = Record<string, Record<string, string>>; // dir -> file -> content

function loadMockFs(): MockFs {
  try {
    return JSON.parse(localStorage.getItem(MOCK_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveMockFs(fs: MockFs) {
  localStorage.setItem(MOCK_KEY, JSON.stringify(fs));
}

/**
 * Lazily initialised — importing this module must not require a DOM, or every
 * test that reaches the service layer fails at import time.
 */
let mockSecretsCache: Map<string, string> | null = null;

function secrets(): Map<string, string> {
  if (!mockSecretsCache) {
    let saved: [string, string][] = [];
    try {
      saved = JSON.parse(sessionStorage.getItem("ddstudio.mocksecrets") ?? "[]");
    } catch {
      /* no sessionStorage (tests), or unparseable — start empty */
    }
    mockSecretsCache = new Map(saved);
  }
  return mockSecretsCache;
}

function persistMockSecrets() {
  try {
    sessionStorage.setItem(
      "ddstudio.mocksecrets",
      JSON.stringify([...secrets().entries()]),
    );
  } catch {
    /* nothing to persist to outside a browser */
  }
}

async function mockInvoke<T>(cmd: string, args: Args): Promise<T> {
  const fs = loadMockFs();
  const dir = args.dir as string;
  switch (cmd) {
    case "project_exists":
      return Boolean(fs[dir]?.["project.json"]) as T;
    case "create_project_dir": {
      if (fs[dir]?.["project.json"]) {
        throw new Error("A project already exists in that folder");
      }
      fs[dir] = fs[dir] ?? {};
      saveMockFs(fs);
      return undefined as T;
    }
    case "load_project": {
      if (!fs[dir]?.["project.json"]) {
        throw new Error("No project.json found in that folder");
      }
      // The real backend only returns *.json from the project folder.
      return Object.fromEntries(
        Object.entries(fs[dir]).filter(([name]) => name.endsWith(".json")),
      ) as T;
    }
    case "save_project_file": {
      fs[dir] = fs[dir] ?? {};
      fs[dir][args.fileName as string] = args.content as string;
      saveMockFs(fs);
      return undefined as T;
    }
    case "quarantine_project_file": {
      const name = args.fileName as string;
      const damaged = fs[dir]?.[name];
      if (damaged === undefined) throw new Error(`${name} is not there to set aside`);
      fs[dir][`recovery/${name}`] = damaged;
      delete fs[dir][name];
      saveMockFs(fs);
      return `recovery/${name}` as T;
    }
    case "snapshot_project": {
      const label = (args.label as string) || "snapshot";
      const path = `${MOCK_SNAPSHOT_PREFIX}${label}-${Date.now()}`;
      fs[dir] = fs[dir] ?? {};
      const entries = Object.entries(fs[dir]).filter(
        ([name]) => !name.startsWith(MOCK_SNAPSHOT_PREFIX),
      );
      for (const [name, content] of entries) fs[dir][`${path}/${name}`] = content;
      saveMockFs(fs);
      return { path, fileCount: entries.length } as T;
    }
    case "commit_migrated_project": {
      const incoming = args.files as Record<string, string>;
      fs[dir] = fs[dir] ?? {};
      const path = `${MOCK_SNAPSHOT_PREFIX}pre-migration-${Date.now()}`;
      for (const [name, content] of Object.entries(fs[dir])) {
        if (!name.startsWith(MOCK_SNAPSHOT_PREFIX)) fs[dir][`${path}/${name}`] = content;
      }
      Object.assign(fs[dir], incoming);
      saveMockFs(fs);
      return { path, fileCount: Object.keys(incoming).length } as T;
    }
    // The lock is advisory and single-machine; a browser tab has nothing to
    // contend with, so it always reports the project as free.
    case "project_lock_status":
    case "project_lock_acquire":
    case "project_lock_refresh":
      return {
        held: false,
        owned: true,
        stale: false,
        machine: "",
        instanceId: "mock",
        heartbeatAt: Date.now(),
      } as T;
    case "project_lock_release":
      return undefined as T;
    case "local_state_get":
      return (localStorage.getItem(localStateKey(args.projectId as string)) ??
        null) as T;
    case "local_state_set": {
      localStorage.setItem(
        localStateKey(args.projectId as string),
        args.content as string,
      );
      return undefined as T;
    }
    case "local_state_delete": {
      localStorage.removeItem(localStateKey(args.projectId as string));
      return undefined as T;
    }
    case "local_state_list": {
      const out: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(LOCAL_STATE_PREFIX)) continue;
        const value = localStorage.getItem(key);
        if (value) out.push(value);
      }
      return out as T;
    }
    case "read_text_file":
      throw new Error("read_text_file is not available in browser mock mode");
    case "save_text_file":
      throw new Error("save_text_file is not available in browser mock mode");
    // Profile storage is backed by the mock filesystem so the import and
    // generate flows can be exercised in the browser. Anything that needs a
    // real path — copying a file in or out — still cannot work here.
    case "store_player_profile_b64": {
      const fileName = mockProfileName(args.playerId as string);
      fs[dir] = fs[dir] ?? {};
      fs[dir][`${MOCK_PROFILE_PREFIX}${fileName}`] = args.contentB64 as string;
      saveMockFs(fs);
      return { fileName, sizeBytes: (args.contentB64 as string).length } as T;
    }
    case "write_player_profile_b64": {
      fs[dir] = fs[dir] ?? {};
      fs[dir][`${MOCK_PROFILE_PREFIX}${args.fileName}`] = args.contentB64 as string;
      saveMockFs(fs);
      return 0 as T;
    }
    case "read_player_profile_b64": {
      const stored = fs[dir]?.[`${MOCK_PROFILE_PREFIX}${args.fileName}`];
      if (!stored) throw new Error("No stored profile found for that player");
      return stored as T;
    }
    case "delete_player_profile": {
      delete fs[dir]?.[`${MOCK_PROFILE_PREFIX}${args.fileName}`];
      saveMockFs(fs);
      return undefined as T;
    }
    case "store_player_profile":
    case "export_player_profile":
    case "read_profile_file_b64":
      throw new Error("Profile files can only be handled in the desktop app");
    case "list_images":
      return [] as T;
    case "discord_post":
      throw new Error("Discord posting is only available in the desktop app");
    case "wiki_fetch_page":
      // The wiki blocks cross-origin reads, which is why the real fetch runs
      // in Rust. The fixture import path works here.
      throw new Error(
        "Fetching from the wiki is only available in the desktop app — use the fixture import in browser mode",
      );
    // Mod Discovery reads the game's installed files, which a browser cannot
    // see at all. There is no useful mock: the whole feature is the filesystem.
    case "resolve_mods_root":
    case "list_installed_mods":
    case "read_installed_mods":
      throw new Error(
        "Reading installed mods is only available in the desktop app",
      );
    // Connecting an account reaches GitHub with a real credential, and the
    // credential lives in Windows Credential Manager — neither exists here.
    // Refused with the code the real one would use, so the UI shows the same
    // message rather than a mock-backend string.
    case "github_connect_account":
    case "github_account_status":
    case "github_repo_by_slug":
    case "github_repo_by_id":
    case "github_branch_exists":
      throw new Error(
        JSON.stringify({
          code: "auth.missing",
          message: "Connecting to GitHub is only available in the desktop app.",
          detail: `${cmd} is not available in browser mock mode`,
        }),
      );
    case "github_disconnect_account":
      return undefined as T;
    // A browser has no repository, so a project here has no history. Empty is
    // the truthful answer, and it reads as "nothing shared yet" rather than as
    // a failure.
    case "git_log":
      return [] as T;
    case "git_state":
      return { head: "", remote: "", dirty: false, branch: "main" } as T;
    case "git_capabilities":
      return { version: "0.0.0", https: false, ssh: false, threads: false } as T;
    case "delivery_dir":
      return `mock-delivery/${args.projectId}` as T;
    case "icon_cache_get":
      return { path: "", cached: false, etag: "" } as T;
    case "icon_cache_stats":
      return { files: 0, bytes: 0, limit: 0 } as T;
    case "icon_cache_clear":
      return 0 as T;
    // Everything that needs a real repository or a credential.
    case "git_fetch":
    case "git_push":
    case "git_commit":
    case "git_fast_forward":
    case "git_replace_dir":
    case "git_restore_files":
    case "git_read_tree":
    case "git_set_remote":
    case "git_mark_recovery":
    case "git_clear_recovery":
    case "icon_fetch":
    case "icon_cache_put":
      throw new Error(
        JSON.stringify({
          code: "unknown",
          message: "This is only available in the desktop app.",
          detail: `${cmd} is not available in browser mock mode`,
        }),
      );
    case "secret_set":
      secrets().set(args.key as string, args.value as string);
      persistMockSecrets();
      return undefined as T;
    case "secret_get":
      return (secrets().get(args.key as string) ?? null) as T;
    case "secret_has":
      return secrets().has(args.key as string) as T;
    case "secret_delete":
      secrets().delete(args.key as string);
      persistMockSecrets();
      return undefined as T;
    default:
      throw new Error(`Mock backend has no handler for command '${cmd}'`);
  }
}
