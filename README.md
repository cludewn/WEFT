# WEFT

WEFT is a self-hosted Discord bot focused on thread management and persistent scheduled actions.

The project is in its initial development phase and is not ready for production use.

Product behavior is defined in [`docs/specification.md`](./docs/specification.md). Architecture and development workflow are documented in [`docs/development.md`](./docs/development.md).

## Requirements

- Node.js 24
- Corepack
- PostgreSQL 18
- Docker and Docker Compose for the provided development database

## Setup

Install dependencies through the pnpm version pinned in `package.json`:

```sh
corepack pnpm install --frozen-lockfile
```

1. Create or select a Discord application and bot in the Developer Portal. Record the **Discord
   Application ID** (not the Bot User ID) and obtain the bot token securely.
2. Under **Installation**, support **Guild Install** only; User Install is unsupported. Use the
   **Discord Provided Link** and set **Default Install Settings** for Guild Install to the `bot`
   and `applications.commands` scopes. Although bot authorization includes application commands,
   select both scopes to make the intended installation explicit.
3. Select these bot permissions for full WEFT functionality: **View Channels**, **Manage Threads**,
   **Send Messages**, **Send Messages in Threads**, **Read Message History**, and **Embed Links**.
   Do not grant Administrator. Enable **Message Content Intent** under **Bot → Privileged Gateway
   Intents** in the Developer Portal for message-link detection. **Server Members Intent** and
   **Presence Intent** remain unnecessary and should stay disabled.
4. Install the application into each target guild using the generated link. Installation grants a
   maximum permission set; channel and thread overwrites can reduce WEFT's effective permissions,
   causing runtime checks to reject an operation. Private thread access also depends on Discord
   visibility rules: WEFT does not automatically join private threads. Sending to an archived
   thread does not automatically unarchive it.
5. Configure WEFT from `.env.example`, prepare PostgreSQL, and run the explicit production migration
   described below before startup. Deploy application commands separately as described below.
6. Start WEFT, verify `GET /health/ready`, then run `/ping` in the guild.

Copy `.env.example` to `.env` for local Docker Compose use, then replace the example passwords and Discord placeholders. Normal application startup requires the bot token and Discord Application ID. `DISCORD_GUILD_ID` selects only the default guild command deployment target; it does not restrict runtime to one guild and is unnecessary for global command deployment or normal startup. Do not commit `.env` files.

Commands run directly on the host do not load `.env` automatically. Provide the same variables through the local shell or environment-management tool before running the application, Drizzle Kit, or PostgreSQL integration tests.

## Environment variables

| Name                     | Required                             | Description                                                                    |
| ------------------------ | ------------------------------------ | ------------------------------------------------------------------------------ |
| `DATABASE_HOST`          | Yes                                  | PostgreSQL host                                                                |
| `DATABASE_PORT`          | Yes                                  | PostgreSQL port between 1 and 65535                                            |
| `DATABASE_NAME`          | Yes                                  | PostgreSQL database name                                                       |
| `DATABASE_USER`          | Yes                                  | PostgreSQL user                                                                |
| `DATABASE_PASSWORD`      | Yes                                  | PostgreSQL password                                                            |
| `DATABASE_SSL`           | No                                   | Set to `true` to require certificate-verified TLS; defaults to `false`         |
| `LOG_LEVEL`              | No                                   | Pino log level; defaults to `info`                                             |
| `HEALTH_PORT`            | No                                   | Local health listener port; defaults to `3000`                                 |
| `DISCORD_TOKEN`          | Yes                                  | Discord bot token; never logged or format-validated                            |
| `DISCORD_APPLICATION_ID` | Yes                                  | Discord application ID                                                         |
| `DISCORD_GUILD_ID`       | For default guild command deployment | Guild targeted by the default deployment mode; not a runtime guild restriction |

## Discord commands

Guild installation, application-command registration, and runtime startup are separate operations.
Normal runtime startup (`node dist/index.js`) does not register application commands. Deploy commands
explicitly to the configured development guild:

```sh
corepack pnpm commands:deploy
```

Global deployment must be selected explicitly:

```sh
corepack pnpm commands:deploy -- --global
```

PostgreSQL integration tests use a separate set of required variables and never fall back to the application database settings:

| Name                     | Required | Description                                        |
| ------------------------ | -------- | -------------------------------------------------- |
| `TEST_DATABASE_HOST`     | Yes      | Dedicated test PostgreSQL host                     |
| `TEST_DATABASE_PORT`     | Yes      | Dedicated test PostgreSQL port between 1 and 65535 |
| `TEST_DATABASE_NAME`     | Yes      | Dedicated test database name                       |
| `TEST_DATABASE_USER`     | Yes      | Dedicated test database user                       |
| `TEST_DATABASE_PASSWORD` | Yes      | Dedicated test database password                   |
| `TEST_DATABASE_SSL`      | Yes      | Set to `true` to require certificate-verified TLS  |

## PostgreSQL

Start the PostgreSQL development service:

```sh
docker compose up -d postgres
```

PostgreSQL is published only on `127.0.0.1` at `DATABASE_PORT`. Its data is stored in the `postgres-data` named volume.

## Operational health

WEFT serves `GET /health/live` and `GET /health/ready` on `127.0.0.1:HEALTH_PORT` (default
`3000`). Liveness returns `200` with `{"status":"alive"}` when the local listener responds.
Readiness returns `200` with `{"status":"ready"}` only after application startup is complete,
Discord currently reports ready, and a read-only PostgreSQL query succeeds. Otherwise it returns
`503` with `{"status":"unavailable"}`. Readiness is an observation of those three conditions;
it does not guarantee that a later Discord or database operation will succeed or trigger recovery.

Docker Compose checks readiness inside the app container every 30 seconds, with a 5-second timeout,
three retries, and a 60-second startup grace period. The health port is not published to the host.
A timed-out readiness request leaves any unfinished database query owned by the process until it
settles or the shared shutdown deadline expires; no second physical health query starts meanwhile.

## Confirmed interactive bulk thread closing

Run `/thread bulk-close` to open the setup Modal. Select one text, announcement or forum parent,
then optionally select an Owner, enter Name contains, or enter Created older than. Submit the Modal,
review the ephemeral candidate selection, select or deselect threads, then Confirm selected threads.

Filtered example: choose the help parent and Name contains `resolved`; matching candidates initially
start selected, so you can deselect exceptions. Combine Owner, Name contains and Created older than
with AND. Names use literal, case-sensitive substring matching, including nonblank edge spaces.
Owner means the current Discord thread creator. Empty or whitespace-only text leaves a filter unset.
Created older than `30d` means **created at least 30 days ago, not inactive for 30 days**. It accepts
one positive `m`, `h` or `d` duration from one minute through 365 days. Threads without a usable
Discord creation timestamp cannot match that filter.

Unfiltered example: choose the questions parent and leave every optional filter blank. All otherwise
eligible candidates appear, but **none starts selected**. Explicitly pick the threads to close.
Zero selected threads cannot be confirmed.

Active, unlocked public/announcement/forum threads are supported, including unmanaged threads.
Private and archived threads are excluded. More than 50 candidates rejects the whole operation;
configure or narrow filters. The String Select shows ten candidates per page, with at most five pages.
Selections persist across Previous/Next navigation. Clear page removes only that page's selections.
Review every candidate as needed; Confirm is required even for one thread. Only the initiator can
use the controls. The session expires after five minutes; selection and navigation do not extend it.

The candidate snapshot never gains threads. Confirm freezes exactly the current selected subset;
deselected candidates never execute. Current state, filters or permissions can still cause skips.
Closing adds the configured prefix and archives without locking. It may cancel an active scheduled
close; cancellation is not restored if the later close fails or remains Pending. Execution uses a
shared maximum of three unresolved bulk operations and stops starting new targets five minutes after
confirmation. The aggregate distinguishes selected, attempted, closed, already closed, pending,
failed/unconfirmed and skipped. Selected counts the frozen subset, not all candidates. Pending work
can finish later; failed/unconfirmed does not prove Discord remained unchanged. This is a partial
batch, not an all-or-nothing transaction. Restart invalidates setup/selection sessions and never
resumes unstarted targets.

## Message-link previews

WEFT displays up to three preview/button items from distinct same-guild Discord message links in
new human messages, examining a bounded set of candidates.
Configure the persistent mode with `/config link-preview show` and `/config link-preview mode
value:<hybrid|public-only|button-only|off>`. These commands require Manage Server; `/config show`
also displays the mode. The default is `hybrid`.

- `hybrid`: automatically preview conservatively proven public targets; otherwise show a generic
  Preview button. Confirmed age-restricted targets are omitted.
- `public-only`: preview only proven public targets.
- `button-only`: post generic buttons without looking up targets until clicked.
- `off`: disable detection output and existing buttons. Existing buttons also fail in `public-only`.

Buttons check the clicking user's current access and return previews ephemerally. Age-restricted
channels and threads with age-restricted direct parents are unsupported, including for owners and
administrators. Unconfirmed access or age state returns the same generic failure as a missing message.
Previews are point-in-time copies; subsequent permission changes, message edits and deletions do not
update or remove them. There is no preview history or monitoring. Source messages receive at most one
reply containing public AUTO embeds followed by Secondary Preview buttons, without helper explanation
text. A single distinct supported link uses `Preview`; multiple links use `Preview N` according to
their source appearance order, including public and omitted links in the count.
In public-only, non-public candidates do not consume visible slots. `+N more` counts eligible items
beyond the three visible slots plus supported-looking links beyond the examination budget. Examined
non-public candidates in public-only and confirmed age-restricted candidates are excluded from this
count. Unexamined links are counted locally without confirming target existence or access.
Buttons and overflow text disclose no protected target metadata. Authorized previews show
actual channel or parent/thread names and a timestamp, without preview labels or omission counts.
AUTO embeds have no Open original button; every successful button-triggered ephemeral preview has
one. Mentions are suppressed, text spoilers are omitted and only the first eligible image is shown.
WEFT never explicitly joins, leaves, modifies, unlocks or unarchives source threads to create a
preview. Archived or locked sources receive no preview reply. Sending to an active public,
announcement or forum-post thread may add WEFT as a member through Discord's normal send behavior.
Private source threads require fresh existing bot membership, even with ManageThreads or Administrator.

Message Content Intent is a separate Developer Portal requirement; the existing six bot permissions
are unchanged. Selecting `off` does not dynamically remove the Client's Gateway intent.

## Audit-log destination

The optional per-guild destination is disabled by default. An administrator with `ManageGuild`
can use `/config audit-log show`, `/config audit-log set channel:<channel>`, and `/config audit-log
disable`. The destination must be a guild text or announcement channel where WEFT currently has
`ViewChannel` and `SendMessages`. `show` reads the stored ID without changing settings or checking
Discord; `disable` also works if the channel has been deleted. Discord validation during `set` is
point-in-time. PostgreSQL stores the authoritative configuration and change audits. Newly committed
audits are also projected as best-effort Discord notifications when a current destination is
configured; PostgreSQL remains the authoritative audit history.

## Audit notifications

WEFT sends metadata-only, plain-text notifications for newly committed thread, scheduled thread-close,
managed-message, scheduled-message, recurring-message, audit-destination, and link-preview mode audits. Message content,
embed fields, names, raw errors, and arbitrary before/after values are excluded. Mentions are
suppressed. Before each send, WEFT reads the current destination from PostgreSQL, force-fetches the
Discord channel and bot member, and checks the bot's current `ViewChannel` and `SendMessages`
permissions. Disabling the destination normally sends no notification.

Delivery is best effort and process local. A stable source-and-audit-ID nonce reduces duplicates,
but ordering and exactly-once delivery are not guaranteed. Failed or ambiguous sends are not retried.
There is no startup replay or historical backfill; a crash may lose a notification while its
PostgreSQL audit remains committed. Graceful shutdown drains accepted notification work within the
existing process-wide deadline before Discord and PostgreSQL close.

## Audit retention

WEFT retains audit history for a fixed global period of 90 * 24 hours. Cleanup covers the seven thread, scheduled thread-close, managed-message, scheduled-message, recurring-message, audit-log-destination, and link-preview mode audit tables. An initial sweep is scheduled shortly after runtime startup without blocking readiness; later sweeps start 24 hours after the previous sweep settles. Deletion uses bounded batches, so expiration is periodic rather than an exact TTL.

Cleanup removes audit rows only. Active schedules, managed-resource state, configuration, and recovery state remain intact. Audit deletion creates no audit notification. A cleanup failure does not invalidate application operations; the next sweep retries remaining work. Shutdown drains in-flight cleanup before PostgreSQL closes under the existing process-wide deadline. Per-guild retention configuration is not implemented and remains unresolved.

## Migrations

`corepack pnpm db:generate` creates migration files during development. `corepack pnpm db:check`
validates them, and `corepack pnpm db:migrate` applies them from a source checkout with development
dependencies. Production releases include the committed migration history and use the explicit
`docker compose run --rm app node dist/migrate.js` operation before starting or upgrading WEFT.
Normal application startup does not apply WEFT migrations. See the
[production migration procedure](docs/development.md#production-migration-operations).

pg-boss owns a separate `pgboss` schema in the same PostgreSQL database. Its internal schema is
created and migrated automatically when pg-boss starts; it is not managed by Drizzle. The
configured database user must have the `CREATE` privilege on the database for this purpose.
pg-boss uses the existing `DATABASE_*` settings and owns a connection pool separate from WEFT's
application database pool.

## Backup and restore

See the [PostgreSQL 18 backup and restore procedure](docs/development.md#production-backup-and-restore-operations)
for the supported archive format, safe restore order, and disposable restore drill.

## Development

Start the application from TypeScript:

```sh
corepack pnpm dev
```

Build and start the compiled application:

```sh
corepack pnpm build
corepack pnpm start
```

## Verification

```sh
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Run PostgreSQL integration tests only after creating a dedicated test database and setting every required `TEST_DATABASE_*` variable. Missing test variables cause validation to fail before any connection is attempted.

```sh
corepack pnpm test:integration
```

## License

WEFT is licensed under the [MIT License](./LICENSE).

The [third-party license document](./THIRD_PARTY_LICENSES.md) supplements the license material
required in distribution artifacts.
