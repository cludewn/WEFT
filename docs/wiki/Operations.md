# Operations

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Operations-ja)

This page is for the host operator maintaining an installed WEFT. Keep one active application instance. Keep PostgreSQL running during graceful application stops and migrations.

Use the checks below for daily operation, [verify a stop](#stop-and-verify) before maintenance, or follow the [upgrade sequence](#upgrade-in-order). After starting again, [inspect delayed work](#restart-and-delayed-work) as well as readiness.

<a id="observe-health-and-logs"></a>

## Check normal operation

1. From the intended Compose checkout, run `docker compose ps` and check container state.
2. Run the [container-local readiness check](Installation-and-Setup#verify-the-first-run).
3. Follow [application-log checks](#inspect-operation-logs) to inspect startup, execution-result and shutdown events in private logs.
4. If the app has restarted or been updated, follow [the delayed-work checks](#restart-and-delayed-work) before replacing work that appears missing.

| Endpoint / response state | HTTP status / response          | What it confirms                                                                                     |
| ------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health/live`        | 200, `{"status":"alive"}`       | The local listener responds; no dependency checks.                                                   |
| `GET /health/ready`       | 200, `{"status":"ready"}`       | Startup reached `READY`, Discord is currently ready and a read-only DB query succeeded.              |
| Readiness unavailable     | 503, `{"status":"unavailable"}` | At least one readiness condition was not established; use the application logs below to investigate. |

Readiness does not confirm that a reservation ran or that Discord matches saved state. If unavailable, use [startup and readiness troubleshooting](Troubleshooting#startup-migration-or-readiness-failure). Keep logs private: never publish configuration, tokens, connection strings, message content or raw error dumps. [Health-check limits](#health-check-limits) explain the observation and probe timing.

<a id="inspect-operation-logs"></a>

## Investigate an operation in application logs

The host operator can read the app container's structured JSON logs. From the intended Compose project, start with this read-only command and adjust `30m` to include the original operation and any restart:

```sh
docker compose logs --since 30m --no-color app
```

Use your deployment's explicit project/settings/file selections here too. Read the `event` field, then compare the operation time and any recorded `guildId`, `threadId`, `scheduledActionId` or `occurrenceId` with the response you kept. Not every event contains all IDs. These logs describe WEFT's processing; they are separate from [database audit history](Audit-and-Privacy#audit-storage-reference) and Discord notices.

- **Startup or shutdown:** `application_ready` marks completed startup; `startup_step_failed` names the failed `startupStep`. `shutdown_completed` or `shutdown_timed_out` helps assess a stop.

- **A close/open result that remains unclear:** `thread_lifecycle_failed` or `thread_lifecycle_outcome_unknown` identifies the thread, operation and `failureCode`. Events beginning `thread_lifecycle_reconciliation_` describe WEFT reading Discord again to confirm a result; warnings can report an unavailable resource, rejected read or scheduled retry. They do not by themselves prove the original change was rejected.

- **Automatic close:** `automatic_close_candidate_execution_failed` identifies a target, `outcome` and `failureCode`; `automatic_close_sweep_scan_failed` means a candidate-page read failed. `automatic_close_sweep_completed` is an aggregate and is omitted when there are no candidates.

- **Scheduled close execution:** `scheduled_thread_close_execution_finished` includes `scheduledActionId`, `outcome`, and `reason` or `failureCode` when applicable. Compare it with the actual thread and reservation.

- **Repair of saved close reservations:** `scheduled_thread_close_startup_recovery_completed` and `scheduled_thread_close_runtime_reconciliation_completed` summarize startup/periodic checks that restore execution requests for saved reservations. Their `_failed` counterparts identify failed checks. A completed sweep is not proof that a particular thread closed.

- **Scheduled/recurring posts:** `scheduled_message_execution_finished` identifies the schedule and outcome; `recurring_execution_finished` identifies an occurrence and outcome. `recurring_execution_unconfirmed` means its result could not be established. Compare with list/status and the actual destination before replacing a post.

- **Missing audit notice:** `audit_notification_delivery` records a notification that was not delivered; read `source`, `auditId` and `outcome`, plus destination/guild IDs when present. It does not report failure of the original administrative operation.

The default `LOG_LEVEL=info` omits debug-only detail, including `thread_lifecycle_pending` and individual processing steps. Higher configured thresholds omit more events; old container logs may also be unavailable. A missing line is not proof of success, failure or no work in progress. Do not restart or change log settings merely to reproduce an uncertain mutation. If response, current Discord state and available logs do not resolve it, preserve those observations and have a database-capable operator investigate the relevant saved records. There is no slash command for complete lifecycle progress or audit-history search.

Keep logs private. Share only the relevant, safely redacted event fields; never publish credentials, payloads or complete configuration.

<a id="stop-and-verify"></a>

## Stop the app and confirm graceful completion

From the intended Compose project:

```sh
stop_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose stop -t 45 app
docker compose ps -a app
docker compose ps postgres
docker compose logs --since "$stop_started_at" --no-color app
```

Require the app to be stopped with exit 0 and a matching `shutdown_completed` for this stop, while
PostgreSQL remains running. `docker compose stop` success alone does not confirm a graceful drain.
WEFT has one shared 30-second shutdown deadline; the container allows 45 seconds. Deadline expiry
or cleanup failure exits nonzero; it does not establish whether in-flight work succeeded. Investigate an
uncertain or failed shutdown before backup, restore or update.

## Upgrade in order

Before using a different checkout directory, confirm that it still selects the deployment's existing Compose project, private settings and PostgreSQL volume. Carry the same explicit project name and configuration-file selection into each Compose command when needed; directory-based defaults can select a different project. Before building or migrating, use the read-only checks below. Run them with the same Compose project, private settings file and Compose file that you will use for migration; add your deployment's explicit `--project-name`, `--env-file` and `-f` selections to every invocation when applicable.

```sh
docker compose ps -a app
docker compose ps postgres
docker compose exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select current_database(), current_user;
SQL
```

Compare the results with your deployment record: the existing app/PostgreSQL containers and published host port must be the intended ones, and the returned database and role must match the database name/user selected for the new migration container. In Docker's container details, also compare the PostgreSQL container's Compose project label and mounted volume with that record. A matching database name alone cannot distinguish two projects. If the expected identities are unknown, a command fails, or any value differs, stop before migration and resolve the mismatch. Do not print resolved configuration or credentials to investigate.

A backup exports the existing database to an archive; restoration replaces a database with archived data. **An ordinary Bot update does not delete/recreate the database or restore archived data.** Do not run `dropdb`, `createdb` or a data-restoring `pg_restore` command. The backup procedure's `pg_restore --list` only reads the archive's table of contents; it does not restore the database. Follow backup creation, inspection and recording only, then return to the upgrade sequence below.

Complete the target checks above before starting the sequence. Keep PostgreSQL running throughout, and keep the app stopped from step 3 until migration succeeds in step 5.

1. Review the target source/image, migration notes and command changes. Keep the new image coupled to its committed `drizzle/` files. Separately record the currently running app's source version and image ID from your deployment record and Docker container details; these identify the backup's source, not the new checkout's revision.
2. From the intended target checkout, build the new image with `docker compose build app` and require success before continuing. This command builds without starting or recreating the app, so the old app may remain running while the image is prepared. Do not start the new image yet.
3. Stop the old app using [the verified stop procedure](#stop-and-verify). Require exit 0 and a matching `shutdown_completed` for that stop, with PostgreSQL still running. If the stop failed or cannot be verified, investigate before backup or migration.
4. With the app still stopped, follow [backup creation, inspection and recording](Backup-and-Recovery#create-and-inspect-a-backup). Record the old source version/image from step 1 with the archive, and the new version as the intended migration target. Require successful archive creation and inspection before continuing. **Do not restart the old app after this backup.** At the backup guide's [continuation choices](Backup-and-Recovery#continue-after-backup), choose the upgrade route and return here to step 5; do not run its restore or database-deletion blocks.
5. Run **one** migration process from the prepared target image:

   ```sh
   docker compose run --rm app node dist/migrate.js
   ```

   Require exit 0 and `migration_succeeded` in that one-shot process's output. `migration_failed` or a nonzero exit requires investigation; preserve the result privately. These are migration-command output, not the stopped app's logs. On failure, keep the app stopped. Do not start either application version against a partial or unknown schema, modify applied SQL/journal history, or generate schema changes on the deployment host.

6. Only after migration succeeds, start the prepared app with `docker compose up -d app`, [verify readiness](Installation-and-Setup#verify-the-first-run) and [inspect delayed work after restart](#restart-and-delayed-work), including recovery logs and actual Discord results. If container settings changed, recreate only the app after its verified stop, for example `docker compose up -d --no-deps --force-recreate app` with the prepared image.
7. Redeploy commands from the target source tools to each Guild/Global scope actually used, following [command registration](Installation-and-Setup#register-commands). Restart alone does not register commands. Check a read-only command and representative operations using resources created for verification. Record the source versions, backup reference, migration outcome and observations privately.

WEFT migrations are explicit and append-only; normal startup does not run them. The scheduler owns
its own internal PostgreSQL schema and migrates that during scheduler startup, not via WEFT’s
migration runner. Do not clear scheduler state to fix an unexplained delivery problem. Database and
application downgrades are unsupported by the documented recovery procedure.

<a id="restart-and-delayed-work"></a>

## Check delayed work after restart

1. Confirm readiness and inspect startup/recovery logs using [the normal-operation checks](#observe-health-and-logs).
2. In each original posting channel, run [`/message schedule list`](Commands-Message#message-schedule-list) with no options. For a reservation you need to investigate, run [`/message schedule status`](Commands-Message#message-schedule-status) with its saved schedule ID in `id`. Completed or cancelled reservations are absent from the list; use a retained ID to inspect them. Check the actual destination and any result message link before creating replacement work.
3. Inside a thread with a reserved close, run [`/thread status`](Commands-Thread#thread-status) with no options. Check its current reservation, then inspect the actual archive state. Status does not list every pending lifecycle operation.

These Discord checks require the commands' current actor permissions. Consult [scheduled messages](Scheduled-Messages#read-the-status-and-verify-delivery) and [scheduled thread close](Scheduled-Thread-Close) for the result-specific next action. Restart does not guarantee that every overdue action runs:

- Startup checks saved reservations and repairs their execution requests before accepting commands; the first periodic sweep need not finish before readiness.
- Automatic-close baseline repair is best effort.
- Unfinished thread operations are tracked in the running app while Discord requests and result confirmation settle. A process exit loses that tracking; stopping cannot guarantee all effects finish. Check the original response, current thread and available logs after restart before another change.
- [Scheduled closes](Scheduled-Thread-Close#execution-and-downtime) and [messages](Scheduled-Messages#late-work-restart-and-retries) follow different recovery policies.
- Bulk-selection and list controls are invalidated. Inspect unconfirmed sends before scheduling replacements.

If checks fail, follow [Troubleshooting](Troubleshooting#startup-migration-or-readiness-failure). For data recovery, use [Backup and recovery](Backup-and-Recovery).

<a id="health-check-limits"></a>

## Details: health checks and logs

The DB observation waits at most 2 seconds. Readiness does not inspect queued work, repair anything, prove Discord consistency or guarantee the next operation.

Compose probes container-local readiness every 30 seconds, allows 5 seconds per probe, marks unhealthy after 3 failures and allows a 60-second startup period. The health port is not published. An unhealthy result calls for investigating the failed condition; it does not establish whether an earlier Discord operation succeeded.
