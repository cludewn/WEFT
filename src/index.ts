import pino from "pino";

import { runApplicationStartup } from "./application-startup.js";
import { createAutomaticCloseConfigurationService } from "./automatic-close-configuration.js";
import { createAutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import {
  createDiscordRuntime,
  registerDiscordCommandHandler,
  startDiscordClient,
} from "./discord.js";
import { createGuildSettingsStore } from "./guild-settings.js";
import { createPgBossRuntime } from "./pg-boss.js";
import { createScheduledActionStore } from "./scheduled-action-persistence.js";
import { createScheduledThreadCloseCommandService } from "./scheduled-thread-close-command.js";
import { createScheduledThreadCloseStore } from "./scheduled-thread-close-persistence.js";
import { createScheduledThreadCloseExecutor } from "./scheduled-thread-close.js";
import {
  createScheduledThreadCloseRuntimeReconciler,
  createScheduledThreadCloseStartupReconciler,
} from "./scheduled-thread-close-reconciler.js";
import { createScheduledThreadCloseWorkerController } from "./scheduled-thread-close-worker.js";
import { createShutdown } from "./shutdown.js";
import { createAutoCloseDiscord } from "./thread-discord.js";
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
  const scheduledActions = createScheduledActionStore(database.client);
  const scheduledThreadCloses = createScheduledThreadCloseStore(database.client);
  const automaticCloses = createAutomaticClosePersistenceStore(database.client);
  const discordRuntime = createDiscordRuntime(logger, { guildSettings, managedThreads, audits });
  const automaticCloseConfiguration = createAutomaticCloseConfigurationService({
    guildSettings,
    schedules: automaticCloses,
    discord: createAutoCloseDiscord(discordRuntime.client),
    logger,
  });
  const scheduledThreadCloseExecutor = createScheduledThreadCloseExecutor({
    scheduledActions,
    schedules: scheduledThreadCloses,
    threadLifecycle: discordRuntime.threadLifecycle,
  });
  const scheduledThreadCloseWorkers = createScheduledThreadCloseWorkerController({
    boss: pgBoss.client,
    scheduledActions,
    executor: scheduledThreadCloseExecutor,
    logger,
  });
  const scheduledThreadCloseCommand = createScheduledThreadCloseCommandService({
    discord: discordRuntime.threadDiscord,
    schedules: scheduledThreadCloses,
    delivery: scheduledThreadCloseWorkers,
    threadLifecycle: discordRuntime.threadLifecycle,
    logger,
  });
  registerDiscordCommandHandler(discordRuntime.client, {
    automaticCloseConfiguration,
    guildSettings,
    scheduledThreadClose: scheduledThreadCloseCommand,
    threadLifecycle: discordRuntime.threadLifecycle,
    logger,
  });
  const scheduledThreadCloseReconciler = createScheduledThreadCloseStartupReconciler({
    scheduledActions,
    schedules: scheduledThreadCloses,
    delivery: scheduledThreadCloseWorkers,
    logger,
  });
  const scheduledThreadCloseRuntimeReconciler = createScheduledThreadCloseRuntimeReconciler({
    scheduledActions,
    delivery: scheduledThreadCloseWorkers,
    logger,
  });
  const startupAbortController = new AbortController();
  const shutdown = createShutdown(
    [
      {
        name: "scheduled-thread-close-runtime-reconciler",
        close: () => scheduledThreadCloseRuntimeReconciler.stop(),
      },
      { name: "scheduled-thread-close-workers", close: () => scheduledThreadCloseWorkers.stop() },
      { name: "pg-boss", close: () => pgBoss.stop() },
      { name: "discord", close: () => discordRuntime.client.destroy() },
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
      ensureScheduledThreadCloseQueue: () => scheduledThreadCloseWorkers.ensureQueue(),
      recoverScheduledThreadCloseDeliveries: () =>
        scheduledThreadCloseReconciler.recoverAtStartup(),
      startDiscord: () =>
        startDiscordClient(
          discordRuntime.client,
          config.discord.token,
          startupAbortController.signal,
        ),
      startScheduledThreadCloseWorkers: () => scheduledThreadCloseWorkers.start(),
      startScheduledThreadCloseRuntimeReconciliation: () =>
        scheduledThreadCloseRuntimeReconciler.start(),
      shutdown,
    },
    logger,
  );
}

await main();
