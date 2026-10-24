# Message commands

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Commands-Message-ja)

Use this page to check a message command's inputs and results. Choose [`/message send`](#message-send) to publish now, [`/message edit`](#message-edit) to update a managed post, or [`/message schedule list`](#message-schedule-list) and [`status`](#message-schedule-status) to inspect saved reservations.

All 10 operations are server-only and require the invoking user's current Manage Messages (`ManageMessages`). Use the intended destination for creation and the original channel for later management. Check each **Access** section for active-thread requirements and WEFT permissions. Command visibility does not replace authorization. Results and errors are ephemeral (visible only to the initiator). For a complete workflow, read [Managed messages](Managed-Messages) or [Scheduled messages](Scheduled-Messages).

| Command details                                                            | Feature guide                                        |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`/message send`](#message-send)                                           | [Managed messages](Managed-Messages)                 |
| [`/message edit`](#message-edit)                                           | [Managed messages](Managed-Messages)                 |
| [`/message schedule create`](#message-schedule-create)                     | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule recurring-create`](#message-schedule-recurring-create) | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule list`](#message-schedule-list)                         | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule status`](#message-schedule-status)                     | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule edit`](#message-schedule-edit)                         | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule reschedule`](#message-schedule-reschedule)             | [Timezones and scheduling](Timezones-and-Scheduling) |
| [`/message schedule recurrence-edit`](#message-schedule-recurrence-edit)   | [Scheduled messages](Scheduled-Messages)             |
| [`/message schedule cancel`](#message-schedule-cancel)                     | [Scheduled messages](Scheduled-Messages)             |

**Syntax and operation:** Syntax blocks describe command names and options; they are not strings to paste and execute. Select the WEFT command, set its options in Discord, then run it. Do not type `<...>` or optional-argument `[...]` brackets.

- **Text and choices:** Enter durations, times, timezones, IDs and weekday lists as text. For `frequency`, select the displayed **daily** or **weekly** choice; labels depend on Discord's language. `weekdays` is a comma-separated text input, not a picker.
- **Forms:** Send, edit, one-time creation, recurring creation and scheduled-content editing open a message form. Submit that form to request the send or saved change; opening it alone has no effect. Review all prefilled fields when editing. See the [shared text/embed rules](Managed-Messages#shared-form-rules) for field requirements and limits.
- **IDs:** `/message edit` uses a Discord message ID or supported message link in `message`. For schedule commands that take an `id` option, use a reservation UUID obtained from creation or the schedule list. These IDs are not interchangeable.
- **Read and direct changes:** List and status do not open a content form. Reschedule, recurrence-edit and cancel also use their slash options directly. For list navigation, use Previous/Next buttons rather than a page argument.

The examples below show what to enter for a specific purpose and what to check afterward. See [common Discord input guidance](Command-Reference#read-syntax). If an outcome is unconfirmed or partial, use [result-state guidance](Troubleshooting#result-states) before repeating it. A saved reservation and a delivered message are separate results. **Payload** means the text and supported embed content; **revision** is a saved version number that prevents an older form overwriting a newer change. **Execution registration** is scheduler setup for picking up a saved reservation, not a completed send. If a response mentions finalization, it means saving/confirming the result after the Discord operation. Use [available checks](Troubleshooting#available-checks) to distinguish current saved content, actual posts and operator-only history.

## /message send

**Purpose:** Send a bot-authored message and register it as a managed message.

**Access:**

- Requires Manage Messages (`ManageMessages`) in the current server text/announcement channel or active supported thread, including an accessible private thread or forum post. Targets the current channel, not a channel option.
- WEFT rechecks current access; sending requires ViewChannel and SendMessages or SendMessagesInThreads, plus EmbedLinks for an authored embed.

**Syntax:**

```text
/message send
```

**Arguments:**

No slash options.

**Example:**

To publish a simple rules reminder that WEFT can later manage:

1. In the intended destination channel, run `/message send` with no options.
2. In the form's **Message content** field, enter `Please read the updated server rules.` Leave the embed fields blank for this text-only example, then submit the form.
3. Check for confirmed managed-message success and retain the returned Discord message ID. Inspect the actual post in that channel.

Opening the form does not send. If the send or management registration is unconfirmed, follow [managed-message outcome guidance](Managed-Messages#permissions-and-uncertain-outcomes) before resending or deleting anything.

**Results:**

- **Form:** opens five message/embed fields; submission posts text, one supported embed, or both.
- **Confirmed success:** Discord message ID and WEFT management record are established.
- **Confirmed rejection:** not sent. Unknown send/registration outcomes are qualified separately below.

**Constraints:**

- Opening the form does not send. See the [shared payload limits](Managed-Messages#shared-form-rules). No attachments, impersonation or automatic mentions. An unconfirmed send may exist. A sent message with UNCONFIRMED registration is not confirmed managed; WEFT did not delete it.
- If WEFT safely attempts to undo a send by deleting the known message, distinguish confirmed deletion from confirmed absence; rejected or unknown deletion needs inspection. Inspect the existing post and saved record before resending.

**Related:** [Managed messages](Managed-Messages) · [Result states](Troubleshooting#result-states)

## /message edit

**Purpose:** Edit the complete text and supported embed of a managed message.

**Access:**

- Requires ManageMessages in the current server text/announcement channel or active supported thread. The managed message must be in that same channel.
- WEFT needs ViewChannel, ReadMessageHistory and current editability; an actual change leaving an authored embed also requires EmbedLinks. A coherent no-op performs no new embed mutation. Send permission is not required for editing.

**Syntax:**

```text
/message edit message:<id-or-link>
```

**Arguments:**

| Option    | Required/optional | Input method and conditions                                                                                                                                                                                             |
| --------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message` | Required          | String: Enter a 17–20 digit positive message ID within uint64 range, or an exact `https://discord.com/channels/<server-id>/<channel-id>/<message-id>` link in the current server/channel. Extra URL parts are rejected. |

**Example:**

To update an existing WEFT-managed rules reminder:

1. In the channel containing the post, run `/message edit` with its actual Discord message ID or supported message link in `message`.
2. In the prefilled form, change **Message content** to `Please read the updated server rules before posting.` Review the other fields and retain any existing embed you want to keep, then submit.
3. Check for updated or unchanged, and inspect that same Discord post. This edits the existing message; it does not publish another one.

If the form is stale or the current post differs from WEFT's saved content, stop and use [editing and uncertain-outcome guidance](Managed-Messages#permissions-and-uncertain-outcomes).

**Results:**

- **Form:** loads the saved payload.
- **Changed/unchanged:** a confirmed edit updates the post and revision once; identical coherent content returns unchanged.
- **Deletion detected:** confirmed missing Discord message is marked `DELETED`, preserving saved payload and revision.

**Constraints:**

- The message must be authored by WEFT, have a confirmed management record, and still be editable. Any authorized administrator may edit it. A stale form or actual Discord/saved-payload mismatch is rejected without overwrite.
- Unknown edit/finalization/restoration requires inspecting both message and record; PARTIAL does not prove old content was restored.

**Related:** [Managed messages](Managed-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule create

**Purpose:** Create one future managed-message send in the current channel.

**Access:**

- Requires Manage Messages (`ManageMessages`) in the current server text/announcement channel or active supported thread, including an accessible private thread or forum post. Targets the current channel, not a channel option.
- WEFT checks ViewChannel and SendMessages or SendMessagesInThreads, plus EmbedLinks for an authored embed, when creating the schedule. It checks its current permissions again when sending.

**Syntax:**

```text
/message schedule create [after:<duration>] [at:<YYYY-MM-DD HH:mm>]
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                                                                       |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `after` | Optional          | String: Specify exactly one of after/at. For after, enter a single positive integer with `m`, `h` or `d`, from 1m through 365d.                                   |
| `at`    | Optional          | String: Enter exactly 16 ASCII characters in `YYYY-MM-DD HH:mm` format, using WEFT’s current default timezone. Choose an instant 1 minute–365 elapsed days ahead. |

**Example:**

To reserve a maintenance reminder with a two-hour delay:

1. In the destination channel, run `/message schedule create` with `2h` in `after` and leave `at` unset.
2. In the form, enter `Scheduled maintenance begins shortly.` in **Message content** and leave the embed fields blank, then submit.
3. On a confirmed saved response, retain the schedule UUID and send time. In the same channel, use [`/message schedule status`](#message-schedule-status) with that UUID in `id` to inspect the reservation.
4. After the due time, inspect the actual post. A completed one-time status may provide its result message link.

The delay is established after form submission and fresh checks. Saving is not sending; if registration is pending, keep the saved reservation rather than create a duplicate.

**Results:**

- **Form:** opens shared payload fields; no reservation exists before submission.
- **Saved:** returns schedule ID and send time. `after` begins after submission and fresh checks.
- **Saved; registration pending:** the confirmed reservation remains for automatic repair. This differs from an unconfirmed save.

**Constraints:**

- Exactly one selector is required although both options are individually optional in Discord. Both/neither/empty input are rejected. at rejects invalid dates, DST gaps and overlaps, seconds, offsets and extra whitespace.
- UNCONFIRMED save is different from confirmed saved plus pending registration. Ordinary restart recovery has an inclusive 60-minute overdue grace. Creation is not deduplicated: repeating can create another schedule.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule recurring-create

**Purpose:** Create daily or weekly recurring posts with a saved local time and timezone.

**Access:**

- Requires Manage Messages (`ManageMessages`) in the current server text/announcement channel or active supported thread, including an accessible private thread or forum post. Targets the current channel, not a channel option.
- WEFT checks ViewChannel and SendMessages or SendMessagesInThreads, plus EmbedLinks for an authored embed, when creating the schedule. It checks its current permissions again when sending.

**Syntax:**

```text
/message schedule recurring-create frequency:<daily|weekly> time:<HH:MM> [weekdays:<weekday-list>] [timezone:<IANA>]
```

**Arguments:**

| Option      | Required/optional | Input method and conditions                                                                                                                                         |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frequency` | Required          | String with choices: Select **daily** or **weekly** in English, or **毎日** or **毎週** in Japanese. The values are `daily` and `weekly`.                           |
| `time`      | Required          | String: Enter a strict 24-hour `HH:MM` value, such as `09:30`.                                                                                                      |
| `weekdays`  | Optional          | String: Omit for `daily`; supply for `weekly`. Enter unique comma-separated days from `mon,tue,wed,thu,fri,sat,sun`. Token case and surrounding spaces are ignored. |
| `timezone`  | Optional          | String: Enter a named IANA zone or UTC, including aliases. Numeric offsets are rejected. Omit to capture WEFT’s default at form submission.                         |

**Example:**

To request support updates every Monday, Wednesday and Friday at 09:30 in Japan time:

1. In the destination channel, select `/message schedule recurring-create`. Select **weekly** (value: `weekly`) for `frequency`; enter `09:30` in `time`, `mon,wed,fri` in `weekdays`, and `Asia/Tokyo` in `timezone`, then run the command.
2. In the form, enter `Please post today's support updates here.` in **Message content**, leave the embed fields blank, and submit.
3. Retain the confirmed schedule UUID and first send time. Use [`/message schedule status`](#message-schedule-status) in the same channel with that UUID in `id` to check the weekly rule, local time, saved timezone and current occurrence.
4. After a due occurrence, inspect its actual post in Discord.

Select the frequency from its choices; type the weekday tokens as text. The saved-series response does not confirm that an occurrence has already been sent.

**Results:**

- **Form:** opens shared payload fields.
- **Saved:** submission creates one series with a schedule ID and first send time. Each successful occurrence later becomes a separate managed message.
- **Registration pending:** a confirmed saved series remains saved.

**Constraints:**

- No raw cron, monthly rules, end date or occurrence count. Omit weekdays for daily; weekly needs unique valid days. A very long timezone name can prevent the content form from opening because its encoded settings exceed Discord’s form-identifier limit. No reservation is created in that case; use a valid shorter IANA name/alias for the intended zone and verify the returned time after saving.
- DST gaps are skipped and overlaps run only at the earlier instant. Downtime considers only the latest missed occurrence within an inclusive 15-minute grace. UNCONFIRMED creation needs inspection before retry.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule list

**Purpose:** List nonterminal one-time and recurring schedules in this channel.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule list
```

**Arguments:**

No slash options.

**Example:**

To find a reservation ID for an upcoming reminder, run `/message schedule list` in its original channel with no options. Compare the kind, time, state and creator ID; use **Previous** and **Next** if further pages are available. Retain the full schedule UUID and open [`/message schedule status`](#message-schedule-status) with that UUID in `id` for details.

The list does not show message content or terminal schedules. If the expected row is missing, use a retained creation ID with status and follow [missing-post investigation](Troubleshooting#a-scheduled-post-did-not-appear); do not infer that it was cancelled.

**Results:**

- **Rows:** starts page 1 with up to 10 metadata entries: full schedule ID, creator ID, kind, status and time; never payloads.
- **Included work:** one-time `ACTIVE`/`EXECUTING` and nonterminal recurring series, combined in time/ID order.
- **Navigation:** Previous/Next buttons; empty page 1 has no controls.

**Constraints:**

- No page slash option. Controls belong to the initiator for 5 minutes and are lost on restart. Each navigation reads fresh state, so concurrent edits can move/repeat rows. Invalid/busy/stale controls require a new list, not an assumption about expiry.
- At most 128 list sessions are retained across the process; capacity exhaustion rejects a new list. An expired session with unfinished work can still occupy a slot until that work settles. This is not a limit on saved schedules.
- An unsafe or failed page is not proof that no schedules exist; no entries are silently truncated.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule status

**Purpose:** Read one schedule’s metadata without exposing its message content.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule status id:<schedule-id>
```

**Arguments:**

| Option | Required/optional | Input method and conditions                                                                                             |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`   | Required          | String: Enter the schedule UUID returned at creation or by list. It must belong to this server and the current channel. |

**Example:**

When a saved reminder has not appeared:

1. In its original channel, run `/message schedule status` with the actual schedule UUID in `id`. Use the ID returned at creation or by [`/message schedule list`](#message-schedule-list), not a Discord message ID.
2. For a one-time reservation, check state, due time and retry count. For a recurring series, also check the local rule, saved timezone and current occurrence state.
3. If a completed one-time reservation includes a message link, inspect the actual post. Status itself does not confirm that the message still exists.

For an executing, failed or uncertain send, use [scheduled-post troubleshooting](Troubleshooting#a-scheduled-post-did-not-appear) before making a replacement.

**Results:**

- **One-time:** status, target, creator, send time, retry count and a result message link when completed with an ID.
- **Recurring:** series state, recurrence, timezone, revision, current occurrence ID/state and retry count.
- **Time label:** an executing/retrying occurrence shows its original due instant, not the retry wake time.
- **Occurrence states:** `PENDING` is waiting to execute, `EXECUTING` is in progress, and `RETRY_PENDING` is waiting for an allowed pre-send retry.

**Constraints:**

- No Discord existence check, execution-registration check or repair occurs. Result states can change immediately after reading. Missing, unreadable or inconsistent state is not confirmed cancellation/failure.
- Use the actual message link and operator records when needed.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule edit

**Purpose:** Change the saved message content and embed for a one-time or recurring schedule.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule edit id:<schedule-id>
```

**Arguments:**

| Option | Required/optional | Input method and conditions                                                                                             |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`   | Required          | String: Enter the schedule UUID returned at creation or by list. It must belong to this server and the current channel. |

**Example:**

To change the text of a maintenance reminder before it is sent:

1. In the original channel, check [`/message schedule status`](#message-schedule-status). A one-time reservation must still be `ACTIVE`; an active recurring series can also be edited.
2. Run `/message schedule edit` with the actual schedule UUID in `id`.
3. In the prefilled form, change **Message content** to `Scheduled maintenance has been postponed.` Review and retain the embed fields you want to keep, then submit.
4. Check for a changed or unchanged response. Use status to inspect the schedule state; it does not display the saved text.

This changes saved content, not the send time or an already published post. An executing/retrying recurring occurrence keeps its captured content. If the result is unconfirmed, inspect the outcome before opening another editing form.

**Results:**

- **Form:** loads shared payload fields at the current revision.
- **Changed/unchanged:** changed content increments revision once; exact normalized equality changes neither revision nor audit.
- **In-flight recurring work:** an executing/retrying occurrence keeps its previously captured content.

**Constraints:**

- One-time requires ACTIVE; EXECUTING and terminal states reject editing. Active recurring series permit content editing while work runs, but it does not rewrite already sent messages or the content already captured for an executing occurrence.
- Stale forms reject without overwrite. For UNCONFIRMED, investigate the saved result using [available checks](Troubleshooting#available-checks) before opening a fresh form.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule reschedule

**Purpose:** Replace the send time of an ACTIVE one-time schedule without changing its content.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule reschedule id:<schedule-id> [after:<duration>] [at:<YYYY-MM-DD HH:mm>]
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                                                                       |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`    | Required          | String: Enter the schedule UUID returned at creation or by list. It must belong to this server and the current channel.                                           |
| `after` | Optional          | String: Specify exactly one of after/at. For after, enter a single positive integer with `m`, `h` or `d`, from 1m through 365d.                                   |
| `at`    | Optional          | String: Enter exactly 16 ASCII characters in `YYYY-MM-DD HH:mm` format, using WEFT’s current default timezone. Choose an instant 1 minute–365 elapsed days ahead. |

**Example:**

To move an upcoming one-time reminder to two hours from this change:

1. In the original channel, use [`/message schedule status`](#message-schedule-status) to check that the intended reservation is one-time and `ACTIVE`.
2. Run `/message schedule reschedule` with its actual schedule UUID in `id`, `2h` in `after`, and `at` unset. This operation has no message-content form.
3. Check the returned new send time, then use status with the same ID to inspect it. The content stays saved as before.

The two hours are measured from this operation, not added to the old due time. A confirmed time change remains saved if execution registration is pending; inspect conflicts or uncertainty before retrying.

**Results:**

- **Saved:** returns the new time; `after` is measured from this operation, not the old time.
- **Revision:** even the same instant increments revision and records the reschedule.
- **Registration pending:** the confirmed saved time remains in effect.

**Constraints:**

- Exactly one after/at with the create validation and timezone/DST rules. EXECUTING, cancelled or terminal one-time schedules cannot move. A recurring ID is rejected with guidance to recurrence-edit.
- Revision conflicts and UNCONFIRMED require checking status before retrying.

**Related:** [Timezones and scheduling](Timezones-and-Scheduling) · [Result states](Troubleshooting#result-states)

## /message schedule recurrence-edit

**Purpose:** Change an active recurring series’s frequency, local time, weekdays or timezone.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule recurrence-edit id:<schedule-id> frequency:<daily|weekly> time:<HH:MM> [weekdays:<weekday-list>] [timezone:<IANA>]
```

**Arguments:**

| Option      | Required/optional | Input method and conditions                                                                                                                                         |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Required          | String: Enter the schedule UUID returned at creation or by list. It must belong to this server and the current channel.                                             |
| `frequency` | Required          | String with choices: Select **daily** or **weekly** in English, or **毎日** or **毎週** in Japanese. The values are `daily` and `weekly`.                           |
| `time`      | Required          | String: Enter a strict 24-hour `HH:MM` value, such as `09:30`.                                                                                                      |
| `weekdays`  | Optional          | String: Omit for `daily`; supply for `weekly`. Enter unique comma-separated days from `mon,tue,wed,thu,fri,sat,sun`. Token case and surrounding spaces are ignored. |
| `timezone`  | Optional          | String: Enter a named IANA zone or UTC, including aliases. Numeric offsets are rejected. Omit to keep this series’s saved timezone.                                 |

**Example:**

To change a recurring announcement to every day at 10:00 while retaining its saved timezone:

1. In the original channel, inspect the intended series with [`/message schedule status`](#message-schedule-status).
2. Select `/message schedule recurrence-edit` and enter its actual schedule UUID in `id`. Select **daily** (value: `daily`) for `frequency`, enter `10:00` in `time`, and leave both `weekdays` and `timezone` unset, then run the command.
3. Check the changed or unchanged response. Use status to confirm the daily rule, local time and retained timezone.

This changes the repeating rule without opening a message-content form. An executing/retrying occurrence keeps its earlier settings; the new rule applies to later work after it settles.

**Results:**

- **Unchanged:** exact normalized equality leaves revision and current work untouched.
- **Changed:** increments revision and replaces pending work. A saved change may still await registration.
- **In-flight work:** executing/retrying occurrences retain settings; next-occurrence preparation waits for settlement.

**Constraints:**

- One-time IDs must use reschedule. Omitted timezone preserves this series’s saved zone, not the current server default. daily omits weekdays; weekly requires them. Existing running work cannot be retimed.
- Conflicts or UNCONFIRMED need status inspection before retry.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)

## /message schedule cancel

**Purpose:** Cancel a one-time schedule or stop future recurring occurrences.

**Access:**

- Requires current ManageMessages in the schedule’s original server and channel (text, announcement or supported thread). Archived threads remain valid for schedule administration.
- No current WEFT send permission is needed to inspect or administer the saved schedule.

**Syntax:**

```text
/message schedule cancel id:<schedule-id>
```

**Arguments:**

| Option | Required/optional | Input method and conditions                                                                                             |
| ------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `id`   | Required          | String: Enter the schedule UUID returned at creation or by list. It must belong to this server and the current channel. |

**Example:**

To stop an outdated reminder or future posts from a recurring announcement:

1. In the original channel, use [`/message schedule status`](#message-schedule-status) to identify the intended reservation and check whether work is already executing.
2. Run `/message schedule cancel` with the actual schedule UUID in `id`.
3. Read whether cancellation is confirmed, the reservation was already cancelled, or a one-time send cannot be cancelled because it is executing. After confirmed cancellation, inspect status with the same ID.

Confirmed cancellation remains cancelled if queued-work cleanup is pending. It does not delete a published post or forcibly stop an executing recurring send. If cancellation itself is unconfirmed, follow [result-state guidance](Troubleshooting#result-states) before another change.

**Results:**

- **One-time:** `ACTIVE` becomes `CANCELLED`; already cancelled is unchanged. `EXECUTING` cannot be cancelled.
- **Recurring:** prevents future occurrences and skips pending/retry-pending work; already-executing work remains in flight.
- **Cleanup pending:** confirmed cancellation remains cancelled even when queued-work cleanup is unconfirmed.

**Constraints:** Does not delete sent messages or forcibly stop a running external send. Completed/failed one-time schedules are terminal. Conflicting revisions or UNCONFIRMED cancellation require status inspection; do not infer cancellation from a missing list row.

If a recurring post arrives afterward, follow the [post-cancellation checks](Troubleshooting#post-after-recurring-cancel) before repeating cancellation or creating replacement work.

**Related:** [Scheduled messages](Scheduled-Messages) · [Result states](Troubleshooting#result-states)
