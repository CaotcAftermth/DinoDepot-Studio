import type { ReactNode } from "react";
import { cx } from "./ui";
import { toast } from "./toast";
import { openExternal } from "../services/openExternal";
import {
  EXTERNAL_LINKS,
  isConfiguredLink,
  unconfiguredHint,
  type ExternalLink,
} from "../model/externalLinks";

/**
 * Who made this, who it stands on, and where it came from.
 *
 * Shown only in the Production Rules empty state, where the editor column is
 * otherwise blank — the page's job is editing rules, and this has to give way
 * the moment there is a rule to edit. It is not a banner and never appears
 * beside working content.
 *
 * The styling is deliberately quiet: a thin accent border, a glow low enough
 * to read as depth rather than neon, and hover changes small enough that the
 * cards look like part of the application rather than three adverts pasted
 * into it.
 */

// ---------------------------------------------------------------------------
// Accents
// ---------------------------------------------------------------------------

type Accent = "cyan" | "violet" | "sky";

/**
 * Tailwind needs whole class names, so each accent lists its own rather than
 * being built from a colour name at runtime.
 *
 * Violet and sky are already in use elsewhere — the alternate-outputs section
 * and the informational badge — so only cyan is new here. The app's own
 * `accent` token is green and deliberately left alone: it means "this is the
 * primary action", which none of these are.
 */
const ACCENTS: Record<
  Accent,
  {
    card: string;
    icon: string;
    heading: string;
    divider: string;
    button: string;
  }
> = {
  cyan: {
    card: "border-cyan-500/25 hover:border-cyan-400/55 shadow-[0_0_30px_-16px_rgba(34,211,238,0.6)] hover:shadow-[0_0_34px_-13px_rgba(34,211,238,0.75)]",
    icon: "text-cyan-400",
    heading: "text-cyan-300",
    divider: "via-cyan-400/35",
    button:
      "border-cyan-500/40 text-cyan-200 hover:bg-cyan-500/10 hover:border-cyan-400/70 focus-visible:ring-cyan-400/60",
  },
  violet: {
    card: "border-violet-500/25 hover:border-violet-400/55 shadow-[0_0_30px_-16px_rgba(167,139,250,0.6)] hover:shadow-[0_0_34px_-13px_rgba(167,139,250,0.75)]",
    icon: "text-violet-400",
    heading: "text-violet-300",
    divider: "via-violet-400/35",
    button:
      "border-violet-500/40 text-violet-200 hover:bg-violet-500/10 hover:border-violet-400/70 focus-visible:ring-violet-400/60",
  },
  sky: {
    card: "border-sky-500/25 hover:border-sky-400/55 shadow-[0_0_30px_-16px_rgba(56,189,248,0.6)] hover:shadow-[0_0_34px_-13px_rgba(56,189,248,0.75)]",
    icon: "text-sky-400",
    heading: "text-sky-300",
    divider: "via-sky-400/35",
    button:
      "border-sky-500/40 text-sky-200 hover:bg-sky-500/10 hover:border-sky-400/70 focus-visible:ring-sky-400/60",
  },
};

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

/**
 * Drawn inline rather than pulled from a package.
 *
 * The app has no icon library — every glyph it uses is either an inline `svg`
 * or a character — and adding a dependency for five shapes would be the
 * largest thing in this feature by far. All but the footprint inherit
 * `currentColor`, so each takes its card's accent without being told about it.
 */

function HeartIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width="34"
      height="34"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20.5 4.2 12.9a5 5 0 0 1 0-7.1 5 5 0 0 1 7.1 0l.7.7.7-.7a5 5 0 0 1 7.1 0 5 5 0 0 1 0 7.1Z" />
    </svg>
  );
}

/**
 * The Dino Depot track, drawn as artwork rather than as a glyph.
 *
 * The odd one out among these icons: it carries its own blue gradient and soft
 * glow instead of taking `currentColor` from its card, because it is the
 * project's own mark and the colour is part of it. The card's sky accent was
 * chosen to sit beside it, so the two agree without being the same value.
 *
 * The gradient and filter ids are prefixed. They are document-global in SVG,
 * and this is a single-page app where an unprefixed `footGradient` would be
 * one careless addition away from being claimed by something else.
 */
function FootprintIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 64"
      className={className}
      width="34"
      height="34"
      aria-hidden
    >
      <defs>
        <linearGradient id="ddFootGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#58A8FF" />
          <stop offset="55%" stopColor="#3B97FF" />
          <stop offset="100%" stopColor="#2F86F4" />
        </linearGradient>
        <filter id="ddFootGlow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="1.4" result="blur" />
          <feFlood floodColor="#2F86F4" floodOpacity="0.28" result="glowColor" />
          <feComposite in="glowColor" in2="blur" operator="in" result="softGlow" />
          <feMerge>
            <feMergeNode in="softGlow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path
        d="M 33.70 6.00 L 31.43 7.13 L 30.30 12.78 L 28.04 15.04 L 26.91 25.22 L 25.78 26.35 L 26.91 27.48 L 26.91 32.00 L 25.78 33.13 L 23.52 33.13 L 17.87 26.35 L 15.61 26.35 L 12.22 20.70 L 9.96 19.57 L 11.09 32.00 L 17.87 46.70 L 22.39 53.48 L 31.43 58.00 L 40.48 55.74 L 43.87 52.35 L 54.04 32.00 L 54.04 19.57 L 41.61 33.13 L 38.22 32.00 L 39.35 28.61 L 38.22 16.17 L 35.96 13.91 L 35.96 10.52 Z"
        fill="url(#ddFootGradient)"
        filter="url(#ddFootGlow)"
      />
    </svg>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M19.3 5.4A16.2 16.2 0 0 0 15.4 4l-.3.5a12 12 0 0 0-6.2 0L8.6 4a16.2 16.2 0 0 0-4 1.4C2 9.3 1.4 13 1.7 16.7a16.4 16.4 0 0 0 4.9 2.5l1-1.7a10.6 10.6 0 0 1-1.7-.8l.4-.3a11.6 11.6 0 0 0 9.9 0l.4.3c-.5.3-1.1.6-1.7.8l1 1.7a16.4 16.4 0 0 0 4.9-2.5c.4-4.3-.6-8-2.5-11.3ZM8.5 14.5c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Zm7 0c-1 0-1.8-.9-1.8-2s.8-2 1.8-2 1.8.9 1.8 2-.8 2-1.8 2Z" />
    </svg>
  );
}

function SmallHeartIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 20.5 4.2 12.9a5 5 0 0 1 0-7.1 5 5 0 0 1 7.1 0l.7.7.7-.7a5 5 0 0 1 7.1 0 5 5 0 0 1 0 7.1Z" />
    </svg>
  );
}

function CoffeeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 9h12v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" />
      <path d="M16 10h1.8a2.2 2.2 0 0 1 0 4.4H16" />
      <path d="M7 3v2.5M11 3v2.5" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A link out, disabled while its destination is still to be filled in. */
function LinkButton({
  link,
  accent,
  icon,
  children,
}: {
  link: ExternalLink;
  accent: Accent;
  icon?: ReactNode;
  children: ReactNode;
}) {
  const ready = isConfiguredLink(link);
  return (
    <button
      type="button"
      // Shaped like the app's own buttons, but coloured by its card. `Button`
      // is not reused because its variants set the same utilities this needs
      // to override, and Tailwind resolves that by stylesheet order rather
      // than by the order the classes are written.
      className={cx(
        "inline-flex items-center justify-center gap-2 w-full px-3 py-1.5 rounded-md",
        "text-sm font-medium border transition-colors cursor-pointer",
        "focus-visible:outline-none focus-visible:ring-2",
        "disabled:opacity-45 disabled:cursor-not-allowed",
        ACCENTS[accent].button,
      )}
      disabled={!ready}
      title={ready ? link.url : unconfiguredHint(link)}
      onClick={() => {
        void openExternal(link.url).catch((e) =>
          toast.error(
            `Could not open ${link.label}: ${e instanceof Error ? e.message : e}`,
          ),
        );
      }}
    >
      {icon}
      {children}
    </button>
  );
}

/** The thin accent rule inside a card. */
function CardDivider({ accent }: { accent: Accent }) {
  return (
    <div
      className={cx(
        "h-px w-full my-4 bg-gradient-to-r from-transparent to-transparent",
        ACCENTS[accent].divider,
      )}
    />
  );
}

/**
 * One credit.
 *
 * `statement` is the line that carries the point and `body` explains it, which
 * is why they are separate: the first card's statement is who wrote the app,
 * the second's is what it stands on, and neither reads correctly at the body's
 * weight.
 */
function CommunityCreditCard({
  accent,
  icon,
  heading,
  statement,
  body,
  actions,
}: {
  accent: Accent;
  icon: ReactNode;
  heading: string;
  statement: ReactNode;
  body: string;
  actions: ReactNode;
}) {
  return (
    <article
      className={cx(
        "relative w-[300px] max-w-full flex flex-col items-center text-center",
        "rounded-lg border bg-ink-900/70 hover:bg-ink-900 px-7 py-8",
        "transition-colors",
        ACCENTS[accent].card,
      )}
    >
      {/* A single faint wash rather than a texture: enough to lift the card
          off the page background, not enough to read as a gradient. */}
      <div
        className="pointer-events-none absolute inset-0 rounded-lg bg-gradient-to-b from-white/[0.025] to-transparent"
        aria-hidden
      />
      <div className={cx("relative", ACCENTS[accent].icon)}>{icon}</div>
      <h3
        className={cx(
          "relative mt-4 text-base font-bold uppercase tracking-wide",
          ACCENTS[accent].heading,
        )}
      >
        {heading}
      </h3>
      <div className="relative mt-2 text-sm text-ink-100 font-medium leading-relaxed">
        {statement}
      </div>
      <div className="relative w-full">
        <CardDivider accent={accent} />
      </div>
      <p className="relative text-sm text-ink-300 leading-relaxed">{body}</p>
      {/* Pushed to the bottom so the buttons line up across cards whose text
          runs to different lengths. */}
      <div className="relative mt-auto pt-6 w-full flex flex-col gap-2">
        {actions}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------

export function CommunityCredits() {
  return (
    <section aria-labelledby="community-credits-heading" className="mt-12">
      {/* The rule brightens towards the outer ends and fades into the label,
          so the heading reads as a break in the line rather than something
          sitting on top of it. */}
      <div className="flex items-center gap-4">
        <div className="h-px flex-1 bg-gradient-to-r from-cyan-400/45 to-transparent" />
        <h2
          id="community-credits-heading"
          className="text-xs font-semibold uppercase tracking-widest text-ink-400"
        >
          Community &amp; Credits
        </h2>
        <div className="h-px flex-1 bg-gradient-to-l from-cyan-400/45 to-transparent" />
      </div>

      {/* Wrapping rather than a fixed three-column grid: at a narrower window
          this puts two cards on the first row and centres the third beneath
          them, and eventually stacks all three, without a breakpoint per
          layout. `items-stretch` keeps them the same height while they share
          a row. */}
      <div className="mt-8 flex flex-wrap items-stretch justify-center gap-7">
        <CommunityCreditCard
          accent="cyan"
          icon={<HeartIcon />}
          heading="Built with love"
          statement={
            <>
              by <span className="text-cyan-200 font-semibold">CaotcAftermth</span>
            </>
          }
          body="Made for the ARK community, fueled by questionable amounts of caffeine."
          actions={
            <LinkButton
              link={EXTERNAL_LINKS.buyMeACoffee}
              accent="cyan"
              icon={<CoffeeIcon />}
            >
              Buy Me a Coffee
            </LinkButton>
          }
        />

        <CommunityCreditCard
          accent="violet"
          icon={<HeartIcon />}
          heading="Special thanks"
          statement="DinoDepot-Studio wouldn't exist without Dino Depot."
          body="Huge thanks to DelilahEve, creator and maintainer of the incredible Dino Depot mod, and for everything she contributes to the ARK community."
          actions={
            <>
              <LinkButton
                link={EXTERNAL_LINKS.dinoDepotDiscord}
                accent="violet"
                icon={<DiscordIcon />}
              >
                Dino Depot Discord
              </LinkButton>
              <LinkButton
                link={EXTERNAL_LINKS.supportDelilahEve}
                accent="violet"
                icon={<SmallHeartIcon />}
              >
                Support DelilahEve
              </LinkButton>
            </>
          }
        />

        <CommunityCreditCard
          accent="sky"
          icon={<FootprintIcon />}
          heading="Shameless plug"
          statement="You found the shameless plug."
          body="DinoDepot-Studio was forged in the fires of the GG Fizz ASA Cluster."
          actions={
            <>
              {/* Discord first: it is where somebody who wants to ask a
                  question before joining actually goes. */}
              <LinkButton
                link={EXTERNAL_LINKS.ggFizzDiscord}
                accent="sky"
                icon={<DiscordIcon />}
              >
                GG Fizz Discord
              </LinkButton>
              <LinkButton link={EXTERNAL_LINKS.ggFizzCommunity} accent="sky">
                Come Play With Us →
              </LinkButton>
            </>
          }
        />
      </div>
    </section>
  );
}
