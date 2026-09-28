import type { Logger } from "pino";

import {
  AUDIT_RETENTION_SOURCES,
  type AuditRetentionStore,
} from "./audit-retention-persistence.js";
import { safeErrorName } from "./application-runtime.js";

export const AUDIT_RETENTION_DURATION_MS = 90 * 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUDIT_RETENTION_BATCH_SIZE = 500;

export type AuditRetentionRuntime = {
  start: () => Promise<void>;
  sweepOnce: () => Promise<void>;
  stop: () => Promise<void>;
};

type Dependencies = {
  persistence: AuditRetentionStore;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
};

export function createAuditRetentionRuntime({
  persistence,
  logger,
  now = () => new Date(),
}: Dependencies): AuditRetentionRuntime {
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const clearPendingTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const runSweep = async (): Promise<void> => {
    const durationStartedAt = Date.now();
    const startedAt = now();
    const cutoff = new Date(startedAt.getTime() - AUDIT_RETENTION_DURATION_MS);
    let totalDeletedCount = 0;
    let totalBatchCount = 0;
    let failedSourceCount = 0;

    for (const source of AUDIT_RETENTION_SOURCES) {
      if (stopping) break;
      try {
        for (;;) {
          if (stopping) break;
          const deletedCount = await persistence.deleteExpiredBatch(
            source,
            cutoff,
            AUDIT_RETENTION_BATCH_SIZE,
          );
          if (deletedCount === 0) break;
          totalDeletedCount += deletedCount;
          totalBatchCount += 1;
          if (stopping) break;
        }
      } catch (error) {
        failedSourceCount += 1;
        logger.warn(
          {
            event: "audit_retention_source_cleanup_failed",
            source,
            cutoff,
            errorName: safeErrorName(error),
          },
          "Audit retention source cleanup failed",
        );
      }
    }

    logger.info(
      {
        event: "audit_retention_sweep_completed",
        cutoff,
        totalDeletedCount,
        totalBatchCount,
        failedSourceCount,
        durationMs: Date.now() - durationStartedAt,
        stopped: stopping,
      },
      "Audit retention sweep completed",
    );
  };

  const schedule = (delayMs: number): void => {
    if (!started || stopping || timer !== undefined || inFlight !== undefined) return;
    const scheduledTimer = setTimeout(() => {
      if (timer !== scheduledTimer) return;
      timer = undefined;
      void sweepOnce().catch((error: unknown) => {
        logger.warn(
          { event: "audit_retention_sweep_failed", errorName: safeErrorName(error) },
          "Audit retention sweep failed",
        );
      });
    }, delayMs);
    timer = scheduledTimer;
  };

  const sweepOnce = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight;
    if (stopping) return Promise.resolve();
    clearPendingTimer();
    const invocation = runSweep();
    inFlight = invocation;
    const release = (): void => {
      if (inFlight === invocation) {
        inFlight = undefined;
        schedule(AUDIT_RETENTION_SWEEP_INTERVAL_MS);
      }
    };
    void invocation.then(release, release);
    return invocation;
  };

  return {
    start(): Promise<void> {
      if (stopping) return Promise.reject(new Error("Audit retention runtime has stopped"));
      if (!started) {
        started = true;
        schedule(0);
        logger.info(
          {
            event: "audit_retention_runtime_started",
            intervalMs: AUDIT_RETENTION_SWEEP_INTERVAL_MS,
          },
          "Audit retention runtime started",
        );
      }
      return Promise.resolve();
    },
    sweepOnce,
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopping = true;
      clearPendingTimer();
      stopPromise = (async () => {
        await inFlight;
        started = false;
        logger.info(
          { event: "audit_retention_runtime_stopped" },
          "Audit retention runtime stopped",
        );
      })();
      return stopPromise;
    },
  };
}
