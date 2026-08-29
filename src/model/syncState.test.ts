import { describe, expect, it } from "vitest";
import { StudioError, STUDIO_ERROR_CODES } from "./errors";
import {
  isWorkingPhase,
  leaksGitTerms,
  phaseForError,
  restingPhase,
  SYNC_PHASE_LABELS,
  SYNC_PHASES,
} from "./syncState";

describe("the phase vocabulary", () => {
  it("has a label for every phase", () => {
    for (const phase of SYNC_PHASES) {
      expect(SYNC_PHASE_LABELS[phase], phase).toBeTruthy();
    }
  });

  /**
   * The design promise is that nobody using this has to know what a merge base
   * is. This is the guard against somebody writing a helpful-sounding "the push
   * was rejected, please rebase" into a status line six months from now.
   */
  it("never uses an implementation term", () => {
    for (const [phase, label] of Object.entries(SYNC_PHASE_LABELS)) {
      expect(leaksGitTerms(label), `${phase}: ${label}`).toEqual([]);
    }
  });

  it("uses the exact agreed wording", () => {
    expect(SYNC_PHASE_LABELS.synchronized).toBe("Synchronized");
    expect(SYNC_PHASE_LABELS["local-changes"]).toBe("Local changes");
    expect(SYNC_PHASE_LABELS.checking).toBe("Checking for team changes");
    expect(SYNC_PHASE_LABELS.integrating).toBe("Integrating changes");
    expect(SYNC_PHASE_LABELS["needs-decision"]).toBe("Needs your decision");
    expect(SYNC_PHASE_LABELS.offline).toBe("Offline");
    expect(SYNC_PHASE_LABELS["access-expired"]).toBe("Access expired");
    expect(SYNC_PHASE_LABELS["repository-unavailable"]).toBe("Repository unavailable");
  });

  /** Offline editing keeps working; a pending decision does not. */
  it("knows which phases still let an administrator work", () => {
    expect(isWorkingPhase("offline")).toBe(true);
    expect(isWorkingPhase("local-changes")).toBe(true);
    expect(isWorkingPhase("needs-decision")).toBe(false);
    expect(isWorkingPhase("blocked")).toBe(false);
  });
});

describe("leaksGitTerms", () => {
  it("catches the terms that must not surface", () => {
    expect(leaksGitTerms("The push was rejected - please rebase")).toContain("rebase");
    expect(leaksGitTerms("non-fast-forward update refused")).toContain("non-fast-forward");
    expect(leaksGitTerms("you are in DETACHED HEAD state")).toContain("detached head");
  });

  it("leaves ordinary wording alone", () => {
    expect(leaksGitTerms("Your changes are shared with the team.")).toEqual([]);
    expect(leaksGitTerms("Checking for team changes")).toEqual([]);
  });
});

describe("phaseForError", () => {
  it("shows a transport failure as being offline", () => {
    expect(phaseForError(new StudioError("network.offline", "x"))).toBe("offline");
    expect(phaseForError(new StudioError("network.timeout", "x"))).toBe("offline");
  });

  it("shows a credential problem as expired access", () => {
    for (const code of ["auth.expired", "auth.missing", "auth.forbidden"] as const) {
      expect(phaseForError(new StudioError(code, "x")), code).toBe("access-expired");
    }
  });

  it("shows a missing repository as unavailable", () => {
    expect(phaseForError(new StudioError("repo.unavailable", "x"))).toBe(
      "repository-unavailable",
    );
    expect(phaseForError(new StudioError("repo.identityMismatch", "x"))).toBe(
      "repository-unavailable",
    );
  });

  it("shows pending conflicts as needing a decision", () => {
    expect(phaseForError(new StudioError("sync.conflictsPending", "x"))).toBe(
      "needs-decision",
    );
  });

  /** Every code has to land somewhere; none may fall through to undefined. */
  it("maps every known error code to a real phase", () => {
    for (const code of STUDIO_ERROR_CODES) {
      const phase = phaseForError(new StudioError(code, "x"));
      expect(SYNC_PHASES, code).toContain(phase);
    }
  });
});

describe("restingPhase", () => {
  it("is Synchronized when there is nothing to share and sharing works", () => {
    expect(
      restingPhase({ hasLocalChanges: false, canSync: true, saveHealthy: true }),
    ).toBe("synchronized");
  });

  it("is Local changes when there is something to share", () => {
    expect(
      restingPhase({ hasLocalChanges: true, canSync: true, saveHealthy: true }),
    ).toBe("local-changes");
  });

  /**
   * The distinction that matters to an administrator: "this goes out next time"
   * versus "this is going nowhere until I set something up".
   */
  it("is Saved locally when there is nowhere to sync to", () => {
    expect(
      restingPhase({ hasLocalChanges: true, canSync: false, saveHealthy: true }),
    ).toBe("saved-locally");
    expect(
      restingPhase({ hasLocalChanges: false, canSync: false, saveHealthy: true }),
    ).toBe("saved-locally");
  });

  /** A failing write outranks everything: nothing else is true if that is. */
  it("is blocked when writes are failing, whatever else is true", () => {
    expect(
      restingPhase({ hasLocalChanges: true, canSync: true, saveHealthy: false }),
    ).toBe("blocked");
    expect(
      restingPhase({ hasLocalChanges: false, canSync: true, saveHealthy: false }),
    ).toBe("blocked");
  });
});
