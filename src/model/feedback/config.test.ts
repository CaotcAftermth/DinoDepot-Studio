import { afterEach, describe, expect, it } from "vitest";
import { FEEDBACK_CONFIG, effectiveConfig } from "./config";

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

  it("lets a non-empty runtime service override the build", () => {
    FEEDBACK_CONFIG.apiBaseUrl = "https://build.example.com";
    expect(effectiveConfig({ apiBaseUrl: "https://runtime.example.com/" }).apiBaseUrl).toBe(
      "https://runtime.example.com",
    );
  });
});
