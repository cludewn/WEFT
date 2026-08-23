import type { Logger } from "pino";

import type {
  ActiveScheduledThreadCloseCursor,
  ScheduledAction,
  ScheduledActionStore,
} from "./scheduled-action-persistence.js";
import type { ScheduledThreadCloseWorkerController } from "./scheduled-thread-close-worker.js";

type RecoveryFailureCode =
  | "ACTIVE_SCAN_FAILED"
  | "EXECUTING_SCAN_FAILED"
  | "STALE_DELIVERY_CLEANUP_FAILED"
  | "EXECUTING_RELEASE_UNCONFIRMED"
  | "ENQUEUE_UNCONFIRMED";

type RecoveryStore = Pick<
  ScheduledActionStore,
  | "findById"
  | "findActiveThreadClosesPage"
  | "findExecutingThreadClosesPage"
  | "releaseExecutionForRetry"
>;

type RecoveryDelivery = Pick<
  ScheduledThreadCloseWorkerController,
  "cancelStaleActiveDeliveries" | "enqueueScheduledThreadClose" | "hasCreatedOrRetryDelivery"
>;

type RecoveryLogger = Pick<Logger, "info" | "warn">;

type RecoveryDependencies = {
  scheduledActions: RecoveryStore;
  delivery: RecoveryDelivery;
  logger: RecoveryLogger;
};

type RecoveryStats = {
  activeScanned: number;
  executingScanned: number;
  pageCount: number;
  staleActiveCancelled: number;
  interruptedReleased: number;
  enqueued: number;
  alreadyPresent: number;
  skippedCurrentState: number;
};

type ActiveSweepStats = {
  pageCount: number;
  scanned: number;
  enqueued: number;
  alreadyPresent: number;
};

type ActiveSweepDependencies = {
  scheduledActions: Pick<ScheduledActionStore, "findActiveThreadClosesPage">;
  reconcileDelivery: (action: ScheduledAction) => Promise<"ENQUEUED" | "ALREADY_PRESENT">;
};

type RuntimeFailureCode = "ACTIVE_SCAN_FAILED" | "ENQUEUE_FAILED";

type RuntimeDependencies = {
  scheduledActions: Pick<ScheduledActionStore, "findActiveThreadClosesPage">;
  delivery: Pick<ScheduledThreadCloseWorkerController, "enqueueScheduledThreadClose">;
  logger: RecoveryLogger;
};

export const SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS = 60_000;

export type ScheduledThreadCloseStartupReconciler = {
  recoverAtStartup: () => Promise<void>;
};

export type ScheduledThreadCloseRuntimeReconciler = {
  start: () => Promise<void>;
  reconcileOnce: () => Promise<void>;
  stop: () => Promise<void>;
};

export class ScheduledThreadCloseStartupRecoveryError extends Error {
  readonly failureCode: RecoveryFailureCode;

  constructor(failureCode: RecoveryFailureCode) {
    super("Scheduled thread close startup recovery failed");
    this.name = "ScheduledThreadCloseStartupRecoveryError";
    this.failureCode = failureCode;
  }
}

class ScheduledThreadCloseRuntimeReconciliationError extends Error {
  readonly failureCode: RuntimeFailureCode;

  constructor(failureCode: RuntimeFailureCode) {
    super("Scheduled thread close runtime reconciliation failed");
    this.name = "ScheduledThreadCloseRuntimeReconciliationError";
    this.failureCode = failureCode;
  }
}

async function reconcileActiveScheduledThreadCloseDeliveries(
  { scheduledActions, reconcileDelivery }: ActiveSweepDependencies,
  stats: ActiveSweepStats,
): Promise<void> {
  let cursor: ActiveScheduledThreadCloseCursor | undefined;
  for (;;) {
    const page = await scheduledActions.findActiveThreadClosesPage(cursor);
    if (page.length === 0) {
      return;
    }
    stats.pageCount += 1;

    for (const action of page) {
      stats.scanned += 1;
      const result = await reconcileDelivery(action);
      if (result === "ENQUEUED") {
        stats.enqueued += 1;
      } else {
        stats.alreadyPresent += 1;
      }
    }

    const last = page.at(-1)!;
    cursor = { executeAt: last.executeAt, id: last.id };
  }
}

export function createScheduledThreadCloseStartupReconciler({
  scheduledActions,
  delivery,
  logger,
}: RecoveryDependencies): ScheduledThreadCloseStartupReconciler {
  const cleanupStaleDeliveries = async (
    scheduledActionId: string,
    stats: RecoveryStats,
  ): Promise<void> => {
    try {
      stats.staleActiveCancelled += await delivery.cancelStaleActiveDeliveries(scheduledActionId);
    } catch {
      throw new ScheduledThreadCloseStartupRecoveryError("STALE_DELIVERY_CLEANUP_FAILED");
    }
  };

  const recoverInterruptedExecutionsAtStartup = async (stats: RecoveryStats): Promise<void> => {
    let afterId: string | undefined;
    for (;;) {
      let page: ScheduledAction[];
      try {
        page = await scheduledActions.findExecutingThreadClosesPage(afterId);
      } catch {
        throw new ScheduledThreadCloseStartupRecoveryError("EXECUTING_SCAN_FAILED");
      }
      if (page.length === 0) {
        return;
      }
      stats.pageCount += 1;

      for (const action of page) {
        stats.executingScanned += 1;
        await cleanupStaleDeliveries(action.id, stats);

        let current: ScheduledAction | undefined;
        try {
          current = (await scheduledActions.releaseExecutionForRetry(action.id)).current;
        } catch {
          try {
            current = await scheduledActions.findById(action.id);
          } catch {
            throw new ScheduledThreadCloseStartupRecoveryError("EXECUTING_RELEASE_UNCONFIRMED");
          }
        }

        if (current?.status === "ACTIVE") {
          stats.interruptedReleased += 1;
        } else if (
          current === undefined ||
          current.status === "CANCELLED" ||
          current.status === "COMPLETED" ||
          current.status === "FAILED"
        ) {
          stats.skippedCurrentState += 1;
        } else {
          throw new ScheduledThreadCloseStartupRecoveryError("EXECUTING_RELEASE_UNCONFIRMED");
        }
      }

      afterId = page.at(-1)!.id;
    }
  };

  const reconcileActiveDeliveriesAtStartup = async (stats: RecoveryStats): Promise<void> => {
    const activeStats = createActiveSweepStats();
    try {
      await reconcileActiveScheduledThreadCloseDeliveries(
        {
          scheduledActions,
          reconcileDelivery: async (action) => {
            await cleanupStaleDeliveries(action.id, stats);

            try {
              return await delivery.enqueueScheduledThreadClose(action.id, action.executeAt);
            } catch {
              let confirmed = false;
              try {
                confirmed = await delivery.hasCreatedOrRetryDelivery(action.id);
              } catch {
                // Confirmation failure is handled by the fatal result below.
              }
              if (!confirmed) {
                throw new ScheduledThreadCloseStartupRecoveryError("ENQUEUE_UNCONFIRMED");
              }
              return "ALREADY_PRESENT";
            }
          },
        },
        activeStats,
      );
    } catch (error) {
      if (error instanceof ScheduledThreadCloseStartupRecoveryError) {
        throw error;
      }
      throw new ScheduledThreadCloseStartupRecoveryError("ACTIVE_SCAN_FAILED");
    }

    stats.pageCount += activeStats.pageCount;
    stats.activeScanned += activeStats.scanned;
    stats.enqueued += activeStats.enqueued;
    stats.alreadyPresent += activeStats.alreadyPresent;
  };

  return {
    async recoverAtStartup(): Promise<void> {
      const startedAt = Date.now();
      const stats: RecoveryStats = {
        activeScanned: 0,
        executingScanned: 0,
        pageCount: 0,
        staleActiveCancelled: 0,
        interruptedReleased: 0,
        enqueued: 0,
        alreadyPresent: 0,
        skippedCurrentState: 0,
      };

      try {
        await recoverInterruptedExecutionsAtStartup(stats);
        await reconcileActiveDeliveriesAtStartup(stats);
      } catch (error) {
        const failureCode =
          error instanceof ScheduledThreadCloseStartupRecoveryError
            ? error.failureCode
            : "ACTIVE_SCAN_FAILED";
        logger.warn(
          {
            event: "scheduled_thread_close_startup_recovery_failed",
            mode: "startup",
            failureCode,
            durationMs: Date.now() - startedAt,
          },
          "Scheduled thread close startup recovery failed",
        );
        throw error;
      }

      logger.info(
        {
          event: "scheduled_thread_close_startup_recovery_completed",
          mode: "startup",
          ...stats,
          durationMs: Date.now() - startedAt,
        },
        "Scheduled thread close startup recovery completed",
      );
    },
  };
}

export function createScheduledThreadCloseRuntimeReconciler({
  scheduledActions,
  delivery,
  logger,
}: RuntimeDependencies): ScheduledThreadCloseRuntimeReconciler {
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const runSweep = async (): Promise<void> => {
    const startedAt = Date.now();
    const stats = createActiveSweepStats();
    let failureCode: RuntimeFailureCode | undefined;

    try {
      await reconcileActiveScheduledThreadCloseDeliveries(
        {
          scheduledActions,
          reconcileDelivery: async (action) => {
            try {
              return await delivery.enqueueScheduledThreadClose(action.id, action.executeAt);
            } catch {
              throw new ScheduledThreadCloseRuntimeReconciliationError("ENQUEUE_FAILED");
            }
          },
        },
        stats,
      );
    } catch (error) {
      failureCode =
        error instanceof ScheduledThreadCloseRuntimeReconciliationError
          ? error.failureCode
          : "ACTIVE_SCAN_FAILED";
    }

    const fields = {
      event:
        failureCode === undefined
          ? "scheduled_thread_close_runtime_reconciliation_completed"
          : "scheduled_thread_close_runtime_reconciliation_failed",
      mode: "periodic",
      ...stats,
      durationMs: Date.now() - startedAt,
      outcome: failureCode === undefined ? "COMPLETED" : "FAILED",
      ...(failureCode === undefined ? {} : { failureCode }),
    };
    if (failureCode === undefined) {
      logger.info(fields, "Scheduled thread close runtime reconciliation completed");
    } else {
      logger.warn(fields, "Scheduled thread close runtime reconciliation failed");
    }
  };

  const reconcileOnce = (): Promise<void> => {
    if (inFlight !== undefined) {
      return inFlight;
    }
    if (stopping) {
      return Promise.resolve();
    }

    const invocation = runSweep();
    inFlight = invocation;
    const releaseInvocation = (): void => {
      if (inFlight === invocation) {
        inFlight = undefined;
      }
    };
    void invocation.then(releaseInvocation, releaseInvocation);
    return invocation;
  };

  const scheduleNext = (): void => {
    if (!started || stopping || timer !== undefined) {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void reconcileOnce().then(scheduleNext, scheduleNext);
    }, SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);
  };

  return {
    start(): Promise<void> {
      if (started) {
        return Promise.resolve();
      }
      if (stopping) {
        return Promise.reject(
          new Error("Scheduled thread close runtime reconciliation has stopped"),
        );
      }

      started = true;
      scheduleNext();
      logger.info(
        {
          event: "scheduled_thread_close_runtime_reconciliation_started",
          mode: "periodic",
          intervalMs: SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS,
        },
        "Scheduled thread close runtime reconciliation started",
      );
      return Promise.resolve();
    },

    reconcileOnce,

    stop(): Promise<void> {
      stopping = true;
      stopPromise ??= (async () => {
        const startedAt = Date.now();
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        await inFlight;
        started = false;
        logger.info(
          {
            event: "scheduled_thread_close_runtime_reconciliation_stopped",
            mode: "periodic",
            durationMs: Date.now() - startedAt,
          },
          "Scheduled thread close runtime reconciliation stopped",
        );
      })();
      return stopPromise;
    },
  };
}

function createActiveSweepStats(): ActiveSweepStats {
  return {
    pageCount: 0,
    scanned: 0,
    enqueued: 0,
    alreadyPresent: 0,
  };
}
