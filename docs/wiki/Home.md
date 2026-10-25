# WEFT user guide

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Home-ja)

WEFT is a self-hosted Discord bot that helps server administrators close finished discussions and publish messages on a schedule. You operate it through Discord slash commands and forms.

Use it to archive resolved support threads, close discussions after inactivity, review a batch before closing it, or publish a one-time reminder or daily/weekly announcement. Messages sent and recorded by WEFT can be edited through its commands.

<a id="start-here"></a>

## Choose your starting point

| Your goal                                 | Start here                                                                               | Then continue to                                                       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Install WEFT for the first time           | [Installation and setup](Installation-and-Setup)                                         | [Choose server settings](Configuration)                                |
| Manage threads on an installed bot        | [Close one thread and understand archiving](Thread-Lifecycle)                            | [Thread command details](Commands-Thread)                              |
| Enable automatic closing after inactivity | [Set up automatic close](Automatic-Close#enable-a-parent-then-exempt-individual-threads) | [If threads do not close](Troubleshooting#automatic-close-not-running) |
| Schedule a post                           | [Create a scheduled message](Scheduled-Messages)                                         | [Timezones and time inputs](Timezones-and-Scheduling)                  |
| Check saved server settings               | [Use `/config show`](Commands-Config#config-show)                                        | [Understand server settings](Configuration)                            |
| Look up a command                         | [Choose a command family](Command-Reference#choose-a-command-family)                     | [Find an individual command](Command-Reference#all-commands)           |
| Investigate a problem or uncertain result | [Troubleshooting](Troubleshooting)                                                       | The symptom’s checks and safe retry guidance                           |

Self-hosting means you provide and maintain the machine running WEFT and its PostgreSQL database. The supported deployment has one active WEFT instance and PostgreSQL 18, using Docker Compose. [Installation](Installation-and-Setup) explains the required tools, Discord application and permissions.

<a id="choose-a-task"></a>

## Find a feature or operation

| Task                                              | Guide                                            |
| ------------------------------------------------- | ------------------------------------------------ |
| Close at a chosen future time                     | [Scheduled thread close](Scheduled-Thread-Close) |
| Select and close several threads                  | [Bulk thread close](Bulk-Thread-Close)           |
| Create or edit a bot announcement                 | [Managed messages](Managed-Messages)             |
| Configure how message-link previews are displayed | [Link previews](Link-Previews)                   |
| Understand stored information and audit notices   | [Audit and privacy](Audit-and-Privacy)           |
| Check health, stop or upgrade WEFT                | [Operations](Operations)                         |
| Back up or restore PostgreSQL                     | [Backup and recovery](Backup-and-Recovery)       |

<a id="find-a-command"></a>

## Use guides and references together

Guides explain a complete task, including what to check afterward. The [command reference](Command-Reference) gives exact inputs, permissions and results for all 32 operations: [configuration](Commands-Config), [threads](Commands-Thread), and [messages and schedules](Commands-Message).

<a id="before-you-rely-on-an-outcome"></a>

## Check the result before repeating an operation

Each guide explains successful results and the cases that need observation. When a result is uncertain, follow [Troubleshooting](Troubleshooting#result-states) before repeating the command. Missing audit notifications do not establish failure.

<a id="guide-version"></a>

This Wiki covers the features and commands implemented for WEFT's initial MVP. The canonical Markdown sources are maintained in [`docs/wiki/` on the repository's `main` branch](https://github.com/cludewn/WEFT/tree/main/docs/wiki) and published to the GitHub Wiki.

Before using a command or setting, check that it is available in the WEFT version you deploy.
