import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  RecurringRuntimeDefinition,
  RecurringRuntimeStore,
} from "./recurring-message-runtime-persistence.js";
import { RECURRING_RETRY_LIFETIME_MS } from "./recurring-message.js";
import type { RecurringMessageWorker } from "./recurring-message-worker.js";

export const RECURRING_RECONCILIATION_INTERVAL_MS = 60_000;

type Dependencies = {
  store: RecurringRuntimeStore;
  worker: Pick<RecurringMessageWorker, "project">;
  logger: Pick<Logger, "warn">;
  now?: () => Date;
};

export function createRecurringMessageReconciler({
  store,
  worker,
  logger,
  now = () => new Date(),
}: Dependencies) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;
  let running: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const projectPending = async (row: RecurringRuntimeDefinition): Promise<void> => {
    await worker.project({
      delivery: {
        kind: "recurring-message-occurrence",
        scheduledActionId: row.action.id,
        occurrenceId: row.occurrence.id,
        scheduledFor: row.occurrence.scheduledFor.toISOString(),
        seriesRevision: row.state.revision,
        retryCount: 0,
      },
      wakeAt: row.occurrence.scheduledFor,
    });
  };
  const processPending = async (row: RecurringRuntimeDefinition): Promise<void> => {
    if (row.action.status !== "ACTIVE") return;
    if (row.occurrence.scheduledFor.getTime() <= now().getTime()) {
      const nextOccurrenceId = randomUUID();
      const recovered = await store.recoverMissed({
        occurrenceId: row.occurrence.id,
        auditId: randomUUID(),
        nextOccurrenceId,
        at: now(),
      });
      if (recovered === "COMMITTED") {
        const next = await store.load(nextOccurrenceId);
        if (next?.occurrence.status === "PENDING") await projectPending(next);
        return;
      }
      if (recovered === "UNKNOWN") return;
    }
    await projectPending(row);
  };
  const processRetry = async (row: RecurringRuntimeDefinition): Promise<void> => {
    if (row.action.status !== "ACTIVE" || row.occurrence.firstAttemptedAt === null) return;
    const wakeAt = await store.retryWake(row.occurrence.id, row.occurrence.retryCount);
    if (wakeAt === undefined) {
      logger.warn(
        { event: "recurring_retry_audit_missing", occurrenceId: row.occurrence.id },
        "Recurring retry audit is missing",
      );
      return;
    }
    const deadline = row.occurrence.firstAttemptedAt.getTime() + RECURRING_RETRY_LIFETIME_MS;
    if (now().getTime() > deadline || wakeAt.getTime() > deadline) {
      await store.expireRetry({
        occurrenceId: row.occurrence.id,
        expectedRetryCount: row.occurrence.retryCount,
        auditId: randomUUID(),
        nextOccurrenceId: randomUUID(),
        occurredAt: now(),
      });
      return;
    }
    await worker.project({
      delivery: {
        kind: "recurring-message-occurrence",
        scheduledActionId: row.action.id,
        occurrenceId: row.occurrence.id,
        scheduledFor: row.occurrence.scheduledFor.toISOString(),
        seriesRevision: row.state.revision,
        retryCount: row.occurrence.retryCount,
      },
      wakeAt,
    });
  };
  const sweepState = async (
    status: RecurringRuntimeDefinition["occurrence"]["status"],
    mode: "STARTUP" | "RUNTIME",
  ): Promise<void> => {
    let afterId: string | undefined;
    for (;;) {
      const rows = await store.page(status, afterId);
      if (rows.length === 0) break;
      for (const row of rows) {
        afterId = row.occurrence.id;
        try {
          if (status === "PENDING") await processPending(row);
          else if (status === "RETRY_PENDING") await processRetry(row);
          else if (status === "EXECUTING" && mode === "STARTUP") {
            await store.terminalize({
              occurrenceId: row.occurrence.id,
              auditId: randomUUID(),
              nextOccurrenceId: randomUUID(),
              occurredAt: now(),
              failureCode: "EXECUTION_INTERRUPTED_UNCONFIRMED",
            });
          }
        } catch {
          logger.warn(
            {
              event: "recurring_reconciliation_item_failed",
              occurrenceId: row.occurrence.id,
              status,
            },
            "Recurring reconciliation item failed",
          );
        }
      }
      if (rows.length < 100) break;
    }
  };
  const sweepMissing = async (): Promise<void> => {
    let afterId: string | undefined;
    for (;;) {
      const ids = await store.pageMissing(afterId);
      if (ids.length === 0) break;
      for (const scheduledActionId of ids) {
        afterId = scheduledActionId;
        try {
          const nextOccurrenceId = randomUUID();
          const recovered = await store.recoverMissing({
            scheduledActionId,
            auditId: randomUUID(),
            nextOccurrenceId,
            at: now(),
          });
          if (recovered === "COMMITTED") {
            const next = await store.load(nextOccurrenceId);
            if (next?.occurrence.status === "PENDING") await projectPending(next);
          }
        } catch {
          logger.warn(
            { event: "recurring_missing_recovery_failed", scheduledActionId },
            "Recurring missing occurrence recovery failed",
          );
        }
      }
      if (ids.length < 100) break;
    }
  };
  const sweep = async (mode: "STARTUP" | "RUNTIME"): Promise<void> => {
    if (mode === "STARTUP") await sweepState("EXECUTING", mode);
    await sweepState("PENDING", mode);
    await sweepState("RETRY_PENDING", mode);
    await sweepMissing();
  };
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      running = sweep("RUNTIME")
        .catch(() =>
          logger.warn(
            { event: "recurring_reconciliation_failed" },
            "Recurring reconciliation failed",
          ),
        )
        .then(() => {
          running = undefined;
          schedule();
        });
    }, RECURRING_RECONCILIATION_INTERVAL_MS);
  };
  return {
    recoverAtStartup: () => sweep("STARTUP"),
    start: () => {
      if (started) return Promise.resolve();
      if (stopped) return Promise.reject(new Error("Recurring reconciliation has stopped"));
      started = true;
      schedule();
      return Promise.resolve();
    },
    stop: () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      stopPromise ??= (async () => {
        await running;
        started = false;
      })();
      return stopPromise;
    },
  };
}
