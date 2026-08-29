/** Ark console spawn-command generation for catalog entries. */

import { tierIndex } from "../model/arkTraits";

/** Class reference from a blueprint path: last dot segment with a `_C` suffix. */
export function classNameOf(bpPath: string): string {
  const last = bpPath.split(".").pop() ?? bpPath;
  return /_C$/.test(last) ? last : `${last}_C`;
}

/** Short class name (no _C) - e.g. `Achatina_Character_BP`. */
export function shortClassName(bpPath: string): string {
  return (bpPath.split(".").pop() ?? bpPath).replace(/_C$/, "");
}

/** Blueprint path without any trailing `_C` (GiveItem/SpawnDino want the object path). */
function objectPath(bpPath: string): string {
  return bpPath.replace(/_C$/, "");
}

export interface SpawnCommand {
  label: string;
  hint: string;
  command: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// Structured spawn arguments
// ---------------------------------------------------------------------------

/**
 * Which identifier `-p=` carries. Dino Depot accepts either the in-game Player
 * ID or the account's EOS ID, and they are not interchangeable - sending one
 * where the other is expected silently delivers the creature to nobody.
 */
export type PlayerIdKind = "playerId" | "eosId";

export const PLAYER_ID_KIND_LABELS: Record<PlayerIdKind, string> = {
  playerId: "Player ID",
  eosId: "EOS ID",
};

/**
 * The nine stats `-s=` carries, in the order the argument expects. Order is
 * the whole contract here: the argument is positional, so this array is the
 * single source of truth for both the editor and the generated command.
 */
export const SPAWN_STATS = [
  { key: "health", label: "Health", short: "Hp" },
  { key: "stamina", label: "Stamina", short: "St" },
  { key: "oxygen", label: "Oxygen", short: "Ox" },
  { key: "food", label: "Food", short: "Fo" },
  { key: "water", label: "Water", short: "Wa" },
  { key: "weight", label: "Weight", short: "We" },
  { key: "melee", label: "Melee damage", short: "Me" },
  { key: "speed", label: "Movement speed", short: "Sp" },
  { key: "craft", label: "Crafting skill", short: "Cr" },
] as const;

export type SpawnStatKey = (typeof SPAWN_STATS)[number]["key"];

/** Points assigned per stat. A stat the admin never touched is simply absent. */
export type StatPoints = Partial<Record<SpawnStatKey, number>>;

export interface ColorAssignment {
  /** 0–5. */
  region: number;
  /** Palette id from model/arkColors. */
  colorId: number;
}

export interface TraitAssignment {
  /** Local row id - traits are not unique, so the token cannot be the key. */
  id: string;
  token: string;
  /** 1, 2 or 3; written into the command as [0], [1], [2]. */
  tier: 1 | 2 | 3;
}

export interface CreatureSpawnParams {
  level: number;
  tamed: boolean;
  /** Dino Depot SpawnDinoInBall parameters */
  playerId: string;
  /** Which identifier `playerId` holds. */
  playerIdKind: PlayerIdKind;
  dinoName: string;
  female: boolean;
  imprint: number; // 0..1
  age: number; // 0..1
  neutered: boolean;
  /** Stat points for `-s=`; empty means "use the level instead". */
  stats: StatPoints;
  /** Colour-region assignments for `-r=`. */
  colors: ColorAssignment[];
  /** Traits for `-g=`. */
  traits: TraitAssignment[];
}

export const DEFAULT_CREATURE_PARAMS: CreatureSpawnParams = {
  level: 150,
  tamed: true,
  playerId: "",
  playerIdKind: "playerId",
  dinoName: "",
  female: false,
  imprint: 1,
  age: 1,
  neutered: false,
  stats: {},
  colors: [],
  traits: [],
};

/** True once any stat carries points - `-s=` replaces `-l=`, so this decides. */
export function hasStatPoints(stats: StatPoints): boolean {
  return SPAWN_STATS.some((s) => (stats[s.key] ?? 0) > 0);
}

/** The nine positional values of `-s=`, e.g. `67,67,64,53,0,66,57,0,0`. */
export function serializeStats(stats: StatPoints): string {
  return SPAWN_STATS.map((s) => Math.max(0, Math.round(stats[s.key] ?? 0))).join(",");
}

/**
 * The six positional values of `-r=`. Regions the admin left alone are 0,
 * which the game reads as "leave this region as it rolled".
 */
export function serializeColors(colors: ColorAssignment[]): string {
  const slots = [0, 0, 0, 0, 0, 0];
  for (const { region, colorId } of colors) {
    if (region >= 0 && region < slots.length) slots[region] = colorId;
  }
  return slots.join(",");
}

/** `-g=` payload, e.g. `aggressive[0],angry[1],swimmer[2]`. */
export function serializeTraits(traits: TraitAssignment[]): string {
  return traits
    .filter((t) => t.token.trim())
    .map((t) => `${t.token.trim()}[${tierIndex(t.tier)}]`)
    .join(",");
}

export function buildCreatureCommands(
  bpPath: string,
  p: CreatureSpawnParams,
): SpawnCommand[] {
  const cls = classNameOf(bpPath);
  const path = objectPath(bpPath);

  const useStats = hasStatPoints(p.stats);
  // Only regions that were actually assigned something count as "set" -
  // an all-zero -r= would be six explicit no-ops taking up console budget.
  const usedColors = p.colors.filter((c) => c.colorId > 0);
  const traits = serializeTraits(p.traits);

  const ballParts = [
    "admincheat scriptcommand SpawnDinoInBall",
    `-p=${p.playerId || `<${PLAYER_ID_KIND_LABELS[p.playerIdKind]}>`}`,
    `-t=${path}`,
  ];
  if (p.dinoName.trim()) ballParts.push(`-n=${p.dinoName.trim()}`);
  if (!useStats) ballParts.push(`-l=${p.level}`);
  ballParts.push(`-f=${p.female ? 1 : 0}`, `-i=${p.imprint}`, `-a=${p.age}`);
  if (p.neutered) ballParts.push("-b=true");
  if (useStats) ballParts.push(`-s=${serializeStats(p.stats)}`);
  if (usedColors.length > 0) ballParts.push(`-r=${serializeColors(usedColors)}`);
  if (traits) ballParts.push(`-g=${traits}`);
  const ballCommand = ballParts.join(" ");

  const commands: SpawnCommand[] = [
    {
      label: "Dino Depot - Spawn in ball",
      hint: "Gives the creature to a player as a captured ball (Dino Depot scriptcommand)",
      command: ballCommand,
      warning: !p.playerId
        ? `Set the ${PLAYER_ID_KIND_LABELS[p.playerIdKind]} - the command needs -p=`
        : ballCommand.length > 290
          ? `Command is ${ballCommand.length} chars - over the 290 console limit`
          : undefined,
    },
    {
      label: p.tamed ? "GMSummon (tamed)" : "Summon (wild, at crosshair)",
      hint: p.tamed
        ? // GMSummon's level excludes the taming bonus, so the creature that
          // lands is higher than the number typed. Saying "level N" here sent
          // admins looking for a bug in the command.
          `Tamed, at your crosshair - level is before the taming bonus, so ${p.level} arrives around ${Math.round(p.level * 1.5)}`
        : "Spawns a wild creature at your crosshair (level from map rules)",
      command: p.tamed
        ? `admincheat GMSummon "${cls}" ${p.level}`
        : `admincheat Summon ${cls}`,
    },
    {
      label: "SpawnDino (wild, exact level)",
      hint: `Wild level ${p.level}, 500 units in front of you`,
      command: `admincheat SpawnDino "Blueprint'${path}'" 500 0 0 ${p.level}`,
    },
    {
      label: p.tamed
        ? "SDF (tamed, exact level)"
        : "SDF (wild, exact level)",
      hint:
        `Matches on part of the class name - ${p.tamed ? "tamed" : "wild"} at exactly level ${p.level}` +
        (p.tamed
          ? `, no taming bonus (drop the last argument to 0 for ${Math.round(p.level * 1.5)})`
          : ""),
      // The last two arguments are ASA-only:
      //   bLoadIfUnloaded=1 - ASA does not keep creature data in memory unless
      //     that creature already exists in the world, so without it the
      //     command silently does nothing for anything not already nearby.
      //   bSkipAddingTamedLevels - 1 spawns at exactly the level given; 0 adds
      //     the perfect-tame bonus, turning 150 into 225. Exact is what every
      //     other command in this modal does, so it is what the level field is
      //     taken to mean here too. Irrelevant when wild; retained examples
      //     wild example passes 0.
      command: `admincheat SDF ${shortClassName(bpPath)} ${p.tamed ? 1 : 0} ${p.level} 1 ${p.tamed ? 1 : 0}`,
    },
  ];
  return commands;
}

export interface ItemSpawnParams {
  quantity: number;
  quality: number;
  asBlueprint: boolean;
}

export const DEFAULT_ITEM_PARAMS: ItemSpawnParams = {
  quantity: 1,
  quality: 0,
  asBlueprint: false,
};

export function buildItemCommands(
  bpPath: string,
  p: ItemSpawnParams,
): SpawnCommand[] {
  const path = objectPath(bpPath);
  return [
    {
      label: "GiveItem (to yourself)",
      hint: `${p.quantity}× quality ${p.quality}${p.asBlueprint ? " as blueprint" : ""}`,
      command: `admincheat GiveItem "Blueprint'${path}'" ${p.quantity} ${p.quality} ${p.asBlueprint ? 1 : 0}`,
    },
    {
      label: "GiveItemToPlayer",
      hint: "Same, but to a specific player - replace <PlayerID>",
      command: `admincheat GiveItemToPlayer <PlayerID> "Blueprint'${path}'" ${p.quantity} ${p.quality} ${p.asBlueprint ? 1 : 0}`,
    },
  ];
}
