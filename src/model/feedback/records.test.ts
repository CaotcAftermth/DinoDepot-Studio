import { describe, expect, it } from "vitest";
import {
  MIN_DESCRIPTION,
  canRetry,
  draftRecord,
  ensureReporterId,
  isReporterId,
  markFailed,
  markLinked,
  markPending,
  markSubmitted,
  migrateFeedbackState,
  newReporterId,
  pruneRecords,
  recordTitle,
  recordsForProject,
  removeRecord,
  reportFrom,
  upsertRecord,
  validateDraft,
  withDraft,
  withIssueState,
} from "./records";
import {
  FEEDBACK_STATE_VERSION,
  IssueStateSchema,
  LocalFeedbackRecordSchema,
  emptyDraft,
  emptyFeedbackState,
  type FeedbackDiagnostics,
  type FeedbackDraft,
  type LocalFeedbackRecord,
} from "./types";

const diagnostics: FeedbackDiagnostics = {
  app: { version: "0.6.0", runtime: "desktop" },
  environment: { os: "Windows 11", osVersion: "", architecture: "", webview: "", viewport: "" },
  navigation: { route: "/production", page: "Production Rules" },
  component: null,
  project: null,
  logs: [],
};

function bugDraft(overrides: Partial<FeedbackDraft> = {}): FeedbackDraft {
  return {
    ...emptyDraft("bug"),
    description: "Setting the quantity to zero deletes the creature entry.",
    ...overrides,
  };
}

describe("the installation id", () => {
  it("is random, prefixed, and recognisable", () => {
    const id = newReporterId();
    expect(id.startsWith("dd-install-")).toBe(true);
    expect(isReporterId(id)).toBe(true);
    expect(newReporterId()).not.toBe(id);
  });

  it("is generated once and then left alone", () => {
    const first = ensureReporterId(emptyFeedbackState());
    expect(ensureReporterId(first).reporterId).toBe(first.reporterId);
  });

  it("replaces something that is not one", () => {
    const state = { ...emptyFeedbackState(), reporterId: "steam:76561198000000000" };
    expect(ensureReporterId(state).reporterId).not.toContain("7656");
    expect(isReporterId(ensureReporterId(state).reporterId)).toBe(true);
  });
});

describe("reading the stored file", () => {
  it("never throws, whatever is in it", () => {
    for (const input of [null, "", "not json", "[]", "3", '{"records":"nope"}']) {
      expect(() => migrateFeedbackState(input)).not.toThrow();
      expect(isReporterId(migrateFeedbackState(input).reporterId)).toBe(true);
    }
  });

  it("gives an installation id to a file that had none", () => {
    expect(isReporterId(migrateFeedbackState("{}").reporterId)).toBe(true);
  });

  /** One bad entry must not cost the whole history. */
  it("keeps the records it can parse and drops the ones it cannot", () => {
    const good = draftRecord(bugDraft());
    const state = migrateFeedbackState(
      JSON.stringify({
        schemaVersion: 1,
        reporterId: "dd-install-11111111-2222-4333-8444-555555555555",
        records: [good, { localId: "broken" }, { nonsense: true }],
      }),
    );
    expect(state.records.length).toBe(1);
    expect(state.records[0].localId).toBe(good.localId);
  });

  it("reads a file from a newer build at this build's version", () => {
    const state = migrateFeedbackState(
      JSON.stringify({ schemaVersion: 99, reporterId: "", records: [] }),
    );
    expect(state.schemaVersion).toBe(FEEDBACK_STATE_VERSION);
  });

  it("keeps the settings it finds", () => {
    const state = migrateFeedbackState(
      JSON.stringify({
        schemaVersion: 1,
        settings: { enabled: false, apiBaseUrl: "https://f.example.com" },
      }),
    );
    expect(state.settings.enabled).toBe(false);
    expect(state.settings.apiBaseUrl).toBe("https://f.example.com");
  });
});

describe("pruning", () => {
  function record(
    index: number,
    status: LocalFeedbackRecord["status"],
  ): LocalFeedbackRecord {
    return LocalFeedbackRecordSchema.parse({
      localId: `r${index}`,
      type: "bug",
      status,
      createdAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      updatedAt: `2026-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
    });
  }

  it("does nothing below the limit", () => {
    const records = [record(1, "submitted")];
    expect(pruneRecords(records, 10)).toBe(records);
  });

  /** A draft and a failed submission are both work nobody has seen the end of. */
  it("never drops anything unfinished", () => {
    const records = [
      record(1, "draft"),
      record(2, "submission_failed"),
      ...Array.from({ length: 10 }, (_, index) => record(index + 3, "submitted")),
    ];
    const kept = pruneRecords(records, 4);
    expect(kept.map((r) => r.localId)).toContain("r1");
    expect(kept.map((r) => r.localId)).toContain("r2");
    expect(kept.length).toBe(4);
  });

  it("drops the oldest resolved reports first", () => {
    const records = Array.from({ length: 6 }, (_, index) =>
      record(index + 1, "submitted"),
    );
    const kept = pruneRecords(records, 2).map((r) => r.localId);
    expect(kept).toEqual(["r5", "r6"]);
  });
});

describe("the record lifecycle", () => {
  it("starts as a draft with the title the issue would get", () => {
    const record = draftRecord(bugDraft());
    expect(record.status).toBe("draft");
    expect(record.title).toBe(recordTitle(bugDraft()));
    expect(record.title.startsWith("[Bug]")).toBe(true);
    expect(record.draft?.description).toContain("quantity");
  });

  it("keeps the title in step as the draft is edited", () => {
    const record = draftRecord(bugDraft());
    const edited = withDraft(record, bugDraft({ description: "Something else broke here." }));
    expect(edited.title).toContain("Something else broke here");
  });

  it("records what was sent before it is sent", () => {
    const pending = markPending(draftRecord(bugDraft()), diagnostics);
    expect(pending.status).toBe("pending");
    expect(pending.diagnostics?.app.version).toBe("0.6.0");
  });

  it("keeps the report, the message and the code when sending fails", () => {
    const failed = markFailed(
      markPending(draftRecord(bugDraft()), diagnostics),
      "DinoDepot cannot reach the feedback service right now.",
      "network.offline",
    );
    expect(failed.status).toBe("submission_failed");
    expect(failed.failureCode).toBe("network.offline");
    expect(failed.draft?.description).toContain("quantity");
    expect(canRetry(failed.status)).toBe(true);
  });

  it("records the issue when it succeeds", () => {
    const done = markSubmitted(
      markPending(draftRecord(bugDraft()), diagnostics),
      { issueNumber: 184, issueUrl: "https://github.com/o/r/issues/184" },
      IssueStateSchema.parse({ state: "open", labels: ["needs-triage"] }),
    );
    expect(done.status).toBe("submitted");
    expect(done.github?.issueNumber).toBe(184);
    expect(done.lastSyncedAt).not.toBe("");
    expect(canRetry(done.status)).toBe(false);
  });

  /** A screenshot already on the issue has no business staying on disk. */
  it("drops attachment bytes once the report has landed", () => {
    const withImage = bugDraft({
      attachments: [
        {
          id: "a1",
          fileName: "shot.webp",
          contentType: "image/webp",
          sizeBytes: 900000,
          dataB64: "AAAA".repeat(1000),
          url: "",
        },
      ],
    });
    const done = markSubmitted(draftRecord(withImage), {
      issueNumber: 1,
      issueUrl: "https://github.com/o/r/issues/1",
    });
    expect(done.draft?.attachments[0].dataB64).toBe("");
    expect(done.draft?.attachments[0].fileName).toBe("shot.webp");
  });

  it("links to an existing issue without filing anything", () => {
    const linked = markLinked(draftRecord(bugDraft()), {
      issueNumber: 143,
      issueUrl: "https://github.com/o/r/issues/143",
    });
    expect(linked.status).toBe("linked_existing");
    expect(linked.github?.issueNumber).toBe(143);
  });

  it("takes a status update from GitHub", () => {
    const done = markSubmitted(draftRecord(bugDraft()), {
      issueNumber: 1,
      issueUrl: "https://github.com/o/r/issues/1",
    });
    const updated = withIssueState(
      done,
      IssueStateSchema.parse({ state: "closed", labels: ["fixed"] }),
    );
    expect(updated.lastKnownIssueState?.state).toBe("closed");
    expect(updated.lastSyncedAt).not.toBe("");
  });

  it("replaces by id rather than appending twice", () => {
    const record = draftRecord(bugDraft());
    const list = upsertRecord([record], markFailed(record, "no", "x"));
    expect(list.length).toBe(1);
    expect(list[0].status).toBe("submission_failed");
    expect(removeRecord(list, record.localId)).toEqual([]);
  });
});

describe("validateDraft", () => {
  it("accepts a bug with only a description", () => {
    expect(validateDraft(bugDraft())).toEqual([]);
  });

  it("asks for a few words rather than accepting nothing", () => {
    expect(validateDraft(bugDraft({ description: "x" }))[0].field).toBe("description");
    expect("Setting quantity to 0 breaks it".length).toBeGreaterThan(MIN_DESCRIPTION);
  });

  /** Only feature requests ask for a title; the others derive one. */
  it("requires a name for a feature request and not for the others", () => {
    const feature = { ...emptyDraft("feature_request"), description: "It should do this thing." };
    expect(validateDraft(feature).some((p) => p.field === "title")).toBe(true);
    expect(validateDraft({ ...feature, title: "Spawn presets" })).toEqual([]);
    expect(
      validateDraft({ ...emptyDraft("suggestion"), description: "Search could match anywhere." }),
    ).toEqual([]);
  });

  it("refuses an email address in the contact field", () => {
    const problems = validateDraft(bugDraft({ contact: "jane@example.com" }));
    expect(problems[0].field).toBe("contact");
    expect(problems[0].message).toContain("published");
  });

  it("accepts a GitHub username with or without the at sign", () => {
    expect(validateDraft(bugDraft({ contact: "octocat" }))).toEqual([]);
    expect(validateDraft(bugDraft({ contact: "@octocat" }))).toEqual([]);
    expect(validateDraft(bugDraft({ contact: "not a username" })).length).toBe(1);
  });

  it("blocks credential-like text in every public report field", () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz012345";
    for (const field of [
      "title",
      "description",
      "expectedBehavior",
      "reproductionSteps",
      "benefit",
    ] as const) {
      const draft = bugDraft({ [field]: `${field}: ${token}` });
      expect(validateDraft(draft)).toContainEqual(
        expect.objectContaining({ field, kind: "credential" }),
      );
    }
  });
});

describe("reportFrom", () => {
  const record = draftRecord(bugDraft());

  it("uses the record's id, so a retry cannot file twice", () => {
    const first = reportFrom(record, bugDraft(), diagnostics, "dd-install-x", "0.6.0");
    const retry = reportFrom(record, bugDraft(), diagnostics, "dd-install-x", "0.6.0");
    expect(retry.id).toBe(first.id);
    expect(first.id).toBe(record.localId);
  });

  it("keeps the creation time of the first attempt", () => {
    expect(
      reportFrom(record, bugDraft(), diagnostics, "", "0.6.0").createdAt,
    ).toBe(record.createdAt);
  });

  it("strips the at sign from a contact, so the issue reads as a mention", () => {
    expect(
      reportFrom(record, bugDraft({ contact: "@octocat" }), diagnostics, "", "0.6.0")
        .contact,
    ).toBe("octocat");
  });

  it("drops severity from anything that is not a bug", () => {
    const suggestion = { ...emptyDraft("suggestion"), description: "x".repeat(20), severity: "major" as const };
    expect(reportFrom(record, suggestion, diagnostics, "", "0.6.0").severity).toBeNull();
  });

  it("omits the selected component when the reporter turns component diagnostics off", () => {
    const target = {
      id: "production-rule-cycle-quantity",
      name: "Production Cycle Quantity",
      area: "production-rules",
      hierarchy: ["Production Rules", "Production Cycle Quantity"],
      context: {},
    };
    const draft = bugDraft({
      target,
      diagnosticChoices: {
        ...bugDraft().diagnosticChoices,
        component: false,
      },
    });
    expect(reportFrom(record, draft, diagnostics, "", "0.6.0").target).toBeNull();
  });
});

/**
 * A report is written while working on one cluster and is not part of the
 * next one's history. The file stays machine-local either way — the scoping is
 * about what My Reports lists, not about where the bytes go.
 */
describe("recordsForProject", () => {
  const at = (projectId: string, localId: string) =>
    LocalFeedbackRecordSchema.parse({ localId, type: "bug", projectId });

  it("lists only the open project's reports", () => {
    const records = [at("p1", "a"), at("p2", "b"), at("p1", "c")];
    expect(recordsForProject(records, "p1").map((r) => r.localId)).toEqual([
      "a",
      "c",
    ]);
  });

  /**
   * The welcome screen has no project. A report written there must not attach
   * itself to whichever project is opened next — that is the behaviour this
   * replaced.
   */
  it("keeps a report written with no project out of every project", () => {
    const records = [at("", "welcome"), at("p1", "a")];
    expect(recordsForProject(records, "p1").map((r) => r.localId)).toEqual(["a"]);
    expect(recordsForProject(records, "").map((r) => r.localId)).toEqual([
      "welcome",
    ]);
  });

  /** Records written before the field existed load as belonging to none. */
  it("treats a record with no project id as unassigned", () => {
    const legacy = LocalFeedbackRecordSchema.parse({ localId: "old", type: "bug" });
    expect(legacy.projectId).toBe("");
    expect(recordsForProject([legacy], "p1")).toEqual([]);
  });

  it("stamps a new draft with the project it was written in", () => {
    const record = draftRecord(emptyDraft("bug"), new Date(), "id-1", "p9");
    expect(record.projectId).toBe("p9");
    expect(draftRecord(emptyDraft("bug")).projectId).toBe("");
  });
});
