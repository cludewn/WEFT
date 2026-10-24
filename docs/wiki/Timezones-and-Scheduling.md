# Timezones and scheduling

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Timezones-and-Scheduling-ja)

Choose how WEFT should interpret the time before creating a reservation. A relative delay such as `2h` means elapsed time; a local date or daily time needs a timezone.

<a id="choose-time-input"></a>

## Choose an elapsed delay or local date

| Goal                                     | Input                                                                                        | Time interpretation                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Post two hours after submitting the form | `/message schedule create`: enter `2h` in `after`.                                           | Two elapsed hours after submission and fresh checks   |
| Post on a chosen local date              | `/message schedule create`: enter a local date in `at` (format example: `2026-11-01 19:30`). | That local date/time in WEFT’s current server default |
| Close a thread after two hours           | `/thread close-after`: enter `2h` in `after`.                                                | Relative delay only; no `at` option                   |

For `at`, [check the server default](#set-and-check-timezone) before entering the date. The calendar date is a format example; choose a valid future date within the allowed horizon. Use Discord’s option field without quotation marks. A day in `after` set to `1d` is exactly 24 elapsed hours.

For a one-time post:

1. Select [`/message schedule create`](Commands-Message#message-schedule-create) and enter the value in **exactly one** of `after` and `at` as shown above; leave the other unset.
2. Run the command and submit the content form to save the reservation. Keep the returned schedule ID and send time.
3. In the same channel, select [`/message schedule status`](Commands-Message#message-schedule-status), enter that actual schedule ID in `id`, then run it. Check the saved send time and state. Saving the reservation does not establish delivery.

For a thread close, follow [scheduled thread closing](Scheduled-Thread-Close) for creation and confirmation in the intended thread.

For `at`, creation reads the default during form submission, not opening. A one-time reschedule using `at` reads it during that operation. Saved one-time work keeps its fixed execution instant when the default later changes.

<a id="set-and-check-timezone"></a>

## Set and check WEFT’s timezone

An **IANA timezone** is a named set of regional time rules, such as `Asia/Tokyo` or `America/New_York`. WEFT’s default is `UTC`, stored separately for each server. Manage Server is required to change it.

1. Run [`/config show`](Commands-Config#config-show) with no options and check **WEFT default timezone**. Keep it if it already matches the region you need.
2. To change it, select [`/config timezone`](Commands-Config#config-timezone), enter `Asia/Tokyo` in `value`, then run it.
3. Read the saved/unchanged response and run `/config show` again to verify the saved timezone.

This is a WEFT application setting, not a Discord client preference. Named aliases are accepted; numeric offsets such as `+09:00` are not. Responses use Discord timestamps, which each viewer sees in their own timezone. That display may differ from the timezone used for input.

<a id="recurring-local-time"></a>

## Set a recurring local time

For a daily 09:30 post in Tokyo:

1. In the destination, select [`/message schedule recurring-create`](Commands-Message#message-schedule-recurring-create). In `frequency`, select **daily** (value: `daily`); enter `09:30` in `time` and `Asia/Tokyo` in `timezone`. Leave `weekdays` unset.
2. Run the command, submit the content form and keep the returned schedule ID and first send time.
3. In the same channel, run [`/message schedule status`](Commands-Message#message-schedule-status) with that schedule ID in `id`. Check the saved local time, timezone and current occurrence’s scheduled time.

Daily omits weekdays. Weekly requires at least one unique comma-separated token from `mon,tue,wed,thu,fri,sat,sun`; token case and surrounding whitespace are ignored. Time is strict 24-hour `HH:MM`. The calendar advances by local dates, not fixed 24/168-hour additions.

| Operation                 | If timezone is omitted                            | Effect of later server-default changes     |
| ------------------------- | ------------------------------------------------- | ------------------------------------------ |
| Create a recurring series | The default timezone is saved at form submission. | Saved series timezone stays unchanged.     |
| Edit recurrence           | The series’s saved timezone is retained.          | The series does not adopt the new default. |

Already-prepared occurrence instants stay fixed. Future preparation uses current timezone data and the current saved recurrence.

<a id="timing-is-eligibility-not-a-guaranteed-second"></a>

## Check saved time and late-work rules

For message reservations, use the status check above to compare the saved time with your intended time. If the Discord display differs, first distinguish the viewer’s timezone from WEFT’s input timezone. Saved time is an eligibility boundary, not an exact-second guarantee.

[Scheduled messages](Scheduled-Messages#late-work-restart-and-retries) allow an inclusive 60-minute one-time grace and 15-minute latest-missed recurring grace; recurring safe retries separately have 15 minutes from first attempt. [Thread closes](Scheduled-Thread-Close) do not use those message grace periods. Startup recovery, periodic checks, API waits and permission changes matter. Do not create duplicates to compensate for uncertain or delayed work.

<a id="relative-or-absolute-one-time-time"></a>

## Exact one-time input rules

[`create`](Commands-Message#message-schedule-create) and [`reschedule`](Commands-Message#message-schedule-reschedule) require exactly one selector. Supplying both, neither, or an empty value is invalid.

| Input   | Accepted form                                                                                          | Rejected examples or conditions                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `after` | One positive integer and `m`, `h` or `d`; surrounding whitespace and unit case are normalized.         | Compound `1h30m`, fractions, zero and leading-zero numbers                                                                   |
| `at`    | Exactly 16 ASCII characters `YYYY-MM-DD HH:mm`, zero-padded fields, one space, 24-hour `00:00`–`23:59` | Outer whitespace, `T`, seconds, fractions, `Z`, offsets, timezone annotations, invalid calendar dates, DST gaps and overlaps |

The inclusive horizon is 1 minute through 365 elapsed days from establishment, not a calendar year. For `at`, the difference need not be a whole-minute multiple: a calendar minute 90 seconds ahead can be valid. Invalid dates are rejected rather than rolled forward.

Only the resulting fixed execution time is stored for one-time work. [`close-after`](Commands-Thread#thread-close-after) supports only `after`, with the same 1m–365d elapsed range.

<a id="dst-gaps-and-overlaps"></a>

## Understand daylight saving time (DST)

Some regions move clocks forward or backward. A **gap** is a local time that does not exist; an **overlap** is a time that occurs twice. WEFT handles these differently for one-time and recurring work.

| Situation                                                       | One-time `at`                                                             | Recurring                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Local clock jumps forward and the requested time does not exist | The input is rejected as DST_GAP. Choose another time.                    | The occurrence is skipped and DST_GAP_SKIPPED is recorded. Its time is not shifted. |
| Local clock repeats a time                                      | The input is rejected as DST_OVERLAP. Choose another time or use `after`. | Only the earlier instant is used.                                                   |

For example, in `America/New_York`, `2026-03-08 02:30` is a gap and `2026-11-01 01:30` is an overlap. These illustrate DST; an actual reservation still needs a valid future date within range.

A daily 09:30 series stays at 09:30 local time across DST, so consecutive instants need not be 24 hours apart. `after` set to `1d` always means 24 elapsed hours. Other regions can change by amounts other than one hour; the same policy applies. Maintain runtime timezone data through reviewed updates.
