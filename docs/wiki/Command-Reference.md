# Command reference

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Command-Reference-ja)

This page links all **32 operations** to their full syntax, inputs, access requirements and outcomes. Choose a family below to browse its commands, or use the [complete index](#all-commands) when you know the command name. The separate guide links explain workflows.

## Choose a command family

| Family     | Operations | Command list and details                  | Feature guides                                                                                                   |
| ---------- | ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/config`  | 14         | [Configuration commands](Commands-Config) | [Server settings](Configuration), [Automatic close](Automatic-Close)                                             |
| `/thread`  | 8          | [Thread commands](Commands-Thread)        | [Thread lifecycle](Thread-Lifecycle), [Scheduled close](Scheduled-Thread-Close), [Bulk close](Bulk-Thread-Close) |
| `/message` | 10         | [Message commands](Commands-Message)      | [Managed messages](Managed-Messages), [Scheduled messages](Scheduled-Messages)                                   |

All commands are server-only. The invoking user needs Manage Server (`ManageGuild`) for `/config`, Manage Threads (`ManageThreads`) for `/thread`, or Manage Messages (`ManageMessages`) for `/message`. Administrator is not required. Each entry also specifies the target context and WEFT’s current permissions. Command visibility alone is not authorization.

<a id="read-syntax"></a>

## Read syntax and examples

Syntax such as `command option:<value>` is explanatory notation, not a complete string to copy and execute. `<...>` marks a value to replace; optional-argument `[...]` marks an optional field. Do not type these brackets.

1. Check the server, channel or thread where you intend to operate, then use `/` to select the WEFT command from Discord’s suggestions. Command and option names are the same in both languages.
2. For ordinary String options, type the value in that option’s field. Enter values containing spaces, such as local datetimes, without quotation marks in that field.
3. For String options with choices, select the displayed choice. Labels follow Discord’s language and may differ from the stored values. A pasted command string containing a choice value is not an interaction procedure.
4. For Channel options, choose the actual channel from the picker; for Boolean options, select the Boolean value. Names such as `#support` describe example targets, not fixed text to submit.
5. Run the command. If it opens a form, enter the fields and submit the form to request the change. Bulk close additionally requires target selection and confirmation.

The current 32 operations have no autocomplete, Integer, Number or User slash options. Parent and Owner in `/thread bulk-close` are Channel and User selectors inside its form. `/message schedule list` uses buttons for pagination.

Where `after` and `at` are individually optional, exactly one is required at execution. Selecting **weekly** for `frequency` also requires `weekdays`, but `weekdays` itself is a comma-separated text input. Check each argument table for registration requirements and runtime conditions. Use actual schedule/message IDs. Calendar examples illustrate format; choose a valid future date within the allowed horizon when executing.

<a id="all-commands"></a>

## Find an individual command

Use this index to open one command’s detailed entry directly. To compare commands within a family, use the family’s command list above.

### /config

| Command                                                                               | Lookup topic            |
| ------------------------------------------------------------------------------------- | ----------------------- |
| [`/config show`](Commands-Config#config-show)                                         | Settings overview       |
| [`/config timezone`](Commands-Config#config-timezone)                                 | Default timezone        |
| [`/config closed-prefix set`](Commands-Config#config-closed-prefix-set)               | Set a closed prefix     |
| [`/config closed-prefix disable`](Commands-Config#config-closed-prefix-disable)       | Disable prefixing       |
| [`/config link-preview show`](Commands-Config#config-link-preview-show)               | Current preview mode    |
| [`/config link-preview mode`](Commands-Config#config-link-preview-mode)               | Change preview mode     |
| [`/config audit-log show`](Commands-Config#config-audit-log-show)                     | Saved audit destination |
| [`/config audit-log set`](Commands-Config#config-audit-log-set)                       | Set audit destination   |
| [`/config audit-log disable`](Commands-Config#config-audit-log-disable)               | Disable audit notices   |
| [`/config auto-close show`](Commands-Config#config-auto-close-show)                   | Automatic-close policy  |
| [`/config auto-close inactivity`](Commands-Config#config-auto-close-inactivity)       | Inactivity period       |
| [`/config auto-close bot-messages`](Commands-Config#config-auto-close-bot-messages)   | Bot activity policy     |
| [`/config auto-close add-parent`](Commands-Config#config-auto-close-add-parent)       | Enable a parent         |
| [`/config auto-close remove-parent`](Commands-Config#config-auto-close-remove-parent) | Disable a parent        |

### /thread

| Command                                                       | Lookup topic                                   |
| ------------------------------------------------------------- | ---------------------------------------------- |
| [`/thread close`](Commands-Thread#thread-close)               | Archive without locking                        |
| [`/thread open`](Commands-Thread#thread-open)                 | Reflect an already-active thread; no unarchive |
| [`/thread status`](Commands-Thread#thread-status)             | Policy and current close reservation           |
| [`/thread track`](Commands-Thread#thread-track)               | Remove individual exclusion                    |
| [`/thread untrack`](Commands-Thread#thread-untrack)           | Add individual exclusion                       |
| [`/thread close-after`](Commands-Thread#thread-close-after)   | Create/replace a close reservation             |
| [`/thread cancel-close`](Commands-Thread#thread-cancel-close) | Cancel a waiting close reservation             |
| [`/thread bulk-close`](Commands-Thread#thread-bulk-close)     | Review, select and close threads               |

### /message

| Command                                                                                    | Lookup topic                   |
| ------------------------------------------------------------------------------------------ | ------------------------------ |
| [`/message send`](Commands-Message#message-send)                                           | Create a managed message       |
| [`/message edit`](Commands-Message#message-edit)                                           | Edit a managed message         |
| [`/message schedule create`](Commands-Message#message-schedule-create)                     | Create a one-time reservation  |
| [`/message schedule recurring-create`](Commands-Message#message-schedule-recurring-create) | Create daily/weekly posts      |
| [`/message schedule list`](Commands-Message#message-schedule-list)                         | List nonterminal reservations  |
| [`/message schedule status`](Commands-Message#message-schedule-status)                     | Inspect one reservation        |
| [`/message schedule edit`](Commands-Message#message-schedule-edit)                         | Change saved text/embed        |
| [`/message schedule reschedule`](Commands-Message#message-schedule-reschedule)             | Move a one-time send           |
| [`/message schedule recurrence-edit`](Commands-Message#message-schedule-recurrence-edit)   | Change a recurring rule        |
| [`/message schedule cancel`](Commands-Message#message-schedule-cancel)                     | Cancel a reservation or series |
