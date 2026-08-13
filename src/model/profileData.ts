import { z } from "zod";
import {
  ArkProfile,
  ArkProperty,
  cloneProfile,
  findAll,
  findPath,
  findProp,
  hex,
  readArrayCount,
  readByte,
  readFloat,
  readInt,
  readString,
  readUint16,
  readUint32Array,
  readUint64,
  writeByte,
  writeFloat,
  writeInt,
  writeString,
  writeUint16,
  writeUint64,
} from "../serializers/arkprofile";

/**
 * The admin-facing view of a `.arkprofile`: the handful of fields that identify
 * a survivor and describe their progression, lifted out of the property tree.
 *
 * Reading is safe on any profile. Writing is not a solved problem — see
 * `applyProfileEdits`, which is deliberately narrow about what it will touch.
 */

// ---------------------------------------------------------------------------
// Where things live in the tree
// ---------------------------------------------------------------------------

const DATA = ["MyData"];
const CONFIG = ["MyData", "MyPlayerCharacterConfig"];
const STATS = ["MyData", "MyPersistentCharacterStats"];

/**
 * ARK's character stat order. The game stores allocated points as repeated
 * `ByteProperty` entries carrying this index, and omits any stat still at zero
 * — so the index is the identity of the stat, never its position in a list.
 */
export const PROFILE_STATS = [
  { index: 0, label: "Health" },
  { index: 1, label: "Stamina" },
  { index: 2, label: "Torpidity" },
  { index: 3, label: "Oxygen" },
  { index: 4, label: "Food" },
  { index: 5, label: "Water" },
  { index: 6, label: "Temperature" },
  { index: 7, label: "Weight" },
  { index: 8, label: "Melee Damage" },
  { index: 9, label: "Movement Speed" },
  { index: 10, label: "Fortitude" },
  { index: 11, label: "Crafting Speed" },
] as const;

const LEVEL_POINTS_PROP = "CharacterStatusComponent_NumberOfLevelUpPointsApplied";
const NOTES_PROP = "PerMapExplorerNoteUnlocks";
const SKILL_TREES_PROP = "MilestoneLevelsAndIndexes";
const COMPLETED_MILESTONES_PROP = "CompletedMilestones";
const CURRENT_MILESTONES_PROP = "CurrentMilestones";

/**
 * Ascension has not appeared in any profile inspected so far — not as an empty
 * field, but absent entirely, which this format also does for any value still
 * at its default. So the property's real name is unknown, and inventing one
 * would produce a file the server has no reason to accept.
 *
 * Rather than guess, every candidate spelling is looked for on import. The
 * moment a profile from a character who has actually ascended turns up, the
 * field appears in the summary and the editor with no code change; until then
 * the UI says plainly that it has nothing to write to.
 */
const ASCENSION_CANDIDATES = [
  "AscensionLevel",
  "AscendedLevel",
  "PlayerState_AscensionLevel",
  "CharacterStatusComponent_AscensionLevel",
  "AscensionData",
];

/**
 * ASA map package names to the names used on the Maps setting. Derived from the
 * level name the profile records, which is the only statement of origin a
 * profile carries — and a profile is per-map, so it matters.
 */
const MAP_PACKAGES: [packageName: string, mapName: string][] = [
  ["TheIsland_WP", "The Island"],
  ["TheCenter_WP", "The Center"],
  ["ScorchedEarth_WP", "Scorched Earth"],
  ["Ragnarok_WP", "Ragnarok"],
  ["Aberration_WP", "Aberration"],
  ["Extinction_WP", "Extinction"],
  ["Valguero_WP", "Valguero"],
  ["Genesis_WP", "Genesis: Part 1"],
  ["CrystalIsles_WP", "Crystal Isles"],
  ["Gen2_WP", "Genesis: Part 2"],
  ["LostIsland_WP", "Lost Island"],
  ["Fjordur_WP", "Fjordur"],
  ["Astraeos_WP", "Astraeos"],
  ["Svartalfheim_WP", "Svartalfheim"],
  ["ClubArk_WP", "Club ARK"],
  ["LostColony_WP", "Lost Colony"],
];

/** The map name for a package like `ScorchedEarth_WP`, or "" if unrecognised. */
export function mapFromPackage(packageName: string): string {
  const key = packageName.trim().toLowerCase();
  return MAP_PACKAGES.find(([pkg]) => pkg.toLowerCase() === key)?.[1] ?? "";
}

/** The package name for a map, for retargeting a generated profile. */
export function packageForMap(map: string): string {
  const key = map.trim().toLowerCase();
  return MAP_PACKAGES.find(([, name]) => name.toLowerCase() === key)?.[0] ?? "";
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export const ProfileStatPointsSchema = z.object({
  index: z.number().default(0),
  label: z.string().default(""),
  points: z.number().default(0),
});
export type ProfileStatPoints = z.infer<typeof ProfileStatPointsSchema>;

/**
 * One entry of `MilestoneLevelsAndIndexes` — the skill tree. Each tree the map
 * offers ("Global", plus one named after the map) carries an IntPoint whose two
 * halves the game calls Level and Index. What they mean exactly is not
 * documented, so they are carried through as the two numbers they are rather
 * than dressed up as something they might not be.
 */
export const ProfileSkillTreeSchema = z.object({
  name: z.string().default(""),
  level: z.number().default(0),
  index: z.number().default(0),
});
export type ProfileSkillTree = z.infer<typeof ProfileSkillTreeSchema>;

/**
 * Every field defaults, because this is stored alongside the roster: a summary
 * written by an older version of the app must never fail to load and take the
 * player record down with it.
 */
export const ProfileSummarySchema = z.object({
  /** EOS product user id as lowercase hex — also the file's proper name. */
  eosId: z.string().default(""),
  /** Identity provider the id belongs to, e.g. "RedpointEOS". */
  platform: z.string().default(""),
  /** Account name, which is not the survivor's name. */
  accountName: z.string().default(""),
  /** In-game survivor name. */
  characterName: z.string().default(""),
  /** The number `ListPlayers` reports, as a string — it is a uint64. */
  playerDataId: z.string().default(""),
  tribeId: z.string().default(""),
  /** Friendly map name, empty when the package name is not recognised. */
  map: z.string().default(""),
  /** Level package the save came from, e.g. `ScorchedEarth_WP`. */
  mapPackage: z.string().default(""),
  /** Displayed level: the stored "extra" level plus the starting one. */
  level: z.number().default(1),
  extraLevel: z.number().default(0),
  highestLevel: z.number().default(1),
  experience: z.number().default(0),
  engramPoints: z.number().default(0),
  engramsLearned: z.number().default(0),
  explorerNotes: z.number().default(0),
  /** Words in the note bitmask — 32 bits each, so the ceiling for a note count. */
  noteCapacity: z.number().default(0),
  deaths: z.number().default(0),
  statPoints: z.array(ProfileStatPointsSchema).default([]),
  /** Total allocated points — should equal `extraLevel` at the default rate. */
  spentPoints: z.number().default(0),
  /** Persistent buffs still applied at logout, by blueprint name. */
  activeBuffs: z.array(z.string()).default([]),
  /** Save format version — 5, or 7 for the Unreal 5.5 maps. */
  saveVersion: z.number().default(5),
  /** Skill tree progress per tree. Empty on maps that have no skill tree. */
  skillTrees: z.array(ProfileSkillTreeSchema).default([]),
  completedMilestones: z.number().default(0),
  currentMilestones: z.number().default(0),
  /**
   * Ascension count, or null when the profile carries no such field — which
   * so far is every profile seen. Null means "unknown", not "zero".
   */
  ascension: z.number().nullable().default(null),
  /** The property ascension was found under, once one ever turns up. */
  ascensionProp: z.string().default(""),
});
export type ProfileSummary = z.infer<typeof ProfileSummarySchema>;

/** The player data object — the one every profile leads with. */
export function playerObject(profile: ArkProfile) {
  return (
    profile.objects.find((o) => o.className.includes("PrimalPlayerDataBP")) ??
    profile.objects[0]
  );
}

function statPointsOf(profile: ArkProfile): ProfileStatPoints[] {
  const stats = findPath(playerObject(profile).properties, STATS);
  const applied = findAll(stats?.children, LEVEL_POINTS_PROP);
  return PROFILE_STATS.map((stat) => ({
    index: stat.index,
    label: stat.label,
    points: readByte(applied.find((p) => p.index === stat.index)) ?? 0,
  }));
}

/**
 * Skill tree state. Each element of `MilestoneLevelsAndIndexes` is a struct of
 * a tree name and an IntPoint, which is packed binary — two int32s.
 */
function skillTreesOf(profile: ArkProfile): ProfileSkillTree[] {
  const stats = findPath(playerObject(profile).properties, STATS);
  const trees = findProp(stats?.children, SKILL_TREES_PROP);
  return (trees?.items ?? []).map((item) => {
    const point = findProp(item, "LevelAndIndex")?.data;
    const view =
      point && point.length >= 8
        ? new DataView(point.buffer, point.byteOffset, point.length)
        : null;
    return {
      name: readString(findProp(item, "Name")) ?? "",
      level: view?.getInt32(0, true) ?? 0,
      index: view?.getInt32(4, true) ?? 0,
    };
  });
}

/** Depth-first search for a property by name, used for fields we cannot place. */
function findAnywhere(props: ArkProperty[], name: string): ArkProperty | undefined {
  for (const prop of props) {
    if (prop.name === name) return prop;
    const nested = prop.children && findAnywhere(prop.children, name);
    if (nested) return nested;
  }
  return undefined;
}

function ascensionOf(profile: ArkProfile): { value: number | null; prop: string } {
  for (const candidate of ASCENSION_CANDIDATES) {
    const hit = findAnywhere(playerObject(profile).properties, candidate);
    if (!hit) continue;
    const value =
      hit.type === "ByteProperty"
        ? readByte(hit)
        : hit.type === "UInt16Property"
          ? readUint16(hit)
          : readInt(hit);
    return { value: value ?? 0, prop: candidate };
  }
  return { value: null, prop: "" };
}

/**
 * Persistent buffs the survivor logged out with.
 *
 * Version 5 named the buff in the object's own class path. Version 7 gives
 * every one of them the same generic class and puts the real identity in a
 * `ForPrimalBuffClassString` property, so that is preferred where it exists —
 * otherwise a Lost Colony profile reads as four buffs all called
 * "PrimalBuffPersistentData".
 */
function activeBuffsOf(profile: ArkProfile): string[] {
  const names = profile.objects
    .filter((o) => o.className.includes("PrimalBuffPersistentData"))
    .map((o) => {
      const declared = readString(findProp(o.properties, "ForPrimalBuffClassString"));
      const path = declared || o.className;
      const leaf = path.split(/[./]/).pop() ?? "";
      // Trim the boilerplate every buff blueprint carries, so the list reads
      // as "Heatstroke" rather than "Buff_Base_Persistent_Heatstroke".
      return leaf
        .replace(/_C$/, "")
        .replace(/^PrimalBuffPersistentData_?/, "")
        .replace(/^Buff_Base_Persistent_/, "")
        .replace(/^Buff_?/, "");
    })
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * The IP the account last connected from.
 *
 * Read on demand and never stored. It used to sit in `ProfileSummary`, which is
 * kept alongside the roster — so it travelled into `players.json` and, once the
 * roster started synchronizing, into a repository's permanent history. It is
 * personal data with no operational use beyond the moment an administrator is
 * looking at an imported file, so that is the only place it now exists.
 */
export function readNetworkAddress(profile: ArkProfile): string {
  return (
    readString(findPath(playerObject(profile).properties, [...DATA, "SavedNetworkAddress"])) ??
    ""
  );
}

export function readProfileSummary(profile: ArkProfile): ProfileSummary {
  const object = playerObject(profile);
  const props = object.properties;
  const stats = findPath(props, STATS);
  const uniqueId = findPath(props, [...DATA, "UniqueID"]);

  // The net id struct is packed binary: a marker byte, the platform name as an
  // FString, a length byte, then the id itself. Taking the id from the end
  // rather than a fixed offset keeps this working whatever the platform is.
  const idBytes = uniqueId?.data?.slice(-16);
  const platform = uniqueId?.data
    ? (readString({ name: "", type: "StrProperty", index: 0, data: uniqueId.data.slice(1) }) ?? "")
    : "";

  const extraLevel = readUint16(findProp(stats?.children, "CharacterStatusComponent_ExtraCharacterLevel")) ?? 0;
  const statPoints = statPointsOf(profile);
  const ascension = ascensionOf(profile);
  const noteWords = readUint32Array(findProp(stats?.children, NOTES_PROP));
  // `_WP` package first, falling back to the short level name the object lists.
  const mapPackage = object.names.find((n) => /_wp$/i.test(n)) ?? "";

  return {
    eosId: idBytes && idBytes.length === 16 ? hex(idBytes) : "",
    platform,
    accountName: readString(findPath(props, [...DATA, "PlayerName"])) ?? "",
    characterName: readString(findPath(props, [...CONFIG, "PlayerCharacterName"])) ?? "",
    playerDataId: (readUint64(findPath(props, [...DATA, "PlayerDataID"])) ?? 0n).toString(),
    tribeId: String(readInt(findPath(props, [...DATA, "TribeID"])) ?? 0),
    map: mapFromPackage(mapPackage),
    mapPackage,
    level: extraLevel + 1,
    extraLevel,
    highestLevel: (readInt(findProp(stats?.children, "CharacterStatusComponent_HighestExtraCharacterLevel")) ?? 0) + 1,
    experience: readFloat(findProp(stats?.children, "CharacterStatusComponent_ExperiencePoints")) ?? 0,
    engramPoints: readInt(findProp(stats?.children, "PlayerState_TotalEngramPoints")) ?? 0,
    engramsLearned: readArrayCount(findProp(stats?.children, "PlayerState_EngramBlueprints")),
    explorerNotes: noteWords.reduce((sum, word) => sum + popCount(word), 0),
    noteCapacity: noteWords.length,
    deaths: readFloat(findPath(props, [...DATA, "NumOfDeaths"])) ?? 0,
    statPoints,
    spentPoints: statPoints.reduce((sum, s) => sum + s.points, 0),
    activeBuffs: activeBuffsOf(profile),
    saveVersion: profile.saveVersion,
    skillTrees: skillTreesOf(profile),
    completedMilestones: readArrayCount(findProp(stats?.children, COMPLETED_MILESTONES_PROP)),
    currentMilestones: readArrayCount(findProp(stats?.children, CURRENT_MILESTONES_PROP)),
    ascension: ascension.value,
    ascensionProp: ascension.prop,
  };
}

function popCount(word: number): number {
  let n = word >>> 0;
  let count = 0;
  while (n) {
    n &= n - 1;
    count++;
  }
  return count;
}

/** The name the game expects: the account's EOS id, lowercase. */
export function profileFileNameFor(eosId: string): string {
  return `${eosId.trim().toLowerCase()}.arkprofile`;
}

/** A well-formed EOS product user id: 32 hex characters. */
export function isValidEosId(value: string): boolean {
  return /^[0-9a-f]{32}$/i.test(value.trim());
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * The fields a generated profile may set. Everything omitted is inherited from
 * the template unchanged — which is the point: the parts of this format nobody
 * has mapped out are exactly the parts worth not touching.
 */
export interface ProfileEdits {
  eosId?: string;
  accountName?: string;
  characterName?: string;
  playerDataId?: string;
  tribeId?: string;
  extraLevel?: number;
  experience?: number;
  engramPoints?: number;
  deaths?: number;
  /** Allocated points by stat index. Stats left out keep the template's value. */
  statPoints?: Record<number, number>;
  /**
   * Zero every allocated stat point, leaving the level's points unspent for
   * the player to assign in game. Applied before `statPoints`.
   */
  clearStatPoints?: boolean;
  /**
   * How many explorer notes to mark found. Approximate by nature: the game
   * stores one bit per note and nobody has mapped bits to notes, so this sets
   * the first N bits — the count comes out right, the specific notes may not.
   */
  explorerNotes?: number;
  /** Skill tree progress by tree name. Trees absent from the template are skipped. */
  skillTrees?: Record<string, { level: number; index: number }>;
  /** Ascension count. Only written if the template carries such a property. */
  ascension?: number;
  /** Retarget the save to another map, e.g. moving a template to Aberration. */
  mapPackage?: string;
  /** Blank the recorded IP — it is stale for a generated profile, and personal. */
  clearNetworkAddress?: boolean;
}

export interface ProfileChange {
  field: string;
  from: string;
  to: string;
}

export interface ProfileEditResult {
  profile: ArkProfile;
  changes: ProfileChange[];
  /** Fields that were asked for but had nowhere to go in this template. */
  skipped: string[];
}

/**
 * Applies edits to a copy of `template`, reporting exactly what changed.
 *
 * Only properties that already exist are written. A missing property means the
 * template does not carry that field, and inventing one would mean guessing at
 * a byte layout the game has to accept — so it is reported as skipped instead,
 * and the admin can pick a template that has it.
 */
export function applyProfileEdits(
  template: ArkProfile,
  edits: ProfileEdits,
): ProfileEditResult {
  const profile = cloneProfile(template);
  const object = playerObject(profile);
  const props = object.properties;
  const changes: ProfileChange[] = [];
  const skipped: string[] = [];

  /** Runs `write` against a property, or records the field as unavailable. */
  function set<T>(
    field: string,
    prop: ArkProperty | undefined,
    read: (p: ArkProperty) => T,
    write: (p: ArkProperty) => void,
    format: (v: T) => string = String,
  ) {
    if (!prop) {
      skipped.push(field);
      return;
    }
    const before = read(prop);
    write(prop);
    const after = read(prop);
    if (format(before) !== format(after)) {
      changes.push({ field, from: format(before), to: format(after) });
    }
  }

  if (edits.eosId !== undefined) {
    const uniqueId = findPath(props, [...DATA, "UniqueID"]);
    const bytes = uniqueId?.data;
    const next = hexToBytes(edits.eosId);
    if (!bytes || bytes.length < 16 || next.length !== 16) {
      skipped.push("EOS ID");
    } else {
      const before = hex(bytes.slice(-16));
      // In place, at the tail: the length byte in front of it still says 16, so
      // nothing about the struct's shape changes.
      const data = Uint8Array.from(bytes);
      data.set(next, data.length - 16);
      uniqueId.data = data;
      if (before !== hex(next)) {
        changes.push({ field: "EOS ID", from: before, to: hex(next) });
      }
    }
  }

  if (edits.accountName !== undefined) {
    set(
      "Account name",
      findPath(props, [...DATA, "PlayerName"]),
      (p) => readString(p) ?? "",
      (p) => writeString(p, edits.accountName!),
    );
  }

  if (edits.characterName !== undefined) {
    set(
      "Character name",
      findPath(props, [...CONFIG, "PlayerCharacterName"]),
      (p) => readString(p) ?? "",
      (p) => writeString(p, edits.characterName!),
    );
  }

  if (edits.playerDataId !== undefined) {
    const value = toBigInt(edits.playerDataId);
    set(
      "Player ID",
      findPath(props, [...DATA, "PlayerDataID"]),
      (p) => (readUint64(p) ?? 0n).toString(),
      (p) => writeUint64(p, value),
    );
  }

  if (edits.tribeId !== undefined) {
    const value = Number(edits.tribeId) || 0;
    set(
      "Tribe ID",
      findPath(props, [...DATA, "TribeID"]),
      (p) => String(readInt(p) ?? 0),
      (p) => writeInt(p, value),
    );
  }

  if (edits.clearNetworkAddress) {
    set(
      "Last known IP",
      findPath(props, [...DATA, "SavedNetworkAddress"]),
      (p) => readString(p) ?? "",
      (p) => writeString(p, ""),
    );
  }

  const stats = findPath(props, STATS);

  if (edits.extraLevel !== undefined) {
    const level = clamp(edits.extraLevel, 0, 65535);
    set(
      "Level",
      findProp(stats?.children, "CharacterStatusComponent_ExtraCharacterLevel"),
      (p) => String((readUint16(p) ?? 0) + 1),
      (p) => writeUint16(p, level),
    );
    // The game treats a level above the recorded high-water mark as a downlevel
    // and can claw points back, so it moves with the level.
    set(
      "Highest level",
      findProp(stats?.children, "CharacterStatusComponent_HighestExtraCharacterLevel"),
      (p) => String((readInt(p) ?? 0) + 1),
      (p) => writeInt(p, Math.max(level, readInt(p) ?? 0)),
    );
  }

  if (edits.experience !== undefined) {
    set(
      "Experience",
      findProp(stats?.children, "CharacterStatusComponent_ExperiencePoints"),
      (p) => (readFloat(p) ?? 0).toFixed(1),
      (p) => writeFloat(p, edits.experience!),
    );
  }

  if (edits.engramPoints !== undefined) {
    set(
      "Engram points",
      findProp(stats?.children, "PlayerState_TotalEngramPoints"),
      (p) => String(readInt(p) ?? 0),
      (p) => writeInt(p, edits.engramPoints!),
    );
  }

  if (edits.deaths !== undefined) {
    set(
      "Deaths",
      findPath(props, [...DATA, "NumOfDeaths"]),
      (p) => String(readFloat(p) ?? 0),
      (p) => writeFloat(p, edits.deaths!),
    );
  }

  if (edits.clearStatPoints) {
    for (const applied of findAll(stats?.children, LEVEL_POINTS_PROP)) {
      const label =
        PROFILE_STATS.find((s) => s.index === applied.index)?.label ??
        `Stat ${applied.index}`;
      set(
        `${label} points`,
        applied,
        (p) => String(readByte(p) ?? 0),
        (p) => writeByte(p, 0),
      );
    }
  }

  if (edits.explorerNotes !== undefined) {
    const notes = findProp(stats?.children, NOTES_PROP);
    if (!notes?.data) skipped.push("Explorer notes");
    else {
      const before = readUint32Array(notes).reduce((sum, w) => sum + popCount(w), 0);
      const words = readUint32Array(notes);
      const wanted = clamp(edits.explorerNotes, 0, words.length * 32);
      const next = words.map((_, i) => {
        const from = i * 32;
        const bits = clamp(wanted - from, 0, 32);
        // `<<` is defined mod 32 in JS, so a full word needs saying explicitly.
        return bits === 0 ? 0 : bits >= 32 ? 0xffffffff : (1 << bits) - 1;
      });
      const data = new Uint8Array(4 + next.length * 4);
      const view = new DataView(data.buffer);
      view.setInt32(0, next.length, true);
      next.forEach((word, i) => view.setUint32(4 + i * 4, word >>> 0, true));
      notes.data = data;
      if (before !== wanted) {
        changes.push({ field: "Explorer notes", from: String(before), to: String(wanted) });
      }
    }
  }

  if (edits.skillTrees) {
    const trees = findProp(stats?.children, SKILL_TREES_PROP);
    for (const [name, value] of Object.entries(edits.skillTrees)) {
      const item = trees?.items?.find((it) => readString(findProp(it, "Name")) === name);
      const point = item && findProp(item, "LevelAndIndex");
      if (!point?.data || point.data.length < 8) {
        skipped.push(`${name} skill tree`);
        continue;
      }
      const data = Uint8Array.from(point.data);
      const view = new DataView(data.buffer);
      const from = `${view.getInt32(0, true)}/${view.getInt32(4, true)}`;
      view.setInt32(0, Math.max(0, Math.round(value.level)), true);
      view.setInt32(4, Math.max(0, Math.round(value.index)), true);
      point.data = data;
      const to = `${view.getInt32(0, true)}/${view.getInt32(4, true)}`;
      if (from !== to) changes.push({ field: `${name} skill tree`, from, to });
    }
  }

  if (edits.ascension !== undefined) {
    const existing = ASCENSION_CANDIDATES.map((name) => findAnywhere(props, name)).find(
      Boolean,
    );
    // Never invented: without a profile that carries the field, its name, type
    // and home in the tree are all guesses, and a wrong guess is a save the
    // server rejects.
    set(
      "Ascension",
      existing,
      (p) => String(readInt(p) ?? readByte(p) ?? 0),
      (p) => {
        if (p.type === "ByteProperty") writeByte(p, edits.ascension!);
        else if (p.type === "UInt16Property") writeUint16(p, edits.ascension!);
        else writeInt(p, edits.ascension!);
      },
    );
  }

  if (edits.statPoints) {
    for (const [key, points] of Object.entries(edits.statPoints)) {
      const index = Number(key);
      const label = PROFILE_STATS.find((s) => s.index === index)?.label ?? `Stat ${index}`;
      const existing = findAll(stats?.children, LEVEL_POINTS_PROP).find(
        (p) => p.index === index,
      );
      if (existing) {
        set(
          `${label} points`,
          existing,
          (p) => String(readByte(p) ?? 0),
          (p) => writeByte(p, clamp(points, 0, 255)),
        );
      } else if (points > 0 && stats?.children) {
        // The game omits stats sitting at zero, so allocating into one that the
        // template never touched means adding the property. Its shape is cloned
        // wholesale from a sibling — the two save versions tag a property quite
        // differently, and copying the real thing sidesteps knowing which.
        const sibling = findAll(stats.children, LEVEL_POINTS_PROP)[0];
        if (!sibling) {
          skipped.push(`${label} points`);
          continue;
        }
        const added: ArkProperty = {
          ...sibling,
          typeParams: sibling.typeParams,
          index,
          data: new Uint8Array([clamp(points, 0, 255)]),
        };
        insertAfterLast(stats.children, LEVEL_POINTS_PROP, added);
        changes.push({ field: `${label} points`, from: "0", to: String(points) });
      }
    }
  }

  if (edits.mapPackage) {
    const target = edits.mapPackage.trim();
    const before = object.names.find((n) => /_wp$/i.test(n));
    if (!before) {
      skipped.push("Map");
    } else if (before !== target) {
      // Two places name the level: the short package name and its full path.
      object.names = object.names.map((name) =>
        name === before
          ? target
          : name.includes(before)
            ? name.replace(new RegExp(escapeRegExp(before), "g"), target)
            : name,
      );
      changes.push({ field: "Map", from: before, to: target });
    }
  }

  return { profile, changes, skipped };
}

/** Keeps repeated properties together, which is how the game writes them. */
function insertAfterLast(props: ArkProperty[], name: string, added: ArkProperty) {
  let at = -1;
  props.forEach((p, i) => {
    if (p.name === name) at = i;
  });
  if (at === -1) props.push(added);
  else props.splice(at + 1, 0, added);
}

function hexToBytes(value: string): Uint8Array {
  const clean = value.trim().replace(/[^0-9a-fA-F]/g, "");
  if (clean.length % 2 !== 0) return new Uint8Array(0);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBigInt(value: string): bigint {
  try {
    const n = BigInt(value.trim() || "0");
    return n < 0n ? 0n : n;
  } catch {
    return 0n;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
