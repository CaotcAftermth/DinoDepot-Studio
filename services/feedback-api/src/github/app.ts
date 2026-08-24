import type { Settings } from "../env";

/**
 * Authenticating to GitHub as the DinoDepot Feedback App.
 *
 * The desktop application holds no credential for this at all. It sends a
 * report; this service signs a short-lived assertion with the app's private
 * key, exchanges it for an installation token, and files the issue. The key
 * never leaves the service and the token never leaves this module.
 *
 * The app's permissions are deliberately two: Issues read and write, and
 * Metadata read. That is everything issue filing needs and nothing else — a
 * compromise of this service could file and read issues in one repository,
 * which is close to what the endpoint openly offers anyway.
 *
 * Signing uses Web Crypto rather than a JWT library, so this has no
 * dependencies and runs unchanged on any platform with the standard APIs.
 */

const encoder = new TextEncoder();

/** Cloudflare's global fetch must be invoked with the global object as receiver. */
export const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

/** Base64url without padding, which is what a JWT segment is. */
function base64url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlJson(value: unknown): string {
  return base64url(encoder.encode(JSON.stringify(value)));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Key import
// ---------------------------------------------------------------------------

/** DER length, short form under 128 and long form above it. */
function derLength(length: number): number[] {
  if (length < 0x80) return [length];
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

/** `AlgorithmIdentifier` for rsaEncryption: the OID and an explicit NULL. */
const RSA_ALGORITHM_IDENTIFIER = [
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
];

/**
 * Wraps a PKCS#1 `RSAPrivateKey` in the PKCS#8 envelope Web Crypto requires.
 *
 * GitHub hands out PKCS#1 (`BEGIN RSA PRIVATE KEY`) and `importKey` only takes
 * PKCS#8. Converting is a fixed ASN.1 header around the same bytes, which is
 * cheaper than telling every operator to run `openssl pkcs8` before they can
 * deploy — and a step like that is one somebody eventually skips.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  const body = [
    0x02, 0x01, 0x00, // version 0
    ...RSA_ALGORITHM_IDENTIFIER,
    0x04, ...derLength(pkcs1.length), // privateKey OCTET STRING
    ...pkcs1,
  ];
  return new Uint8Array([0x30, ...derLength(body.length), ...body]);
}

/** Strips the PEM armour and returns the DER inside it. */
export function derFromPem(pem: string): { der: Uint8Array; pkcs1: boolean } {
  const text = pem.replace(/\\n/g, "\n").trim();
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END \1-----/.exec(text);
  if (!match) {
    throw new Error("GITHUB_APP_PRIVATE_KEY is not a PEM private key");
  }
  const label = match[1].trim();
  if (label !== "PRIVATE KEY" && label !== "RSA PRIVATE KEY") {
    throw new Error(`GITHUB_APP_PRIVATE_KEY is a ${label}, not a private key`);
  }
  const der = decodeBase64(match[2].replace(/\s+/g, ""));
  return { der, pkcs1: label === "RSA PRIVATE KEY" };
}

let cachedKey: { pem: string; key: CryptoKey } | null = null;

async function importSigningKey(pem: string): Promise<CryptoKey> {
  if (cachedKey?.pem === pem) return cachedKey.key;
  const { der, pkcs1 } = derFromPem(pem);
  const pkcs8 = pkcs1 ? pkcs1ToPkcs8(der) : der;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    // A fresh buffer: some runtimes reject a view with a non-zero offset.
    pkcs8.slice().buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cachedKey = { pem, key };
  return key;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * An app JWT.
 *
 * Issued sixty seconds in the past, because GitHub rejects a token whose `iat`
 * is in the future and clocks between here and there are not identical. Ten
 * minutes is GitHub's maximum lifetime; this asks for nine.
 */
export async function appJwt(settings: Settings, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000) - 60;
  const header = base64urlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64urlJson({
    iat: issuedAt,
    exp: issuedAt + 9 * 60,
    iss: settings.appId,
  });
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importSigningKey(settings.privateKey),
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64url(signature)}`;
}

interface CachedToken {
  token: string;
  /** Epoch milliseconds. Held short of the real expiry — see below. */
  expiresAt: number;
}

let cachedInstallationToken: CachedToken | null = null;

/**
 * Sixty seconds of headroom.
 *
 * An installation token that expires between being read and being used
 * produces a 401 on somebody's bug report, which is the least useful place for
 * one. Retiring it a minute early costs one extra exchange an hour.
 */
const TOKEN_HEADROOM_MS = 60 * 1000;

/**
 * The installation token, minted on demand and reused until it is nearly due.
 *
 * Cached per isolate rather than in KV. A token in KV is a credential at rest
 * for the sake of saving one request an hour, and the exchange is cheap.
 */
export async function installationToken(
  settings: Settings,
  fetchImpl: typeof fetch = runtimeFetch,
  now = Date.now(),
): Promise<string> {
  if (cachedInstallationToken && cachedInstallationToken.expiresAt - TOKEN_HEADROOM_MS > now) {
    return cachedInstallationToken.token;
  }

  const jwt = await appJwt(settings, now);
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(settings.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "DinoDepotFeedback",
        "x-github-api-version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    // The body is not included. It can echo the assertion back, and an
    // assertion in a log is a nine-minute credential in a log.
    throw new Error(`GitHub refused the installation token (${response.status})`);
  }

  const body = (await response.json()) as { token?: string; expires_at?: string };
  if (!body.token) throw new Error("GitHub returned no installation token");

  cachedInstallationToken = {
    token: body.token,
    expiresAt: body.expires_at ? Date.parse(body.expires_at) : now + 55 * 60 * 1000,
  };
  return cachedInstallationToken.token;
}

/** Clears the cached key and token. For tests, and for a configuration change. */
export function resetAuthCache(): void {
  cachedKey = null;
  cachedInstallationToken = null;
}
