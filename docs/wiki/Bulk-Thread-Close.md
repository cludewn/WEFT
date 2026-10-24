# Bulk thread close

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Bulk-Thread-Close-ja)

Bulk close lets you inspect several threads, select the ones to close, and confirm the selection. For example, review old resolved support discussions before archiving them. Each selected thread closes independently: some may close even when others fail.

The workflow is **setup form → candidate review → selection → confirmation → result counts**. Opening a form or preview does not close anything.

<a id="before-starting"></a>

## Check the scope and permissions

Run in the server with Manage Threads. Select a text, announcement or forum parent; both you and WEFT need current View Channel and Manage Threads on the parent and selected targets.

Candidates are active, unlocked public/announcement/forum-post threads under that parent, including threads WEFT has never managed. Private and archived threads are excluded.

<a id="build-a-preview"></a>

## 1. Set conditions in the form

Run `/thread bulk-close` in the server with no options to open a Modal (an input form). Choose a parent channel and, if useful, filters:

| Form field                  | Required/optional | Input and matching rule                                                                                                                       |
| --------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Parent                      | Required          | Choose one text, announcement or forum channel from the Channel selector.                                                                     |
| Owner                       | Optional          | Choose one Discord user from the User selector. The filter matches the thread’s current creator ID.                                           |
| Thread name contains        | Optional          | Enter at most 100 UTF-16 units. Matching is literal and case-sensitive. For a nonblank filter, leading/trailing spaces are part of the match. |
| Minimum time since creation | Optional          | Enter one duration, 1m–365d, using at most 32 UTF-16 units. This filters by creation age, not inactivity.                                     |

For example, choose the support forum, Thread name contains `resolved`, and Minimum time since creation `30d`. This finds active matching threads created at least 30 days before candidate construction; it does not measure their last activity.

Filters combine with AND. Blank or whitespace-only text leaves a filter unset. A nonblank name filter keeps its edge spaces. The age filter requires a usable Discord creation timestamp; last-post time is not substituted.

Submit the form to build the read-only candidate preview. Zero matches produces no selection view. **More than 50 candidates rejects the entire preview without truncation**; add or narrow filters.

<a id="review-the-selected-subset"></a>

## 2. Review pages and choose threads

| What is limited                                                 | Maximum / lifetime | Details                                                                            |
| --------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------- |
| <!-- fact:bulk-candidates --> Threads in one candidate preview  | 50 threads         | A preview cannot be created with more than 50 candidates. Add or narrow filters.   |
| <!-- fact:bulk-page --> Candidates shown on one page            | 10 threads         | Candidates appear across at most 5 pages.                                          |
| <!-- fact:bulk-session-minutes --> Candidate-selection lifetime | 5 minutes          | Measured from preview creation. Navigation and selection changes do not extend it. |

1. Check the parent, conditions and candidate count.
2. Review the initial selection: with at least one optional Owner, Thread name contains or Minimum time since creation filter, all matches start selected; without those filters, none do.
3. Change the current page’s selection. Clear page deselects only that page.
4. Use Previous/Next to review other pages. Their selections are retained when you leave a page.
5. Check the total selected count before confirming. At least one selection is required, even for a single candidate.

Only the initiator can use the form and controls. The setup form expires 5 minutes after opening; the preview has its own 5-minute lifetime from creation. Navigation never extends expiry. Candidate IDs and the creation cutoff stay fixed; newly matching threads are not added. Cancel before execution starts no target operations.

<a id="confirm-selection"></a>

## 3. Confirm the exact selection

**Before confirming:** close archives without locking. A waiting explicit close schedule can be cancelled, and that cancellation is not restored if closing later fails or remains pending. There is no all-or-nothing rollback.

Confirmation freezes the selected subset. WEFT rechecks state, permissions and filters before each attempt, so some selected targets may not start. Deselected candidates receive no close, scheduled cancellation or close audit from this batch.

<a id="confirm-and-interpret-the-summary"></a>

## 4. Interpret the result counts

| Summary                 | What it establishes                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Selected                | This is the number selected at confirmation, not the total candidate count.                                                              |
| Attempted               | This is the number of target operations actually started by this invocation.                                                             |
| Closed / Already closed | These are confirmed closed/already-closed results, not merely a database CLOSED record.                                                  |
| Pending                 | WEFT is still processing work it started; it can finish later.                                                                           |
| Failed or unconfirmed   | Full completion is not established; Discord may have changed.                                                                            |
| Skipped                 | No attempt began, for example because eligibility changed, another operation on that thread was unfinished, or a schedule was executing. |

`Attempted = Closed + Already closed + Pending + Failed or unconfirmed`.
`Selected = Attempted + Skipped`.

Skipped does not mean closed. A database `CLOSED` record alone is not confirmation either. Counts omit target names to avoid disclosing identities after access changes.

Check the actual selected threads in Discord. For Pending, wait and observe; WEFT sends no later completion message. For failed or unconfirmed targets, inspect the response and current state before choosing another batch. **Do not immediately repeat the entire batch.**

<a id="limits-and-restart"></a>

## Execution limits, delays and restart

When a batch includes recently operated threads, review the [same-thread wait guidance](Thread-Lifecycle#delays-and-safe-observation) before confirming or planning another batch. Repeated close/open-related operations on the same thread can require roughly 10 minutes of waiting. Avoid rapid repeated operations on those threads; the time is a guide, not a guaranteed release time. Inspect started work before retrying: `Pending` can continue beyond that time, and elapsed time does not turn it into `Skipped` or failure.

- At most 3 unresolved target-thread operations run across all bulk sessions. The number 3 counts target operations, not sessions; it is not a fixed cooldown between commands.
- Separately, WEFT can retain up to 128 setup-form requests and 128 candidate-review records across the running app. At capacity it rejects new work without evicting an existing session. Confirmed or cancelled candidate sessions retain their original expiry, so cancelling does not immediately free that capacity.
- New attempts stop after the inclusive 5-minute admission window from confirmation. Already-started work continues.
- Each target’s initial result is observed for at most 15 seconds. The aggregate summary can arrive while logical work is still pending.
- Restart invalidates forms and selection controls and does not resume unstarted targets. Completed effects remain.
- Invalid controls can also mean stale state, lost authorization or unavailable reads; do not assume expiry alone.

Start a fresh preview only after checking already-started targets and [result states](Troubleshooting#result-states). Exact access and command details: [`/thread bulk-close`](Commands-Thread#thread-bulk-close).
