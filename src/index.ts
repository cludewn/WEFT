import pino from "pino";

import { runApplicationStartup } from "./application-startup.js";
import { createAutomaticCloseActivityService } from "./automatic-close-activity.js";
import { createAutomaticCloseConfigurationService } from "./automatic-close-configuration.js";
import { createAutomaticCloseExecutor } from "./automatic-close-execution.js";
import { createAutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import { createAutomaticCloseBaselineReconciler } from "./automatic-close-reconciler.js";
import { createAutomaticCloseRuntime } from "./automatic-close-runtime.js";
import { createAutomaticCloseThreadMaintenanceService } from "./automatic-close-thread-maintenance.js";
import { ConfigurationError, loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import {
  createDiscordRuntime,
  registerAutomaticCloseActivityHandlers,
  registerDiscordCommandHandler,
  registerManagedMessageModalHandler,
  startDiscordClient,
} from "./discord.js";
import { createGuildSettingsStore } from "./guild-settings.js";
import { createManagedMessageDiscord } from "./managed-message-discord.js";
import { createManagedMessageStore } from "./managed-message-persistence.js";
import { createManagedMessageService } from "./managed-message.js";
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
import {
  createAutoCloseDiscord,
  createAutomaticCloseExecutionDiscord,
  createAutomaticCloseThreadMaintenanceDiscord,
} from "./thread-discord.js";
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
  const managedMessageStore = createManagedMessageStore(database.client);
  const discordRuntime = createDiscordRuntime(logger, { guildSettings, managedThreads, audits });
  const managedMessages = createManagedMessageService({
    discord: createManagedMessageDiscord(discordRuntime.client),
    store: managedMessageStore,
    logger,
  });
  const autoCloseDiscord = createAutoCloseDiscord(discordRuntime.client);
  const automaticCloseMaintenanceDiscord = createAutomaticCloseThreadMaintenanceDiscord(
    discordRuntime.client,
  );
  const automaticCloseConfiguration = createAutomaticCloseConfigurationService({
    guildSettings,
    schedules: automaticCloses,
    discord: autoCloseDiscord,
    logger,
  });
  registerManagedMessageModalHandler(discordRuntime.client, managedMessages, logger);
  const automaticCloseActivity = createAutomaticCloseActivityService({
    persistence: automaticCloses,
    logger,
  });
  const automaticCloseMaintenance = createAutomaticCloseThreadMaintenanceService({
    discord: automaticCloseMaintenanceDiscord,
    persistence: automaticCloses,
    scheduledActions,
    logger,
  });
  const automaticCloseBaselineReconciler = createAutomaticCloseBaselineReconciler({
    persistence: automaticCloses,
    discord: autoCloseDiscord,
    logger,
  });
  const automaticCloseExecutor = createAutomaticCloseExecutor({
    discord: createAutomaticCloseExecutionDiscord(discordRuntime.client),
    persistence: automaticCloses,
    scheduledActions,
    threadLifecycle: discordRuntime.threadLifecycle,
  });
  const automaticCloseRuntime = createAutomaticCloseRuntime({
    persistence: automaticCloses,
    executor: automaticCloseExecutor,
    logger,
  });
  registerAutomaticCloseActivityHandlers(discordRuntime.client, {
    activity: automaticCloseActivity,
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
    automaticCloseMaintenance,
    guildSettings,
    managedMessages,
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
      { name: "automatic-close-runtime", close: () => automaticCloseRuntime.stop() },
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
      reconcileAutomaticCloseBaselines: () =>
        automaticCloseBaselineReconciler.reconcileMissingBaselines(),
      startAutomaticCloseRuntime: () => automaticCloseRuntime.start(),
      shutdown,
    },
    logger,
  );
}

await main();
