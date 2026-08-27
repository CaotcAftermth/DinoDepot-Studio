import { describe, expect, it } from "vitest";
import { FEEDBACK_ATTR, feedbackTarget } from "./targets";
import {
  findFeedbackTarget,
  isIgnored,
  sameTarget,
  snapshotFor,
  targetBreadcrumb,
  type TargetNode,
} from "./resolveTarget";

/**
 * Resolution, exercised without a DOM.
 *
 * `findFeedbackTarget` is written against the two members it actually uses, so
 * a plain object stands in for an element. That is the whole reason the
 * signature is what it is: this project's test runner has no DOM, and
 * resolution order is the part of the Feedback Center most likely to be subtly
 * wrong and least likely to be noticed by hand.
 */

interface FakeNode extends TargetNode {
  attributes: Record<string, string>;
  parentElement: FakeNode | null;
  tagName: string;
  textContent: string;
}

/**
 * Takes `object` rather than a record type so the props `feedbackTarget`
 * returns can be handed straight in. An interface without an index signature
 * is not assignable to `Record<string, string>`, and adding one to the props
 * would weaken the checking at every real call site to save a cast here.
 */
function node(
  attributes: object = {},
  tagName = "DIV",
  textContent = "",
): FakeNode {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string") clean[key] = value;
  }
  return {
    attributes: clean,
    parentElement: null,
    tagName,
    textContent,
    getAttribute(name: string) {
      return name in this.attributes ? this.attributes[name] : null;
    },
  };
}

function child(
  parent: FakeNode,
  tagName: string,
  textContent: string,
  attributes: object = {},
): FakeNode {
  const current = node(attributes, tagName, textContent);
  current.parentElement = parent;
  return current;
}

/** Builds a chain outermost-first and returns the innermost node. */
function tree(...levels: object[]): FakeNode {
  let parent: FakeNode | null = null;
  let current: FakeNode | null = null;
  for (const level of levels) {
    current = node(level);
    current.parentElement = parent;
    parent = current;
  }
  return current as FakeNode;
}

const PRODUCTION_RULES = feedbackTarget("production-rules");
const CYCLE_EDITOR = feedbackTarget("production-rule-cycle-editor");
const QUANTITY = feedbackTarget("production-rule-cycle-quantity");

describe("findFeedbackTarget", () => {
  it("walks up to the nearest registered component", () => {
    // A span holding the digits, inside the quantity field.
    const span = tree(PRODUCTION_RULES, CYCLE_EDITOR, QUANTITY, {});
    const found = findFeedbackTarget(span);
    expect(found?.snapshot.id).toBe("production-rule-cycle-quantity");
  });

  it("returns the node itself when it is the target", () => {
    const field = tree(PRODUCTION_RULES, QUANTITY);
    expect(findFeedbackTarget(field)?.node).toBe(field);
  });

  it("highlights an unregistered button instead of its page-sized target", () => {
    const page = tree(feedbackTarget("project-home"));
    const button = child(page, "BUTTON", "New project");
    const found = findFeedbackTarget(button);
    expect(found?.node).toBe(button);
    expect(found?.snapshot.id).toBe("project-home");
    expect(found?.snapshot.name).toBe("New project");
    expect(found?.snapshot.hierarchy).toEqual(["Welcome Screen", "New project"]);
    expect(found?.snapshot.context).toEqual({ field: "New project" });
  });

  it("never names a section from its live output text", () => {
    const shell = node(feedbackTarget("app-shell"));
    const page = child(shell, "DIV", "", feedbackTarget("overview"));
    const card = child(
      page,
      "SECTION",
      "Publishing0 of 4 synchronizedNo destination setPassive ProductionNever published",
    );
    const found = findFeedbackTarget(card);
    expect(found?.snapshot.name).toBe("Section");
    expect(found?.snapshot.hierarchy).toEqual(["Overview", "Section"]);
  });

  it("uses a registered Overview card name instead of counts and status", () => {
    const shell = node(feedbackTarget("app-shell"));
    const page = child(shell, "DIV", "", feedbackTarget("overview"));
    const card = child(
      page,
      "A",
      "Production rules2All valid",
      feedbackTarget("overview-production-summary"),
    );
    const found = findFeedbackTarget(card);
    expect(found?.snapshot.name).toBe("Production Rules Summary");
    expect(found?.snapshot.hierarchy).toEqual([
      "Overview",
      "Production Rules Summary",
    ]);
  });

  it("never reads an input value while naming a field", () => {
    const page = tree(PRODUCTION_RULES);
    const input = child(page, "INPUT", "secret project value", {
      placeholder: "Creature count",
      value: "private",
    });
    const found = findFeedbackTarget(input);
    expect(found?.snapshot.name).toBe("Creature count");
    expect(found?.snapshot.name).not.toContain("private");
    expect(found?.snapshot.name).not.toContain("secret project value");
  });

  it("uses Field labels to distinguish controls with the same placeholder", () => {
    const page = tree(feedbackTarget("settings-defaults"));
    const chanceWrapper = child(page, "LABEL", "", {
      [FEEDBACK_ATTR.fieldName]: "Chance to produce",
    });
    const chance = child(chanceWrapper, "INPUT", "", {
      placeholder: "0.1 or 10%",
    });
    const activationWrapper = child(page, "LABEL", "", {
      [FEEDBACK_ATTR.fieldName]: "Activation chance",
    });
    const activation = child(activationWrapper, "INPUT", "", {
      placeholder: "0.1 or 10%",
    });

    expect(findFeedbackTarget(chance)?.snapshot.name).toBe("Chance to produce");
    expect(findFeedbackTarget(activation)?.snapshot.name).toBe(
      "Activation chance",
    );
  });

  it("uses a Field label when the control has no placeholder", () => {
    const page = tree(feedbackTarget("settings-simulator"));
    const wrapper = child(page, "LABEL", "", {
      [FEEDBACK_ATTR.fieldName]: "Default hours",
    });
    const input = child(wrapper, "INPUT", "");

    expect(findFeedbackTarget(input)?.snapshot.name).toBe("Default hours");
  });

  it("uses a generic name when visible text contains a machine path", () => {
    const page = tree(feedbackTarget("project-home"));
    const button = child(page, "BUTTON", "Open C:\\Users\\jane\\Project");
    expect(findFeedbackTarget(button)?.snapshot.name).toBe("Control");
  });

  it("finds nothing in the gap between cards", () => {
    expect(findFeedbackTarget(tree({}, {}, {}))).toBeNull();
    expect(findFeedbackTarget(null)).toBeNull();
  });

  /** An id from an older build must not produce an unsearchable area label. */
  it("ignores an id this build does not know", () => {
    const stale = tree(PRODUCTION_RULES, {
      [FEEDBACK_ATTR.id]: "removed-in-a-later-version",
      [FEEDBACK_ATTR.name]: "Something Gone",
    });
    expect(findFeedbackTarget(stale)?.snapshot.id).toBe("production-rules");
  });

  it("takes the name from the registry, not from a stale attribute", () => {
    const renamed = tree({
      [FEEDBACK_ATTR.id]: "production-rule-cycle-quantity",
      [FEEDBACK_ATTR.name]: "What It Was Called Last Release",
    });
    expect(findFeedbackTarget(renamed)?.snapshot.name).toBe(
      "Production Cycle Quantity",
    );
  });
});

describe("ignored subtrees", () => {
  it("refuses anything inside the Feedback Center's own chrome", () => {
    const insideForm = tree(
      { [FEEDBACK_ATTR.ignore]: "true" },
      CYCLE_EDITOR,
      QUANTITY,
    );
    expect(isIgnored(insideForm)).toBe(true);
    expect(findFeedbackTarget(insideForm)).toBeNull();
  });

  it("leaves everything else alone", () => {
    expect(isIgnored(tree(PRODUCTION_RULES, QUANTITY))).toBe(false);
  });
});

describe("hierarchy", () => {
  it("reads outermost first, so it describes a location", () => {
    const field = tree(PRODUCTION_RULES, CYCLE_EDITOR, QUANTITY);
    expect(snapshotFor(field).hierarchy).toEqual([
      "Production Rules",
      "Production Cycle Editor",
      "Production Cycle Quantity",
    ]);
  });

  it("puts the area at the front when the page has no target of its own", () => {
    const field = tree(CYCLE_EDITOR, QUANTITY);
    expect(snapshotFor(field).hierarchy).toEqual([
      "Production Rules",
      "Production Cycle Editor",
      "Production Cycle Quantity",
    ]);
  });

  it("omits the application shell and repeated area from a page path", () => {
    const card = tree(
      feedbackTarget("app-shell"),
      feedbackTarget("overview"),
      feedbackTarget("overview-publishing-summary"),
    );
    expect(snapshotFor(card).hierarchy).toEqual(["Overview", "Publishing Summary"]);
  });

  it("does not repeat a wrapper that shares its child's name", () => {
    const doubled = tree(PRODUCTION_RULES, PRODUCTION_RULES, QUANTITY);
    expect(snapshotFor(doubled).hierarchy).toEqual([
      "Production Rules",
      "Production Cycle Quantity",
    ]);
  });

  it("keeps the informative end of a very deep trail", () => {
    const deep = tree(
      PRODUCTION_RULES,
      feedbackTarget("production-rule-card"),
      CYCLE_EDITOR,
      feedbackTarget("production-rule-cycle-interval"),
      feedbackTarget("content-sources"),
      feedbackTarget("settings-nav"),
      QUANTITY,
    );
    const hierarchy = snapshotFor(deep).hierarchy;
    expect(hierarchy.length).toBeLessThanOrEqual(6);
    expect(hierarchy[hierarchy.length - 1]).toBe("Production Cycle Quantity");
  });

  it("carries the context of the matched node only", () => {
    const field = tree(
      PRODUCTION_RULES,
      feedbackTarget("production-rule-card", { index: 2 }),
      feedbackTarget("production-rule-cycle-quantity", { field: "quantity" }),
    );
    expect(snapshotFor(field).context).toEqual({ field: "quantity" });
  });
});

describe("breadcrumbs", () => {
  it("joins the trail the way the issue and the form both show it", () => {
    const field = tree(PRODUCTION_RULES, CYCLE_EDITOR, QUANTITY);
    expect(targetBreadcrumb(snapshotFor(field))).toBe(
      "Production Rules › Production Cycle Editor › Production Cycle Quantity",
    );
  });

  it("falls back to the component's own name rather than an empty string", () => {
    expect(
      targetBreadcrumb({
        id: "overview",
        name: "Overview",
        area: "",
        hierarchy: [],
        context: {},
      }),
    ).toBe("Overview");
    expect(targetBreadcrumb(null)).toBe("");
  });
});

describe("sameTarget", () => {
  const base = {
    id: "production-rule-cycle-quantity",
    name: "Production Cycle Quantity",
    area: "production-rules",
    hierarchy: [],
    context: { field: "quantity" },
  };

  it("is true for the same component with the same context", () => {
    expect(sameTarget(base, { ...base })).toBe(true);
  });

  /** Two rules' quantity fields are the same component and different targets. */
  it("is false when the context differs", () => {
    expect(sameTarget(base, { ...base, context: { field: "interval" } })).toBe(
      false,
    );
  });

  it("is false against nothing", () => {
    expect(sameTarget(base, null)).toBe(false);
    expect(sameTarget(null, null)).toBe(true);
  });
});
