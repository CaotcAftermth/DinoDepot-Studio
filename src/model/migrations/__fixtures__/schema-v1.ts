/**
 * A schema-1 project, captured as it was actually written by the released
 * build.
 *
 * Permanent. This is the only evidence left of what shipped, and the 1→2 test
 * is worth nothing if the fixture drifts to match whatever the code does now —
 * so nothing here may be "tidied up", including the local paths, the
 * repository name and the recorded IP addresses, which are the whole point of
 * what the migration has to deal with.
 *
 * The IPs are from the documentation range (RFC 5737) and belong to nobody.
 */

/** The IP the fixture roster carries, so a test can assert it is gone. */
export const FIXTURE_IP = "203.0.113.42";

export const SCHEMA_V1_PROJECT: Record<string, string> = {
  "project.json": JSON.stringify(
    {
      schemaVersion: 1,
      name: "GG Fizz",
      cluster: "GG Fizz Cluster",
      imagesDir: "C:\\Users\\admin\\Pictures\\dino-icons",
      modsDir: "D:\\ASA\\ShooterGame\\Binaries\\Win64\\ShooterGame\\Mods\\83374",
      github: {
        owner: "ggfizz",
        repo: "cluster-config",
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
      maps: [
        { name: "The Island", icon: "🏝️", color: "#4ade80", enabled: true },
        { name: "Ragnarok", icon: "⚔️", color: "#38bdf8", enabled: true },
      ],
      discord: {
        header: "**🆕 New Custom Cosmetic Mods ({count})**",
        line: "- [{name}](<{url}>) — `{id}`{updatedSuffix}",
        footer: "",
      },
      modules: { "player-data": true },
      playerData: {},
      modpackRegistry: {
        owner: "CaotcAftermth",
        repo: "DinoDepot_Production_Studio",
        branch: "main",
        path: "Public_Content/ModPacks",
      },
    },
    null,
    2,
  ),

  "players.json": JSON.stringify(
    {
      schemaVersion: 1,
      players: [
        {
          id: "p1",
          discordName: "survivor",
          discordId: "218450941836787712",
          steamName: "",
          steamId: "",
          accountName: "SurvivorAccount",
          gameName: "Rex Wrangler",
          playerId: "112233",
          eosId: "0002abcd0002abcd0002abcd0002abcd",
          notes: "",
          profile: {
            fileName: "0002abcd0002abcd0002abcd0002abcd.arkprofile",
            storedAt: "2026-07-02T10:00:00.000Z",
            map: "Ragnarok",
            backedUpAt: null,
            summary: {
              eosId: "0002abcd0002abcd0002abcd0002abcd",
              accountName: "SurvivorAccount",
              characterName: "Rex Wrangler",
              level: 105,
              lastKnownIp: "203.0.113.42",
              saveVersion: 5,
            },
            generated: false,
            archivedAt: null,
          },
        },
      ],
      cleanSlates: [
        {
          map: "Ragnarok",
          fileName: "clean-slate-ragnarok",
          addedAt: "2026-07-02T10:00:00.000Z",
          summary: {
            eosId: "",
            accountName: "",
            characterName: "",
            level: 1,
            lastKnownIp: "203.0.113.42",
            saveVersion: 5,
          },
        },
      ],
    },
    null,
    2,
  ),

  "production.draft.json": JSON.stringify(
    { schemaVersion: 1, rules: [], groups: [] },
    null,
    2,
  ),
};
