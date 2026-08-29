/**
 * The Discord webhook, which belongs to a project rather than to a machine.
 *
 * A webhook URL points at one channel in one server, and that server belongs to
 * one cluster. Stored under a single global key it did two wrong things at
 * once: a project created five minutes ago opened Settings already reporting a
 * webhook it had never been given, and "Post to Discord" from that project
 * announced into somebody else's channel. So the key carries the project id.
 *
 * The value itself is never read back here - it lives in Windows Credential
 * Manager and only Rust touches it. Everything below asks about a credential or
 * asks for an operation on one; nothing returns a URL.
 */

import { ipc } from "./ipc";

/** The key an older, single-webhook build wrote. Read and moved, never written. */
export const LEGACY_WEBHOOK_KEY = "discord-webhook";

/** The credential key for one project's webhook. */
export function discordWebhookKey(projectId: string): string {
  return `${LEGACY_WEBHOOK_KEY}:${projectId}`;
}

/** Whether this project has been given a webhook. False without a project id. */
export async function hasDiscordWebhook(projectId: string): Promise<boolean> {
  if (!projectId) return false;
  return ipc<boolean>("secret_has", { key: discordWebhookKey(projectId) });
}

export async function storeDiscordWebhook(
  projectId: string,
  url: string,
): Promise<void> {
  await ipc("secret_set", { key: discordWebhookKey(projectId), value: url });
}

export async function removeDiscordWebhook(projectId: string): Promise<void> {
  await ipc("secret_delete", { key: discordWebhookKey(projectId) });
}

/**
 * Whether a webhook from before the split is still sitting on this machine.
 *
 * It is offered rather than adopted: nothing on the machine records which
 * project it belonged to, and quietly attaching it to whichever project opened
 * Settings first is the same wrong answer the global key gave.
 */
export async function hasLegacyDiscordWebhook(): Promise<boolean> {
  return ipc<boolean>("secret_has", { key: LEGACY_WEBHOOK_KEY });
}

/** Moves the pre-split webhook into this project. One-way and one-time. */
export async function adoptLegacyDiscordWebhook(
  projectId: string,
): Promise<void> {
  await ipc("discord_webhook_adopt_legacy", { projectId });
}

/** Discards the pre-split webhook without giving it to any project. */
export async function discardLegacyDiscordWebhook(): Promise<void> {
  await ipc("secret_delete", { key: LEGACY_WEBHOOK_KEY });
}

/** Posts an announcement through this project's webhook, one message each. */
export async function postDiscord(
  projectId: string,
  segments: string[],
): Promise<void> {
  await ipc("discord_post", { projectId, segments });
}
