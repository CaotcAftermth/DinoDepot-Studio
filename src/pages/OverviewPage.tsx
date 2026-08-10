import { Link } from "react-router-dom";
import { useProjectOverview } from "./overview/useProjectOverview";
import {
  activityRoute,
  formatActivityTime,
  type ActivityEvent,
} from "../model/activity";
import {
  HEALTH_LABELS,
  type AttentionItem,
  type HealthLevel,
  type InventoryCard,
  type NextAction,
} from "../model/projectOverview";
import { OUTPUT_STATUS_LABELS, type OutputState } from "../model/outputs";
import type { GithubReadiness } from "../model/githubReadiness";
import { Badge, Card, cx, PageHeader } from "../components/ui";

/**
 * The project's command centre.
 *
 * Renders a prepared view model and nothing else — every judgement it shows is
 * made in model/projectOverview and model/outputs, which Publish reads from
 * too, so the two pages cannot disagree about whether something is published.
 */
export function OverviewPage() {
  const overview = useProjectOverview();
  const {
    health,
    headline,
    outputs,
    inventory,
    attention,
    actions,
    github,
    synchronized,
    hasPublishableContent,
    activity,
  } = overview;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        subtitle={
          overview.projectName
            ? `${overview.projectName} — ${overview.clusterName}`
            : ""
        }
      />

      <HealthBanner health={health} headline={headline} />

      <div className="grid grid-cols-5 gap-3">
        {inventory.map((card) => (
          <InventoryTile key={card.id} card={card} />
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
        <Card
          title={
            <span className="flex items-center gap-2">
              Publishing
              <span className="text-xs font-normal text-ink-400">
                {hasPublishableContent
                  ? `${synchronized.count} of ${synchronized.total} synchronized`
                  : "nothing to publish yet"}
              </span>
            </span>
          }
          actions={<GithubTarget github={github} />}
        >
          <div className="flex flex-col">
            {outputs.map((output) => (
              <OutputRow key={output.family} output={output} />
            ))}
          </div>
        </Card>

        <Card title={actions.some((a) => a.primary) ? "Next actions" : "Common tasks"}>
          <div className="flex flex-col gap-1.5">
            {actions.map((action) => (
              <ActionLink key={action.id} action={action} />
            ))}
          </div>
        </Card>
      </div>

      {/* Only takes space when it has something to say — a card reserved for
          "nothing needs attention" was the largest thing on a healthy page. */}
      {attention.length > 0 && (
        <Card
          title={
            <span className="flex items-center gap-2">
              Needs attention
              <Badge tone={health === "blocked" ? "error" : "warn"}>
                {attention.length}
              </Badge>
            </span>
          }
        >
          <div className="flex flex-col divide-y divide-ink-800">
            {attention.map((item) => (
              <AttentionRow key={item.id} item={item} />
            ))}
          </div>
        </Card>
      )}

      <Card title="Recent activity">
        <RecentActivity events={activity} />
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

const HEALTH_STYLES: Record<
  HealthLevel,
  { border: string; bg: string; dot: string; text: string; glyph: string }
> = {
  healthy: {
    border: "border-accent-500/40",
    bg: "bg-accent-500/[0.06]",
    dot: "bg-accent-500",
    text: "text-accent-400",
    glyph: "✓",
  },
  changes: {
    border: "border-sky-500/40",
    bg: "bg-sky-500/[0.06]",
    dot: "bg-sky-500",
    text: "text-sky-400",
    glyph: "●",
  },
  attention: {
    border: "border-amber-flag/40",
    bg: "bg-amber-flag/[0.06]",
    dot: "bg-amber-flag",
    text: "text-amber-400",
    glyph: "!",
  },
  blocked: {
    border: "border-danger/40",
    bg: "bg-danger/[0.07]",
    dot: "bg-danger",
    text: "text-red-400",
    glyph: "!",
  },
};

function HealthBanner({
  health,
  headline,
}: {
  health: HealthLevel;
  headline: string;
}) {
  const style = HEALTH_STYLES[health];
  return (
    <div
      className={cx(
        "flex items-center gap-3 rounded-lg border px-4 py-3",
        style.border,
        style.bg,
      )}
      role="status"
    >
      <span
        className={cx(
          "grid place-items-center w-7 h-7 rounded-full text-sm font-bold text-ink-950 shrink-0",
          style.dot,
        )}
        aria-hidden
      >
        {style.glyph}
      </span>
      <div className="min-w-0">
        <div className={cx("text-sm font-semibold", style.text)}>
          {HEALTH_LABELS[health]}
        </div>
        <div className="text-sm text-ink-300">{headline}</div>
      </div>
    </div>
  );
}

function InventoryTile({ card }: { card: InventoryCard }) {
  return (
    <Link
      to={card.to}
      className={cx(
        "bg-ink-900 border rounded-lg px-3 py-2.5 hover:border-ink-500 transition-colors",
        card.alert ? "border-amber-flag/50" : "border-ink-700",
      )}
    >
      <div className="text-xs text-ink-300 uppercase tracking-wide truncate">
        {card.label}
      </div>
      <div className="text-2xl font-bold text-white mt-0.5 leading-tight">
        {card.value}
      </div>
      <div
        className={cx(
          "text-xs mt-0.5 truncate",
          card.alert ? "text-amber-400" : "text-ink-400",
        )}
        title={card.sub}
      >
        {card.sub}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------

/** Status glyph and tone per output state. */
const OUTPUT_STYLES: Record<
  OutputState["status"],
  { glyph: string; className: string }
> = {
  published: { glyph: "✓", className: "text-accent-400" },
  changed: { glyph: "●", className: "text-sky-400" },
  unpublished: { glyph: "○", className: "text-ink-300" },
  empty: { glyph: "—", className: "text-ink-500" },
  disabled: { glyph: "—", className: "text-ink-500" },
  blocked: { glyph: "!", className: "text-red-400" },
};

function OutputRow({ output }: { output: OutputState }) {
  const style = OUTPUT_STYLES[output.status];
  const detail =
    output.status === "blocked"
      ? `${output.errors} error${output.errors === 1 ? "" : "s"}`
      : output.status === "published" && output.lastPublishedAt
        ? new Date(output.lastPublishedAt).toLocaleDateString()
        : OUTPUT_STATUS_LABELS[output.status];

  return (
    <Link
      to="/publish"
      className="flex items-center gap-2 py-1.5 group border-b border-ink-800 last:border-0"
    >
      <span className={cx("w-4 text-center shrink-0", style.className)} aria-hidden>
        {style.glyph}
      </span>
      <span
        className={cx(
          "text-sm min-w-0 flex-1 truncate",
          output.applicable
            ? "text-ink-200 group-hover:text-white"
            : "text-ink-500",
        )}
      >
        {output.label}
      </span>
      {output.warnings > 0 && output.status !== "blocked" && (
        <Badge tone="warn">{output.warnings}</Badge>
      )}
      <span className={cx("text-xs shrink-0", style.className)}>{detail}</span>
    </Link>
  );
}

function GithubTarget({ github }: { github: GithubReadiness }) {
  if (!github.destinationConfigured) {
    return (
      <Link to="/settings" className="text-xs text-amber-400 hover:underline">
        No destination set
      </Link>
    );
  }
  return (
    <Link
      to="/settings"
      className="flex items-center gap-1.5 text-xs text-ink-300 hover:text-white"
      title={
        github.ready
          ? github.verified
            ? "Connection verified this session"
            : "Ready to publish — connection not verified this session"
          : github.blockers.join(" · ")
      }
    >
      <span className="mono truncate max-w-[220px]">{github.target}</span>
      {github.ready ? (
        <Badge tone={github.verified ? "ok" : "neutral"}>
          {github.verified ? "verified" : "ready"}
        </Badge>
      ) : (
        <Badge tone="warn">not ready</Badge>
      )}
    </Link>
  );
}

// ---------------------------------------------------------------------------

const ATTENTION_TONES = {
  error: { badge: "error" as const, glyph: "!" },
  warn: { badge: "warn" as const, glyph: "!" },
  info: { badge: "info" as const, glyph: "i" },
};

function AttentionRow({ item }: { item: AttentionItem }) {
  const tone = ATTENTION_TONES[item.tone];
  return (
    <Link to={item.to} className="flex items-start gap-2.5 py-2 group">
      <span className="mt-0.5 shrink-0">
        <Badge tone={tone.badge}>{tone.glyph}</Badge>
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-ink-200 group-hover:text-white">
          {item.label}
        </span>
        {item.detail && (
          <span className="block text-xs text-ink-400 truncate">
            {item.detail}
          </span>
        )}
      </span>
      <span className="ml-auto text-xs text-ink-500 shrink-0 group-hover:text-ink-300">
        →
      </span>
    </Link>
  );
}

function ActionLink({ action }: { action: NextAction }) {
  return (
    <Link
      to={action.to}
      className={cx(
        "px-3 py-2 rounded-md border text-sm transition-colors",
        action.primary
          ? "bg-accent-600/15 border-accent-500/40 text-accent-300 hover:bg-accent-600/25 hover:text-white"
          : "bg-ink-800 border-ink-600 text-ink-200 hover:text-white hover:border-ink-500",
      )}
    >
      {action.label}
    </Link>
  );
}

function RecentActivity({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-sm text-ink-400">
        Nothing recorded yet. Publishing, adding rules and running the cosmetics
        collector all show up here.
      </p>
    );
  }
  return (
    <div className="flex flex-col divide-y divide-ink-800">
      {events.map((event) => (
        <Link
          key={event.id}
          to={activityRoute(event)}
          className="flex items-baseline gap-3 py-1.5 group"
        >
          <span className="mono text-xs text-ink-400 w-24 shrink-0 tabular-nums">
            {formatActivityTime(event.at)}
          </span>
          <span className="text-sm text-ink-200 group-hover:text-white min-w-0 truncate">
            {event.title}
          </span>
          {event.detail && (
            <span className="text-xs text-ink-400 min-w-0 truncate ml-auto">
              {event.detail}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}
