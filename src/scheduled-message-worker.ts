import type { JobWithMetadata, PgBoss, QueueResult } from "pg-boss";
import type { Logger } from "pino";
import { z } from "zod";

import type { ScheduledActionStore } from "./scheduled-action-persistence.js";
import type { ScheduledMessageExecutor } from "./scheduled-message-execution.js";

export const SCHEDULED_MESSAGE_QUEUE = "weft-send-message";
export const SCHEDULED_MESSAGE_WORKER_COUNT = 1;

const queueOptions = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 900,
} as const;
const workOptions = { batchSize: 1, includeMetadata: true } as const;
const payloadSchema = z.strictObject({ scheduledActionId: z.string().min(1) });
type Payload = z.infer<typeof payloadSchema>;

type BossClient = Pick<
  PgBoss,
  "createQueue" | "getQueue" | "send" | "work" | "offWork" | "findJobs" | "cancel"
>;
type WorkerLogger = Pick<Logger, "debug" | "info" | "warn">;

export class ScheduledMessageDeliveryRetryError extends Error {
  constructor() {
    super("Scheduled message delivery can be retried safely");
    this.name = "ScheduledMessageDeliveryRetryError";
  }
}

export type ScheduledMessageWorkerController = {
  ensureQueue: () => Promise<void>;
  enqueueScheduledMessage: (
    scheduledActionId: string,
    executeAt: Date,
  ) => Promise<"ENQUEUED" | "ALREADY_PRESENT">;
  cancelStaleActiveDeliveries: (scheduledActionId: string) => Promise<number>;
  hasCreatedOrRetryDelivery: (scheduledActionId: string) => Promise<boolean>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type Dependencies = {
  boss: BossClient;
  scheduledActions: Pick<ScheduledActionStore, "findById">;
  executor: ScheduledMessageExecutor;
  logger: WorkerLogger;
};

export function createScheduledMessageWorkerController({
  boss,
  scheduledActions,
  executor,
  logger,
}: Dependencies): ScheduledMessageWorkerController {
  const workerIds: string[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopping = false;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const processJob = async (job: JobWithMetadata<unknown>): Promise<void> => {
    const parsed = payloadSchema.safeParse(job.data);
    if (!parsed.success) {
      logger.warn(
        {
          event: "scheduled_message_payload_invalid",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
        },
        "Scheduled message delivery payload is invalid",
      );
      return;
    }
    const { scheduledActionId } = parsed.data;
    let action;
    try {
      action = await scheduledActions.findById(scheduledActionId);
    } catch {
      logger.warn(
        {
          event: "scheduled_message_authoritative_state_unconfirmed",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
        },
        "Scheduled message authoritative state could not be read",
      );
      return;
    }
    if (
      action === undefined ||
      action.status === "CANCELLED" ||
      action.status === "COMPLETED" ||
      action.status === "FAILED"
    ) {
      logger.debug(
        {
          event: "scheduled_message_delivery_skipped",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          reason: action === undefined ? "MISSING" : "NOT_ACTIVE",
        },
        "Scheduled message delivery was skipped",
      );
      return;
    }
    if (action.status === "EXECUTING") {
      logger.warn(
        {
          event: "scheduled_message_execution_recovery_required",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
        },
        "Scheduled message execution requires startup recovery",
      );
      return;
    }
    if (action.actionType !== "SEND_MESSAGE") {
      logger.warn(
        {
          event: "scheduled_message_action_type_mismatch",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
        },
        "Scheduled message action type does not match",
      );
      return;
    }
    if (action.executeAt.getTime() > Date.now()) {
      logger.warn(
        {
          event: "scheduled_message_delivery_not_due",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
        },
        "Scheduled message delivery arrived before its execution time",
      );
      return;
    }

    let result;
    try {
      result = await executor.execute(scheduledActionId);
    } catch {
      logger.warn(
        {
          event: "scheduled_message_executor_unconfirmed",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
        },
        "Scheduled message executor failed after authoritative state was loaded",
      );
      return;
    }
    if (result.outcome === "RETRYABLE_FAILURE") {
      logger.warn(
        {
          event: "scheduled_message_delivery_retryable",
          queue: SCHEDULED_MESSAGE_QUEUE,
          jobId: job.id,
          scheduledActionId,
          failureCode: result.code,
          retryCount: job.retryCount,
          retryLimit: job.retryLimit,
        },
        "Scheduled message delivery will be retried",
      );
      throw new ScheduledMessageDeliveryRetryError();
    }
    logger.info(
      {
        event: "scheduled_message_execution_finished",
        queue: SCHEDULED_MESSAGE_QUEUE,
        jobId: job.id,
        scheduledActionId,
        outcome: result.outcome,
        ...(result.outcome === "PERMANENT_FAILURE" || result.outcome === "UNCONFIRMED"
          ? { failureCode: result.code }
          : {}),
      },
      "Scheduled message execution finished",
    );
  };

  const handler = (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
    const invocation =
      jobs.length === 1
        ? processJob(jobs[0]!)
        : Promise.resolve().then(() => {
            logger.warn(
              {
                event: "scheduled_message_worker_batch_invalid",
                queue: SCHEDULED_MESSAGE_QUEUE,
                jobCount: jobs.length,
              },
              "Scheduled message worker received an unexpected batch",
            );
          });
    inFlight.add(invocation);
    void invocation.then(
      () => inFlight.delete(invocation),
      () => inFlight.delete(invocation),
    );
    return invocation;
  };

  const stopWorkers = async (): Promise<number> => {
    const ids = [...workerIds];
    const results = await Promise.allSettled(
      ids.map((id) => boss.offWork(SCHEDULED_MESSAGE_QUEUE, { id, wait: true })),
    );
    const stopped = new Set(ids.filter((_, index) => results[index]?.status === "fulfilled"));
    workerIds.splice(0, workerIds.length, ...workerIds.filter((id) => !stopped.has(id)));
    while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    if (results.some((result) => result.status === "rejected"))
      throw new Error("Scheduled message worker shutdown failed");
    return stopped.size;
  };

  return {
    async ensureQueue() {
      await boss.createQueue(SCHEDULED_MESSAGE_QUEUE, queueOptions);
      const queue = await boss.getQueue(SCHEDULED_MESSAGE_QUEUE);
      if (!hasRequiredQueueConfiguration(queue))
        throw new Error("Scheduled message queue configuration is invalid");
      logger.info(
        { event: "scheduled_message_queue_ready", queue: SCHEDULED_MESSAGE_QUEUE },
        "Scheduled message queue is ready",
      );
    },
    async enqueueScheduledMessage(scheduledActionId, executeAt) {
      const jobId = await boss.send(
        SCHEDULED_MESSAGE_QUEUE,
        { scheduledActionId } satisfies Payload,
        { singletonKey: scheduledActionId, startAfter: executeAt },
      );
      return jobId === null ? "ALREADY_PRESENT" : "ENQUEUED";
    },
    async cancelStaleActiveDeliveries(scheduledActionId) {
      const jobs = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, { key: scheduledActionId });
      const activeIds = jobs.filter((job) => job.state === "active").map((job) => job.id);
      if (activeIds.length === 0) return 0;
      try {
        await boss.cancel(SCHEDULED_MESSAGE_QUEUE, activeIds);
      } catch {
        /* confirm below */
      }
      const confirmed = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, { key: scheduledActionId });
      if (confirmed.some((job) => job.state === "active"))
        throw new Error("Scheduled message stale delivery cleanup could not be confirmed");
      return activeIds.length;
    },
    async hasCreatedOrRetryDelivery(scheduledActionId) {
      const jobs = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, { key: scheduledActionId });
      return jobs.some((job) => job.state === "created" || job.state === "retry");
    },
    start() {
      startPromise ??= (async () => {
        for (let index = 0; index < SCHEDULED_MESSAGE_WORKER_COUNT; index += 1) {
          if (stopping) throw new Error("Scheduled message workers are stopping");
          workerIds.push(
            await boss.work<unknown, void, typeof workOptions>(
              SCHEDULED_MESSAGE_QUEUE,
              workOptions,
              handler,
            ),
          );
        }
        logger.info(
          {
            event: "scheduled_message_workers_started",
            queue: SCHEDULED_MESSAGE_QUEUE,
            workerCount: workerIds.length,
          },
          "Scheduled message workers started",
        );
      })();
      return startPromise;
    },
    stop() {
      stopping = true;
      stopPromise ??= (async () => {
        await startPromise?.catch(() => undefined);
        const workerCount = await stopWorkers();
        logger.info(
          {
            event: "scheduled_message_workers_stopped",
            queue: SCHEDULED_MESSAGE_QUEUE,
            workerCount,
          },
          "Scheduled message workers stopped",
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
