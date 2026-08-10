import { isTauri } from "./ipc";

/** Opens a native folder picker. Falls back to a prompt in browser mock mode. */
export async function pickFolder(title: string): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: true, title });
    return typeof result === "string" ? result : null;
  }
  return window.prompt(`${title} (mock mode: type a folder path)`) || null;
}

/** Opens a native file picker. Falls back to a prompt in browser mock mode. */
export async function pickFile(
  title: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: false, title, filters });
    return typeof result === "string" ? result : null;
  }
  return window.prompt(`${title} (mock mode: type a file path)`) || null;
}

/** Opens a native file picker that takes several files at once. */
export async function pickFiles(
  title: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string[]> {
  if (isTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const result = await open({ directory: false, multiple: true, title, filters });
    return Array.isArray(result) ? result : typeof result === "string" ? [result] : [];
  }
  const typed = window.prompt(`${title} (mock mode: type file paths, comma separated)`);
  return typed ? typed.split(",").map((p) => p.trim()).filter(Boolean) : [];
}

/** Opens a native "save as" dialog. Falls back to a prompt in mock mode. */
export async function pickSavePath(
  title: string,
  defaultPath?: string,
  filters?: { name: string; extensions: string[] }[],
): Promise<string | null> {
  if (isTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const result = await save({ title, defaultPath, filters });
    return typeof result === "string" ? result : null;
  }
  return window.prompt(`${title} (mock mode: type a file path)`) || null;
}
