import { z } from "zod";
import { PlayerDataSettingsSchema } from "./playerData";
import { ModpackRegistrySchema, defaultModpackRegistry } from "./modpack";
import { dependencyKey, PackageDependencySchema } from "./dependency";
import {
  CURRENT_PROJECT_SCHEMA,
  MINIMUM_STUDIO_VERSION,
  PROJECT_FORMAT,
  ProjectCapabilitiesSchema,
} from "./manifest";
import type { LocalProjectState } from "./localState";

/**
 * Repository-relative locations of the files a project produces.
 *
 * Portable: this is the shape of the repository, which every administrator
 * shares. The repository it is a shape *of* is machine-local — see
 * {@link LocalProjectState}.
 */
export const OutputPathsSchema = z.object({
  production: z.string().default("dinodepot/passive-production.json"),
  remaps: z.string().default("dinodepot/creature-remaps.json"),
  cosmetics: z.string().default("dinodepot/custom-cosmetics.txt"),
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

export type OutputPaths = z.infer<typeof OutputPathsSchema>;

/**
 * A repository plus the layout inside it — what the publishing code actually
 * needs to build a URL or a path.
 *
 * Assembled at runtime by {@link effectiveGithubConfig} from the portable
 * layout and this machine's binding, rather than stored anywhere. Storing it
 * whole is what mixed one administrator's repository into everybody's project
 * file in schema 1.
 */
export interface GithubConfig {
  owner: string;
  repo: string;
  branch: string;
  paths: OutputPaths;
}

/**
 * The repository configuration for the open project on this machine.
 *
 * Falls back to blank owner/repo when nothing is bound yet, which every caller
 * already handles — `githubConfigComplete` has always been the gate.
 */
export function effectiveGithubConfig(
  settings: Pick<ProjectSettings, "outputPaths"> | null,
  local: Pick<LocalProjectState, "source"> | null,
): GithubConfig {
  const source = local?.source ?? null;
  return {
    owner: source?.owner ?? "",
    repo: source?.name ?? "",
    branch: source?.branch || "main",
    paths: settings?.outputPaths ?? defaultOutputPaths(),
  };
}

export function defaultOutputPaths(): OutputPaths {
  return OutputPathsSchema.parse({});
}

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

/**
 * The root project manifest — `project.json`, and the only manifest there is.
 *
 * Everything in here is *portable*: it is the same on every administrator's
 * machine, and it is what synchronizes. Local paths and repository bindings
 * used to live here too, which meant two administrators overwrote each other's
 * machine setup on every save; those now live in {@link LocalProjectState}.
 */
export const ProjectSettingsSchema = z.object({
  format: z.literal(PROJECT_FORMAT).default(PROJECT_FORMAT),
  /** Immutable identity. Never derived from a name, a path or a repository. */
  projectId: z.string().min(1),
  schemaVersion: z.literal(CURRENT_PROJECT_SCHEMA),
  minimumStudioVersion: z.string().default(MINIMUM_STUDIO_VERSION),
  createdAt: z.string().default(""),
  capabilities: ProjectCapabilitiesSchema,
  name: z.string().min(1),
  cluster: z.string(),
  /** Repository-relative locations of the generated files. */
  outputPaths: OutputPathsSchema.default(() => OutputPathsSchema.parse({})),
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
  /** Exact, portable package requirements. Order is dependency precedence. */
  packageDependencies: z.array(PackageDependencySchema).default([]),
}).superRefine((settings, context) => {
  const seen = new Set<string>();
  for (let index = 0; index < settings.packageDependencies.length; index++) {
    const key = dependencyKey(settings.packageDependencies[index]);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["packageDependencies", index],
        message: `Duplicate exact dependency ${key}`,
      });
    }
    seen.add(key);
  }
});

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

export function defaultProjectSettings(
  name: string,
  cluster: string,
  projectId: string,
  now = new Date(),
): ProjectSettings {
  return {
    format: PROJECT_FORMAT,
    projectId,
    schemaVersion: CURRENT_PROJECT_SCHEMA,
    minimumStudioVersion: MINIMUM_STUDIO_VERSION,
    createdAt: now.toISOString(),
    capabilities: {},
    name,
    cluster,
    outputPaths: defaultOutputPaths(),
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
    packageDependencies: [],
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
