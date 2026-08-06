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

Copy `.env.example` to `.env` for local Docker Compose use, then replace the example passwords and Discord placeholders. Normal application startup requires `DISCORD_TOKEN` and `DISCORD_APPLICATION_ID`. Deploying commands to the default development guild also requires `DISCORD_GUILD_ID`. Do not commit `.env` files.

Commands run directly on the host do not load `.env` automatically. Provide the same variables through the local shell or environment-management tool before running the application, Drizzle Kit, or PostgreSQL integration tests.

## Environment variables

| Name                     | Required               | Description                                                            |
| ------------------------ | ---------------------- | ---------------------------------------------------------------------- |
| `DATABASE_HOST`          | Yes                    | PostgreSQL host                                                        |
| `DATABASE_PORT`          | Yes                    | PostgreSQL port between 1 and 65535                                    |
| `DATABASE_NAME`          | Yes                    | PostgreSQL database name                                               |
| `DATABASE_USER`          | Yes                    | PostgreSQL user                                                        |
| `DATABASE_PASSWORD`      | Yes                    | PostgreSQL password                                                    |
| `DATABASE_SSL`           | No                     | Set to `true` to require certificate-verified TLS; defaults to `false` |
| `LOG_LEVEL`              | No                     | Pino log level; defaults to `info`                                     |
| `DISCORD_TOKEN`          | Yes                    | Discord bot token; never logged or format-validated                    |
| `DISCORD_APPLICATION_ID` | Yes                    | Discord application ID                                                 |
| `DISCORD_GUILD_ID`       | For command deployment | Development guild used by the default command deployment mode          |

## Discord commands

Normal application startup does not register application commands. Deploy commands explicitly to the configured development guild:

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

## Migrations

Migrations are not applied automatically when the application starts. Run the required command explicitly with database environment variables available to the process:

```sh
corepack pnpm db:generate
corepack pnpm db:check
corepack pnpm db:migrate
```

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
