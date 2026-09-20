import { Temporal } from "@js-temporal/polyfill";

export const RECURRING_MESSAGE_FREQUENCIES = ["DAILY", "WEEKLY"] as const;
export type RecurringMessageFrequency = (typeof RECURRING_MESSAGE_FREQUENCIES)[number];

export const ALL_WEEKDAYS_MASK = 0b111_1111;
export const RECURRING_MISSED_GRACE_MINUTES = 15;
export const RECURRING_RETRY_LIFETIME_MINUTES = 15;

export type RecurrenceInput = {
  frequency: RecurringMessageFrequency;
  weekdayMask: number;
  localTime: string;
  timezone: string;
};

export type RecurrenceDefinition = RecurrenceInput & {
  timezone: string;
};

export type RecurrenceValidationResult =
  | { ok: true; definition: RecurrenceDefinition }
  | {
      ok: false;
      error:
        "INVALID_FREQUENCY" | "INVALID_WEEKDAY_MASK" | "INVALID_LOCAL_TIME" | "INVALID_TIMEZONE";
    };

export type ResolvedCalendarCandidate = {
  kind: "OCCURRENCE";
  intendedLocalDate: string;
  intendedLocalTime: string;
  scheduledFor: Date;
  overlap: boolean;
};

export type DstGapCandidate = {
  kind: "DST_GAP";
  definitionRevision: number;
  intendedLocalDate: string;
  intendedLocalTime: string;
};

export type CalendarCandidate = ResolvedCalendarCandidate | DstGapCandidate;

export type NextOccurrenceResult = {
  occurrence: ResolvedCalendarCandidate;
  skippedGaps: DstGapCandidate[];
};

export type MissedOccurrenceSelection = {
  latestMissed: ResolvedCalendarCandidate | null;
  latestMissedWithinGrace: boolean;
  firstFuture: ResolvedCalendarCandidate;
  skippedRange: {
    fromLocalDate: string;
    fromLocalTime: string;
    throughLocalDate: string;
    throughLocalTime: string;
  } | null;
  skippedGaps: DstGapCandidate[];
};

const STRICT_LOCAL_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function isStrictRecurringLocalTime(localTime: string): boolean {
  return STRICT_LOCAL_TIME.test(localTime);
}

export function validateRecurrence(input: RecurrenceInput): RecurrenceValidationResult {
  if (!RECURRING_MESSAGE_FREQUENCIES.includes(input.frequency)) {
    return { ok: false, error: "INVALID_FREQUENCY" };
  }
  if (
    !Number.isInteger(input.weekdayMask) ||
    input.weekdayMask < 1 ||
    input.weekdayMask > ALL_WEEKDAYS_MASK ||
    (input.frequency === "DAILY" && input.weekdayMask !== ALL_WEEKDAYS_MASK)
  ) {
    return { ok: false, error: "INVALID_WEEKDAY_MASK" };
  }
  if (!isStrictRecurringLocalTime(input.localTime)) {
    return { ok: false, error: "INVALID_LOCAL_TIME" };
  }
  const timezone = normalizeRecurringTimezone(input.timezone);
  if (timezone === undefined) return { ok: false, error: "INVALID_TIMEZONE" };
  return { ok: true, definition: { ...input, timezone } };
}

export function normalizeRecurringTimezone(timezone: string): string | undefined {
  if (timezone.length === 0) return undefined;
  try {
    const normalized = Temporal.ZonedDateTime.from({
      timeZone: timezone,
      year: 2000,
      month: 1,
      day: 1,
      hour: 0,
    }).timeZoneId;
    return normalized.startsWith("+") || normalized.startsWith("-") ? undefined : normalized;
  } catch {
    return undefined;
  }
}

export function resolveLocalCandidate(
  intended: Temporal.PlainDateTime,
  timezone: string,
  definitionRevision: number,
): CalendarCandidate {
  const fields = {
    timeZone: timezone,
    year: intended.year,
    month: intended.month,
    day: intended.day,
    hour: intended.hour,
    minute: intended.minute,
    second: intended.second,
    millisecond: intended.millisecond,
    microsecond: intended.microsecond,
    nanosecond: intended.nanosecond,
  };
  const earlier = Temporal.ZonedDateTime.from(fields, { disambiguation: "earlier" });
  const later = Temporal.ZonedDateTime.from(fields, { disambiguation: "later" });
  const earlierMatches = earlier.toPlainDateTime().equals(intended);
  const laterMatches = later.toPlainDateTime().equals(intended);
  const sameInstant = earlier.epochNanoseconds === later.epochNanoseconds;
  const intendedLocalDate = intended.toPlainDate().toString();
  const intendedLocalTime = intended.toPlainTime().toString({ smallestUnit: "minute" });

  if (earlierMatches && laterMatches) {
    if (sameInstant) {
      return {
        kind: "OCCURRENCE",
        intendedLocalDate,
        intendedLocalTime,
        scheduledFor: new Date(Number(earlier.epochMilliseconds)),
        overlap: false,
      };
    }
    return {
      kind: "OCCURRENCE",
      intendedLocalDate,
      intendedLocalTime,
      scheduledFor: new Date(Number(earlier.epochMilliseconds)),
      overlap: true,
    };
  }
  if (!earlierMatches && !laterMatches) {
    return { kind: "DST_GAP", definitionRevision, intendedLocalDate, intendedLocalTime };
  }
  throw new Error("Unexpected Temporal timezone disambiguation shape");
}

export function findNextOccurrence(
  definition: RecurrenceDefinition,
  definitionRevision: number,
  strictlyAfter: Date,
): NextOccurrenceResult {
  const boundary = Temporal.Instant.fromEpochMilliseconds(
    strictlyAfter.getTime(),
  ).toZonedDateTimeISO(definition.timezone);
  const boundaryLocal = boundary.toPlainDateTime();
  let date = boundary.toPlainDate();
  const skippedGaps: DstGapCandidate[] = [];

  for (let searched = 0; searched < 3_000; searched += 1, date = date.add({ days: 1 })) {
    if (!weekdaySelected(definition.weekdayMask, date.dayOfWeek)) continue;
    const intended = toPlainDateTime(date, definition.localTime);
    if (Temporal.PlainDateTime.compare(intended, boundaryLocal) <= 0) continue;
    const candidate = resolveLocalCandidate(intended, definition.timezone, definitionRevision);
    if (candidate.kind === "DST_GAP") {
      skippedGaps.push(candidate);
      continue;
    }
    if (candidate.scheduledFor.getTime() > strictlyAfter.getTime()) {
      return { occurrence: candidate, skippedGaps };
    }
  }
  throw new Error("No recurring occurrence found within the supported search horizon");
}

export function selectMissedAndFutureOccurrences(
  definition: RecurrenceDefinition,
  definitionRevision: number,
  after: Date,
  now: Date,
): MissedOccurrenceSelection {
  if (now.getTime() < after.getTime()) {
    const future = findNextOccurrence(definition, definitionRevision, after);
    return {
      latestMissed: null,
      latestMissedWithinGrace: false,
      firstFuture: future.occurrence,
      skippedRange: null,
      skippedGaps: collectDstGapsInRange(definition, definitionRevision, after, future.occurrence),
    };
  }

  const firstAfter = findNextOccurrence(definition, definitionRevision, after);
  const latest = findLatestOccurrenceAtOrBefore(definition, definitionRevision, now);
  const hasMissed =
    latest !== null &&
    latest.scheduledFor.getTime() >= firstAfter.occurrence.scheduledFor.getTime();
  const latestMissed = hasMissed ? latest : null;
  const withinGrace =
    latestMissed !== null &&
    now.getTime() - latestMissed.scheduledFor.getTime() <= RECURRING_MISSED_GRACE_MINUTES * 60_000;
  const future = findNextOccurrence(definition, definitionRevision, now);
  const skippedThrough =
    latestMissed === null
      ? null
      : withinGrace
        ? findLatestOccurrenceAtOrBefore(
            definition,
            definitionRevision,
            new Date(latestMissed.scheduledFor.getTime() - 1),
          )
        : latestMissed;
  const skippedRange =
    skippedThrough === null ||
    skippedThrough.scheduledFor.getTime() < firstAfter.occurrence.scheduledFor.getTime()
      ? null
      : {
          fromLocalDate: firstAfter.occurrence.intendedLocalDate,
          fromLocalTime: firstAfter.occurrence.intendedLocalTime,
          throughLocalDate: skippedThrough.intendedLocalDate,
          throughLocalTime: skippedThrough.intendedLocalTime,
        };
  return {
    latestMissed,
    latestMissedWithinGrace: withinGrace,
    firstFuture: future.occurrence,
    skippedRange,
    skippedGaps: collectDstGapsInRange(definition, definitionRevision, after, future.occurrence),
  };
}

export function isRecurringRetryWithinLifetime(firstAttemptedAt: Date, claimTime: Date): boolean {
  return (
    claimTime.getTime() <= firstAttemptedAt.getTime() + RECURRING_RETRY_LIFETIME_MINUTES * 60_000
  );
}

function findLatestOccurrenceAtOrBefore(
  definition: RecurrenceDefinition,
  definitionRevision: number,
  atOrBefore: Date,
): ResolvedCalendarCandidate | null {
  const boundary = Temporal.Instant.fromEpochMilliseconds(atOrBefore.getTime()).toZonedDateTimeISO(
    definition.timezone,
  );
  let date = boundary.toPlainDate();
  for (let searched = 0; searched < 16; searched += 1, date = date.subtract({ days: 1 })) {
    if (!weekdaySelected(definition.weekdayMask, date.dayOfWeek)) continue;
    const candidate = resolveLocalCandidate(
      toPlainDateTime(date, definition.localTime),
      definition.timezone,
      definitionRevision,
    );
    if (
      candidate.kind === "OCCURRENCE" &&
      candidate.scheduledFor.getTime() <= atOrBefore.getTime()
    ) {
      return candidate;
    }
  }
  return null;
}

function collectDstGapsInRange(
  definition: RecurrenceDefinition,
  definitionRevision: number,
  strictlyAfter: Date,
  through: ResolvedCalendarCandidate,
): DstGapCandidate[] {
  const boundary = Temporal.Instant.fromEpochMilliseconds(
    strictlyAfter.getTime(),
  ).toZonedDateTimeISO(definition.timezone);
  const afterLocal = boundary.toPlainDateTime();
  const throughLocal = Temporal.PlainDateTime.from(
    `${through.intendedLocalDate}T${through.intendedLocalTime}`,
  );
  let date = afterLocal.toPlainDate();
  const gaps = new Map<string, DstGapCandidate>();

  for (; ; date = date.add({ days: 1 })) {
    const intended = toPlainDateTime(date, definition.localTime);
    if (Temporal.PlainDateTime.compare(intended, throughLocal) > 0) break;
    if (
      Temporal.PlainDateTime.compare(intended, afterLocal) <= 0 ||
      !weekdaySelected(definition.weekdayMask, date.dayOfWeek)
    ) {
      continue;
    }
    const candidate = resolveLocalCandidate(intended, definition.timezone, definitionRevision);
    if (candidate.kind === "DST_GAP") {
      gaps.set(
        `${candidate.definitionRevision}|${candidate.intendedLocalDate}|${candidate.intendedLocalTime}`,
        candidate,
      );
    }
  }
  return [...gaps.values()];
}

function weekdaySelected(mask: number, isoDayOfWeek: number): boolean {
  return (mask & (1 << (isoDayOfWeek - 1))) !== 0;
}

function toPlainDateTime(date: Temporal.PlainDate, localTime: string): Temporal.PlainDateTime {
  return date.toPlainDateTime(Temporal.PlainTime.from(localTime));
}
