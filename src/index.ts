import { createManagedMessageExecutionRecorder } from "./messages/managed-message-execution-audit.js";
import { createAdministrativeFailureRecorder } from "./audit/administrative-operation-failure-audit.js";
import { createGuildConfigurationService } from "./guild/guild-configuration.js";
import pino from "pino";

import { createBulkCloseService } from "./threads/bulk-thread-close.js";
import { createBulkCloseDiscord } from "./threads/bulk-thread-close-discord.js";

import { createLinkPreviewConfiguration } from "./link-previews/link-preview-configuration.js";
import { createLinkPreviewStore } from "./link-previews/link-preview-persistence.js";
import { createLinkPreviewService } from "./link-previews/link-preview.js";
import {
  createLinkPreviewDiscord,
  registerLinkPreviewHandlers,
} from "./link-previews/link-preview-discord.js";

import { createAuditLogDestinationDiscord } from "./audit/audit-log-destination-discord.js";
import { createAuditLogDestinationStore } from "./audit/audit-log-destination-persistence.js";
import { createAuditLogDestinationService } from "./audit/audit-log-destination.js";
import { createAuditNotificationDiscord } from "./audit/audit-notification-discord.js";
import { createAuditNotificationDispatcher } from "./audit/audit-notification-dispatcher.js";
import { createAuditNotificationProjection } from "./audit/audit-notification-projection.js";
import {
  publishAuditDestinationChanges,
  publishLinkPreviewChanges,
  publishManagedMessageAudits,
  publishRecurringMessageAudits,
  publishScheduledMessageAudits,
  publishScheduledThreadCloseAudits,
} from "./audit/audit-notification-publication.js";
import { createAuditRetentionStore } from "./audit/audit-retention-persistence.js";
import { createAuditRetentionRuntime } from "./audit/audit-retention-runtime.js";
import { createApplicationRuntime, type ProcessControl } from "./application-runtime.js";
import { createAutomaticCloseActivityService } from "./threads/automatic-close-activity.js";
import { createAutomaticCloseConfigurationService } from "./threads/automatic-close-configuration.js";
import { createAutomaticCloseExecutor } from "./threads/automatic-close-execution.js";
import { createAutomaticClosePersistenceStore } from "./threads/automatic-close-persistence.js";
import { createAutomaticCloseBaselineReconciler } from "./threads/automatic-close-reconciler.js";
import { createAutomaticCloseRuntime } from "./threads/automatic-close-runtime.js";
import { createAutomaticCloseThreadMaintenanceService } from "./threads/automatic-close-thread-maintenance.js";
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
import { createGuildSettingsStore } from "./guild/guild-settings.js";
import { createHealthListener } from "./health.js";
import { createManagedMessageDiscord } from "./messages/managed-message-discord.js";
import { createManagedMessageStore } from "./messages/managed-message-persistence.js";
import { createManagedMessageService } from "./messages/managed-message.js";
import { createPgBossRuntime } from "./pg-boss.js";
import { installProcessHandlers } from "./process-handlers.js";
import { createRecurringMessageExecutor } from "./messages/recurring-message-execution.js";
import { createRecurringMessageStore } from "./messages/recurring-message-persistence.js";
import { createRecurringMessageReconciler } from "./messages/recurring-message-reconciler.js";
import { createRecurringRuntimeStore } from "./messages/recurring-message-runtime-persistence.js";
import { createRecurringMessageWorker } from "./messages/recurring-message-worker.js";
import { createScheduledActionStore } from "./scheduled-action-persistence.js";
import { createScheduledMessageDiscord } from "./messages/scheduled-message-discord.js";
import { createScheduledMessageCommandService } from "./messages/scheduled-message-command.js";
import { createScheduledMessageAdministrationStore } from "./messages/scheduled-message-administration-persistence.js";
import { createScheduledMessageExecutor } from "./messages/scheduled-message-execution.js";
import { createScheduledMessageStore } from "./messages/scheduled-message-persistence.js";
import {
  createScheduledMessageRuntimeReconciler,
  createScheduledMessageStartupReconciler,
} from "./messages/scheduled-message-reconciler.js";
import { createScheduledMessageWorkerController } from "./messages/scheduled-message-worker.js";
import { createScheduledThreadCloseCommandService } from "./threads/scheduled-thread-close-command.js";
import { createScheduledThreadCloseStore } from "./threads/scheduled-thread-close-persistence.js";
import { createScheduledThreadCloseExecutor } from "./threads/scheduled-thread-close.js";
import {
  createScheduledThreadCloseRuntimeReconciler,
  createScheduledThreadCloseStartupReconciler,
} from "./threads/scheduled-thread-close-reconciler.js";
import { createScheduledThreadCloseWorkerController } from "./threads/scheduled-thread-close-worker.js";
import {
  createAutoCloseDiscord,
  createAutomaticCloseExecutionDiscord,
  createAutomaticCloseThreadMaintenanceDiscord,
} from "./threads/thread-discord.js";
import { createManagedThreadStore, createThreadAuditStore } from "./threads/thread-persistence.js";

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
  const managedThreads = createManagedThreadStore(database.client);
  const notificationDispatcher: { current?: ReturnType<typeof createAuditNotificationDispatcher> } =
    {};
  const auditPublisher = {
    publish: (
      reference: Parameters<ReturnType<typeof createAuditNotificationDispatcher>["publish"]>[0],
    ) => notificationDispatcher.current?.publish(reference),
  };
  const administrativeFailures = createAdministrativeFailureRecorder(
    database.client,
    logger,
    auditPublisher,
  );
  const guildSettings = createGuildSettingsStore(database.client, auditPublisher);
  const audits = createThreadAuditStore(database.client, auditPublisher);
  const scheduledActions = createScheduledActionStore(database.client);
  const scheduledThreadCloses = publishScheduledThreadCloseAudits(
    database.client,
    auditPublisher,
    createScheduledThreadCloseStore(database.client),
  );
  const scheduledMessageStore = publishScheduledMessageAudits(
    database.client,
    auditPublisher,
    createScheduledMessageStore(database.client),
  );
  const recurringMessageStore = publishRecurringMessageAudits(
    database.client,
    auditPublisher,
    createRecurringMessageStore(database.client),
  );
  const recurringRuntimeStore = createRecurringRuntimeStore(database.client, auditPublisher);
  const automaticCloses = createAutomaticClosePersistenceStore(database.client, auditPublisher);
  const managedMessageStore = publishManagedMessageAudits(
    database.client,
    auditPublisher,
    createManagedMessageStore(database.client),
  );
  const discordRuntime = createDiscordRuntime(logger, { guildSettings, managedThreads, audits });
  const destinationStore = publishAuditDestinationChanges(
    database.client,
    auditPublisher,
    createAuditLogDestinationStore(database.client),
  );
  const auditNotifications = createAuditNotificationDispatcher({
    projection: createAuditNotificationProjection(database.client),
    readDestination: (guildId) => destinationStore.read(guildId),
    discord: createAuditNotificationDiscord(discordRuntime.client),
    logger,
  });
  notificationDispatcher.current = auditNotifications;
  const auditLogDestination = createAuditLogDestinationService(
    destinationStore,
    createAuditLogDestinationDiscord(discordRuntime.client),
    administrativeFailures,
  );
  const linkPreviewStore = publishLinkPreviewChanges(
    database.client,
    auditPublisher,
    createLinkPreviewStore(database.client),
  );
  const linkPreview = createLinkPreviewConfiguration(linkPreviewStore, administrativeFailures);
  const linkPreviews = createLinkPreviewService({
    readMode: linkPreviewStore.read,
    discord: createLinkPreviewDiscord(discordRuntime.client),
    log: (source, code) =>
      logger.debug(
        {
          event: "link_preview",
          guildId: source.guildId,
          channelId: source.channelId,
          messageId: source.messageId,
          code,
        },
        "Link preview outcome",
      ),
  });
  const managedMessages = createManagedMessageService({
    discord: createManagedMessageDiscord(discordRuntime.client),
    store: managedMessageStore,
    failures: createManagedMessageExecutionRecorder(database.client, logger, auditPublisher),
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
    failures: administrativeFailures,
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
    failures: administrativeFailures,
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
  const auditRetentionRuntime = createAuditRetentionRuntime({
    persistence: createAuditRetentionStore(database.client),
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
    failures: administrativeFailures,
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
    failures: administrativeFailures,
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
  const bulkClose = createBulkCloseService({
    discord: createBulkCloseDiscord(discordRuntime.client),
    manualClose: scheduledThreadCloseCommand,
    isReady: () => runtime.getState() === "READY",
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
    startAuditRetentionRuntime: () => auditRetentionRuntime.start(),
    quiesce: [
      { name: "bulk-close", stop: () => bulkClose.stop() },
      { name: "audit-retention-runtime", stop: () => auditRetentionRuntime.stop() },
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
    drainAuditNotifications: () => auditNotifications.drain(),
    stopPgBoss: (remainingMs) => pgBoss.stop(remainingMs),
    destroyDiscord: () => discordRuntime.client.destroy(),
    closeDatabase: () => database.close(),
    logger,
    processControl,
  });

  registerLinkPreviewHandlers(discordRuntime.client, linkPreviews, logger, runtime.ingress);
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
      bulkClose,
      auditLogDestination,
      linkPreview,
      automaticCloseConfiguration,
      automaticCloseMaintenance,
      guildSettings: createGuildConfigurationService(guildSettings, administrativeFailures),
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
