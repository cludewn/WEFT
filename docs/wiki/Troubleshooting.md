# Troubleshooting

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Troubleshooting-ja)

Choose the symptom you see, then follow its checks in order. Keep the exact command response and operation time. Before repeating a change, check what happened in Discord and what WEFT has saved; a missing notification or list entry alone does not establish failure or cancellation.

<a id="choose-a-symptom"></a>

## Start with the symptom

| Symptom                                                | Start here                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Automatic close is configured, but a thread stays open | [Check parent, exclusion and inactivity](#automatic-close-not-running)                            |
| A scheduled post did not arrive on time                | [Inspect the reservation before replacing it](#a-scheduled-post-did-not-appear)                   |
| A recurring post arrived after cancellation            | [Check cancellation and the executing occurrence](#post-after-recurring-cancel)                   |
| A scheduled close did not happen when expected         | [Check due time, current reservation and actual thread](Scheduled-Thread-Close#execution-results) |
| A managed-message send failed or is unconfirmed        | [Check the send and management record before resending](Managed-Messages#check-the-send-result)   |
| `/thread open` did not unarchive a thread              | [Check what open does](#thread-open-does-not-unarchive)                                           |
| A command is missing or permissions are rejected       | [Check installation and current access](#commands-missing-or-permissions-rejected)                |
| A response says Pending, UNCONFIRMED or PARTIAL        | [Interpret the result before retrying](#result-states)                                            |
| Bulk close did not process every selected thread       | [Read the result counts and current state](#bulk-close-skipped-targets)                           |
| A thread operation stays pending or cannot be repeated | [Investigate thread delays](#thread-delays)                                                       |
| An edit is stale, unchanged or mismatched              | [Check message editing](#an-edit-is-stale-unchanged-or-mismatched)                                |
| Bulk or list controls fail                             | [Check interactive controls](#bulk-or-list-controls-no-longer-work)                               |
| A preview is missing or a button fails                 | [Check previews](#previews)                                                                       |
| Audit notifications are missing                        | [Check stored history and notification delivery separately](#audit-notifications-missing)         |
| You need to restore a backup safely                    | [Verify the target and restore precautions](Backup-and-Recovery#choose-a-procedure)               |
| Startup, migration or readiness fails                  | [Check host operation](#startup-migration-or-readiness-failure)                                   |

<a id="available-checks"></a>

## Know what you can actually check

Start with the command response and the actual Discord resource. Use the display commands below for saved settings or reservation metadata; their required permissions still apply. They do not establish the history of an uncertain request.

| Question                                                       | Available check and its limit                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| What settings are saved?                                       | Use `/config show` or the feature's `show` command with Manage Server. Current values do not prove which earlier request saved them.                                                                                                                                                                                           |
| What is this thread's policy or current close reservation?     | Run `/thread status` **inside that thread** with Manage Threads. It does not show every unfinished close/open operation or terminal reservation history.                                                                                                                                                                       |
| What is saved for a message reservation?                       | In the original channel, use `/message schedule list` and `/message schedule status` with Manage Messages and the reservation ID. They show metadata, not message content or a complete recurring-post history.                                                                                                                |
| What message content is saved?                                 | Where editing is allowed, open `/message edit` with the message ID or `/message schedule edit` with the reservation ID and read the prefilled form **without submitting it**. Opening it does not change content. A rejected/unavailable form does not prove the record is absent. Inspect the actual Discord post separately. |
| What processing or history can only the host operator inspect? | [Application logs](Operations#inspect-operation-logs) and [database audit records](Audit-and-Privacy#audit-storage-reference). There is no complete audit-history viewer in Discord. If you lack host/DB access, keep the response, IDs and time and ask that operator to investigate.                                         |

If these checks cannot establish the previous result, leave changes paused. A matching current value, a missing log, or an absent reservation alone does not make a resend, deletion or another close safe.

<a id="automatic-close-not-running"></a>

## Automatic close is configured, but a thread stays open

**Possible causes:** the parent is not enabled, the thread is excluded, the recorded inactivity period has not elapsed, an explicit scheduled close takes precedence, or current Discord state/permissions prevent closing. Setting a period alone does not enable a parent.

**Check and act in order:**

1. Run [`/config auto-close show`](Commands-Config#config-auto-close-show) with no options. Check the inactivity period, bot-post policy and enabled parents. It displays at most 25 parents and a remaining count, so a parent missing from the display is not necessarily disabled.
2. Inside the affected thread, run [`/thread status`](Commands-Thread#thread-status) with no options. Check effective participation, parent policy and individual exclusion. If the parent is disabled, follow [setup](Automatic-Close#enable-a-parent-then-exempt-individual-threads) to enable the correct channel. If an exclusion is unintended, remove it with `/thread track`, then check status again. Track cannot override a disabled parent.
3. Compare the recorded activity or baseline with the current inactivity period. Parent enablement, exclusion removal and an observed return to active state can start a new baseline. Thread age alone does not determine eligibility. Check whether qualifying human posts, or bot posts when included, moved the time forward. If no time is recorded, follow the [missing-baseline checks](Automatic-Close#measurement-baselines); do not infer inactivity from thread age.
4. Check the explicit scheduled-close field in status. A waiting (`ACTIVE`) or executing (`EXECUTING`) reservation takes precedence; automatic close does not cancel it. If you intend to remove that reservation, use the separate [scheduled-close cancellation procedure](Scheduled-Thread-Close#cancel-or-close-now).
5. Inspect the actual archive/lock state and WEFT’s current access and Manage Threads permission in Discord. Already archived threads need no new archive; locked threads cannot be closed by WEFT. If a lock should be removed, an authorized administrator must do so manually before another attempt.
6. Allow for periodic checks: the first begins 5 minutes after startup, and later checks begin 5 minutes after the previous check finishes. Discord waits can add delay. If processing is already pending, use [thread-delay checks](#thread-delays).

**Safety:** do not shorten the period or repeat track merely to force a close. Shortening applies to existing activity, while repeated track on an included thread does not reset its timer. Removing a parent or excluding a thread does not forcibly stop an already-started close. Neither show nor status lists every pending lifecycle operation.

**If unresolved:** give the operator the parent/thread IDs, status response and observation time for [application-log checks](Operations#inspect-operation-logs): look for a matching `automatic_close_candidate_execution_failed` or a failed candidate-page scan, then any thread result-check warnings. WEFT does not reconstruct every post missed during downtime. See [activity, baselines and execution timing](Automatic-Close#what-counts-as-activity).

<a id="a-scheduled-post-did-not-appear"></a>

<a id="a-scheduled-post-is-missing-or-the-send-result-is-unknown"></a>

## A scheduled post did not arrive on time or its send result is unknown

**Possible causes:** the due time has not arrived, timezone misunderstanding, delayed registration/API work, target no longer sendable, elapsed grace, cancelled/failed work, or an interrupted/ambiguous send.

**Check in order:**

1. In the original channel, select [`/message schedule status`](Commands-Message#message-schedule-status), enter the retained reservation UUID in `id`, and run it. This is not a Discord message ID. If you did not retain it, run `/message schedule list` with no options in that channel; the list contains only nonterminal reservations. Disappearance is not proof of cancellation.
2. Inspect the actual Discord destination and any result message link. Status does not check message existence. Creation’s saved response confirms a reservation, not delivery.
3. Check due instant, saved recurring timezone, series/occurrence state and retry count. During a recurring retry, displayed due time is the original due time, not retry wake.
4. Check target archive state and WEFT’s current view/send/embed permissions.
5. After downtime, compare the [60-minute one-time and 15-minute recurring grace rules](Scheduled-Messages#late-work-restart-and-retries). Only the latest eligible missed recurring occurrence is considered; older posts are not all replayed.

**Choose the next action:**

| Observation                                                           | Action / retry condition                                                                                                                             |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed saved, setup pending                                        | Let WEFT repair registration; creating another reservation can duplicate work.                                                                       |
| Still executing or a live retry is pending                            | Observe; do not race it with a replacement send.                                                                                                     |
| `SEND_UNCONFIRMED` or `EXECUTION_INTERRUPTED_UNCONFIRMED`             | Sending may already have occurred. Inspect Discord and operator records before a manual replacement.                                                 |
| Confirmed rejection or expired grace                                  | Correct the cause, then compare the response with the actual destination. Create a replacement schedule only after ruling out a possible prior send. |
| Message exists but saving its management record/result is unconfirmed | Inspect both the record and post before resending or deleting.                                                                                       |

**Safety:** do not recreate a reservation while its send result is uncertain. Interrupted executing sends are not automatically resent after restart. There is no exact-second or exactly-once guarantee. Cancellation cannot forcibly stop a send already executing.

**If unresolved:** stop manual replacement attempts and ask the operator to correlate the schedule/occurrence ID, time, result code and actual message evidence. Use [scheduling details](Scheduled-Messages#uncertain-sends), not a guessed failure classification.

<a id="post-after-recurring-cancel"></a>

## A post arrived after cancelling a recurring series

An occurrence already `EXECUTING` when cancellation takes effect can still send. Confirmed recurring cancellation stops future occurrences and skips pending/retry-pending work; it does not withdraw an executing Discord request or delete a sent post.

1. Keep the cancellation response, schedule ID and time. In the original channel, run [`/message schedule status`](Commands-Message#message-schedule-status) with that ID. Distinguish confirmed cancellation from a conflict or `UNCONFIRMED` result.
2. Inspect the received post and retain its message ID/time. Compare it with the intended series and occurrence; another reservation may also post in the same channel. Status is not a complete occurrence history.
3. If cancellation was confirmed and the post belongs to an already-executing occurrence, do not recreate or repeatedly cancel the series to undo that send. Manage the existing post separately using [managed-message editing or Discord deletion](Managed-Messages#deletion-and-scheduling), where authorized. If more posts arrive or the evidence does not explain the send, ask the operator to compare cancellation and occurrence audit records before further changes.

A late post alone does not establish that a confirmed cancelled series became active again. If cancellation itself was unconfirmed, follow [result states](#result-states) before assuming future posting has stopped. See [cancellation scope](Scheduled-Messages#cancel-a-reservation).

<a id="thread-open-does-not-unarchive"></a>

## /thread open did not unarchive a thread

**Cause to check first:** `/thread open` reflects a thread that is already active in Discord. WEFT does not issue an unarchive request and does not change the lock state.

**Check and act:** inspect the actual archive and lock state in Discord. If the thread remains archived, use Discord’s own controls to unarchive it with the required permissions. Discord may also unarchive an unlocked thread when a user creates an interaction in it; do not assume this occurred without checking. Once active, run [`/thread open`](Commands-Thread#thread-open) inside the thread with no options if WEFT’s state still needs updating.

**Confirm:** check the command result and actual title. For a managed thread, WEFT removes only one applicable saved leading closed prefix when nonempty and updates its open-state record when needed. A supported active thread without a management record is accepted as a no-op. A thread closed with prefixing disabled may keep exactly the same title. Automatic state reflection may already have completed, so an unchanged result can be normal.

**Safety and details:** do not alternate close/open to clear a delay, and do not expect open to unlock a thread. If a result is Pending or unconfirmed, follow [thread-delay checks](#thread-delays). See [thread lifecycle](Thread-Lifecycle#reconcile-an-already-active-thread) for saved-prefix and manual-title behavior.

<a id="commands-missing-or-permissions-rejected"></a>

## Commands are missing or access is rejected

**Possible causes:** wrong installation server, missing/stale command deployment, actor permission loss, bot channel overwrites, private-thread access or membership.

**Check:**

1. Confirm installation into the intended server and registration in the intended Guild/Global scope.
2. Find the command in the [command reference](Command-Reference) and check its access section: `/config` requires the actor’s Manage Server, `/thread` Manage Threads, and `/message` Manage Messages. Also check the required server/channel/thread context. Being able to see a command is not authorization.
3. Check WEFT’s current channel permissions separately, including thread-specific access and overwrites. Thread changes require View Channel and Manage Threads; message sends also depend on current send/embed permissions for the destination. Read the individual command’s access section for exceptions, such as inspecting a saved schedule without current bot send permission.

**Action and retry:** redeploy changed definitions through [setup](Installation-and-Setup#register-commands), or correct the missing access and retry the rejected operation after confirming its result. Runtime restart does not register commands. Do not grant Administrator as a workaround. Inaccessible target names are intentionally undisclosed.

**If unresolved:** give the operator the command family, intended scope and generic error, without protected names or credentials.

<a id="bulk-close-skipped-targets"></a>

## Bulk close did not process every selected thread

**Possible causes:** only the selected subset is executed, eligibility or permissions changed after preview, another operation owns a thread, an explicit close is executing, or the admission window ended before all attempts could begin. A batch is not an all-or-nothing operation.

**Check and act in order:**

1. Keep the result counts. `Selected` is the selection frozen at confirmation, not every candidate in the preview. Deselected threads receive no operation from that batch.
2. Distinguish `Skipped` (no attempt began), `Pending` (started and still owned by WEFT), and `Failed or unconfirmed` (completion is not fully established). Inspect the actual selected threads in Discord; counts do not reveal target names after access changes.
3. For a skipped target, check current active/unlocked state, original filters, and current actor/WEFT View Channel and Manage Threads permissions. Use `/thread status` inside the thread for its current explicit close schedule. Another unfinished operation on that thread or an executing schedule can also prevent a new attempt.
4. Allow already-started Pending work to settle. At most three unresolved bulk-owned thread operations run across sessions. New attempts stop after the 5-minute admission window from confirmation; started work continues. There is no later completion notification for Pending work.
5. Create a fresh preview only after checking earlier outcomes and current eligibility. Restart invalidates controls and does not resume unstarted targets; completed effects remain.

**Safety:** do not immediately repeat the entire batch. Failed or unconfirmed results do not prove Discord stayed unchanged. A waiting explicit reservation cancelled by an attempted close is not restored if closing later fails or remains pending. A new preview does not undo that cancellation.

**Details:** [Bulk result counts and limits](Bulk-Thread-Close#confirm-and-interpret-the-summary). If the controls themselves are rejected, use [interactive-control checks](#bulk-or-list-controls-no-longer-work).

<a id="result-states"></a>

<a id="interpret-the-response-before-retrying"></a>

<a id="result-states-and-safe-retry"></a>

## Pending, UNCONFIRMED or PARTIAL: interpret before retrying

First distinguish work still owned by WEFT from an outcome that WEFT cannot establish. Pending calls for observation; an uncertain result calls for checking actual effects and saved evidence before another change.

| Result                        | Meaning                                                                                  | Next action                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Confirmed success             | Required effects and completion evidence are established.                                | Inspect expected output; do not repeat just because a notification is missing.                      |
| Unchanged / already completed | No new change was needed under that operation’s checks.                                  | Continue; this is not failure.                                                                      |
| PENDING                       | WEFT is still processing or checking the result, potentially including final audit work. | Wait and observe; do not race it with repeated commands.                                            |
| Skipped                       | This invocation did not start that target’s attempt.                                     | Inspect current eligibility before a new selection; not a completed close.                          |
| Confirmed failure             | The reported failure facts are established.                                              | Fix that cause, but read any qualification about external effects.                                  |
| UNCONFIRMED                   | Evidence cannot establish the full result.                                               | Inspect actual Discord state and saved records before retrying or deleting anything.                |
| PARTIAL                       | Only some historical effects are established.                                            | Inspect Discord and records; do not assume the old content was restored or the new content remains. |

The table describes operation responses. A recurring occurrence’s stored `PENDING` state instead means waiting for execution; `RETRY_PENDING` means waiting for an allowed pre-send retry. See [reservation metadata](Scheduled-Messages#inspect-edit-or-cancel).

For saved content and operator-only records, use [available checks](#available-checks). If they cannot establish the result, pause changes rather than treating uncertainty as permission to retry.

These states describe different levels of evidence. A database `CLOSED` record alone does not confirm archiving. Current `CANCELLED` state alone does not prove that a particular ambiguous cancellation committed.

When WEFT attempts to undo a message change, distinguish confirmed deletion, already absent, rejected deletion/restoration, and unknown outcome. Already absent confirms absence at observation, not who deleted it. “Failed or unconfirmed” does not prove Discord stayed unchanged.

| Schedule response                     | What is established                                                                 | Next action                                                                     |
| ------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Saved; execution setup unconfirmed    | Database save is confirmed; execution registration still needs confirmation/repair. | Keep the reservation and inspect status; do not recreate just for registration. |
| Cancelled; queued cleanup unconfirmed | Cancellation is confirmed; queue cleanup still needs confirmation.                  | Do not recreate or assume the reservation became active again.                  |
| Save/cancellation itself unconfirmed  | The mutation result is unknown.                                                     | Inspect current state and exact operator evidence before another mutation.      |

<a id="thread-delays"></a>

<a id="thread-closeopen-is-still-processing"></a>

## Thread closing or state reflection is still processing

**If the same thread cannot be operated on again soon after a close/open-related operation, allow for a wait of roughly 10 minutes.** Plan repeated operations with that possible wait in mind, and check the previous result before doing anything else. Another thread working normally does not establish that the first operation failed. The [thread lifecycle guide](Thread-Lifecycle#delays-and-safe-observation) explains what to check before another operation. Ten minutes is a guide, not a guaranteed release time.

**Possible causes:** Discord queueing or rate limits, a mutation awaiting settlement, saved-state or final-audit confirmation. `PENDING` can outlive the command’s wait budget without being a failure.

**Check in order:**

1. Keep the first response and operation time.
2. Inspect the actual title, archive state and lock state in Discord.
3. Use [`/thread status`](Commands-Thread#thread-status) for automatic-close policy and the current explicit close schedule. It does not list every pending mutation or final audit.
4. If the result remains unclear, ask the host operator to follow [application-log checks](Operations#inspect-operation-logs). Compare the operation time and thread ID with `thread_lifecycle_failed`, `thread_lifecycle_outcome_unknown` and any Discord result-check warnings. Those warnings can explain why a result could not be confirmed; they are not proof that Discord rejected the original change. Use [database audit history](Audit-and-Privacy#audit-storage-reference) when more investigation is needed.

**Action and retry:** wait while WEFT owns `PENDING` work; it may still complete, including after ten minutes. For an unconfirmed result, investigate the current state and operator evidence first. Do not alternate close/open or retry merely because ten minutes have passed. Once the previous outcome and current eligibility are understood, decide whether another operation is needed. Disabling prefixes does not guarantee bypassing restrictions.

**If unresolved:** keep the operation evidence for the operator. Restart is not a guaranteed repair and loses process-local observations; repeated restarts do not safely force a mutation replay. Missing notices establish neither success nor failure.

## An edit is stale, unchanged or mismatched

**Possible causes:** a newer revision, identical coherent content, a nonmanaged/wrong-channel message, current access loss, or a difference between Discord and saved payload.

**Check:** confirm the original channel, WEFT authorship and confirmed management record. Any currently authorized administrator can edit. Compare the response with the actual post; even an unchanged submission checks permissions and complete payload coherence.

**Action and retry:** after a revision conflict, open a fresh form and review the newer content. An unchanged result is normal. On a payload mismatch, stop and inspect both versions; WEFT does not overwrite the difference. Do not resend/delete when sending, saving its management record, editing, deletion or restoration remains unconfirmed. `PARTIAL` is not proof that old content was restored or new content remains.

**If unresolved:** keep the message ID, time and response (and a revision number if displayed) and follow [Managed messages](Managed-Messages#permissions-and-uncertain-outcomes) with the operator.

## Bulk or list controls no longer work

**Possible causes:** wrong user, stale revision, ongoing work, expiry, restart, lost permissions, malformed controls or unavailable reads. A generic rejection does not identify one exact cause.

**Check:** use the initiator’s view, current permissions and time since creation. Both selection and list views have a fixed 5-minute lifetime; navigation does not renew it.

**Action and retry:** run a fresh list for read-only metadata. For bulk, inspect already-started/Pending targets before a new preview. A preview over 50 candidates is rejected entirely; narrow its filters rather than assume truncation. Neither bulk restart nor new controls undo prior effects or resume unstarted targets.

**If unresolved:** keep the counts and first response; do not repeat an entire batch while earlier results are uncertain. See [Bulk close](Bulk-Thread-Close#confirm-and-interpret-the-summary).

<a id="previews"></a>

## A preview is missing or a button fails

**Possible causes:** mode policy, unsupported/cross-server links, missing Message Content Intent, source send permissions, archived/locked source, missing private-source membership, or target access/age checks.

**Check:** inspect [`link-preview show`](Commands-Config#config-link-preview-show), Intent and source read/send/embed permissions. Use a new ordinary human post with a supported same-server URL. A button alone is not proof of target existence.

**Action and retry:** after correcting source settings, test a new reply. Clicks need current user and bot access and confirmed non-age-restricted state; owner/admin status is no exception. Old labels do not change with locale or restart. Old buttons fail in `off` or `public-only`.

**If unresolved:** a generic failure intentionally does not reveal whether a protected message exists. Do not weaken permissions to expose it. Review [preview access rules](Link-Previews#access-privacy-and-copies).

<a id="audit-notifications-missing"></a>

## Audit notifications are missing

Missing Discord notices do not establish that the operation failed or that its database audit is absent. History is stored separately; notifications are a best-effort single delivery with no retry or historical replay.

1. Keep the original operation response and time. Check whether it was an actual [audited change or eligible failure](Audit-and-Privacy#what-is-recorded); a configuration no-op does not create a change notice.
2. With Manage Server, run [`/config audit-log show`](Commands-Config#config-audit-log-show). If disabled, no destination is configured. If an ID is shown, check that the actual text/announcement channel exists and WEFT currently has View Channel and Send Messages. Show reads only the stored ID.
3. If a committed audit should exist, have the operator inspect its [database record](Audit-and-Privacy#audit-storage-reference) and [notification-delivery logs](Operations#inspect-operation-logs), especially `audit_notification_delivery` and its `outcome`. A crash or delivery failure may lose a notice; certain failure audits themselves can also be lost. Do not repeat the business operation to generate a notice.

Correct an identified destination or permission problem, then observe a later actual audited operation. Old missed notices are not backfilled. Disabling notices leaves database auditing running; see [notification limits](Audit-and-Privacy#evidence-limits).

<a id="startup-migration-or-readiness-failure"></a>

## Startup, migration or readiness fails

**Possible causes:** invalid private configuration, unavailable PostgreSQL/Discord, incomplete migrations, or a startup step failing.

**Check:** inspect the startup-step log, DB reachability, Discord connectivity and private settings without printing credentials. Compare liveness and readiness using [Operations](Operations#observe-health-and-logs).

**Action and retry:** run only one migration runner per DB and require success before startup. Resolve the identified cause before restarting. Do not rewrite applied migration history or clear scheduler state. Keep the app stopped after an uncertain/failed restore or migration.

**If unresolved:** use [Operations](Operations) and [Backup and recovery](Backup-and-Recovery). Ready does not establish complete recovery or Discord consistency.

<a id="report-a-problem"></a>

## Provide evidence privately

For an unresolved reproducible issue, provide the source revision, non-sensitive command/inputs, exact result code, operation time, relevant IDs and safely redacted logs. Never include tokens, credentials, private message content or a full configuration dump.
