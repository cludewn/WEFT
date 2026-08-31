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

The initial `/message send` implementation targets the current supported guild text,
announcement, or active thread channel. Content is entered through a Discord modal. It supports
plain text and normal URLs, and it suppresses user-provided mentions so they do not notify users or
roles by default. Embed authoring remains part of the overall MVP but is not implemented in this
initial slice.

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
loads the current persisted content into a modal and binds the modal to that managed message's
revision. A stale modal is rejected as a conflict rather than overwriting a later edit.

An authorized administrator may edit a managed message through WEFT even when that administrator
did not create the original message. The administrator's current `ManageMessages` permission and
the bot's current access and editability are revalidated when the modal is submitted. Editing
preserves the submitted content exactly and suppresses automatic mention parsing.

Before either a no-op or an actual edit, WEFT freshly inspects the Discord message and requires its
current content to equal the persisted managed content. A mismatch is reported for administrator
inspection and neither side is silently repaired. A no-op therefore still requires current
authorization, Discord existence, WEFT authorship, editability, and content coherence.

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
the prior Discord content once only after fresh PostgreSQL and Discord reads prove that restoration
is safe.

### Managed message authorization

Managed-message operations require the Discord `ManageMessages` permission in the MVP.

WEFT must also verify its own permission to send or edit the target message.

### Managed message content

The MVP supports:

- plain text,
- normal URLs,
- Discord embeds.

Plain-text managed-message send and edit are implemented before embed authoring. The final embed
creation and editing interface remains unresolved MVP work.

The MVP does not include persistent attachment storage.

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

The exact overdue grace period and retry parameters must be decided before scheduled-message implementation.

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

- the exact overdue grace period for one-time scheduled messages,
- retry count and backoff parameters for scheduled messages,
- the command input format for recurring schedules,
- the final embed creation and editing interface,
- whether audit retention will be configurable per guild.
