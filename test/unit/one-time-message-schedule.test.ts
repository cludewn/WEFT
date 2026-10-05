import { describe, expect, it } from "vitest";

import {
  parseOneTimeLocalDateTime,
  parseOneTimeScheduleOptions,
  resolveOneTimeSchedule,
} from "../../src/one-time-message-schedule.js";
import { normalizeRecurringTimezone } from "../../src/recurring-message.js";

describe("one-time local datetime grammar", () => {
  it.each(["2026-10-10 19:30", "2028-02-29 00:00", "2000-02-29 23:59", "0000-01-01 00:00"])(
    "accepts %s without host-local parsing",
    (input) => {
      const result = parseOneTimeLocalDateTime(input);
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.local.toString({ smallestUnit: "minute" })).toBe(input.replace(" ", "T"));
    },
  );

  it.each([
    "2026-10-10T19:30",
    " 2026-10-10 19:30",
    "2026-10-10 19:30 ",
    "2026-10-10 19:30\n",
    "2026-10-10\n19:30",
    "2026-10-10  19:30",
    "2026-10-10 19:30:00",
    "2026-10-10 19:30:00.001",
    "2026-10-10 19:30+09:00",
    "2026-10-10 19:30Z",
    "2026-10-10 19:30[UTC]",
    "2026-1-10 19:30",
    "２０２６-10-10 19:30",
    "2026-10-10 24:00",
    "2026-10-10 12:60",
    "",
    "0".repeat(10_000),
  ])("rejects noncanonical syntax %#", (input) => {
    expect(parseOneTimeLocalDateTime(input)).toEqual({ ok: false, code: "INVALID_AT_FORMAT" });
  });

  it.each([
    "2026-02-29 12:00",
    "1900-02-29 12:00",
    "2026-04-31 12:00",
    "2026-00-10 12:00",
    "2026-13-10 12:00",
    "2026-01-00 12:00",
    "2026-01-32 12:00",
  ])("rejects calendar overflow for %s", (input) => {
    expect(parseOneTimeLocalDateTime(input)).toEqual({ ok: false, code: "INVALID_AT_DATE" });
  });
});

describe("selector presence", () => {
  it.each([
    [null, null, "MISSING_SELECTOR"],
    [undefined, undefined, "MISSING_SELECTOR"],
    ["1m", "2026-10-10 19:30", "CONFLICTING_SELECTORS"],
    ["", "", "CONFLICTING_SELECTORS"],
    [null, "", "INVALID_AT_FORMAT"],
    ["", null, "INVALID_DURATION"],
  ])("rejects supplied invalid selectors %#", (after, at, code) => {
    expect(parseOneTimeScheduleOptions(after, at)).toEqual({ ok: false, code });
  });
  it("preserves existing relative grammar and parses an absolute selector", () => {
    expect(parseOneTimeScheduleOptions(" 2H ", null)).toEqual({
      ok: true,
      schedule: { kind: "AFTER", durationMs: 7_200_000 },
    });
    expect(parseOneTimeScheduleOptions(null, "2026-10-10 19:30")).toEqual({
      ok: true,
      schedule: { kind: "AT", localDateTime: "2026-10-10 19:30" },
    });
  });
});

describe("one-time absolute resolution", () => {
  const establishedAt = new Date("2026-10-05T00:00:00Z");
  it.each([
    ["Asia/Tokyo", "2026-10-10T10:30:00Z"],
    ["UTC", "2026-10-10T19:30:00Z"],
    ["asia/tokyo", "2026-10-10T10:30:00Z"],
    ["Etc/UTC", "2026-10-10T19:30:00Z"],
  ])("uses validated named timezone %s", (zone, expected) => {
    expect(
      resolveOneTimeSchedule(
        { kind: "AT", localDateTime: "2026-10-10 19:30" },
        establishedAt,
        normalizeRecurringTimezone(zone),
      ),
    ).toEqual({ ok: true, executeAt: new Date(expected) });
  });

  it.each([
    ["2026-03-08 02:30", "America/New_York", "DST_GAP"],
    ["2026-11-01 01:30", "America/New_York", "DST_OVERLAP"],
    ["2026-10-04 02:15", "Australia/Lord_Howe", "DST_GAP"],
    ["2026-04-05 01:45", "Australia/Lord_Howe", "DST_OVERLAP"],
  ])(
    "rejects %s in %s without selecting or shifting an instant",
    (localDateTime, timezone, code) => {
      expect(
        resolveOneTimeSchedule(
          { kind: "AT", localDateTime },
          new Date("2026-01-01T00:00:00Z"),
          timezone,
        ),
      ).toEqual({ ok: false, code });
    },
  );

  it.each([
    ["2026-10-10T19:31:00Z", "TOO_SOON"], // past
    ["2026-10-10T19:30:00Z", "TOO_SOON"], // now
    ["2026-10-10T19:29:55Z", "TOO_SOON"], // seconds
    ["2026-10-10T19:29:00.001Z", "TOO_SOON"],
    ["2025-10-10T19:29:59.999Z", "TOO_FAR"],
  ])("validates canonical elapsed horizon from %s", (anchor, code) => {
    expect(
      resolveOneTimeSchedule(
        { kind: "AT", localDateTime: "2026-10-10 19:30" },
        new Date(anchor),
        "UTC",
      ),
    ).toEqual({ ok: false, code });
  });

  it.each(["2026-10-10T19:29:00Z", "2025-10-10T19:30:00Z", "2026-10-10T19:28:30Z"])(
    "accepts inclusive boundaries and non-minute differences from %s",
    (anchor) => {
      expect(
        resolveOneTimeSchedule(
          { kind: "AT", localDateTime: "2026-10-10 19:30" },
          new Date(anchor),
          "UTC",
        ),
      ).toEqual({ ok: true, executeAt: new Date("2026-10-10T19:30:00Z") });
    },
  );

  it("uses an elapsed 365-day maximum across a DST boundary", () => {
    expect(
      resolveOneTimeSchedule(
        { kind: "AT", localDateTime: "2027-03-08 12:00" },
        new Date("2026-03-08T15:59:59.999Z"),
        "America/New_York",
      ),
    ).toEqual({ ok: false, code: "TOO_FAR" });
  });
});
