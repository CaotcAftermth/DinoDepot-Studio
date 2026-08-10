import { z } from "zod";
import { PlayerDataSettingsSchema } from "./playerData";
import { ModpackRegistrySchema, defaultModpackRegistry } from "./modpack";

export const GithubOutputPathsSchema = z.object({
  production: z.string(),
  remaps: z.string(),
  cosmetics: z.string(),
  /** Data file consumed by the public cluster viewer page. */
  viewerData: z.string().default("dinodepot/viewer-data.json"),
  /** The viewer page itself — serve via GitHub Pages (e.g. /docs folder). */
  viewerPage: z.string().default("docs/index.html"),
  /** Player roster JSON. */
  players: z.string().default("dinodepot/players.json"),
  /**
   * Folder the stored .arkprofile files are backed up to, one per player.
   * Not an OutputFamily — these are binaries published individually.
   */
  profiles: z.string().default("dinodepot/profiles"),
});

export const GithubConfigSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  branch: z.string(),
  paths: GithubOutputPathsSchema,
});

export const ProjectDefaultsSchema = z.object({
  intervalSeconds: z.number().positive(),
  chanceToProduce: z.number().min(0).max(1),
  quantityPerDino: z.number().min(0),
  maxQuantityPerCycle: z.number().min(0),
  maxQuantityInTerminal: z.number().min(0),
});

export const SimulatorDefaultsSchema = z.object({
  defaultHours: z.number().positive(),
  defaultCreatureCount: z.number().positive(),
  /** Items/hour above which the simulator flags output as excessive. */
  highOutputPerHour: z.number().positive(),
  /** Items/hour below which the simulator flags output as weak. */
  lowOutputPerHour: z.number().min(0),
});

/**
 * One entry in the cluster's map list. Drives the Content Sources map
 * assignment, so adding a map here is all it takes to use it there.
 */
export const MapEntrySchema = z.object({
  name: z.string().min(1),
  icon: z.string().default("🗺️"),
  /** Text color for the map label. Empty = the default muted grey. */
  color: z.string().default(""),
  /**
   * Whether the cluster actually runs this map.
   *
   * Disabling never hides content: a creature or item first seen on a disabled
   * map is often obtainable elsewhere anyway — Scorched Earth wyverns also
   * spawn on Ragnarok — so it stays fully available and picks up a Caution
   * marker instead, because it *might* genuinely be unobtainable here.
   *
   * Defaults to true so existing projects keep every map they already had.
   */
  enabled: z.boolean().default(true),
});
export type MapEntry = z.infer<typeof MapEntrySchema>;

/**
 * Template for the Custom Cosmetic Mod announcement. `line` is rendered once
 * per new mod and joined with newlines; header and footer are optional.
 */
export const DiscordFormatSchema = z.object({
  header: z.string().default("**🆕 New Custom Cosmetic Mods ({count})**"),
  line: z.string().default("- [{name}](<{url}>) — `{id}`{updatedSuffix}"),
  footer: z.string().default(""),
});
export type DiscordFormat = z.infer<typeof DiscordFormatSchema>;

export const ProjectSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1),
  cluster: z.string(),
  /**
   * Folder scanned (recursively) for creature/item icon images.
   * Empty = `<project folder>/images`. Subfolders `creatures/` and `items/`
   * scope matching by kind; flat files match either.
   */
  imagesDir: z.string().default(""),
  /**
   * The folder ASA installs mods into, used by Mod Discovery.
   *
   * Stored resolved (the `Mods/<gameId>` folder itself) rather than as the game
   * root, so discovery never has to re-derive it. Empty = not set up yet. Can
   * point at a dedicated server install as readily as a client one — mods are
   * downloaded server-side too, and the files discovery reads are identical.
   */
  modsDir: z.string().default(""),
  github: GithubConfigSchema,
  defaults: ProjectDefaultsSchema,
  simulator: SimulatorDefaultsSchema,
  /** Maps offered when assigning an entry's map of origin. */
  maps: z.array(MapEntrySchema).default(() => defaultMaps()),
  discord: DiscordFormatSchema.default(() => DiscordFormatSchema.parse({})),
  /**
   * Optional pages beyond the production studio: module id -> enabled.
   * Anything absent is off, so a new module never appears uninvited.
   */
  modules: z.record(z.string(), z.boolean()).default({}),
  /**
   * Player Data module policy. Edited from that page's own Settings modal
   * rather than the Settings page, since the module can be switched off.
   */
  playerData: PlayerDataSettingsSchema.default(() =>
    PlayerDataSettingsSchema.parse({}),
  ),
  /**
   * Where "+ Add mod" searches for community modpacks. Defaults to the
   * official registry; overridable so a team can review submissions on a fork
   * or a branch before they go live.
   */
  modpackRegistry: ModpackRegistrySchema.default(() => defaultModpackRegistry()),
});

export type GithubConfig = z.infer<typeof GithubConfigSchema>;
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

/**
 * The stock map list: ASA's official maps plus the two catch-alls a cluster
 * usually needs. Editable in Settings — this is only the starting point.
 */
export function defaultMaps(): MapEntry[] {
  return [
    { name: "The Island", icon: "🏝️", color: "#4ade80", enabled: true },
    { name: "The Center", icon: "🌋", color: "#4ade80", enabled: true },
    { name: "Scorched Earth", icon: "🏜️", color: "#fbbf24", enabled: true },
    { name: "Ragnarok", icon: "⚔️", color: "#38bdf8", enabled: true },
    { name: "Aberration", icon: "🍄", color: "#c084fc", enabled: true },
    { name: "Extinction", icon: "🏙️", color: "#f87171", enabled: true },
    { name: "Valguero", icon: "🗻", color: "#4ade80", enabled: true },
    { name: "Genesis: Part 1", icon: "🧬", color: "#38bdf8", enabled: true },
    { name: "Crystal Isles", icon: "💎", color: "#c084fc", enabled: true },
    { name: "Genesis: Part 2", icon: "🚀", color: "#38bdf8", enabled: true },
    { name: "Lost Island", icon: "🧭", color: "#4ade80", enabled: true },
    { name: "Fjordur", icon: "🛡️", color: "#38bdf8", enabled: true },
    { name: "Astraeos", icon: "🌌", color: "#c084fc", enabled: true },
    { name: "Lost Colony", icon: "❄️", color: "#38bdf8", enabled: true },
    { name: "Svartalfheim", icon: "⛏️", color: "#9ca3af", enabled: true },
    { name: "Club ARK", icon: "🎪", color: "#fbbf24", enabled: true },
    { name: "Event", icon: "🎉", color: "#f87171", enabled: true },
  ];
}

export function defaultProjectSettings(name: string, cluster: string): ProjectSettings {
  return {
    schemaVersion: 1,
    name,
    cluster,
    imagesDir: "",
    modsDir: "",
    github: {
      owner: "",
      repo: "",
      branch: "main",
      paths: {
        production: "dinodepot/passive-production.json",
        remaps: "dinodepot/creature-remaps.json",
        cosmetics: "dinodepot/custom-cosmetics.txt",
        viewerData: "dinodepot/viewer-data.json",
        viewerPage: "docs/index.html",
        players: "dinodepot/players.json",
        profiles: "dinodepot/profiles",
      },
    },
    defaults: {
      intervalSeconds: 300,
      chanceToProduce: 1,
      quantityPerDino: 1,
      maxQuantityPerCycle: 0,
      maxQuantityInTerminal: 0,
    },
    simulator: {
      defaultHours: 24,
      defaultCreatureCount: 10,
      highOutputPerHour: 500,
      lowOutputPerHour: 1,
    },
    maps: defaultMaps(),
    discord: DiscordFormatSchema.parse({}),
    modules: {},
    playerData: PlayerDataSettingsSchema.parse({}),
    modpackRegistry: defaultModpackRegistry(),
  };
}

/** File names inside a project folder. Must match PROJECT_FILES in project_io.rs. */
export const PROJECT_FILE = {
  settings: "project.json",
  production: "production.draft.json",
  remaps: "remaps.draft.json",
  cosmetics: "cosmetics.draft.json",
  catalog: "catalog.mods.json",
  watchlist: "watchlist.json",
  history: "history.json",
  players: "players.json",
  creatureImports: "creature-imports.json",
  activity: "activity.json",
} as const;

export type ProjectFileName = (typeof PROJECT_FILE)[keyof typeof PROJECT_FILE];
