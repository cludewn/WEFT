# Configuration commands

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Commands-Config-ja)

Use this page to check a configuration command's options and results. To review current settings, start with [`/config show`](#config-show). To set up a feature for the first time, follow the feature guide linked in the table.

All 14 operations require Manage Server (`ManageGuild`) in this server and can only be used there. Command visibility does not replace authorization. Results and errors are ephemeral (visible only to the initiator). For initial setup choices, read [Configuration](Configuration).

| Command details                                                        | Feature guide                                        |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| [`/config show`](#config-show)                                         | [Configuration](Configuration)                       |
| [`/config timezone`](#config-timezone)                                 | [Timezones and scheduling](Timezones-and-Scheduling) |
| [`/config closed-prefix set`](#config-closed-prefix-set)               | [Thread lifecycle](Thread-Lifecycle)                 |
| [`/config closed-prefix disable`](#config-closed-prefix-disable)       | [Thread lifecycle](Thread-Lifecycle)                 |
| [`/config link-preview show`](#config-link-preview-show)               | [Link previews](Link-Previews)                       |
| [`/config link-preview mode`](#config-link-preview-mode)               | [Link previews](Link-Previews)                       |
| [`/config audit-log show`](#config-audit-log-show)                     | [Audit and privacy](Audit-and-Privacy)               |
| [`/config audit-log set`](#config-audit-log-set)                       | [Audit and privacy](Audit-and-Privacy)               |
| [`/config audit-log disable`](#config-audit-log-disable)               | [Audit and privacy](Audit-and-Privacy)               |
| [`/config auto-close show`](#config-auto-close-show)                   | [Automatic close](Automatic-Close)                   |
| [`/config auto-close inactivity`](#config-auto-close-inactivity)       | [Automatic close](Automatic-Close)                   |
| [`/config auto-close bot-messages`](#config-auto-close-bot-messages)   | [Automatic close](Automatic-Close)                   |
| [`/config auto-close add-parent`](#config-auto-close-add-parent)       | [Automatic close](Automatic-Close)                   |
| [`/config auto-close remove-parent`](#config-auto-close-remove-parent) | [Automatic close](Automatic-Close)                   |

**Syntax and operation:** The syntax blocks describe command names and options; they are not strings to paste and execute. Select the WEFT command in Discord, set its required options, then run it. Commands with no arguments need no further input. Do not type `<...>` or optional-argument `[...]` brackets.

- **Text:** Type values such as `Asia/Tokyo`, `[DONE]` or `7d` into the named option.
- **String choice:** For link-preview mode, select a displayed choice from the picker. The stable values in the table below identify the choices; they are not free-text inputs.
- **Channel:** Select the actual server channel from Discord's picker. An example channel name is not a literal value to type.
- **Boolean:** For bot-message activity, explicitly select `true` or `false`; this option cannot be omitted.

Choice labels depend on Discord's language. See [typing, selecting and submitting forms](Command-Reference#read-syntax) for general command input. The examples below show a purpose, the values to use and what to check afterward. If a change is unconfirmed, inspect the corresponding `show` result before trying again; see [result states](Troubleshooting#result-states). A `show` result checks the current setting, not whether a particular uncertain request committed. If the response and current setting do not resolve the result, follow [available checks](Troubleshooting#available-checks) with the host operator before another change.

## /config show

**Purpose:** Show this server’s saved WEFT settings, including the default timezone, closed prefix, audit destination, automatic-close summary and preview mode.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config show
```

**Arguments:** None.

**Example:**

Before changing WEFT settings, run `/config show` to review this server's current configuration. Check the timezone used for new one-time absolute schedules, the closed prefix, the audit-notification destination, the automatic-close summary and the link-preview mode. For the enabled parent channels and bot-message policy, continue with [`/config auto-close show`](#config-auto-close-show).

**Results:** Returns the settings ephemerally. A disabled prefix is explicitly displayed as Disabled. Missing general settings may be initialized with defaults.

**Constraints:** This is a settings overview, not a check that Discord resources still exist or that pending actions finished. A read failure is not an empty configuration.

**Related:** [Configuration](Configuration) · [Result states](Troubleshooting#result-states)

## /config timezone

**Purpose:** Set WEFT’s default scheduling timezone for this server.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config timezone value:<value>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                          |
| ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------- |
| `value` | Required          | String: Enter a named IANA zone or UTC, including valid aliases, such as `Asia/Tokyo`. Numeric offsets are rejected. |

**Example:**

To enter future one-time absolute schedules in Japan time:

1. Run `/config timezone` with the text `Asia/Tokyo` in `value`.
2. Check that the response reports the timezone as saved or unchanged.
3. Run [`/config show`](#config-show) and confirm that the default timezone is `Asia/Tokyo` before entering a new absolute schedule.

**Results:** Reports saved or unchanged. Later one-time absolute inputs use this setting; existing saved instants and recurring timezones stay as saved.

**Constraints:** Invalid zones are rejected. An UNCONFIRMED change requires checking /config show before another change. This does not change Discord’s timestamp display or interaction language.

**Related:** [Timezones and scheduling](Timezones-and-Scheduling) · [Result states](Troubleshooting#result-states)

## /config closed-prefix set

**Purpose:** Set the text added at the beginning of thread names for future closes.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config closed-prefix set value:<value>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                   |
| ------- | ----------------- | --------------------------------------------------------------------------------------------- |
| `value` | Required          | String: Enter 1–20 Unicode code points after outer trimming. Control characters are rejected. |

**Example:**

To change the closed prefix setting to `[DONE]`:

1. Run `/config closed-prefix set` with the text `[DONE]` in `value`.
2. Check for a saved or unchanged result, then run [`/config show`](#config-show) and confirm the closed prefix is `[DONE]`.

Existing thread names are not a way to verify this setting: the command does not rename them.

**Results:** Reports saved or unchanged. This command changes the setting; it does not close threads or rename existing ones. Future closes use the new setting. However, a prefix saved at a previous close is reused until WEFT reflects the active thread state.

**Constraints:** Empty or whitespace-only input is invalid; it does not disable the prefix. Use the separate disable command. Check /config show after an UNCONFIRMED result.

**Related:** [Thread lifecycle](Thread-Lifecycle) · [Result states](Troubleshooting#result-states)

## /config closed-prefix disable

**Purpose:** Disable the closed prefix setting.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config closed-prefix disable
```

**Arguments:** None.

**Example:**

To disable the closed prefix setting, run `/config closed-prefix disable`. Check for a disabled or already-disabled result, then run [`/config show`](#config-show) and confirm that the closed prefix is **Disabled**. Existing names and prefixes already saved for closed threads remain unchanged.

**Results:**

- **Setting:** reports disabled or already disabled. This command does not close threads. Existing thread names and prefixes saved in WEFT’s `CLOSED` records remain unchanged.
- **Future closes:** closes add no prefix. However, repeated closes of a thread recorded as `CLOSED` reuse its saved prefix, including a nonempty one, until WEFT reflects the active thread state.

**Constraints:** This does not remove existing prefixes or guarantee bypassing Discord name-change limits. Inspect /config show if the write is unconfirmed.

**Related:** [Thread lifecycle](Thread-Lifecycle) · [Result states](Troubleshooting#result-states)

## /config link-preview show

**Purpose:** Read the currently saved preview mode.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config link-preview show
```

**Arguments:** None.

**Example:**

When you want to check how WEFT is configured to handle message links, run `/config link-preview show`. Read the displayed mode and compare it with the [link-preview mode table](Link-Previews#choose-a-mode). This checks the setting; it does not test whether a particular link can be previewed.

**Results:** Returns hybrid by default when no settings row exists, without creating one. Otherwise displays the configured mode.

**Constraints:** Does not check individual links or prove that WEFT can send a preview. A read failure is reported separately.

**Related:** [Link previews](Link-Previews) · [Result states](Troubleshooting#result-states)

## /config link-preview mode

**Purpose:** Choose automatic previews, access-checked buttons, or no preview output.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config link-preview mode value:<value>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                                         |
| ------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `value` | Required          | String choice: Select a mode from the labels below. The corresponding values are `hybrid`, `public-only`, `button-only`, and `off`. |

Select the displayed label in Discord’s `value` picker. Values below are for reference.

| English label                  | Japanese label               | Value         |
| ------------------------------ | ---------------------------- | ------------- |
| Automatic previews + buttons   | 自動表示＋プレビューボタン   | `hybrid`      |
| Automatic public previews only | 公開メッセージの自動表示のみ | `public-only` |
| Preview buttons only           | プレビューボタンのみ         | `button-only` |
| Off                            | オフ                         | `off`         |

**Example:**

To offer access-checked preview buttons without automatic previews:

1. Run `/config link-preview mode` and select **Preview buttons only** (value: `button-only`) in the `value` picker.
2. Check for the new mode or an unchanged result.
3. Run [`/config link-preview show`](#config-link-preview-show) and confirm that the displayed mode is **Preview buttons only**.

**Results:** Reports the new mode or unchanged. off disables existing preview buttons; public-only also rejects existing buttons.

**Constraints:** Changing mode does not remove already published copies. After UNCONFIRMED, use show before retrying. See the mode table for age restrictions and disclosure limits.

**Related:** [Link previews](Link-Previews) · [Result states](Troubleshooting#result-states)

## /config audit-log show

**Purpose:** Read the configured Discord audit-notification destination.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config audit-log show
```

**Arguments:** None.

**Example:**

When you want to find the saved destination for audit notifications, run `/config audit-log show`. Check whether notifications are disabled or a channel ID is stored. If a channel ID is shown but notifications are missing, use [Audit and privacy](Audit-and-Privacy) to investigate delivery; the saved ID alone does not establish that the channel still exists or is usable.

**Results:** Displays disabled or the stored channel ID, even if the channel has since disappeared. Missing settings are read as disabled without insertion.

**Constraints:** This does not test destination permissions or delivery. Missing notifications do not prove that operations did not occur.

**Related:** [Audit and privacy](Audit-and-Privacy) · [Result states](Troubleshooting#result-states)

## /config audit-log set

**Purpose:** Set the destination for optional Discord audit notifications.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config audit-log set channel:<channel>
```

**Arguments:**

| Option    | Required/optional | Input method and conditions                                                                                   |
| --------- | ----------------- | ------------------------------------------------------------------------------------------------------------- |
| `channel` | Required          | Channel: Select a text or announcement channel in this server. WEFT needs ViewChannel and SendMessages there. |

**Example:**

To send optional audit notifications to an existing `#weft-audit` channel:

1. Confirm that the intended text or announcement channel allows WEFT to view it and send messages.
2. Run `/config audit-log set` and select that channel in the `channel` picker. `#weft-audit` is an example name; choose the actual destination.
3. Check for a saved or unchanged result, then run [`/config audit-log show`](#config-audit-log-show) and check the saved destination.

The response confirms the setting, not the delivery of a test notification.

**Results:** Reports saved or unchanged after checking the current destination and bot permissions. The setting and its change audit are saved together.

**Constraints:** Threads, forums and inaccessible destinations are rejected. Validation is point-in-time. UNCONFIRMED requires inspecting show; no test notification or guaranteed future delivery is implied.

**Related:** [Audit and privacy](Audit-and-Privacy) · [Result states](Troubleshooting#result-states)

## /config audit-log disable

**Purpose:** Stop optional Discord audit notifications for this server.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config audit-log disable
```

**Arguments:** None.

**Example:**

To stop Discord audit notifications while retaining database audit history, run `/config audit-log disable`. Check for a disabled or already-disabled result, then run [`/config audit-log show`](#config-audit-log-show) and confirm that the destination is disabled. Previous notifications are not removed.

**Results:** Reports disabled or already disabled. Database audit recording and retention continue. This works even when the old destination was deleted.

**Constraints:** Does not delete prior notifications or database records. A lost confirmation requires checking show; disabling normally sends no notification.

**Related:** [Audit and privacy](Audit-and-Privacy) · [Result states](Troubleshooting#result-states)

## /config auto-close show

**Purpose:** Inspect the inactivity threshold, whether bot posts count, and enabled parent channels.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config auto-close show
```

**Arguments:** None.

**Example:**

After configuring automatic close, run `/config auto-close show`. Check the inactivity period, whether bot posts count, and whether the intended parent channels are enabled. If no parent is enabled, follow the [automatic-close setup steps](Automatic-Close). For one thread's participation and recorded activity, run [`/thread status`](Commands-Thread#thread-status) inside that thread with Manage Threads (`ManageThreads`).

**Results:** Returns the detailed policy, with no parents meaning no automatic-close candidates. Shows at most 25 parent mentions and a remaining count; this is a display limit, not a configured-parent limit. Individual exclusions still apply. Missing general settings may be initialized with defaults.

**Constraints:** This does not enumerate every eligible thread or inspect pending lifecycle operations. A parent missing from the first 25 displayed entries is not necessarily disabled. Use `/thread status` inside a thread under that parent, with Manage Threads, to check its policy.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /config auto-close inactivity

**Purpose:** Set the inactivity period after which eligible threads can be closed on a periodic check.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config auto-close inactivity value:<value>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                                                       |
| ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `value` | Required          | String: Enter one positive integer and unit `m`, `h`, or `d`, from 5 minutes through 365 days inclusive. Examples include `30m`, `12h`, and `7d`. |

**Example:**

To make eligible threads candidates after seven days without counted activity:

1. Run `/config auto-close inactivity` with the text `7d` in `value`.
2. Check for a saved or unchanged result, then run [`/config auto-close show`](#config-auto-close-show) and confirm that the inactivity period is `7d`.
3. Check that the intended parent channel is enabled; if needed, use [`/config auto-close add-parent`](#config-auto-close-add-parent).

Setting the period alone does not enable any parent channel or establish an exact closing time.

**Results:** Reports saved or unchanged. The new threshold is applied to recorded activity; it does not reset every thread’s timer. A shorter threshold can make existing activity eligible sooner.

**Constraints:** Compound/fractional durations are invalid. This is neither a thread-creation-age filter nor an exact closing deadline. Check show after an unconfirmed change.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /config auto-close bot-messages

**Purpose:** Choose whether qualifying bot posts count as automatic-close activity.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config auto-close bot-messages value:<value>
```

**Arguments:**

| Option  | Required/optional | Input method and conditions                                                                                        |
| ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `value` | Required          | Boolean: Select `true` or `false`. The initial policy is `false`, but this command requires an explicit selection. |

**Example:**

To count new bot posts, including WEFT's posts, when measuring inactivity:

1. Run `/config auto-close bot-messages` and select the Boolean value `true` in `value`.
2. Check that the response reports bot posts as included, saved or unchanged.
3. Run [`/config auto-close show`](#config-auto-close-show) and confirm that bot posts are included.

Select `false` instead if bot posts should not extend the inactivity period. This changes how subsequent posts count; it does not rescan earlier messages.

**Results:** Reports included/excluded, saved or unchanged. Affects subsequent qualifying activity, including WEFT posts when enabled.

**Constraints:** Discord system messages never count. Reactions, renames and setting changes do not count. This is not a history rescan. Inspect show after UNCONFIRMED.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /config auto-close add-parent

**Purpose:** Enable automatic closing under one parent and establish the inactivity measurement start time (baseline) for its currently active eligible threads.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config auto-close add-parent channel:<channel>
```

**Arguments:**

| Option    | Required/optional | Input method and conditions                                           |
| --------- | ----------------- | --------------------------------------------------------------------- |
| `channel` | Required          | Channel: Select a text, announcement or forum channel in this server. |

**Example:**

To enable automatic close for threads under an existing `#support` channel:

1. Check the inactivity period with [`/config auto-close show`](#config-auto-close-show) and adjust it first if needed.
2. Run `/config auto-close add-parent` and select the intended text, announcement or forum channel in `channel`. `#support` is an example name.
3. Check for enabled and the number of threads whose inactivity measurement starts now, or already enabled. Run [`/config auto-close show`](#config-auto-close-show) to inspect the enabled parents; use [`/thread status`](Commands-Thread#thread-status) inside a particular thread with Manage Threads (`ManageThreads`) to check its participation.

A successful setting does not mean the threads have already been closed.

**Results:** Reports enabled and the baseline count, or already enabled. Existing newer activity is preserved and excluded threads get no baseline. Repeating does not reset existing baselines.

**Constraints:** WEFT must read active threads first. Enumeration failure leaves the parent disabled. An unconfirmed database result needs show/status inspection. Enabling does not close every old thread immediately.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)

## /config auto-close remove-parent

**Purpose:** Disable automatic close under one configured parent.

**Access:** Requires Manage Server (`ManageGuild`) in this server.

**Syntax:**

```text
/config auto-close remove-parent channel:<channel>
```

**Arguments:**

| Option    | Required/optional | Input method and conditions                                                                                                |
| --------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `channel` | Required          | Channel: Select the parent whose automatic closing you want to disable. Selecting an unconfigured channel makes no change. |

**Example:**

To stop automatic close under `#support`:

1. Run `/config auto-close remove-parent` and select the parent to disable in the `channel` picker.
2. Check for disabled, or unchanged if it was not configured.
3. Run [`/config auto-close show`](#config-auto-close-show) and check the remaining enabled parents. Because it displays at most 25, absence alone does not confirm disablement. Inside a thread under the removed parent, use [`/thread status`](Commands-Thread#thread-status) with Manage Threads to check the parent policy.

This does not cancel separate scheduled closes or undo a close that has already started.

**Results:** Reports disabled or unchanged if absent. Retains recorded activity and per-thread exclusions. Explicit scheduled closes remain independent.

**Constraints:** Does not reopen threads or reverse an already-started close. Re-enabling starts inactivity measurement from re-enablement while preserving newer recorded activity. Inspect show after UNCONFIRMED.

**Related:** [Automatic close](Automatic-Close) · [Result states](Troubleshooting#result-states)
