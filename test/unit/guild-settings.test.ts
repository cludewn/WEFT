import { describe, expect, it } from "vitest";

import {
  InvalidAutoCloseInactivityError,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
  MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
  MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
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
