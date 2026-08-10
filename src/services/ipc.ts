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
