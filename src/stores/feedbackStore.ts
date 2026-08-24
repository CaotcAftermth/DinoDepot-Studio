import { create } from "zustand";
import { newId } from "../model/ids";
import { asStudioError, isOffline, isStudioError } from "../model/errors";
import { STUDIO_VERSION } from "../model/studio";
import { useProjectStore } from "./projectStore";
import {
  FEEDBACK_CONFIG,
  canSubmitDirectly,
  effectiveConfig,
  newIssueUrl,
  type FeedbackConfig,
} from "../model/feedback/config";
import { FEEDBACK_SCOPE, sanitizeText, studioLog } from "../model/feedback/log";
import {
  MAX_DUPLICATES,
  rankCandidates,
  type ScoredCandidate,
} from "../model/feedback/duplicates";
import { debugInfoText, prefilledIssueUrl } from "../model/feedback/issue";
import { labelsForReport } from "../model/feedback/labels";
import {
  canRetry,
  credentialProblems,
  draftRecord,
  markFailed,
  markLinked,
  markPending,
  markSubmitted,
  removeRecord,
  reportFrom,
  upsertRecord,
  validateDraft,
  withDraft,
  withIssueState,
} from "../model/feedback/records";
import {
  issuesToRefresh,
  needsRefresh,
  type ReportFilter,
} from "../model/feedback/status";
import {
  defaultDiagnosticChoices,
  emptyDraft,
  emptyFeedbackState,
  type DiagnosticChoices,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type FeedbackTargetSnapshot,
  type FeedbackType,
  type LocalFeedbackRecord,
} from "../model/feedback/types";
import { issueStateFrom } from "../model/feedback/wire";
import {
  lookupIssues,
  searchDuplicates,
  submitReport,
} from "../services/feedback/api";
import { collectDiagnostics } from "../services/feedback/collect";
import {
  loadFeedbackState,
  saveFeedbackState,
} from "../services/feedback/localStore";
import { openExternal } from "../services/openExternal";
import { chooseDialog } from "../components/confirm";

/**
 * The Feedback Center, as a state machine.
 *
 * Every entry point — the Help menu, the right-click menu, the keyboard
 * shortcut, an error boundary — calls into this one store. That is not tidiness
 * for its own sake: the same report can be started four ways and must behave
 * identically each time, and four components each holding their own draft is
 * how "the inspector lost what I had typed" happens.
 *
 * The components above are deliberately thin. Everything with a decision in it
 * is here, in plain functions over plain data, so it can be exercised without
 * rendering anything — which matters because this project's test runner has no
 * DOM at all.
 *
 * ## Nothing here may break the app
 *
 * Feedback is not load-bearing. Every action catches its own failures and
 * leaves the store in a state the UI can render; nothing propagates out to a
 * caller who was only trying to open a menu.
 */

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

/**
 * Which panel the Feedback Center is showing.
 *
 * One value rather than a set of booleans, because "diagnostics open while the
 * duplicates list is also open" is not a state that should be representable.
 */
export type FeedbackView =
  | "closed"
  /** The three choices: bug, suggestion, feature. */
  | "launcher"
  | "form"
  | "diagnostics"
  | "duplicates"
  | "submitted"
  | "failed"
  | "reports";

export interface SubmissionResult {
  issueNumber: number;
  issueUrl: string;
  /** The service recognised the report id and returned the issue it already had. */
  alreadyFiled: boolean;
  /** True when the reporter said an existing issue was theirs. */
  linked: boolean;
  missingLabels: string[];
}

export interface FeedbackFailure {
  message: string;
  code: string;
  /** Whether retrying is worth offering, or the reporter should use GitHub. */
  retryable: boolean;
  /** Whether the current report was successfully written to local storage. */
  saved: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  target: FeedbackTargetSnapshot | null;
  /**
   * Live element used only to draw the selection spotlight. It is deliberately
   * separate from `target`: DOM nodes are never persisted or submitted.
   */
  targetElement: Element | null;
  /** True when the press was inside an editable field, so text actions matter. */
  editable: boolean;
}

interface StartReportOptions {
  target?: FeedbackTargetSnapshot | null;
  /** Transient geometry source for a target selected in the current view. */
  targetElement?: Element | null;
}

interface FeedbackStoreState {
  /** False until the stored history has been read once. */
  ready: boolean;
  view: FeedbackView;
  /** The view to come back to when the inspector finishes. */
  returnTo: FeedbackView;
  inspecting: boolean;
  /** What the pointer is over right now, while inspecting. */
  hovered: FeedbackTargetSnapshot | null;
  /** The live page element represented by `draft.target`, when still available. */
  targetElement: Element | null;

  draft: FeedbackDraft | null;
  /** The local record the draft belongs to; empty before one exists. */
  activeRecordId: string;

  records: LocalFeedbackRecord[];
  reporterId: string;
  settings: { enabled: boolean; apiBaseUrl: string };
  lastSyncAt: string;

  diagnostics: FeedbackDiagnostics | null;
  duplicates: ScoredCandidate[];
  /** True once the duplicate search has run for the current draft. */
  duplicatesChecked: boolean;
  checkingDuplicates: boolean;

  submitting: boolean;
  result: SubmissionResult | null;
  failure: FeedbackFailure | null;

  contextMenu: ContextMenuState | null;
  filter: ReportFilter;
  refreshing: boolean;

  // -- lifecycle ----------------------------------------------------------
  init(): Promise<void>;
  config(): FeedbackConfig;

  // -- opening ------------------------------------------------------------
  openLauncher(): void;
  openReports(): void;
  startReport(type: FeedbackType, options?: StartReportOptions): void;
  reportBug(options?: StartReportOptions): void;
  suggestImprovement(options?: StartReportOptions): void;
  requestFeature(options?: StartReportOptions): void;
  /** Starts a bug report already describing a caught error. */
  reportError(error: unknown, componentName?: string): void;

  // -- editing ------------------------------------------------------------
  updateDraft(patch: Partial<FeedbackDraft>): void;
  setTarget(target: FeedbackTargetSnapshot | null, targetElement?: Element | null): void;
  setDiagnosticChoice(key: keyof DiagnosticChoices, value: boolean): void;

  // -- the inspector ------------------------------------------------------
  startInspector(): void;
  hoverTarget(target: FeedbackTargetSnapshot | null): void;
  pickTarget(target: FeedbackTargetSnapshot, targetElement?: Element | null): void;
  cancelInspector(): void;

  // -- panels -------------------------------------------------------------
  openDiagnostics(): Promise<void>;
  backToForm(): void;

  // -- submitting ---------------------------------------------------------
  /** Checks for duplicates first when configured, otherwise submits. */
  submitOrCheck(): Promise<void>;
  submit(): Promise<void>;
  linkExisting(candidate: { number: number; url: string; state: "open" | "closed"; labels: string[] }): Promise<void>;
  /** Opens the repository's new-issue page with the report prefilled. */
  openGithubFallback(): Promise<void>;

  // -- closing ------------------------------------------------------------
  close(): void;
  /** Closes, asking about a half-written report first. */
  requestClose(): Promise<void>;
  saveDraftAndClose(): Promise<void>;
  discardAndClose(): Promise<void>;
  /** Whether closing now would lose something the reporter typed. */
  hasUnsavedContent(): boolean;

  // -- the report list ----------------------------------------------------
  setFilter(filter: ReportFilter): void;
  refreshReports(options?: { force?: boolean }): Promise<void>;
  resumeRecord(localId: string): void;
  deleteRecord(localId: string): Promise<void>;
  openIssue(localId: string): Promise<void>;

  // -- the context menu ---------------------------------------------------
  openContextMenu(state: ContextMenuState): void;
  closeContextMenu(): void;
  /** The sanitized debug summary. Returns what was copied, for the toast. */
  debugInfo(target: FeedbackTargetSnapshot | null): Promise<string>;

  // -- settings -----------------------------------------------------------
  setSettings(patch: Partial<{ enabled: boolean; apiBaseUrl: string }>): Promise<void>;
}

// ---------------------------------------------------------------------------

const initial = emptyFeedbackState();

export const useFeedbackStore = create<FeedbackStoreState>((set, get) => ({
  ready: false,
  view: "closed",
  returnTo: "form",
  inspecting: false,
  hovered: null,
  targetElement: null,

  draft: null,
  activeRecordId: "",

  records: [],
  reporterId: "",
  settings: initial.settings,
  lastSyncAt: "",

  diagnostics: null,
  duplicates: [],
  duplicatesChecked: false,
  checkingDuplicates: false,

  submitting: false,
  result: null,
  failure: null,

  contextMenu: null,
  filter: "all",
  refreshing: false,

  // -----------------------------------------------------------------------

  async init() {
    if (get().ready) return;
    const state = await loadFeedbackState();
    set({
      ready: true,
      records: state.records,
      reporterId: state.reporterId,
      settings: state.settings,
      lastSyncAt: state.lastSyncAt,
    });
    // The id may have been generated during the read; persisting it now means
    // it is stable from the first report rather than from the second.
    if (state.reporterId && !state.records.length) {
      void persist(get()).catch((error) => {
        studioLog.error(FEEDBACK_SCOPE, `Could not save the reporter id: ${describe(error)}`);
      });
    }
  },

  config() {
    return effectiveConfig(get().settings);
  },

  // -- opening ------------------------------------------------------------

  openLauncher() {
    set({ view: "launcher", contextMenu: null, failure: null, result: null });
  },

  openReports() {
    set({ view: "reports", contextMenu: null });
    void get().refreshReports();
  },

  startReport(type, options = {}) {
    const draft: FeedbackDraft = {
      ...emptyDraft(type),
      target: options.target ?? null,
    };
    set({
      view: "form",
      returnTo: "form",
      draft,
      targetElement: options.targetElement ?? null,
      activeRecordId: "",
      diagnostics: null,
      duplicates: [],
      duplicatesChecked: false,
      failure: null,
      result: null,
      contextMenu: null,
    });
  },

  reportBug(options) {
    get().startReport("bug", options);
  },
  suggestImprovement(options) {
    get().startReport("suggestion", options);
  },
  requestFeature(options) {
    get().startReport("feature_request", options);
  },

  /**
   * A bug report that already knows what went wrong.
   *
   * The message and the first few stack frames go in, sanitized the same way a
   * log line is — so the paths of the machine that crashed are not part of the
   * report. Severity starts at major because an error boundary firing means
   * part of the interface stopped rendering.
   */
  reportError(error, componentName) {
    const message = sanitizeText(
      error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? "Unknown error"),
    );
    const frames =
      error instanceof Error && error.stack
        ? error.stack
            .split("\n")
            .slice(1, 6)
            .map((line) => sanitizeText(line))
            .filter(Boolean)
        : [];

    const description = [
      componentName
        ? `${componentName} stopped working and showed the error screen.`
        : "Part of the app stopped working and showed the error screen.",
      "",
      `Error: ${message}`,
      ...(frames.length > 0 ? ["", "```", ...frames, "```"] : []),
    ].join("\n");

    get().startReport("bug");
    get().updateDraft({
      description,
      severity: "major",
      expectedBehavior: "The page should have carried on working.",
    });
  },

  // -- editing ------------------------------------------------------------

  updateDraft(patch) {
    const draft = get().draft;
    if (!draft) return;
    const next = { ...draft, ...patch };
    // Any edit invalidates a duplicate search done against the previous text.
    const textChanged =
      patch.title !== undefined ||
      patch.description !== undefined ||
      patch.target !== undefined;
    set({
      draft: next,
      duplicatesChecked: textChanged ? false : get().duplicatesChecked,
      duplicates: textChanged ? [] : get().duplicates,
      failure: null,
    });
  },

  setTarget(target, targetElement = null) {
    set({ targetElement: target ? targetElement : null });
    get().updateDraft({ target });
  },

  setDiagnosticChoice(key, value) {
    const draft = get().draft;
    if (!draft) return;
    const choices: DiagnosticChoices = { ...draft.diagnosticChoices, [key]: value };
    set({ draft: { ...draft, diagnosticChoices: choices } });
    // The panel shows what will actually be sent, so it is rebuilt rather than
    // filtered — a toggle that only hides a row would be a lie about the payload.
    void get().openDiagnostics();
  },

  // -- the inspector ------------------------------------------------------

  startInspector() {
    set({ inspecting: true, hovered: null, returnTo: get().view, view: "closed" });
  },

  hoverTarget(target) {
    if (!get().inspecting) return;
    set({ hovered: target });
  },

  pickTarget(target, targetElement = null) {
    if (!get().inspecting) return;
    set({ inspecting: false, hovered: null, view: get().returnTo });
    get().setTarget(target, targetElement);
  },

  cancelInspector() {
    if (!get().inspecting) return;
    set({ inspecting: false, hovered: null, view: get().returnTo });
  },

  // -- panels -------------------------------------------------------------

  async openDiagnostics() {
    const draft = get().draft;
    if (!draft) return;
    const returnTo = get().view === "diagnostics" ? get().returnTo : get().view;
    set({ view: "diagnostics", returnTo });
    try {
      const diagnostics = await collectDiagnostics(
        draft.target,
        draft.diagnosticChoices,
        FEEDBACK_CONFIG.diagnosticsLogLimit,
      );
      set({ diagnostics });
    } catch (error) {
      studioLog.error(FEEDBACK_SCOPE, `Could not read diagnostics: ${describe(error)}`);
      set({ diagnostics: null });
    }
  },

  backToForm() {
    set({ view: "form" });
  },

  // -- submitting ---------------------------------------------------------

  /**
   * The primary button.
   *
   * Looks for existing reports first, once, and only when a service is
   * configured to look with. A search that fails is not allowed to stop
   * anything: it logs, marks itself done, and falls through to submitting.
   */
  async submitOrCheck() {
    const state = get();
    const draft = state.draft;
    // Both flags, because this is the button somebody double-clicks.
    if (!draft || state.submitting || state.checkingDuplicates) return;

    const config = state.config();
    if (state.duplicatesChecked || !config.duplicateSearchEnabled || !canSubmitDirectly(config)) {
      await get().submit();
      return;
    }

    set({ checkingDuplicates: true });
    try {
      const target = draft.diagnosticChoices.component ? draft.target : null;
      const response = await searchDuplicates(config, {
        type: draft.type,
        title: draft.title.slice(0, 200),
        description: draft.description.slice(0, 2000),
        componentId: target?.id ?? "",
        area: target?.area ?? "",
      });
      const ranked = rankCandidates(
        {
          type: draft.type,
          title: draft.title,
          description: draft.description,
          target: draft.target,
        },
        response.candidates.map((candidate) => ({ ...candidate })),
        MAX_DUPLICATES,
      );
      set({ duplicates: ranked, duplicatesChecked: true, checkingDuplicates: false });
      if (ranked.length > 0) {
        set({ view: "duplicates" });
        return;
      }
    } catch (error) {
      // Nobody should be prevented from reporting a bug because the search for
      // similar bugs did not work.
      studioLog.warn(FEEDBACK_SCOPE, `Duplicate search failed: ${describe(error)}`);
      set({ duplicates: [], duplicatesChecked: true, checkingDuplicates: false });
    }
    await get().submit();
  },

  /**
   * Files the report.
   *
   * The local record is written *before* the network call and updated after,
   * so a submission interrupted by a crash leaves something to retry rather
   * than nothing at all. The record's id is the idempotency key, so the retry
   * cannot produce a second issue.
   */
  async submit() {
    const state = get();
    const draft = state.draft;
    if (!draft || state.submitting) return;

    if (validateDraft(draft).length > 0) {
      set({ view: "form" });
      return;
    }

    // Claimed before the first `await`, not after it. Collecting diagnostics
    // yields, and a guard that only ran before that yield let a double click
    // through — two issues for one report, which is exactly what the report id
    // exists to prevent.
    set({ submitting: true, failure: null });

    const record =
      existingRecord(state) ??
      draftRecord(
        draft,
        new Date(),
        newId(),
        // Stamped at creation, not at listing time: which project the report
        // came out of is a fact about the report, and the open project will
        // have changed by the time anybody reads it.
        useProjectStore.getState().settings?.projectId ?? "",
      );
    const withText = withDraft(record, draft);

    let diagnostics: FeedbackDiagnostics;
    try {
      diagnostics = await collectDiagnostics(
        draft.target,
        draft.diagnosticChoices,
        FEEDBACK_CONFIG.diagnosticsLogLimit,
      );
    } catch (error) {
      // A report with no diagnostics is still a report worth sending.
      studioLog.warn(FEEDBACK_SCOPE, `Diagnostics unavailable: ${describe(error)}`);
      diagnostics = await collectDiagnostics(null, defaultDiagnosticChoices(), 0).catch(
        () => emptyDiagnostics(),
      );
    }

    const pending = markPending(withText, diagnostics);
    set({
      activeRecordId: pending.localId,
      records: upsertRecord(get().records, pending),
      diagnostics,
    });
    try {
      await persist(get());
    } catch (error) {
      const message =
        "DinoDepot could not save this report on this computer, so nothing was sent. Keep the app open and try again.";
      set({
        submitting: false,
        failure: { message, code: "save.failed", retryable: true, saved: false },
        view: "failed",
      });
      studioLog.error(FEEDBACK_SCOPE, `Report not saved: ${describe(error)}`, "save.failed");
      return;
    }

    const config = state.config();
    if (!canSubmitDirectly(config)) {
      await failSubmission(
        set,
        get,
        pending,
        "No feedback service is set up for this build. Your report is saved on this computer — you can still open it on GitHub.",
        "unknown",
        false,
      );
      await get().openGithubFallback();
      return;
    }

    const report = reportFrom(
      pending,
      draft,
      diagnostics,
      get().reporterId,
      STUDIO_VERSION,
    );

    let response: Awaited<ReturnType<typeof submitReport>>;
    try {
      response = await submitReport(config, report);
    } catch (error) {
      const failure = asStudioError(error, "unknown", "Your report could not be sent.");
      await failSubmission(
        set,
        get,
        pending,
        failure.message,
        failure.code,
        isOffline(failure) || failure.code === "network.serverError" || failure.code === "network.rateLimited",
      );
      return;
    }

    const done = markSubmitted(
      pending,
      { issueNumber: response.issue.number, issueUrl: response.issue.url },
      issueStateFrom(response.issue),
    );
    set({
      submitting: false,
      records: upsertRecord(get().records, done),
      result: {
        issueNumber: response.issue.number,
        issueUrl: response.issue.url,
        alreadyFiled: response.alreadyFiled,
        linked: false,
        missingLabels: response.missingLabels,
      },
      view: "submitted",
    });
    await persist(get()).catch((error) => {
      studioLog.error(
        FEEDBACK_SCOPE,
        `Issue ${response.issue.number} was filed but its local status could not be saved: ${describe(error)}`,
      );
    });
    studioLog.info(FEEDBACK_SCOPE, `Report filed as issue ${response.issue.number}`);
  },

  /**
   * The reporter recognised their problem in an existing issue.
   *
   * Nothing is filed. The local record points at the issue that already exists,
   * so My Reports still tracks it and still shows when it is fixed — which is
   * the thing they wanted from reporting it.
   */
  async linkExisting(candidate) {
    const state = get();
    const draft = state.draft;
    if (!draft) return;

    const record = existingRecord(state) ?? draftRecord(draft, new Date(), newId());
    const linked = markLinked(
      withDraft(record, draft),
      { issueNumber: candidate.number, issueUrl: candidate.url },
      issueStateFrom({
        number: candidate.number,
        url: candidate.url,
        title: "",
        state: candidate.state,
        labels: candidate.labels,
        milestone: "",
        updatedAt: "",
      }),
    );
    set({
      records: upsertRecord(get().records, linked),
      activeRecordId: linked.localId,
      result: {
        issueNumber: candidate.number,
        issueUrl: candidate.url,
        alreadyFiled: true,
        linked: true,
        missingLabels: [],
      },
      view: "submitted",
      submitting: false,
    });
    await persist(get()).catch((error) => {
      studioLog.error(FEEDBACK_SCOPE, `Could not save the linked report: ${describe(error)}`);
    });
  },

  /**
   * The fallback that needs no service at all.
   *
   * Opens the repository's new-issue page with everything except the
   * diagnostics filled in. The diagnostics are left out deliberately: they
   * would travel through a URL, and a URL is the one place a payload is
   * guaranteed to be logged by everything it passes through.
   */
  async openGithubFallback() {
    const state = get();
    const draft = state.draft;
    if (!draft) {
      await openExternal(newIssueUrl()).catch(() => {});
      return;
    }
    const record = existingRecord(state) ?? draftRecord(draft, new Date(), newId());
    const diagnostics = state.diagnostics ?? (await collectDiagnostics(
      draft.target,
      draft.diagnosticChoices,
      0,
    ).catch(() => emptyDiagnostics()));

    const report = reportFrom(record, draft, diagnostics, "", STUDIO_VERSION);
    const url = prefilledIssueUrl(newIssueUrl(), report, labelsForReport(report));
    try {
      await openExternal(url);
    } catch (error) {
      studioLog.error(FEEDBACK_SCOPE, `Could not open GitHub: ${describe(error)}`);
    }
  },

  // -- closing ------------------------------------------------------------

  close() {
    set({
      view: "closed",
      inspecting: false,
      hovered: null,
      targetElement: null,
      contextMenu: null,
      duplicates: [],
      duplicatesChecked: false,
    });
  },

  /**
   * The close every panel with a draft behind it uses.
   *
   * Somebody who has written three paragraphs about a bug and then pressed
   * Escape has not asked to throw them away. The prompt only appears when
   * there is something to lose.
   */
  async requestClose() {
    if (!get().hasUnsavedContent()) {
      get().close();
      return;
    }
    const answer = await chooseDialog({
      title: "Save this report as a draft?",
      message: "You have not sent it yet. A draft stays in My reports until you finish it.",
      options: [
        { key: "save", label: "Save as draft", variant: "primary" },
        { key: "discard", label: "Discard it", variant: "danger" },
      ],
      cancelLabel: "Keep writing",
    });
    if (answer === "save") await get().saveDraftAndClose();
    else if (answer === "discard") await get().discardAndClose();
  },

  hasUnsavedContent() {
    const draft = get().draft;
    if (!draft) return false;
    if (get().view === "submitted") return false;
    return Boolean(
      draft.description.trim() ||
        draft.title.trim() ||
        draft.expectedBehavior.trim() ||
        draft.reproductionSteps.trim() ||
        draft.benefit.trim() ||
        draft.attachments.length > 0,
    );
  },

  async saveDraftAndClose() {
    const state = get();
    const draft = state.draft;
    if (draft) {
      if (credentialProblems(draft).length > 0) {
        set({
          failure: {
            message: "Remove the credential-like text before this draft can be saved.",
            code: "validation.failed",
            retryable: false,
            saved: false,
          },
          view: "failed",
        });
        return;
      }
      const record = existingRecord(state) ?? draftRecord(draft, new Date(), newId());
      set({ records: upsertRecord(state.records, withDraft(record, draft)) });
      try {
        await persist(get());
      } catch (error) {
        set({
          failure: {
            message:
              "DinoDepot could not save this draft on this computer. Keep the app open and try again.",
            code: "save.failed",
            retryable: true,
            saved: false,
          },
          view: "failed",
        });
        return;
      }
    }
    set({ draft: null, activeRecordId: "" });
    get().close();
  },

  async discardAndClose() {
    const state = get();
    // A record that only ever existed as this draft goes with it. One that has
    // been submitted before — a retry being abandoned — stays.
    const record = existingRecord(state);
    if (record && record.status === "draft") {
      set({ records: removeRecord(state.records, record.localId) });
      await persist(get());
    }
    set({ draft: null, activeRecordId: "" });
    get().close();
  },

  // -- the report list ----------------------------------------------------

  setFilter(filter) {
    set({ filter });
  },

  /**
   * Brings My Reports up to date.
   *
   * Only on request, and only when the last refresh is old enough — GitHub is
   * not something to poll, and a list that refetches on every render would
   * exhaust a rate limit shared by everybody using this build.
   */
  async refreshReports(options = {}) {
    const state = get();
    if (state.refreshing) return;
    const config = state.config();
    if (!canSubmitDirectly(config)) return;

    const numbers = issuesToRefresh(state.records);
    if (numbers.length === 0) return;
    if (!options.force && !needsRefresh(state.lastSyncAt, config.statusCacheMs)) return;

    set({ refreshing: true });
    try {
      const summaries: Awaited<ReturnType<typeof lookupIssues>> = [];
      // Batched, because the service caps a lookup at fifty and a long history
      // must not silently return only its first page.
      for (let at = 0; at < numbers.length; at += 50) {
        summaries.push(...(await lookupIssues(config, numbers.slice(at, at + 50))));
      }
      const byNumber = new Map(summaries.map((issue) => [issue.number, issue]));
      const records = get().records.map((record) => {
        const issue = record.github ? byNumber.get(record.github.issueNumber) : undefined;
        return issue ? withIssueState(record, issueStateFrom(issue)) : record;
      });
      set({ records, lastSyncAt: new Date().toISOString(), refreshing: false });
      await persist(get());
    } catch (error) {
      // Offline is the normal case here, and it is not worth an error toast on
      // a page somebody opened to read.
      studioLog.warn(FEEDBACK_SCOPE, `Could not refresh reports: ${describe(error)}`);
      set({ refreshing: false });
    }
  },

  resumeRecord(localId) {
    const record = get().records.find((entry) => entry.localId === localId);
    if (!record?.draft || !canRetry(record.status)) return;
    set({
      draft: record.draft,
      activeRecordId: record.localId,
      view: "form",
      returnTo: "form",
      duplicates: [],
      // A retry of something already checked should not stop to check again.
      duplicatesChecked: record.status === "submission_failed",
      failure: null,
      result: null,
      diagnostics: record.diagnostics,
      // A resumed record has a safe snapshot, not a live DOM reference.
      targetElement: null,
    });
  },

  async deleteRecord(localId) {
    set({ records: removeRecord(get().records, localId) });
    if (get().activeRecordId === localId) set({ activeRecordId: "", draft: null });
    await persist(get());
  },

  async openIssue(localId) {
    const record = get().records.find((entry) => entry.localId === localId);
    if (!record?.github?.issueUrl) return;
    await openExternal(record.github.issueUrl).catch((error) => {
      studioLog.error(FEEDBACK_SCOPE, `Could not open the issue: ${describe(error)}`);
    });
  },

  // -- the context menu ---------------------------------------------------

  openContextMenu(state) {
    set({ contextMenu: state });
  },

  closeContextMenu() {
    set({ contextMenu: null });
  },

  async debugInfo(target) {
    const diagnostics = await collectDiagnostics(
      target,
      { app: true, component: true, logs: false, project: true },
      0,
    ).catch(() => emptyDiagnostics());
    return debugInfoText(diagnostics, target);
  },

  // -- settings -----------------------------------------------------------

  async setSettings(patch) {
    const previous = get().settings;
    set({ settings: { ...previous, ...patch } });
    try {
      await persist(get());
    } catch (error) {
      set({ settings: previous });
      studioLog.error(FEEDBACK_SCOPE, `Could not save feedback settings: ${describe(error)}`);
    }
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function existingRecord(state: {
  activeRecordId: string;
  records: LocalFeedbackRecord[];
}): LocalFeedbackRecord | null {
  if (!state.activeRecordId) return null;
  return state.records.find((record) => record.localId === state.activeRecordId) ?? null;
}

/** The whole store's persistable half, written as one document. */
async function persist(state: FeedbackStoreState): Promise<void> {
  await saveFeedbackState({
    schemaVersion: 1,
    reporterId: state.reporterId,
    records: state.records,
    lastSyncAt: state.lastSyncAt,
    settings: state.settings,
  });
}

async function failSubmission(
  set: (partial: Partial<FeedbackStoreState>) => void,
  get: () => FeedbackStoreState,
  record: LocalFeedbackRecord,
  message: string,
  code: string,
  retryable: boolean,
): Promise<void> {
  const failed = markFailed(record, message, code);
  set({
    submitting: false,
    records: upsertRecord(get().records, failed),
    failure: { message, code, retryable, saved: true },
    view: "failed",
  });
  await persist(get()).catch((error) => {
    studioLog.error(FEEDBACK_SCOPE, `Could not save the failed report status: ${describe(error)}`);
  });
  studioLog.error(FEEDBACK_SCOPE, `Report not sent: ${message}`, code);
}

function describe(error: unknown): string {
  if (isStudioError(error)) return `${error.code}: ${error.message}`;
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

/** Only ever used when collection itself failed. Says nothing, truthfully. */
function emptyDiagnostics(): FeedbackDiagnostics {
  return {
    app: { version: STUDIO_VERSION, runtime: "desktop" },
    environment: { os: "", osVersion: "", architecture: "", webview: "", viewport: "" },
    navigation: { route: "", page: "" },
    component: null,
    project: null,
    logs: [],
  };
}
