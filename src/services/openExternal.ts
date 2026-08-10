import { isTauri } from "./ipc";

/** Opens a URL in the user's real browser (falls back to a new tab in mock mode). */
export async function openExternal(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error("Only http(s) links can be opened");
  }
  if (isTauri) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
