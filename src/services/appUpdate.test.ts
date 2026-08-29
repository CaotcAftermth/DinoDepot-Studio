import { describe, expect, it } from "vitest";
import {
  describeRejection,
  isUpgrade,
  progressPercent,
  updateFailureMessage,
  UPDATE_STATE_LABELS,
} from "./appUpdate";
import { leaksGitTerms } from "../model/syncState";

/**
 * The rules this layer adds on top of the signed updater: never a downgrade,
 * never silent, and never install something that failed verification.
 */

describe("deciding whether to install", () => {
  it("accepts a newer version", () => {
    expect(isUpgrade("0.3.0", "0.2.0")).toBe(true);
    expect(isUpgrade("1.0.0", "0.9.9")).toBe(true);
    expect(isUpgrade("0.2.1", "0.2.0")).toBe(true);
  });

  it("refuses the same version", () => {
    expect(isUpgrade("0.2.0", "0.2.0")).toBe(false);
  });

  /**
   * A release published with the wrong tag would otherwise roll every install
   * backwards, which is the one update failure nobody notices until later.
   */
  it("refuses an older version", () => {
    expect(isUpgrade("0.1.0", "0.2.0")).toBe(false);
    expect(isUpgrade("0.2.0", "1.0.0")).toBe(false);
  });

  it("refuses a version it cannot read rather than guessing", () => {
    expect(isUpgrade("latest", "0.2.0")).toBe(false);
    expect(isUpgrade("v0.3.0", "0.2.0")).toBe(false);
    expect(isUpgrade("", "0.2.0")).toBe(false);
  });

  /** A pre-release sorts below the release it leads to. */
  it("refuses a pre-release of the version already installed", () => {
    expect(isUpgrade("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(isUpgrade("1.0.0", "1.0.0-beta.1")).toBe(true);
  });
});

describe("explaining why nothing was installed", () => {
  it("names the older version it refused", () => {
    const message = describeRejection("0.1.0", "0.2.0");
    expect(message).toContain("0.1.0");
    expect(message).toContain("0.2.0");
    expect(message).toContain("Nothing has been installed");
  });

  it("says so plainly when the version is unreadable", () => {
    expect(describeRejection("banana", "0.2.0")).toContain("cannot read");
  });

  it("reports being current as being current", () => {
    expect(describeRejection("0.2.0", "0.2.0")).toContain("latest version");
  });
});

describe("update failures", () => {
  /**
   * A signature failure means the file on the release is not one this build
   * will trust - a broken upload, or something worse. Either way it must not be
   * installed, and the administrator is told to go and fetch it themselves.
   */
  it("is explicit about a signature that did not verify", () => {
    for (const text of [
      "signature verification failed",
      "Could not verify the update signature",
      "SIGNATURE mismatch",
    ]) {
      const message = updateFailureMessage(new Error(text));
      expect(message, text).toContain("not been installed");
      expect(message, text).toContain("releases page");
    }
  });

  it("treats a transport failure as harmless", () => {
    for (const text of [
      "network error",
      "dns lookup failed",
      "failed to connect",
      "request timed out",
    ]) {
      expect(updateFailureMessage(new Error(text)), text).toContain("try again later");
    }
  });

  it("says something useful for anything else", () => {
    const message = updateFailureMessage(new Error("something odd"));
    expect(message).toContain("Your work is unaffected");
  });

  it("copes with a rejection that is not an Error", () => {
    expect(updateFailureMessage("a string")).toBeTruthy();
    expect(updateFailureMessage(null)).toBeTruthy();
  });

  /** Every one of these reassures rather than alarms about the project. */
  it("never suggests the administrator's work is at risk", () => {
    for (const error of [
      new Error("signature verification failed"),
      new Error("network error"),
      new Error("something odd"),
    ]) {
      const message = updateFailureMessage(error);
      expect(leaksGitTerms(message), message).toEqual([]);
      expect(message.toLowerCase()).not.toContain("lost");
    }
  });
});

describe("download progress", () => {
  it("reports a percentage when the size is known", () => {
    expect(progressPercent({ downloaded: 50, total: 200 })).toBe(25);
    expect(progressPercent({ downloaded: 200, total: 200 })).toBe(100);
  });

  /** Some servers never announce a length; a spinner is the honest answer. */
  it("reports nothing when the size was never announced", () => {
    expect(progressPercent({ downloaded: 50, total: 0 })).toBeNull();
  });

  it("never reports past 100", () => {
    expect(progressPercent({ downloaded: 300, total: 200 })).toBe(100);
  });
});

describe("what the administrator reads", () => {
  it("has a label for every state", () => {
    for (const [state, label] of Object.entries(UPDATE_STATE_LABELS)) {
      if (state === "idle") continue;
      expect(label, state).toBeTruthy();
      expect(leaksGitTerms(label), label).toEqual([]);
    }
  });
});
