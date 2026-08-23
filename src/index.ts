import pino from "pino";

import { runApplicationStartup } from "./application-startup.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createDiscordClient, startDiscordClient } from "./discord.js";
import { createGuildSettingsStore } from "./guild-settings.js";
import { createPgBossRuntime } from "./pg-boss.js";
import { createShutdown } from "./shutdown.js";
import { createManagedThreadStore, createThreadAuditStore } from "./thread-persistence.js";

async function main(): Promise<void> {
  let config;

  try {
    config = loadConfig();
  } catch (error) {
    const variables = error instanceof ConfigurationError ? error.variables : [];
    process.stderr.write(`${JSON.stringify({ event: "configuration_failed", variables })}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = pino({ level: config.logLevel });
  const database = createDatabase(config.database);
  const pgBoss = createPgBossRuntime(config.database, logger);
  const guildSettings = createGuildSettingsStore(database.client);
  const managedThreads = createManagedThreadStore(database.client);
  const audits = createThreadAuditStore(database.client);
  const discord = createDiscordClient(logger, { guildSettings, managedThreads, audits });
  const startupAbortController = new AbortController();
  const shutdown = createShutdown(
    [
      { name: "pg-boss", close: () => pgBoss.stop() },
      { name: "discord", close: () => discord.destroy() },
      { name: "database", close: () => database.close() },
    ],
    logger,
  );

  const handleSignal = (signal: NodeJS.Signals): void => {
    startupAbortController.abort();
    void shutdown(signal).catch(() => {
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  await runApplicationStartup(
    {
      verifyDatabaseConnection: () => database.verifyConnection(),
      startPgBoss: () => pgBoss.start(),
      startDiscord: () =>
        startDiscordClient(discord, config.discord.token, startupAbortController.signal),
      shutdown,
    },
    logger,
  );
}

await main();
