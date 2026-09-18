import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  ScheduledAction,
  ScheduledActionStore,
  ScheduledMessageActionCursor,
} from "./scheduled-action-persistence.js";
import {
  isWithinScheduledMessageGrace,
  type ScheduledMessageExecutor,
} from "./scheduled-message-execution.js";
import type { ScheduledMessageStore } from "./scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "./scheduled-message-worker.js";

export const SCHEDULED_MESSAGE_RECONCILIATION_INTERVAL_MS = 60_000;

type ActionReads = Pick<
  ScheduledActionStore,
  "findActiveScheduledMessagesPage" | "findExecutingScheduledMessagesPage"
>;
type Delivery = Pick<
  ScheduledMessageWorkerController,
  "cancelStaleActiveDeliveries" | "ensureScheduledMessageDelivery"
>;
type ReconciliationLogger = Pick<Logger, "info" | "warn">;

export type ScheduledMessageStartupReconciler = { recoverAtStartup: () => Promise<void> };
export type ScheduledMessageRuntimeReconciler = {
  start: () => Promise<void>;
  reconcileOnce: () => Promise<void>;
  stop: () => Promise<void>;
};

type StartupDependencies = {
  scheduledActions: ActionReads;
  store: Pick<ScheduledMessageStore, "find" | "failExecution">;
  executor: ScheduledMessageExecutor;
  delivery: Delivery;
  logger: ReconciliationLogger;
  now?: () => Date;
  generateId?: () => string;
};

type RuntimeDependencies = {
  scheduledActions: Pick<ScheduledActionStore, "findActiveScheduledMessagesPage">;
  store: Pick<ScheduledMessageStore, "find">;
  executor: ScheduledMessageExecutor;
  delivery: Pick<ScheduledMessageWorkerController, "ensureScheduledMessageDelivery">;
  logger: ReconciliationLogger;
  now?: () => Date;
};

export class ScheduledMessageStartupRecoveryError extends Error {
  constructor() {
    super("Scheduled message startup recovery failed");
    this.name = "ScheduledMessageStartupRecoveryError";
  }
}

async function scanActive(
  scheduledActions: Pick<ScheduledActionStore, "findActiveScheduledMessagesPage">,
  visit: (action: ScheduledAction) => Promise<void>,
): Promise<number> {
  let cursor: ScheduledMessageActionCursor | undefined;
  let scanned = 0;
  for (;;) {
    const page = await scheduledActions.findActiveScheduledMessagesPage(cursor);
    if (page.length === 0) return scanned;
    for (const action of page) {
      scanned += 1;
      await visit(action);
    }
    const last = page.at(-1)!;
    cursor = { executeAt: last.executeAt, id: last.id };
  }
}

export function createScheduledMessageStartupReconciler({
  scheduledActions,
  store,
  executor,
  delivery,
  logger,
  now = () => new Date(),
  generateId = randomUUID,
}: StartupDependencies): ScheduledMessageStartupReconciler {
  return {
    async recoverAtStartup() {
      const startedAt = Date.now();
      let executingScanned = 0;
      let activeScanned = 0;
      try {
        let afterId: string | undefined;
        for (;;) {
          const page = await scheduledActions.findExecutingScheduledMessagesPage(afterId);
          if (page.length === 0) break;
          for (const action of page) {
            executingScanned += 1;
            await delivery.cancelStaleActiveDeliveries(action.id);
            const definition = await store.find(action.id);
            if (definition === undefined || definition.action.status !== "EXECUTING") {
              throw new ScheduledMessageStartupRecoveryError();
            }
            const transition = await store.failExecution({
              definition,
              auditId: generateId(),
              occurredAt: now(),
              failureCode: "EXECUTION_INTERRUPTED_UNCONFIRMED",
              resultMessageId: null,
            });
            if (transition.outcome !== "COMMITTED") {
              // Startup recovery is accepted only with this attempt's exact stable audit.
              throw new ScheduledMessageStartupRecoveryError();
            }
          }
          afterId = page.at(-1)!.id;
        }

        activeScanned = await scanActive(scheduledActions, async (action) => {
          if (!isWithinScheduledMessageGrace(action.executeAt, now())) {
            const result = await executor.execute(action.id);
            if (result.outcome === "SKIPPED" && result.reason === "NOT_DUE") return;
            if (
              result.outcome !== "PERMANENT_FAILURE" ||
              result.code !== "OVERDUE_GRACE_EXCEEDED"
            ) {
              throw new ScheduledMessageStartupRecoveryError();
            }
            return;
          }
          const definition = await store.find(action.id);
          if (definition === undefined || definition.action.status !== "ACTIVE") {
            throw new ScheduledMessageStartupRecoveryError();
          }
          const deliveryResult = await delivery.ensureScheduledMessageDelivery({
            scheduledActionId: definition.action.id,
            executeAt: definition.action.executeAt,
            revision: definition.revision,
          });
          if (deliveryResult !== "CURRENT") {
            logger.warn(
              {
                event: "scheduled_message_startup_delivery_pending",
                scheduledActionId: definition.action.id,
              },
              "Scheduled message delivery is pending runtime reconciliation",
            );
          }
        });
      } catch (error) {
        logger.warn(
          {
            event: "scheduled_message_startup_recovery_failed",
            executingScanned,
            activeScanned,
            durationMs: Date.now() - startedAt,
          },
          "Scheduled message startup recovery failed",
        );
        throw error instanceof ScheduledMessageStartupRecoveryError
          ? error
          : new ScheduledMessageStartupRecoveryError();
      }
      logger.info(
        {
          event: "scheduled_message_startup_recovery_completed",
          executingScanned,
          activeScanned,
          durationMs: Date.now() - startedAt,
        },
        "Scheduled message startup recovery completed",
      );
    },
  };
}

export function createScheduledMessageRuntimeReconciler({
  scheduledActions,
  store,
  executor,
  delivery,
  logger,
  now = () => new Date(),
}: RuntimeDependencies): ScheduledMessageRuntimeReconciler {
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const runSweep = async (): Promise<void> => {
    const startedAt = Date.now();
    let scanned = 0;
    let failure = false;
    try {
      scanned = await scanActive(scheduledActions, async (action) => {
        if (!isWithinScheduledMessageGrace(action.executeAt, now())) {
          const result = await executor.execute(action.id);
          if (result.outcome === "UNCONFIRMED" || result.outcome === "RETRYABLE_FAILURE") {
            throw new Error("Scheduled message overdue transition could not be confirmed");
          }
        } else {
          const definition = await store.find(action.id);
          if (definition === undefined || definition.action.status !== "ACTIVE") {
            throw new Error("Scheduled message definition could not be loaded");
          }
          const deliveryResult = await delivery.ensureScheduledMessageDelivery({
            scheduledActionId: definition.action.id,
            executeAt: definition.action.executeAt,
            revision: definition.revision,
          });
          if (deliveryResult !== "CURRENT") {
            throw new Error("Scheduled message delivery repair is unconfirmed");
          }
        }
      });
    } catch {
      failure = true;
    }
    const fields = {
      event: failure
        ? "scheduled_message_runtime_reconciliation_failed"
        : "scheduled_message_runtime_reconciliation_completed",
      scanned,
      durationMs: Date.now() - startedAt,
    };
    if (failure) logger.warn(fields, "Scheduled message runtime reconciliation failed");
    else logger.info(fields, "Scheduled message runtime reconciliation completed");
  };
  const reconcileOnce = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    if (stopping) return Promise.resolve();
    const invocation = runSweep();
    inFlight = invocation;
    const release = (): void => {
      if (inFlight === invocation) inFlight = undefined;
    };
    void invocation.then(release, release);
    return invocation;
  };
  const scheduleNext = (): void => {
    if (!started || stopping || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void reconcileOnce().then(scheduleNext, scheduleNext);
    }, SCHEDULED_MESSAGE_RECONCILIATION_INTERVAL_MS);
  };

  return {
    start() {
      if (started) return Promise.resolve();
      if (stopping)
        return Promise.reject(new Error("Scheduled message runtime reconciliation has stopped"));
      started = true;
      scheduleNext();
      logger.info(
        {
          event: "scheduled_message_runtime_reconciliation_started",
          intervalMs: SCHEDULED_MESSAGE_RECONCILIATION_INTERVAL_MS,
        },
        "Scheduled message runtime reconciliation started",
      );
      return Promise.resolve();
    },
    reconcileOnce,
    stop() {
      stopping = true;
      stopPromise ??= (async () => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        await inFlight;
        started = false;
        logger.info(
          { event: "scheduled_message_runtime_reconciliation_stopped" },
          "Scheduled message runtime reconciliation stopped",
        );
      })();
      return stopPromise;
    },
  };
}
