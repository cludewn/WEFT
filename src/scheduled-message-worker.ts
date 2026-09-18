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
const legacyPayloadSchema = z.strictObject({ scheduledActionId: z.string().min(1) });
const projectedPayloadSchema = z.strictObject({
  scheduledActionId: z.string().min(1),
  scheduledExecuteAt: z.string().min(1),
  scheduleRevision: z.number().int().nonnegative(),
});
const payloadSchema = z.union([projectedPayloadSchema, legacyPayloadSchema]);
type ProjectedPayload = z.infer<typeof projectedPayloadSchema>;

export type ScheduledMessageDeliveryProjection = {
  scheduledActionId: string;
  executeAt: Date;
  revision: number;
};
export type ScheduledMessageDeliveryInspection = "CURRENT" | "STALE" | "MISSING" | "UNCONFIRMED";
export type ScheduledMessageDeliveryRepairResult = "CURRENT" | "PENDING_RECONCILIATION";

type BossClient = Pick<
  PgBoss,
  "createQueue" | "getQueue" | "upsert" | "work" | "offWork" | "findJobs" | "cancel"
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
  inspectScheduledMessageDelivery: (
    projection: ScheduledMessageDeliveryProjection,
  ) => Promise<ScheduledMessageDeliveryInspection>;
  ensureScheduledMessageDelivery: (
    projection: ScheduledMessageDeliveryProjection,
  ) => Promise<ScheduledMessageDeliveryRepairResult>;
  cancelStaleActiveDeliveries: (scheduledActionId: string) => Promise<number>;
  cancelScheduledMessageDeliveries: (
    scheduledActionId: string,
  ) => Promise<{ outcome: "CONFIRMED" | "UNCONFIRMED"; matchedDeliveryCount: number }>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

type Dependencies = {
  boss: BossClient;
  scheduledActions: Pick<ScheduledActionStore, "findById">;
  executor: ScheduledMessageExecutor;
  logger: WorkerLogger;
};

type EffectiveJob = JobWithMetadata<unknown> & {
  state: "created" | "retry" | "active";
};
type DeliveryDetails =
  | { outcome: "CURRENT" | "STALE"; job: EffectiveJob; legacy: boolean }
  | { outcome: "MISSING" | "UNCONFIRMED" };

function projectionPayload(projection: ScheduledMessageDeliveryProjection): ProjectedPayload {
  return {
    scheduledActionId: projection.scheduledActionId,
    scheduledExecuteAt: projection.executeAt.toISOString(),
    scheduleRevision: projection.revision,
  };
}

function parseProjectedPayload(value: unknown): ProjectedPayload | undefined {
  const parsed = projectedPayloadSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const timestamp = new Date(parsed.data.scheduledExecuteAt);
  return !Number.isNaN(timestamp.getTime()) &&
    timestamp.toISOString() === parsed.data.scheduledExecuteAt
    ? parsed.data
    : undefined;
}

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

  const inspectDetails = async (
    projection: ScheduledMessageDeliveryProjection,
  ): Promise<DeliveryDetails> => {
    let jobs: JobWithMetadata<unknown>[];
    try {
      jobs = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, {
        key: projection.scheduledActionId,
      });
    } catch {
      return { outcome: "UNCONFIRMED" };
    }
    const effective = jobs.filter(
      (job): job is EffectiveJob =>
        job.state === "created" || job.state === "retry" || job.state === "active",
    );
    if (effective.length === 0) return { outcome: "MISSING" };
    if (effective.length !== 1) return { outcome: "UNCONFIRMED" };

    const job = effective[0]!;
    const projected = parseProjectedPayload(job.data);
    if (projected !== undefined) {
      if (projected.scheduledActionId !== projection.scheduledActionId) {
        return { outcome: "UNCONFIRMED" };
      }
      const timeMatches = projected.scheduledExecuteAt === projection.executeAt.toISOString();
      const startMatches = job.startAfter.getTime() === projection.executeAt.getTime();
      return {
        outcome: timeMatches && (job.state !== "created" || startMatches) ? "CURRENT" : "STALE",
        job,
        legacy: false,
      };
    }

    const legacy = legacyPayloadSchema.safeParse(job.data);
    if (!legacy.success || legacy.data.scheduledActionId !== projection.scheduledActionId) {
      return { outcome: "UNCONFIRMED" };
    }
    if (job.state === "created") {
      return {
        outcome: job.startAfter.getTime() === projection.executeAt.getTime() ? "CURRENT" : "STALE",
        job,
        legacy: true,
      };
    }
    if (job.state === "retry") return { outcome: "CURRENT", job, legacy: true };
    return { outcome: "STALE", job, legacy: true };
  };

  const confirmCurrent = async (
    projection: ScheduledMessageDeliveryProjection,
  ): Promise<ScheduledMessageDeliveryRepairResult> =>
    (await inspectDetails(projection)).outcome === "CURRENT" ? "CURRENT" : "PENDING_RECONCILIATION";

  const upsertProjection = async (
    projection: ScheduledMessageDeliveryProjection,
    updateStartAfter: boolean,
  ): Promise<ScheduledMessageDeliveryRepairResult> => {
    try {
      await boss.upsert(SCHEDULED_MESSAGE_QUEUE, projectionPayload(projection), {
        singletonKey: projection.scheduledActionId,
        ...(updateStartAfter ? { startAfter: projection.executeAt } : {}),
        retryLimit: queueOptions.retryLimit,
        retryDelay: queueOptions.retryDelay,
        retryBackoff: queueOptions.retryBackoff,
        retryDelayMax: queueOptions.retryDelayMax,
        expireInSeconds: queueOptions.expireInSeconds,
      });
    } catch {
      // An ambiguous state-changing result is resolved only by the read below.
    }
    return confirmCurrent(projection);
  };

  const processJob = async (job: JobWithMetadata<unknown>): Promise<void> => {
    const parsed = payloadSchema.safeParse(job.data);
    if (
      !parsed.success ||
      ("scheduledExecuteAt" in (parsed.success ? parsed.data : {}) &&
        parseProjectedPayload(job.data) === undefined)
    ) {
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
    async inspectScheduledMessageDelivery(projection) {
      return (await inspectDetails(projection)).outcome;
    },
    async ensureScheduledMessageDelivery(projection) {
      const inspected = await inspectDetails(projection);
      if (inspected.outcome === "UNCONFIRMED") return "PENDING_RECONCILIATION";
      if (inspected.outcome === "MISSING") return upsertProjection(projection, true);
      if (inspected.outcome === "CURRENT") {
        if (!inspected.legacy) return "CURRENT";
        // A legacy retry's startAfter is its retry wake time and must be preserved while metadata
        // is adopted. A trusted legacy created delivery already has the authoritative start time.
        return upsertProjection(projection, false);
      }
      if (inspected.outcome !== "STALE") return "PENDING_RECONCILIATION";
      if (inspected.job.state === "created" || inspected.job.state === "retry") {
        return upsertProjection(projection, true);
      }

      try {
        await boss.cancel(SCHEDULED_MESSAGE_QUEUE, inspected.job.id);
      } catch {
        // Confirm ineffectiveness below before any replacement is attempted.
      }
      let afterCancellation: JobWithMetadata<unknown>[];
      try {
        afterCancellation = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, {
          key: projection.scheduledActionId,
        });
      } catch {
        return "PENDING_RECONCILIATION";
      }
      if (
        afterCancellation.some(
          (job) =>
            job.id === inspected.job.id &&
            (job.state === "created" || job.state === "retry" || job.state === "active"),
        )
      ) {
        return "PENDING_RECONCILIATION";
      }
      return upsertProjection(projection, true);
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
    async cancelScheduledMessageDeliveries(scheduledActionId) {
      let cancellableIds: string[];
      try {
        const jobs = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, { key: scheduledActionId });
        cancellableIds = jobs
          .filter(
            (job) => job.state === "created" || job.state === "retry" || job.state === "active",
          )
          .map((job) => job.id);
      } catch {
        return { outcome: "UNCONFIRMED", matchedDeliveryCount: 0 };
      }

      if (cancellableIds.length > 0) {
        try {
          await boss.cancel(SCHEDULED_MESSAGE_QUEUE, cancellableIds);
        } catch {
          /* confirm below */
        }
      }
      try {
        const confirmed = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, {
          key: scheduledActionId,
        });
        const remaining = confirmed.some(
          (job) => job.state === "created" || job.state === "retry" || job.state === "active",
        );
        return {
          outcome: remaining ? "UNCONFIRMED" : "CONFIRMED",
          matchedDeliveryCount: cancellableIds.length,
        };
      } catch {
        return { outcome: "UNCONFIRMED", matchedDeliveryCount: cancellableIds.length };
      }
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
