import pino from "pino";

import { createAuditLogDestinationDiscord } from "./audit-log-destination-discord.js";
import { createAuditLogDestinationStore } from "./audit-log-destination-persistence.js";
import { createAuditLogDestinationService } from "./audit-log-destination.js";
import { createApplicationRuntime, type ProcessControl } from "./application-runtime.js";
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
  registerThreadLifecycleEventHandler,
  startDiscordClient,
} from "./discord.js";
import { createGuildSettingsStore } from "./guild-settings.js";
import { createHealthListener } from "./health.js";
import { createManagedMessageDiscord } from "./managed-message-discord.js";
import { createManagedMessageStore } from "./managed-message-persistence.js";
import { createManagedMessageService } from "./managed-message.js";
import { createPgBossRuntime } from "./pg-boss.js";
import { installProcessHandlers } from "./process-handlers.js";
import { createRecurringMessageExecutor } from "./recurring-message-execution.js";
import { createRecurringMessageStore } from "./recurring-message-persistence.js";
import { createRecurringMessageReconciler } from "./recurring-message-reconciler.js";
import { createRecurringRuntimeStore } from "./recurring-message-runtime-persistence.js";
import { createRecurringMessageWorker } from "./recurring-message-worker.js";
import { createScheduledActionStore } from "./scheduled-action-persistence.js";
import { createScheduledMessageDiscord } from "./scheduled-message-discord.js";
import { createScheduledMessageCommandService } from "./scheduled-message-command.js";
import { createScheduledMessageAdministrationStore } from "./scheduled-message-administration-persistence.js";
import { createScheduledMessageExecutor } from "./scheduled-message-execution.js";
import { createScheduledMessageStore } from "./scheduled-message-persistence.js";
import {
  createScheduledMessageRuntimeReconciler,
  createScheduledMessageStartupReconciler,
} from "./scheduled-message-reconciler.js";
import { createScheduledMessageWorkerController } from "./scheduled-message-worker.js";
import { createScheduledThreadCloseCommandService } from "./scheduled-thread-close-command.js";
import { createScheduledThreadCloseStore } from "./scheduled-thread-close-persistence.js";
import { createScheduledThreadCloseExecutor } from "./scheduled-thread-close.js";
import {
  createScheduledThreadCloseRuntimeReconciler,
  createScheduledThreadCloseStartupReconciler,
} from "./scheduled-thread-close-reconciler.js";
import { createScheduledThreadCloseWorkerController } from "./scheduled-thread-close-worker.js";
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
  const scheduledMessageStore = createScheduledMessageStore(database.client);
  const recurringMessageStore = createRecurringMessageStore(database.client);
  const recurringRuntimeStore = createRecurringRuntimeStore(database.client);
  const automaticCloses = createAutomaticClosePersistenceStore(database.client);
  const managedMessageStore = createManagedMessageStore(database.client);
  const discordRuntime = createDiscordRuntime(logger, { guildSettings, managedThreads, audits });
  const auditLogDestination = createAuditLogDestinationService(
    createAuditLogDestinationStore(database.client),
    createAuditLogDestinationDiscord(discordRuntime.client),
  );
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
  const scheduledMessageDiscord = createScheduledMessageDiscord(discordRuntime.client);
  const scheduledMessageExecutor = createScheduledMessageExecutor({
    store: scheduledMessageStore,
    discord: scheduledMessageDiscord,
  });
  const scheduledMessageWorkers = createScheduledMessageWorkerController({
    boss: pgBoss.client,
    scheduledActions,
    executor: scheduledMessageExecutor,
    logger,
  });
  const recurringExecutor = createRecurringMessageExecutor({
    claims: recurringMessageStore,
    store: recurringRuntimeStore,
    discord: scheduledMessageDiscord,
  });
  const recurringWorker = createRecurringMessageWorker({
    boss: pgBoss.client,
    executor: recurringExecutor,
    recurring: recurringMessageStore,
    store: recurringRuntimeStore,
    logger,
  });
  const recurringReconciler = createRecurringMessageReconciler({
    store: recurringRuntimeStore,
    worker: recurringWorker,
    logger,
  });
  const scheduledMessages = createScheduledMessageCommandService({
    discord: scheduledMessageDiscord,
    store: scheduledMessageStore,
    delivery: scheduledMessageWorkers,
    administration: createScheduledMessageAdministrationStore(database.client),
    recurring: recurringMessageStore,
    recurringWorker,
    guildSettings,
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
  const scheduledMessageStartupReconciler = createScheduledMessageStartupReconciler({
    scheduledActions,
    store: scheduledMessageStore,
    executor: scheduledMessageExecutor,
    delivery: scheduledMessageWorkers,
    logger,
  });
  const scheduledMessageRuntimeReconciler = createScheduledMessageRuntimeReconciler({
    scheduledActions,
    store: scheduledMessageStore,
    executor: scheduledMessageExecutor,
    delivery: scheduledMessageWorkers,
    logger,
  });
  const processControl: ProcessControl = {
    setExitCode: (code) => {
      process.exitCode = code;
    },
    forceExit: (code) => process.exit(code),
    writeStderr: (message) => process.stderr.write(message),
  };
  const health = createHealthListener({
    port: config.healthPort,
    getState: () => runtime.getState(),
    isDiscordReady: () => discordRuntime.client.isReady(),
    verifyDatabaseConnection: () => database.verifyConnection(),
  });
  const runtime = createApplicationRuntime({
    startHealthListener: () => health.start(),
    quiesceHealth: () => health.quiesce(),
    drainHealth: () => health.drain(),
    verifyDatabaseConnection: () => database.verifyConnection(),
    startPgBoss: () => pgBoss.start(),
    ensureScheduledThreadCloseQueue: () => scheduledThreadCloseWorkers.ensureQueue(),
    ensureScheduledMessageQueue: () => scheduledMessageWorkers.ensureQueue(),
    ensureRecurringMessageQueue: () => recurringWorker.ensureQueue(),
    recoverScheduledThreadCloseDeliveries: () => scheduledThreadCloseReconciler.recoverAtStartup(),
    recoverScheduledMessageDeliveries: () => scheduledMessageStartupReconciler.recoverAtStartup(),
    recoverRecurringMessageDeliveries: () => recurringReconciler.recoverAtStartup(),
    startDiscord: () =>
      startDiscordClient(discordRuntime.client, config.discord.token, new AbortController().signal),
    startScheduledThreadCloseWorkers: () => scheduledThreadCloseWorkers.start(),
    startScheduledMessageWorker: () => scheduledMessageWorkers.start(),
    startRecurringMessageWorker: () => recurringWorker.start(),
    startScheduledThreadCloseRuntimeReconciliation: () =>
      scheduledThreadCloseRuntimeReconciler.start(),
    startScheduledMessageRuntimeReconciliation: () => scheduledMessageRuntimeReconciler.start(),
    startRecurringMessageRuntimeReconciliation: () => recurringReconciler.start(),
    reconcileAutomaticCloseBaselines: () =>
      automaticCloseBaselineReconciler.reconcileMissingBaselines(),
    startAutomaticCloseRuntime: () => automaticCloseRuntime.start(),
    quiesce: [
      { name: "automatic-close-runtime", stop: () => automaticCloseRuntime.stop() },
      {
        name: "scheduled-message-runtime-reconciler",
        stop: () => scheduledMessageRuntimeReconciler.stop(),
      },
      {
        name: "scheduled-thread-close-runtime-reconciler",
        stop: () => scheduledThreadCloseRuntimeReconciler.stop(),
      },
      {
        name: "recurring-message-runtime-reconciler",
        stop: () => recurringReconciler.stop(),
      },
      {
        name: "scheduled-thread-close-workers",
        stop: () => scheduledThreadCloseWorkers.stop(),
      },
      { name: "scheduled-message-workers", stop: () => scheduledMessageWorkers.stop() },
      { name: "recurring-message-worker", stop: () => recurringWorker.stop() },
    ],
    drainThreadLifecycle: () => discordRuntime.threadLifecycle.drain(),
    stopPgBoss: (remainingMs) => pgBoss.stop(remainingMs),
    destroyDiscord: () => discordRuntime.client.destroy(),
    closeDatabase: () => database.close(),
    logger,
    processControl,
  });

  registerThreadLifecycleEventHandler(
    discordRuntime.client,
    discordRuntime.threadLifecycle,
    logger,
    runtime.ingress,
  );
  registerAutomaticCloseActivityHandlers(
    discordRuntime.client,
    { activity: automaticCloseActivity, logger },
    runtime.ingress,
  );
  registerManagedMessageModalHandler(
    discordRuntime.client,
    managedMessages,
    scheduledMessages,
    logger,
    runtime.ingress,
  );
  registerDiscordCommandHandler(
    discordRuntime.client,
    {
      auditLogDestination,
      automaticCloseConfiguration,
      automaticCloseMaintenance,
      guildSettings,
      managedMessages,
      scheduledMessages,
      scheduledThreadClose: scheduledThreadCloseCommand,
      threadLifecycle: discordRuntime.threadLifecycle,
      logger,
    },
    runtime.ingress,
  );
  installProcessHandlers(runtime, processControl);
  await runtime.start().catch(() => undefined);
}

await main();
