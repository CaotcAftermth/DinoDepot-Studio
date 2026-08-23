import { create } from "zustand";
import { ipc } from "./ipc";
import { testConnection } from "./publish";
import type { ConnectionState } from "../model/githubReadiness";
import type { GithubConfig } from "../model/project";

/**
 * Cached answers to the two GitHub questions that cost a round trip.
 *
 * Overview needs both to say anything honest about publishing readiness, and
 * Overview re-renders constantly — so neither is ever fetched during render.
 * The token is read once per session; the connection is only ever recorded
 * from a test the admin actually ran, and is dropped the moment the
 * destination changes so a stale "verified" can never outlive the repo it
 * described.
 */

interface GithubStatusState {
  /** Null until the credential store has been read. */
  tokenPresent: boolean | null;
  connection: ConnectionState;
  /** Account plus destination the cached `connection` belongs to. */
  connectionTarget: string;
  /** Reads the token once; further calls are no-ops while one is in flight. */
  ensureToken(accountId: string): void;
  /** Forces a re-read, after the token has been stored or removed. */
  refreshToken(accountId: string): Promise<void>;
  /** Runs a connection test and remembers the outcome for this destination. */
  checkConnection(config: GithubConfig): Promise<{ ok: boolean; message: string }>;
  /** The cached connection state for a destination, if it still applies. */
  connectionFor(config: GithubConfig | null): ConnectionState;
}

/** Cache key includes credential identity as well as repository destination. */
export function githubConnectionTarget(config: GithubConfig): string {
  return `${config.accountId}|${config.owner}/${config.repo}@${config.branch}`;
}

let tokenRead: Promise<void> | null = null;
let tokenReadFor = "";

export const useGithubStatus = create<GithubStatusState>((set, get) => ({
  tokenPresent: null,
  connection: "unknown",
  connectionTarget: "",

  ensureToken(accountId) {
    if (tokenRead && tokenReadFor === accountId) return;
    tokenReadFor = accountId;
    tokenRead = get().refreshToken(accountId);
  },

  async refreshToken(accountId) {
    if (!accountId) {
      set({ tokenPresent: false });
      return;
    }
    try {
      const has = await ipc<boolean>("secret_has", {
        key: `github-account:${accountId}`,
      });
      if (tokenReadFor !== accountId) return;
      set({ tokenPresent: has });
    } catch {
      // A credential store that cannot be read is not the same as "no token";
      // leaving it unknown keeps readiness from claiming a blocker it has not
      // established.
      if (tokenReadFor === accountId) set({ tokenPresent: null });
    }
  },

  async checkConnection(config) {
    try {
      const result = await testConnection(config);
      set({
        connection: result.ok ? "ok" : "failed",
        connectionTarget: githubConnectionTarget(config),
      });
      return result;
    } catch (e) {
      set({
        connection: "failed",
        connectionTarget: githubConnectionTarget(config),
      });
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  connectionFor(config) {
    if (!config) return "unknown";
    const { connection, connectionTarget } = get();
    return connectionTarget === githubConnectionTarget(config)
      ? connection
      : "unknown";
  },
}));

/** Clears the session cache — used when a different project is opened. */
export function resetGithubStatus() {
  tokenRead = null;
  tokenReadFor = "";
  useGithubStatus.setState({
    tokenPresent: null,
    connection: "unknown",
    connectionTarget: "",
  });
}
