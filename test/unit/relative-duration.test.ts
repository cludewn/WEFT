import { describe, expect, it } from "vitest";

import {
  addRelativeDuration,
  InvalidRelativeDurationError,
  parseRelativeDuration,
} from "../../src/relative-duration.js";

describe("relative duration", () => {
  it.each([
    ["1m", 60_000],
    [" 2H ", 7_200_000],
    ["365d", 31_536_000_000],
  ])("parses bounded single-unit duration %s", (input, expected) => {
    expect(parseRelativeDuration(input)).toBe(expected);
  });

  it.each(["", "0m", "1s", "1h30m", "366d", "999999999999999999999999999999d"])(
    "rejects invalid or overflowing duration %s",
    (input) => {
      expect(() => parseRelativeDuration(input)).toThrow(InvalidRelativeDurationError);
    },
  );

  it("adds a parsed duration to the supplied anchor without recapturing time", () => {
    const anchor = new Date("2030-01-02T03:04:05.678Z");
    expect(addRelativeDuration(anchor, parseRelativeDuration("2h"))).toEqual(
      new Date("2030-01-02T05:04:05.678Z"),
    );
  });

  it("rejects an overflowing timestamp", () => {
    expect(() =>
      addRelativeDuration(new Date(8_639_999_999_999_999), parseRelativeDuration("1m")),
    ).toThrow(InvalidRelativeDurationError);
  });
});
