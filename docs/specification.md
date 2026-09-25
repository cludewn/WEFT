# WEFT Specification

## Status

This document is the authoritative product specification for the currently approved WEFT scope.

A behavior described here may not be implemented yet. Implementation progress is tracked through GitHub Issues and the repository history.

Do not infer unapproved implementation details from this document.

## Product definition

WEFT is a self-hosted Discord bot focused on:

- Discord thread lifecycle management,
- persistent one-time and recurring scheduled actions,
- managed messages sent by the bot,
- authorization and auditability for administrative operations.

WEFT must remain practical to deploy and operate with Docker Compose.

## Target deployment

The initial supported deployment consists of:

- one WEFT application instance,
- one PostgreSQL instance,
- one Discord bot application,
- Docker Compose.

The initial design does not include:

- Redis,
- microservices,
- a web administration interface,
- multiple active WEFT application instances,
- a high-availability cluster.

## Required technology

- Node.js 24 LTS
- TypeScript
- ECMAScript modules
- TypeScript strict mode
- pnpm
- discord.js
- PostgreSQL 18
- Drizzle ORM
- pg-boss
- Zod
- Vitest
- Pino
- Docker
- Docker Compose

## Terminology

### Guild

A Discord guild is what the Discord user interface commonly calls a server.

Use `guild` in source code, database fields, and technical documentation when it corresponds to Discord API terminology.

### Managed thread

A Discord thread for which WEFT records management state or applies a configured management policy.

### Managed message

A Discord message sent by WEFT and recorded in PostgreSQL so that authorized administrators can manage it through WEFT.

### Scheduled action

A persistent instruction for WEFT to execute a supported action once or repeatedly.

## Product principles

1. Thread management and persistent scheduling are the product core.
2. Administrative operations must be explicit and auditable.
3. Scheduled work must not be silently lost when WEFT restarts.
4. Current Discord state and permissions must be revalidated when execution depends on them.
5. Operations should be idempotent where practical.
6. Potentially sensitive features must use restrictive defaults.
7. Extensibility must come from clear module boundaries, not from accumulating unrelated utility commands.

## MVP scope

### Application foundation

WEFT must:

- start and stop cleanly,
- connect to Discord,
- connect to PostgreSQL,
- validate required environment variables,
- emit structured logs,
- run database migrations,
- shut down gracefully,
- reconcile persistent scheduling state after startup.

#### Runtime lifecycle

The application process owns the process-local states `STARTING`, `READY`, `SHUTTING_DOWN`, and
`STOPPED`. These states are not persistent application state. PostgreSQL remains authoritative for
WEFT configuration, schedules, managed resources, and audit history.

Runtime startup validates configuration before constructing the lifecycle owner. It then wires
Discord handlers behind a closed ingress gate and performs the following ordered work:

1. start the local health listener without entering `READY`,
2. verify the application PostgreSQL connection with a real query,
3. start pg-boss and validate every required queue,
4. complete PostgreSQL-authoritative startup recovery,
5. connect Discord and observe `ClientReady`,
6. register the scheduled and recurring workers,
7. schedule the periodic reconciliation loops,
8. attempt best-effort automatic-close baseline reconciliation,
9. schedule the automatic-close runtime,
10. atomically enter `READY`, open application ingress, and log `application_ready`.

The first periodic reconciliation sweep need not complete before `READY`. Remote Discord command
deployment remains a separate CLI operation and is not runtime startup or a readiness condition.

Discord application operations are admitted only in `READY`. An admitted top-level handler remains
tracked until its handler Promise settles. Handler settlement is not necessarily logical-operation
settlement: a thread-lifecycle operation that already returned `PENDING` may still own a raw Discord
mutation, finalization work, or an admitted deferred continuation. That retained work remains
process-locally tracked without extending the interaction wait budget.

The first shutdown request synchronously enters `SHUTTING_DOWN`, closes ingress, prevents another
startup step, and starts quiescing the health listener, every reconciler timer, automatic-close
timer, and worker poller before drain waiting. Shutdown first waits for every source that can create thread-lifecycle work:
the active startup step, admitted handlers, reconciliation sweeps, and worker callbacks. Only after
that source barrier does it drain retained thread-lifecycle work, followed by active health
requests and the physical health probe. One 30-second process-wide deadline covers all drain
stages, pg-boss stop, Discord destruction, application PostgreSQL close, and process-listener
removal. Discord and the application PostgreSQL pool remain available during
the bounded drain. pg-boss closes before Discord, and Discord closes before the application pool.

`SIGINT` and `SIGTERM` join the same idempotent shutdown. Successful normal signal shutdown selects
status 0; cleanup failure or deadline expiry selects status 1. `unhandledRejection` and
`uncaughtException` are fatal: the first closes ingress and starts or joins non-zero shutdown, while
a second fatal event or fatal shutdown deadline expiry forces immediate status-1 termination.
Lifecycle logging uses bounded identities and never includes raw errors, rejection reasons, stacks,
configuration, credentials, or message payloads.

Startup failure keeps its bounded startup-step identity as the primary failure and converges on the
same cleanup path. A cleanup failure is reported separately. Shutdown timeout never invents a
feature success, failure, or retry; restart continues to use existing PostgreSQL-authoritative
recovery and reconciliation.

#### Operational health observation

After configuration validation and process-handler installation, a Node HTTP listener binds only to
`127.0.0.1` on `HEALTH_PORT` (default `3000`, strict decimal port 1–65535) as the named first
startup step `health_listener_start`. It precedes PostgreSQL verification without changing the
relative dependency startup order. Listener startup does not enter `READY`; a bind failure uses the
existing bounded startup-failure cleanup.

`GET /health/live` returns HTTP 200 and exactly `{"status":"alive"}` without dependency checks.
`GET /health/ready` returns HTTP 200 and exactly `{"status":"ready"}` only if lifecycle state is
`READY`, the existing Discord client currently reports ready, and the application database completes
a read-only `SELECT 1` query. Otherwise it returns HTTP 503 and exactly
`{"status":"unavailable"}`. All responses use `Content-Type: application/json` and disclose no
failure reason. Readiness is an observation, not authority over application state or recovery. It
does not guarantee future Discord or PostgreSQL work, inspect pg-boss, or cause repair or writes.

Path matching ignores query strings but requires the exact pathname. Unknown paths return 404 with
`{"status":"not_found"}`. A known path with a method other than GET returns 405 with `Allow: GET`
and `{"status":"method_not_allowed"}`. HEAD follows the same status and header rules but sends no
body, including for unknown paths.

Each readiness request waits at most 2,000 ms for its PostgreSQL query. At most one physical
PostgreSQL health query may remain unresolved, including after its initiating HTTP request times
out. Concurrent requests may await that query within their own budgets; a settled result is never
cached. Late success or rejection is consumed without changing application state.

On entry to `SHUTTING_DOWN`, health probe admission closes synchronously and listener quiescence
begins. In-flight readiness rechecks lifecycle and Discord state before success. Health requests
and the physical query drain after the thread-lifecycle source and retained-work barriers, before
pg-boss, Discord, and the application database close. The existing 30-second process-wide deadline
remains the sole timeout authority. Compose checks readiness from inside the app container; the
health port is not published.

### Guild configuration

WEFT must store configuration separately for each guild.

Initial guild configuration includes:

- an IANA timezone identifier,
- the closed-thread title prefix,
- an optional audit-log destination,
- settings required by implemented features.

The default closed prefix is:

```text
[CLOSED]
```

The default guild timezone is:

```text
UTC
```

A guild administrator may configure another valid IANA timezone identifier.

The per-guild audit-log destination is disabled by default. `/config audit-log show` reads only
PostgreSQL state and displays the stored channel ID even if the Discord channel is no longer
available; a missing settings row is displayed as disabled without creating one. `/config audit-log
set channel:<channel>` accepts only guild text and announcement channels, re-fetches the current
channel and bot member, and requires the bot's effective `ViewChannel` and `SendMessages`
permissions. `/config audit-log disable` uses only PostgreSQL state. All three commands require
the invoking user's current `ManageGuild` permission. Exact repeated changes leave timestamps and
audits untouched. Real changes and their dedicated destination-change audits commit atomically.

PostgreSQL remains authoritative for configuration and audit history. Discord validation is a
point-in-time check. Phase 9B-2A does not send audit notifications; Phase 9B-2B will revalidate the
channel and permissions at delivery time and send best-effort notifications. The Discord channel
is never authoritative audit storage.

### Thread command structure

Thread operations are subcommands of the top-level `/thread` slash command.

The intended command surface is:

```text
/thread close
/thread open
/thread close-after
/thread cancel-close
/thread track
/thread untrack
/thread status
```

These commands may be implemented incrementally.

### Thread close

Closing a thread means:

1. adding the configured closed prefix to the beginning of the thread title,
2. archiving the thread without locking it.

Requirements:

- The invoking user must have the Discord `ManageThreads` permission.
- WEFT must verify its own required permissions.
- The current Discord state must be inspected before modification.
- WEFT must not change the thread's locked state as part of close.
- A locked thread must be rejected with a clear error instead of being modified.
- The configured prefix must not be duplicated.
- Repeated close operations must be idempotent.
- WEFT-managed state must be persisted.
- An active scheduled close for the same thread must be cancelled.
- The operation and its outcome must be audited.

The title prefix is a user-visible indicator. It is not the authoritative source of state.

### Thread open

Opening a thread means:

1. reconciling an active thread as open after Discord has unarchived it,
2. removing one WEFT-managed closed prefix from the beginning of the title.

Requirements:

- The invoking user must have the Discord `ManageThreads` permission.
- WEFT must verify its own required permissions.
- The current Discord state must be inspected before modification.
- WEFT must not change the thread's locked state as part of open.
- Repeated open operations must be idempotent.
- Only the managed leading prefix may be removed.
- A previously stored title must not overwrite later manual title edits.
- WEFT-managed state must be persisted.
- The operation and its outcome must be audited.

Discord may unarchive an unlocked thread when a user creates an interaction in it. WEFT must
reconcile an unlocked archived-to-active transition with its managed state. This reconciliation
must be serialized with explicit thread lifecycle commands for the same thread.

### Supported thread resources

The intended supported resources are:

- public threads,
- private threads that WEFT can access,
- forum posts represented by Discord as threads.

Unsupported contexts must receive a clear ephemeral error.

### Partial failures

Discord operations and PostgreSQL updates cannot be committed as one transaction.

If a request fails after only some effects have succeeded, WEFT must:

- avoid reporting complete success,
- classify and record the failure,
- preserve enough information for later reconciliation,
- perform compensation only when it is safe and predictable,
- reconcile the stored state with Discord later when necessary.

A Discord mutation may remain pending after the command stops waiting synchronously for its
result. Normal discord.js rate-limit queueing is not a failure or an unknown outcome solely
because it exceeds the caller wait budget. In this case, WEFT must:

- tell the caller that Discord is still processing the update, that rate limiting thread-name changes
  can be one cause without asserting it is the cause, and that completion may take several minutes,
- continue tracking the raw mutation without aborting it because the caller wait budget expired,
- prevent another Discord mutation for the same thread until mutation finalization completes,
- treat a later successful Discord response as confirmed success without an extra Discord fetch,
- reconcile current Discord state after a rejected raw mutation,
- keep background reconciliation boundaries single-flight and wait for each raw operation to
  settle before retrying it,
- retry transient reconciliation failures with backoff while retaining the per-thread guard,
- record the final success or failure audit only after the outcome and managed state are confirmed.

Returning a pending result must not create a failure or outcome-unknown audit.

### Scheduled thread closing

WEFT must support scheduling one future close for a thread.

Requirements:

- Only one active scheduled close may exist for the same guild and thread.
- Creating a new scheduled close replaces the existing active schedule by default.
- Cancelling a scheduled close is idempotent.
- An overdue scheduled close is executed after restart when it remains applicable.
- Discord state and permissions are revalidated immediately before execution.
- Creation, replacement, cancellation, execution, retry, and failure are audited.

### Automatic thread closing

WEFT must support policy-based closing of inactive managed threads.

The initial policy supports:

- an allowlist of managed parent channels,
- an inactivity duration,
- per-thread exclusion,
- whether bot messages count as activity.

By default, activity includes messages sent by human users.

By default, activity excludes:

- WEFT messages,
- messages from other bots,
- reactions,
- title changes,
- thread setting changes,
- WEFT configuration changes.

Bot messages do not count as activity by default.

Discord system messages never count as activity. This remains true when the guild enables
bot-message activity.

The default inactivity duration is 7 days.

The supported configurable inactivity range is 5 minutes through 365 days.

The parent-channel allowlist is empty by default. An empty allowlist produces no automatic-close
candidates, so no thread is automatically closed.

A thread may participate in automatic-close management only when:

1. it is a supported Discord thread resource,
2. its parent channel is in the guild's automatic-close allowlist,
3. it has no individual automatic-close exclusion.

A policy-level automatic-close candidate is a thread with recorded qualifying activity whose
stored parent is currently allowlisted, whose thread is not currently excluded, and whose guild
inactivity duration has elapsed at the sweep timestamp. Candidate eligibility is inclusive:

```text
last_activity_at + inactivity_duration <= as_of
```

Each sweep uses one caller-captured `as_of` value for every database page. A guild without a
settings row uses the seven-day default without creating a settings row. Candidate discovery is
provisional: current Discord state and permissions are revalidated separately before any close.

An automatic-close candidate identifies one recorded inactivity episode. Immediately before an
execution attempt, WEFT uses a newly captured timestamp to revalidate that the exact recorded
activity still exists, the current Discord parent still matches it, the current parent and thread
policy still permits automatic close, the current inactivity duration has elapsed, and that
episode has not already completed. A current explicit scheduled close in `ACTIVE` or `EXECUTING`
state takes precedence and causes automatic close to skip without changing that schedule.

Automatic inactivity closing uses the existing soft-close lifecycle behavior and records the
distinct `AUTO_CLOSE` action with a system actor. Manual and explicitly scheduled closes continue
to record `CLOSE`. A completed or already archived inactivity episode is retired so it is not
processed repeatedly. Retirement applies only to the matching recorded activity timestamp; newer
qualifying activity starts a new episode naturally.

When WEFT observes a supported archived thread become active, it establishes the observation time
as a monotonic re-entry inactivity baseline if the current parent is allowlisted and the thread is
not individually excluded. Reopening is not qualifying message activity and does not override
parent or exclusion policy. A reopened eligible thread may therefore become inactive and eligible
again after the configured duration even when no later message is posted.

PostgreSQL policy revalidation and Discord lifecycle work cannot form one atomic transaction.
Activity or policy committed before final revalidation prevents execution, while a change committed
after that read may race with the close. The lifecycle serialization and idempotent close behavior
keep concurrent close attempts safe without claiming cross-system atomicity.

The parent-channel allowlist is the higher-level policy. `/thread track` removes an individual
exclusion. It does not override a parent channel that is outside the allowlist.

Automatic closing uses a periodic database-driven sweep rather than replacing a delayed job after every message.

The initial sweep interval is five minutes.

The first sweep begins only after the initial five-minute runtime interval. Each later sweep begins
five minutes after the previous sweep settles, so long-running sweeps do not overlap. The
inactivity threshold is therefore an eligibility boundary rather than an exact wall-clock close
deadline: an eligible candidate is closed on a later sweep only after current state and permissions
are revalidated. Shutdown stops new sweep work and drains work already in progress, so unprocessed
candidates remain eligible for a later runtime.

Immediately before closing, WEFT must re-fetch the thread and revalidate its current state and permissions.

### Thread maintenance commands

The thread maintenance commands manage and inspect automatic-close participation for the current
supported thread. `/thread track`, `/thread untrack`, and `/thread status` take no options and
require the invoking user's current Discord `ManageThreads` permission. They do not require
`Administrator`, the bot's thread-management permission, or an active or unlocked thread. A
supported archived or locked thread remains a valid maintenance target when it has a parent
channel.

Effective automatic-close participation is enabled only when the current parent is allowlisted and
the thread has no individual exclusion. `/thread track` removes only the individual exclusion; it
never adds or overrides the parent allowlist. When track removes an exclusion under a currently
allowlisted parent, the track time is applied as a monotonic activity floor:

```text
last_activity_at = max(existing last_activity_at, tracked_at)
```

A missing row is inserted, an older row is advanced with the current parent, and an equal or newer
row is left completely unchanged, including its parent and update timestamp. Exclusion removal and
this required re-entry baseline operation commit in one PostgreSQL transaction. The track time is
captured only after current Discord context and user permission validation, and no database
transaction is held during that Discord work.

Repeated track does not reset or advance an existing inactivity timer. If the thread is already
individually included under an allowlisted parent but its activity row is missing, track repairs the
missing baseline with an insert-if-absent operation only. If the parent is not allowlisted, track
may remove the exclusion but does not create, reset, or advance activity; effective automatic close
remains disabled.

`/thread untrack` idempotently adds the individual exclusion without requiring an allowlisted
parent. It preserves the activity row exactly. Track and untrack do not create, replace, cancel, or
otherwise change an explicit scheduled close.

`/thread status` is read-only. It reports the effective automatic-close state, current parent
policy, individual exclusion, configured inactivity duration, last recorded qualifying activity
when present, and the current explicit scheduled close. Activity comes only from PostgreSQL, not
Discord history. A missing guild-settings row uses the approved seven-day inactivity default
without creating settings or repairing any other state. The scheduled-close field shows the
execution timestamp for an `ACTIVE` close, `executing` for an `EXECUTING` close, and `none` when no
current close exists; terminal history and non-close actions are ignored.

### Managed message command structure

Managed-message operations are subcommands of the top-level `/message` slash command.

The MVP includes:

```text
/message send
/message edit
```

### Managed message send

WEFT sends the message as the WEFT bot.

`/message send` targets the current supported guild text, announcement, or active thread channel.
The modal contains optional fields for plain content, one embed title, one embed description, one
embed color, and one embed image URL. A valid message may be text-only, embed-only, or combined,
but it must contain plain content or a visible embed title, description, or image. An embed color
alone is not visible content. Plain content supports normal URLs, and user-provided mentions are
suppressed so they do not notify users or roles by default.

The invoking user must have the current `ManageMessages` permission. Immediately before sending,
WEFT must inspect the current Discord target and verify its own effective permission and
sendability. It must not unarchive a thread or join a private thread to make the target sendable.

A successful operation must record:

- guild ID,
- channel ID,
- Discord message ID,
- creator user ID,
- current revision,
- creation timestamp,
- lifecycle status.

The initial send implementation persists this managed-message metadata only after Discord confirms
the send. New managed-message creation commits the managed row and its `CREATED` audit atomically.
Rows created before creation-audit support remain valid managed messages without fabricated
historical audit records.

User-provided content must not generate mentions by default.

Long-form content should be entered through a Discord modal rather than being forced into a single slash-command text option.

### Managed message edit

`/message edit message:<id-or-link>` accepts either a Discord message ID or a canonical
`discord.com` message link. The target must belong to the current guild and current channel. WEFT
loads the current persisted plain content and managed embed into the five-field modal and binds the
modal to that managed message's revision. A stale modal is rejected as a conflict rather than
overwriting a later edit.

An authorized administrator may edit a managed message through WEFT even when that administrator
did not create the original message. The administrator's current `ManageMessages` permission and
the bot's current access and editability are revalidated when the modal is submitted. Editing
preserves accepted non-empty plain content exactly and suppresses automatic mention parsing. It may
add, change, or remove the managed embed and may clear plain content when a visible managed embed
remains.

Before either a no-op or an actual edit, WEFT freshly inspects the Discord message and requires its
current plain content and projected managed rich embed to equal the complete persisted managed
payload. A mismatch is reported for administrator inspection and neither side is silently
repaired. A no-op therefore still requires current authorization, Discord existence, WEFT
authorship, editability, and complete payload coherence. Any plain-content or managed-embed change
increments the single managed-message revision once and records one complete before/after audit.

A successful edit must record:

- the previous value,
- the new value,
- the editor user ID,
- the new revision,
- the edit timestamp,
- the related audit event.

Concurrent edits must not silently overwrite each other.

If Discord confirms that the message no longer exists, WEFT atomically changes the managed
lifecycle state from `ACTIVE` to `DELETED` and records a `DELETION_DETECTED` system audit without
changing content or revision. No proactive message-deletion listener or periodic reconciliation is
required for this edit-time detection.

Successful managed-message creation, edit, and deletion detection commit dedicated audit records.
Discord and PostgreSQL cannot form one transaction, so bounded partial failures remain possible.
When an edit reaches Discord but managed-state finalization cannot be confirmed, WEFT may restore
the complete prior Discord payload once only after fresh PostgreSQL and Discord reads prove that
restoration is safe. Exact confirmation and compensation safety include every supported embed
property.

### Managed message authorization

Managed-message operations require the Discord `ManageMessages` permission in the MVP.

WEFT must also verify its own permission to send or edit the target message.

### Managed message content

The MVP supports:

- plain text,
- normal URLs,
- one explicitly authored Discord rich embed per managed message.

The managed rich embed supports only a title, description, color, and image URL. Embed fields,
footer, author, thumbnail, title URL, timestamp, raw embed JSON, and multiple managed embeds are not
supported. The modal maximums are 2000 Unicode code points for plain content, 256 UTF-16 code units
for the title, 4000 UTF-16 code units for the description, and 2048 code units for the image URL.

Embed title and description are outer-trimmed while internal whitespace is preserved. Blank embed
fields are absent. Color accepts exactly `RRGGBB` or `#RRGGBB`, is normalized to an integer, and is
prefilled for editing as uppercase `#RRGGBB`. Image URLs are outer-trimmed, must be absolute HTTP or
HTTPS URLs, and use WHATWG URL serialization. WEFT performs no network request, DNS lookup, MIME
inspection, download, proxying, or logging of the image URL or managed payload.

Discord may create non-rich preview or media embeds from ordinary URLs in plain content. Documented
non-rich preview/media embed types are ignored when comparing managed state. A missing or invalid
embed type, unknown type, multiple rich candidates, or unsupported rich state is treated
conservatively as a state mismatch. Embed `type` is a Discord rendering classification, not a
guaranteed provenance marker.

Attachments and persistent attachment storage are not supported.

Successful creation, edit, and deletion-detection audits contain the complete managed payload.
Failed-operation audit completion remains deferred.

WEFT must not imitate individual users through webhook names or avatars.

### Scheduled messages

WEFT must support:

- one-time scheduled managed messages,
- recurring managed messages.

Requirements:

- Schedules are persisted in PostgreSQL.
- Jobs are executed through pg-boss.
- Absolute timestamps are stored with timezone information.
- Recurring schedules use IANA timezone identifiers.
- Transient failures use bounded retries.
- Permanent failures are recorded explicitly.
- Recurring messages do not replay every missed occurrence after downtime.
- Overdue one-time messages execute once only when they remain within the configured grace period.
- Successful scheduled sends persist the resulting Discord message ID.
- Schedule creation, modification, cancellation, execution, retry, and failure are audited.

An overdue one-time scheduled message may execute once through the inclusive 60-minute grace
boundary: it is eligible while `now <= execute_at + 60 minutes` and is outside the grace period
when `now > execute_at + 60 minutes`.

The one-time `SEND_MESSAGE` delivery queue uses a retry limit of 3, a retry delay of 30 seconds,
exponential backoff, and a maximum retry delay of 900 seconds. These values are specific to
scheduled-message delivery rather than shared scheduler defaults. Its delivery expiration is 900
seconds.

Scheduled-message execution reloads the authoritative action and payload from PostgreSQL. It does
not revalidate the original creator's current guild membership, roles, or `ManageMessages`
permission. It does freshly inspect the target guild and channel, active thread state, and WEFT's
current view/send permissions; an explicit rich embed also requires `EmbedLinks`.

Application-authorized retry is bounded to three safe failures before any Discord Create Message
request capable of creating the message has occurred. Each such retry is persisted and audited.
Create Message uses mention suppression and a stable action-derived nonce. An ambiguous request is
replayed at most once immediately with the same nonce and is never followed by a delayed blind
resend. A returned message must match the intended guild, channel, bot author, canonical payload,
and the nonce when Discord returns one.

Once Discord creation is confirmed, that action can never return to active delivery. Successful
database finalization atomically establishes the completed schedule, result message ID, managed
message, managed-message creation audit, and scheduled execution audit. A safely confirmed
compensation deletion after finalization failure is terminal rather than retryable. If database
commit status cannot be determined, WEFT neither deletes nor resends. On startup, an interrupted
`EXECUTING SEND_MESSAGE` action fails conservatively as unconfirmed instead of being released for
another send.

Recurring managed messages use structured, calendar-oriented input and IANA timezone semantics.
Raw cron expressions are not accepted through the user-facing Discord interface.

The recurring scheduling foundation supports daily execution at one local `HH:MM` and weekly
execution on a non-empty selection of weekdays at one local `HH:MM`. Daily schedules are stored
canonically as all seven selected weekdays. Monthly, nth-weekday, last-day, arbitrary interval,
start-date, end-date, occurrence-count, raw cron, and user-facing RRULE schedules are not
supported.

Each recurring series snapshots a normalized named IANA timezone. `UTC`, named zones, and named
links or aliases are accepted; numeric UTC offsets are rejected. Link or alias identity is
preserved after case normalization rather than rewritten to a different primary-zone identifier.
Calendar advancement uses local dates and times rather than fixed 24-hour or 168-hour instant
arithmetic.

For a local time in a daylight-saving overlap, WEFT selects only the earlier instant. For a local
time in a daylight-saving gap, WEFT creates no occurrence and records a `DST_GAP_SKIPPED` audit.
It does not shift the intended local time. The disambiguation algorithm compares both Temporal
`earlier` and `later` round trips and does not assume a one-hour transition.

Series creation and recurrence or timezone editing use one caller-established timestamp for the
definition effective boundary, mutation audit, strictly-after candidate selection, and exact
persistence confirmation. A materialized occurrence's absolute `scheduled_for` instant never
changes. Future materialization uses current timezone data and the latest current recurrence
definition.

Recurring downtime recovery considers only the latest eligible missed calendar occurrence. It may
materialize that one occurrence through the inclusive 15-minute missed grace boundary; older
missed occurrences are represented as one explicit skipped-range audit rather than one row per
calendar event. If the latest occurrence is also outside grace, advancement proceeds to the first
future occurrence. DST gaps crossed during downtime are audited once per definition revision and
intended local date and time, without creating occurrence rows for skipped dates. A safe pre-send
retry chain has a separate inclusive 15-minute lifetime from its first attempt and a persisted
retry budget of three.

`scheduled_actions` remains the scheduling envelope and `scheduled_message_states.revision` is the
single series revision. A row in `recurring_message_schedules` is the recurring discriminator.
Payload edits increment the series revision without changing the definition revision or replacing
the current occurrence. Recurrence and timezone edits increment the series revision, set the
definition revision to that value, and replace a pending occurrence atomically. An executing or
retry-pending occurrence retains its immutable claim snapshot and defers future materialization.
Cancellation increments the series revision, prevents future materialization, skips a pending or
retry-pending occurrence, and does not attempt to stop an already executing external operation.

At most one pending, executing, or retry-pending occurrence may exist for a series. Occurrence
materialization is unique by series, definition revision, intended local date, and intended local
time. Initial execution claim atomically snapshots the current canonical payload and the current
series and definition revisions. Recurring state-changing persistence uses stable operation
identities and exact read-only confirmation rather than blind write retry. Materialization uses a
stable occurrence ID and immutable occurrence fields as historical evidence when the transaction
response is lost; while it remains pending, confirmation also checks its initial lifecycle shape
and the updated execution time.

Recurring occurrence execution uses the dedicated `weft-recurring-message-occurrence` pg-boss
queue with exclusive policy, no built-in retry, and 900-second expiration. Delivery is a timed
projection. PostgreSQL occurrence state and `OCCURRENCE_RETRY` audit time determine eligibility and
retry wake time. Delivery generations use retry counts zero through three and a singleton key
formed from the occurrence ID and generation. Queue state never authorizes execution.

Initial execution validates authoritative state and payload, performs fresh Discord preflight,
then claims `PENDING -> EXECUTING`. Only the claim winner may send or record a preflight failure.
Retry continuation preserves the original claim payload and requires a winning
`RETRY_PENDING -> EXECUTING` transition. Pre-send `CURRENT_STATE_CHECK_FAILED` may create the next
retry only if the failure was observed within 15 minutes of the first attempt, the retry budget is
not exhausted, and the 30-second wake remains within that inclusive deadline. These checks occur
in that order; only an allowed retry increments the count and inserts one retry audit.

Discord Create Message uses mention suppression, an occurrence-derived nonce, and at most one
immediate same-nonce replay after ambiguity. A definite initial rejection is terminal
`SEND_REJECTED`; ambiguity unresolved after replay is terminal `SEND_UNCONFIRMED`. A returned
message must match the guild, channel, bot author, payload, and non-null nonce. No possible
post-send effect returns to pre-send retry.

Concrete success atomically records occurrence completion, resulting managed message and creation
audit, occurrence audit, and the next occurrence. Terminal failure atomically records its failure
audit and next occurrence. Active series advance from the latest recurrence definition; cancelled
series record explicit no-next history. Finalization response loss uses read-only exact confirmation.
Compensation deletes a known Discord message only when PostgreSQL finalization is proven absent;
an unknown result causes neither deletion nor resend.

Startup reconciliation recovers pending and retry-pending delivery and terminalizes orphaned
executing occurrences as `EXECUTION_INTERRUPTED_UNCONFIRMED` without resending. Runtime
reconciliation runs non-overlapping 60-second sweeps over bounded pages and repairs missing
projections and missed pending work. Active series without a nonterminal row use the current
definition and terminal history to derive a safe candidate; an unreadable basis is left unresolved.
Runtime reconciliation does not fail a live executing occurrence based on queue
absence. Retry expiry uses a separate PostgreSQL transition that requires the occurrence still be
`RETRY_PENDING` at the expected retry count after locking the series and occurrence. A concurrent
resume to `EXECUTING` wins over stale expiry reads, and expiry never terminalizes that live send.
Scheduled messages expose these commands:

```text
/message schedule create after:<duration>
/message schedule recurring-create frequency:<daily|weekly> time:<HH:MM> [weekdays:<weekday-list>] [timezone:<IANA>]
/message schedule cancel id:<schedule-id>
/message schedule status id:<schedule-id>
/message schedule list [page:<positive-integer>]
/message schedule edit id:<schedule-id>
/message schedule reschedule id:<schedule-id> after:<duration>
/message schedule recurrence-edit id:<schedule-id> frequency:<daily|weekly> time:<HH:MM> [weekdays:<weekday-list>] [timezone:<IANA>]
```

`create` and `reschedule` are one-time only. `recurring-create` and `recurrence-edit` are recurring
only. `cancel`, `status`, `list`, and `edit` support both kinds while preserving the recurring
discriminator in all one-time persistence and runtime paths. A recurring ID passed to
`reschedule` is directed to `recurrence-edit` without mutation.

Daily recurrence omits `weekdays` and persists the all-weekday mask. Weekly recurrence requires a
non-empty comma-separated selection of unique `mon,tue,wed,thu,fri,sat,sun` tokens; token case
and whitespace around commas are ignored. Both use strict `HH:MM` local time. An explicit
timezone must be a named IANA identifier or `UTC`, including valid links and aliases; numeric
offsets are rejected. When timezone is omitted at creation, WEFT validates and snapshots the
current guild timezone at payload modal submission. A later guild setting change does not alter
the series. An edit without a timezone option preserves the persisted series timezone.

Recurring creation revalidates recurrence, payload, target, actor, and bot permissions on modal
submission and writes no series before then. Confirmed creation projects its initial pending
occurrence to pg-boss after commit. Projection failure leaves the PostgreSQL series authoritative
and pending reconciliation.

Recurring payload edit is permitted while an active series has a pending, executing, or retrying
occurrence. A changed payload increments the unified revision once without changing the current
occurrence or an in-flight claim snapshot. Exact canonical no-ops neither revise nor audit.
Recurrence edit validates expected unified revision under the series lock and compares the complete
normalized definition there. An exact no-op leaves revision, audit, occurrence, execution time,
and projection unchanged. A changed edit replaces a pending occurrence atomically. Executing or
retry-pending work remains immutable and future materialization is deferred. The committed result
records whether that particular edit created a replacement, including its identity and scheduled
time. Response-loss confirmation reads the stable audit to recover that historical effect. Only
an immediate replacement still observed as active and pending is projected; a concurrent change
after that read may leave a stale job, which execution revalidates against PostgreSQL.

Shared cancellation is revision-checked and idempotent when already cancelled. A pending or
retry-pending occurrence is skipped; an executing occurrence remains in flight. Shared status is
read-only and payload-free for recurring series. Shared list combines one-time and recurring
nonterminal schedules in `(execute_at, scheduled_action_id)` order before ten-row pagination.
For recurring rows, `execute_at` is the next scheduled occurrence only while current work is
`PENDING`; during execution or retry it is the current occurrence's original scheduled instant,
and after cancellation it may be historical. It is never the retry wake time. User mutations
compete on the unified revision; a stale edit or cancellation reports conflict without blind retry.

One-time creation accepts one relative duration from `1m` through `365d`, using a single `m`, `h`, or `d`
unit. The delay begins only after modal submission and fresh authorization succeed. Creation
revalidates the target, active thread state, actor membership and `ManageMessages`, and WEFT's
view/send permissions; an explicit rich embed also requires `EmbedLinks`. Creation persists the
active schedule and `CREATED` audit before enqueueing delivery and never sends the Discord message
itself. A confirmed schedule remains active when initial delivery enqueueing cannot be confirmed;
runtime reconciliation repairs missing delivery.

One-time cancellation and status are scoped to the current guild and channel and require `ManageMessages`.
They remain available in an archived supported thread and do not require WEFT's current send
permission. One-time cancellation changes only `ACTIVE` to `CANCELLED`, atomically records a user-attributed
`CANCELLED` audit, and never overwrites executing or terminal state. Delivery cleanup failure does
not undo confirmed cancellation. Status is read-only and does not expose the scheduled payload.
Completed status includes a canonical Discord message link when the result message ID is present.

For one-time messages, list includes `ACTIVE` and `EXECUTING` rows. The combined list uses the
same current-guild/channel scope, execution-time and schedule-ID ordering, and fixed ten-row pages.
Each row contains the full schedule ID, status, execution time, and creator ID. It never returns
scheduled content and performs no Discord, pg-boss, repair, or database mutation work.

Edit is available only while a one-time schedule remains `ACTIVE`. It loads the current canonical
managed-message payload into the existing five-field modal and binds the form to the persisted
scheduled-message revision. Submission revalidates the current guild, channel, administrator
permission, canonical payload, active state, and expected revision. An exact payload no-op changes
nothing. A successful edit replaces the complete payload, increments revision once, and commits an
`EDITED` user audit atomically. A stale form never overwrites a later edit or reschedule.

Reschedule accepts the same `1m` through `365d` single-unit relative duration as creation. The new
execution time is derived from the reschedule establishment time, not from the old execution time.
Only `ACTIVE` schedules may change. A successful reschedule updates only execution time and the
scheduled-message revision, preserves payload, creator, retry count, and result state, and commits
a complete `RESCHEDULED` user audit atomically.

For one-time schedules, the persisted scheduled-message revision starts at zero and increments exactly once for each
successful edit or reschedule. Execution loads the authoritative revision before Discord preflight
and must still match it while atomically claiming `ACTIVE` to `EXECUTING`. Thus an edit or
reschedule that commits during preflight prevents the stale executor from creating a Discord
message; a claim that commits first prevents the administrative mutation. Cancellation, safe
pre-send retry, failure, and finalization do not change revision.

Scheduled-message delivery payloads include the action ID, canonical projected execution time, and
projected revision while remaining backward compatible with older ID-only deliveries. PostgreSQL
state and the revision-aware claim remain execution authority. A projected revision difference
alone does not stale a delivery when the authoritative execution time is unchanged after a
payload-only edit.

Created delivery is current only when its projected time and effective start time match the
authoritative execution time. Retry and active delivery use the projected execution time because a
retry start time is its next retry wake time. Created and retry delivery are updated in place with
the public pg-boss `upsert()` API. A stale active delivery is cancelled and confirmed ineffective
before current delivery is upserted. Terminal history does not suppress repair. Legacy created
delivery is adopted only when its effective time matches; legacy retry delivery may be upgraded in
place without resetting its retry wake time; legacy active delivery is cancelled conservatively
before replacement. Startup and runtime reconciliation apply these timing-aware rules and leave an
unconfirmed repair pending for a later sweep rather than guessing.

Scheduled-message administration requires the Discord `ManageMessages` permission in the MVP.

A schedule remains active if its creator later loses a role or leaves the guild unless an administrator explicitly disables or deletes it.

### Scheduling guarantees

Discord API effects and PostgreSQL updates cannot be committed as one transaction.

WEFT must reduce duplicate execution using:

- persistent execution state,
- stable action identifiers,
- uniqueness constraints,
- pre-execution state checks,
- recorded Discord message IDs,
- Discord-supported duplicate-reduction mechanisms where applicable.

WEFT does not claim mathematically strict exactly-once delivery.

### Authorization

The MVP uses direct Discord permission checks.

- Bot configuration requires `ManageGuild`.
- Thread lifecycle operations require `ManageThreads`.
- Managed-message operations require `ManageMessages`.
- Scheduled-message administration requires `ManageMessages`.

WEFT must also check its own relevant Discord permissions before execution.

WEFT must not require the Discord `Administrator` permission.

A custom capability-to-role system is not part of the initial MVP.

### Audit

WEFT must record administrative state changes.

Audit records should include, when applicable:

- guild ID,
- actor user ID,
- action,
- target type,
- target Discord ID,
- before value,
- after value,
- optional reason,
- correlation ID,
- timestamp,
- outcome.

Audit coverage includes:

- thread close and open,
- automatic and scheduled thread closing,
- schedule changes and executions,
- managed-message creation and editing,
- guild configuration changes,
- authorization-related configuration changes,
- failed administrative operations.

The initial default audit retention period is 90 days.

Retention cleanup must not delete state required to recover active schedules.

Whether retention is configurable per guild remains unresolved.

### Message safety

Messages containing user-provided content must suppress mentions by default.

The default behavior is equivalent to Discord `allowed_mentions` with no automatic parsing.

User-facing errors must not expose:

- secrets,
- stack traces,
- database details,
- inaccessible channel names,
- inaccessible message content.

## Deferred ideas

The following ideas are outside the MVP and do not yet have an approved implementation design:

- Discord message-link previews,
- polls,
- reaction-role assignment,
- monitoring message edits and deletions,
- bulk thread closing,
- reaction-based solved state.

Do not implement or document detailed designs for these features until they are explicitly approved.

## Non-goals

WEFT is not intended to:

- impersonate human users,
- support direct-message use in the initial version,
- provide arbitrary user-defined code execution,
- become a general-purpose workflow platform,
- replace Discord's complete moderation system,
- use microservices without a demonstrated requirement,
- guarantee strict exactly-once Discord delivery.

## Unresolved decisions

The following decisions must be made before their corresponding implementation work:

- whether audit retention will be configurable per guild.
