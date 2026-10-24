# Thread lifecycle

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Thread-Lifecycle-ja)

WEFT closes finished discussions by archiving the thread and, when enabled, adding a closed prefix such as `[CLOSED]` to its name. For example, a resolved support thread named `Login help` can become `[CLOSED] Login help` and be archived.

<a id="close-and-archive"></a>

## Understand close, archive and lock

| Action                    | Effect                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| WEFT close                | Archives without locking or deleting; adds the applicable closed prefix when enabled.                                                  |
| Unarchive through Discord | Makes the thread active again; an unlocked archived thread can become active through Discord use.                                      |
| `/thread open`            | Reflects an **already-active** thread in WEFT and removes its saved leading prefix where applicable; does **not** unarchive or unlock. |

Closing does not prevent users from making an unlocked thread active again. A locked thread is rejected by close. If you need to prevent further participation, WEFT’s close alone does not provide that restriction.

<a id="before-closing"></a>

## Before you start

Use a supported public/announcement thread, accessible private thread, or forum post. The actor and WEFT need current View Channel and Manage Threads permissions. Private threads require existing WEFT access; WEFT does not automatically join an inaccessible thread.

A valid manual close cancels any waiting explicit [scheduled close](Scheduled-Thread-Close) before trying to close. That cancellation remains effective even if closing later fails. Check for a reservation you intend to keep before running close.

<a id="close-one-thread"></a>

## Close a thread and check the result

1. Enter the target thread.
2. Run `/thread close` with no options.
3. Read WEFT’s response and check the actual thread’s archive state and name in Discord.

A confirmed “closed” or “already closed” response establishes a successful lifecycle result. Repeating close does not add duplicate prefixes. A disabled prefix leaves the name unchanged, so the title alone is not enough to check success.

If the response is `PENDING` (WEFT is still processing or confirming the operation), wait. If the result is unconfirmed, inspect current state before retrying. [Delays and conflicts](#delays-and-safe-observation) explains these cases.

<a id="reconcile-an-already-active-thread"></a>

## Use a thread again and reflect its state

1. Make the thread active using Discord. `/thread open` does **not** perform this step.
2. Check whether WEFT has already removed the saved prefix after detecting the unarchive.
3. If needed, run `/thread open` with no options inside the already-active target thread and read its result.

WEFT removes one applicable saved leading prefix and updates its record when needed. It may update only WEFT state or report no changes. A supported active thread without a management record is accepted as a no-op. This command does not cancel a scheduled close or change automatic-close exclusions.

<a id="saved-prefixes-and-manual-names"></a>

## How saved prefixes affect later operations

A nonempty prefix is added with one following space. WEFT saves the prefix chosen at closing, including the choice to use no prefix. That choice persists through configuration changes and pending confirmation until WEFT reflects the active thread state. **The saved record is not proof that Discord archiving succeeded.**

| Sequence                                                          | Result when reflecting the active state                    |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Close with `[CLOSED]`, disable prefix, then unarchive in Discord  | Removes the saved leading `[CLOSED] ` if still present.    |
| Close without a prefix, enable `[DONE]`, then unarchive           | Leaves the name intact.                                    |
| Manually rename so the saved prefix is no longer at the beginning | Keeps the current name rather than restoring an old title. |

After WEFT has reflected the active state, closing the thread again uses the server’s closed prefix setting at that time.

Manual name changes outside the saved leading prefix and separator are preserved. A nonempty prefix can require truncating the remaining title to fit 100 Unicode code points; open cannot recover discarded text. With no applied prefix, the title is preserved exactly, including leading spaces, without trimming or truncation. Configuration changes never rename existing threads.

<a id="delays-and-safe-observation"></a>

## Delays, conflicts and safe observation

**Allow for a wait of roughly 10 minutes when planning repeated close/open-related operations on the same thread.** A short sequence can leave that thread temporarily unable to accept the next operation, even while another thread remains usable. Avoid rapid close/open cycles during normal work or verification. If an operation cannot proceed, check its response and the actual thread state before deciding whether another command is needed.

Approximately **10 minutes** is a planning guide, not a guaranteed release time. Check the previous response, actual thread state and any unresolved processing before another operation. The same delay is not established for every command; [technical background](#same-thread-wait-background) explains the scope of this guidance.

- Discord rate-limit waiting is one possible source of delay, but the elapsed time alone does not identify the cause.
- WEFT’s Discord client waits for Discord rate limits. A prefix-disabled close still includes the name in the archive request; disabling the prefix does not guarantee a bypass.
- Separately, `PENDING` can cover the Discord change, saving state or confirming audits. WEFT continues that work and blocks conflicting changes to the same thread; the request may finish later. Waiting ten minutes does not establish completion or permission to start a conflicting change. An unconfirmed outcome likewise requires investigation, not another command on a timer.
- A scheduled close marked `ACTIVE` is waiting to execute; `EXECUTING` has begun execution. An executing schedule or unconfirmed cancellation prevents manual close from starting. Confirmed cancellation is not restored by later failed or pending close work.

Do not alternate close and open to force progress. [`/thread status`](Commands-Thread#thread-status) shows automatic-close policy and the current explicit close schedule, **not every in-progress lifecycle operation**. Compare the response with Discord’s actual title/archive state and follow [Troubleshooting](Troubleshooting#thread-delays). A missing audit notice is not proof of failure.

<a id="related-commands"></a>

## Continue with thread management

For exact inputs and permissions, see [`close`](Commands-Thread#thread-close), [`open`](Commands-Thread#thread-open), and [`status`](Commands-Thread#thread-status). To automate or review multiple closes, use [Automatic close](Automatic-Close), [Scheduled close](Scheduled-Thread-Close), or [Bulk close](Bulk-Thread-Close).

<a id="same-thread-wait-background"></a>

## Technical background: the same-thread wait

In actual use on Discord, repeated close/open-related operations on one thread have required roughly ten minutes of waiting, while another thread remained usable and the original thread accepted an operation after waiting. This experience is the basis for the planning guide, but it does not establish the cause or when a restriction will end. WEFT has no fixed ten-minute internal cooldown, and the same limit has not been established for every command. This wait is separate from WEFT blocking conflicting changes while processing or result confirmation remains unfinished (`PENDING`). Use the [operational checks above](#delays-and-safe-observation) to decide what to do.
