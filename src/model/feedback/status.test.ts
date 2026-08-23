import { describe, expect, it } from "vitest";
import {
  fixVersion,
  friendlyStatus,
  issuesToRefresh,
  matchesFilter,
  needsRefresh,
  sortRecords,
  statusFromIssue,
} from "./status";
import {
  IssueStateSchema,
  LocalFeedbackRecordSchema,
  type IssueState,
  type LocalFeedbackRecord,
} from "./types";

function issue(overrides: Partial<IssueState> = {}): IssueState {
  return IssueStateSchema.parse({ state: "open", labels: [], ...overrides });
}

function record(overrides: Partial<LocalFeedbackRecord> = {}): LocalFeedbackRecord {
  return LocalFeedbackRecordSchema.parse({
    localId: "r1",
    type: "bug",
    status: "submitted",
    github: { issueNumber: 184, issueUrl: "https://github.com/o/r/issues/184" },
    ...overrides,
  });
}

describe("local status", () => {
  it("reads a draft as a draft, whatever GitHub thinks", () => {
    expect(friendlyStatus(record({ status: "draft", github: null })).label).toBe("Draft");
  });

  it("reads a failed submission as not sent, and says the report is safe", () => {
    const status = friendlyStatus(
      record({ status: "submission_failed", github: null }),
    );
    expect(status.label).toBe("Not sent");
    expect(status.tone).toBe("error");
    expect(status.detail).toContain("Saved on this computer");
  });

  it("says a report is submitted before the first update arrives", () => {
    expect(friendlyStatus(record({ lastKnownIssueState: null })).label).toBe(
      "Submitted",
    );
  });

  it("says a linked report is linked", () => {
    expect(
      friendlyStatus(record({ status: "linked_existing", lastKnownIssueState: null }))
        .label,
    ).toBe("Linked");
  });
});

describe("statusFromIssue", () => {
  it("translates the labels the repository uses", () => {
    expect(statusFromIssue(issue({ labels: ["needs-triage"] })).label).toBe("Submitted");
    expect(statusFromIssue(issue({ labels: ["confirmed"] })).label).toBe("Confirmed");
    expect(statusFromIssue(issue({ labels: ["in-progress"] })).label).toBe("In progress");
    expect(statusFromIssue(issue({ labels: ["planned"] })).label).toBe("Planned");
    expect(statusFromIssue(issue({ labels: ["fixed"], state: "closed" })).label).toBe("Fixed");
    expect(statusFromIssue(issue({ labels: ["wont-fix"], state: "closed" })).label).toBe("Won't fix");
    expect(statusFromIssue(issue({ labels: ["duplicate"] })).label).toBe("Duplicate");
  });

  /**
   * The rule that keeps this honest: a closed issue with no progress label may
   * have been closed as stale or by mistake, and saying "Fixed" would tell
   * somebody their bug was solved when nobody said that.
   */
  it("invents nothing when the repository does not use these labels", () => {
    expect(statusFromIssue(issue({ state: "open" })).label).toBe("Open");
    expect(statusFromIssue(issue({ state: "closed" })).label).toBe("Closed");
    expect(statusFromIssue(issue({ state: "closed", labels: ["question"] })).label).toBe(
      "Closed",
    );
  });

  it("resolves conflicting labels in a fixed order", () => {
    expect(
      statusFromIssue(issue({ labels: ["needs-triage", "confirmed", "in-progress"] }))
        .label,
    ).toBe("In progress");
  });

  it("ignores a stale triage label on a closed issue", () => {
    expect(statusFromIssue(issue({ state: "closed", labels: ["needs-triage"] })).label).toBe(
      "Closed",
    );
  });
});

describe("fixVersion", () => {
  it("reads a milestone named after a release", () => {
    expect(fixVersion(issue({ milestone: "v1.4.2" }))).toBe("1.4.2");
    expect(fixVersion(issue({ milestone: "0.7.0" }))).toBe("0.7.0");
  });

  it("reads a fixed-in label", () => {
    expect(fixVersion(issue({ labels: ["fixed", "fixed-in:1.3.9"] }))).toBe("1.3.9");
  });

  /** Not every repository records a version, and guessing one would be wrong. */
  it("says nothing when the repository records none", () => {
    expect(fixVersion(issue({ milestone: "Next up" }))).toBe("");
    expect(fixVersion(issue())).toBe("");
  });

  it("shows the release in the status when there is one", () => {
    expect(
      statusFromIssue(issue({ state: "closed", labels: ["fixed"], milestone: "v1.4.2" }))
        .detail,
    ).toBe("Fixed in 1.4.2");
  });
});

describe("filters", () => {
  const drafted = record({ status: "draft", github: null });
  const open = record({ lastKnownIssueState: issue({ state: "open" }) });
  const closed = record({ lastKnownIssueState: issue({ state: "closed" }) });
  const failed = record({ status: "submission_failed", github: null });

  it("keeps drafts out of Open and in Drafts", () => {
    expect(matchesFilter(drafted, "open")).toBe(false);
    expect(matchesFilter(drafted, "drafts")).toBe(true);
  });

  /**
   * A failed submission is unfinished business, and the one list somebody
   * checks must not be the list that hides it.
   */
  it("counts a failed submission as open", () => {
    expect(matchesFilter(failed, "open")).toBe(true);
    expect(matchesFilter(failed, "resolved")).toBe(false);
  });

  it("sorts a closed issue into resolved", () => {
    expect(matchesFilter(closed, "resolved")).toBe(true);
    expect(matchesFilter(closed, "open")).toBe(false);
    expect(matchesFilter(open, "open")).toBe(true);
  });

  it("shows everything under All", () => {
    for (const entry of [drafted, open, closed, failed]) {
      expect(matchesFilter(entry, "all")).toBe(true);
    }
  });
});

describe("refreshing", () => {
  it("lists the issue numbers worth asking about", () => {
    expect(
      issuesToRefresh([
        record({ localId: "a" }),
        record({ localId: "b", github: { issueNumber: 9, issueUrl: "u" } }),
        record({ localId: "c", status: "draft", github: null }),
      ]),
    ).toEqual([184, 9]);
  });

  it("is due when nothing has been checked", () => {
    expect(needsRefresh("", 60_000)).toBe(true);
    expect(needsRefresh("not a date", 60_000)).toBe(true);
  });

  it("is not due again inside the cache window", () => {
    const now = Date.parse("2026-08-22T09:00:00Z");
    expect(needsRefresh("2026-08-22T08:59:00.000Z", 5 * 60_000, now)).toBe(false);
    expect(needsRefresh("2026-08-22T08:50:00.000Z", 5 * 60_000, now)).toBe(true);
  });

  it("puts the most recently changed report first", () => {
    const older = record({ localId: "a", updatedAt: "2026-08-01T00:00:00.000Z" });
    const newer = record({ localId: "b", updatedAt: "2026-08-20T00:00:00.000Z" });
    expect(sortRecords([older, newer]).map((r) => r.localId)).toEqual(["b", "a"]);
  });
});
