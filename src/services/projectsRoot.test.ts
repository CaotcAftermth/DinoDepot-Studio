import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  folderNameFor,
  joinPath,
  lastSegment,
  loadProjectsRoot,
  PROJECTS_FOLDER_NAME,
  projectDirFor,
  projectsRootIn,
  saveProjectsRoot,
} from "./projectsRoot";
import {
  FIRST_WORDS,
  SECOND_WORDS,
  suggestNames,
} from "../model/nameSuggestions";

/** What the fake backend has stored, and whether it is willing to answer. */
let stored: string | null = null;
let backendFails = false;
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    if (backendFails) throw new Error("application data folder is unreadable");
    switch (cmd) {
      case "projects_root_get":
        return stored;
      case "projects_root_set":
        stored = String(args.dir ?? "");
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));

/**
 * A project name becomes a folder name without the administrator seeing the
 * conversion, so anything this gets wrong shows up as a project that cannot be
 * created — or worse, one created somewhere other than where the card said.
 */

describe("joinPath", () => {
  it("keeps a Windows path a Windows path", () => {
    expect(joinPath("C:\\Users\\me\\Documents", "Studio")).toBe(
      "C:\\Users\\me\\Documents\\Studio",
    );
  });

  it("uses forward slashes when the path already does", () => {
    expect(joinPath("/home/me/docs", "Studio")).toBe("/home/me/docs/Studio");
  });

  it("does not double a trailing separator", () => {
    expect(joinPath("C:\\Users\\me\\", "Studio")).toBe("C:\\Users\\me\\Studio");
    expect(joinPath("/home/me/", "Studio")).toBe("/home/me/Studio");
  });
});

describe("lastSegment", () => {
  it("ignores a trailing separator", () => {
    expect(lastSegment("C:\\Users\\me\\Projects\\")).toBe("Projects");
    expect(lastSegment("/home/me/Projects")).toBe("Projects");
  });

  it("is empty for a bare root", () => {
    expect(lastSegment("/")).toBe("");
  });
});

describe("projectsRootIn", () => {
  it("makes the projects folder inside the chosen parent", () => {
    expect(projectsRootIn("C:\\Users\\me\\Documents")).toBe(
      `C:\\Users\\me\\Documents\\${PROJECTS_FOLDER_NAME}`,
    );
  });

  /**
   * The file dialog reopens where it was last used, so the second time this is
   * run the projects folder itself is what is staring at the administrator.
   * Nesting a second copy inside it would silently orphan every project
   * already there.
   */
  it("takes the projects folder itself as the answer", () => {
    const chosen = `D:\\ARK\\${PROJECTS_FOLDER_NAME}`;
    expect(projectsRootIn(chosen)).toBe(chosen);
    expect(projectsRootIn(chosen.toUpperCase())).toBe(chosen.toUpperCase());
    expect(projectsRootIn(`${chosen}\\`)).toBe(chosen);
  });

  it("is empty for an empty choice", () => {
    expect(projectsRootIn("   ")).toBe("");
  });
});

describe("folderNameFor", () => {
  it("keeps an ordinary name", () => {
    expect(folderNameFor("  GG Fizz  ")).toBe("GG Fizz");
  });

  it("replaces characters Windows refuses", () => {
    expect(folderNameFor('GG: Fizz/Fuzz?')).toBe("GG Fizz Fuzz");
    expect(folderNameFor("A<B>C|D*E")).toBe("A B C D E");
  });

  it("drops a trailing dot or space, which Windows would drop anyway", () => {
    expect(folderNameFor("Fizz.")).toBe("Fizz");
    expect(folderNameFor("Fizz . . ")).toBe("Fizz");
  });

  it("sidesteps reserved device names", () => {
    expect(folderNameFor("CON")).toBe("CON project");
    expect(folderNameFor("com4.cluster")).toBe("com4.cluster project");
    // Only the whole stem is reserved, not a name that starts with one.
    expect(folderNameFor("Console")).toBe("Console");
  });

  it("caps the length without leaving a trailing space", () => {
    const long = `${"a".repeat(63)} tail`;
    const name = folderNameFor(long);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe("a".repeat(63));
  });

  it("is empty when nothing usable is left", () => {
    expect(folderNameFor("  ///  ")).toBe("");
    expect(folderNameFor("...")).toBe("");
  });
});

describe("projectDirFor", () => {
  it("puts the project under the root", () => {
    expect(projectDirFor("C:\\Studio Projects", "GG Fizz")).toBe(
      "C:\\Studio Projects\\GG Fizz",
    );
  });

  /**
   * The caller must show an error rather than create anything: falling back to
   * the root itself would put project files loose among every other project.
   */
  it("refuses rather than falling back to the root", () => {
    expect(projectDirFor("C:\\Studio Projects", "///")).toBe("");
    expect(projectDirFor("", "GG Fizz")).toBe("");
  });
});

describe("name suggestions", () => {
  it("pairs a project name with a matching cluster name", () => {
    expect(suggestNames(() => 0)).toEqual({
      project: `${FIRST_WORDS[0]} ${SECOND_WORDS[0]}`,
      cluster: `${FIRST_WORDS[0]} ${SECOND_WORDS[0]} Cluster`,
    });
  });

  it("never repeats a word against itself", () => {
    // "Hollow" is in both lists, and picking it twice would suggest
    // "Hollow Hollow".
    const doubled = suggestNames(() => FIRST_WORDS.indexOf("Hollow") / FIRST_WORDS.length);
    expect(doubled.project).not.toBe("Hollow Hollow");
  });

  /** A suggestion an administrator accepts verbatim has to survive step two. */
  it("suggests only names that survive becoming a folder", () => {
    for (const first of FIRST_WORDS) {
      for (const second of SECOND_WORDS) {
        const project = `${first} ${second}`;
        if (first === second) continue;
        expect(folderNameFor(project)).toBe(project);
      }
    }
  });
});

/**
 * The location survives a restart or it is not a preference at all — an
 * administrator who is asked again on every launch ends up with a second
 * projects folder beside the real one. It lived in `localStorage` and was
 * cleared out from under the app, so the store itself is worth pinning down.
 */
describe("remembering the projects folder", () => {
  const ROOT_KEY = "ddstudio.projectsRoot";
  let legacy: Record<string, string> = {};

  beforeEach(() => {
    stored = null;
    backendFails = false;
    calls = [];
    legacy = {};
    // The suite runs without a DOM; the legacy read only has to be reachable.
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => legacy[k] ?? null,
      setItem: (k: string, v: string) => {
        legacy[k] = v;
      },
      removeItem: (k: string) => {
        delete legacy[k];
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is empty before the machine has ever been asked", async () => {
    await expect(loadProjectsRoot()).resolves.toBe("");
  });

  it("reads back what was saved", async () => {
    await saveProjectsRoot(`D:\ARK\${PROJECTS_FOLDER_NAME}`);
    await expect(loadProjectsRoot()).resolves.toBe(
      `D:\ARK\${PROJECTS_FOLDER_NAME}`,
    );
    expect(calls.map((c) => c.cmd)).toEqual([
      "projects_root_set",
      "projects_root_get",
    ]);
  });

  it("trims what it stores and what it returns", async () => {
    await saveProjectsRoot("  D:\ARK\Projects  ");
    expect(stored).toBe("D:\ARK\Projects");
    stored = "  D:\ARK\Projects  ";
    await expect(loadProjectsRoot()).resolves.toBe("D:\ARK\Projects");
  });

  /**
   * An install made before the location moved out of the webview still has the
   * answer in the old place. Adopting it is the difference between upgrading
   * and being asked the question this store exists to stop asking.
   */
  it("adopts the copy an older install left behind", async () => {
    legacy[ROOT_KEY] = `E:\Studio\${PROJECTS_FOLDER_NAME}`;
    await expect(loadProjectsRoot()).resolves.toBe(
      `E:\Studio\${PROJECTS_FOLDER_NAME}`,
    );
    // Written through, so the next run does not depend on the old store still
    // being there.
    expect(stored).toBe(`E:\Studio\${PROJECTS_FOLDER_NAME}`);
  });

  it("prefers the stored answer over the old copy", async () => {
    stored = "D:\New";
    legacy[ROOT_KEY] = "E:\Old";
    await expect(loadProjectsRoot()).resolves.toBe("D:\New");
  });

  /** A backend that cannot answer must read as "never asked", not as a crash. */
  it("treats an unreadable store as a first run", async () => {
    backendFails = true;
    await expect(loadProjectsRoot()).resolves.toBe("");
    await expect(saveProjectsRoot("D:\ARK")).resolves.toBeUndefined();
  });
});
