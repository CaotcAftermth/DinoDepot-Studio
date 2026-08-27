import { afterEach, describe, expect, it } from "vitest";
import {
  FEEDBACK_CONFIG,
  effectiveConfig,
  hasManagedFeedbackService,
} from "./config";

const originalApiBaseUrl = FEEDBACK_CONFIG.apiBaseUrl;

afterEach(() => {
  FEEDBACK_CONFIG.apiBaseUrl = originalApiBaseUrl;
});

describe("effective feedback configuration", () => {
  it("uses the build-time service when the persisted runtime override is empty", () => {
    FEEDBACK_CONFIG.apiBaseUrl = "https://build.example.com";
    expect(effectiveConfig({ apiBaseUrl: "" }).apiBaseUrl).toBe(
      "https://build.example.com",
    );
  });

  it("keeps the managed build service when a stored override exists", () => {
    FEEDBACK_CONFIG.apiBaseUrl = "https://build.example.com";
    expect(effectiveConfig({ apiBaseUrl: "https://runtime.example.com/" }).apiBaseUrl).toBe(
      "https://build.example.com",
    );
    expect(hasManagedFeedbackService()).toBe(true);
  });

  it("uses a runtime service only when the build has no managed one", () => {
    FEEDBACK_CONFIG.apiBaseUrl = "";
    expect(effectiveConfig({ apiBaseUrl: "https://runtime.example.com/" }).apiBaseUrl).toBe(
      "https://runtime.example.com",
    );
    expect(hasManagedFeedbackService()).toBe(false);
  });
});
