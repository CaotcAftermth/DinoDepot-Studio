import { describe, expect, it } from "vitest";
import {
  formatChance,
  formatDuration,
  parseChanceInput,
  parseDurationInput,
} from "./productionInput";

describe("production chance input", () => {
  it("accepts stored fractions and percentages", () => {
    expect(parseChanceInput("0.1")).toBe(0.1);
    expect(parseChanceInput("10%")).toBe(0.1);
    expect(parseChanceInput("10 %")).toBe(0.1);
    expect(parseChanceInput("100%")).toBe(1);
  });

  it("rejects ambiguous and out-of-range values", () => {
    expect(parseChanceInput("10")).toBeNull();
    expect(parseChanceInput("101%")).toBeNull();
    expect(parseChanceInput("-1%")).toBeNull();
    expect(parseChanceInput("anything")).toBeNull();
  });

  it("formats stored fractions as percentages", () => {
    expect(formatChance(0.1)).toBe("10%");
    expect(formatChance(0.3333)).toBe("33.33%");
  });
});

describe("production duration input", () => {
  it("keeps unitless values as seconds", () => {
    expect(parseDurationInput("94")).toBe(94);
    expect(parseDurationInput("94 seconds")).toBe(94);
    expect(parseDurationInput("94s")).toBe(94);
  });

  it("accepts minutes and hours with or without spaces", () => {
    expect(parseDurationInput("1 min")).toBe(60);
    expect(parseDurationInput("1minute")).toBe(60);
    expect(parseDurationInput("1.5 hours")).toBe(5400);
    expect(parseDurationInput("2hr")).toBe(7200);
  });

  it("accepts compact compound durations", () => {
    expect(parseDurationInput("1h 2min 3s")).toBe(3723);
    expect(parseDurationInput("1hour30minutes")).toBe(5400);
  });

  it("rejects incomplete or non-positive durations", () => {
    expect(parseDurationInput("0")).toBeNull();
    expect(parseDurationInput("1 fortnight")).toBeNull();
    expect(parseDurationInput("1min later")).toBeNull();
  });

  it("formats seconds as readable exact durations", () => {
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(94)).toBe("1min 34s");
    expect(formatDuration(3694)).toBe("1hr 1min 34s");
  });
});
