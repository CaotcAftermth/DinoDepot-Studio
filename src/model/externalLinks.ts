/**
 * Every destination outside the app, in one place.
 *
 * A URL typed into the component that links to it is a URL nobody can find
 * again - and these are the kind that change: a Discord invite expires, a
 * donation page moves host, a cluster gets a new front page. Kept together so
 * updating one is an edit to this file rather than a search across the UI.
 *
 * Opened with {@link openExternal}, never by navigation: the webview would
 * otherwise try to render Discord inside the application window.
 *
 * An empty string means **not configured yet**. Callers must treat that as "no
 * link" and disable the control rather than opening nothing - see
 * {@link isConfiguredLink}. Empty is deliberate: a guessed URL that happens to
 * resolve somewhere is worse than a button that plainly says it needs setting
 * up, because nobody ever checks the one that looks like it works.
 */

export interface ExternalLink {
  /** The destination, or "" while it is still to be filled in. */
  url: string;
  /** What the link is, for the tooltip and for the not-configured message. */
  label: string;
}

export const EXTERNAL_LINKS = {
  /** Author's donation page. */
  buyMeACoffee: {
    url: "https://buymeacoffee.com/caotcaftermth",
    label: "Buy Me a Coffee",
  },
  /** The Dino Depot mod community's own server. */
  dinoDepotDiscord: {
    url: "https://discord.gg/MR947AvtVJ",
    label: "Dino Depot Discord",
  },
  /** Where DelilahEve, the Dino Depot mod's author, can be supported. */
  supportDelilahEve: {
    url: "https://ko-fi.com/delilaheve",
    label: "Support DelilahEve",
  },
  /** The GG Fizz ASA cluster's own server. */
  ggFizzDiscord: {
    url: "https://discord.gg/v8qGgXW5w",
    label: "GG Fizz Discord",
  },
  /** The GG Fizz ASA cluster's community destination. */
  ggFizzCommunity: {
    url: "https://ggfizz.gameserverapp.net/page/106643-Home",
    label: "GG Fizz ASA Cluster",
  },
} as const satisfies Record<string, ExternalLink>;

export type ExternalLinkKey = keyof typeof EXTERNAL_LINKS;

/** Whether a link has been given a destination yet. */
export function isConfiguredLink(link: ExternalLink): boolean {
  return /^https?:\/\//i.test(link.url.trim());
}

/** What to tell somebody hovering a link that has no destination yet. */
export function unconfiguredHint(link: ExternalLink): string {
  return `${link.label} has no address yet - set it in src/model/externalLinks.ts`;
}
