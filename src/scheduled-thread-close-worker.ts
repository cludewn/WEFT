import { randomUUID } from "node:crypto";

import type { JobWithMetadata, PgBoss, QueueResult } from "pg-boss";
import type { Logger } from "pino";
import { z } from "zod";

import type { ScheduledActionStore } from "./scheduled-action-persistence.js";
import type {
  ScheduledThreadCloseExecutionAuditIds,
  ScheduledThreadCloseExecutionFailureCode,
  ScheduledThreadCloseExecutor,
} from "./scheduled-thread-close.js";

export const SCHEDULED_THREAD_CLOSE_QUEUE = "weft-close-thread";
export const SCHEDULED_THREAD_CLOSE_WORKER_COUNT = 4;

const queueOptions = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 86_399,
} as const;

const workOptions = {
  batchSize: 1,
  includeMetadata: true,
} as const;

const scheduledThreadClosePayload = z.strictObject({
  scheduledActionId: z.string().min(1),
});

type ScheduledThreadClosePayload = z.infer<typeof scheduledThreadClosePayload>;

type PgBossScheduledThreadCloseClient = Pick<
  PgBoss,
  "createQueue" | "getQueue" | "send" | "work" | "offWork" | "findJobs" | "cancel"
>;

type WorkerLogger = Pick<Logger, "debug" | "info" | "warn">;

export type ScheduledThreadCloseEnqueueResult = "ENQUEUED" | "ALREADY_PRESENT";

export type ScheduledThreadCloseWorkerController = {
  ensureQueue: () => Promise<void>;
  enqueueScheduledThreadClose: (
    scheduledActionId: string,
    executeAt: Date,
  ) => Promise<ScheduledThreadCloseEnqueueResult>;
  cancelStaleActiveDeliveries: (scheduledActionId: string) => Promise<number>;
  hasCreatedOrRetryDelivery: (scheduledActionId: string) => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type Dependencies = {
  boss: PgBossScheduledThreadCloseClient;
  scheduledActions: Pick<ScheduledActionStore, "findById">;
  executor: ScheduledThreadCloseExecutor;
  logger: WorkerLogger;
};

type RetryableDeliveryFailureCode =
  | ScheduledThreadCloseExecutionFailureCode
  | "SCHEDULED_ACTION_LOAD_FAILED"
  | "SCHEDULED_THREAD_CLOSE_EXECUTOR_FAILED";

export class ScheduledThreadCloseDeliveryRetryError extends Error {
  readonly failureCode: RetryableDeliveryFailureCode;

  constructor(failureCode: RetryableDeliveryFailureCode) {
    super("Scheduled thread close delivery can be retried");
    this.name = "ScheduledThreadCloseDeliveryRetryError";
    this.failureCode = failureCode;
  }
}

export function createScheduledThreadCloseWorkerController({
  boss,
  scheduledActions,
  executor,
  logger,
}: Dependencies): ScheduledThreadCloseWorkerController {
  const workerIds: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const processJob = async (job: JobWithMetadata<unknown>): Promise<void> => {
    const parsed = scheduledThreadClosePayload.safeParse(job.data);
    if (!parsed.success) {
      logger.warn(
        {
          event: "scheduled_thread_close_payload_invalid",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        },
        "Scheduled thread close delivery payload is invalid",
      );
      return;
    }

    const { scheduledActionId } = parsed.data;
    let action;
    try {
      action = await scheduledActions.findById(scheduledActionId);
    } catch {
      rejectRetryableDelivery(logger, job, scheduledActionId, "SCHEDULED_ACTION_LOAD_FAILED");
    }

    if (action === undefined) {
      logger.debug(
        {
          event: "scheduled_thread_close_delivery_skipped",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          reason: "MISSING",
        },
        "Scheduled thread close delivery was skipped",
      );
      return;
    }

    if (action.status === "EXECUTING") {
      logger.warn(
        {
          event: "scheduled_thread_close_execution_recovery_required",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          persistedStatus: action.status,
        },
        "Scheduled thread close execution requires later recovery",
      );
      return;
    }

    if (
      action.status === "CANCELLED" ||
      action.status === "COMPLETED" ||
      action.status === "FAILED"
    ) {
      logger.debug(
        {
          event: "scheduled_thread_close_delivery_skipped",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          persistedStatus: action.status,
          reason: "NOT_ACTIVE",
        },
        "Scheduled thread close delivery was skipped",
      );
      return;
    }

    if (action.actionType !== "CLOSE_THREAD") {
      logger.warn(
        {
          event: "scheduled_thread_close_action_type_mismatch",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          persistedStatus: action.status,
        },
        "Scheduled thread close delivery action type does not match",
      );
      return;
    }

    if (action.executeAt.getTime() > Date.now()) {
      logger.warn(
        {
          event: "scheduled_thread_close_delivery_not_due",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          persistedStatus: action.status,
        },
        "Scheduled thread close delivery arrived before its execution time",
      );
      return;
    }

    const auditIds: ScheduledThreadCloseExecutionAuditIds = {
      attemptAuditId: randomUUID(),
      executionAuditId: randomUUID(),
    };
    logger.debug(
      {
        event: "scheduled_thread_close_execution_started",
        queue: SCHEDULED_THREAD_CLOSE_QUEUE,
        jobId: job.id,
        scheduledActionId,
        ...auditIds,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      },
      "Scheduled thread close execution started",
    );

    let result;
    try {
      result = await executor.execute(action, auditIds);
    } catch {
      rejectRetryableDelivery(
        logger,
        job,
        scheduledActionId,
        "SCHEDULED_THREAD_CLOSE_EXECUTOR_FAILED",
        auditIds,
      );
    }

    if (result.outcome === "RETRYABLE_FAILURE") {
      rejectRetryableDelivery(logger, job, scheduledActionId, result.code, auditIds);
    }

    logger.info(
      {
        event: "scheduled_thread_close_execution_finished",
        queue: SCHEDULED_THREAD_CLOSE_QUEUE,
        jobId: job.id,
        scheduledActionId,
        ...auditIds,
        outcome: result.outcome,
        ...(result.outcome === "SKIPPED" ? { reason: result.reason } : {}),
        ...(result.outcome === "PERMANENT_FAILURE" ? { failureCode: result.code } : {}),
      },
      "Scheduled thread close execution finished",
    );
  };

  const handler = (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
    const invocation =
      jobs.length === 1
        ? processJob(jobs[0]!)
        : Promise.resolve().then(() => {
            logger.warn(
              {
                event: "scheduled_thread_close_worker_batch_invalid",
                queue: SCHEDULED_THREAD_CLOSE_QUEUE,
                jobCount: jobs.length,
              },
              "Scheduled thread close worker received an unexpected batch",
            );
          });
    inFlight.add(invocation);
    void invocation.then(
      () => inFlight.delete(invocation),
      () => inFlight.delete(invocation),
    );
    return invocation;
  };

  const stopRegisteredWorkers = async (): Promise<number> => {
    const registeredIds = [...workerIds];
    const results = await Promise.allSettled(
      registeredIds.map((id) => boss.offWork(SCHEDULED_THREAD_CLOSE_QUEUE, { id, wait: true })),
    );

    const stoppedIds = new Set(
      registeredIds.filter((_, index) => results[index]?.status === "fulfilled"),
    );
    workerIds.splice(0, workerIds.length, ...workerIds.filter((id) => !stoppedIds.has(id)));

    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }

    if (results.some((result) => result.status === "rejected")) {
      throw new Error("Scheduled thread close worker shutdown failed");
    }
    return stoppedIds.size;
  };

  return {
    async ensureQueue(): Promise<void> {
      await boss.createQueue(SCHEDULED_THREAD_CLOSE_QUEUE, queueOptions);
      const queue = await boss.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
      if (!hasRequiredQueueConfiguration(queue)) {
        logger.warn(
          {
            event: "scheduled_thread_close_queue_configuration_invalid",
            queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          },
          "Scheduled thread close queue configuration is invalid",
        );
        throw new Error("Scheduled thread close queue configuration is invalid");
      }
      logger.info(
        { event: "scheduled_thread_close_queue_ready", queue: SCHEDULED_THREAD_CLOSE_QUEUE },
        "Scheduled thread close queue is ready",
      );
    },

    async enqueueScheduledThreadClose(scheduledActionId, executeAt) {
      const jobId = await boss.send(
        SCHEDULED_THREAD_CLOSE_QUEUE,
        { scheduledActionId } satisfies ScheduledThreadClosePayload,
        { singletonKey: scheduledActionId, startAfter: executeAt },
      );
      const result = jobId === null ? "ALREADY_PRESENT" : "ENQUEUED";
      logger.debug(
        {
          event: "scheduled_thread_close_enqueued",
          queue: SCHEDULED_THREAD_CLOSE_QUEUE,
          scheduledActionId,
          enqueueResult: result,
          ...(jobId === null ? {} : { jobId }),
        },
        "Scheduled thread close delivery enqueue completed",
      );
      return result;
    },

    async cancelStaleActiveDeliveries(scheduledActionId) {
      const jobs = await boss.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE, {
        key: scheduledActionId,
      });
      const activeJobIds = jobs.filter((job) => job.state === "active").map((job) => job.id);
      if (activeJobIds.length === 0) {
        return 0;
      }

      try {
        await boss.cancel(SCHEDULED_THREAD_CLOSE_QUEUE, activeJobIds);
      } catch {
        // A rejected client promise may have applied the cancellation. Confirmation below is final.
      }

      const confirmedJobs = await boss.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE, {
        key: scheduledActionId,
      });
      if (confirmedJobs.some((job) => job.state === "active")) {
        throw new Error("Scheduled thread close stale delivery cleanup could not be confirmed");
      }
      return activeJobIds.length;
    },

    async hasCreatedOrRetryDelivery(scheduledActionId) {
      const jobs = await boss.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE, {
        key: scheduledActionId,
      });
      return jobs.some((job) => job.state === "created" || job.state === "retry");
    },

    start(): Promise<void> {
      startPromise ??= (async () => {
        const startedAt = Date.now();
        try {
          for (let index = 0; index < SCHEDULED_THREAD_CLOSE_WORKER_COUNT; index += 1) {
            if (stopping) {
              throw new Error("Scheduled thread close workers are stopping");
            }
            const workerId = await boss.work<unknown, void, typeof workOptions>(
              SCHEDULED_THREAD_CLOSE_QUEUE,
              workOptions,
              handler,
            );
            workerIds.push(workerId);
          }
          logger.info(
            {
              event: "scheduled_thread_close_workers_started",
              queue: SCHEDULED_THREAD_CLOSE_QUEUE,
              workerCount: workerIds.length,
              durationMs: Date.now() - startedAt,
            },
            "Scheduled thread close workers started",
          );
        } catch (error) {
          try {
            await stopRegisteredWorkers();
          } catch {
            logger.warn(
              {
                event: "scheduled_thread_close_worker_startup_cleanup_failed",
                queue: SCHEDULED_THREAD_CLOSE_QUEUE,
              },
              "Scheduled thread close worker startup cleanup failed",
            );
          }
          throw error;
        }
      })();
      return startPromise;
    },

    stop(): Promise<void> {
      stopping = true;
      stopPromise ??= (async () => {
        const startedAt = Date.now();
        await startPromise?.catch(() => undefined);
        const stoppedWorkerCount = await stopRegisteredWorkers();
        logger.info(
          {
            event: "scheduled_thread_close_workers_stopped",
            queue: SCHEDULED_THREAD_CLOSE_QUEUE,
            workerCount: stoppedWorkerCount,
            durationMs: Date.now() - startedAt,
          },
          "Scheduled thread close workers stopped",
        );
      })();
      return stopPromise;
    },
  };
}

function hasRequiredQueueConfiguration(queue: QueueResult | null): boolean {
  return (
    queue !== null &&
    queue.policy === queueOptions.policy &&
    queue.retryLimit === queueOptions.retryLimit &&
    queue.retryDelay === queueOptions.retryDelay &&
    queue.retryBackoff === queueOptions.retryBackoff &&
    queue.retryDelayMax === queueOptions.retryDelayMax &&
    queue.expireInSeconds === queueOptions.expireInSeconds
  );
}

/**
 * Rejects one delivery attempt so pg-boss can retry it.
 *
 * Delivery retry exhaustion is reported through operational logging only. It does not change the
 * authoritative scheduled action and never records a scheduled-close execution audit.
 */
function rejectRetryableDelivery(
  logger: WorkerLogger,
  job: JobWithMetadata<unknown>,
  scheduledActionId: string,
  failureCode: RetryableDeliveryFailureCode,
  auditIds?: ScheduledThreadCloseExecutionAuditIds,
): never {
  logger.warn(
    {
      event: "scheduled_thread_close_delivery_retryable",
      queue: SCHEDULED_THREAD_CLOSE_QUEUE,
      jobId: job.id,
      scheduledActionId,
      ...(auditIds ?? {}),
      failureCode,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
    },
    "Scheduled thread close delivery will be retried",
  );
  if (job.retryCount >= job.retryLimit) {
    logger.warn(
      {
        event: "scheduled_thread_close_delivery_retry_exhausted",
        queue: SCHEDULED_THREAD_CLOSE_QUEUE,
        jobId: job.id,
        scheduledActionId,
        ...(auditIds ?? {}),
        failureCode,
        retryCount: job.retryCount,
        retryLimit: job.retryLimit,
      },
      "Scheduled thread close delivery retry budget is exhausted",
    );
  }
  throw new ScheduledThreadCloseDeliveryRetryError(failureCode);
}
