import { describe, expect, it } from "vitest";
import {
  DUPLICATE_THRESHOLD,
  duplicateQueries,
  keywordsOf,
  rankCandidates,
  scoreCandidate,
  type DuplicateSubject,
  type IssueCandidate,
} from "./duplicates";

const subject: DuplicateSubject = {
  type: "bug",
  title: "Quantity of zero removes the creature",
  description:
    "Setting the production quantity to zero removes the creature entry from the rule instead of leaving the quantity at zero.",
  target: {
    id: "production-rule-cycle-quantity",
    name: "Production Cycle Quantity",
    area: "production-rules",
    hierarchy: [],
    context: {},
  },
};

function candidate(overrides: Partial<IssueCandidate> = {}): IssueCandidate {
  return {
    number: 143,
    title: "Quantity field removes production entry",
    body: "the quantity removes the entry",
    state: "open",
    labels: ["bug"],
    url: "https://github.com/o/r/issues/143",
    updatedAt: "2026-08-01T00:00:00Z",
    ...overrides,
  };
}

describe("keywordsOf", () => {
  it("drops filler and keeps what the report is about", () => {
    const words = keywordsOf(`${subject.title} ${subject.description}`);
    expect(words).toContain("quantity");
    expect(words).toContain("creature");
    expect(words).not.toContain("the");
    expect(words).not.toContain("into");
  });

  /** Searching this repository for "studio" returns this repository. */
  it("drops the domain's own filler", () => {
    expect(keywordsOf("dinodepot studio ark bug error page")).toEqual([]);
  });

  it("ranks a repeated word above a rare one", () => {
    expect(keywordsOf("quantity quantity quantity creature", 2)[0]).toBe("quantity");
  });

  it("returns nothing for text with nothing in it", () => {
    expect(keywordsOf("")).toEqual([]);
    expect(keywordsOf("a an it")).toEqual([]);
  });
});

describe("duplicateQueries", () => {
  it("asks about the exact component first", () => {
    const queries = duplicateQueries(subject, "o/r");
    expect(queries[0]).toBe(
      'repo:o/r is:issue in:body "production-rule-cycle-quantity"',
    );
  });

  it("falls back to keywords when there is no component", () => {
    const queries = duplicateQueries({ ...subject, target: null }, "o/r");
    expect(queries.length).toBe(1);
    expect(queries[0]).toContain("in:title,body");
    expect(queries[0]).toContain("quantity");
  });

  /**
   * A repository whose labels have not been created yet must still return
   * candidates, so the search deliberately does not filter by area label.
   */
  it("never narrows by a label that may not exist", () => {
    for (const query of duplicateQueries(subject, "o/r")) {
      expect(query).not.toContain("label:");
    }
  });

  it("searches closed issues too, because 'already fixed' is an answer", () => {
    for (const query of duplicateQueries(subject, "o/r")) {
      expect(query).not.toContain("is:open");
    }
  });

  it("asks nothing at all when there is nothing to ask about", () => {
    expect(
      duplicateQueries({ type: "bug", title: "", description: "", target: null }, "o/r"),
    ).toEqual([]);
  });
});

describe("scoring", () => {
  it("puts the component id above everything else", () => {
    const sameComponent = scoreCandidate(
      subject,
      candidate({ body: "reported against production-rule-cycle-quantity" }),
    );
    const wordsOnly = scoreCandidate(subject, candidate({ body: "quantity issue" }));
    expect(sameComponent.score).toBeGreaterThan(wordsOnly.score);
    expect(sameComponent.reason).toBe("same component");
  });

  it("credits a shared area", () => {
    const withArea = scoreCandidate(
      subject,
      candidate({ labels: ["bug", "area:production-rules"] }),
    );
    const withoutArea = scoreCandidate(subject, candidate());
    expect(withArea.score).toBeGreaterThan(withoutArea.score);
  });

  it("prefers an open issue over a closed one, all else equal", () => {
    expect(scoreCandidate(subject, candidate()).score).toBeGreaterThan(
      scoreCandidate(subject, candidate({ state: "closed" })).score,
    );
  });

  it("gives an unrelated issue a score below the threshold", () => {
    const unrelated = scoreCandidate(
      subject,
      candidate({
        number: 9,
        title: "Discord webhook posts twice",
        body: "the announcement is duplicated",
        labels: ["bug", "area:settings"],
      }),
    );
    expect(unrelated.score).toBeLessThan(DUPLICATE_THRESHOLD);
  });
});

describe("rankCandidates", () => {
  it("shows nothing when nothing resembles the report", () => {
    expect(
      rankCandidates(subject, [
        candidate({ number: 9, title: "Discord webhook posts twice", body: "" }),
      ]),
    ).toEqual([]);
  });

  it("deduplicates, because the two searches overlap by design", () => {
    const one = candidate({ body: "production-rule-cycle-quantity" });
    expect(rankCandidates(subject, [one, { ...one }]).length).toBe(1);
  });

  it("returns the best first and respects the limit", () => {
    const ranked = rankCandidates(
      subject,
      [
        candidate({ number: 1, body: "quantity creature removes entry rule zero" }),
        candidate({ number: 2, body: "production-rule-cycle-quantity" }),
        candidate({ number: 3, body: "quantity creature removes production" }),
      ],
      2,
    );
    expect(ranked.length).toBe(2);
    expect(ranked[0].number).toBe(2);
  });

  it("copes with an empty answer from the service", () => {
    expect(rankCandidates(subject, [])).toEqual([]);
  });
});
