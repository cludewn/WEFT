import { describe, expect, it } from "vitest";

import {
  InvalidClosedPrefixError,
  InvalidTimezoneError,
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
