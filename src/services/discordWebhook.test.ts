import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  adoptLegacyDiscordWebhook,
  discardLegacyDiscordWebhook,
  discordWebhookKey,
  hasDiscordWebhook,
  hasLegacyDiscordWebhook,
  LEGACY_WEBHOOK_KEY,
  postDiscord,
  removeDiscordWebhook,
  storeDiscordWebhook,
} from "./discordWebhook";

/**
 * A webhook points at one channel in one Discord server, which belongs to one
 * cluster. Stored under a single machine-wide key it did two wrong things at
 * once: a project made five minutes ago reported a webhook it had never been
 * given, and posting from it announced into somebody else's channel. So every
 * call here has to carry the project id, and the one that does not — the
 * legacy entry — must never be reached by accident.
 */

/** The fake credential store, and what the backend was asked to do. */
let store: Record<string, string> = {};
let calls: { cmd: string; args: Record<string, unknown> }[] = [];

vi.mock("./ipc", () => ({
  isTauri: false,
  ipc: async (cmd: string, args: Record<string, unknown> = {}) => {
    calls.push({ cmd, args });
    const key = args.key as string;
    switch (cmd) {
      case "secret_has":
        return key in store;
      case "secret_set":
        store[key] = args.value as string;
        return undefined;
      case "secret_delete":
        delete store[key];
        return undefined;
      case "discord_webhook_adopt_legacy": {
        const legacy = store["discord-webhook"];
        if (!legacy) throw new Error("There is no webhook from an older version to move");
        store[`discord-webhook:${args.projectId as string}`] = legacy;
        delete store["discord-webhook"];
        return undefined;
      }
      case "discord_post":
        return undefined;
      default:
        throw new Error(`unexpected command ${cmd}`);
    }
  },
}));

const PROJECT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";

beforeEach(() => {
  store = {};
  calls = [];
});

describe("discordWebhookKey", () => {
  it("namespaces the key by project", () => {
    expect(discordWebhookKey(PROJECT)).toBe(`${LEGACY_WEBHOOK_KEY}:${PROJECT}`);
    expect(discordWebhookKey(PROJECT)).not.toBe(discordWebhookKey(OTHER));
  });
});

describe("one project's webhook", () => {
  it("is not another project's", async () => {
    await storeDiscordWebhook(PROJECT, "https://discord.com/api/webhooks/1/a");
    await expect(hasDiscordWebhook(PROJECT)).resolves.toBe(true);
    await expect(hasDiscordWebhook(OTHER)).resolves.toBe(false);
  });

  /** The reported bug: a brand-new project claiming a stored webhook. */
  it("is absent on a project that has never been given one", async () => {
    await expect(hasDiscordWebhook(OTHER)).resolves.toBe(false);
  });

  /**
   * A project with no id must not fall through to a key of its own — an empty
   * tail is how the machine-wide entry gets reached by accident.
   */
  it("is absent, and asks the backend nothing, without a project id", async () => {
    await expect(hasDiscordWebhook("")).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it("removes only its own", async () => {
    await storeDiscordWebhook(PROJECT, "https://discord.com/api/webhooks/1/a");
    await storeDiscordWebhook(OTHER, "https://discord.com/api/webhooks/2/b");
    await removeDiscordWebhook(PROJECT);
    await expect(hasDiscordWebhook(PROJECT)).resolves.toBe(false);
    await expect(hasDiscordWebhook(OTHER)).resolves.toBe(true);
  });

  it("names the project when posting, so the right channel is used", async () => {
    await postDiscord(PROJECT, ["one", "two"]);
    expect(calls).toEqual([
      { cmd: "discord_post", args: { projectId: PROJECT, segments: ["one", "two"] } },
    ]);
  });
});

describe("the webhook an older version stored", () => {
  beforeEach(() => {
    store[LEGACY_WEBHOOK_KEY] = "https://discord.com/api/webhooks/old/secret";
  });

  it("is found, but claimed by no project until it is moved", async () => {
    await expect(hasLegacyDiscordWebhook()).resolves.toBe(true);
    await expect(hasDiscordWebhook(PROJECT)).resolves.toBe(false);
  });

  it("becomes this project's, and is offered to no other", async () => {
    await adoptLegacyDiscordWebhook(PROJECT);
    await expect(hasDiscordWebhook(PROJECT)).resolves.toBe(true);
    await expect(hasLegacyDiscordWebhook()).resolves.toBe(false);
    await expect(hasDiscordWebhook(OTHER)).resolves.toBe(false);
    expect(store[discordWebhookKey(PROJECT)]).toBe(
      "https://discord.com/api/webhooks/old/secret",
    );
  });

  it("can be thrown away instead, giving it to nobody", async () => {
    await discardLegacyDiscordWebhook();
    await expect(hasLegacyDiscordWebhook()).resolves.toBe(false);
    await expect(hasDiscordWebhook(PROJECT)).resolves.toBe(false);
  });

  it("cannot be moved twice", async () => {
    await adoptLegacyDiscordWebhook(PROJECT);
    await expect(adoptLegacyDiscordWebhook(OTHER)).rejects.toThrow(
      "There is no webhook from an older version to move",
    );
  });
});
