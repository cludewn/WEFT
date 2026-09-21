import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";

import {
  ALL_WEEKDAYS_MASK,
  findNextOccurrence,
  isRecurringRetryWithinLifetime,
  normalizeRecurringTimezone,
  parseRecurringCommandInput,
  resolveLocalCandidate,
  selectMissedAndFutureOccurrences,
  validateRecurrence,
  type RecurrenceDefinition,
} from "../../src/recurring-message.js";

const dailyUtc: RecurrenceDefinition = {
  frequency: "DAILY",
  weekdayMask: ALL_WEEKDAYS_MASK,
  localTime: "09:00",
  timezone: "UTC",
};

describe("recurring message calendar", () => {
  it("parses only the supported recurring command syntax", () => {
    expect(parseRecurringCommandInput({ frequency: "daily", time: "09:30" })).toEqual({
      frequency: "DAILY",
      weekdayMask: 127,
      localTime: "09:30",
    });
    expect(
      parseRecurringCommandInput({
        frequency: "weekly",
        time: "23:59",
        weekdays: " MON , Wed,fri ",
        timezone: "america/new_york",
      }),
    ).toEqual({
      frequency: "WEEKLY",
      weekdayMask: 21,
      localTime: "23:59",
      explicitTimezone: "America/New_York",
    });
    for (const input of [
      { frequency: "daily", time: "09:30", weekdays: "mon" },
      { frequency: "weekly", time: "09:30" },
      { frequency: "weekly", time: "09:30", weekdays: "" },
      { frequency: "weekly", time: "09:30", weekdays: "mon,mon" },
      { frequency: "weekly", time: "09:30", weekdays: "mon,,wed" },
      { frequency: "weekly", time: "09:30", weekdays: "mon;wed" },
      { frequency: "weekly", time: "09:30", weekdays: "monday" },
      { frequency: "daily", time: "9:30" },
      { frequency: "daily", time: "09:30:00" },
      { frequency: "daily", time: "24:00" },
      { frequency: "daily", time: "09:30", timezone: "+09:00" },
    ])
      expect(parseRecurringCommandInput(input)).toBeUndefined();
  });
  it("normalizes supported recurrence and rejects invalid combinations and minute precision", () => {
    expect(validateRecurrence(dailyUtc)).toEqual({ ok: true, definition: dailyUtc });
    expect(validateRecurrence({ ...dailyUtc, frequency: "DAILY", weekdayMask: 1 })).toEqual({
      ok: false,
      error: "INVALID_WEEKDAY_MASK",
    });
    expect(validateRecurrence({ ...dailyUtc, frequency: "WEEKLY", weekdayMask: 0 })).toEqual({
      ok: false,
      error: "INVALID_WEEKDAY_MASK",
    });
    expect(validateRecurrence({ ...dailyUtc, localTime: "09:00:00" })).toEqual({
      ok: false,
      error: "INVALID_LOCAL_TIME",
    });
    expect(validateRecurrence({ ...dailyUtc, localTime: "9:00" })).toEqual({
      ok: false,
      error: "INVALID_LOCAL_TIME",
    });
  });

  it("accepts zones and aliases, preserves alias identity, normalizes casing, and rejects offsets", () => {
    expect(normalizeRecurringTimezone("UTC")).toBe("UTC");
    expect(normalizeRecurringTimezone("america/new_york")).toBe("America/New_York");
    expect(normalizeRecurringTimezone("US/Eastern")).toBe("US/Eastern");
    for (const offset of ["+05", "+0530", "+05:30", "+00", "-08", "-0800", "-08:00"]) {
      expect(normalizeRecurringTimezone(offset)).toBeUndefined();
    }
    expect(normalizeRecurringTimezone("Not/A_Zone")).toBeUndefined();
  });

  it("selects daily and weekly calendar occurrences strictly after the boundary", () => {
    expect(
      findNextOccurrence(dailyUtc, 0, new Date("2030-01-01T09:00:00.000Z")).occurrence,
    ).toMatchObject({
      intendedLocalDate: "2030-01-02",
      intendedLocalTime: "09:00",
      scheduledFor: new Date("2030-01-02T09:00:00.000Z"),
    });
    const mondayAndFriday = {
      ...dailyUtc,
      frequency: "WEEKLY" as const,
      weekdayMask: 0b001_0001,
    };
    expect(
      findNextOccurrence(mondayAndFriday, 0, new Date("2030-01-01T10:00:00.000Z")).occurrence,
    ).toMatchObject({ intendedLocalDate: "2030-01-04", intendedLocalTime: "09:00" });
  });

  it("uses the same strict boundary for creation and recurrence edits", () => {
    const establishment = new Date("2030-01-01T08:59:59.999Z");
    const creation = findNextOccurrence(dailyUtc, 0, establishment);
    const edit = findNextOccurrence(dailyUtc, 0, establishment);
    expect(creation).toEqual(edit);
    expect(creation.occurrence.scheduledFor).toEqual(new Date("2030-01-01T09:00:00.000Z"));
  });

  it("classifies ordinary local time, skips a gap, and chooses the earlier overlap instant", () => {
    expect(
      resolveLocalCandidate(Temporal.PlainDateTime.from("2026-02-01T12:00"), "America/New_York", 0),
    ).toMatchObject({
      kind: "OCCURRENCE",
      overlap: false,
      scheduledFor: new Date("2026-02-01T17:00:00.000Z"),
    });
    expect(
      resolveLocalCandidate(Temporal.PlainDateTime.from("2026-03-08T02:30"), "America/New_York", 7),
    ).toEqual({
      kind: "DST_GAP",
      definitionRevision: 7,
      intendedLocalDate: "2026-03-08",
      intendedLocalTime: "02:30",
    });
    expect(
      resolveLocalCandidate(Temporal.PlainDateTime.from("2026-11-01T01:30"), "America/New_York", 0),
    ).toMatchObject({
      kind: "OCCURRENCE",
      overlap: true,
      scheduledFor: new Date("2026-11-01T05:30:00.000Z"),
    });
  });

  it("does not assume a one-hour transition and handles a skipped local date", () => {
    expect(
      resolveLocalCandidate(
        Temporal.PlainDateTime.from("2026-10-04T02:15"),
        "Australia/Lord_Howe",
        0,
      ),
    ).toMatchObject({ kind: "DST_GAP" });
    expect(
      resolveLocalCandidate(
        Temporal.PlainDateTime.from("2026-04-05T01:45"),
        "Australia/Lord_Howe",
        0,
      ),
    ).toMatchObject({ kind: "OCCURRENCE", overlap: true });
    expect(
      resolveLocalCandidate(Temporal.PlainDateTime.from("2011-12-30T12:00"), "Pacific/Apia", 0),
    ).toMatchObject({ kind: "DST_GAP" });
  });

  it("runs an overlap once even when the boundary lies between its earlier and later instants", () => {
    const definition = { ...dailyUtc, localTime: "01:30", timezone: "America/New_York" };
    const result = findNextOccurrence(definition, 0, new Date("2026-11-01T06:00:00.000Z"));
    expect(result.occurrence.intendedLocalDate).toBe("2026-11-02");
  });

  it("keeps a materialized instant stable as an absolute value", () => {
    const occurrence = findNextOccurrence(
      { ...dailyUtc, timezone: "America/New_York" },
      0,
      new Date("2026-03-07T00:00:00.000Z"),
    ).occurrence;
    const persisted = new Date(occurrence.scheduledFor);
    findNextOccurrence(
      { ...dailyUtc, timezone: "America/Chicago" },
      0,
      new Date("2026-03-07T00:00:00.000Z"),
    );
    expect(occurrence.scheduledFor).toEqual(persisted);
  });

  it("selects only the latest missed occurrence and the first future occurrence after long downtime", () => {
    const selection = selectMissedAndFutureOccurrences(
      dailyUtc,
      0,
      new Date("2030-01-01T00:00:00.000Z"),
      new Date("2030-06-01T09:10:00.000Z"),
    );
    expect(selection.latestMissed).toMatchObject({ intendedLocalDate: "2030-06-01" });
    expect(selection.latestMissedWithinGrace).toBe(true);
    expect(selection.firstFuture).toMatchObject({ intendedLocalDate: "2030-06-02" });
    expect(selection.skippedRange).toEqual({
      fromLocalDate: "2030-01-01",
      fromLocalTime: "09:00",
      throughLocalDate: "2030-05-31",
      throughLocalTime: "09:00",
    });
  });

  it("applies inclusive missed grace at now equal to scheduled time and at fifteen minutes", () => {
    expect(
      selectMissedAndFutureOccurrences(
        dailyUtc,
        0,
        new Date("2030-01-01T00:00:00.000Z"),
        new Date("2030-01-01T09:00:00.000Z"),
      ).latestMissedWithinGrace,
    ).toBe(true);
    expect(
      selectMissedAndFutureOccurrences(
        dailyUtc,
        0,
        new Date("2030-01-01T00:00:00.000Z"),
        new Date("2030-01-01T09:15:00.000Z"),
      ).latestMissedWithinGrace,
    ).toBe(true);
    expect(
      selectMissedAndFutureOccurrences(
        dailyUtc,
        0,
        new Date("2030-01-01T00:00:00.000Z"),
        new Date("2030-01-01T09:15:00.001Z"),
      ).latestMissedWithinGrace,
    ).toBe(false);
  });

  it("collects every DST gap in a missed calendar range once", () => {
    const definition = { ...dailyUtc, localTime: "02:30", timezone: "America/New_York" };
    const selection = selectMissedAndFutureOccurrences(
      definition,
      4,
      new Date("2025-01-01T00:00:00.000Z"),
      new Date("2027-12-01T00:00:00.000Z"),
    );
    expect(selection.skippedGaps).toEqual([
      {
        kind: "DST_GAP",
        definitionRevision: 4,
        intendedLocalDate: "2025-03-09",
        intendedLocalTime: "02:30",
      },
      {
        kind: "DST_GAP",
        definitionRevision: 4,
        intendedLocalDate: "2026-03-08",
        intendedLocalTime: "02:30",
      },
      {
        kind: "DST_GAP",
        definitionRevision: 4,
        intendedLocalDate: "2027-03-14",
        intendedLocalTime: "02:30",
      },
    ]);
    expect(new Set(selection.skippedGaps.map((gap) => JSON.stringify(gap))).size).toBe(3);
  });

  it("keeps one interior gap across downtime and does not double-count a shared search gap", () => {
    const definition = { ...dailyUtc, localTime: "02:30", timezone: "America/New_York" };
    const interior = selectMissedAndFutureOccurrences(
      definition,
      2,
      new Date("2026-03-01T00:00:00.000Z"),
      new Date("2026-03-10T12:00:00.000Z"),
    );
    expect(interior.skippedGaps).toEqual([
      {
        kind: "DST_GAP",
        definitionRevision: 2,
        intendedLocalDate: "2026-03-08",
        intendedLocalTime: "02:30",
      },
    ]);

    const shared = selectMissedAndFutureOccurrences(
      definition,
      2,
      new Date("2026-03-08T05:00:00.000Z"),
      new Date("2026-03-08T08:00:00.000Z"),
    );
    expect(shared.skippedGaps).toEqual(interior.skippedGaps);
    expect(
      findNextOccurrence(definition, 2, new Date("2026-03-08T08:00:00.000Z")).skippedGaps,
    ).toEqual([]);
  });

  it("returns no gap for gap-free ranges and preserves non-hour transition gaps", () => {
    expect(
      selectMissedAndFutureOccurrences(
        dailyUtc,
        0,
        new Date("2030-01-01T00:00:00.000Z"),
        new Date("2030-02-01T00:00:00.000Z"),
      ).skippedGaps,
    ).toEqual([]);
    expect(
      selectMissedAndFutureOccurrences(
        { ...dailyUtc, localTime: "02:15", timezone: "Australia/Lord_Howe" },
        9,
        new Date("2026-09-01T00:00:00.000Z"),
        new Date("2026-11-01T00:00:00.000Z"),
      ).skippedGaps,
    ).toEqual([
      {
        kind: "DST_GAP",
        definitionRevision: 9,
        intendedLocalDate: "2026-10-04",
        intendedLocalTime: "02:15",
      },
    ]);
  });

  it("applies the independent retry lifetime inclusively", () => {
    const first = new Date("2030-01-01T09:00:00.000Z");
    expect(isRecurringRetryWithinLifetime(first, new Date("2030-01-01T09:15:00.000Z"))).toBe(true);
    expect(isRecurringRetryWithinLifetime(first, new Date("2030-01-01T09:15:00.001Z"))).toBe(false);
  });
});
