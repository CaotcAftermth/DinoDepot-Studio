/**
 * Configuration, and the shape of what the platform hands the service.
 *
 * Everything is an environment variable or a binding. Nothing is committed:
 * see `.env.example` for the list and `README.md` for how to set each one.
 */

/** A Workers KV namespace, described by the two methods this service uses. */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** An R2 bucket, likewise. */
export interface StoredBlob {
  readonly body: ReadableStream;
  readonly httpEtag: string;
  writeHttpMetadata(headers: Headers): void;
}

export interface BlobStore {
  get(key: string): Promise<StoredBlob | null>;
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

export interface Env {
  /** GitHub App id, from the app's settings page. */
  GITHUB_APP_ID?: string;
  /** The app's private key, PEM. PKCS#1 or PKCS#8; both are accepted. */
  GITHUB_APP_PRIVATE_KEY?: string;
  /** Installation id, from the URL of the app's installation. */
  GITHUB_INSTALLATION_ID?: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;

  /**
   * Optional shared key the client must present.
   *
   * Off by default, and deliberately so. A key compiled into a desktop
   * application that anybody can download is not a secret, and treating it as
   * one would be worse than not having it - it invites the belief that the
   * endpoint is protected when it is not. Rate limiting is what actually holds
   * the line. Set this only when the deployment is private and the key can be
   * distributed out of band.
   */
  FEEDBACK_SHARED_KEY?: string;

  /** Reports per installation per hour. */
  RATE_LIMIT_PER_HOUR?: string;
  /** Reports per source address per hour, across all installations behind it. */
  RATE_LIMIT_PER_IP_PER_HOUR?: string;

  /** Salt for hashing installation ids. Any long random string. */
  IDENTITY_SALT?: string;

  /** Optional public URL override. Defaults to this Worker's attachment route. */
  ATTACHMENTS_BASE_URL?: string;

  /** Optional. Without it, rate limiting is per-isolate and best effort. */
  FEEDBACK_KV?: KeyValueStore;
  /** Optional. Without it, attachments cannot be stored and are reported as such. */
  ATTACHMENTS?: BlobStore;
}

export interface Settings {
  appId: string;
  privateKey: string;
  installationId: string;
  owner: string;
  repo: string;
  sharedKey: string;
  perInstallationPerHour: number;
  perAddressPerHour: number;
  identitySalt: string;
  attachmentsBaseUrl: string;
}

export class ConfigError extends Error {}

const DEFAULT_PER_INSTALLATION = 10;
const DEFAULT_PER_ADDRESS = 30;

/**
 * Reads the configuration, refusing rather than guessing.
 *
 * A service that starts with half its configuration and fails on the first
 * real report is worse than one that will not start: the first failure would
 * be somebody's bug report, and they would be told the service was down.
 */
export function readSettings(env: Env): Settings {
  const required: [string, string | undefined][] = [
    ["GITHUB_APP_ID", env.GITHUB_APP_ID],
    ["GITHUB_APP_PRIVATE_KEY", env.GITHUB_APP_PRIVATE_KEY],
    ["GITHUB_INSTALLATION_ID", env.GITHUB_INSTALLATION_ID],
    ["GITHUB_OWNER", env.GITHUB_OWNER],
    ["GITHUB_REPO", env.GITHUB_REPO],
  ];
  const missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length > 0) {
    throw new ConfigError(`Not configured: ${missing.join(", ")}`);
  }

  return {
    appId: env.GITHUB_APP_ID!.trim(),
    privateKey: env.GITHUB_APP_PRIVATE_KEY!,
    installationId: env.GITHUB_INSTALLATION_ID!.trim(),
    owner: env.GITHUB_OWNER!.trim(),
    repo: env.GITHUB_REPO!.trim(),
    sharedKey: env.FEEDBACK_SHARED_KEY?.trim() ?? "",
    perInstallationPerHour: positiveInt(env.RATE_LIMIT_PER_HOUR, DEFAULT_PER_INSTALLATION),
    perAddressPerHour: positiveInt(env.RATE_LIMIT_PER_IP_PER_HOUR, DEFAULT_PER_ADDRESS),
    // Falls back to the app id, which is not secret but is at least stable and
    // deployment-specific. A missing salt must not turn hashing off.
    identitySalt: env.IDENTITY_SALT?.trim() || `dinodepot:${env.GITHUB_APP_ID}`,
    attachmentsBaseUrl: (env.ATTACHMENTS_BASE_URL ?? "").trim().replace(/\/+$/, ""),
  };
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function repoSlug(settings: Settings): string {
  return `${settings.owner}/${settings.repo}`;
}
