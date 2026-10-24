# Installation and setup

[Home](Home) · [Command reference](Command-Reference) · [Troubleshooting](Troubleshooting) · [日本語](Installation-and-Setup-ja)

This guide takes you from a Discord application to a running WEFT instance. Self-hosting requires maintaining the host, private configuration, PostgreSQL data and backups.

<a id="prerequisites"></a>

## Prepare the host and deployment

| Requirement                                                     | Purpose                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Git and a complete WEFT checkout for your chosen version        | Supplies Compose, application sources and matching migrations.                  |
| Docker and Docker Compose                                       | Builds/runs one WEFT instance and PostgreSQL 18.                                |
| Node.js 24 with Corepack on the host                            | Runs command-registration tools; use the pnpm version pinned in `package.json`. |
| Ability to manage a Discord application and server installation | Creates the bot and grants required access.                                     |

Use one active WEFT instance. Web administration, direct-message operation, cluster mode and a general moderation suite are not supported.

The order is **create/install the Discord bot → prepare private settings → build/start PostgreSQL → migrate → register commands → start WEFT → verify → choose server settings**.

## Create and install the Discord application

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications).
   Record the Application ID, and obtain the bot token through the Bot settings. Store it privately.
2. Configure **Guild Install** only. User Install and direct messages are unsupported. Use the
   Discord Provided Link with `bot` and `applications.commands` scopes.
3. For WEFT’s features, select **View Channels**, **Manage Threads**, **Send Messages**,
   **Send Messages in Threads**, **Read Message History**, and **Embed Links**. Do not grant Administrator.
4. Enable **Message Content Intent** under Bot → Privileged Gateway Intents for message-link
   detection. Server Members and Presence intents are unnecessary. Turning preview mode off does
   not dynamically remove this configured runtime intent.
5. Install into the intended server. Review channel overwrites: installation permissions alone do not determine effective access; current roles and channel overwrites also matter. Private threads need actual access; WEFT does not
   automatically join them to make a message send possible.

| Command family                  | Required actor permission |
| ------------------------------- | ------------------------- |
| `/config`                       | Manage Server             |
| `/thread`                       | Manage Threads            |
| `/message`, including schedules | Manage Messages           |

Command visibility is not authorization. WEFT’s own permissions are checked separately; give it the required channel permissions without Administrator.

<a id="prepare-the-checkout-and-configuration"></a>

## Prepare the checkout and private settings

Prepare a complete WEFT source checkout for the version you intend to deploy. Run the following
commands from its root directory, which contains `compose.yaml`, `package.json` and `.env.example`.
Install the tools used for command registration:

```sh
corepack pnpm install --frozen-lockfile
```

Create a private local configuration from `.env.example` in the checkout root:

```sh
umask 077
cp -n .env.example .env
chmod 600 .env
```

`cp -n` preserves an existing `.env`; update that file rather than overwriting it. In a private editor,
set `DATABASE_NAME`, `DATABASE_USER` and a strong `DATABASE_PASSWORD`. Replace `DISCORD_TOKEN` and
`DISCORD_APPLICATION_ID` with the bot token and Application ID obtained above. Set `DISCORD_GUILD_ID`
to the server ID if you will register commands for one server. Keep all credentials private: never
commit the file, paste its contents into an issue, or print the entire configuration.

For host-versus-container connection details and optional settings, see the [configuration reference below](#configuration-reference). Finish the private settings before deployment.

<a id="build-migrate-deploy-commands-and-start"></a>

## Build, migrate, register and start

<a id="build-and-migrate"></a>

### 1. Build the image and migrate PostgreSQL

Run each command in order and check that it succeeds before continuing.

From the checkout root, after private settings are ready:

```sh
docker compose build app
docker compose up -d postgres
docker compose run --rm app node dist/migrate.js
```

A migration updates the database structure required by WEFT. Require a successful migration exit
before starting the app, and run only one migration process for a database at a time. Startup does
not migrate WEFT tables. The image includes the migration runner and matching SQL files; no
additional migration tools are needed inside the runtime container.

<a id="register-commands"></a>

### 2. Register Discord commands

From the checkout root, use Node.js 24 to load the private `.env` created above and register commands:

```sh
node --env-file=.env --import tsx src/deploy-commands.ts
```

By default, this registers commands for the server identified by `DISCORD_GUILD_ID` (Guild scope).
For global registration, append `--global` to the same command:

```sh
node --env-file=.env --import tsx src/deploy-commands.ts --global
```

Registration overwrites the selected scope; Guild and Global scopes are independent. Runtime restart
does not register commands. On updates, redeploy each scope used.

These commands run on the host. Compose’s container environment is not passed to them; `--env-file`
explicitly loads the checkout’s private file. Existing host environment variables take precedence
over that file. Registration needs `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID`
for Guild scope; Global scope does not require the guild ID. It does not connect to PostgreSQL.

If the required Discord variables are already set in the host environment, you can instead use
`corepack pnpm commands:deploy`, or `corepack pnpm run commands:deploy --global` for Global scope.
These pnpm commands run the same registration CLI but do **not** automatically load `.env`.

<a id="start-application"></a>

### 3. Start WEFT

```sh
docker compose up -d app
docker compose ps
```

## Verify the first run

Run the container-local readiness check:

```sh
docker compose exec -T app node -e "fetch('http://127.0.0.1:' + process.env.HEALTH_PORT + '/health/ready').then(r => process.exit(r.status === 200 ? 0 : 1)).catch(() => process.exit(1))"
```

Exit 0 means readiness returned HTTP 200 at that observation. Use the [application-log command](Operations#inspect-operation-logs) to look for
`application_ready`; do not publish raw logs containing private identifiers or content. As an
administrator, run [`/config audit-log show`](Commands-Config#config-audit-log-show), then
[`/config show`](Commands-Config#config-show). A missing audit destination initially shows disabled.
Follow [Configuration](Configuration) before enabling policies. Confirm ephemeral responses (shown only to the person who ran the command) and
channel permissions using threads or posts created for this check. Readiness is a point-in-time
health check; it does not guarantee future API success or recovery consistency. For failures, see [Troubleshooting](Troubleshooting).

| Check                               | Expected result                                                      |
| ----------------------------------- | -------------------------------------------------------------------- |
| Container readiness                 | Check exits 0 (HTTP 200 at that observation).                        |
| Startup log                         | `application_ready`                                                  |
| Discord command registration/access | `/config show` responds ephemerally for an authorized administrator. |
| Initial audit destination           | `/config audit-log show` displays disabled unless configured.        |

Continue to [Configuration](Configuration), then try [closing a verification thread](Thread-Lifecycle) or [sending a managed message](Managed-Messages). Readiness alone does not establish those operations succeeded.

<a id="configuration-reference"></a>

## Host and container configuration reference

Docker Compose reads the checkout’s `.env` for variable substitution and passes the variables listed
in `compose.yaml` into each container. Variables already exported in the host shell take precedence
over `.env` during substitution, so check for conflicting settings without printing secrets.
Host-side Node.js and pnpm commands do **not** automatically read `.env`; use an environment manager
or the explicit file-loading command in the registration step. `TEST_DATABASE_*` entries are not used for deployment.
Use literal values in settings shared by Compose and Node.js: Node.js does not expand Compose-style
`${...}` references. Quote values containing special characters according to the
[Compose file syntax](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/#env-file-syntax)
and [Node.js file syntax](https://nodejs.org/download/release/v24.11.0/docs/api/cli.html#--env-filefile).

| Setting                                                                       | Requirement                                                                                  |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD | Required. For host connections, use the intended PostgreSQL address and a port from 1–65535. |
| DATABASE_SSL                                                                  | Optional; the default is false. Setting true requires certificate-verified TLS.              |
| DISCORD_TOKEN, DISCORD_APPLICATION_ID                                         | Required for runtime. Use the Application ID, not Bot User ID, for the latter.               |
| DISCORD_GUILD_ID                                                              | Used only for default guild command deployment. It does not restrict runtime to one server.  |
| LOG_LEVEL                                                                     | Optional; the default is info.                                                               |
| HEALTH_PORT                                                                   | Optional; the default is 3000. This sets the container-local health listener port.           |

Compose sets the app container’s `DATABASE_HOST` to `postgres` and `DATABASE_PORT` to `5432`,
regardless of those two values in `.env`. For commands connecting from the host, use `127.0.0.1`
and the host port selected by `DATABASE_PORT` (5432 by default). If you run WEFT directly on the host,
supply all required runtime variables from the table; the Compose overrides do not apply.
PostgreSQL’s port is published only on 127.0.0.1, and data is stored in the named `postgres-data`
volume. The app health port is not published. The database role also needs permission to create the scheduler’s internal schema in that database.
