# Audit and privacy

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Audit-and-Privacy-ja)

WEFT keeps **audit history** in PostgreSQL so operators can investigate administrative changes and execution outcomes. You can also enable **audit notifications** in a Discord channel for convenient observation. The stored history and the Discord notices have different guarantees.

| Record                     | Use                                                                       | Limitation                                                                           |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| PostgreSQL audit history   | Investigate recorded changes and outcomes                                 | Some failure recording is best effort; absence does not prove no operation occurred. |
| Optional Discord notices   | Follow newly committed audits without reading the database                | Delivery can be lost; this is not authoritative storage.                             |
| Discord standard audit log | Inspect Discord’s own audit entries, including WEFT thread-change reasons | A separate Discord service, not WEFT’s database history                              |

<a id="what-is-recorded"></a>

## Audit coverage

All **10 sources** below participate in retention and optional notifications.

| Category                           | Recorded activity                                                                                                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Thread operations                  | Close, open, automatic close/open and lifecycle outcomes                                                                                   |
| Scheduled thread closes            | Explicit close creation/replacement/cancellation and execution/retry/failure                                                               |
| Managed-message changes            | Confirmed managed-message creation, edits and edit-time deletion detection                                                                 |
| One-time scheduled posts           | One-time schedule changes and execution outcomes                                                                                           |
| Recurring posts                    | Series changes, occurrence outcomes, DST gaps and missed ranges                                                                            |
| Audit notification settings        | Notification-destination changes                                                                                                           |
| Link preview settings              | Preview-mode changes, not preview content or clicks                                                                                        |
| Server settings and exclusions     | Timezone, prefix, automatic-close scalar/parent changes and thread exclusions                                                              |
| Administrative operation failures  | Eligible failures while changing settings, exclusions or schedules, or preparing a manual/bulk close, under the conditions described below |
| Managed-message send/edit failures | Confirmed failures and confirmed partial effects of interactive managed-message send/edit                                                  |

**Failure coverage is limited.** After valid input, target and the invoking user's authorization are established, eligible administrative failures include failures where the database change is confirmed not to have completed. Certain operations also record required-read, bot-permission or active-thread-enumeration failures. For example, enabling an automatic-close parent can record a failure to fetch its active threads; creating a scheduled close can record a bot-permission failure after the user's authorization is confirmed. This does not mean every operation records every kind of failure.

Invalid input, denied or unverified user authorization, ordinary conflicts and operations already being processed by WEFT do not create this separate administrative-failure record. Interactive managed-message send/edit has its own failure records: these distinguish confirmed failure from `PARTIAL`, where a Discord effect and incomplete database update are established but undoing the effect was not attempted or was rejected. An error or result label alone is insufficient; recording a failure requires evidence of an eligible failure.

Routine administrators should start with the response and actual Discord state. Operators can use the [database table reference](#audit-storage-reference) to investigate recorded evidence. Missing history or notifications never makes a resend or another close safe by itself.

<a id="stored-data-and-privacy"></a>

## Protect stored information

Restrict database access, [backup archives](Backup-and-Recovery) and notification-channel membership according to your server’s privacy needs.

| Information                                       | Storage or disclosure                                                                                                                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor/Discord IDs, times, operations and outcomes | Can appear in audit history.                                                                                                                                      |
| Failure details                                   | Eligible failure records identify the operation, stage and predefined reason; verified target IDs and established effect/undo evidence depend on the record type. |
| Supported message payload and changes             | Managed-message success audits contain complete supported content and before/after changes; scheduled payloads/audits can contain text and image URLs.            |
| Automatic-close activity                          | Metadata, not message bodies                                                                                                                                      |
| Preview content and clicks                        | No dedicated persistent preview history or audit                                                                                                                  |
| Discord notices                                   | Limited plain-text metadata with suppressed mentions; no message/embed content, names, arbitrary before/after values, raw errors or credentials                   |

Confirmed administrative-failure and managed-message execution-failure notices also omit target identity. Other sources can include target IDs. Retention of WEFT history cannot remove Discord copies or old backups.

<a id="optional-discord-notifications"></a>

## Enable, verify or disable Discord notices

You need Manage Server. Choose a text/announcement channel with an appropriate audience; WEFT needs current View Channel and Send Messages there. Notices can contain actor and other metadata, including target IDs from some sources.

1. Select [`/config audit-log set`](Commands-Config#config-audit-log-set). In `channel`, choose the destination from Discord’s channel picker, for example the intended `#weft-audit`, then run it.
2. Read whether the response confirms a saved change or no change. Run [`/config audit-log show`](Commands-Config#config-audit-log-show) with no options and check the intended channel ID. If saving is `UNCONFIRMED`, [investigate the uncertain result](Troubleshooting#result-states) before retrying.
3. Observe a subsequent actual [audited change](#what-is-recorded) and its notice when delivered. Setting the destination is not a guaranteed test delivery.
4. If notices are missing, follow the [notification checks](Troubleshooting#audit-notifications-missing) for the stored destination, actual access, audit eligibility and operator evidence. Show reads the saved ID even if the channel no longer exists. A missing notice does not establish that the operation failed; see [notification and evidence limits](#evidence-limits).

To stop notices, run [`/config audit-log disable`](Commands-Config#config-audit-log-disable) with no options, read the response and use `/config audit-log show` to check that the destination is disabled.

Database auditing and retention continue. Prior notices are not deleted, and disabling normally sends no notice.

<a id="retention"></a>

## Retention and its limits

| Retained data                                    | Retention (days) | Conditions                                                                            |
| ------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------- |
| <!-- fact:audit-retention-days --> Audit history | 90               | Each day is 24 elapsed hours. The duration is fixed and cannot be changed per server. |

| Retention processing                                                | Count / interval | Conditions                                      |
| ------------------------------------------------------------------- | ---------------- | ----------------------------------------------- |
| <!-- fact:audit-source-count --> Covered audit sources              | 10 sources       | Includes all audit categories above.            |
| <!-- fact:audit-sweep-hours --> Delay before the next cleanup sweep | 24 hours         | Measured from completion of the previous sweep. |
| <!-- fact:audit-batch --> Maximum rows per deletion batch           | 500 rows         | Rows are deleted in audit-time and ID order.    |

An initial cleanup is scheduled shortly after startup without delaying readiness. Each sweep
chooses one cutoff and deletes only timestamps **strictly older** than now minus 90 × 24 hours;
records equal to the cutoff remain. Batches and failures can delay deletion; records are not guaranteed to be deleted at the exact expiration time.
A failed source does not invalidate business operations. Cleanup continues for the other sources; the failed source’s remaining work waits for another sweep.

Retention deletes audit history only, not schedules, managed resources, configuration or recovery
state, and creates no notification. Retention cannot be configured per server. It is not a deletion guarantee for message content stored elsewhere,
Discord copies or old backups. Treat [backup archives](Backup-and-Recovery) as private data too.

<a id="evidence-limits"></a>

## What audit presence or absence means

- Actual successful configuration transitions are audited. Exact no-ops and baseline-only repair do not create configuration-change history.
- The separate confirmed administrative-failure source excludes invalid input/context, denied or unverified authorization, ordinary conflicts and another unfinished operation on the same target.
- `PENDING` means WEFT is still processing or checking the result; `UNCONFIRMED` means insufficient evidence. Delayed responses or asynchronous errors do not turn either into confirmed failure.
- Some thread/background results contain `FAILURE` even when the Discord effect is unconfirmed. For example, `DISCORD_RECONCILIATION_UNCONFIRMED` means WEFT could not confirm and finish a thread operation; the earlier Discord change may still have occurred. Inspect the actual thread and operator records before another change.
- Separate failure records are attempted after the business operation. Outages, crashes or shutdown limits can lose them; there is no later backfill.
- `PARTIAL` establishes only known historical effects, not current remaining message state. An absent audit or notice alone cannot prove an operation never occurred.

Notices check the current destination and WEFT’s view/send permissions at delivery. Sending is best effort, once, with duplicate reduction. There is no retry, replay, backfill, ordering or exactly-once guarantee. A crash after audit commit can lose the notice. Missing notification does not undo the recorded operation.

<a id="audit-storage-reference"></a>

## Database reference for operators

WEFT has no slash command or bundled search tool for browsing complete database audit history. A host operator with PostgreSQL access must use read-only SQL against the current schema; the table names below identify where to investigate, not a ready-to-run inspection tool. Compare the saved response and time with the record’s operation, actor, target/schedule IDs where present, outcome and failure reason. Columns differ by category, and some failure records deliberately omit target identity. If those records cannot identify the exact attempt, leave its outcome unconfirmed; do not infer it from a later matching setting.

Administrative-failure records use 23 fixed identifiers for the operation and how it was invoked, such as manual or bulk-close preparation. These operation/origin codes classify the attempted action; 23 is not a count of all command failures. They cover settings and policy changes, schedule administration, and per-thread manual/bulk close preparation. The code, failure stage and reason must be interpreted together; lifecycle execution and managed-message execution use separate records. The [conditions above](#what-is-recorded) explain the practical coverage.

| Category                           | Database table                           |
| ---------------------------------- | ---------------------------------------- |
| Thread operations                  | thread_audits                            |
| Scheduled thread closes            | scheduled_thread_close_audits            |
| Managed-message changes            | managed_message_audits                   |
| One-time scheduled posts           | scheduled_message_audits                 |
| Recurring posts                    | recurring_message_audits                 |
| Audit notification settings        | audit_log_destination_audits             |
| Link preview settings              | link_preview_audits                      |
| Server settings and exclusions     | guild_configuration_audits               |
| Administrative operation failures  | administrative_operation_failure_audits  |
| Managed-message send/edit failures | managed_message_execution_failure_audits |

Command details: [`audit-log show`](Commands-Config#config-audit-log-show), [`set`](Commands-Config#config-audit-log-set), [`disable`](Commands-Config#config-audit-log-disable). Interpret uncertain operations with [Troubleshooting](Troubleshooting#result-states).
