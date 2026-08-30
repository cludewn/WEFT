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
other scheduled-action categories. Scheduled-message retry count and backoff parameters remain an
unresolved product decision and must be decided before scheduled-message implementation.

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

## Startup and shutdown

Startup must initialize components in a controlled order.

The intended sequence is:

1. load and validate application configuration,
2. initialize structured logging,
3. connect to PostgreSQL,
4. run or verify database migrations according to the approved migration strategy,
5. initialize pg-boss when scheduling is implemented,
6. create and validate required scheduling queues,
7. reconcile persistent scheduled actions and their delivery state,
8. initialize the Discord client and wait until it is ready,
9. register workers and event handlers,
10. start runtime reconciliation loops,
11. begin normal operation.

Startup code must not print secret values.

Shutdown must:

1. stop accepting new application work where practical,
2. stop new runtime reconciliation sweeps and drain an in-flight sweep,
3. stop worker polling and drain in-flight scheduled execution,
4. stop pg-boss and close its independently owned database connections,
5. destroy the Discord client,
6. close the application database connections,
7. report shutdown failures,
8. exit without silently abandoning in-process state.

The exact migration and command-registration strategies must be selected during their implementation phases.

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
must not create overlapping attempts. The final managed state and exactly one success or failure
audit are persisted before the guard is released. Normal discord.js rate-limit queue waits are not
failures or unknown outcomes solely because they exceed the caller wait budget.

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

- Implement `/message send`.
- Persist managed-message metadata.
- Suppress mentions by default.
- Implement `/message edit`.
- Add revision-based conflict detection.
- Record before-and-after audit data.
- Detect manually deleted Discord messages.
- Add authorization and concurrency tests.

### Phase 8: Scheduled messages

Before implementation, decide:

- the overdue grace period,
- retry count and backoff parameters,
- the recurring-schedule input format.

Then:

- implement one-time scheduled messages,
- persist resulting Discord message IDs,
- implement recurring messages,
- skip missed recurring occurrences after downtime,
- implement cancellation,
- add retry, race, and restart-recovery tests.

### Phase 9: MVP hardening

- Review Discord permissions.
- Implement and validate the optional audit-log destination guild setting.
- Finalize operational health checks.
- Implement audit retention.
- Document backup and restore procedures.
- Document migration operations.
- Review Discord rate-limit behavior.
- Review runtime dependencies and licenses.
- Prepare the first public release.

Deferred ideas must not be implemented during these phases without an approved specification change.
