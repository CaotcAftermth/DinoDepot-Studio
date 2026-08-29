import { StudioError } from "./errors";
import {
  ArkProfileError,
  parseArkProfile,
  serializeArkProfile,
  type ArkProfile,
} from "../serializers/arkprofile";
import {
  applyProfileEdits,
  readNetworkAddress,
  readProfileSummary,
} from "./profileData";

/**
 * The gate every `.arkprofile` passes through before it leaves this computer.
 *
 * A profile is a player's save. It carries the IP address they last connected
 * from, which is personal data that has no business in a repository - not even
 * a private one, because "private" is a setting somebody can change, and a
 * repository's history keeps what was committed to it forever.
 *
 * So the rule is absolute: nothing uploads the original file. This module
 * produces a sanitized copy or it refuses, and there is no third outcome.
 *
 * The verification after serializing is the point. Clearing the field and
 * trusting that it worked would be one bug away from uploading an IP anyway,
 * so the sanitized bytes are parsed *back* and checked - the same way anybody
 * receiving the file would read it.
 */

/**
 * Bumped whenever what this removes changes.
 *
 * Recorded alongside each backup so a project can be re-swept when a later
 * version learns to remove something this one did not know about.
 */
export const SANITIZER_VERSION = 1;

/** Save versions this has been exercised against. */
export const SUPPORTED_SAVE_VERSIONS = [5, 7] as const;

export interface SanitizedProfile {
  /** The bytes that may be uploaded. Never the input. */
  bytes: Uint8Array;
  sanitizerVersion: number;
  saveVersion: number;
  /** True when the original actually carried an address. */
  hadNetworkAddress: boolean;
  /** Content hashes, for noticing a re-upload is unnecessary. */
  originalHash: string;
  sanitizedHash: string;
}

/**
 * Fields compared before and after, to catch a sanitizer that removed more than
 * it meant to.
 *
 * Deliberately the identity and progression an administrator would notice
 * missing - a save that comes back with the right IP removed and the wrong
 * level is not a success.
 */
const PRESERVED_FIELDS = [
  "eosId",
  "accountName",
  "characterName",
  "playerDataId",
  "tribeId",
  "mapPackage",
  "level",
  "extraLevel",
  "highestLevel",
  "experience",
  "engramPoints",
  "engramsLearned",
  "explorerNotes",
  "deaths",
  "spentPoints",
  "saveVersion",
] as const;

/**
 * Produces the uploadable copy of a profile.
 *
 * Throws rather than returning a partial result. Every caller is about to put
 * the output somewhere permanent, and "sanitized, probably" is not a state this
 * can be allowed to express.
 */
export function sanitizeProfile(bytes: Uint8Array): SanitizedProfile {
  let profile: ArkProfile;
  try {
    profile = parseArkProfile(bytes);
  } catch (e) {
    throw new StudioError(
      "profile.unsanitizable",
      "DinoDepot cannot read this profile, so it cannot remove the player's IP address from it. The file has been left on this computer and not uploaded.",
      { detail: e instanceof Error ? e.message : String(e), cause: e },
    );
  }

  if (!SUPPORTED_SAVE_VERSIONS.includes(profile.saveVersion as 5 | 7)) {
    // A save version nobody has looked at may keep the address somewhere else
    // entirely. Uploading it because the one field this knows about happened to
    // be empty would be luck, not safety.
    throw new StudioError(
      "profile.unsanitizable",
      `This profile uses a save format DinoDepot does not know yet (version ${profile.saveVersion}). Update DinoDepot Studio, or leave this player out of the backup. The file has not been uploaded.`,
      { detail: `unsupported saveVersion ${profile.saveVersion}` },
    );
  }

  const before = readProfileSummary(profile);

  // `clearNetworkAddress` writes an empty string over the address in a *copy*;
  // the caller's bytes are never touched.
  const edited = applyProfileEdits(profile, { clearNetworkAddress: true });

  let sanitized: Uint8Array;
  try {
    sanitized = serializeArkProfile(edited.profile);
  } catch (e) {
    throw new StudioError(
      "profile.unsanitizable",
      "The cleaned copy of this profile could not be written. The original has been left on this computer and not uploaded.",
      { detail: e instanceof Error ? e.message : String(e), cause: e },
    );
  }

  // --- read it back the way anybody receiving it would ---------------------
  let reread: ArkProfile;
  try {
    reread = parseArkProfile(sanitized);
  } catch (e) {
    throw new StudioError(
      "profile.unsanitizable",
      "The cleaned copy of this profile could not be read back, so DinoDepot cannot confirm it is safe to upload. Nothing has been uploaded.",
      { detail: e instanceof Error ? e.message : String(e), cause: e },
    );
  }

  const after = readProfileSummary(reread);

  if (readNetworkAddress(reread) !== "") {
    throw new StudioError(
      "profile.unsanitizable",
      "DinoDepot could not remove the player's IP address from this profile, so it has not been uploaded.",
      { detail: "SavedNetworkAddress still set after sanitizing" },
    );
  }

  const changed = PRESERVED_FIELDS.filter(
    (field) => String(before[field]) !== String(after[field]),
  );
  if (changed.length > 0) {
    // Removing the address must not disturb anything else. A save that comes
    // back with the right field cleared and the wrong level is not a success.
    throw new StudioError(
      "profile.unsanitizable",
      "Cleaning this profile changed more than the IP address, so it has not been uploaded. The original is untouched on this computer.",
      { detail: `changed: ${changed.join(", ")}` },
    );
  }

  return {
    bytes: sanitized,
    sanitizerVersion: SANITIZER_VERSION,
    saveVersion: profile.saveVersion,
    hadNetworkAddress: readNetworkAddress(profile) !== "",
    originalHash: hashBytes(bytes),
    sanitizedHash: hashBytes(sanitized),
  };
}

/**
 * Whether a sanitizer failure is this profile's fault or this build's.
 *
 * Only used to word the message: an unreadable file is the administrator's
 * problem to investigate, a save version we have not met is ours.
 */
export function isUnsupportedVersion(error: unknown): boolean {
  return (
    error instanceof StudioError &&
    error.code === "profile.unsanitizable" &&
    error.detail.startsWith("unsupported saveVersion")
  );
}

export { ArkProfileError };

/**
 * FNV-1a over bytes, as 8 hex characters.
 *
 * Not a security hash and not used as one - it answers "are these the same
 * bytes I already uploaded", where a collision costs a redundant upload.
 */
export function hashBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The public boundary
// ---------------------------------------------------------------------------

/**
 * Anything that looks like an IP address.
 *
 * Used as a last check over text about to be committed - belt and braces
 * against a field nobody thought to look at. IPv4 with a plausible-octet
 * requirement, plus the IPv6 shapes an address actually takes.
 */
const IP_PATTERNS: RegExp[] = [
  /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  /**
   * IPv6: either all eight groups written out, or any form containing `::`.
   *
   * Those two shapes are what an address actually looks like, and requiring one
   * of them is what stops `ratio 1:2` and a timestamp being flagged. The
   * lookarounds are on `[\w:]` rather than `\b`, because a word boundary does
   * not exist before a leading colon - which is exactly the `::1` case.
   */
  /(?<![\w:])(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4}){7}|(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?::(?:[0-9a-fA-F]{1,4}(?::[0-9a-fA-F]{1,4})*)?)(?![\w:])/g,
];

/**
 * Every address-shaped string in some text.
 *
 * Deliberately over-eager: a version number is not an IP, but a false positive
 * costs a moment's confusion while a false negative publishes somebody's home
 * address.
 */
export function findIpAddresses(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of IP_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // A four-part version like 1.2.3.4 is indistinguishable from an IP, and
      // is treated as one. Anything genuinely a version belongs in a field this
      // check is not run over.
      found.add(match[0]);
    }
  }
  return [...found];
}
