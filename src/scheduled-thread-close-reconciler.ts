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

export type ScheduledThreadCloseStartupReconciler = {
  recoverAtStartup: () => Promise<void>;
};

export class ScheduledThreadCloseStartupRecoveryError extends Error {
  readonly failureCode: RecoveryFailureCode;

  constructor(failureCode: RecoveryFailureCode) {
    super("Scheduled thread close startup recovery failed");
    this.name = "ScheduledThreadCloseStartupRecoveryError";
    this.failureCode = failureCode;
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
    let cursor: ActiveScheduledThreadCloseCursor | undefined;
    for (;;) {
      let page: ScheduledAction[];
      try {
        page = await scheduledActions.findActiveThreadClosesPage(cursor);
      } catch {
        throw new ScheduledThreadCloseStartupRecoveryError("ACTIVE_SCAN_FAILED");
      }
      if (page.length === 0) {
        return;
      }
      stats.pageCount += 1;

      for (const action of page) {
        stats.activeScanned += 1;
        await cleanupStaleDeliveries(action.id, stats);

        try {
          const result = await delivery.enqueueScheduledThreadClose(action.id, action.executeAt);
          if (result === "ENQUEUED") {
            stats.enqueued += 1;
          } else {
            stats.alreadyPresent += 1;
          }
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
          stats.alreadyPresent += 1;
        }
      }

      const last = page.at(-1)!;
      cursor = { executeAt: last.executeAt, id: last.id };
    }
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
