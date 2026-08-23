import { useState } from "react";
import { useFeedbackStore } from "../../stores/feedbackStore";
import {
  FEEDBACK_CONFIG,
  canSubmitDirectly,
  effectiveConfig,
  isUsableApiUrl,
} from "../../model/feedback/config";
import { feedbackTarget } from "../../model/feedback/targets";
import { studioRepoSlug, studioRepoUrl } from "../../model/studio";
import { checkHealth } from "../../services/feedback/api";
import { openExternal } from "../../services/openExternal";
import { asStudioError } from "../../model/errors";
import { FEEDBACK_SHORTCUT } from "../../components/feedback/FeedbackHost";
import { Badge, Button, Card, Field, Input, Toggle } from "../../components/ui";
import { toast } from "../../components/toast";

/**
 * Where the Feedback Center is pointed, and whether it is on.
 *
 * The service address is here rather than baked into the build for a practical
 * reason: it is not a secret, it changes when the service is redeployed
 * somewhere else, and asking an administrator to recompile the application in
 * order to file a bug report would be an odd requirement for a bug reporting
 * feature.
 *
 * With no address set, everything still works — the report is written, kept,
 * and opened on GitHub with the text filled in. That is a real route, not a
 * degraded one, and it is what a build with no service behind it uses.
 */

export function FeedbackSettings() {
  const store = useFeedbackStore();
  const config = effectiveConfig(store.settings);
  const [url, setUrl] = useState(store.settings.apiBaseUrl);
  const [testing, setTesting] = useState(false);
  const [checked, setChecked] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  const trimmed = url.trim().replace(/\/+$/, "");
  const usable = trimmed === "" || isUsableApiUrl(trimmed);
  const dirty = trimmed !== store.settings.apiBaseUrl;

  async function save() {
    await store.setSettings({ apiBaseUrl: trimmed });
    setChecked(null);
    toast.success(
      trimmed ? "Feedback service address saved." : "Feedback service address cleared.",
    );
  }

  /**
   * Asks the service what repository it files into.
   *
   * A misconfigured address that answers is more dangerous than one that does
   * not — reports would go somewhere nobody is reading — so the check compares
   * the answer against the repository this build belongs to rather than just
   * reporting that something replied.
   */
  async function test() {
    setTesting(true);
    setChecked(null);
    try {
      const health = await checkHealth(effectiveConfig({ apiBaseUrl: trimmed }));
      const expected = studioRepoSlug();
      if (health.repository && health.repository !== expected) {
        setChecked({
          ok: false,
          message: `That service files into ${health.repository}, not ${expected}.`,
        });
      } else if (!health.accepts.includes(1)) {
        setChecked({
          ok: false,
          message: "That service does not accept reports from this version of the app.",
        });
      } else {
        setChecked({ ok: true, message: `Answering, and files into ${expected}.` });
      }
    } catch (error) {
      setChecked({
        ok: false,
        message: asStudioError(error, "unknown", "It did not answer.").message,
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <p className="col-span-full -mb-2 text-xs text-ink-400">
        <span className="text-ink-300">This computer only:</span> feedback
        settings and your report history are stored on this machine and saved as
        you set them, so the Save button does not apply here.
      </p>

      <Card
        title="Feedback"
        actions={
          canSubmitDirectly(config) ? (
            <Badge tone="ok">Service configured</Badge>
          ) : (
            <Badge tone="neutral">GitHub only</Badge>
          )
        }
      >
        <div className="flex flex-col gap-4" {...feedbackTarget("settings-feedback")}>
          <Field label="Feedback" interactiveLabel>
            <Toggle
              checked={store.settings.enabled}
              onChange={(value) => void store.setSettings({ enabled: value })}
              label="Show the Feedback Center"
              title="Hides every feedback entry point, including the right-click menu"
            />
            <span className="block text-xs text-ink-400 mt-1">
              {FEEDBACK_SHORTCUT} opens it from anywhere. Right-click any control
              to report a problem with that exact part of the app.
            </span>
          </Field>

          <Field
            label="Feedback service address"
            hint="Optional HTTPS address of a deployed DinoDepot Feedback API. It files reports without using your GitHub sign-in. Leave empty to save reports here and open them on GitHub instead."
          >
            <Input
              value={url}
              placeholder="https://dinodepot-feedback.example.workers.dev"
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
            {!usable && (
              <span className="block text-xs text-red-400 mt-1">
                Must be an https:// address with no username, password or query
                string.
              </span>
            )}
            {FEEDBACK_CONFIG.apiBaseUrl && !store.settings.apiBaseUrl && (
              <span className="block text-xs text-ink-400 mt-1">
                This build ships with{" "}
                <span className="mono">{FEEDBACK_CONFIG.apiBaseUrl}</span>, which
                is used unless you set one here.
              </span>
            )}
          </Field>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" onClick={() => void save()} disabled={!usable || !dirty}>
              Save address
            </Button>
            <Button
              variant="secondary"
              onClick={() => void test()}
              disabled={!usable || !trimmed || testing}
            >
              {testing ? "Checking…" : "Test"}
            </Button>
            {checked && (
              <Badge tone={checked.ok ? "ok" : "error"}>{checked.message}</Badge>
            )}
          </div>

          <div className="border-t border-ink-700 pt-3 flex flex-wrap items-center gap-2">
            {config.enabled && (
              <>
                <Button variant="secondary" onClick={store.openLauncher}>
                  Send feedback
                </Button>
                <Button variant="ghost" onClick={store.openReports}>
                  My reports
                  {store.records.length > 0 && (
                    <span className="ml-1.5 text-xs text-ink-400">
                      ({store.records.length})
                    </span>
                  )}
                </Button>
              </>
            )}
            <Button
              variant="ghost"
              onClick={() => void openExternal(`${studioRepoUrl()}/issues`).catch(() => {})}
            >
              All reports on GitHub ↗
            </Button>
          </div>

          <p className="text-xs text-ink-400">
            Reports go to <span className="mono">{studioRepoSlug()}</span> — the
            application's own repository, never your project's. Your GitHub sign
            in is not used and is never sent.
          </p>
        </div>
      </Card>
    </>
  );
}
