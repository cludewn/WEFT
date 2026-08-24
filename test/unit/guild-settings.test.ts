import { describe, expect, it } from "vitest";

import {
  formatAutoCloseInactivitySeconds,
  InvalidAutoCloseInactivityError,
  InvalidAutoCloseInactivityInputError,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
  MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
  MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
  parseAutoCloseInactivityInput,
  validateAutoCloseInactivitySeconds,
  validateClosedPrefix,
  validateTimezone,
} from "../../src/guild-settings.js";

describe("guild settings validation", () => {
  it("accepts Node.js-supported IANA timezones and trims input", () => {
    expect(validateTimezone(" Asia/Tokyo ")).toBe("Asia/Tokyo");
    expect(validateTimezone("UTC")).toBe("UTC");
  });

  it("rejects an invalid timezone", () => {
    expect(() => validateTimezone("not/a-timezone")).toThrow(InvalidTimezoneError);
  });

  it("trims a closed prefix and accepts 1 to 20 Unicode characters", () => {
    expect(validateClosedPrefix(" [DONE] ")).toBe("[DONE]");
    expect(validateClosedPrefix("😀".repeat(20))).toBe("😀".repeat(20));
  });

  it("rejects empty, oversized, newline, and control-character prefixes", () => {
    for (const value of ["   ", "x".repeat(21), "closed\n", "closed\u0000"]) {
      expect(() => validateClosedPrefix(value)).toThrow(InvalidClosedPrefixError);
    }
  });
});

describe("automatic close inactivity validation", () => {
  it("accepts the exact supported bounds and a value inside the range", () => {
    expect(validateAutoCloseInactivitySeconds(MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS)).toBe(300);
    expect(validateAutoCloseInactivitySeconds(MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS)).toBe(
      31_536_000,
    );
    expect(validateAutoCloseInactivitySeconds(604_800)).toBe(604_800);
  });

  it("rejects values outside the supported range", () => {
    expect(() => validateAutoCloseInactivitySeconds(299)).toThrow(InvalidAutoCloseInactivityError);
    expect(() => validateAutoCloseInactivitySeconds(31_536_001)).toThrow(
      InvalidAutoCloseInactivityError,
    );
  });

  it("rejects non-integer, non-finite, and non-positive values", () => {
    for (const value of [600.5, Number.NaN, Number.POSITIVE_INFINITY, 0, -300]) {
      expect(() => validateAutoCloseInactivitySeconds(value)).toThrow(
        InvalidAutoCloseInactivityError,
      );
    }
  });
});

describe("automatic close inactivity input", () => {
  it("parses the approved unit syntax and normalizes surrounding input", () => {
    expect(parseAutoCloseInactivityInput("30m")).toBe(1_800);
    expect(parseAutoCloseInactivityInput("12h")).toBe(43_200);
    expect(parseAutoCloseInactivityInput("7d")).toBe(604_800);
    expect(parseAutoCloseInactivityInput("  7D  ")).toBe(604_800);
  });

  it("accepts the exact supported bounds", () => {
    expect(parseAutoCloseInactivityInput("5m")).toBe(MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS);
    expect(parseAutoCloseInactivityInput("365d")).toBe(MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS);
  });

  it("rejects durations outside the supported range", () => {
    for (const value of ["1m", "4m", "366d", "8761h"]) {
      expect(() => parseAutoCloseInactivityInput(value)).toThrow(
        InvalidAutoCloseInactivityInputError,
      );
    }
  });

  it("rejects malformed input without throwing on overflow", () => {
    for (const value of [
      "",
      "7",
      "d",
      "0m",
      "-5m",
      "1.5h",
      "1h30m",
      "07d",
      "7 d",
      "7w",
      "999999999999999999999d",
    ]) {
      expect(() => parseAutoCloseInactivityInput(value)).toThrow(
        InvalidAutoCloseInactivityInputError,
      );
    }
  });

  it("formats persisted seconds with the largest exact unit", () => {
    expect(formatAutoCloseInactivitySeconds(604_800)).toBe("7d");
    expect(formatAutoCloseInactivitySeconds(43_200)).toBe("12h");
    expect(formatAutoCloseInactivitySeconds(1_800)).toBe("30m");
    expect(formatAutoCloseInactivitySeconds(300)).toBe("5m");
    expect(formatAutoCloseInactivitySeconds(90_000)).toBe("25h");
    expect(formatAutoCloseInactivitySeconds(5_400)).toBe("90m");
  });
});
