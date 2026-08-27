import { describe, expect, it } from "vitest";
import {
  ACTION_SCHEMA_VERSION,
  collapseActions,
  commitSubject,
  decodeCommitMessage,
  describeAction,
  encodeCommitMessage,
  EXTERNAL_CHANGES_ACTION,
  MIGRATION_ACTION,
  StructuredActionSchema,
  type StructuredAction,
} from "./commitActions";

function action(over: Partial<StructuredAction> = {}): StructuredAction {
  return StructuredActionSchema.parse({ type: "creature.updated", ...over });
}

const ENVELOPE = {
  projectId: "11111111-2222-4333-8444-555555555555",
  schemaVersion: 2,
  operationId: "op-8a7c",
  actor: "ggfizz",
};

describe("commitSubject", () => {
  it("names the domains that changed", () => {
    expect(
      commitSubject([action({ type: "creature.updated" }), action({ type: "mod.added" })]),
    ).toBe("Updated creature and mod configuration");
  });

  it("reads naturally with one domain", () => {
    expect(commitSubject([action({ type: "remap.added" })])).toBe(
      "Updated remap configuration",
    );
  });

  it("follows the order things were actually done in", () => {
    expect(
      commitSubject([action({ type: "mod.added" }), action({ type: "creature.updated" })]),
    ).toBe("Updated mod and creature configuration");
  });

  it("stops listing once a list stops being a summary", () => {
    expect(
      commitSubject([
        action({ type: "creature.updated" }),
        action({ type: "mod.added" }),
        action({ type: "remap.added" }),
        action({ type: "cosmetic.added" }),
      ]),
    ).toBe("Updated several parts of the project");
  });

  it("says something rather than nothing for an empty set", () => {
    expect(commitSubject([])).toBe("Updated project files");
  });

  /**
   * A sync that found changes Studio did not make must say so. Claiming nothing
   * happened would be worse than admitting the app does not know what did.
   */
  it("admits when the change came from outside Studio", () => {
    expect(commitSubject([action({ type: EXTERNAL_CHANGES_ACTION })])).toBe(
      "Recorded changes made outside Studio",
    );
  });

  it("has its own subject for a migration", () => {
    expect(commitSubject([action({ type: MIGRATION_ACTION })])).toBe(
      "Updated the project to a newer format",
    );
  });

  it("never speaks in Git terms", () => {
    const subject = commitSubject([action(), action({ type: "mod.added" })]);
    expect(subject).not.toMatch(/merge|rebase|ref|HEAD|commit|sha/i);
  });
});

describe("encodeCommitMessage", () => {
  const actions = [
    action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
    action({ type: "mod.added", id: "1431447" }),
  ];

  it("puts the subject first, then a blank line, then the trailers", () => {
    const lines = encodeCommitMessage({ ...ENVELOPE, actions }).split("\n");
    expect(lines[0]).toBe("Updated creature and mod configuration");
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe(`DinoDepot-Project: ${ENVELOPE.projectId}`);
  });

  it("stamps the project, schema, operation and action version", () => {
    const message = encodeCommitMessage({ ...ENVELOPE, actions });
    expect(message).toContain(`DinoDepot-Schema: 2`);
    expect(message).toContain(`DinoDepot-Operation: op-8a7c`);
    expect(message).toContain(`DinoDepot-Actor: ggfizz`);
    expect(message).toContain(`DinoDepot-Actions-Version: ${ACTION_SCHEMA_VERSION}`);
  });

  it("writes one trailer per action, each on a single line", () => {
    const message = encodeCommitMessage({ ...ENVELOPE, actions });
    const trailers = message
      .split("\n")
      .filter((l) => l.startsWith("DinoDepot-Action:"));
    expect(trailers).toHaveLength(2);
    expect(trailers[0]).toBe(
      'DinoDepot-Action: {"type":"creature.updated","id":"r1","fields":["displayName"]}',
    );
  });

  it("leaves defaulted fields out of a permanent record", () => {
    const message = encodeCommitMessage({
      ...ENVELOPE,
      actions: [action({ type: "mod.added", id: "1431447" })],
    });
    expect(message).toContain('{"type":"mod.added","id":"1431447"}');
    expect(message).not.toContain('"fields":[]');
    expect(message).not.toContain('"label":""');
  });

  /**
   * A label is administrator-supplied text. A raw newline in one would end the
   * trailer early and turn the rest into something a parser reads as a
   * different field.
   */
  it("cannot be broken out of by a newline in a label", () => {
    const message = encodeCommitMessage({
      ...ENVELOPE,
      actions: [
        action({
          type: "creature.updated",
          id: "r1",
          label: "Rex\nDinoDepot-Operation: injected",
        }),
      ],
    });
    const trailers = message.split("\n").filter((l) => l.startsWith("DinoDepot-Action:"));
    expect(trailers).toHaveLength(1);
    expect(decodeCommitMessage(message).operationId).toBe("op-8a7c");
  });

  it("keeps an administrator name inside one trailer", () => {
    const message = encodeCommitMessage({
      ...ENVELOPE,
      actor: "ggfizz\nDinoDepot-Project: injected",
      actions,
    });
    expect(decodeCommitMessage(message).actor).toBe("ggfizz DinoDepot-Project: injected");
    expect(decodeCommitMessage(message).projectId).toBe(ENVELOPE.projectId);
  });

  it("lets a caller supply its own subject", () => {
    const message = encodeCommitMessage({
      ...ENVELOPE,
      actions: [],
      subject: "Published the cluster viewer",
    });
    expect(message.split("\n")[0]).toBe("Published the cluster viewer");
  });
});

describe("decodeCommitMessage", () => {
  const actions = [
    action({ type: "creature.updated", id: "r1", fields: ["displayName"], label: "Rex" }),
    action({ type: "mod.added", id: "1431447" }),
  ];

  it("round-trips everything it encoded", () => {
    const decoded = decodeCommitMessage(encodeCommitMessage({ ...ENVELOPE, actions }));
    expect(decoded.projectId).toBe(ENVELOPE.projectId);
    expect(decoded.schemaVersion).toBe(2);
    expect(decoded.operationId).toBe(ENVELOPE.operationId);
    expect(decoded.actor).toBe("ggfizz");
    expect(decoded.actionsVersion).toBe(ACTION_SCHEMA_VERSION);
    expect(decoded.actions).toEqual(actions);
    expect(decoded.isDinoDepot).toBe(true);
    expect(decoded.fromNewerStudio).toBe(false);
  });

  /**
   * Somebody editing a file through the GitHub web UI produces a perfectly
   * ordinary commit, and Recent Activity still has to describe it.
   */
  it("reads a commit DinoDepot did not write", () => {
    const decoded = decodeCommitMessage("Update players.json\n\nEdited on github.com");
    expect(decoded.isDinoDepot).toBe(false);
    expect(decoded.subject).toBe("Update players.json");
    expect(decoded.actions).toEqual([]);
    expect(decoded.actor).toBe("");
  });

  it("keeps what it understands from a newer action vocabulary", () => {
    const message = [
      "Updated creature configuration",
      "",
      `DinoDepot-Project: ${ENVELOPE.projectId}`,
      "DinoDepot-Actions-Version: 99",
      'DinoDepot-Action: {"type":"creature.updated","id":"r1"}',
      'DinoDepot-Action: {"type":"something.brandNew","id":"x","futureField":true}',
    ].join("\n");
    const decoded = decodeCommitMessage(message);
    expect(decoded.fromNewerStudio).toBe(true);
    // Both survive: an unknown *type* is not an unreadable action.
    expect(decoded.actions).toHaveLength(2);
    expect(decoded.actions[1].type).toBe("something.brandNew");
    expect(decoded.unreadableActions).toBe(0);
  });

  /** Counted, not discarded — the UI must not show less than happened. */
  it("counts action trailers it cannot parse", () => {
    const message = [
      "Updated creature configuration",
      "",
      'DinoDepot-Action: {"type":"creature.updated"}',
      "DinoDepot-Action: { this is not json",
      "DinoDepot-Action: {\"missing\":\"a type\"}",
    ].join("\n");
    const decoded = decodeCommitMessage(message);
    expect(decoded.actions).toHaveLength(1);
    expect(decoded.unreadableActions).toBe(2);
  });

  it("survives a message with no trailers at all", () => {
    const decoded = decodeCommitMessage("Initial commit");
    expect(decoded.subject).toBe("Initial commit");
    expect(decoded.schemaVersion).toBeNull();
    expect(decoded.actionsVersion).toBeNull();
  });

  it("reads a message with Windows line endings", () => {
    const message = encodeCommitMessage({ ...ENVELOPE, actions }).replace(/\n/g, "\r\n");
    expect(decodeCommitMessage(message).actions).toEqual(actions);
  });

  it("ignores trailers belonging to something else", () => {
    const message = [
      "Updated creature configuration",
      "",
      `DinoDepot-Project: ${ENVELOPE.projectId}`,
      "Co-Authored-By: Someone <someone@example.com>",
      "Signed-off-by: Someone <someone@example.com>",
    ].join("\n");
    const decoded = decodeCommitMessage(message);
    expect(decoded.projectId).toBe(ENVELOPE.projectId);
    expect(decoded.actions).toEqual([]);
  });
});

describe("collapseActions", () => {
  /** Twenty keystrokes on one name is one line of history, not twenty. */
  it("merges repeated updates to the same thing", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
      action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
      action({ type: "creature.updated", id: "r1", fields: ["interval"] }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].fields).toEqual(["displayName", "interval"]);
  });

  it("keeps the newest label", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "r1", label: "Rex" }),
      action({ type: "creature.updated", id: "r1", label: "Rex (Tamed)" }),
    ]);
    expect(collapsed[0].label).toBe("Rex (Tamed)");
  });

  /** The thing is new; what it was adjusted to on the way in is not history. */
  it("keeps a create as a create when it is then edited", () => {
    const collapsed = collapseActions([
      action({ type: "mod.added", id: "1431447" }),
      action({ type: "mod.updated", id: "1431447", fields: ["name"] }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].type).toBe("mod.added");
  });

  /** Between one sync and the next, nobody else ever saw it exist. */
  it("drops something created and then deleted", () => {
    const collapsed = collapseActions([
      action({ type: "mod.added", id: "1431447" }),
      action({ type: "mod.updated", id: "1431447", fields: ["name"] }),
      action({ type: "mod.deleted", id: "1431447" }),
    ]);
    expect(collapsed).toEqual([]);
  });

  it("keeps the surrounding actions in order when one is dropped", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "a" }),
      action({ type: "mod.added", id: "b" }),
      action({ type: "mod.deleted", id: "b" }),
      action({ type: "remap.added", id: "c" }),
    ]);
    expect(collapsed.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("keeps a deletion of something that already existed", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "r1", fields: ["displayName"] }),
      action({ type: "creature.deleted", id: "r1" }),
    ]);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].type).toBe("creature.deleted");
    expect(collapsed[0].fields).toEqual([]);
  });

  it("does not merge different things that share a verb", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "r1" }),
      action({ type: "creature.updated", id: "r2" }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it("does not merge the same id across different domains", () => {
    const collapsed = collapseActions([
      action({ type: "creature.updated", id: "1" }),
      action({ type: "mod.updated", id: "1" }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it("leaves actions about no particular thing alone", () => {
    const collapsed = collapseActions([
      action({ type: EXTERNAL_CHANGES_ACTION }),
      action({ type: EXTERNAL_CHANGES_ACTION }),
    ]);
    expect(collapsed).toHaveLength(2);
  });

  it("does nothing to an empty list", () => {
    expect(collapseActions([])).toEqual([]);
  });
});

describe("describeAction", () => {
  it("reads as a sentence about the thing", () => {
    expect(describeAction(action({ type: "mod.added", id: "1431447", label: "Ports of Atlas" })))
      .toBe("Added mod Ports of Atlas");
    expect(describeAction(action({ type: "creature.deleted", label: "Rex" }))).toBe(
      "Removed creature Rex",
    );
  });

  it("names the fields that changed", () => {
    expect(
      describeAction(
        action({ type: "creature.updated", label: "Rex", fields: ["interval", "chance"] }),
      ),
    ).toBe("Changed interval and chance on creature Rex");
  });

  it("falls back to the id when there is no label", () => {
    expect(describeAction(action({ type: "mod.added", id: "1431447" }))).toBe(
      "Added mod 1431447",
    );
  });

  it("has words for the two project-level actions", () => {
    expect(describeAction(action({ type: EXTERNAL_CHANGES_ACTION }))).toContain(
      "outside Studio",
    );
    expect(describeAction(action({ type: MIGRATION_ACTION }))).toContain("newer format");
  });

  /** A commit from a newer Studio must still produce a row, not a blank. */
  it("says something for a verb it has never seen", () => {
    const described = describeAction(action({ type: "creature.ascended", label: "Rex" }));
    expect(described).not.toBe("");
    expect(described).toContain("Rex");
  });
});
