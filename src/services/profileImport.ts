import { newId } from "../model/ids";
import {
  newPlayer,
  Player,
  playerLabel,
  type PlayerFieldKey,
  type StoredProfile,
} from "../model/players";
import { readProfileSummary, type ProfileSummary } from "../model/profileData";
import { parseArkProfile } from "../serializers/arkprofile";

/**
 * Bulk `.arkprofile` import.
 *
 * A dropped profile has to find its own way to a roster entry: the admin is
 * dropping a folder of files named after EOS ids, and matching them up by hand
 * is the tedium this replaces. Everything here is pure so the matching rules
 * can be tested without a filesystem - the page does the file IO.
 */

/** A file handed to the importer, however it arrived. */
export interface ProfileFile {
  /** Display name only. The name on disk is not trusted to identify anyone. */
  fileName: string;
  bytes: Uint8Array;
  /** File's own last-modified time, epoch ms. 0 when unknown. */
  modifiedAt?: number;
}

/** A roster value the profile disagrees with. Never overwritten silently. */
export interface FieldConflict {
  key: PlayerFieldKey;
  label: string;
  existing: string;
  incoming: string;
}

export interface ProfileImportResult {
  fileName: string;
  /** Null when the file could not be read as a profile. */
  summary: ProfileSummary | null;
  error?: string;
  /** Which roster entry this landed on. */
  playerId?: string;
  playerName?: string;
  /** How the entry was found, for the review list. */
  matchedBy?: "eosId" | "playerId" | "characterName" | "new";
  /** Blank fields the profile filled in. */
  filled: PlayerFieldKey[];
  conflicts: FieldConflict[];
  /**
   * Set when the roster was updated but the file itself could not be saved -
   * the identifiers landed, the profile did not, and those are worth telling
   * apart.
   */
  storeError?: string;
}

/** Fields a profile can speak to, and where each one comes from. */
const FIELD_SOURCES: {
  key: PlayerFieldKey;
  label: string;
  from: (s: ProfileSummary) => string;
}[] = [
  { key: "eosId", label: "EOS ID", from: (s) => s.eosId },
  { key: "playerId", label: "Player ID", from: (s) => s.playerDataId },
  { key: "accountName", label: "Account name", from: (s) => s.accountName },
  { key: "gameName", label: "Game name", from: (s) => s.characterName },
];

/** Reads a profile's summary, turning any parse failure into a message. */
export function readProfileFile(file: ProfileFile): ProfileImportResult {
  try {
    const summary = readProfileSummary(parseArkProfile(file.bytes));
    return { fileName: file.fileName, summary, filled: [], conflicts: [] };
  } catch (e) {
    return {
      fileName: file.fileName,
      summary: null,
      error: e instanceof Error ? e.message : String(e),
      filled: [],
      conflicts: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Choosing between several files for one account
// ---------------------------------------------------------------------------

/** One readable file, as a candidate for the account it belongs to. */
export interface ProfileCandidate {
  /** Position in the list handed to the importer. */
  fileIndex: number;
  fileName: string;
  /** File's last-modified time, epoch ms; 0 when unknown. */
  modifiedAt: number;
  summary: ProfileSummary;
}

/** Every file that claims one EOS ID, newest first. */
export interface ProfileGroup {
  eosId: string;
  candidates: ProfileCandidate[];
  /**
   * True when the candidates disagree about the Player ID. Two saves of the
   * same account normally differ only by age and the newest simply wins; a
   * different Player ID means they are different characters, and which one the
   * admin wants is not something to decide for them.
   */
  needsChoice: boolean;
}

export interface GroupedProfiles {
  groups: ProfileGroup[];
  /** Files that could not be read at all, reported as-is. */
  unreadable: ProfileImportResult[];
}

/**
 * Sorts a dropped batch into one group per account.
 *
 * The EOS ID is the whole identity here: two files with the same one are the
 * same account no matter what the survivor is called, and a batch pulled out
 * of dated backup folders will routinely hold several.
 */
export function groupProfileFiles(files: ProfileFile[]): GroupedProfiles {
  const byEos = new Map<string, ProfileCandidate[]>();
  const unreadable: ProfileImportResult[] = [];

  files.forEach((file, fileIndex) => {
    const read = readProfileFile(file);
    if (!read.summary) {
      unreadable.push(read);
      return;
    }
    // A profile with no EOS id cannot be grouped with anything, so it stands
    // alone under a key that can never collide.
    const key = read.summary.eosId || `#${fileIndex}`;
    const candidate: ProfileCandidate = {
      fileIndex,
      fileName: file.fileName,
      modifiedAt: file.modifiedAt ?? 0,
      summary: read.summary,
    };
    byEos.set(key, [...(byEos.get(key) ?? []), candidate]);
  });

  const groups = [...byEos.entries()].map(([eosId, candidates]) => {
    const sorted = [...candidates].sort(
      (a, b) => b.modifiedAt - a.modifiedAt || a.fileName.localeCompare(b.fileName),
    );
    const playerIds = new Set(sorted.map((c) => c.summary.playerDataId));
    return {
      eosId: eosId.startsWith("#") ? "" : eosId,
      candidates: sorted,
      needsChoice: playerIds.size > 1,
    };
  });

  return { groups, unreadable };
}

/**
 * The file to import for each group: the admin's pick where they made one,
 * otherwise the newest.
 */
export function chooseProfileFiles(
  files: ProfileFile[],
  groups: ProfileGroup[],
  picks: Record<string, number> = {},
): { chosen: ProfileFile[]; superseded: ProfileCandidate[] } {
  const chosen: ProfileFile[] = [];
  const superseded: ProfileCandidate[] = [];
  for (const group of groups) {
    const key = group.eosId || group.candidates[0]?.fileName;
    const pickedIndex = picks[key];
    const picked =
      group.candidates.find((c) => c.fileIndex === pickedIndex) ?? group.candidates[0];
    if (!picked) continue;
    chosen.push(files[picked.fileIndex]);
    superseded.push(...group.candidates.filter((c) => c !== picked));
  }
  return { chosen, superseded };
}

/**
 * Finds the roster entry a profile belongs to.
 *
 * The EOS id is the only identifier the game guarantees is stable and unique,
 * so it wins outright. The others are fallbacks for rosters filled in by hand
 * before any profile was imported - a survivor name in particular is only a
 * hint, since two players can pick the same one.
 */
export function matchPlayer(
  players: Player[],
  summary: ProfileSummary,
): { player: Player; matchedBy: ProfileImportResult["matchedBy"] } | null {
  const eq = (a: string, b: string) =>
    a.trim().length > 0 && a.trim().toLowerCase() === b.trim().toLowerCase();

  const byEos = players.find((p) => eq(p.eosId, summary.eosId));
  if (byEos) return { player: byEos, matchedBy: "eosId" };

  /**
   * A roster entry whose EOS ID is known and different is a different account,
   * full stop - no weaker signal can override that.
   *
   * Without this the fallbacks below quietly merge unrelated players: two
   * accounts can share a Player ID (a generated profile inherits its
   * template's) and survivors are routinely called the same thing, and the
   * second file would then overwrite the first one's stored profile.
   */
  const possible = players.filter(
    (p) =>
      !(
        p.eosId.trim() &&
        summary.eosId.trim() &&
        p.eosId.trim().toLowerCase() !== summary.eosId.trim().toLowerCase()
      ),
  );

  const byPlayerId = possible.find((p) => eq(p.playerId, summary.playerDataId));
  if (byPlayerId) return { player: byPlayerId, matchedBy: "playerId" };

  const byName = possible.filter((p) => eq(p.gameName, summary.characterName));
  // An ambiguous name is no match at all - guessing between two survivors is
  // worse than making the admin say which one.
  if (byName.length === 1) return { player: byName[0], matchedBy: "characterName" };

  return null;
}

/**
 * Copies what the profile knows into blank roster fields.
 *
 * Only blanks are filled. A value the admin typed is theirs, so a disagreement
 * is reported as a conflict for them to settle rather than being overwritten -
 * an imported file is evidence, not authority.
 */
export function applySummaryToPlayer(
  player: Player,
  summary: ProfileSummary,
): { player: Player; filled: PlayerFieldKey[]; conflicts: FieldConflict[] } {
  const next = { ...player };
  const filled: PlayerFieldKey[] = [];
  const conflicts: FieldConflict[] = [];

  for (const field of FIELD_SOURCES) {
    const incoming = field.from(summary).trim();
    if (!incoming) continue;
    const existing = next[field.key].trim();
    if (!existing) {
      next[field.key] = incoming;
      filled.push(field.key);
    } else if (existing.toLowerCase() !== incoming.toLowerCase()) {
      conflicts.push({ key: field.key, label: field.label, existing, incoming });
    }
  }

  return { player: next, filled, conflicts };
}

/** The stored-profile record for a freshly imported file. */
export function storedProfileFor(
  summary: ProfileSummary,
  fileName: string,
  now = new Date(),
  generated = false,
): StoredProfile {
  return {
    fileName,
    storedAt: now.toISOString(),
    map: summary.map,
    // A newly stored file supersedes whatever is in the repo.
    backedUpAt: null,
    summary,
    generated,
    // A fresh import is current by definition, whatever the old file was.
    archivedAt: null,
  };
}

export interface ImportPlan {
  players: Player[];
  results: ProfileImportResult[];
}

/**
 * Works out what a batch of dropped files does to the roster, without touching
 * disk.
 *
 * Only the identifier fields are settled here. The stored-profile record is
 * left alone deliberately: it names a file that does not exist until the page
 * has written it, and a record pointing at a missing file is exactly the
 * "profile reference lost" state the roster already has to warn about.
 */
export function planImport(existing: Player[], files: ProfileFile[]): ImportPlan {
  let players = [...existing];
  const results: ProfileImportResult[] = [];

  for (const file of files) {
    const read = readProfileFile(file);
    if (!read.summary) {
      results.push(read);
      continue;
    }
    const summary = read.summary;

    const match = matchPlayer(players, summary);
    const target = match?.player ?? newPlayer(newId());
    const applied = applySummaryToPlayer(target, summary);

    if (match) {
      players = players.map((p) => (p.id === applied.player.id ? applied.player : p));
    } else {
      players = [...players, applied.player];
    }

    results.push({
      ...read,
      playerId: applied.player.id,
      playerName: playerLabel(applied.player),
      matchedBy: match?.matchedBy ?? "new",
      filled: applied.filled,
      conflicts: applied.conflicts,
    });
  }

  return { players, results };
}

/**
 * The name a profile is stored under inside the project's profiles/ folder.
 *
 * The EOS id leads because it is unique per account and is what the game names
 * profiles by - copying one back to a server is then a straight copy. Player
 * ID is a poor key on its own: a generated profile inherits its template's,
 * so two roster entries can carry the same one and the second would overwrite
 * the first. The roster id is the last resort for an entry with neither.
 */
export function profileStorageKey(
  player: Pick<Player, "id" | "eosId" | "playerId">,
  summary?: ProfileSummary | null,
): string {
  return (
    summary?.eosId.trim() ||
    player.eosId.trim() ||
    player.playerId.trim() ||
    player.id
  );
}

/** Files that are not profiles at all, so the page can say so up front. */
export function isProfileFileName(name: string): boolean {
  return name.toLowerCase().endsWith(".arkprofile");
}

/**
 * Profile bytes cross the Tauri boundary as base64. Chunked because spreading
 * a whole profile into `String.fromCharCode` overflows the call stack.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
