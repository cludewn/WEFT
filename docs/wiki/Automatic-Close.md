# Automatic close

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Automatic-Close-ja)

Automatic close archives threads after a configured period without qualifying posts. Use it, for example, to clear inactive support discussions without choosing a separate deadline for each thread. It uses the same [close without locking](Thread-Lifecycle) as a manual close.

A **parent channel** is the text, announcement or forum channel containing the threads. Enable a parent to apply the policy to its threads, then exclude individual threads where needed. Prior manual WEFT management is unnecessary. Initially no parents are enabled, so automatic close does not run on any thread.

<a id="enable-a-parent-then-exempt-individual-threads"></a>

<a id="set-up-and-verify-a-policy"></a>

## Set up automatic close

You need Manage Server to change server policy. To inspect or exclude an individual thread, you need Manage Threads. WEFT needs current access and thread-management permissions when it actually closes a thread. Start with a parent created for verification.

<a id="set-inactivity-period"></a>

### 1. Set the inactivity period

To close threads after seven days without qualifying posts, select [`/config auto-close inactivity`](Commands-Config#config-auto-close-inactivity), enter `7d` in `value`, and run it. Check that the response confirms the saved period or says it was unchanged.

Accepted input is one positive integer followed by `m`, `h` or `d`, from 5 minutes through 365 days. The default is 7 days. This period applies across enabled parents in the server.

**When changing an existing policy:** shortening the period applies the new threshold to recorded activity. It does not restart every timer, so existing threads may become eligible sooner.

<a id="choose-bot-activity"></a>

### 2. Choose whether bot posts count

If bot posts should keep threads active, select [`/config auto-close bot-messages`](Commands-Config#config-auto-close-bot-messages) and choose the Boolean value `true` for `value`. Choose `false` to ignore them; this is the default. Run the command and check the response for whether bot posts are included or excluded.

Discord system messages never count, even when this option is `true`. See [what counts as activity](#what-counts-as-activity) for other events.

<a id="enable-parent"></a>

### 3. Enable the parent channel

Select [`/config auto-close add-parent`](Commands-Config#config-auto-close-add-parent). In `channel`, choose the intended text, announcement or forum channel from Discord’s picker, then run it. For example, choose the support forum after verifying that it is the intended destination.

Check that the response confirms enablement, or says the parent was already enabled. A newly enabled parent’s response reports how many threads had their inactivity measurement established or advanced. This is a baseline count, not a count of threads already closed.

WEFT first reads active threads; if that read fails, the parent is not enabled. Newly enabled eligible threads start measurement at enablement or a newer recorded activity time. Earlier inactivity is not counted toward an immediate close.

<a id="verify-setup"></a>

### 4. Verify the policy and an individual thread

1. Run [`/config auto-close show`](Commands-Config#config-auto-close-show) with no options. Check the inactivity period, bot-post setting and enabled parents. It displays at most 25 parents and a remaining count; if the parent is not shown, use the next step to check its policy.
2. Inside a thread under the enabled parent, run [`/thread status`](Commands-Thread#thread-status) with no options. Check effective automatic-close participation, parent policy, individual exclusion, inactivity period and recorded activity or measurement start. Also check whether an explicit scheduled close exists.
3. If the thread should remain open regardless of inactivity, [exclude it](#exclusions-and-stopping).

When a close occurs, inspect the thread’s actual archive state in Discord. Automatic close archives without locking. The inactivity period is an eligibility threshold; the periodic checks and Discord waits mean that it is not an exact deadline. See [when closing happens](#when-closing-can-happen).

If the policy or thread status differs from your intention, use [automatic-close troubleshooting](Troubleshooting#automatic-close-not-running) before changing several settings at once. A saved policy alone does not confirm a later close.

<a id="exclusions-and-stopping"></a>

## Exclude a thread or stop a policy

<a id="exclude-one-thread"></a>

### Keep one thread out of automatic close

Inside the individual thread, run [`/thread untrack`](Commands-Thread#thread-untrack) with no options. This requires Manage Threads and adds an exclusion. Run `/thread status` in the same thread to confirm the exclusion and effective automatic-close state.

To include it again, run [`/thread track`](Commands-Thread#thread-track) with no options, then check `/thread status` again. Track removes the exclusion; it does not enable a disabled parent. Under an enabled parent, removing an exclusion starts measurement from that operation or newer recorded activity. Repeating track on an already included thread does not reset its timer. Neither command changes an explicit scheduled close.

<a id="disable-parent"></a>

### Stop automatic close under a whole parent

Select [`/config auto-close remove-parent`](Commands-Config#config-auto-close-remove-parent), choose the intended parent in the `channel` picker, and run it. Check that the response confirms disablement or says the parent was already unconfigured. Run `/config auto-close show` to review the remaining policy. Its parent display is limited to 25, so absence alone does not confirm disablement; inside a thread under that parent, use `/thread status` to check the parent policy.

Removing a parent or adding an exclusion does not forcibly stop work already begun, reopen threads, or cancel explicit schedules. Use [scheduled-close cancellation](Scheduled-Thread-Close#cancel-or-close-now) for explicit reservations.

## What counts as activity

| Event                                                   | Counts?                            |
| ------------------------------------------------------- | ---------------------------------- |
| Human post in an eligible supported thread              | Yes                                |
| Bot post, including WEFT                                | Only when `bot-messages` is `true` |
| Discord system message                                  | Never                              |
| Reaction, rename, thread-setting or WEFT-setting change | No                                 |

WEFT records activity metadata rather than message bodies. Late events never move the recorded time backward. It does not rescan Discord history or backfill every message missed during downtime.

<a id="measurement-baselines"></a>

## Understand the recorded measurement time

A **baseline** starts inactivity measurement even when it is not a post. Parent enablement, exclusion removal, an observed return to active state, or missing-record initialization can establish one.

| Target, conditions and command                                                                                    | Effect on measurement time and exclusions                                                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Run `/thread track` in an individually excluded thread under a parent with automatic close enabled                | Measurement starts from that operation; newer activity is preserved.                     |
| Repeat `/thread track` in a thread that is not individually excluded, under a parent with automatic close enabled | Measurement continues from the recorded time; only a missing baseline is filled in.      |
| Run `/thread track` in a thread under a parent with automatic close disabled                                      | Any individual exclusion is removed, but measurement does not start.                     |
| Run `/thread untrack` in the individual thread                                                                    | An individual exclusion is set; recorded activity is preserved.                          |
| Disable automatic close for a parent with `/config auto-close remove-parent`                                      | Recorded activity and exclusions are preserved.                                          |
| Re-enable automatic close for a parent with `/config auto-close add-parent`                                       | Measurement for eligible threads starts from re-enablement; newer activity is preserved. |

Startup checks active threads and attempts to repair missing baselines. A newly visible thread need not inherit an old creation time. Inspect `/thread status` when determining when a thread might close.

If status shows no recorded time, first confirm that the parent is enabled and the thread should not be excluded. With Manage Threads, run [`/thread track`](Commands-Thread#thread-track) to repair a missing baseline, then check status again. This starts measurement when a baseline was absent; it does not reconstruct older posts or force an immediate close. Repeating track leaves an existing timer intact.

<a id="when-closing-can-happen"></a>

## When closing happens and what can prevent it

A thread is eligible when its recorded post or baseline plus the **current** inactivity period is at or before the check time. This is inactivity, not age since creation.

The first sweep begins after 5 minutes; each later sweep begins 5 minutes after the previous one finishes. Long checks and Discord waits can delay it further. The threshold is not an exact close deadline.

Before closing, WEFT checks current policy, matching activity, actual parent/thread state and its permissions. A waiting (`ACTIVE`) or executing (`EXECUTING`) explicit close schedule takes precedence and is not cancelled. Already archived or no-longer-applicable targets may be skipped. Failed attempts can be considered again on a later sweep; failures do not establish that the thread was closed.

The policy check and Discord change happen separately. A policy or activity change after the check can overlap with a close already starting; do not treat disabling a policy as proof that an in-progress close stopped. Saved-prefix and pending-result behavior follows [Thread lifecycle](Thread-Lifecycle).

<a id="verify-a-policy-change"></a>

## Check unexpected results

Use [`auto-close show`](Commands-Config#config-auto-close-show) for server policy and [`thread status`](Commands-Thread#thread-status) for individual participation. Neither lists every pending lifecycle operation. If saving a policy is unconfirmed, inspect the affected setting before retrying. If threads do not close, follow [the symptom checks](Troubleshooting#automatic-close-not-running). For ongoing closes, use [pending-operation checks](Troubleshooting#thread-delays).
