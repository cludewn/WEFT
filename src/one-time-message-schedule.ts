import { Temporal } from "@js-temporal/polyfill";

import { isStrictRecurringLocalTime, resolveLocalCandidate } from "./recurring-message.js";
import { addRelativeDuration, parseRelativeDuration } from "./relative-duration.js";

export type OneTimeScheduleInput =
  { kind: "AFTER"; durationMs: number } | { kind: "AT"; localDateTime: string };

export const ONE_TIME_SCHEDULE_ERRORS = {
  MISSING_SELECTOR: "Specify either after or at.",
  CONFLICTING_SELECTORS: "Specify only one of after or at.",
  INVALID_DURATION: "Enter one duration from 1m through 365d using m, h, or d.",
  INVALID_AT_FORMAT: "Enter at as YYYY-MM-DD HH:mm using a 24-hour clock.",
  INVALID_AT_DATE: "Enter a valid calendar date for at.",
  INVALID_GUILD_TIMEZONE: "Configure a valid named IANA guild timezone before using at.",
  TIMEZONE_UNAVAILABLE: "WEFT could not load the guild timezone. Please try again later.",
  DST_GAP: "That local time does not exist in the guild timezone. Choose another time.",
  DST_OVERLAP:
    "That local time occurs twice in the guild timezone. Choose another time or use after.",
  TOO_SOON: "Schedule the message at least one minute ahead.",
  TOO_FAR: "Schedule the message no more than 365 elapsed days ahead.",
} as const;

export type OneTimeScheduleError = keyof typeof ONE_TIME_SCHEDULE_ERRORS;
type Failure = { ok: false; code: OneTimeScheduleError };

export function parseOneTimeLocalDateTime(
  input: string,
): { ok: true; local: Temporal.PlainDateTime } | Failure {
  if (
    input.length !== 16 ||
    !/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}$/.test(input) ||
    !isStrictRecurringLocalTime(input.slice(11))
  )
    return { ok: false, code: "INVALID_AT_FORMAT" };
  try {
    const local = Temporal.PlainDateTime.from(
      {
        year: Number(input.slice(0, 4)),
        month: Number(input.slice(5, 7)),
        day: Number(input.slice(8, 10)),
        hour: Number(input.slice(11, 13)),
        minute: Number(input.slice(14, 16)),
      },
      { overflow: "reject" },
    );
    return { ok: true, local };
  } catch {
    return { ok: false, code: "INVALID_AT_DATE" };
  }
}

export function parseOneTimeScheduleOptions(
  after: string | null | undefined,
  at: string | null | undefined,
): { ok: true; schedule: OneTimeScheduleInput } | Failure {
  const hasAfter = after !== null && after !== undefined;
  const hasAt = at !== null && at !== undefined;
  if (!hasAfter && !hasAt) return { ok: false, code: "MISSING_SELECTOR" };
  if (hasAfter && hasAt) return { ok: false, code: "CONFLICTING_SELECTORS" };
  if (hasAt) {
    const parsed = parseOneTimeLocalDateTime(at);
    return parsed.ok ? { ok: true, schedule: { kind: "AT", localDateTime: at } } : parsed;
  }
  try {
    return { ok: true, schedule: { kind: "AFTER", durationMs: parseRelativeDuration(after!) } };
  } catch {
    return { ok: false, code: "INVALID_DURATION" };
  }
}

/** Both inputs converge on the existing canonical instant; the caller owns the clock. */
export function resolveOneTimeSchedule(
  schedule: OneTimeScheduleInput,
  establishedAt: Date,
  timezone?: string,
): { ok: true; executeAt: Date } | Failure {
  if (schedule.kind === "AFTER") {
    try {
      return { ok: true, executeAt: addRelativeDuration(establishedAt, schedule.durationMs) };
    } catch {
      return { ok: false, code: "INVALID_DURATION" };
    }
  }
  const parsed = parseOneTimeLocalDateTime(schedule.localDateTime);
  if (!parsed.ok) return parsed;
  if (timezone === undefined) return { ok: false, code: "INVALID_GUILD_TIMEZONE" };
  const candidate = resolveLocalCandidate(parsed.local, timezone, 0);
  if (candidate.kind === "DST_GAP") return { ok: false, code: "DST_GAP" };
  if (candidate.overlap) return { ok: false, code: "DST_OVERLAP" };
  const aheadMs = candidate.scheduledFor.getTime() - establishedAt.getTime();
  if (aheadMs < 60_000) return { ok: false, code: "TOO_SOON" };
  if (aheadMs > 31_536_000_000) return { ok: false, code: "TOO_FAR" };
  return { ok: true, executeAt: candidate.scheduledFor };
}
