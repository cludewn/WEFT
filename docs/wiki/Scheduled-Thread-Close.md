# Scheduled thread close

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Scheduled-Thread-Close-ja)

Use a scheduled close when a discussion should end after a chosen delay, even if people continue posting. For example, reserve a close two hours from now for a time-limited question thread. For closing after a period without posts, use [Automatic close](Automatic-Close) instead.

A reservation schedules one future close. The result is the same [archive without locking](Thread-Lifecycle) as manual close: it does not delete the thread or prevent later Discord unarchiving. Saving a reservation does not close the thread immediately or guarantee that it can be closed later.

<a id="create-replace-and-inspect"></a>

## Create a close schedule and check it

Use an active, unlocked supported thread: a public/announcement thread, an accessible private thread, or a forum post. The actor and WEFT need current View Channel and Manage Threads permissions.

1. In the target thread, select [`/thread close-after`](Commands-Thread#thread-close-after), enter `2h` in `after`, and run it to reserve a close two hours later. `after` is required text input: one positive integer and `m`, `h` or `d`, from 1 minute through 365 elapsed days. The message-scheduling `at` option is not supported.
2. Read the response and retain the returned schedule ID and execution time. The ID identifies the reservation for investigation; the commands below select the current reservation by thread, without an ID option.
3. In the same thread, run [`/thread status`](Commands-Thread#thread-status) with no options. Check the explicit scheduled-close field for the intended time. Its automatic-close fields describe a separate policy, not this reservation.

**Execution registration** is the scheduler setup that lets WEFT pick up a saved close reservation when due. It is separate from saving the reservation and from actually archiving the thread. A setup warning is a reason to keep and inspect the saved reservation, not create another one. For an overdue reservation, use [the result checks below](#execution-results).

| Creation result                    | Meaning and next action                                                                                                                              |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created/replaced                   | The schedule and time are confirmed saved; the thread has not been closed yet. Check the returned time and status.                                   |
| Saved; execution setup unconfirmed | Saving is confirmed; WEFT can repair execution registration. Keep the reservation and inspect status. Do not replace it just to repair this message. |
| Save unconfirmed                   | Neither saved nor unsaved is established. Inspect status and operator records before retrying.                                                       |

**There is one current close per thread.** To change a waiting reservation, first check its current time with `/thread status`. Then run `/thread close-after` again with the new delay in `after`, and check the new response and time. This replaces the waiting reservation; it does not add a second close. An executing (`EXECUTING`) close cannot be replaced.

<a id="cancel-or-close-now"></a>

## Cancel the reservation or close now

To stop a waiting close, run [`/thread cancel-close`](Commands-Thread#thread-cancel-close) inside the target thread with no options. Read the result, then run `/thread status` in that thread with no options to inspect the current reservation.

Cancellation works in supported archived or locked threads too. It needs the actor’s View Channel and Manage Threads permissions, but no WEFT mutation permission.

| Cancellation result           | Meaning and next action                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Cancelled                     | Keep the confirmation. The cancelled reservation no longer authorizes a close.                                  |
| No current reservation        | This is a successful no-op. It does not establish the historical outcome of an earlier close.                   |
| Execution already in progress | The executing close cannot be cancelled. Inspect the actual thread and [execution results](#execution-results). |
| Cancellation unconfirmed      | Check status and operator evidence before another change; do not assume the reservation was cancelled.          |

To close now instead, run [`/thread close`](Commands-Thread#thread-close) with no options and follow the [manual-close result checks](Thread-Lifecycle#close-one-thread). A valid manual close, including a selected bulk close, cancels a waiting reservation before attempting lifecycle changes. **A committed cancellation stays cancelled if the later close fails or remains pending.** An executing reservation or unconfirmed cancellation prevents the new close from starting.

Cancelling the reservation does not exclude the thread from automatic close. Removing an individual exclusion with [`/thread track`](Commands-Thread#thread-track), setting one with [`/thread untrack`](Commands-Thread#thread-untrack), or changing automatic-close settings for the parent channel does not cancel this reservation.

<a id="execution-results"></a>

## Check what happened when due

At execution, WEFT reads current Discord state and its permissions again. The thread may be closed, already archived, or unable to close because of deletion, lock, access changes or a failure. Saving does not guarantee future permissions. To verify the result or investigate a thread that remains open:

1. Compare the returned execution time with the current time, then inspect the actual archive state and name in Discord. A name alone does not prove archiving, especially when prefixing is disabled.
2. Inside the thread, run `/thread status` with no options and check the explicit scheduled-close field.
3. Use the current state below to choose the next check.

| Current observation                 | Next check or action                                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Waiting (`ACTIVE`)                  | If still in the future, wait. If overdue, check current thread state and permissions; delivery repair or Discord waits can delay an applicable close. See [downtime and retries](#execution-and-downtime).                 |
| Execution in progress (`EXECUTING`) | Do not try to replace or cancel it. Observe the thread and follow [thread-delay checks](Troubleshooting#thread-delays) if it remains unresolved.                                                                           |
| No current close                    | Status does not show terminal history. “None” alone does not establish whether this attempt completed, failed or was cancelled. Compare Discord state and operator evidence.                                               |
| No confirmed close result           | Check for deletion, lock, loss of WEFT access or Manage Threads permission, and pending lifecycle work. Correct only an identified cause; inspect an uncertain result before creating another reservation or manual close. |

`/thread status` is not a tracker of every pending close/open operation. If current state does not resolve the question, retain the reservation ID, original response, execution time and current thread state for the host operator to compare with [application execution and result-check logs](Operations#inspect-operation-logs) and [database audit history](Audit-and-Privacy#audit-storage-reference). The logs distinguish this reservation’s execution result from periodic repair of saved reservations; a successful repair sweep alone does not prove the close completed. A missing Discord notice alone is not evidence of failure. Use [result states](Troubleshooting#result-states) for pending or unconfirmed work.

<a id="execution-and-downtime"></a>

## Downtime, delays and retries

Eligible failed attempts may be retried, so a reservation does not guarantee only one attempt. Each checked attempt uses current state; it is not an instruction to repeat a stale Discord change blindly.

- Applicable overdue closes can execute after restart. **The 60-minute and 15-minute message grace periods do not apply to thread closes.**
- Startup may release an interrupted close for another checked attempt. A delivered execution request still reloads current state before another Discord change.
- Rate-limit waits and periodic repair can delay execution. It is not an exact-second guarantee.
- Temporary failures to pass an execution request to the close processor have retry limits. A later repair may create another cycle while the schedule remains `ACTIVE`; exhausting one cycle does not by itself mean `FAILED`.
- Confirmed execution, retry and failure are audited. A missing Discord notice alone is not evidence of failure.

Before manually retrying on a recently operated thread, account for the [possible same-thread wait of roughly 10 minutes](Thread-Lifecycle#delays-and-safe-observation). Avoid repeatedly operating on that thread while waiting. Inspect the reservation, actual thread and any pending work first; creating another reservation can replace a waiting close and does not force the previous operation to finish.

Exact contracts: [`close-after`](Commands-Thread#thread-close-after), [`cancel-close`](Commands-Thread#thread-cancel-close), [`status`](Commands-Thread#thread-status). For conflicts and name-change delays, see [Thread lifecycle](Thread-Lifecycle#delays-and-safe-observation).
