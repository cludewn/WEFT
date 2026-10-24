# Thread commands

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Commands-Thread-ja)

Use this page to check a thread command's inputs and results. To inspect automatic-close policy or an explicit close reservation, start with [`/thread status`](#thread-status). To close a discussion or reflect an already-active thread, read [Thread lifecycle](Thread-Lifecycle).

All 8 operations are server-only and require the invoking user's current Manage Threads (`ManageThreads`). The required target and WEFT permissions differ by operation; check **Access** below. Command visibility does not replace authorization. Results and errors are ephemeral (visible only to the initiator).

| Command details                                | Feature guide                                    |
| ---------------------------------------------- | ------------------------------------------------ |
| [`/thread close`](#thread-close)               | [Thread lifecycle](Thread-Lifecycle)             |
| [`/thread open`](#thread-open)                 | [Thread lifecycle](Thread-Lifecycle)             |
| [`/thread status`](#thread-status)             | [Automatic close](Automatic-Close)               |
| [`/thread track`](#thread-track)               | [Automatic close](Automatic-Close)               |
| [`/thread untrack`](#thread-untrack)           | [Automatic close](Automatic-Close)               |
| [`/thread close-after`](#thread-close-after)   | [Scheduled thread close](Scheduled-Thread-Close) |
| [`/thread cancel-close`](#thread-cancel-close) | [Scheduled thread close](Scheduled-Thread-Close) |
| [`/thread bulk-close`](#thread-bulk-close)     | [Bulk thread close](Bulk-Thread-Close)           |

**Syntax and operation:** Syntax blocks describe command names and options; they are not strings to paste and execute. Select the WEFT command in Discord and run it in the intended context. Do not type `<...>` or optional-argument `[...]` brackets.

- **Thread commands:** Except for bulk close, operate inside the intended thread. Commands with no slash options need no additional input before running.
- **Close delay:** For `/thread close-after`, type a duration such as `2h` into `after`; it is a text option, not a date picker.
- **Bulk-close form:** `/thread bulk-close` has no slash options. Running it opens a form with a required parent channel picker, optional owner picker and optional text filters. Submitting the form only prepares candidates; selecting targets and confirming them starts the close operation.

**Execution registration** below means preparing the scheduler to execute a saved close reservation; it does not mean the thread has closed. [Scheduled close](Scheduled-Thread-Close#create-replace-and-inspect) explains saved versus setup-unconfirmed results.

The examples below connect a purpose to the actual inputs and result checks. See [typing, selecting and submitting forms](Command-Reference#read-syntax) for common UI guidance. For `PENDING` or unconfirmed results, follow [result-state guidance](Troubleshooting#result-states) before repeating a change; status is not a complete lifecycle progress tracker.

## /thread close

**Purpose:** Add the applicable closed prefix when enabled and archive this thread without locking.

**Access:** Use inside a supported, unlocked public/announcement thread, accessible private thread, or forum post. Actor and WEFT need ViewChannel + ManageThreads.

**Syntax:**

```text
/thread close
```

**Arguments:**

No slash options.

**Example:**

To archive a resolved support discussion:

1. Check that you are inside the intended thread and that it is not locked, then run `/thread close` with no options.
2. Read the response: a confirmed close or already-closed result is different from `PENDING` or an unconfirmed result.
3. After confirmed completion, inspect the actual archive state and name in Discord. A prefix is added only when the applicable policy enables it; the operation does not lock the thread.

If processing continues, follow [thread-delay checks](Troubleshooting#thread-delays) before issuing another change.

**Results:**

- **Confirmed:** closed or already closed, based on lifecycle evidence.
- **Schedule effect:** a waiting (`ACTIVE`) explicit close is cancelled first.
- **Ongoing:** `PENDING` means WEFT still processes or confirms the operation.

**Constraints:**

- A locked thread is rejected. An EXECUTING schedule or unconfirmed cancellation stops the manual close. Committed cancellation is not reversed by a later failure.
- Repeated close/open-related operations on the same thread may require roughly 10 minutes of waiting. Allow for that when planning another operation, then check the previous result and current state; do not retry on elapsed time alone. See [same-thread delays](Thread-Lifecycle#delays-and-safe-observation) for the checks to make before another operation and the separate restrictions while `PENDING` work continues.
- A CLOSED database record alone does not confirm archiving. Repeated close retains a saved prefix, including an empty one.

**Related:** [Thread lifecycle](Thread-Lifecycle) · [Result states](Troubleshooting#result-states)

## /thread open

**Purpose:** Update WEFT’s record to reflect an already-active thread and remove one applicable saved leading closed prefix.

**Access:** Use inside an already-active supported thread. Actor and WEFT need ViewChannel + ManageThreads. No existing WEFT record is required.

**Syntax:**

```text
/thread open
```

**Arguments:**

No slash options.

**Example:**

After a discussion has been made active again through Discord, use this command if WEFT still needs to reflect that state:

1. Confirm that the intended thread is already active in Discord. `/thread open` cannot unarchive it.
2. Run `/thread open` inside that thread with no options.
3. Check the changed or unchanged response and the actual name. An applicable saved leading prefix may be removed; a prefix-free close or a thread whose active state WEFT already recorded may need no name change.

Do not use `/thread status` as proof that a pending open operation has finished; use [result and delay guidance](Troubleshooting#thread-delays).

**Results:**

- **Changed:** removes the applicable saved prefix and saves `OPEN`, or updates only WEFT state.
- **Unchanged:** supported active threads without management records are accepted as a no-op. WEFT may already have detected the Discord unarchive and updated its record and prefix.
- **Ongoing:** `PENDING` means WEFT is still processing or confirming.

**Constraints:**

- WEFT does not unarchive or unlock the thread. Make it active through Discord first. It does not restore a stale original name, strip arbitrary matching text, change automatic-close exclusions, or cancel an explicit close schedule.
- A manually changed name without the saved leading prefix stays intact. Inspect actual state before retrying unconfirmed results.
- Allow for the [possible same-thread wait of roughly 10 minutes](Thread-Lifecycle#delays-and-safe-observation) after recent close/open-related work. The time does not guarantee completion or permit another mutation while WEFT still owns `PENDING` work. This command still requires an already-active thread; waiting does not unarchive it.

**Related:** [Thread lifecycle](Thread-Lifecycle) · [Result states](Troubleshooting#result-states)

## /thread status

**Purpose:** Inspect this thread’s automatic-close participation and current explicit close schedule.

**Access:** Use inside a supported thread with a parent and current ManageThreads permission. Archived or locked threads are allowed. No bot thread-management permission is required for this maintenance operation.

**Syntax:**

```text
/thread status
```

**Arguments:**

No slash options.

**Example:**

When a thread has not closed automatically, run `/thread status` inside that thread. Check whether its parent is enabled, whether the thread is excluded, the inactivity period and recorded activity time, and whether an explicit close reservation takes precedence. Use the [automatic-close symptom checks](Troubleshooting#automatic-close-not-running) to decide which setting or condition needs attention. This command does not report the progress of every close or open operation.

**Results:**

- **Automatic close:** effective participation, parent enabled/disabled, individual exclusion, inactivity threshold and last recorded post or baseline.
- **Explicit reservation:** current close time, executing, or none.
- **Read-only:** no repair or Discord history scan.

**Constraints:** Not a comprehensive progress tracker: it does not list pending close/open mutations, their final audits, terminal close history, or message schedules. “None” does not prove a PENDING lifecycle operation finished. A read failure is not “none.”

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /thread track

**Purpose:** Remove this thread’s individual automatic-close exclusion.

**Access:** Use inside a supported thread with a parent and current ManageThreads permission. Archived or locked threads are allowed. No bot thread-management permission is required for this maintenance operation.

**Syntax:**

```text
/thread track
```

**Arguments:**

No slash options.

**Example:**

To return a previously excluded support thread to automatic-close consideration:

1. Run `/thread track` inside that thread with no options.
2. Check whether the response reports exclusion removal or an already-included thread, and read the separate parent-policy result.
3. Run [`/thread status`](#thread-status) in the same thread. Confirm that the individual exclusion is absent; effective automatic close also requires an enabled parent.

If the parent is disabled, use the [server policy setup](Automatic-Close#enable-a-parent-then-exempt-individual-threads) with Manage Server. Repeating track will not enable it.

**Results:**

- **Policy:** exclusion removed or already absent; the response separately states effective participation under the parent policy.
- **Measurement:** removing an exclusion under an enabled parent starts from this operation, preserving newer activity. Repeating keeps existing time and repairs only a missing baseline.

**Constraints:** Does not enable the parent or change scheduled close. Under a disabled parent it removes the exclusion without starting an inactivity baseline. After UNCONFIRMED use /thread status.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /thread untrack

**Purpose:** Exclude this thread from automatic inactivity closing.

**Access:** Use inside a supported thread with a parent and current ManageThreads permission. Archived or locked threads are allowed. No bot thread-management permission is required for this maintenance operation.

**Syntax:**

```text
/thread untrack
```

**Arguments:**

No slash options.

**Example:**

To keep a long-lived reference thread out of inactivity-based closing:

1. Run `/thread untrack` inside the intended thread with no options.
2. Check for excluded or already excluded, then run [`/thread status`](#thread-status) and confirm the individual exclusion and effective automatic-close state.

An explicit reservation is independent. If one exists and should also be removed, use [`/thread cancel-close`](#thread-cancel-close); untrack does not cancel it or stop an operation already running.

**Results:** Reports excluded or already excluded. Preserves the recorded activity timestamp. Works even when the parent is not enabled.

**Constraints:** Does not cancel an explicit close schedule, reopen a thread or stop an already-started operation. Check /thread status if the change is unconfirmed.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /thread close-after

**Purpose:** Schedule a future close for the current thread, replacing an existing ACTIVE close.

**Access:** Use inside an active, unlocked supported thread. Actor and WEFT need ViewChannel + ManageThreads.

**Syntax:**

```text
/thread close-after after:<duration>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                                              |
| ------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `after` | Required          | String: Enter one positive integer plus `m`, `h` or `d`, from 1 minute through 365 elapsed days. Examples include `30m`, `2h`, and `7d`. |

**Example:**

To reserve a close for a discussion two hours from this operation:

1. Inside the intended active, unlocked thread, run `/thread close-after` with `2h` in `after`.
2. Check for a created or replaced reservation, and retain the returned schedule ID and execution time. An existing waiting close is replaced; this is not a second independent reservation.
3. Run [`/thread status`](#thread-status) in the same thread and check the current close time. After execution, inspect the actual archive state in Discord.

A saved reservation is not a completed close. If execution registration is pending, keep the saved reservation and inspect it before retrying.

**Results:**

- **Saved:** created or replaced, with schedule ID and execution time. No immediate close occurs.
- **Saved; setup unconfirmed:** the reservation remains saved and WEFT repairs execution registration later.

**Constraints:**

- Only one current close per thread. EXECUTING cannot be replaced. Invalid duration, inactive/locked target, lost permissions and unconfirmed save are distinct from saved-but-pending.
- Verify /thread status before retrying; overdue applicable closes may execute after restart without the message grace periods.

**Related:** [Scheduled thread close](Scheduled-Thread-Close) · [Result states](Troubleshooting#result-states)

## /thread cancel-close

**Purpose:** Cancel this thread’s current ACTIVE explicit close schedule.

**Access:** Use inside a supported thread with ViewChannel + ManageThreads. Archived or locked threads are allowed; WEFT’s mutation permission is not required.

**Syntax:**

```text
/thread cancel-close
```

**Arguments:**

No slash options.

**Example:**

When a discussion needs to remain available past its explicit close deadline:

1. Run [`/thread status`](#thread-status) inside the thread to check the current reservation.
2. Run `/thread cancel-close` with no options. Read whether cancellation is confirmed, no current reservation exists, or execution has already begun and cannot be cancelled.
3. After confirmed cancellation, use `/thread status` to inspect the current reservation field.

Automatic-close policy still applies. If inactivity closing should also be prevented, consider [`/thread untrack`](#thread-untrack). A missing reservation alone does not establish that other pending lifecycle work finished.

**Results:**

- **Cancelled/no-op:** cancellation with ID, or no current reservation as successful no-op.
- **Cannot cancel:** `EXECUTING` has begun execution.
- **Scope:** no thread mutation or automatic-close policy change.

**Constraints:** A cancellation whose persistence is unconfirmed must be checked with /thread status before retrying. Queue remnants cannot authorize execution of a confirmed cancelled action. Cancelling this schedule does not exclude the thread from automatic close.

**Related:** [Scheduled thread close](Scheduled-Thread-Close) · [Result states](Troubleshooting#result-states)

## /thread bulk-close

**Purpose:** Prepare an interactive selection of threads and close only the confirmed subset.

**Access:** Requires Manage Threads (`ManageThreads`); invoke in this server, then select a text, announcement or forum parent. Actor and WEFT both need ViewChannel + ManageThreads on that parent and each selected target. Private threads are excluded.

**Syntax:**

```text
/thread bulk-close
```

**Arguments:**

No slash options.

**Example:**

To review support threads whose names contain `resolved` and which were created at least seven days ago:

1. Run `/thread bulk-close` in the server. In the form, select the actual support parent using **Parent**, enter `resolved` in **Thread name contains** and `7d` in **Minimum time since creation**. Leave **Owner** unset unless you also want to restrict the creator; that field uses a user picker.
2. Submit the filters and review the candidates. These filters start with all matching candidates selected. Deselect any thread you want to keep and review selections on every page.
3. Check the schedule-cancellation warning, then press **Close selected threads** only when the selected subset is correct.
4. Read the result counts and inspect the selected threads in Discord. `Skipped` means no attempt began; `Pending` means work may finish later. Use [bulk-result troubleshooting](Troubleshooting#bulk-close-skipped-targets) before repeating a batch.

The `7d` filter measures age since creation, not inactivity. Showing candidates or submitting filters does not close them.

**Results:**

- **Form:** immediately asks for Parent and optional Owner, Thread name contains and Minimum time since creation.
- **Selection:** review candidates and page selections, then confirm. Filtered matches initially all selected; without filters none are selected.
- **Execution:** returns Selected, Attempted, Closed, Already closed, Pending, Failed or unconfirmed, and Skipped counts. Cancel before execution changes no targets.

**Constraints:**

- There are at most 50 candidates, with 10 per page. The condition form must be submitted within 5 minutes of opening; the candidate-selection screen has a separate 5-minute lifetime from its creation. Interaction does not extend either deadline, and only the initiator can use them. Filters are AND; Thread name contains is at most 100 UTF-16 units and the age input at most 32 UTF-16 units. Creation age is 1m–365d, not inactivity.
- Setup-form requests and candidate-review records each have a separate process-wide capacity of 128. At capacity, new work is rejected without evicting existing sessions; cancelled candidate sessions retain their original expiry.
- Confirm needs at least one selection. Fresh checks may skip targets without starting them. Started work may finish later; active close schedules can be cancelled even if closing later fails. No all-or-nothing guarantee or later Pending completion message.
- See the feature guide before a large batch.

**Related:** [Bulk thread close](Bulk-Thread-Close) · [Result states](Troubleshooting#result-states)
