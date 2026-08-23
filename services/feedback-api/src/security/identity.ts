/**
 * Identifiers, hashed before they are used for anything.
 *
 * Two values reach this service that could identify somebody: the
 * installation id the app generates, and the address the request came from.
 * Neither is ever stored or logged as it arrived. They are salted and hashed
 * on the way in, and only the digest is used — as a rate-limiting key, and for
 * nothing else.
 *
 * The salt is per deployment. It makes the digests useless outside this
 * service, so a rate-limit key that leaked would not let anybody confirm
 * whether a particular installation had ever filed a report.
 */

const encoder = new TextEncoder();

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A short digest, which is all a rate-limit key needs.
 *
 * Sixteen hex characters is 64 bits — far past the point where a collision
 * matters here, and short enough to keep the stored keys small.
 */
export async function hashIdentifier(value: string, salt: string): Promise<string> {
  if (!value) return "";
  return (await sha256Hex(`${salt}:${value}`)).slice(0, 16);
}

/**
 * Whether the client presented the shared key, when one is required.
 *
 * Compared in constant time. The comparison is not the weak point here — a key
 * shipped inside a downloadable application is not a secret at all — but
 * writing the check the other way would set a bad example for the next thing
 * that needs one.
 */
export function sharedKeyAccepted(presented: string, expected: string): boolean {
  if (!expected) return true;
  if (presented.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}
