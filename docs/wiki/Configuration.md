# Configuration

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Configuration-ja)

Server settings control WEFT’s timezone, thread policies, audit notices and message-link previews. Configure each Discord server separately with Manage Server (`ManageGuild`). Installing WEFT does not enable automatic closing.

<a id="defaults-and-first-choices"></a>

## Inspect defaults before changing settings

Run [`/config show`](Commands-Config#config-show) with no options to see the current timezone, closed prefix, automatic-close summary, audit destination and preview mode. Compare the values with the decisions below; change only the settings you need.

For details, run [`/config auto-close show`](Commands-Config#config-auto-close-show) to inspect the policy and parents, or [`/config audit-log show`](Commands-Config#config-audit-log-show) to inspect the saved notification destination. Both take no options.

| Setting                        | Default    | Decision                                                            |
| ------------------------------ | ---------- | ------------------------------------------------------------------- |
| WEFT default timezone          | UTC        | Which local time should new date inputs use?                        |
| Closed prefix                  | `[CLOSED]` | Should future closes add a visible name prefix?                     |
| Automatic-close parents        | None       | Which parent channels should have inactivity closing?               |
| Inactivity period              | 7 days     | How long should an eligible thread remain without counted activity? |
| Bot posts as activity          | Excluded   | Should automated posts keep threads active?                         |
| Audit notification destination | Disabled   | Who should see optional operation notices?                          |
| Link previews                  | `hybrid`   | May WEFT automatically copy publicly readable linked messages?      |

<a id="timezone-and-language"></a>

## Set time input and understand language

Before entering local dates for scheduled posts, choose an IANA timezone, a named region such as `Asia/Tokyo`. It accounts for the region’s time rules; numeric offsets such as `+09:00` are not accepted.

1. Select [`/config timezone`](Commands-Config#config-timezone), enter `Asia/Tokyo` in `value`, then run it.
2. Read the saved/unchanged response, then run `/config show` with no options and check **WEFT default timezone**.

Changing this default does not move saved one-time instants or recurring series. See [Timezones and scheduling](Timezones-and-Scheduling) before using absolute dates or recurring local times.

Timezone is not a language preference. Each interaction uses that person’s Discord interaction language: `ja` selects Japanese, otherwise English. Background output uses the available server language with English fallback.

<a id="closed-prefix"></a>

## Choose a closed prefix

A **closed prefix** is text added at the start of a thread name when WEFT closes it. Choose the behavior for future closes:

- To use `[DONE]`, select [`/config closed-prefix set`](Commands-Config#config-closed-prefix-set), enter `[DONE]` in `value`, then run it.
- To close without adding a prefix, run [`/config closed-prefix disable`](Commands-Config#config-closed-prefix-disable) with no options.

Read the response, then run `/config show` and check **Closed prefix**. A disabled prefix is displayed as Disabled.

`set` accepts 1–20 Unicode code points after trimming outer whitespace and rejects control characters. Empty or whitespace-only input is invalid; use `disable` explicitly.

Existing thread names do not change. WEFT retains the prefix chosen at closing, including no prefix, until it reflects that thread’s active state. A repeated close can therefore still use the saved prefix. [Thread lifecycle](Thread-Lifecycle#saved-prefixes-and-manual-names) explains removal, manual names and truncation.

<a id="automatic-close-and-exclusions"></a>

## Enable automatic close only where needed

Follow [Automatic close](Automatic-Close) to choose a period, enable a text/announcement/forum parent and verify individual threads. Enabling first reads active threads and establishes measurement baselines; failed enumeration leaves the parent disabled.

Run `/config auto-close show` to check the server’s automatic-close settings. To check an individual thread, enter that thread and run [`/thread status`](Commands-Thread#thread-status). [`/thread untrack`](Commands-Thread#thread-untrack) excludes an individual thread. Removing a parent preserves activity and exclusions and does not cancel explicit scheduled closes. Before shortening an existing period, check the activity to which the new threshold will apply.

<a id="notifications-and-preview-policy"></a>

## Choose audit notices and preview privacy

These are optional, independent features. Check the linked guides before enabling them.

| Feature                                                                 | Example                                                                  | Verify with                 | Effect to know before changing                                                                                            |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Audit notifications](Audit-and-Privacy#optional-discord-notifications) | `/config audit-log set`: select the destination in `channel`.            | `/config audit-log show`    | Choose appropriately restricted viewers; notices may reveal metadata. Disabling notices leaves database auditing running. |
| [Message-link previews](Link-Previews)                                  | `/config link-preview mode`: select **Preview buttons only** in `value`. | `/config link-preview show` | Automatic previews copy content. Mode changes do not remove previous copies.                                              |

Audit destination show reads the stored ID even if that channel has disappeared; check current Discord permissions separately. For privacy-sensitive servers, review whether automatic copies are appropriate before leaving the default `hybrid` mode enabled.

<a id="confirm-changes"></a>

## Confirm each change

Each settings command saves its own change. If a later settings command fails, earlier confirmed changes are not automatically undone. Read each response before continuing:

- **Changed:** the change is confirmed saved.
- **Unchanged/already disabled:** no new change was needed; this is a valid result.
- **`UNCONFIRMED`:** saving is not confirmed successful or failed. Inspect the affected setting with its `show` command; if still unclear, ask the host operator to follow [available checks](Troubleshooting#available-checks) before retrying.

A lost response does not undo a committed change. Checking the current setting helps you decide what to do next, but cannot by itself prove that a particular request with an uncertain result saved its change. See [result states](Troubleshooting#result-states).

Exact syntax and permissions for all 14 configuration operations: [Configuration commands](Commands-Config).
