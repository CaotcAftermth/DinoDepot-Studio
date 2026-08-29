import type { PlayersFile } from "../model/players";

/**
 * Player roster as published JSON.
 *
 * Deliberately not the raw draft file: the stored `.arkprofile` reference is
 * local to the admin's project folder and means nothing to anyone else, so it
 * is reduced to "there is one, from this map, as of this date". Everything
 * published here is personal data - see the warning on the Publish page.
 */
export interface PublishedPlayer {
  discordName: string;
  discordId: string;
  steamName: string;
  steamId: string;
  accountName: string;
  gameName: string;
  playerId: string;
  eosId: string;
  notes: string;
  profile: { map: string; storedAt: string } | null;
}

export interface PublishedPlayers {
  version: 1;
  generatedAt: string;
  players: PublishedPlayer[];
}

export function playersToPublished(
  file: PlayersFile,
  now = new Date(),
): PublishedPlayers {
  return {
    version: 1,
    generatedAt: now.toISOString(),
    players: file.players.map((p) => ({
      discordName: p.discordName,
      discordId: p.discordId,
      steamName: p.steamName,
      steamId: p.steamId,
      accountName: p.accountName,
      gameName: p.gameName,
      playerId: p.playerId,
      eosId: p.eosId,
      notes: p.notes,
      profile: p.profile
        ? { map: p.profile.map, storedAt: p.profile.storedAt }
        : null,
    })),
  };
}

export function playersToText(file: PlayersFile, now = new Date()): string {
  return JSON.stringify(playersToPublished(file, now), null, 2);
}
