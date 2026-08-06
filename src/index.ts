import pino from "pino";

import { ConfigurationError, loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createDiscordClient, DiscordStartupAbortedError, startDiscordClient } from "./discord.js";
import { createGuildSettingsStore } from "./guild-settings.js";
import { createShutdown, getErrorName } from "./shutdown.js";
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
  const guildSettings = createGuildSettingsStore(database.client);
  const managedThreads = createManagedThreadStore(database.client);
  const audits = createThreadAuditStore(database.client);
  const discord = createDiscordClient(logger, { guildSettings, managedThreads, audits });
  const startupAbortController = new AbortController();
  const shutdown = createShutdown(
    [
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

  try {
    logger.info({ event: "application_starting" }, "Application startup started");
    await database.verifyConnection();
    logger.info({ event: "database_connected" }, "PostgreSQL connection verified");
    await startDiscordClient(discord, config.discord.token, startupAbortController.signal);
    logger.info({ event: "discord_ready" }, "Discord client is ready");
    logger.info({ event: "application_ready" }, "Application startup completed");
  } catch (error) {
    if (error instanceof DiscordStartupAbortedError) {
      try {
        await shutdown("startup_aborted");
      } catch {
        process.exitCode = 1;
      }
      return;
    }

    logger.error(
      { event: "startup_failed", errorName: getErrorName(error) },
      "Application startup failed",
    );
    process.exitCode = 1;

    try {
      await shutdown("startup_failure");
    } catch {
      // The shutdown controller already recorded the failure without exposing configuration values.
    }
  }
}

await main();
