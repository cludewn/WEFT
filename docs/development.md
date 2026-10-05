# WEFT Development Guide

## Purpose

This document defines the approved architecture, implementation order, and repository workflow for WEFT.

Product behavior is defined in `docs/specification.md`.

When this document conflicts with the product specification, the product specification takes precedence for product behavior.

## Architecture

WEFT uses a modular-monolith architecture.

The initial runtime consists of:

- one Node.js application process,
- one PostgreSQL service,
- one Discord bot application,
- Docker Compose for local and self-hosted deployment.

All application functionality runs in one Node.js process.

PostgreSQL runs as a separate Docker Compose service.

Do not split application modules into network services without a demonstrated requirement and explicit approval.

Do not introduce Redis, additional runtime services, or a web interface without an approved specification change.

## Code organization

Organize the code around clear feature and infrastructure boundaries.

The implementation is expected to include responsibilities for:

- application startup and shutdown,
- Discord commands and event handling,
- guild configuration,
- thread management,
- managed messages,
- persistent scheduling,
- audit recording,
- Discord integration,
- PostgreSQL access,
- job execution,
- structured logging.

The exact directory structure is not fixed in advance.

When introducing or changing the structure:

- prefer the smallest structure that clearly separates responsibilities,
- organize closely related feature code together where practical,
- keep substantial business logic out of Discord command and event handlers,
- keep Discord API details out of rules that do not require Discord,
- keep database queries out of Discord handlers,
- avoid generic `utils`, `common`, or `shared` modules unless multiple concrete callers justify them,
- do not create empty directories or placeholder modules,
- do not introduce an interface unless it provides a real architectural or testing boundary,
- do not create layers only to match an architectural pattern,
- explain significant structural decisions before implementing them,
- evolve the structure from implemented use cases rather than anticipated future features.

The first implementation must establish only the structure required for the project foundation and the current vertical slice.

## Responsibility boundaries

### Discord handlers

Discord command and event handlers:

- parse Discord-specific input,
- validate the interaction or event context,
- invoke application operations,
- format Discord responses.

They must not contain substantial business logic.

A handler may perform Discord-specific validation, but product decisions should remain independently testable where practical.

### Application operations

Application-level code coordinates a use case across:

- authorization,
- persistent storage,
- Discord operations,
- scheduled jobs,
- audit recording.

Do not require every operation to use a class or formal service abstraction.

Use the smallest design that keeps the use case understandable and testable.

### Domain rules

Rules that do not require direct Discord API or database access should remain independent of those systems.

Examples include:

- closed-prefix normalization,
- lifecycle-state decisions,
- activity classification,
- schedule replacement rules,
- revision and concurrency decisions.

Do not create a separate domain layer when the behavior is too small to justify one.

### Discord integration

Discord-specific code performs Discord API operations.

Keep discord.js details near the Discord integration boundary.

Application rules should not depend unnecessarily on concrete discord.js objects.

Introduce an interface or adapter only when it provides meaningful isolation, testability, or replaceability.

Do not create wrapper interfaces that merely duplicate discord.js without adding a real boundary.

WEFT supports Guild Install only because its management operations require a guild bot member.
The installation permission set is an upper bound, not authorization for every channel. Discord
channel and thread overwrites determine the bot's effective permissions; WEFT checks those at the
Discord boundary. Human command defaults may be overridden by server administrators, so runtime
authorization still checks `ManageGuild` for `/config`, `ManageThreads` for `/thread`, and
`ManageMessages` for `/message` slash and modal actions. `/ping` remains unrestricted within a guild.

Thread lifecycle checks force-fetch the actor and bot members. discord.js 14.27.0 calculates a
thread's effective permissions through its cached parent channel, so checks refresh the parent
channel before using `thread.permissionsFor`. Thread message-send preflight does the same and
requires `SendMessagesInThreads`; ordinary text and announcement sends require `SendMessages`.
Individual managed-message GETs require `ViewChannel` and `ReadMessageHistory`; an unreadable
read-back after an ambiguous edit cannot confirm either success or failure. These checks are
point-in-time: Discord may reject the subsequent read or mutation if permissions change again.

The runtime uses only `Guilds`, `GuildMessages` and `MessageContent` Gateway intents. Automatic-close
activity tracking uses message metadata; link-preview detection reads content. Single member REST
fetches require no `GuildMembers` Gateway intent; presence intent is also unnecessary. Command
registration is a separate guild or global deployment operation, not part of normal runtime
startup. See the README for the operator installation procedure and command-deployment commands.

The runtime Client and standalone command-deployment REST instance explicitly configure
`retries: 0`. In the resolved discord.js REST transport this disables automatic retries
for 5xx responses, `AbortError` (including REST request timeout), and `ECONNRESET`.
Keep discord.js route bucket, global rate-limit, and sublimit handling, including ordinary
429 wait and retry. Do not add fixed Discord bucket limits, a second queue, or a generic
retry layer. A 429 resend inside discord.js is separate from a WEFT application replay.

Rate-limit queue waiting is distinct from the REST request timeout, a WEFT caller wait
budget, and feature-specific retry or replay. Queue waiting can outlive a caller budget
without making the mutation fail; thread lifecycle then retains the raw mutation and
may return `PENDING`. Feature code continues to own its specified reconciliation and
application retry behavior after a surfaced failure. Rate-limit logs must exclude
`majorParameter`, request URLs, credentials, content, and raw errors. Parsed REST debug
messages are optional telemetry and must not drive control flow.

### Database access

Keep database queries out of Discord handlers and independent product rules.

Group related persistence operations so that:

- transaction boundaries are visible,
- constraints are intentional,
- tests can exercise database behavior,
- schema changes remain traceable to product requirements.

A formal repository interface is not mandatory for every table or feature.

Introduce one only when it provides a useful application or testing boundary.

### Job execution

A persistent job worker must:

1. load the persistent action state,
2. verify that the action is still active,
3. load the current target state,
4. revalidate relevant permissions,
5. execute the action,
6. persist the result,
7. record audit and failure information.

Workers must not assume that a job is delivered or attempted only once.

## State ownership

Discord is authoritative for:

- whether a Discord resource currently exists,
- the current thread title,
- the current archived and locked values,
- current Discord permissions,
- whether a Discord message currently exists.

PostgreSQL is authoritative for:

- WEFT guild configuration,
- WEFT management policies,
- intended scheduled actions,
- managed-message metadata,
- audit history,
- retry and failure state,
- WEFT's last-known management state.

WEFT must reconcile these categories rather than assuming that either system contains the complete truth.

Stored state must not be used to overwrite legitimate manual Discord changes unless an approved active policy explicitly requires enforcement.

## Data conventions

- Represent Discord snowflake IDs as strings in TypeScript.
- Store Discord snowflake IDs as `TEXT` or an equivalent lossless string representation in PostgreSQL.
- Never represent a Discord snowflake as a JavaScript `number`.
- Store absolute timestamps with PostgreSQL `TIMESTAMPTZ`.
- Store scheduling timezones as IANA timezone identifiers.
- Use database transactions where multiple database changes must succeed or fail together.
- Use uniqueness constraints, optimistic revisions, or equivalent controls where concurrent operations can conflict.
- Validate persisted structured payloads at application boundaries.
- Do not create the complete future database schema before the corresponding behavior is implemented.
- Add schema fields and tables in response to approved use cases, constraints, and query requirements.

## Scheduling architecture

Use pg-boss for persistent job execution.

Do not implement persistent scheduling with in-memory `setTimeout` calls.

pg-boss owns its PostgreSQL connection pool and its internal `pgboss` schema. It uses the validated
application database configuration, but it does not share WEFT's application pool. pg-boss creates
and migrates its internal schema during startup. WEFT-owned tables remain managed through the
explicit Drizzle migration workflow and are not migrated automatically during application startup.

The initial scheduled action categories are:

- `CLOSE_THREAD`
- `SEND_MESSAGE`

Automatic inactivity closing uses a periodic database-driven sweep rather than one delayed job per message.

Workers must assume that a job can be delivered or attempted more than once.

Each worker must therefore perform appropriate state and idempotency checks.

Discord API effects and PostgreSQL updates cannot be committed as one transaction.

The scheduling implementation must reduce duplicate external effects, but it must not claim strict exactly-once delivery.

Scheduled thread-close delivery is reconciled in two distinct modes. Startup recovery may release
interrupted executions and remove stale active delivery left by a fully terminated previous
process. During normal operation, a fixed-delay loop scans only active scheduled thread closes and
repairs missing pg-boss delivery without changing application lifecycle state or cancelling active
jobs. The startup active-action pass is the initial reconciliation; periodic reconciliation begins
60 seconds after runtime startup and waits 60 seconds after each completed sweep before starting the
next one.

The implemented scheduled thread-close delivery queue uses:

- queue policy: `exclusive`
- retry limit: `3`
- retry delay: `30` seconds
- retry backoff: enabled
- retry delay maximum: `900` seconds
- expiration: `86399` seconds

These values describe the scheduled thread-close delivery queue only. They are not defaults for
other scheduled-action categories. The implemented `weft-send-message` queue uses `exclusive`
policy, a retry limit of 3, a retry delay of 30 seconds, exponential backoff, a maximum retry delay
of 900 seconds, and a 900-second expiration.

pg-boss retries each delivery for a finite cycle. If that cycle is exhausted while the authoritative
application action remains active, a later runtime reconciliation sweep may create a new delivery
cycle. Retry exhaustion alone does not make the application action terminal. Delivery retry
exhaustion is reported through operational logging only: it never marks the scheduled action
`FAILED` and never records a scheduled-close execution audit. Runtime reconciliation remains
`ACTIVE`-only and does not recover `EXECUTING` actions.

A scheduled thread close records its execution outcome in `scheduled_thread_close_audits`. Each
terminal execution transition and its execution audit commit in one PostgreSQL transaction, so a
scheduled-action state change is never persisted without its audit and an audit is never persisted
without its state change. A successful execution records `EXECUTION_COMPLETED` with a `SUCCESS`
outcome; a retryable execution releases the action to `ACTIVE` and records `EXECUTION_RETRY` with
its concrete failure code; a permanent failure records `EXECUTION_FAILED` with its concrete failure
code. Startup recovery of an execution interrupted by a terminated process performs the same
audited release and records `EXECUTION_RETRY` with `EXECUTION_INTERRUPTED`. Claiming an action for
execution, a lost claim, a missing or non-active action, and an action-type mismatch complete no
execution transition and therefore write no execution audit.

Thread lifecycle audits and scheduled-close execution audits are separate records with separate
stable identifiers. Each identifier is generated before its state-changing operation and reused
when an ambiguous response requires read-only confirmation. Confirmation must match both the
expected scheduled-action state and the exact audit record for that operation's identifier; a
matching state alone is not a committed result, and an unconfirmed state-changing operation is
never retried blindly.

`/thread close-after` creates a one-time close for the current active, unlocked thread. Its required
`after` value is one relative duration using `m`, `h`, or `d`, from one minute through 365 days.
Creating another close while the current close is `ACTIVE` replaces it; an `EXECUTING` close is not
replaced. Schedule administration is serialized per guild and thread with a transaction-scoped
PostgreSQL advisory lock. The action change and its `CREATED` or `REPLACED` record in the dedicated
`scheduled_thread_close_audits` table commit atomically.

After commit, the command uses the existing scheduled-close delivery boundary. If enqueue delivery
cannot be confirmed, the committed action remains authoritative and the user receives a saved-but-
pending result; the existing runtime reconciliation loop repairs missing delivery. The command does
not cancel an older pg-boss delivery during replacement because workers reload the authoritative
application action before attempting execution.

`/thread cancel-close` idempotently cancels the current thread's `ACTIVE` scheduled close. It
requires the invoking user's current Manage Threads permission, but it does not require an active
or unlocked thread or the bot's mutation permission because it does not mutate Discord.
Cancellation and close creation/replacement share the same per-guild/thread PostgreSQL advisory-
lock domain. The `ACTIVE` to `CANCELLED` transition and its `CANCELLED` user audit commit atomically;
no matching active close is a successful no-op, while an `EXECUTING` close cannot be cancelled.

A valid manual `/thread close` cancels an `ACTIVE` scheduled close after the lifecycle's initial
resource, locked-state, user-permission, and bot-permission checks, but before managed-state or
Discord mutation work begins. A cancellation that cannot be confirmed stops the manual close.
Once committed, the cancellation is not restored if later lifecycle work is unchanged, pending, or
fails. WEFT does not directly cancel the stale pg-boss delivery; the existing worker reloads the
authoritative action and safely ignores `CANCELLED` state.

## Operational health

The focused health module owns only the Node HTTP listener, request admission and completion, and
one outstanding physical application PostgreSQL readiness query. It reads the application runtime's
lifecycle state and the Discord client's current readiness. It reuses the application's `SELECT 1`
connection verification boundary and does not own a separate pool or persistent health state.

The listener starts as `health_listener_start` before database verification. Its local-only port is
`HEALTH_PORT`, default `3000`, with the same strict port validation as `DATABASE_PORT`. GET liveness
answers without dependency work. GET readiness observes `READY`, current Discord readiness, and a
read-only database query with a 2,000 ms per-request wait budget. A timed-out query retains physical
ownership until settlement, so later requests cannot start a second unresolved query. No result is
cached and neither timeout nor rejection causes application recovery.

At shutdown, the runtime closes health probe admission synchronously and initiates listener close
alongside producer quiescence. It waits for active health requests and the physical query only after
the existing source and retained thread-lifecycle work barriers. Database close follows health
drain, all under the shared 30,000 ms deadline. Compose probes the container-local readiness route
every 30 seconds, allows 5 seconds per probe, marks unhealthy after three failures, and allows
60 seconds for startup. The health port has no host port mapping.

## Startup and shutdown

One application-specific runtime owner coordinates the process-local `STARTING`, `READY`,
`SHUTTING_DOWN`, and `STOPPED` states. It is deliberately not a generic lifecycle or dependency-
injection framework.

After configuration validation, Discord event handlers are wired behind the runtime's closed
ingress gate. The runtime starts the local health listener, verifies PostgreSQL with `SELECT 1`,
starts pg-boss, validates all queues, completes scheduled-thread-close, scheduled-message, and
recurring-message startup recovery, waits
for Discord `ClientReady`, registers all workers, schedules all periodic reconcilers, attempts the
best-effort automatic-close baseline repair, and starts the automatic-close timer. Only then does
one synchronous boundary enter `READY`; handlers consult that state directly before entering an
application service. `application_ready` is logged after the boundary. Command deployment remains
outside this path.

Each awaited startup step has a state checkpoint. A shutdown request during one step closes ingress
and prevents the next step, but does not close a dependency underneath the active step. The active
step receives the remaining shared shutdown budget, after which startup and shutdown converge on
the single cleanup operation. Partial-startup failure uses the same operation; the original startup
step and safe error name remain primary while cleanup failures are separate bounded events.

The ingress gate tracks admitted top-level Discord operations. Thread lifecycle separately tracks
the full logical operation when a raw mutation outlives a `PENDING` interaction result. Retained
ownership begins when the raw mutation starts and ends only after finalization, so the transition
from raw settlement to finalization cannot produce a false empty drain. A deferred auto-open that
was admitted before ingress closed remains attached to that bounded logical operation. Unrelated
post-close events cannot enter the service.

Shutdown has two phases. Quiesce synchronously closes ingress and health probe admission, starts
listener close, and initiates every automatic-close timer, scheduled-thread-close reconciler, scheduled-message reconciler, recurring-message
reconciler, scheduled-thread-close worker poller, scheduled-message worker poller, and recurring-
message worker poller stop before awaiting any drain. Drain first establishes a source barrier by
waiting for the active startup step, admitted handlers, active sweeps, and worker callbacks, because
each can transfer ownership to retained thread-lifecycle work. It then drains that stable retained-
work set. The original thread audit write stays retained through confirmed notification publication
even when the caller wait expires. Accepted audit-notification tasks drain after the source and
retained-work barriers while Discord and PostgreSQL remain available. After that, health requests
and any physical health probe drain. Then pg-boss stops and closes its own PostgreSQL resources,
Discord is destroyed, the application pool closes, and process listeners are removed. Cleanup operations are
idempotent.

The first shutdown request creates one 30,000 ms deadline. Every phase uses its remaining budget;
pg-boss receives the remaining time but the application timer remains final authority over its
minimum timeout behavior. Expiry emits only a sanitized `shutdown_timed_out`, selects status 1, and
forces termination without changing feature state. No database transaction or advisory lock spans
unrelated shutdown waits.

One disposable process-handler installation owns `SIGINT`, `SIGTERM`, `unhandledRejection`, and
`uncaughtException`. Normal signals join the shared shutdown and select status 0 only when cleanup
succeeds. The first fatal event synchronously selects status 1 and closes ingress before joining
shutdown. A second fatal event, or the shared deadline during fatal shutdown, forces immediate
status-1 termination. Fatal logging contains only the origin and a bounded error name; logger
failure uses a fixed stderr fallback.

## Error handling

Errors must be classified sufficiently to distinguish:

- validation failure,
- authorization failure,
- missing Discord resource,
- missing WEFT permission,
- transient Discord API failure,
- permanent Discord API failure,
- database failure,
- scheduling failure,
- configuration failure,
- concurrency conflict.

User-facing errors must not expose:

- internal stack traces,
- database implementation details,
- secrets,
- inaccessible channel names,
- inaccessible message content.

Application operations should expose failures in a form that Discord handlers can translate into appropriate user responses and logs.

Do not introduce an elaborate error hierarchy before concrete failure cases require it.

## Logging

Use structured Pino logs.

Include relevant metadata when available:

- event name,
- guild ID,
- Discord resource ID,
- actor user ID,
- scheduled-action ID,
- correlation ID,
- outcome,
- error classification.

Do not log message content by default.

Do not log:

- secrets,
- Discord tokens,
- database passwords,
- webhook URLs,
- complete credential-bearing connection strings,
- raw environment dumps.

Logs intended for operators and audit records intended to describe administrative actions are separate concerns.

## Testing strategy

Use Vitest.

Testing should include, when relevant:

- pure rule tests,
- application-operation tests,
- Discord boundary fakes or mocks,
- PostgreSQL integration tests,
- authorization and validation failures,
- idempotent repeated execution,
- concurrency conflicts,
- partial Discord failures,
- scheduled-action cancellation races,
- restart and overdue-job behavior.

Ordinary automated tests must not require:

- a live Discord bot,
- a production Discord guild,
- production credentials,
- the real `.env` file.

Use a real PostgreSQL test instance when correctness depends on:

- PostgreSQL constraints,
- transactions,
- locking,
- query semantics,
- migrations,
- pg-boss behavior.

Do not mock PostgreSQL when the test is specifically intended to verify PostgreSQL behavior.

The exact test-database mechanism must be selected during project-foundation implementation.

## Production migration operations

Migration generation (`corepack pnpm db:generate`) is a development operation. The
`corepack pnpm db:migrate` command uses Drizzle Kit from a source checkout with development
dependencies. A production release instead contains the compiled one-shot `dist/migrate.js` entry
point and its committed `drizzle/` SQL and journal. It needs only `DATABASE_HOST`, `DATABASE_PORT`,
`DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, and optionally `DATABASE_SSL` (default
`false`). It does not load `.env` or require Discord, health, or logging settings.

For an initial deployment:

1. Prepare the production environment and obtain or build the WEFT release image.
2. Make PostgreSQL available. With Compose, start the database using `docker compose up -d postgres`.
3. Run exactly one WEFT migration process against the database:

   ```sh
   docker compose run --rm app node dist/migrate.js
   ```

4. Confirm the command exits successfully before starting WEFT with `docker compose up -d app`.
5. Check `/health/ready`. Deploy Discord commands separately where required.

For an upgrade:

1. Obtain or build the new WEFT release and review its migration requirements.
2. Stop the currently running WEFT application. Keep PostgreSQL available.
3. Run the new release's explicit production migration command shown above.
4. Confirm migration success. If migration fails, do not start the new application.
5. Start the new WEFT application and check `/health/ready`.
6. Deploy Discord commands separately where required.

The migration command never starts the Discord application or pg-boss.

Run at most one WEFT production migration process against a database at a time. Do not start
concurrent migration runners for the same database. The installed Drizzle migrator has no
concurrency lock for this operation.

Committed and applied WEFT migration history is append-only. Never rewrite applied migration SQL,
journal entry ordering, or journal timestamps (`when`). Append a new migration for each schema
change. The installed migrator records SQL hashes but does not validate applied hashes against
later file changes; editing history can therefore escape detection. The release's `drizzle/`
folder must stay coupled to its application image.

Normal `docker compose up` runs `node dist/index.js` and does not apply WEFT migrations. pg-boss
creates or updates only its own internal `pgboss` schema during normal pg-boss startup.

## Production backup and restore operations

This procedure runs from the source checkout root against the intended Compose project. It supports
PostgreSQL 18 and one format: a complete, single-database `pg_dump --format=custom` logical archive.
The provided `postgres:18-bookworm` container supplies the client utilities; no host PostgreSQL
client is required. A live copy of the `postgres-data` volume and a plain SQL dump are not supported
backup procedures. PostgreSQL major-version upgrades and downgrades are outside this procedure.

For a running deployment, gracefully stop WEFT before backup or restore while PostgreSQL remains
running. Use the 45-second Compose stop grace period to cover WEFT's shared 30-second shutdown
deadline:

```sh
stop_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
docker compose stop -t 45 app
docker compose ps -a app
docker compose ps postgres
docker compose logs --since "$stop_started_at" --no-color app | grep 'shutdown_completed'
```

Confirm that the app process exited with status 0, that `shutdown_completed` belongs to this stop,
and that PostgreSQL is still running. A successful `docker compose stop` alone does not prove
graceful completion. If the app was already stopped, confirm its last relevant exit and shutdown
log instead; if either cannot be established, investigate before proceeding. Keep the app stopped
through backup creation and inspection, or through restore and its checks. A restore target where
WEFT has never started follows the separate preflight below.

### Backup and archive inspection

After the stop check, create the backup from the source deployment:

```sh
(
  set -e
  umask 077
  backup_dir="$HOME/weft-backups"
  mkdir -p -- "$backup_dir"
  chmod 700 -- "$backup_dir"
  partial_file=$(mktemp "$backup_dir/weft-$(date -u +%Y%m%dT%H%M%SZ)-pg18.XXXXXX.partial")
  archive_file="${partial_file%.partial}.dump"
  docker compose exec -T postgres sh -c 'exec pg_dump --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$partial_file"
  docker compose exec -T postgres pg_restore --list < "$partial_file" > /dev/null
  mv -- "$partial_file" "$archive_file"
  printf '%s\n' "$archive_file"
)
```

`-T` disables TTY allocation so binary archive bytes are not altered. `pg_dump` stdout goes to the
host archive; its stderr stays separate. The private `.partial` file is promoted only after dump
and archive listing succeed. `umask 077` and the private directory restrict access. `--no-password`
fails instead of opening an interactive password prompt when authentication is unavailable. A
failed backup does not change the database. Never treat a leftover `.partial` file as a valid
backup; diagnose the failure, then retry with WEFT stopped or restart the same WEFT release.

For a saved archive, set `backup_file` to its absolute path and inspect its table of contents:

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
```

Check for `public` and `drizzle` entries, and `pgboss` entries if that schema existed at backup
time. Listing the table of contents is a lightweight archive check, not proof that every archive
item can be restored. An actual restore drill is required to test restoreability. Archive listing
also does not establish that an untrusted archive is safe.

Record the backup's UTC timestamp, source configured database name, PostgreSQL major version,
source WEFT release/image ID or Git revision, and intended restore target release in the operator's
existing records. Keep this context with the archive without inventing a new manifest format.

After the archive is promoted and its context recorded, restart the **same WEFT release** with
`docker compose up -d app`. Run the container-local `/health/ready` command under
[Verify the database, migrate, then start WEFT](#verify-the-database-migrate-then-start-weft)
and require HTTP 200 (command exit status 0). Backup does not change database state, so it does
not require a WEFT migration.

### Restore preflight and clean restore

Restore only an archive from a trusted source. Identify the correct Compose project, configured
target database and role, source WEFT release, and target WEFT release. A backup from a newer WEFT
release must not be restored for an older application release; downgrades are unsupported. Review
external Discord effects since the backup before choosing to restore (see below).

From the target checkout, before any destructive command:

```sh
backup_file='/absolute/private/path/to/weft-backup.dump'
test -s "$backup_file"
docker compose exec -T postgres pg_restore --list < "$backup_file"
docker compose ps -a app
docker compose ps postgres
docker compose exec -T postgres sh -c 'printf "target database: %s; role: %s\n" "$POSTGRES_DB" "$POSTGRES_USER"'
```

Check every command's result. Confirm the trusted, nonempty archive lists successfully; its source
and target release context is known; the Compose project, database, and role are correct; and
PostgreSQL remains running. Then establish **one** of these app states before destructive restore:

- **Previously running or started on this target:** If running, execute the stop block above,
  including `docker compose stop -t 45 app`. Confirm the app is no longer running, exited with
  status 0, and logged `shutdown_completed` for **that** stop while PostgreSQL stayed running. If
  already stopped, confirm its actual last stop and matching completion log. An arbitrary older
  `shutdown_completed` does not confirm this operation.
- **Never started on this target:** Confirm that no WEFT app container or process is running against
  this database. `docker compose ps -a app` may show no container at all. No prior exit status or
  `shutdown_completed` log is expected. Do not start WEFT merely to create a shutdown log before
  restore.

An unexpected crash, forced termination, or unknown shutdown history is not the never-started
case. Investigate its state before restoring; absence of a running process alone is insufficient.
Do not proceed if any archive, target identity, PostgreSQL, or applicable app-state check is
uncertain.

The following block destroys and recreates the configured target database. Run it only after the
preflight succeeds. Stop at the first failure; do not start WEFT with a missing or partial database.

```sh
(
  set -e
  docker compose exec -T postgres sh -c 'exec dropdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec createdb --no-password -U "$POSTGRES_USER" --maintenance-db=postgres --template=template0 --owner="$POSTGRES_USER" "$POSTGRES_DB"'
  docker compose exec -T postgres sh -c 'exec pg_restore --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --no-privileges --single-transaction' < "$backup_file"
)
```

This clean recreation restores into the configured `POSTGRES_DB` / `DATABASE_NAME`, rather than
the source database name embedded in the archive. Do not merge archive objects into an existing
database or use `pg_restore --clean --create`: with `--create`, `-d` names the management database,
while the archive determines the actual restored database name. `dropdb` does not force-disconnect
other sessions. If connections remain, let it fail and investigate; do not add `--force`.

`--no-owner` skips restoration of source role ownership, so the restore user owns the objects it
creates. `--no-privileges` skips source `GRANT` and `REVOKE` entries. This fits the provided
single-user Compose deployment, where the configured PostgreSQL user can use the restored objects.
A single-database archive does not contain cluster-global role definitions. Backup requires read
access to the source database and objects. Clean restore requires target database ownership or
equivalent administrative ability to drop it, `CREATEDB`-equivalent ability, and permission to
create the restored schemas and objects. Normal pg-boss startup still needs `CREATE` capability on
the configured database. An external PostgreSQL deployment needs equivalent database-level
administrative capability and ownership preparation; restricted users may not be able to run these
commands.

`--single-transaction` makes the restore atomic within the newly created database and, in
PostgreSQL 18, implies `--exit-on-error`. A restore error makes the command exit nonzero. Do not
continue to migration or application startup after any failed command; investigate the cause.
The transaction does not undo the preceding database drop and creation. For a large database, the
long-running transaction can impose lock and resource costs.

### Verify the database, migrate, then start WEFT

After successful restore, run this database-level check before migration:

```sh
docker compose exec -T postgres sh -c 'exec psql -X -v ON_ERROR_STOP=1 --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
select current_database(), current_user;
select count(*) as guild_settings_rows from public.guild_settings;
select count(*) as drizzle_migration_rows from drizzle.__drizzle_migrations;
select to_regclass('pgboss.version') as pgboss_version_table;
SQL
```

`ON_ERROR_STOP=1` makes any failed SQL statement fail the command. Check the database and role,
representative WEFT rows against values recorded before backup when available, and the Drizzle
history without assuming a fixed migration count. If `pgboss` existed at backup time, expect
`pgboss.version` and, when useful, inspect it with
`select count(*) from pgboss.version;`. The complete database archive includes its existing
schema and state. Do not clear or recreate pg-boss state or manage it with Drizzle.

Before app startup, run the target release's explicit WEFT migrations, even when restoring to the
same release:

```sh
docker compose run --rm app node dist/migrate.js
```

For the same release this should be a successful no-op. A newer target release applies its
committed pending migrations to the restored database. Confirm migration success and rerun the
database-level check above to inspect the resulting target schema. Run only one migration process.
The migration command does not connect to Discord or start pg-boss. Normal pg-boss startup later
owns its own internal migration and compatibility behavior.

Only after restore, database verification, and target-release migration all succeed:

```sh
docker compose up -d app
docker compose exec -T app node -e "fetch('http://127.0.0.1:' + process.env.HEALTH_PORT + '/health/ready').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
```

Then review normal startup recovery, reconciliation, and failure logs. Readiness confirms current
application conditions, not Discord-state consistency.

### Discord-state boundary and artifact handling

Restore moves PostgreSQL state back to the backup time; it does not roll back Discord or create an
atomic PostgreSQL-plus-Discord snapshot. A message may already have been sent, a thread closed,
opened, or renamed, a message deleted, permissions changed, or a channel deleted after the backup.
In particular, a one-time or recurring scheduled message sent after the backup can become a
delivery candidate again when an older database state is restored. Before restore, identify those
external effects and evaluate replay and duplicate-effect risk. Fresh Discord reads, permission
revalidation, reconciliation, idempotency checks, stable nonces, and conservative handling of
ambiguous outcomes reduce risk, but do not guarantee exactly-once recovery or prevent every
duplicate external effect. Restore does not undo external effects.

Treat the archive as production data. It can contain guild configuration, Discord identifiers,
managed-message metadata, scheduled and recurring message content, audit history, retry and
delivery state, and pg-boss internal state. Store it in a private directory with access control
equivalent to production data. Do not commit it to the repository or write it to application logs.

### Disposable restore drill

An archive table-of-contents check is insufficient. Periodically perform an actual clean restore
in an isolated, disposable PostgreSQL 18 Compose project with its own database volume, private
archive location, and credentials created solely for the drill. Use only disposable data and never
point the drill at the normal development or production database. Do not start the Discord app.

1. Create a uniquely named Compose project and a private, drill-only environment file for the
   existing Compose settings. Confirm its project name, database, and role before any drop. Start
   only PostgreSQL with `docker compose up -d postgres` in that project.
2. Apply the explicit migration command shown above. Seed recognizable WEFT-owned data and, when
   testing pg-boss recovery, initialize
   pg-boss using its own library without starting Discord. Record representative row counts.
3. With the app stopped, run the backup block above using that project's Compose invocation. List
   the resulting archive and note whether its table of contents contains `pgboss`.
4. Run the clean drop/create/restore block above against that same disposable project and archive.
   Compare WEFT-owned data, Drizzle history, pg-boss state when present, and object ownership and
   usability by the configured role. Run the same-release migration command again and confirm it
   succeeds without applying new migrations. Start and stop pg-boss through its library to check
   that its restored internal state remains usable; do not start Discord.
5. Exercise a restore failure with an invalid archive and confirm a nonzero exit without starting
   the app. Remove the unique drill project and its volume, private archive, and temporary
   credentials after recording the results.

Use the same backup and restore commands as production, substituting only the isolated Compose
project invocation and private backup path. An actual restore drill establishes more than archive
inspection, but still cannot prove future application readiness or Discord-state consistency.

## Runtime dependency and license review

Repeat this review before a release and after a lockfile update. Review the locked versions
and the packages actually distributed after `pnpm prune --prod`, including optional packages
and duplicate versions. Do not infer the production closure from direct dependencies alone.
Review each direct runtime dependency's current production use, Node.js compatibility,
deprecation/support status, and upstream release information before changing it.

### Production dependency closure

From the source checkout root, build the existing pruned build stage and the final runtime image
without application secrets or an environment file:

```sh
docker build --target build -t weft:dependency-review-build .
docker build -t weft:dependency-review .
docker run --rm --entrypoint corepack weft:dependency-review-build pnpm --version
docker run --rm --entrypoint corepack weft:dependency-review-build pnpm list --prod --depth Infinity --json
docker run --rm --entrypoint corepack weft:dependency-review-build pnpm licenses list --prod --json
```

The build stage has Corepack enabled and retains the lockfile; these commands were verified with
the pinned pnpm 11.20.0. Use the build stage for package-manager inspection, then cross-check
against the final image's physical package directories. Do not add development tools to the
runtime image to perform the review. Source-checkout command deployment uses development tooling;
the compiled migration runner uses production dependencies.

The following final-image inspection lists each physically installed package and its root license
material candidates. A README is only sufficient when it contains the required complete notice;
a license name or link alone is not a license text. Inspect candidate contents and any additional
license/NOTICE files below each package root before concluding that material is complete.

```sh
docker run --rm -i --entrypoint node weft:dependency-review --input-type=module <<'JS'
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const packages = [];
const store = '/app/node_modules/.pnpm';
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'node_modules') continue;
  const modules = join(store, entry.name, 'node_modules');
  for (const child of readdirSync(modules, { withFileTypes: true })) {
    if (!child.isDirectory()) continue;
    const roots = child.name.startsWith('@')
      ? readdirSync(join(modules, child.name), { withFileTypes: true })
          .filter(item => item.isDirectory())
          .map(item => join(modules, child.name, item.name))
      : [join(modules, child.name)];
    for (const root of roots) {
      const metadata = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
      packages.push({
        name: metadata.name,
        version: metadata.version,
        license: metadata.license ?? 'UNKNOWN',
        root,
        candidates: readdirSync(root).filter(name => /license|copying|notice|readme/i.test(name)),
      });
    }
  }
}
packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
console.log(JSON.stringify(packages, null, 2));
console.log(JSON.stringify({
  packageVersions: new Set(packages.map(item => `${item.name}@${item.version}`)).size,
  packageNames: new Set(packages.map(item => item.name)).size,
}));
JS
```

The 2026-09-30 Issue #85 review found 63 package versions across 61 names. Counts are a dated
cross-check, not a permanent requirement. Investigate discrepancies against the current lockfile
and prune result. Check for unintended development-only tools; legitimate transitive packages
must still be included in the inventory. Resolve UNKNOWN, UNLICENSED, custom/non-SPDX, copyleft,
`SEE LICENSE IN ...`, and multiple-license expressions from authoritative upstream evidence.

### Production security audit

Run the production audit against that same lockfile and record its exit status and every advisory:

```sh
docker run --rm --entrypoint corepack weft:dependency-review-build pnpm audit --prod
```

This is the container equivalent of `corepack pnpm audit --prod` from a configured source checkout.
Audit data changes over time. An audit with findings is not a passing or clean audit. Investigate
new findings; an unresolved Critical or High finding blocks release unless a technically justified
exception covers the current execution path. Do not suppress findings with audit ignore settings,
severity filtering, overrides, or package patches.

### Current undici technical exception

Review date: **2026-09-30**. The locked runtime contains **undici 6.28.0**, **discord.js 14.27.0**,
**@discordjs/ws 1.2.3**, **@discordjs/util 1.2.0**, and **@discordjs/rest 2.6.3**. The final image's
observed Node.js version was **24.21.0**. The production audit reported the following three
advisories and exited with status **1**:

| Advisory                                                                 | Severity | Vulnerable facility                   |
| ------------------------------------------------------------------------ | -------- | ------------------------------------- |
| [GHSA-rfgv-xxqx-mfg5](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5) | High     | WebSocket unrequested subprotocol DoS |
| [GHSA-3wwx-pv8p-q78v](https://github.com/advisories/GHSA-3wwx-pv8p-q78v) | Moderate | WebSocket permessage-deflate DoS      |
| [GHSA-r53p-7pc4-xj5r](https://github.com/advisories/GHSA-r53p-7pc4-xj5r) | Low      | Retry interceptor response splitting  |

The advisories exist, and installed undici 6.28.0 is within their affected ranges. Undici 6.28.1
contains the fixes. Issue #85 retains the locked version under the following execution-path
exception; it does not declare the package unaffected or the audit clean:

- On the observed Node.js runtime, `@discordjs/util.shouldUseGlobalFetchAndWebSocket()` returns
  `false`. `@discordjs/ws` therefore uses `ws` for the Discord Gateway, without exercising Undici
  WebSocket or the global WebSocket implementation implicated by the two WebSocket advisories.
- `@discordjs/rest` uses the Undici HTTP request path. The response-splitting advisory requires
  Undici `interceptors.retry()`, which the current Discord.js and WEFT paths do not use. Discord.js
  REST retries and WEFT application retries are separate from this Undici interceptor.

Re-evaluate the exception whenever the lockfile, discord.js, @discordjs/ws, @discordjs/util, undici,
Node base image/runtime behavior, Gateway WebSocket implementation path, or Undici retry-interceptor
usage changes. Re-run the audit, inspect the installed transport implementation and WEFT callers,
and test the global-transport selector on the actual final Node runtime. The selector can be checked
without connecting to Discord:

```sh
docker run --rm --entrypoint node weft:dependency-review --input-type=module -e '
import { createRequire } from "node:module";
const appRequire = createRequire("/app/package.json");
const discordRequire = createRequire(appRequire.resolve("discord.js"));
console.log(process.version);
console.log(discordRequire("@discordjs/util").shouldUseGlobalFetchAndWebSocket());
'
```

### License material and Docker verification

Verify the final distribution, not only the source checkout:

- Preserve WEFT's root `LICENSE` and compare it with `/app/LICENSE` in the final image.
- Maintain `THIRD_PARTY_LICENSES.md` manually for missing runtime license text only. Update its
  package versions and version-specific authoritative source references together, and compare
  the included text exactly with upstream LICENSE/COPYING files, including copyright notices.
  Sapphire's identical MIT text is included once for its two listed packages. Drizzle's text is
  from its matching release tag. Re-check upstream and installed NOTICE files on updates; preserve
  relevant existing content and never invent a NOTICE.
- Compare `/app/THIRD_PARTY_LICENSES.md` with the repository document. Preserve existing package
  LICENSE, COPYING, `license-mit`, complete README notices, and relevant NOTICE material under
  `/app/node_modules/.pnpm`; the supplemental document does not replace those files.
- Keep `/usr/local/LICENSE` and the npm/Corepack license material supplied by the Node image.
  Preserve Debian `/usr/share/doc/*/copyright`. Node and Debian license material stays in the base
  image; do not duplicate it into WEFT's npm license document or strip it from the image.

Inspect file contents and ownership inside the final image, and confirm the expected runtime
artifacts and non-root command:

```sh
docker run --rm --entrypoint sh weft:dependency-review -c '
test -f /app/LICENSE && test -f /app/THIRD_PARTY_LICENSES.md &&
test -f /app/package.json && test -d /app/dist && test -d /app/drizzle &&
test -d /app/node_modules && test -f /app/dist/migrate.js &&
test -f /usr/local/LICENSE &&
find /usr/share/doc -name copyright -type f -print
'
docker image inspect weft:dependency-review --format '{{.Config.User}} {{json .Config.Cmd}}'
docker run --rm --entrypoint node weft:dependency-review --input-type=module -e '
await import("./dist/migrate.js");
console.log("Migration runner module dependencies resolved without running migrations");
'
```

Require a successful image build, `USER node`, and `CMD ["node", "dist/index.js"]`. Verify that
top-level TypeScript, tsx, Vitest, ESLint, and Drizzle Kit tools were not added to the runtime image.
The import check resolves the compiled migration runner's modules without invoking its CLI or
accessing a database. Ordinary standard verification still applies. License documents and
Dockerfile license COPY changes alone require neither external PostgreSQL integration nor live
Discord verification; executable or dependency-classification changes require the normal gates.

## Standard verification

The project must provide these commands:

    pnpm lint
    pnpm typecheck
    pnpm test
    pnpm build

Infrastructure changes must also validate the Docker Compose configuration.

A task is not complete merely because code was generated.

Relevant checks must be run, and their results must be reviewed.

A failed or skipped check must be reported accurately.

## Source-of-truth order

Use the following order:

1. `docs/specification.md`
2. the accepted GitHub Issue and its acceptance criteria
3. automated tests
4. implementation

An Issue may narrow an implementation task, but it must not contradict the approved product specification without an explicit specification change.

Tests demonstrate intended and implemented behavior, but an outdated test does not override an approved specification.

If these sources conflict, identify the conflict before changing behavior.

## GitHub Issues

Use GitHub Issues for non-trivial:

- features,
- bugs,
- technical improvements,
- investigations,
- documentation work.

An Issue should normally define work that fits within one reviewable Pull Request.

Do not create an Issue for every:

- individual line,
- import,
- variable rename,
- formatting change,
- trivial mechanical edit.

Do not combine multiple independent features into one Issue merely to reduce the number of Issues.

A typical Issue should contain:

    ## Summary

    ## Specification references

    ## Scope

    ## Out of scope

    ## Acceptance criteria

    ## Verification

Repository initialization and trivial mechanical maintenance do not require an Issue when an Issue would provide no review or tracking value.

## Branches

Use short English branch names.

Examples:

- `docs/initial-specification`
- `chore/project-foundation`
- `feat/discord-bootstrap`
- `feat/guild-settings`
- `feat/thread-close`
- `feat/thread-open`
- `feat/scheduled-thread-close`
- `fix/duplicate-closed-prefix`

A branch should normally correspond to one Issue or one independently reviewable task.

## Commits

Follow the Conventional Commits policy in `AGENTS.md`.

A commit should contain one logical and independently understandable change.

Do not combine unrelated implementation, formatting, dependency, and documentation changes into one commit when separating them would materially improve reviewability.

Do not split every minor edit into its own commit when the edits form one logical change.

Formatting-only changes should use the `style` type only when runtime behavior does not change.

## Pull Requests

After the project foundation is stable, use Pull Requests for functional changes.

A Pull Request should include:

- a concise summary,
- the linked Issue when one exists,
- relevant specification references,
- implementation notes,
- verification results,
- known limitations or unresolved matters.

A Pull Request must not claim that tests passed unless the listed commands were actually executed successfully.

The maintainer must inspect the complete diff before merging.

## Codex workflow

For a non-trivial implementation task:

1. Create or select a GitHub Issue.
2. Create a task branch.
3. Start Codex from the repository root with appropriate permissions.
4. Ask Codex to read:
   - `AGENTS.md`,
   - `docs/specification.md`,
   - `docs/development.md`,
   - the relevant Issue.
5. Ask Codex to inspect the relevant files and produce a plan before editing.
6. Review the plan for:
   - scope,
   - architecture,
   - security,
   - licensing,
   - unnecessary abstractions,
   - unsupported assumptions.
7. Authorize implementation only within the defined scope.
8. Inspect `git status` and the complete `git diff`.
9. Run the relevant verification commands independently.
10. Ask Codex to correct identified defects.
11. Review the final diff.
12. Commit the logical change.
13. Open and review a Pull Request when the workflow requires one.

Treat Codex output as untrusted proposed code.

The human maintainer remains responsible for:

- product decisions,
- architecture,
- correctness,
- security,
- licensing,
- dependency choices,
- commits,
- merges,
- releases.

## Codex context management

Use one focused Codex session per task where practical.

Reference repository documents rather than repeatedly pasting the complete specification.

Limit exploration to relevant code unless broader investigation is justified.

Separate planning from implementation for non-trivial work.

Do not request vague repository-wide improvement work.

End or restart a session when unrelated context has accumulated enough to reduce clarity.

Do not omit necessary context merely to reduce usage.

Ambiguous tasks usually create more corrective work than precise tasks.

## Implementation order

### Phase 0: Repository and project foundation

- Add the initial repository documentation.
- Add `AGENTS.md`.
- Configure pnpm.
- Configure Node.js 24 LTS.
- Configure TypeScript with ECMAScript modules and strict mode.
- Configure linting and formatting.
- Configure Vitest.
- Configure Pino.
- Configure Zod environment validation.
- Add or update `.env.example` without reading `.env`.
- Add a Dockerfile.
- Add Docker Compose.
- Add the PostgreSQL development service.
- Configure Drizzle ORM and migrations.
- Add controlled startup and graceful shutdown.
- Provide passing `lint`, `typecheck`, `test`, and `build` commands.

The initial code structure must include only what this phase requires.

### Phase 1: Discord bootstrap

- Initialize the Discord client.
- Use only the required gateway intents.
- Add structured startup and shutdown logs.
- Implement graceful Discord-client destruction.
- Select and implement the command-registration strategy.
- Implement a minimal `/ping` command.
- Add tests that do not require a live Discord connection.

Reassess the code organization after this phase. Do not assume that the initial foundation structure is final.

### Phase 2: Guild configuration

- Implement the initial guild-settings schema.
- Add database migrations.
- Implement focused guild-settings persistence.
- Store the guild timezone and closed prefix.
- Implement default-settings creation.
- Require `ManageGuild` for configuration operations.
- Add PostgreSQL integration tests.

Introduce only the persistence boundaries justified by this use case.

### Phase 3: Immediate thread lifecycle

First vertical slice:

- Implement `/thread close`.
- Validate the supported thread context.
- Require `ManageThreads`.
- Validate WEFT's own permissions.
- Normalize and add the closed prefix.
- Archive the thread without changing its locked state.
- Reject already locked threads instead of modifying them.
- Persist managed state.
- Record audit data.
- Test idempotency, authorization, and partial failures.

Second vertical slice:

- Implement `/thread open`.
- Reconcile the thread after Discord unarchives it without changing its locked state.
- Remove one managed leading prefix.
- Persist managed state.
- Record audit data.
- Test idempotency, authorization, and partial failures.

Discord mutation handling must separate the caller wait budget from the lifetime of the raw
discord.js REST request. Exceeding the caller wait budget returns a pending result without
aborting the request. The per-thread mutation guard remains active through final settlement
and finalization handling, including managed-state and final-audit persistence. A successful raw
response confirms the mutation without an additional Discord fetch. A rejected raw mutation is
reconciled against current Discord state. Background reconciliation waits for each raw external
operation to settle before an actual rejection can start a backoff retry; observation deadlines
must not create overlapping attempts. Confirmed finalization persists the final managed state
and exactly one success or failure audit before the guard is released. The reconciliation read
classifies structured Unknown Channel at the channel stage and Unknown Guild at the guild stage as
confirmed unavailable; access and
authentication failures remain separate. Retryable or unclassified read failures keep the existing
backoff. A permanently rejected read with unknown Discord state stops the read loop and finalizes
one `FAILURE / DISCORD_RECONCILIATION_UNCONFIRMED` audit using the existing audit ID and PostgreSQL
audit-write retry semantics. This failure means WEFT could not confirm and complete the operation,
not that the raw mutation was proven unsuccessful. No managed-state write is derived from unknown
Discord state. The pre-mutation `CLOSED/appliedPrefix` row is management metadata, not proof of
current Discord archive state; later close attempts retain the stored-prefix selection rule. The
process-local guard releases only after the exact terminal audit is durably confirmed, and later
mutation paths still perform fresh Discord reads and permission checks. Normal discord.js
rate-limit queue waits are not failures or unknown outcomes solely because they exceed the caller
wait budget.

After both vertical slices, review whether the current physical structure still reflects the actual feature and infrastructure boundaries.

### Phase 4: Persistent scheduling foundation

- Integrate pg-boss.
- Implement scheduled-action persistence.
- Implement worker startup and shutdown.
- Define transient and permanent failure classification.
- Implement startup reconciliation.
- Implement runtime reconciliation of active scheduled-action delivery.
- Test cancellation and execution races.
- Test restart recovery.

Do not create scheduling abstractions for unsupported future action types.

### Phase 5: Scheduled thread closing

- Implement `/thread close-after`.
- Enforce one active scheduled close per guild and thread.
- Replace an existing scheduled close by default.
- Implement `/thread cancel-close`.
- Recover applicable overdue closes after restart.
- Record schedule and execution audit events.

### Phase 6: Automatic thread closing

- Implement managed parent-channel policies.
- Track qualifying message activity.
- Implement per-thread exclusions.
- Implement the five-minute database sweep.
- Re-fetch Discord state before closing.
- Implement `/thread track`, `/thread untrack`, and `/thread status` as required by the approved behavior.
- Add policy, idempotency, and reconciliation tests.

Automatic-close persistence keeps policy state separate from thread lifecycle state. The scalar
guild policy fields live in `guild_settings`. The parent-channel allowlist, per-thread exclusions,
and qualifying thread activity each have a dedicated table. The inactivity duration is persisted as
integer seconds rather than a PostgreSQL interval or a derived per-thread timestamp, so a guild
policy change does not rewrite stored activity.

Qualifying activity writes are monotonic: `last_activity_at` keeps the maximum observed value, so
an out-of-order Discord event cannot move activity backward. The invariant is applied inside one
PostgreSQL statement rather than an application-level read-modify-write.

Automatic-close participation does not require a `managed_threads` row. `managed_threads` remains
WEFT's thread lifecycle state and only exists for threads WEFT has already closed, so requiring it
would exclude exactly the threads inactivity management must be able to close.

Automatic-close configuration is split between the Discord interaction boundary and a focused
application boundary. The `/config` command handler performs routing, option extraction,
Discord-specific validation, and response formatting. A separate automatic-close configuration
service coordinates guild settings, automatic-close persistence, and an injected Discord
active-thread enumeration boundary. The persistence store never calls Discord and never depends on
the guild-settings store.

Enabling a parent channel reads the guild's currently active threads once through the guild-level
Discord active-thread route, filters them in application code by requested parent and supported
thread type, and only then performs the database work. The enable timestamp is captured after
successful enumeration and immediately before the database operation, so a slow Discord response
cannot shorten the resulting grace period. A failed enumeration leaves the parent disabled and
writes nothing. No PostgreSQL transaction is held across the Discord call.

The database portion of parent enablement is one transaction. The allowlist row is added only when
absent, and baselines are applied only when the parent was newly added. Baselines apply
`last_activity_at = max(existing, enabled_at)` for each supplied non-excluded thread, so an enable
never moves activity backward and a stale or equal baseline leaves `last_activity_at`,
`parent_channel_id`, and `updated_at` untouched. Individually excluded threads receive no baseline.
Removing a parent deletes only the allowlist row; activity rows are retained so that a later
re-enable preserves legitimately newer activity while advancing stale rows to the new floor.

Automatic-close activity tracking uses the `GuildMessages` gateway intent without the privileged
`MessageContent` intent. The message event boundary reads only metadata: guild, thread, parent
channel, supported thread type, the Discord message creation timestamp, whether the author is a
bot, and whether the message is a Discord system message. Message content is never read, passed on,
persisted, or logged. Events that Discord metadata alone can reject, such as non-guild, non-thread,
unsupported, parentless, and system messages, never reach PostgreSQL. The thread channel is
resolved from the client cache only; an unresolved channel is skipped rather than fetched, so the
high-volume message path performs no REST request.

A qualifying message evaluates its policy and writes its activity in one PostgreSQL statement. That
statement checks current parent allowlist membership, the absence of an individual exclusion, and
the guild bot-message activity policy, then applies `last_activity_at = max(existing, incoming)`.
A guild without a settings row falls back to the approved defaults, so a human message still
qualifies while a bot message does not. Message activity never calls the guild-settings store, uses
no application-level read-modify-write, and takes no advisory lock. Successful tracking is silent;
only persistence failures are logged, with safe identifiers and a safe error name.

`ThreadCreate` and startup reconciliation share a missing-only baseline operation. It creates an
activity row solely when the thread has none, and never advances an existing row's
`last_activity_at`, `parent_channel_id`, or `updated_at`. This is deliberately weaker than the
parent-enable activity floor. `ThreadCreate` uses the thread creation timestamp only for a thread
that is genuinely new and reports one; otherwise it uses the observation time, so a thread that
merely became visible does not inherit an old creation time.

Startup missing-baseline reconciliation runs after the Discord client is ready. It discovers
configured parents in one query, so a guild with no automatic-close configuration is never fetched
from Discord, and it reads each relevant guild's active threads once rather than once per thread.
Each guild's baseline timestamp is captured after that guild's enumeration succeeds, so a slow
Discord response cannot shorten another guild's grace period. A guild whose enumeration or batch
fails is skipped while the remaining guilds are still reconciled, and the whole reconciliation is
non-fatal: application startup continues and the missing baselines are recovered later by a
restart, `ThreadCreate`, or `MessageCreate`. No per-message job, timer, or periodic inactivity
sweep exists yet.

Automatic-close thread maintenance uses a focused application service for `/thread track`,
`/thread untrack`, and `/thread status`. The Discord command handler retains interaction routing,
the bounded initial/final response behavior, and plain-text response formatting. The service
coordinates supported-context validation, current actor authorization, automatic-close
persistence, and the two focused status reads without accepting discord.js interaction objects.

The maintenance Discord boundary fetches the requested channel once with a forced current-channel
read, verifies guild ownership, supported thread type, and a non-null parent, then reuses that
thread for the invoking member's current `ManageThreads` permission calculation. It requires no
bot permission and does not reject archived or locked supported threads. Discord validation
finishes before the track timestamp is captured and before any PostgreSQL transaction begins.

The track persistence operation removes the individual exclusion, reads current parent allowlist
membership, and performs any required baseline write in one transaction. When an exclusion was
removed under an enabled parent, the activity write applies the track time as a monotonic floor.
An advanced row stores the track time in `last_activity_at` and the persistence write time in
`updated_at`; an equal or newer row is a complete no-op. When no exclusion existed, the operation
may insert a missing baseline under an enabled parent but never updates an existing row. This
missing-only repair prevents repeated track commands from extending inactivity deadlines. A
disabled parent permits exclusion removal but causes no activity write.

Untrack reuses the existing idempotent exclusion insert and never deletes or updates activity. It
does not require parent allowlist membership. Track and untrack are independent of explicit
scheduled closes and never call scheduled-action mutation or delivery boundaries.

Status uses one read-only automatic-close query for parent membership, exclusion state, inactivity
duration, and stored activity. A missing guild-settings row is represented by the approved default
without being created. A separate focused read on the scheduled-action envelope returns only the
current `ACTIVE` or `EXECUTING` `CLOSE_THREAD`; `scheduled_actions` owns that current-state
envelope, so the scheduled-close mutation/audit store is unchanged. The independent reads may run
concurrently and neither repairs state.

Phase 6C uses the existing schema and adds no migration, table, column, constraint, or index. It
does not implement the Phase 6D inactivity sweep or automatic-close execution path.

Phase 6D-1 adds database-only automatic-close candidate discovery to the existing automatic-close
persistence store. Activity rows are the driving source. One read-only PostgreSQL statement joins
each row to the matching current parent allowlist entry, left joins current guild settings, rejects
a matching guild/thread exclusion with `NOT EXISTS`, and applies the inclusive inactivity
threshold. Missing guild settings use the approved 604800-second default without creating a row.
Candidate discovery does not inspect `managed_threads`, scheduled actions, or the bot-message
policy because qualifying activity has already been classified when recorded.

Candidate pages use a fixed size of 100 and deterministic keyset ordering by
`last_activity_at ASC`, `guild_id ASC`, then `thread_id ASC`. The cursor contains that complete
tuple and selects only rows strictly after it; OFFSET pagination is not used. A future sweep will
capture one `asOf` timestamp and supply that same value to every page, so page duration does not
change the inactivity boundary. The query never uses PostgreSQL `now()` as the sweep authority.

Candidate selection is provisional and creates no claim or lock. Activity can move forward and
parent or exclusion policy can change while pages are read; a later execution slice must revalidate
policy and fresh Discord state immediately before acting. Phase 6D-1 performs no Discord access or
mutation, writes no audit, and starts no runtime sweep or timer. The activity table has one
candidate-pagination index on `last_activity_at`, `guild_id`, and `thread_id`; no other index or
runtime dependency is added by this slice.

Phase 6D-2 adds a focused executor for one provisional candidate without adding the periodic sweep.
It first performs one forced current Discord channel fetch through an execution-specific boundary.
A supported thread yields only its current parent and archived state. A null, confirmed Discord
Unknown Channel response, unsupported resource, guild mismatch, or parentless resource is confirmed
unavailable; transport, rate-limit, server, permission, and opaque failures remain retryable. An
already archived, confirmed unavailable, or parent-mismatched episode skips lifecycle execution and
is retired. Parent mismatch never rewrites activity merely to make the old candidate executable.

After Discord inspection, the executor captures a new revalidation timestamp and performs one
read-only PostgreSQL eligibility query. The query requires the exact guild, thread,
`last_activity_at`, and fresh parent; current parent allowlist membership; no current exclusion;
the inclusive current inactivity threshold; and no retirement matching the current episode. It
uses the seven-day missing-settings default without inserting settings and never uses PostgreSQL
`now()` as the execution timestamp. False eligibility is a safe skip without retirement.

Immediately after successful candidate revalidation, the executor reads the current explicit
scheduled close. An `ACTIVE` or `EXECUTING` close takes precedence, causing a safe skip without
claiming, cancelling, transitioning, or auditing the scheduled action. Terminal history is absent
from this focused current-state read and does not block automatic close. No scheduled-action lock is
held across Discord work; a schedule created after this read may race with lifecycle execution.

Automatic close enters the existing lifecycle queue through a distinct system entry point. The
shared close implementation still owns fresh supported-thread reads, locked-state and bot
permission checks, guild prefix selection, managed CLOSED persistence, Discord mutation
classification and reconciliation, and final lifecycle audit. Close finalization uses an explicit
`CLOSE`/`AUTO_CLOSE` type guard so both operations remain on the CLOSED branch. Manual close remains
`CLOSE` with a user actor, scheduled system close remains `CLOSE` with a system actor, and automatic
close records `AUTO_CLOSE` with a system actor.

An automatic-close retirement stores the latest retired `last_activity_at` for one guild/thread.
Its conflict write advances only to a newer timestamp; equal and stale writes are complete no-ops
without `updated_at` churn. Candidate discovery and final revalidation reject a retirement only
when it exactly matches the current activity timestamp, so a newer qualifying activity episode is
eligible naturally. A successful lifecycle close is retired afterward. Retirement failure does not
undo the close and is retryable; the next attempt observes the archived thread and retries only the
retirement path. Lifecycle attempt failure never retires the episode because its condition may
change before a later sweep.

The automatic-close activity handler independently observes raw gateway `THREAD_UPDATE` dispatches
before discord.js mutates its channel cache. A cached archived-to-active transition, including a
locked thread, establishes a re-entry baseline. An active supported thread missing from cache does
the same because Discord may deliver an unarchive without that archived thread already in memory;
a cached active-to-active metadata update does not reset inactivity. The handler records the
observation time only when the current parent remains allowlisted and the thread is not excluded.
Policy evaluation and `last_activity_at = max(existing, reopened_at)` occur in one PostgreSQL
statement; an equal or stale observation changes neither parent nor timestamps. This path does not
consult the bot-message policy, perform a REST fallback, remove exclusions, enable parents, or
delete retirement. Re-entry and nearby message writes may arrive in either order because both
persistence operations are monotonic. Lifecycle auto-open remains a separate high-level
`ThreadUpdate` listener with independent bounded failure handling.

Migration 0008 adds only the automatic-close retirement table and permits `AUTO_CLOSE` in the
thread lifecycle audit action constraint. Phase 6D-2 adds no five-minute loop, startup execution
sweep, page-iteration runtime, pg-boss queue, or delayed automatic-close job. Phase 6D-3 owns that
runtime orchestration. The remaining change-after-revalidation PostgreSQL/Discord race is accepted
and documented rather than hidden behind a database lock held across Discord work.

Phase 6D-3 adds a focused automatic-close runtime controller. It uses a fixed-delay `setTimeout`:
the first sweep begins five minutes after startup, and each later timer is created only after the
owner sweep settles. A manual sweep cancels a pending periodic timer and owns the next full delay;
callers that join an existing sweep share its exact promise and do not acquire timer ownership.
This process-local single-flight behavior prevents overlap without introducing a PostgreSQL lock,
claim, lease, or high-availability coordination.

Each sweep captures one `asOf` timestamp and reuses it while reading candidate pages to exhaustion
with the persistence boundary's existing keyset cursor. Candidates execute sequentially through
the Phase 6D-2 executor. Bounded executor failures and unexpected executor rejections are counted,
logged without raw errors, and isolated so later candidates still run. A candidate-page read
failure ends only the current sweep; the next periodic sweep starts from an empty cursor with a new
timestamp after the full delay. Aggregate logging reports non-empty sweep statistics without
emitting per-candidate success or safe-skip logs.

Startup attempts missing-baseline reconciliation after Discord and scheduled-close runtime startup,
then starts the automatic-close runtime even when that best-effort baseline attempt failed. Runtime
startup failure remains fatal. Shutdown stops automatic-close scheduling first, clears its pending
timer, and drains an in-flight page read or candidate execution before scheduled workers, Discord,
or PostgreSQL are stopped. Stopping checks between page reads and candidates prevent new work after
shutdown begins. Automatic close remains a database-driven scan and has no pg-boss queue or delayed
job per thread, message, or candidate.

### Phase 7: Managed messages

Phase 7A implements `/message send` as one focused vertical slice. The chat-input handler performs
only cheap guild, current-target, active-thread, and interaction permission checks before opening a
static modal. A focused modal-submit route handles only `managed-message:send`, validates the
plain-text content, acknowledges ephemerally, and invokes the managed-message application service.
Unrelated modal IDs remain available to other handlers.

The application service generates one 16-byte base64url nonce for the send and coordinates a
focused Discord boundary with the managed-message persistence store. The Discord boundary
force-fetches the current channel, refreshes the actor and bot members, revalidates
`ManageMessages`, checks the bot's effective send permissions, and also requires a current thread
to be active and `sendable`. It never joins or unarchives a thread. The actual send payload includes
`allowedMentions: { parse: [] }`, the stable nonce, and `enforceNonce: true`. No application resend
loop is used.

Discord send must precede PostgreSQL persistence because the resulting Discord message ID and
creation timestamp are required managed state. Migration 0009 adds `managed_messages`, keyed by
the Discord message ID, with creator, exact content, revision 1, `ACTIVE` status, the Discord
creation timestamp, and a database-owned update timestamp. If the insert rejects, the store does
not retry the write: it reads by message ID and confirms the exact expected state. A missing,
conflicting, or unreadable confirmation causes one compensation delete of only the confirmed sent
message. An unconfirmed compensation is reported as a partial failure with the known message ID.
Discord and PostgreSQL remain non-atomic.

Phase 7A needs neither `MessageContent` nor `GuildMembers` gateway intent. Message editing,
revision mutation and conflict handling, managed-message creation/edit audit completion, and
manual Discord deletion detection remain deferred to later Phase 7 work.

Phase 7B implements `/message edit` without adding a gateway intent or event listener. The command
accepts a strict decimal Discord message ID or an exact canonical `discord.com` message link and
restricts either form to the current guild and channel. Modal opening performs the cheap current
interaction checks and one focused managed-message read, then prefills persisted content in a modal
whose custom ID contains only the message ID and expected revision.

Edit submission validates the owned custom ID and content before acknowledging ephemerally. Slow
work begins only after acknowledgement. A process-local per-message FIFO serializes the complete
pipeline for the same message while allowing different message IDs to proceed independently. The
FIFO is not a distributed lock; the conditional PostgreSQL revision transition remains the
authoritative concurrency boundary.

Inside the FIFO, the service freshly reads managed state and rejects a missing, deleted, mismatched,
or stale-revision target before Discord work. The Discord boundary then force-fetches the current
channel, refreshes the actor and bot members, revalidates `ManageMessages` and bot access, and
force-fetches the exact message without using a cached message. It requires the message to be
WEFT-authored and currently editable. An archived thread is rejected, and locked-thread behavior
uses discord.js editability semantics. Editing an existing bot-authored message does not require
send permissions.

Discord content must equal persisted managed content before either no-op detection or mutation.
Consequently, submitted content equal to persisted content does not bypass current permission,
existence, authorship, editability, or coherence checks. A mismatch returns a bounded failure and
does not repair Discord or PostgreSQL. An actual edit uses `allowedMentions: { parse: [] }` and no
application retry. An ambiguous PATCH receives at most one fresh fetch: exact new content with an
advanced edit timestamp confirms application, exact old content with the unchanged timestamp
confirms non-application, and every other result remains unconfirmed.

Migration 0010 expands managed-message status to exactly `ACTIVE` and `DELETED` and adds the
dedicated relational `managed_message_audits` table for `CREATED`, `EDITED`, and
`DELETION_DETECTED`. New sends now persist the managed row and `CREATED` audit in one transaction;
the migration does not fabricate creation audits for Phase 7A rows. A confirmed edit conditionally
updates `ACTIVE` state at the expected revision and old content and inserts its `EDITED` audit in
the same transaction. Confirmed Discord Unknown Message changes `ACTIVE` to `DELETED` and inserts a
system deletion-detection audit atomically while preserving content and revision.

Every state-changing persistence attempt uses one stable audit ID. A rejected or ambiguous create,
edit, or deletion transaction is confirmed read-only only when both the exact intended row state
and exact audit are present. After a confirmed Discord edit whose database finalization cannot be
confirmed, compensation is attempted only when a fresh database read still shows the exact old
active revision and content with no intended audit. A second fresh Discord read must still show the
exact new content and confirmed edit timestamp before one restore PATCH, also with mention
suppression. Newer, changed, deleted, unavailable, or otherwise ambiguous state is never restored
and returns a bounded partial failure.

Phase 7B adds no `MessageDelete` listener, `MessageContent` intent, scheduled-message worker,
distributed lock, embed authoring, or generic audit/modal framework.

Phase 7C adds one canonical `ManagedMessagePayload` representation in
`managed-message-payload.ts`: exact plain content plus either one normalized supported embed or no
embed. The shared send/edit validator preserves accepted plain content, counts it by Unicode code
point, outer-trims embed text, applies builder-compatible UTF-16 limits, normalizes exact six-digit
hex colors, and performs syntax-only WHATWG normalization of absolute HTTP/HTTPS image URLs. Empty
payloads, whitespace-only non-empty content, and color-only embeds are rejected.

Both send and edit use one five-field modal for content, embed title, description, color, and image
URL. The Discord boundary builds at most one explicit rich embed with only those supported
properties. It projects freshly fetched Discord messages back to the canonical payload, ignores
documented non-rich URL preview/media embeds, ignores response-only image proxy metadata, and
rejects missing or invalid types, multiple rich candidates, and unsupported rich state
conservatively. Embed `type` is treated only as Discord's rendering taxonomy, not as a guaranteed
provenance marker. Operations that actually send an explicit managed embed revalidate
`EmbedLinks`; text-only operations do not require it merely because their content contains a URL.

Create confirmation, edit coherence and no-op detection, ambiguous edit reconciliation, deletion
detection, persistence confirmation, compensation safety, and one-shot restore all compare the
complete canonical payload. Every actual edit explicitly replaces both content and embed portions;
add, remove, or embed-only changes increment the single revision once. Migration 0011 adds the four
nullable embed columns to managed messages and complete before/after embed columns to the existing
audit table, while preserving pre-0011 rows and audits with null embed state. No creation-audit
backfill is fabricated. Phase 7C adds neither `MessageContent` nor another gateway intent, event
listener, attachment support, scheduled-message worker, or failed-operation audit completion.

- Implement `/message send`.
- Persist managed-message metadata.
- Suppress mentions by default.
- Implement `/message edit`.
- Add revision-based conflict detection.
- Record before-and-after audit data.
- Detect manually deleted Discord messages.
- Add authorization and concurrency tests.

### Phase 8: Scheduled messages

Phase 8A reuses `scheduled_actions` as the generic scheduling envelope for one-time scheduled
managed messages. A `SEND_MESSAGE` action stores the target Discord channel ID in `target_id`; its
one-to-one `scheduled_message_states` row stores the existing canonical `ManagedMessagePayload`
shape in explicit columns and reserves a nullable resulting Discord message ID. Creation commits
the `ACTIVE` action, action-specific state, and exact `CREATED` user audit in one PostgreSQL
transaction.

The application validates through the existing managed-message payload validator and generates
the scheduled-action ID, audit ID, and audit occurrence timestamp before persistence. If the
transaction response is ambiguous, persistence performs one read-only confirmation and accepts
success only when the complete action, state, and stable audit match. It does not retry the write.
PostgreSQL-owned scheduled-action creation and update timestamps are not confirmation invariants.

Phase 8B adds runtime execution without exposing a command. Action-specific state stores the
original creator independently of audit retention and an authoritative retry count from zero
through three. Migration 0013 backfills each Phase 8A creator only from exactly one creation audit
that agrees with the complete action, target, execution time, and canonical payload; missing,
duplicate, or mismatched sources fail migration.

Execution loads authoritative state, validates the payload and initial inclusive 60-minute grace,
performs read-only Discord preflight, rechecks grace, and only then conditionally claims
`ACTIVE -> EXECUTING`. A claim loser performs no Create Message, execution audit, retry-count
change, or execution-state mutation. Retryable preflight results are processed only by the claim
winner. Safe pre-send retry atomically returns to `ACTIVE`, increments the persisted retry count,
and records `EXECUTION_RETRY`; count three converts another retryable condition into audited
terminal failure. Recreated pg-boss delivery never resets this budget.

The scheduled SYSTEM Discord boundary does not query the creator's current membership or
permission. It freshly validates target type, guild, active thread state, bot view/send permission,
and `EmbedLinks` for an explicit embed. Create Message suppresses mentions, enforces a deterministic
action-derived nonce of at most 25 characters, and permits at most one immediate replay with the
same request and nonce after an ambiguous result. A non-null returned nonce must match; a null nonce
does not trigger a refetch. Returned guild, channel, bot author, and canonical payload must also
match exactly.

Confirmed or ambiguous Create Message effects never use the pre-send retry transition. Returned
message mismatch, confirmed rejection, unresolved ambiguity, and compensation paths are terminal.
After exact creation, successful finalization atomically commits the completed action, state result
ID, active managed message, user-attributed managed-message creation audit, and system-attributed
scheduled execution audit. Both audit IDs are generated before the transaction. Response loss is
accepted only after a read-only match of the complete intended result. Compensation deletion is
allowed only when a reliable read proves finalization uncommitted; confirmed deletion remains
terminal. An unreadable commit confirmation causes neither deletion, resend, nor a guessed database
transition.

Startup recovery handles scheduled messages before their active reconciliation. Interrupted
`EXECUTING SEND_MESSAGE` actions have stale active delivery cleared and become audited `FAILED`
with `EXECUTION_INTERRUPTED_UNCONFIRMED`; they are never released to `ACTIVE` and no Discord call is
made. Startup and runtime active scans use `(execute_at, id)` keyset ordering. They fail actions
outside grace through normal claim/audit semantics and repair missing delivery without changing the
retry count. Runtime reconciliation is ACTIVE-only, non-overlapping, begins after 60 seconds, and
waits 60 seconds after each completed sweep. The worker count is one; correctness remains based on
the database claim rather than worker count.

Phase 8C-1 adds `/message schedule create`, `cancel`, and `status` without changing the existing
`send` and `edit` subcommands. Create stores only the validated one-time selector in its modal
custom ID and reuses the managed-message payload fields and validator. Legacy relative-delay IDs
remain readable after Issue #91 adds the absolute selector. After modal submission, a dedicated
Discord boundary freshly checks the target, active thread state, actor `ManageMessages`, and bot
view/send permissions, including `EmbedLinks` only for an explicit embed. It does not send, join a
private thread, unarchive a thread, or hold a PostgreSQL transaction during Discord reads.

After successful preflight, the application generates stable action and audit IDs, performs any
required guild-timezone lookup, then captures one establishment timestamp. It normalizes the
one-time selector to `execute_at` and uses the same establishment timestamp for the `CREATED` audit.
Existing exact creation confirmation remains authoritative. Initial pg-boss enqueue occurs only after confirmed persistence. An enqueue error is confirmed by a read-only
effective-delivery check; otherwise the active schedule is reported as pending reconciliation and
left for the existing startup/runtime repair path.

Cancellation uses a focused transaction scoped by schedule ID, guild, channel, and `SEND_MESSAGE`.
Only `ACTIVE -> CANCELLED` mutates state, and that transition commits with an exact user
`CANCELLED` audit added by migration 0014. A conditional update linearizes cancellation against the
execution claim. Ambiguous transaction responses are never retried and use read-only exact
confirmation. The normal locked path validates the scoped one-time message state before returning
`ALREADY_CANCELLED` from current `CANCELLED` state, without reading historical cancellation audits.
This no-op updates no rows or timestamps, inserts no audit, and causes no actual audit publication.
Missing or invalid state remains unconfirmed. The response-loss and defensive zero-row paths retain
exact audit checks: current `CANCELLED` state alone cannot confirm a newly attempted mutation.
Only after confirmed cancelled state does a focused pg-boss cleanup cancel
`created`, `retry`, and `active` delivery; terminal job history is retained, and cleanup failure
does not reactivate the application schedule.

Status uses one scoped PostgreSQL read and returns lifecycle metadata without payload content. It
performs no Discord or pg-boss call and no repair. Cancel and status require the interaction's
`ManageMessages` permission but remain available in archived supported threads and do not require
bot send permission.

Phase 8C-2 adds one-time `list`, `edit`, and `reschedule`. List is a read-only, channel-scoped query
over `ACTIVE` and `EXECUTING` `SEND_MESSAGE` actions, ordered by `(execute_at, id)` with fixed
10-row pages. Its view contains schedule metadata only and cannot expose payload columns.

The scheduled-message-specific state now owns a non-negative revision starting at zero. Edit and
reschedule transactions lock the scoped scheduled-action row as their common serialization point,
validate the complete action-specific state and expected revision, then commit the mutation and
stable `EDITED` or `RESCHEDULED` user audit together. Exact edit no-ops neither increment revision
nor audit. Ambiguous transactions use the exact stable audit for read-only confirmation; a later
valid revision does not invalidate proof that the earlier transaction committed.

Execution loads revision with the authoritative payload before Discord preflight. Its later claim
locks the scheduled-action row and commits `ACTIVE -> EXECUTING` only when the action remains a
`SEND_MESSAGE` and the scheduled-message revision still equals the loaded value. No transaction is
held over Discord work. A committed edit or reschedule therefore defeats a stale claim, while a
claim committed first makes the later administration request ineligible.

Scheduled-message pg-boss payload is a backward-compatible union. New projection contains
`scheduledActionId`, canonical `scheduledExecuteAt`, and `scheduleRevision`; old ID-only payloads
remain readable. Projection metadata identifies delivery but never authorizes execution. Created
delivery requires both projected time and effective start time to match. Retry and active delivery
use projected time only because retry `startAfter` is its next wake time. Revision-only drift after
a payload edit is current when projected time still matches.

The scheduled-message delivery boundary uses public pg-boss 12.27.0 inspection, `upsert()`, and
cancellation APIs. Created and retry jobs are updated in place, preserving job identity and retry
metadata. Missing or terminal-only delivery uses the upsert insert path. Stale active delivery is
cancelled and read-confirmed ineffective before current delivery is upserted; a current active job
is not replaced. Ambiguous mutations receive read-only confirmation and otherwise remain pending
for reconciliation. PostgreSQL reschedule state is never rolled back or restored because delivery
repair failed.

Startup and runtime scheduled-message reconciliation now load each authoritative active definition
and classify delivery as current, stale, missing, or unconfirmed by execution time. Legacy created
delivery is adopted only at the matching effective time. Legacy retry is upgraded with projection
metadata without resetting its retry state or wake time. Legacy active delivery is cancelled and
confirmed before replacement. Terminal history does not suppress repair, and unconfirmed state is
logged safely for a later sweep. Worker handling still reloads PostgreSQL, rejects early stale
wakeups while authoritative execution time remains in the future, and relies on the revision-aware
database claim to prevent stale or duplicate Discord effects.

One-time list, edit, and reschedule commands are implemented.

#### Absolute one-time message scheduling (Issue #91)

`one-time-message-schedule.ts` owns the shared `AFTER`/`AT` selector, strict parser, bounded errors
and canonical normalization. `/message schedule create [after:<duration>] [at:<local-datetime>]`
and `reschedule id:<id> [after:<duration>] [at:<local-datetime>]` define both selectors as optional,
with required `id` first. The handler enforces XOR by option presence, validates syntax/calendar
and transports the selector through the existing payload modal. Empty supplied strings remain
invalid. `at` has equal min/max lengths of 16; the parser requires ASCII `YYYY-MM-DD HH:mm`, one
space and `00:00` through `23:59`, then uses `Temporal.PlainDateTime.from` with overflow rejection.
No whitespace trimming, locale parsing, seconds, offsets, annotations or calendar normalization
is allowed. Relative parsing remains unchanged.

The old numeric duration modal IDs remain supported. AT uses the same owned prefix with an `at:`
discriminator and strict local input. No timezone or canonical instant is encoded; malformed and
oversize identities fail before service calls. The existing five payload fields and stateless
transport remain, with no persistent modal sessions.

The application service freshly authorizes create or loads scoped editable reschedule state,
then loads current `guild_settings.timezone` only for AT. Create does this during modal submission
processing, so settings changed while the form is open are authoritative at submission. Reschedule
reads settings during its operation. Reuse `getOrCreate` for the existing missing-setting UTC
default and `normalizeRecurringTimezone` for named-IANA validation, including supported aliases.
Reject invalid saved zones and numeric offsets without fallback. Separate bounded timezone lookup
failure from invalid stored timezone; never surface raw values or exceptions.

After preflight and lookup, capture exactly one `establishedAt = now()`. AFTER continues through
`addRelativeDuration`; AT converts the validated local datetime directly using `resolveLocalCandidate`
with the explicit guild timezone. Reject both `DST_GAP` and the resolver's overlap flag. Never
persist the resolver's earlier occurrence for one-time overlap input. Recurring gap/overlap policy
is unchanged. These installed polyfill 0.5.1 APIs do not require `Temporal.TimeZone` or host-local
Date parsing.

AT horizon validation compares the canonical instant with that single clock: inclusive 60,000 ms
minimum and 31,536,000,000 ms maximum (365 elapsed days). Do not impose the relative transport's
whole-minute-multiple rule on this difference. Do not convert AT to a duration or use another clock.
Do not revalidate minimum lead time at commit; delays after establishment retain existing recovery.
Both selectors continue through the same `executeAt: Date` persistence and projection path, with
canonical `CREATED`/`RESCHEDULED` audit data only. Guild timezone changes cannot reinterpret a stored
instant. Reschedule retains row locks/revisions and preserves payload, creator, retry/result state;
same-instant reschedules still mutate and audit. Discord success timestamps remain viewer-local.

No schema, migration, dependency, intent, permission, worker, queue, claim, reconciliation or shutdown
changes are required. Existing duplicate-delivery and response-loss behavior remains authoritative;
no creation deduplication or exactly-once guarantee is added.

Unit coverage includes XOR presence, strict/calendar grammar, named zones, DST gaps/overlaps
(including Lord Howe), inclusive horizon/non-minute differences, deterministic preflight-clock
advancement and single-clock establishment, modal round trips/timezone changes, reschedule and
bounded response errors. Run the pure absolute tests under distinct host TZ values to verify
independence. PostgreSQL integration extends administration and worker suites for atomic canonical
creation/audit (including rollback and response loss), same-row/revision reschedule, unchanged stored
instants after timezone edits, claims, exact later-revision confirmation and real pg-boss
projection/reconciliation repair. The maintainer runs secret-dependent `weft-integration` after
non-secret Node 24 checks; passing unit tests does not establish integration success.

#### Phase 8D: Recurring scheduled messages

Phase 8D is divided into three reviewable slices:

- Phase 8D-1: recurring scheduling foundation,
- Phase 8D-2: recurring occurrence execution and delivery,
- Phase 8D-3: recurring message administration.

Phase 8D-1 adds `@js-temporal/polyfill` as a direct runtime dependency and implements the calendar
and persistence foundation without starting recurring runtime work. Daily and selected-weekday
weekly rules use local calendar arithmetic, strict minute precision, normalized named IANA zones,
and an all-weekday canonical mask for daily schedules. Numeric offsets are rejected. IANA link or
alias identity is retained after preferred-case normalization.

Local-time resolution evaluates Temporal `earlier` and `later` disambiguation and round-trips both
results. An overlap materializes only the earlier instant. A gap materializes no occurrence and is
an explicit audit effect. The algorithm makes no one-hour-transition assumption. Candidate
selection is strictly after one stable establishment timestamp captured before creation or a
recurrence edit. Materialized absolute instants are immutable.

Migration 0016 adds `recurring_message_schedules`, `recurring_message_occurrences`, and
`recurring_message_audits`. The recurrence row is the discriminator; no generic schedule-kind
column or backfill is introduced. Occurrences have bounded lifecycle, failure, and skip states,
claim-snapshot shape constraints, one-nonterminal-per-series uniqueness, and definition/date/time
materialization uniqueness. The audit table uses explicit relational fields for mutation,
execution, DST-gap, missed-range, and historical next-occurrence effects.

The existing scheduled-message revision is the unified series revision. Payload edit increments
it without changing the definition revision or current occurrence. Recurrence or timezone edit
increments it once and establishes the new definition revision and effective boundary. A pending
occurrence is skipped and replaced in the same transaction; executing and retry-pending
occurrences retain their immutable snapshots and defer materialization. Cancellation uses the lock
order series then occurrence, increments the unified revision, skips pending and retry-pending
work, and leaves an executing occurrence in flight.

Initial claim is a pure PostgreSQL transaction. It locks series then occurrence, verifies active
series state, occurrence identity and pending state, and the caller's expected unified revision,
then snapshots the canonical payload and claim revisions with one stable claim timestamp.
Persistence mutations use caller-generated stable audit IDs and exact read-only audit confirmation
instead of blind retry. Claim, payload edit, recurrence edit, and cancellation therefore serialize
at the series row without depending on worker count or a process-local lock.

Standalone occurrence materialization uses a stable occurrence ID and a unique definition/local
date/local time identity. If its transaction response is lost, a read-only check confirms that ID,
the immutable intended instant, the initial pending shape and execution-time update while still
pending. A later valid lifecycle or recurrence change can replace those current-state effects;
the immutable occurrence identity and materialization fields remain the historical evidence.

Missed-occurrence calculation selects the latest eligible missed candidate without persisting a row
for each missed date, applies an inclusive 15-minute grace, identifies the first future candidate,
and represents older misses as one range. It scans the relevant local calendar dates in memory to
collect each DST gap once by definition revision, local date, and local time. Safe pre-send retry
lifetime is a separate inclusive 15-minute boundary. Runtime retry continuation and terminal
advancement remain Phase 8D-2, but the 0016 occurrence and audit shapes represent their complete
bounded state and historical next/no-next effects.

All existing one-time scans, reconciliation loads, execution loads and claims, status/list reads,
editable loads, edits, reschedules, and cancellation exclude rows with a recurring discriminator.
Consequently a stale one-time pg-boss delivery carrying a recurring series ID is rejected before a
Discord Create Message request. Existing one-time rows retain their prior behavior.

Phase 8D-2 adds `weft-recurring-message-occurrence` as an exclusive pg-boss queue with
`retryLimit: 0` and `expireInSeconds: 900`. Its strict payload carries the series ID, occurrence
ID, immutable scheduled instant, projected series revision, and delivery generation. The singleton
key is `${occurrenceId}:${retryCount}`. A later generation can be projected while an older one
remains active. Projection repair never changes authoritative PostgreSQL state.

The executor loads the occurrence by ID, checks the series and immutable scheduled instant,
validates the canonical payload, performs fresh Discord preflight, and then claims `PENDING ->
EXECUTING`. A losing or ambiguous claim cannot send or record preflight failure. Retry continuation
uses the immutable initial claim payload and requires a winning `RETRY_PENDING -> EXECUTING`
transition. The current series revision in a job is projection metadata; it is not an execution
veto. Both paths use the series-then-occurrence PostgreSQL lock order and release all locks before
Discord or pg-boss calls.

Only a known pre-send `CURRENT_STATE_CHECK_FAILED` can create an application retry. One stable
retry-transition timestamp determines eligibility, the retry audit time, and the next 30-second
wake. The decision order is observed-after-deadline, exhausted count, candidate-wake-after-deadline,
then retry. The lifetime is 15 minutes from the first attempt, inclusive; the count increments
only on entry to `RETRY_PENDING` and reaches at most three. The committed retry audit determines
the wake, including after restart. pg-boss's own retry state is not application authority.

The Discord boundary is shared with one-time execution. Recurring sends use a domain-separated
occurrence nonce, mention suppression, and one immediate same-nonce replay after ambiguity. A
definite initial rejection becomes `SEND_REJECTED`; replay rejection or ambiguity becomes
`SEND_UNCONFIRMED`. Concrete success finalizes the occurrence, managed message, both audits, and
next occurrence in one transaction. Active advancement uses the latest recurrence definition;
cancelled series record no-next. Database response loss requires read-only exact confirmation;
compensation is allowed only after confirmed non-commit, and an unknown result causes no delete or
resend.

Startup recovery scans bounded pages before recurring workers start, repairs pending and retry
delivery, and fails orphaned `EXECUTING` occurrences conservatively without resend. Runtime
reconciliation runs non-overlapping 60-second sweeps for pending and retry work, including missed
grace and retry expiry. Retry expiry checks `RETRY_PENDING`, its expected retry generation, and
the first-attempt timestamp inside one series-then-occurrence-locked transaction before failing an
occurrence; it cannot claim a live resumed `EXECUTING` or terminal occurrence, or a newer retry
generation. The reconciler routes strictly overdue retries to expiry before `retryWake()`. The
locked expiry path derives the deadline again and, only when the operation time is strictly beyond
it, does not require the historical retry audit. At or before the inclusive deadline, the matching
retry audit remains necessary for wake/resume and for expiry when its recorded wake exceeds the
lifetime. Missing evidence within that window produces the existing warning and conservative
return without projection or guessed expiry. Normal terminalization, next-state advancement, and
publication of actual committed terminal/gap audit references remain unchanged. Response-loss
confirmation still requires the new stable terminal audit and exact occurrence/next state.

Current scheduling rows are authoritative scheduling state; historical audits are audit history.
Using valid current state for overdue recovery or an already-cancelled no-op does not relax exact
evidence for a newly attempted mutation or guarantee reconstruction of missing/corrupt state.
Issue #72 compatibility changes keep valid current scheduling state independent of historical audits.

An active series with no nonterminal occurrence derives a safe candidate from its current definition
effective boundary
and latest terminal occurrence history. It never infers an interrupted execution from queue
absence.

Phase 8D-3 completes the recurring command surface with `recurring-create` and `recurrence-edit`.
The payload modal transports validated compact recurrence input in a stateless custom ID. Creation
loads an omitted guild timezone at modal submission, performs fresh Discord preflight, generates
stable series, occurrence, and audit IDs, and uses the existing calendar helper to enumerate DST
gaps. Only confirmed PostgreSQL creation projects the initial pending occurrence; a lost pg-boss
projection is reconciled later.

The recurring persistence primitive checks expected unified revision and normalized recurrence
equality under the series lock. An exact no-op does not revise or audit. A pending occurrence is
skipped and replaced in the edit transaction; executing or retry-pending work remains immutable
and defers future materialization. Pre-generated replacement and gap IDs may remain unused if a
claim wins before the lock. The `RECURRENCE_EDITED` audit records that edit's historical deferred
or immediate replacement effect, and exact response-loss confirmation reconstructs it from the
audit. A replacement is projected only after a read-only eligibility check; execution-time
PostgreSQL validation makes a job stale after that check harmless.

Shared payload edit, cancel, and status route by the recurring discriminator. One-time persistence
retains its exclusion and `reschedule` remains one-time only. Recurring payload edits use the
unified revision without rewriting the current occurrence or claim snapshot. Recurring status
reads no payload columns. A combined payload-free list query orders both kinds by
`(execute_at, scheduled_action_id)` before ten-row pagination. Recurring `execute_at` is the next
scheduled time only for pending work; executing and retry-pending rows show the current
occurrence's original scheduled instant, while cancelled rows may show historical time. Phase 8D
is complete; Phase 9 remains separate.

### Phase 9: MVP hardening

- Review Discord permissions.
- Implement and validate the optional audit-log destination guild setting.
- Finalize operational health checks.
- Maintain fixed global audit retention.
- Document backup and restore procedures.
- Document migration operations.
- Review Discord rate-limit behavior.
- Review runtime dependencies and licenses.
- Prepare the first public release.

### Phase 9B-2A: Audit-log destination configuration

The optional guild destination is disabled by default and stores only a channel ID. `/config
audit-log show` performs a read-only PostgreSQL lookup and projects a missing row as disabled.
`set` re-fetches a guild text or announcement channel and the bot member, then checks effective
`ViewChannel` and `SendMessages` permissions before entering the database transaction. `disable`
performs no Discord lookup. All commands require the user's `ManageGuild` permission.

Destination changes serialize on the `guild_settings` row and atomically write the setting and a
dedicated PostgreSQL audit. An exact no-op changes neither timestamp nor audit history. Ambiguous
write responses are checked through the stable audit ID; a later destination change does not erase
that historical proof. PostgreSQL remains authoritative. The configuration-time Discord preflight
is point-in-time. Phase 9B-2B projects newly committed audits from the seven current audit tables.
The projection explicitly selects safe metadata, never message content or embed fields. Publication follows successful commit or exact same-ID confirmation;
recurring operations publish only audit rows actually committed, including gap/skip audits and any
managed-message audit in a combined transaction. A process-local dispatcher owns asynchronous
projection, current destination lookup, delivery-time Discord permission checks, one plain-text
send with mention suppression and a stable nonce, and graceful-shutdown drain. It has no durable
queue, retry, replay, backfill, or ordering guarantee. PostgreSQL remains authoritative even if a
notification is lost.

Deferred ideas must not be implemented during these phases without an approved specification change.

### Phase 9B-3: Audit retention

A process-local retention runtime uses the existing application PostgreSQL client. It schedules an initial sweep after startup without waiting for the backlog before READY, then schedules each later sweep 24 hours after the previous one settles. Single-flight ownership prevents overlapping sweeps. Shutdown marks the runtime as stopping, cancels its timer, and drains its current bounded statement through the existing application quiesce phase before the database closes.

Each sweep captures one instant and subtracts exactly 90 * 24 hours. A dedicated persistence boundary deletes only rows with audit timestamps strictly before that cutoff from the seven explicit audit tables. Each atomic PostgreSQL statement selects at most 500 IDs ordered by timestamp and ID, deletes those rows, and returns IDs only for counting. The five new timestamp-and-ID indexes support this global query shape; the existing audit-log-destination retention index remains. A source failure is logged with bounded metadata and does not stop other sources or affect readiness.

Audit deletion leaves authoritative schedule, managed-resource, and configuration state untouched. It does not publish audit references or Discord notifications. An already eligible audit may disappear before best-effort notification projection; the existing missing-projection behavior applies. The period is fixed globally for this MVP, cleanup is periodic rather than exact TTL, and per-guild configurability remains unresolved.

## Message-link preview implementation

`link-preview.ts` contains link/ID grammar, bounded pure rendering and application orchestration.
`link-preview-permissions.ts` validates fresh raw DTOs and computes conservative public proof and
individual effective permissions. `link-preview-discord.ts` owns raw REST calls and global button
routing; no collectors, timers, target cache or scheduler are used. Existing automatic-close handlers
remain separate. Both new handlers enter through `runtime.ingress.run()` and retain their promises
through all fetches, sends and ephemeral edits under the existing shared 30-second shutdown deadline.

Raw channel and role reads preserve missing/invalid fields as unconfirmed instead of accepting
cached discord.js defaults. For threads, refresh the direct parent and validate the type/guild/parent
relationship. Age state must be explicit `nsfw: false` on that parent or direct target. Category state
is not a second permission layer. Public proof checks everyone's view/history grants and every
non-everyone overwrite deny; the bot's own read access is a separate condition. Click authorization
uses fresh guild/roles and individual Get Guild Member calls, plus Get Thread Member for private
threads unless effective ManageThreads permits access. No GuildMembers intent or enumeration is used.

Within each fresh observation boundary, independent channel, guild, role and individual member reads
run concurrently. Guild/role/member reads are shared across the bounded AUTO batch; channel and direct
parent reads are deduplicated by ID in a map that is discarded after that observation. Initial and
final observations never share authority. Private-thread user/bot membership reads also run
concurrently after fresh effective permissions are known. Wait for all parallel siblings to settle
even when one fails, retaining shutdown ownership and failing closed. Candidate message/identity
reads run concurrently across targets, but all finish before final public proof. No stale discord.js
cache is used as authority or as a preliminary hint.

Keep the early source-sendability preflight to avoid unnecessary target work. After payload
preparation, concurrently perform a separate fresh source observation and the final target proof;
await all siblings before immediately creating the one reply. Every public output, including
button-only helpers and overflow-only replies, uses this final source guard. Revalidate source
identity, guild, supported type, current bot view/history/embed/send permissions and thread state.
Source threads must have explicit `archived: false` and `locked: false`, with a fresh valid parent
relation. Private sources additionally require fresh existing bot membership from Get Thread Member,
regardless of ManageThreads or Administrator. Missing, invalid or failed membership observations
suppress private-source replies. Public, announcement and forum-post sources do not require existing
membership and perform no source Get Thread Member lookup. Their normal Create Message may cause
Discord to add WEFT as a member; that implicit membership change is allowed only for public sources.
Never explicitly join, leave, modify, unarchive or unlock a source thread to create a preview.
Each observation discards its membership map; no cached authority crosses from preflight to final
checks. The final observation and Create Message are not atomic, so a later
Discord state change can still race the send. All added REST work remains awaited within ingress.

Local parsing collects all distinct supported same-guild candidates and their source ordinals.
Separate feature constants bound visible items (`MAX_VISIBLE_ITEMS = 3`) and examined candidates
(`MAX_CANDIDATES_EXAMINED = 6`). Classify only the first six candidates as one concurrent fresh batch.
Prepare their initially safe-public messages concurrently, then freshly revalidate every prepared
candidate before selecting the first three final eligible items in source order. Preparing standby
candidates allows slot filling after final revocation without any content reads after final proof.
Message/identity reads are bounded by six; shared fresh guild/role/member/parent reads retain their
observation-local deduplication. Never fetch a seventh candidate just to compute overflow.

Compute overflow as eligible examined items minus displayed items, plus unexamined candidate count.
Public-only excludes every examined restricted/uncertain/age-ineligible or failed-message candidate;
hybrid includes generic fallbacks but excludes confirmed age-ineligible candidates. Button-only counts
syntactic candidates without target investigation, sends at most three buttons, and counts the rest
as overflow. Off has no output or target reads. Preserve full-source candidate count for deciding
`Preview` versus `Preview N`, even when only one button is finally visible. Nonzero overflow is plain
`+N more` message content; zero overflow leaves content absent. Overflow-only replies are allowed for
unexamined links and convey no target facts.

Prepare every AUTO candidate's content, identity and bounded embed before starting the final
observation batch. Drop protected payloads whose fresh proof or age eligibility failed; hybrid may
replace a restricted/unconfirmed result with an ID-only helper. Immediately call Create Message after
synchronous assembly. Ephemeral content likewise receives a final authorization/age observation.
Reads and sends are not atomic; no later permission/edit/delete monitoring is implied. Keep all
protected names, content, avatars, attachment URLs/names, raw embeds, errors, stacks and interaction
tokens out of logs. Log only selected IDs and bounded codes. In particular, ambiguous Create Message
ends with `SEND_UNCONFIRMED`; no application resend. The source-derived SHA-256 nonce is domain
separated and versioned, bounded to 25 characters, stable across restart and sent with
`enforce_nonce: true`. Immediately after final proof, send at most one reply combining public embeds
and generic Secondary Preview buttons. Attempt it once; never retry an ambiguous send. The reply has no
helper explanation text. A single distinct supported link uses `Preview`; multiple links use `Preview N`
according to source appearance order, including public and omitted targets. Legacy components follow
all embeds rather than appearing between them. Footer location comes only from successful final
fresh observations. Public AUTO targets have no Open original component; authorized button previews
always include Open original, regardless of target classification.

Migration 0019 extends guild settings with a constrained default-hybrid mode and adds the seventh
audit source, `link_preview_audits`. A row lock serializes setters; mode, timestamp and audit commit
in one transaction. A stable audit ID provides exact historical confirmation after response loss.
No-op writes do not change timestamps or insert audits. Show/detection reads never create settings.
Notification projection selects only administrative mode metadata; retention uses `(occurred_at, id)`.
No preview or click payload/history is persisted.

After ordinary Node 24 verification, the maintainer must run `weft-integration` with dedicated test
PostgreSQL settings. Codex must not read those settings or run the secret-dependent suite. Integration
coverage includes the 0018-to-0019 upgrade, preservation of existing values/timestamps, constraints,
no-op behavior, concurrent setters, rollback, exact audit confirmation, publication and retention.

A user-run live Discord gate is also required before pre-commit approval: verify all modes, safe-public
AUTO, restricted helpers, authorized/unauthorized and revoked clicks, private/public/forum threads,
age-restricted targets and parents, deleted messages, multiple links, identity/avatar/image rendering,
Open original, mention suppression and no recursive output. Test permission/age changes after helper
creation. Neither PostgreSQL nor live Discord verification is implied by passing unit tests.

Discord reference contracts: [permissions](https://docs.discord.com/developers/topics/permissions),
[channel/thread resources](https://docs.discord.com/developers/resources/channel), and
[message creation](https://docs.discord.com/developers/resources/message).

## Confirmed interactive bulk thread closing (Issue #89)

`bulk-thread-close.ts` owns pure optional AND filters, fixed candidate snapshots, mutable selected
subsets, bounded setup/session Maps and application orchestration. `bulk-thread-close-discord.ts`
owns fresh raw REST reads; `bulk-thread-close-command.ts` owns interaction acknowledgement, strict
`btc:` controls and bounded rendering. Existing `lp:` routing remains separate. `/thread` keeps its
ManageThreads command default.

The slash command has no options. Its guild/ManageThreads/READY checks precede `showModal()` as the
initial response; do not defer that command before opening the Modal. Current discord.js
LabelBuilder and ModalBuilder.addLabelComponents support required Channel Select, optional User
Select and two optional Text Inputs. Submit reads typed fields and raw selected ID arrays rather
than resolved objects, defers ephemerally, consumes a guild/initiator-bound setup ticket once, then
validates input. Blank name/age means unset; nonblank name preserves its original spaces. The
relative-duration parser sets one fixed age cutoff. Setup tickets have independent capacity 128 and
five-minute TTL, lazy cleanup and no live eviction. Restart, shutdown, expiry or replay invalidates
them.

The active guild route is the REST equivalent of `guild.channels.fetchActiveThreads()`. Read raw
`create_timestamp` directly to avoid cached ThreadChannel metadata or snowflake fallback. Parent,
guild owner, roles and individual actor/bot members are observed freshly. All parent authorization
responses must succeed before starting active enumeration; failure never starts enumeration. Reuse
the repository's permission DTO validators and effective-overwrite calculation from
`link-preview-permissions.ts`, requiring ViewChannel + ManageThreads rather than link-preview
read/send permissions. Public and announcement threads inherit their direct parent's permissions.
Private and wrong-parent/type identities never leave the bulk Discord boundary. Each bounded
observation awaits all parallel siblings even if one fails. No freshness authority persists between
observations.

Sort canonical decimal thread IDs by length, then lexical comparison, giving ascending numeric
ordering without Number conversion or creation-time inference. Store immutable candidate IDs,
mutable selected Set, conditions, fixed creation cutoff, identity/binding, expiry, state, current
page/revision and preview-write ownership. Filtered snapshots initially select all candidates;
unfiltered snapshots initially select none. Both modes reject more than 50 eligible candidates
without truncation. The ten-option current-page String Select replaces only that page's selected
values. Validate array, unique snowflakes, current page and snapshot membership before changing the
Set. Clear page submits an empty selection while retaining other pages. Navigation/revisit projects
the Set into option defaults. Bounded revision controls reject stale page/selection submissions.
Revision values range from zero to 999999; at the bound further editing fails safely while
Confirm/Cancel remain available. Session capacity is 128: at most 6,400 IDs for a single instance
with five-minute previews. No live eviction occurs. Expired entries are cleaned lazily on
access/creation; consumed and cancelled sessions retain their original expiry and do not extend it.
Shutdown clears the Map and wakes capacity waiters. There is no periodic cleanup timer or durable
restart progress.

Extend existing lifecycle close with optional `BulkThreadCloseHooks` only. Inside lifecycle
ownership, a queued operation or guarded mutation returns a typed existing-operation skip before
selection or preparation. A fresh selection hook returns a currently authorized snapshot;
false/rejected/timed-out pre-attempt evidence produces a typed skip without schedule cancellation,
settings creation, managed write, close audit or PATCH. Immediately after this check, a synchronous
admission hook checks READY, caller admission and the inclusive confirmation-time + five-minute
deadline. Then `onAttemptStarted` marks the first possible effect before existing manual-close
preparation. The preparation still uses `scheduledThreadClose.closeManually`, preserving schedule
cancellation and EXECUTING exclusion. Fresh selection is repeated before managed persistence and
immediately before archive using the latest title. After the start boundary, selection failure
follows the existing attempted failure/audit path. A confirmed EXECUTING cancellation result
establishes no cancellation/close effect and remains skipped.

`onLogicalSettled` propagates the existing serialize/retained-operation settlement boundary. A
feature-wide owner reserves at most three slots across all sessions (including preflight
reservation). Only that lifecycle signal releases the reservation, after raw mutation,
reconciliation, required persistence and final audit/publication have relinquished ownership. No
bulk finalizer, second reconciler, audit path, per-thread lock, rate limiter or retry layer is
added. Ordinary single closes have no hooks and retain their behavior. Timed-out bulk selection
reads remain attached to logical drain and cannot later admit an attempt.

Three local orchestration workers per session share the single feature owner. Capacity waits wake on
logical settlement, deadline or quiesce. Per-target caller observation is 15 seconds; timeout closes
only that caller's future admission. Started unresolved work remains Pending and retains its slot.
Aggregate counts return by the admission deadline plus at most one caller-observation budget, even
if manual-close preparation never settles. Lifecycle owns the underlying promise throughout. A
result uses only counts and generic explanation, so no final authorization lookup is needed to
expose names. There is no later interaction-token completion notification.

`discord.ts` routes btc Modal submissions, String Selects and buttons through existing READY-only
`ingress.run`, separately from lp controls. No interaction work is detached. Modal submit uses
`deferReply` ephemerally; page/select/buttons use `deferUpdate` before slow REST work. Pages show
ten identities with bounded Markdown/masked-link-safe prose and normalized plain-text Select
labels/descriptions; one embed remains below description, field and aggregate UTF-16 limits.
Mention-like tokens are neutralized and `allowedMentions: { parse: [] }` is applied to every
reply/edit. Invalid controls and identity/authorization failures return one generic ephemeral
message. Confirm freshly authorizes the parent, then re-reads session identity/expiry/state and
nonzero selection, copies selected candidate IDs, and synchronously transitions PREVIEW to EXECUTING
without an intervening await. Only the frozen execution IDs enter the unchanged manual-close
orchestration. Selected in aggregate counts means this frozen subset; deselected candidates never
call closeManually or cause schedule cancellation, managed writes, audit or PATCH. Selection may
change while Confirm awaits authorization; the final synchronous copy is authoritative. Once
consumed it cannot change. Preview edits are serialized per session and page authorization is
refreshed after any earlier raw edit settles; queued renderers check current state/revision after
fresh reads; stale writes cannot publish after consumption, and terminal control removal follows
earlier raw page edits. Confirm's bounded aggregate uses a separate ephemeral follow-up, so an
in-flight page edit cannot delay the result indefinitely. Both promises stay under READY ingress
ownership and the existing source drain, then retained work uses lifecycle drain.

Use fake timers, controlled promises and fresh REST DTO fakes for race, deadline, privacy and
payload tests. PostgreSQL tests exercise existing unmanaged transition, cancellation, actor and
stable audit persistence, including partial selection failure after an effect. No migration or
dependency changes are needed. The maintainer must run `weft-integration` and the Issue #89 live
Discord gate after non-secret Node 24 checks; unit tests do not establish either result.

Modal preview preparation uses the existing `withTimeout` observation helper: acknowledgement and
message edits have the existing 2.5-second interaction I/O budget, and preparation shares one
15-second budget after acknowledgement. The budget covers fresh authorization, active enumeration,
first-page reauthorization, rendering and publication, including response-tail waiting. Each REST
read logs its fixed stage (`parent_fetch`, `guild_fetch`, `roles_fetch`, actor/Bot member fetch,
`active_enumeration` or `candidate_fetch`); rendering and updates have separate boundary stages.
Started/completed debug events and failed/timeout warnings contain only stage, duration and a coarse
failure code, without names, filters, IDs, URLs or raw errors.

Use distinct Previous/Next action IDs even on a single page: Discord forbids duplicate component
custom IDs, including disabled buttons. A rejected preview edit must replace the Preparing text with
a generic preparation failure and remove controls. Preparation failure discards the unpublished
session and aborts continuation authority. Late authorization must not start enumeration; late
enumeration/page reads cannot create or publish a session. This signal does not cancel discord.js
transport or change its rate-limit queue/retry policy. A failure edit has its own bounded observation;
if Discord also refuses or stalls that edit, log its outcome as unknown rather than claiming delivery.
Never enqueue this recovery inside the renderer's own response tail.

The Modal router retains raw REST/edit promises in its already-admitted ingress operation after the
bounded user-facing preparation returns. Source drain awaits those raw promises under the existing
process shutdown deadline. Do not detach them or add another shutdown coordinator. Timed-out reads
cannot resume discovery or execute targets. A late message write cannot reactivate a discarded
session; the transport continues to serialize the already-issued webhook edits. Other bulk mutation,
logical-settlement and concurrency ownership remains unchanged.
