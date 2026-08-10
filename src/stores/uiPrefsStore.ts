import { create } from "zustand";

/**
 * Purely presentational preferences — which cards the admin has folded up or
 * opened out.
 *
 * Deliberately *not* in the project files: collapsing a card says nothing
 * about the cluster's configuration, and writing it into the drafts would put
 * one admin's view state into the published-adjacent data every other admin
 * pulls. localStorage is the same place the recent-projects list already
 * lives, and it survives a restart in both the desktop webview and the browser
 * mock.
 *
 * What is stored is the set of cards whose state *differs from their default*,
 * not the set of collapsed ones. Sections have different defaults — a rule
 * editor opens, a remap in a long list does not — and storing deviations means
 * an untouched card always follows its section's default, and the store stays
 * empty until the admin actually changes something.
 */

const STORAGE_KEY = "ddstudio.foldState";

function load(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(raw) ? raw.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set();
  }
}

function persist(toggled: Set<string>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...toggled]));
  } catch {
    // A full or unavailable localStorage costs the admin a preference, which
    // is not worth interrupting them over.
  }
}

interface UiPrefsState {
  /** Keys whose fold state is the opposite of their section's default. */
  toggled: Set<string>;
  setToggled(key: string, value: boolean): void;
  /**
   * Drops stored ids that no longer exist. Called with the live ids of a
   * family (`remap:*`, `rule:*`…) so deleting a rule doesn't leave its key
   * behind forever — and so a *new* rule reusing an id can't inherit it.
   */
  prune(prefix: string, liveKeys: string[]): void;
}

export const useUiPrefsStore = create<UiPrefsState>((set, get) => ({
  toggled: load(),

  setToggled(key, value) {
    const toggled = new Set(get().toggled);
    if (value) toggled.add(key);
    else toggled.delete(key);
    persist(toggled);
    set({ toggled });
  },

  prune(prefix, liveKeys) {
    const live = new Set(liveKeys);
    const current = get().toggled;
    const stale = [...current].filter(
      (key) => key.startsWith(prefix) && !live.has(key),
    );
    if (stale.length === 0) return;
    const toggled = new Set(current);
    for (const key of stale) toggled.delete(key);
    persist(toggled);
    set({ toggled });
  },
}));

/** True when the card under `key` was moved away from its default state. */
export function useToggled(key: string | undefined): boolean {
  return useUiPrefsStore((s) => (key ? s.toggled.has(key) : false));
}
