import { useEffect, useMemo, useState } from "react";
import { PublishSiteCard } from "./publish/PublishSiteCard";
import { Link } from "react-router-dom";
import {
  useDraftsStore,
  flushPendingSaves,
  recordActivity,
} from "../stores/draftsStore";
import { useGithubConfig, useProjectStore } from "../stores/projectStore";
import type { GithubConfig } from "../model/project";
import { useCatalogIndex } from "../stores/useCatalogIndex";
import {
  OUTPUT_FAMILY_LABELS,
  OutputFamily,
  PublishRecord,
} from "../model/history";
import {
  buildOutputStates,
  standaloneOutputs,
  type OutputState,
} from "../model/outputs";
import { newId } from "../model/ids";
import {
  fetchRemote,
  githubConfigComplete,
  publishFile,
  rawUrl,
} from "../services/publish";
import { useGithubStatus } from "../services/githubStatus";
import { isTauri } from "../services/ipc";
import {
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
} from "../components/ui";
import { OutputPreviewModal } from "../components/OutputPreviewModal";
import { toast } from "../components/toast";
import { feedbackTarget } from "../model/feedback/targets";

/** The default commit message for a family, used when none was typed. */
function defaultCommitMessage(family: OutputFamily): string {
  return `Update ${OUTPUT_FAMILY_LABELS[family]} via Dino Depot Studio`;
}

/**
 * Publishes one output family and returns the record to append to history.
 *
 * The single-family button and Publish All both go through here, so a change
 * to how a publish is recorded can only ever be made in one place.
 */
async function publishFamily(
  github: GithubConfig,
  state: OutputState,
  commitMessage: string,
): Promise<PublishRecord> {
  const result = await publishFile(
    github,
    state.family,
    state.content,
    commitMessage,
  );
  return {
    id: newId(),
    family: state.family,
    publishedAt: new Date().toISOString(),
    commitSha: result.commit_sha,
    commitMessage,
    path: github.paths[state.family],
    rawUrl: rawUrl(github, state.family),
    // The stable hash, so the next comparison is against the same measure.
    contentHash: state.hash,
  };
}

export function PublishPage() {
  const drafts = useDraftsStore();
  const { settings } = useProjectStore();
  const github = useGithubConfig();
  const index = useCatalogIndex();
  useEffect(drafts.hydrate, [drafts.hydrate]);

  const [ghStatus, setGhStatus] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutputState | null>(null);

  // The shared registry - Overview reads exactly the same states, so the two
  // pages cannot disagree about what is published.
  const allOutputs = useMemo(
    () =>
      buildOutputStates({
        production: drafts.production,
        remaps: drafts.remaps,
        cosmetics: drafts.cosmetics,
        catalog: drafts.catalog,
        players: drafts.players,
        history: drafts.history,
        imageFiles: drafts.imageFiles,
        settings,
        github,
        index,
      }),
    [drafts.production, drafts.remaps, drafts.cosmetics, drafts.catalog, drafts.players, drafts.history, drafts.imageFiles, index, settings, github],
  );
  /** Site files publish atomically above; only standalone outputs get cards. */
  const families = useMemo(
    () => standaloneOutputs(allOutputs),
    [allOutputs],
  );

  if (!settings) return null;
  const configured = githubConfigComplete(github);

  async function handleTest() {
    setGhStatus("Testing connection…");
    // Recorded in the shared status cache, which is where Overview reads its
    // "verified" state from - it never runs a test of its own.
    const result = await useGithubStatus.getState().checkConnection(github);
    setGhStatus(result.message);
  }

  return (
    <div {...feedbackTarget("publishing")}>
      <PageHeader
        title="Publish"
        subtitle="The public site, published as one change from a shared version"
        actions={
          <Button onClick={handleTest} disabled={!configured || !isTauri}>
            Test GitHub connection
          </Button>
        }
      />

      <PublishSiteCard />

      {!configured && (
        <Card className="mb-4">
          <p className="text-sm text-amber-400">
            GitHub is not configured yet - set the repository owner, name, and
            branch in Settings before publishing.
          </p>
        </Card>
      )}
      {ghStatus && (
        <Card className="mb-4">
          <p className="text-sm text-ink-200">{ghStatus}</p>
        </Card>
      )}

      <div className="flex flex-col gap-5">
        {families.map((state) => (
          <FamilyCard
            key={state.family}
            state={state}
            configured={configured}
            onPreview={() => setPreview(state)}
          />
        ))}
      </div>

      {preview && (
        <OutputPreviewModal
          label={OUTPUT_FAMILY_LABELS[preview.family]}
          content={preview.content}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

/*
 * The "Publish All" modal is gone.
 *
 * It published each output as its own commit, so a failure halfway through left
 * a site that was half last week's - and there was no single moment at which
 * the published site was known to correspond to one version of the project.
 * `PublishSiteCard` replaces it with one atomic commit carrying the viewer
 * page, viewer data, assets, and manifest. Cards below are only for outputs
 * with independent consumers and destinations.
 */

// ---------------------------------------------------------------------------

function FamilyCard({
  state,
  configured,
  onPreview,
}: {
  state: OutputState;
  configured: boolean;
  onPreview: () => void;
}) {
  const { history, setHistory } = useDraftsStore();
  const github = useGithubConfig();

  const { dirty, errors, warnings, lastRecord: record } = state;

  const [message, setMessage] = useState("");
  const [ackWarnings, setAckWarnings] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [showIssues, setShowIssues] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [remoteNote, setRemoteNote] = useState<string | null>(null);

  const url = rawUrl(github, state.family);
  const canPublish =
    configured &&
    isTauri &&
    errors === 0 &&
    (warnings === 0 || ackWarnings) &&
    !publishing;

  async function checkRemote() {
    setRemoteNote("Fetching remote file…");
    try {
      const remote = await fetchRemote(github, state.family);
      if (!remote.exists) {
        setRemoteNote("Remote file does not exist yet - publishing will create it.");
      } else if (remote.content === state.content) {
        setRemoteNote("Remote file is identical to the current draft output.");
      } else {
        const remoteLines = remote.content?.split("\n").length ?? 0;
        const localLines = state.content.split("\n").length;
        setRemoteNote(
          `Remote file differs from draft output (remote: ${remoteLines} lines, draft: ${localLines} lines).`,
        );
      }
    } catch (e) {
      setRemoteNote(`Could not fetch remote: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function handlePublish() {
    setPublishing(true);
    try {
      await flushPendingSaves();
      const newRecord = await publishFamily(
        github,
        state,
        message.trim() || defaultCommitMessage(state.family),
      );
      setHistory({
        ...history,
        records: [...history.records, newRecord],
      });
      recordActivity({
        kind: "publish",
        title: `Published ${OUTPUT_FAMILY_LABELS[state.family]}`,
        detail: `commit ${newRecord.commitSha.slice(0, 7)}`,
      });
      setMessage("");
      setAckWarnings(false);
      toast.success(
        `${OUTPUT_FAMILY_LABELS[state.family]} published (commit ${newRecord.commitSha.slice(0, 7)})`,
      );
    } catch (e) {
      toast.error(`${e instanceof Error ? e.message : e}`);
    } finally {
      setPublishing(false);
    }
  }

  const familyRecords = history.records
    .filter((r) => r.family === state.family)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          {OUTPUT_FAMILY_LABELS[state.family]}
          {errors > 0 ? (
            <Badge tone="error">{errors} errors</Badge>
          ) : warnings > 0 ? (
            <Badge tone="warn">{warnings} warnings</Badge>
          ) : (
            <Badge tone="ok">Valid</Badge>
          )}
          {dirty ? (
            <Badge tone="warn">Unpublished changes</Badge>
          ) : record ? (
            <Badge tone="ok">Up to date</Badge>
          ) : null}
        </span>
      }
      actions={
        <>
          <Button variant="ghost" onClick={onPreview}>
            Preview output
          </Button>
          <Button variant="ghost" onClick={checkRemote} disabled={!configured || !isTauri}>
            Compare with remote
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_auto] gap-4 items-start">
        <div className="min-w-0 flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-ink-400">
            <span className="mono truncate" title={url}>
              {github.paths[state.family]}
            </span>
            <Button
              variant="ghost"
              onClick={() => {
                navigator.clipboard.writeText(url);
                toast.success("RAW URL copied");
              }}
            >
              Copy RAW URL
            </Button>
          </div>

          {state.family === "players" && (
            <p className="text-xs text-sky-400">
              The roster itself - names, IDs, and which map each stored
              .arkprofile came from. The profile <em>files</em> are backed up
              separately, per player, from the{" "}
              <Link to="/players" className="text-accent-400 hover:underline">
                Player Data
              </Link>{" "}
              page.
            </p>
          )}
          {record && (
            <p className="text-xs text-ink-400">
              Last published {new Date(record.publishedAt).toLocaleString()} -
              commit{" "}
              <span className="mono">{record.commitSha.slice(0, 7)}</span> ·{" "}
              {record.commitMessage}
            </p>
          )}
          {remoteNote && <p className="text-xs text-sky-400">{remoteNote}</p>}

          {state.issues.length > 0 && (
            <div>
              <button
                className="text-xs text-ink-300 underline cursor-pointer"
                onClick={() => setShowIssues(!showIssues)}
              >
                {showIssues ? "Hide" : "Show"} {state.issues.length} validation
                issue{state.issues.length === 1 ? "" : "s"}
              </button>
              {showIssues && (
                <div className="flex flex-col gap-1 mt-2">
                  {state.issues.map((issue, i) => (
                    <div key={i} className="flex items-start gap-2 text-sm">
                      <Badge tone={issue.level === "error" ? "error" : "warn"}>
                        {issue.level}
                      </Badge>
                      <span className="text-ink-300">
                        <span className="text-ink-400">{issue.where}:</span>{" "}
                        {issue.message}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {familyRecords.length > 0 && (
            <div>
              <button
                className="text-xs text-ink-300 underline cursor-pointer"
                onClick={() => setShowHistory(!showHistory)}
              >
                {showHistory ? "Hide" : "Show"} publish history (
                {familyRecords.length})
              </button>
              {showHistory && (
                <div className="flex flex-col gap-1 mt-2">
                  {familyRecords.map((r) => (
                    <div key={r.id} className="text-xs text-ink-400">
                      {new Date(r.publishedAt).toLocaleString()} ·{" "}
                      <span className="mono">{r.commitSha.slice(0, 7)}</span> ·{" "}
                      {r.commitMessage}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="w-[320px] flex flex-col gap-2">
          <Field label="Commit message">
            <Input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={`Update ${OUTPUT_FAMILY_LABELS[state.family]}`}
            />
          </Field>
          {warnings > 0 && errors === 0 && (
            <label className="flex items-center gap-2 text-xs text-amber-400 cursor-pointer">
              <input
                type="checkbox"
                checked={ackWarnings}
                onChange={(e) => setAckWarnings(e.target.checked)}
              />
              Publish despite {warnings} warning{warnings === 1 ? "" : "s"}
            </label>
          )}
          <Button
            variant="primary"
            disabled={!canPublish}
            onClick={handlePublish}
          >
            {publishing ? "Publishing…" : "Publish to GitHub"}
          </Button>
          {errors > 0 && (
            <p className="text-xs text-red-400">
              Fix all validation errors before publishing.
            </p>
          )}
          {!isTauri && (
            <p className="text-xs text-ink-400">
              Publishing is only available in the desktop app.
            </p>
          )}
        </div>
      </div>
    </Card>
  );
}
