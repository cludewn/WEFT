# Scheduled messages

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Scheduled-Messages-ja)

Use scheduled messages to send an announcement later without an administrator being online. Choose a [one-time reservation](#create-a-one-time-post) for one reminder or a [recurring series](#create-a-recurring-post) for daily or weekly posts. One occurrence is one scheduled send within a recurring series; each successful send becomes a separate [managed message](Managed-Messages).

Already have a reservation? [Find its ID and check its state](#inspect-edit-or-cancel), then [edit](#change-a-reservation) or [cancel](#cancel-a-reservation) it. If a post did not appear, start with [the investigation steps](Troubleshooting#a-scheduled-post-did-not-appear).

<a id="before-creating"></a>

## Choose the destination and check the time

Run the creation command **in the destination** server text/announcement channel or active supported thread. There is no destination-channel option. You need Manage Messages there. WEFT needs view/send access and Embed Links for an authored embed. It checks its own current access again at delivery and will not join a private thread or unarchive a target to send.

For a local date or recurring time, check [WEFT’s default timezone](Timezones-and-Scheduling) first. Discord displays the returned send instant in each viewer’s client timezone, which may differ from the timezone used for input.

**Creating a reservation saves future work; it does not send the message.** Separate creation commands can create duplicate reservations. If a creation result is uncertain, [inspect the saved records and Discord](#save-the-schedule-id) before creating another.

<a id="create-a-one-time-post"></a>

## Schedule one reminder

For example, to post a maintenance reminder two hours from now:

1. In the destination, select [`/message schedule create`](Commands-Message#message-schedule-create). Enter `2h` in `after` and leave `at` unset, then run the command.
2. In the form, enter the reminder text, an embed, or both, following the [shared message fields](Managed-Messages#shared-form-rules). Submit the form to save the reservation; opening it alone creates nothing.
3. Check the response for the **schedule ID and send time**, and [keep the ID and verify the saved reservation](#save-the-schedule-id). This response confirms saving, not delivery.

The `2h` delay begins after form submission and fresh checks; time spent filling out the form does not shorten it. Relative input uses one positive integer and one unit: `m`, `h` or `d`.

To schedule a calendar date instead, select the same command, leave `after` unset and enter a future local datetime in `at`, in `YYYY-MM-DD HH:mm` format without quotation marks. `2026-11-01 19:30` illustrates the format; choose a valid future date when using it. **Supply exactly one of `after` and `at`.** Both methods allow 1 minute through 365 elapsed days. See [time input and DST rules](Timezones-and-Scheduling) for rejected dates and times.

<a id="create-a-recurring-post"></a>

## Schedule daily or weekly posts

For example, to post an announcement every Monday, Wednesday and Friday at 09:30 Tokyo time:

1. In the destination, select [`/message schedule recurring-create`](Commands-Message#message-schedule-recurring-create). For `frequency`, **select weekly** (value: `weekly`); this is a choice, not free text. Enter `09:30` in `time`, `mon,wed,fri` in `weekdays` and `Asia/Tokyo` in `timezone`, then run the command.
2. Enter the announcement text/embed in the [shared content form](Managed-Messages#shared-form-rules), then submit it. No series exists before submission.
3. Check the returned **schedule ID and first send time**. [Keep the ID and run status](#save-the-schedule-id) to verify the frequency, weekdays, local time, saved timezone and current occurrence.

For daily posts, select **daily** (value: `daily`) in `frequency` and omit `weekdays`. `time` uses a 24-hour `HH:MM` value. Weekly `weekdays` is text containing unique comma-separated tokens from `mon,tue,wed,thu,fri,sat,sun`.

Creation captures the explicit named IANA timezone, or WEFT’s current default at form submission when `timezone` is omitted. Later default changes do not move the series. During daylight saving time (DST), a nonexistent local time is skipped; a repeated time runs only at the earlier instant. See [timezone examples](Timezones-and-Scheduling#dst-gaps-and-overlaps).

Monthly rules, raw cron, arbitrary intervals, start/end dates and occurrence counts are unsupported. The [command details](Commands-Message#message-schedule-recurring-create) describe the accepted input.

<a id="save-the-schedule-id"></a>

## Keep the schedule ID and read the creation result

A saved reservation and its execution setup are separate. **Execution registration** means arranging for WEFT’s scheduler to pick up that saved reservation when due. A setup warning after confirmed saving does not mean saving failed; keep the ID and let WEFT check/repair the execution request. List/status do not test that registration. If the reservation remains overdue, follow [the investigation steps](Troubleshooting#a-scheduled-post-did-not-appear).

For either kind, keep the **full schedule ID, destination and returned send time**. The schedule ID identifies the reservation, not a Discord message; recurring posts use one schedule ID for the series. Use it for status, edits and cancellation, including after a reservation disappears from the active list.

| Creation response                  | What to check and do                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Saved, with ID and time            | Keep the ID, then use status below to check the saved time and state.                                     |
| Saved; execution setup unconfirmed | The database schedule is confirmed; WEFT can repair registration. Do not recreate merely to repair setup. |
| Save unconfirmed                   | Saving is neither confirmed successful nor failed. Check list/status and Discord before another creation. |

If the response did not provide an ID, use the original channel’s list to inspect saved reservations. A missing row alone does not prove that creation failed or that nothing was sent. Follow [scheduled-post investigation](Troubleshooting#a-scheduled-post-did-not-appear) if the result remains unclear.

<a id="inspect-edit-or-cancel"></a>

## Find a reservation and check its saved state

Use the **original server and channel** with current Manage Messages permission for list, status, edits and cancellation. Any administrator with that permission can manage the reservation. Archived supported threads remain valid for saved-schedule administration, and WEFT’s current send permission is not required for it.

Creator departure or role loss does not stop reservations. At delivery, WEFT checks its own current access, not the creator’s current roles.

<a id="find-the-schedule-id"></a>

### Find the ID and run status

1. If you kept the schedule ID, go directly to step 3. Otherwise, run [`/message schedule list`](Commands-Message#message-schedule-list) **with no options** in the original channel. It shows reservations that have not ended, up to 10 per page, without message content. Use its Previous/Next buttons if available.
2. Copy the full ID of the intended reservation. Completed or cancelled reservations are not in this list; use the ID you kept to inspect them.
3. Select [`/message schedule status`](Commands-Message#message-schedule-status), enter the actual schedule ID in `id`, then run it. Check the destination, saved time and state. For a recurring series, also check the recurrence, saved timezone and current occurrence separately.

| Level                | How to read the state                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| One-time reservation | `ACTIVE` is waiting; `EXECUTING` means execution has begun.                                                     |
| Recurring series     | Describes the reservation as a whole; read its current occurrence state separately.                             |
| Recurring occurrence | `PENDING` is waiting, `EXECUTING` is in progress, and `RETRY_PENDING` is waiting for an allowed pre-send retry. |

These are saved schedule/occurrence states. A thread command’s `PENDING` response instead means WEFT is still processing or checking the result. List and status do not expose the saved message content or verify current Discord message existence or execution registration. During a recurring retry, the displayed due time is the occurrence’s original time, not its next retry wake.

If list buttons stop working, run a fresh list. A failed page is not an empty list. [Button lifetime and concurrent changes](#button-lifetime-and-concurrent-changes) explain the limits.

<a id="change-a-reservation"></a>

## Change content or time

Use the reservation’s actual schedule ID in `id` for each operation below. A one-time reservation must still be `ACTIVE`; executing or terminal one-time work cannot be changed. Changes to reservations do not edit messages already sent.

<a id="edit-future-content"></a>

### Change future text or an embed

For example, to correct an announcement before it is sent:

1. Select [`/message schedule edit`](Commands-Message#message-schedule-edit), enter the schedule ID in `id`, then run it. This works for either kind of reservation.
2. Change the saved text/embed in the form, then submit it.
3. Read whether the response confirms a saved change or no change. Status does not display content. If the result is unconfirmed or another edit conflicts, [check the current reservation before retrying](#concurrent-edits-and-execution).

An executing or retrying recurring occurrence keeps its captured content; a payload edit does not replace that occurrence.

### Move a one-time send

1. Select [`/message schedule reschedule`](Commands-Message#message-schedule-reschedule), enter the schedule ID in `id` and `2h` in `after` to move the reminder to two hours after this operation. Leave `at` unset. Alternatively, use only `at` with the local datetime format described above.
2. Check the response for the new send time, then run `/message schedule status` with the same `id` to check the saved time and state.

Use this command only for a one-time reservation. If execution setup is unconfirmed after a confirmed reschedule, the saved change remains authoritative and WEFT can repair registration.

<a id="change-repeat-settings"></a>

### Change recurring days, time or timezone

For example, to change an active weekly series to daily posts at 10:00:

1. Select [`/message schedule recurrence-edit`](Commands-Message#message-schedule-recurrence-edit). Enter the schedule ID in `id`, select **daily** (value: `daily`) in `frequency`, enter `10:00` in `time` and omit `weekdays`. Omit `timezone` to keep the saved timezone; enter a named IANA timezone to change it.
2. Read the result, then run `/message schedule status` with the same `id`. Confirm the saved recurrence, timezone and current occurrence.

A recurrence change replaces pending work. An executing or retrying occurrence keeps its captured settings, so the new settings wait for it to settle before future work is prepared. A successful edit does not mean an in-flight send was changed.

<a id="cancel-a-reservation"></a>

## Cancel future posting and verify

1. In the original channel, select [`/message schedule cancel`](Commands-Message#message-schedule-cancel), enter the actual schedule ID in `id`, then run it.
2. Read whether cancellation is confirmed, already confirmed, rejected or unconfirmed. Then run `/message schedule status` with the same `id` to inspect the saved state. Do not treat disappearance from list alone as proof of cancellation.

**Cancellation does not delete sent messages or forcibly stop an external send already executing.** One-time `EXECUTING` cannot be cancelled. Recurring cancellation skips pending/retry-pending work and prevents future occurrences, but its already-executing occurrence can still finish sending.

If a recurring post arrives after cancellation, [compare the cancellation response and the executing occurrence](Troubleshooting#post-after-recurring-cancel) before changing the series again. A late post alone does not prove the cancellation failed.

Confirmed cancellation remains cancelled even if queued-work cleanup is unconfirmed. This differs from cancellation itself being unconfirmed: a later saved state alone does not prove that the uncertain cancellation request succeeded. If the outcome is unclear, [inspect the reservation and destination](Troubleshooting#a-scheduled-post-did-not-appear).

<a id="read-the-status-and-verify-delivery"></a>

## Check the actual post after its scheduled time

1. Run `/message schedule status` with the saved schedule ID in `id` in the original channel.
2. For completed one-time work, open the result message link when present and inspect the actual post. For recurring posts, check the destination for the intended occurrence’s post; status describes the series and its current occurrence, rather than a history of all sent posts.
3. If the post is missing or its result is unclear, follow [scheduled-post investigation](Troubleshooting#a-scheduled-post-did-not-appear) before creating replacement work. Saved creation, an active series or an absent list row does not prove delivery.

Each successful send becomes a separate [managed message](Managed-Messages). To change a message already sent, use that guide rather than editing the reservation.

**An unconfirmed result does not establish that no message was sent.** WEFT does not continue delayed blind resends after a possible send. Inspect Discord before replacing work; the [retry and restart rules](#uncertain-sends) explain why duplicate delivery remains possible.

<a id="concurrent-edits-and-execution"></a>

## Details: concurrent edits and execution

A **revision** is the saved version number used to detect intervening changes. Forms remember the version they opened, so concurrent edits reject stale forms rather than overwrite newer work. If an edit conflicts, use status to check the current reservation and open a fresh edit form to read the saved content without submitting. If a result is unconfirmed, follow [available checks](Troubleshooting#available-checks) before submitting another change. Changed payloads increment revision; normalized identical payloads do not. One-time rescheduling increments revision and audits even for the same instant.

An active recurring series can be edited while an occurrence executes or retries. That occurrence keeps its captured content and settings. A recurrence change replaces pending work; preparation of future work waits for executing/retrying work to settle. Exact normalized recurrence equality makes no change.

<a id="button-lifetime-and-concurrent-changes"></a>

## Details: list buttons and changing results

- List buttons belong to the initiator, last 5 minutes from creation, and are invalidated by restart. Navigation does not extend their lifetime.
- Each page reads fresh data. Concurrent changes can move or repeat rows between pages.
- A failed page is not an empty list. Run a fresh list if the controls no longer work.
- WEFT retains at most 128 list sessions across the process, separately from saved schedules. A new list is rejected when those slots are full. Expired sessions with unfinished work can retain a slot until that work settles.

<a id="late-work-restart-and-retries"></a>

## Details: late work and restart

| Recovery / retry timing                                                       | Duration (minutes) | Measurement and conditions                                                                                              |
| ----------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| <!-- fact:one-time-grace --> One-time overdue grace                           | 60                 | Includes exactly 60 minutes after the scheduled time.                                                                   |
| <!-- fact:recurring-grace --> Latest missed recurring occurrence grace        | 15                 | Includes exactly 15 minutes after the scheduled time.                                                                   |
| <!-- fact:recurring-retry-lifetime --> Recurring safe pre-send retry lifetime | 15                 | Measured from the first attempt, including exactly 15 minutes afterward. This is separate from missed-occurrence grace. |

| Retry policy                                                        | Maximum retries | Counting rule                                           |
| ------------------------------------------------------------------- | --------------- | ------------------------------------------------------- |
| <!-- fact:message-retries --> Safe pre-send application retry limit | 3               | The retry count is saved; restarting does not reset it. |

For example, ordinary one-time recovery at 60 minutes after due remains inside grace; later than that it fails instead of sending arbitrarily old content. Recurring recovery considers only the latest eligible missed calendar occurrence. It may send that one within grace, records older misses as a skipped range, and otherwise advances to the future. It does not replay every missed post.

Checks and repairs run periodically, with 60 seconds between completed sweeps. Startup recovery, Discord waits, changed permissions and archived targets can prevent or delay sending. There is no exact-second guarantee.

<a id="uncertain-sends"></a>

## Details: retries and unknown send results

Safe pre-send retries apply only before a request capable of creating a Discord message. Retry counts persist across restart. The recurring retry lifetime starts at its first attempt and is separate from the missed-occurrence grace.

After an ambiguous send, WEFT can make at most one immediate replay tied to the original request to reduce duplicates. This is automatic; you do not supply an internal identifier. WEFT does not continue delayed blind resends. Duplicate reduction does not guarantee exactly-once delivery.

On startup, interrupted `EXECUTING` one-time sends and recurring occurrences become `EXECUTION_INTERRUPTED_UNCONFIRMED` without resending. **Inspect Discord before creating replacement work.** Use the symptom-specific [scheduled-post investigation](Troubleshooting#a-scheduled-post-did-not-appear), [command reference](Commands-Message), and [restore risks](Backup-and-Recovery).
