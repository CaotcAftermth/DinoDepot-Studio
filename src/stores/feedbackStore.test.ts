import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Feedback Center's behaviour, tested where it lives.
 *
 * Everything a person can do - open the launcher, switch report type, start
 * and cancel the picker, review diagnostics, hit a duplicate, submit, fail,
 * retry, save a draft - is a transition on this store, and the components
 * above it only render what it holds. So these are the interaction tests, run
 * in Node, with no DOM and no renderer involved.
 */

const submitReport = vi.fn();
const searchDuplicates = vi.fn();
const lookupIssues = vi.fn();
const collectDiagnostics = vi.fn();
const saveFeedbackState = vi.fn();
const loadFeedbackState = vi.fn();
const openExternal = vi.fn();
const chooseDialog = vi.fn();

vi.mock("../services/feedback/api", () => ({
  submitReport: (...args: unknown[]) => submitReport(...args),
  searchDuplicates: (...args: unknown[]) => searchDuplicates(...args),
  lookupIssues: (...args: unknown[]) => lookupIssues(...args),
  checkHealth: vi.fn(),
}));

vi.mock("../services/feedback/collect", () => ({
  collectDiagnostics: (...args: unknown[]) => collectDiagnostics(...args),
}));

vi.mock("../services/feedback/localStore", () => ({
  loadFeedbackState: (...args: unknown[]) => loadFeedbackState(...args),
  saveFeedbackState: (...args: unknown[]) => saveFeedbackState(...args),
}));

vi.mock("../services/openExternal", () => ({
  openExternal: (...args: unknown[]) => openExternal(...args),
}));

vi.mock("../components/confirm", () => ({
  chooseDialog: (...args: unknown[]) => chooseDialog(...args),
}));

import { useFeedbackStore } from "./feedbackStore";
import { StudioError } from "../model/errors";
import { emptyFeedbackState, type FeedbackDiagnostics } from "../model/feedback/types";
import { feedbackTarget } from "../model/feedback/targets";
import { snapshotFor } from "../model/feedback/resolveTarget";

const SERVICE = "https://feedback.example.com";

const diagnostics: FeedbackDiagnostics = {
  app: { version: "0.6.0", runtime: "desktop" },
  environment: { os: "Windows 11", osVersion: "", architecture: "", webview: "", viewport: "" },
  navigation: { route: "/production", page: "Production Rules" },
  component: null,
  project: null,
  logs: [],
};

const QUANTITY = snapshotFor({
  getAttribute: (name) => feedbackTarget("production-rule-cycle-quantity")[
    name as keyof ReturnType<typeof feedbackTarget>
  ] ?? null,
  parentElement: null,
});

function issue(number = 184) {
  return {
    number,
    url: `https://github.com/o/r/issues/${number}`,
    title: "[Bug] Quantity of zero",
    state: "open" as const,
    labels: ["bug", "needs-triage"],
    milestone: "",
    updatedAt: "2026-08-22T09:00:00Z",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  collectDiagnostics.mockResolvedValue(diagnostics);
  saveFeedbackState.mockResolvedValue(undefined);
  loadFeedbackState.mockResolvedValue({
    ...emptyFeedbackState(),
    reporterId: "dd-install-11111111-2222-4333-8444-555555555555",
  });
  searchDuplicates.mockResolvedValue({ candidates: [] });
  submitReport.mockResolvedValue({ issue: issue(), alreadyFiled: false, missingLabels: [] });
  lookupIssues.mockResolvedValue([]);
  openExternal.mockResolvedValue(undefined);

  useFeedbackStore.setState({
    ready: false,
    view: "closed",
    returnTo: "form",
    inspecting: false,
    hovered: null,
    targetElement: null,
    draft: null,
    activeRecordId: "",
    records: [],
    reporterId: "dd-install-11111111-2222-4333-8444-555555555555",
    settings: { enabled: true, apiBaseUrl: SERVICE },
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
  });
});

const store = () => useFeedbackStore.getState();

function writeABug(description = "Setting the quantity to zero deletes the creature.") {
  store().reportBug();
  store().updateDraft({ description });
}

// ---------------------------------------------------------------------------

describe("opening", () => {
  it("reads the stored history once", async () => {
    await store().init();
    expect(store().ready).toBe(true);
    await store().init();
    expect(loadFeedbackState).toHaveBeenCalledTimes(1);
  });

  it("opens the launcher", () => {
    store().openLauncher();
    expect(store().view).toBe("launcher");
  });

  it("starts each kind of report with an empty draft of that kind", () => {
    store().reportBug();
    expect(store().view).toBe("form");
    expect(store().draft?.type).toBe("bug");

    store().suggestImprovement();
    expect(store().draft?.type).toBe("suggestion");
    expect(store().draft?.description).toBe("");

    store().requestFeature();
    expect(store().draft?.type).toBe("feature_request");
  });

  /** The right-click path: the component is already selected when the form opens. */
  it("carries a preselected target into the report", () => {
    const targetElement = {} as Element;
    store().reportBug({ target: QUANTITY, targetElement });
    expect(store().draft?.target?.id).toBe("production-rule-cycle-quantity");
    expect(store().targetElement).toBe(targetElement);
  });

  it("clears a previous failure when a new report starts", () => {
    useFeedbackStore.setState({
      failure: { message: "old", code: "unknown", retryable: true, saved: true },
    });
    store().reportBug();
    expect(store().failure).toBeNull();
  });
});

describe("the inspector", () => {
  it("hides the form rather than discarding it", () => {
    writeABug();
    store().startInspector();
    expect(store().inspecting).toBe(true);
    expect(store().view).toBe("closed");
    expect(store().draft?.description).toContain("quantity");
  });

  it("puts the form back and fills in the area when something is picked", () => {
    writeABug();
    store().startInspector();
    const targetElement = {} as Element;
    store().pickTarget(QUANTITY, targetElement);
    expect(store().inspecting).toBe(false);
    expect(store().view).toBe("form");
    expect(store().draft?.target?.id).toBe("production-rule-cycle-quantity");
    expect(store().targetElement).toBe(targetElement);
  });

  it("drops the transient element when the selected area is removed", () => {
    writeABug();
    store().setTarget(QUANTITY, {} as Element);
    store().setTarget(null);
    expect(store().targetElement).toBeNull();
  });

  it("puts the form back unchanged when it is cancelled", () => {
    writeABug();
    store().setTarget(null);
    store().startInspector();
    store().cancelInspector();
    expect(store().view).toBe("form");
    expect(store().draft?.target).toBeNull();
  });

  it("tracks what the pointer is over, and only while inspecting", () => {
    writeABug();
    store().hoverTarget(QUANTITY);
    expect(store().hovered).toBeNull();
    store().startInspector();
    store().hoverTarget(QUANTITY);
    expect(store().hovered?.id).toBe("production-rule-cycle-quantity");
    store().cancelInspector();
    expect(store().hovered).toBeNull();
  });

  it("returns to whichever panel started it", () => {
    writeABug();
    useFeedbackStore.setState({ view: "duplicates" });
    store().startInspector();
    store().cancelInspector();
    expect(store().view).toBe("duplicates");
  });
});

describe("diagnostics", () => {
  it("builds the bundle when the panel opens", async () => {
    writeABug();
    await store().openDiagnostics();
    expect(store().view).toBe("diagnostics");
    expect(store().diagnostics?.app.version).toBe("0.6.0");
  });

  it("rebuilds when a category is toggled, rather than hiding a row", async () => {
    writeABug();
    await store().openDiagnostics();
    collectDiagnostics.mockClear();
    store().setDiagnosticChoice("project", true);
    expect(store().draft?.diagnosticChoices.project).toBe(true);
    await vi.waitFor(() => expect(collectDiagnostics).toHaveBeenCalled());
    expect(collectDiagnostics.mock.calls[0][1].project).toBe(true);
  });

  it("shows the panel even when collection fails", async () => {
    writeABug();
    collectDiagnostics.mockRejectedValueOnce(new Error("no"));
    await store().openDiagnostics();
    expect(store().view).toBe("diagnostics");
    expect(store().diagnostics).toBeNull();
  });

  it("goes back to the form", async () => {
    writeABug();
    await store().openDiagnostics();
    store().backToForm();
    expect(store().view).toBe("form");
  });
});

describe("submitting", () => {
  it("refuses to send an incomplete report and stays on the form", async () => {
    store().reportBug();
    store().updateDraft({ description: "x" });
    await store().submit();
    expect(submitReport).not.toHaveBeenCalled();
    expect(store().view).toBe("form");
  });

  it("files the report and records the issue", async () => {
    writeABug();
    await store().submitOrCheck();
    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(store().view).toBe("submitted");
    expect(store().result?.issueNumber).toBe(184);
    const record = store().records[0];
    expect(record.status).toBe("submitted");
    expect(record.github?.issueNumber).toBe(184);
  });

  it("writes the record before the network call, so a crash loses nothing", async () => {
    writeABug();
    let statusWhenSending = "";
    submitReport.mockImplementationOnce(async () => {
      statusWhenSending = useFeedbackStore.getState().records[0].status;
      return { issue: issue(), alreadyFiled: false, missingLabels: [] };
    });
    await store().submitOrCheck();
    expect(statusWhenSending).toBe("pending");
    expect(saveFeedbackState).toHaveBeenCalled();
  });

  it("does not send when the pending report cannot be saved", async () => {
    writeABug();
    saveFeedbackState.mockRejectedValueOnce(new Error("disk full"));
    await store().submitOrCheck();
    expect(submitReport).not.toHaveBeenCalled();
    expect(store().view).toBe("failed");
    expect(store().failure).toEqual(
      expect.objectContaining({ code: "save.failed", saved: false }),
    );
  });

  it("sends the diagnostics the reporter reviewed", async () => {
    writeABug();
    await store().openDiagnostics();
    await store().submitOrCheck();
    expect(submitReport.mock.calls[0][1].diagnostics).toEqual(diagnostics);
  });

  it("keeps the report and says so when sending fails", async () => {
    writeABug();
    submitReport.mockRejectedValueOnce(
      new StudioError("network.offline", "DinoDepot cannot reach the feedback service."),
    );
    await store().submitOrCheck();
    expect(store().view).toBe("failed");
    expect(store().failure?.retryable).toBe(true);
    const record = store().records[0];
    expect(record.status).toBe("submission_failed");
    expect(record.draft?.description).toContain("quantity");
  });

  it("does not offer a retry for a refusal that would just fail again", async () => {
    writeABug();
    submitReport.mockRejectedValueOnce(
      new StudioError("validation.failed", "That report was refused."),
    );
    await store().submitOrCheck();
    expect(store().failure?.retryable).toBe(false);
  });

  /** The double-click case: one report, one id, one issue. */
  it("reuses the report id on a retry", async () => {
    writeABug();
    submitReport.mockRejectedValueOnce(new StudioError("network.offline", "offline"));
    await store().submitOrCheck();
    const firstId = submitReport.mock.calls[0][1].id;

    await store().submit();
    expect(submitReport.mock.calls[1][1].id).toBe(firstId);
    expect(store().records.length).toBe(1);
  });

  it("tells the reporter when the service had already filed it", async () => {
    writeABug();
    submitReport.mockResolvedValueOnce({
      issue: issue(),
      alreadyFiled: true,
      missingLabels: [],
    });
    await store().submitOrCheck();
    expect(store().result?.alreadyFiled).toBe(true);
    expect(store().records.length).toBe(1);
  });

  it("says which labels the repository is missing", async () => {
    writeABug();
    submitReport.mockResolvedValueOnce({
      issue: issue(),
      alreadyFiled: false,
      missingLabels: ["area:production-rules"],
    });
    await store().submitOrCheck();
    expect(store().result?.missingLabels).toEqual(["area:production-rules"]);
  });

  it("refuses to send twice at once", async () => {
    writeABug();
    const both = [store().submitOrCheck(), store().submitOrCheck()];
    await Promise.all(both);
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it("keeps the report locally when no service is configured", async () => {
    await store().setSettings({ apiBaseUrl: "" });
    writeABug();
    await store().submit();
    expect(submitReport).not.toHaveBeenCalled();
    expect(store().view).toBe("failed");
    expect(store().records[0].status).toBe("submission_failed");
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(new URL(openExternal.mock.calls[0][0] as string).pathname).toContain("/issues/new");
  });
});

describe("duplicates", () => {
  const candidate = {
    number: 143,
    title: "Quantity field removes production entry",
    body: "production-rule-cycle-quantity removes the entry at zero",
    state: "open" as const,
    labels: ["bug", "area:production-rules"],
    url: "https://github.com/o/r/issues/143",
    updatedAt: "2026-08-01T00:00:00Z",
  };

  it("shows candidates before submitting, rather than filing straight away", async () => {
    store().reportBug({ target: QUANTITY });
    store().updateDraft({ description: "Quantity of zero removes the creature entry." });
    searchDuplicates.mockResolvedValueOnce({ candidates: [candidate] });
    await store().submitOrCheck();
    expect(store().view).toBe("duplicates");
    expect(store().duplicates[0].number).toBe(143);
    expect(submitReport).not.toHaveBeenCalled();
  });

  it("submits straight through when nothing resembles it", async () => {
    writeABug();
    await store().submitOrCheck();
    expect(searchDuplicates).toHaveBeenCalled();
    expect(submitReport).toHaveBeenCalled();
  });

  it("does not leak the selected component into duplicate search when it is disabled", async () => {
    store().reportBug({ target: QUANTITY });
    store().updateDraft({ description: "Quantity of zero removes the creature entry." });
    store().setDiagnosticChoice("component", false);
    await store().submitOrCheck();
    expect(searchDuplicates).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ componentId: "", area: "" }),
    );
  });

  /** Nobody should be stopped reporting a bug because the search broke. */
  it("submits anyway when the search fails", async () => {
    writeABug();
    searchDuplicates.mockRejectedValueOnce(new Error("search is down"));
    await store().submitOrCheck();
    expect(submitReport).toHaveBeenCalled();
    expect(store().view).toBe("submitted");
  });

  it("lets the reporter submit anyway from the list", async () => {
    store().reportBug({ target: QUANTITY });
    store().updateDraft({ description: "Quantity of zero removes the creature entry." });
    searchDuplicates.mockResolvedValueOnce({ candidates: [candidate] });
    await store().submitOrCheck();
    await store().submit();
    expect(submitReport).toHaveBeenCalledTimes(1);
    expect(store().view).toBe("submitted");
  });

  it("links to an existing issue without filing a second one", async () => {
    writeABug();
    await store().linkExisting({
      number: 143,
      url: candidate.url,
      state: "open",
      labels: candidate.labels,
    });
    expect(submitReport).not.toHaveBeenCalled();
    expect(store().view).toBe("submitted");
    expect(store().result?.linked).toBe(true);
    expect(store().records[0].status).toBe("linked_existing");
    expect(store().records[0].github?.issueNumber).toBe(143);
  });

  it("searches again after the report is edited", async () => {
    store().reportBug({ target: QUANTITY });
    store().updateDraft({ description: "Quantity of zero removes the creature entry." });
    searchDuplicates.mockResolvedValueOnce({ candidates: [candidate] });
    await store().submitOrCheck();
    expect(store().duplicatesChecked).toBe(true);

    store().updateDraft({ description: "Actually it is the interval that breaks." });
    expect(store().duplicatesChecked).toBe(false);
    expect(store().duplicates).toEqual([]);
  });
});

describe("drafts", () => {
  it("closes without asking when nothing was written", async () => {
    store().reportBug();
    await store().requestClose();
    expect(chooseDialog).not.toHaveBeenCalled();
    expect(store().view).toBe("closed");
  });

  it("offers to save what was written", async () => {
    writeABug();
    chooseDialog.mockResolvedValueOnce("save");
    await store().requestClose();
    expect(store().view).toBe("closed");
    expect(store().records.length).toBe(1);
    expect(store().records[0].status).toBe("draft");
    expect(saveFeedbackState).toHaveBeenCalled();
  });

  it("keeps a draft open when it cannot be saved", async () => {
    writeABug();
    saveFeedbackState.mockRejectedValueOnce(new Error("disk full"));
    await store().saveDraftAndClose();
    expect(store().view).toBe("failed");
    expect(store().draft).not.toBeNull();
    expect(store().failure?.saved).toBe(false);
  });

  it("does not persist credential-like text in a draft", async () => {
    writeABug("token=ghp_abcdefghijklmnopqrstuvwxyz012345");
    saveFeedbackState.mockClear();
    await store().saveDraftAndClose();
    expect(saveFeedbackState).not.toHaveBeenCalled();
    expect(store().view).toBe("failed");
    expect(store().draft).not.toBeNull();
  });

  it("throws it away when that is what was chosen", async () => {
    writeABug();
    chooseDialog.mockResolvedValueOnce("discard");
    await store().requestClose();
    expect(store().records).toEqual([]);
    expect(store().draft).toBeNull();
  });

  it("keeps writing when the prompt is dismissed", async () => {
    writeABug();
    chooseDialog.mockResolvedValueOnce(null);
    await store().requestClose();
    expect(store().view).toBe("form");
    expect(store().draft?.description).toContain("quantity");
  });

  it("reopens a saved draft where it was left", async () => {
    writeABug("Setting the quantity to zero deletes the creature entry.");
    store().setTarget(QUANTITY);
    chooseDialog.mockResolvedValueOnce("save");
    await store().requestClose();

    const localId = store().records[0].localId;
    store().resumeRecord(localId);
    expect(store().view).toBe("form");
    expect(store().draft?.description).toContain("quantity");
    expect(store().draft?.target?.id).toBe("production-rule-cycle-quantity");
    expect(store().activeRecordId).toBe(localId);
  });

  it("does not re-check duplicates when resuming a draft it never sent", async () => {
    writeABug();
    chooseDialog.mockResolvedValueOnce("save");
    await store().requestClose();
    store().resumeRecord(store().records[0].localId);
    expect(store().duplicatesChecked).toBe(false);
  });

  it("keeps a submitted record when a retry is abandoned", async () => {
    writeABug();
    submitReport.mockRejectedValueOnce(new StudioError("network.offline", "offline"));
    await store().submitOrCheck();
    store().resumeRecord(store().records[0].localId);
    chooseDialog.mockResolvedValueOnce("discard");
    await store().requestClose();
    expect(store().records.length).toBe(1);
  });
});

describe("my reports", () => {
  async function withSubmittedReport() {
    writeABug();
    await store().submitOrCheck();
  }

  it("refreshes the issues it knows about", async () => {
    await withSubmittedReport();
    lookupIssues.mockResolvedValueOnce([
      { ...issue(), state: "closed" as const, labels: ["fixed"], milestone: "v0.7.0" },
    ]);
    await store().refreshReports({ force: true });
    expect(lookupIssues).toHaveBeenCalledWith(expect.anything(), [184]);
    expect(store().records[0].lastKnownIssueState?.state).toBe("closed");
  });

  it("does not ask again inside the cache window", async () => {
    await withSubmittedReport();
    await store().refreshReports({ force: true });
    lookupIssues.mockClear();
    await store().refreshReports();
    expect(lookupIssues).not.toHaveBeenCalled();
  });

  it("stays quiet when the refresh fails", async () => {
    await withSubmittedReport();
    lookupIssues.mockRejectedValueOnce(new Error("offline"));
    await store().refreshReports({ force: true });
    expect(store().refreshing).toBe(false);
    expect(store().records[0].status).toBe("submitted");
  });

  it("asks nothing when there is nothing submitted", async () => {
    await store().refreshReports({ force: true });
    expect(lookupIssues).not.toHaveBeenCalled();
  });

  it("opens an issue in the browser", async () => {
    await withSubmittedReport();
    await store().openIssue(store().records[0].localId);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/o/r/issues/184");
  });

  it("deletes a record", async () => {
    await withSubmittedReport();
    await store().deleteRecord(store().records[0].localId);
    expect(store().records).toEqual([]);
  });
});

describe("the GitHub fallback", () => {
  it("opens a prefilled issue with no diagnostics in the URL", async () => {
    writeABug();
    await store().openGithubFallback();
    const url = new URL(openExternal.mock.calls[0][0] as string);
    expect(url.pathname).toContain("/issues/new");
    const body = url.searchParams.get("body") ?? "";
    expect(body).toContain("## What happened");
    expect(body).not.toContain("```json");
    expect(url.searchParams.get("labels")).toContain("bug");
  });

  it("still opens the repository with no draft at all", async () => {
    await store().openGithubFallback();
    expect(openExternal).toHaveBeenCalled();
  });
});

describe("the context menu", () => {
  it("opens and closes with what was clicked", () => {
    store().openContextMenu({
      x: 10,
      y: 20,
      target: QUANTITY,
      targetElement: null,
      editable: false,
    });
    expect(store().contextMenu?.target?.id).toBe("production-rule-cycle-quantity");
    store().closeContextMenu();
    expect(store().contextMenu).toBeNull();
  });

  it("produces a debug summary with no credentials or project data in it", async () => {
    const text = await store().debugInfo(QUANTITY);
    expect(text).toContain("DinoDepot Studio 0.6.0");
    expect(text).toContain("production-rule-cycle-quantity");
    expect(text).not.toContain("ghp_");
    expect(text).not.toContain("dd-install-");
  });

  it("closes when a report is started from it", () => {
    store().openContextMenu({
      x: 1,
      y: 1,
      target: QUANTITY,
      targetElement: null,
      editable: false,
    });
    store().reportBug({ target: QUANTITY });
    expect(store().contextMenu).toBeNull();
  });
});

describe("error boundary reporting", () => {
  it("opens a bug report describing the error", () => {
    store().reportError(new TypeError("cycle is undefined"), "Production Rules");
    expect(store().view).toBe("form");
    expect(store().draft?.type).toBe("bug");
    expect(store().draft?.description).toContain("TypeError: cycle is undefined");
    expect(store().draft?.description).toContain("Production Rules");
    expect(store().draft?.severity).toBe("major");
  });

  it("sanitizes the stack, so no path from the machine is carried", () => {
    const error = new Error("boom");
    error.stack = [
      "Error: boom",
      "    at RuleEditor (C:\\Users\\jane\\app\\assets\\index.js:1:2)",
      "    at renderWithHooks (C:\\Users\\jane\\app\\assets\\vendor.js:3:4)",
    ].join("\n");
    store().reportError(error, "Production Rules");
    const description = store().draft?.description ?? "";
    expect(description).not.toContain("jane");
    expect(description).toContain("«path»");
  });

  it("copes with something that is not an Error", () => {
    store().reportError("just a string");
    expect(store().draft?.description).toContain("just a string");
  });
});

describe("settings", () => {
  it("stores the service address and uses it", async () => {
    await store().setSettings({ apiBaseUrl: "https://other.example.com" });
    expect(store().config().apiBaseUrl).toBe("https://other.example.com");
    expect(saveFeedbackState).toHaveBeenCalled();
  });

  /** An unusable address is the same as none, rather than a broken submit. */
  it("ignores an address that is not usable", async () => {
    await store().setSettings({ apiBaseUrl: "http://insecure.example.com" });
    expect(store().config().apiBaseUrl).toBe("");
  });

  it("can be switched off entirely", async () => {
    await store().setSettings({ enabled: false });
    expect(store().config().enabled).toBe(false);
  });
});
