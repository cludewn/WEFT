# WEFT

<p align="center">
  <strong>English</strong> | <a href="./README-ja.md">日本語</a>
</p>

WEFT is a self-hosted Discord bot for managing threads, collaboratively editing bot messages, and scheduling one-time and recurring posts.

## Features

### Thread management

Close threads manually or configure automatic closing after a period of inactivity. Schedule threads to close after a delay, or filter candidates by thread name, creator, and other criteria, then close the selected threads together.

### Shared editing of bot messages

Multiple authorized administrators can collaboratively edit messages posted by the bot.

### Scheduled and recurring messages

Schedule messages for a specific date and time or after a delay. Daily and weekly recurring posts are also available, with options to change message content or timing and cancel schedules.

### Message link previews

Preview messages linked from within the same server. Content confirmed to be publicly readable is displayed automatically; other content is shown only to users whose access has been verified.

### Permission checks and audit logs

WEFT checks user and bot permissions for administrative operations and records operation outcomes and configuration changes. Audit events can also be sent to a designated Discord channel.

## Documentation

For feature guides, commands, configuration, updates, backup, and recovery, see the [official Wiki](https://github.com/cludewn/WEFT/wiki/Home).

## Getting started

Deploy WEFT from a complete source checkout using Docker Compose, with one active application instance and PostgreSQL 18.

Requirements:

- Git, Docker, and Docker Compose.
- Node.js 24 and Corepack on the host. Use the pnpm version pinned in `package.json`.
- Permission to manage a Discord application and install it into the target server.

These steps are for a first installation. Run commands in order and confirm that each succeeds before continuing. Detailed setup and maintenance instructions are available in the [Wiki guides](#documentation).

### 1. Set up the Discord application

1. Create an application in the [Discord Developer Portal](https://discord.com/developers/applications). Record its Application ID and obtain the bot token through the Bot settings.
2. Configure Guild Install and use the Discord Provided Link with the `bot` and `applications.commands` scopes in Default Install Settings.
3. Grant View Channels, Manage Threads, Send Messages, Send Messages in Threads, Read Message History, and Embed Links. Do not grant Administrator.
4. Enable Message Content Intent under Bot → Privileged Gateway Intents, then install the application into the target server.

### 2. Obtain the source and configure WEFT

Clone the repository and install the host-side dependencies:

```sh
git clone https://github.com/cludewn/WEFT.git
cd WEFT
corepack pnpm install --frozen-lockfile
```

Run subsequent commands from the checkout root. Create private settings from [`.env.example`](.env.example):

```sh
umask 077
cp -n .env.example .env
chmod 600 .env
```

`cp -n` preserves an existing `.env`. Edit the file to set `DATABASE_NAME`, `DATABASE_USER`, a strong `DATABASE_PASSWORD`, `DISCORD_TOKEN`, and `DISCORD_APPLICATION_ID`. For server-specific command registration, set `DISCORD_GUILD_ID` to the target server ID. Keep the file private and do not commit it.

Optional settings and environment configuration details are covered in the [configuration reference](https://github.com/cludewn/WEFT/wiki/Installation-and-Setup#configuration-reference).

### 3. Build the image and run database migrations

```sh
docker compose build app
docker compose up -d postgres
docker compose run --rm app node dist/migrate.js
```

**Confirm that the migration succeeds before continuing.** If it fails, do not start the application; investigate the failure first.

### 4. Register Discord commands

Run this command on the host to register commands for `DISCORD_GUILD_ID` (Guild scope). Host commands do not load `.env` automatically, so it is loaded explicitly:

```sh
node --env-file=.env --import tsx src/deploy-commands.ts
```

For Global registration instead, use the following command; `DISCORD_GUILD_ID` is not required:

```sh
node --env-file=.env --import tsx src/deploy-commands.ts --global
```

Application startup does not register commands, so complete this step before starting WEFT.

### 5. Start WEFT and verify operation

```sh
docker compose up -d app
docker compose ps
```

The health port is not published to the host. Check readiness inside the app container:

```sh
docker compose exec -T app node -e "
  fetch('http://127.0.0.1:' + (process.env.HEALTH_PORT ?? '3000') + '/health/ready')
    .then(r => process.exit(r.status === 200 ? 0 : 1))
    .catch(() => process.exit(1))
"
```

Confirm exit code 0, then run `/config show` in Discord as a member with Manage Server and check that the bot responds.

## Security

Follow [SECURITY.md](SECURITY.md) to report vulnerabilities privately. Do not include vulnerability details in public Issues.

## License

WEFT is distributed under the [MIT License](LICENSE). [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) supplements the dependency license material included in distribution artifacts.
