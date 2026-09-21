import type { JobWithMetadata, PgBoss, QueueResult } from "pg-boss";
import type { Logger } from "pino";
import { z } from "zod";

import type { RecurringMessageExecutor, RecurringDelivery } from "./recurring-message-execution.js";
import type { RecurringMessageStore } from "./recurring-message-persistence.js";
import type { RecurringRuntimeStore } from "./recurring-message-runtime-persistence.js";

export const RECURRING_MESSAGE_QUEUE = "weft-recurring-message-occurrence";
const queueOptions = { policy: "exclusive", retryLimit: 0, expireInSeconds: 900 } as const;
const workOptions = { batchSize: 1, includeMetadata: true, localConcurrency: 1 } as const;
const schema = z.strictObject({
  kind: z.literal("recurring-message-occurrence"),
  scheduledActionId: z.string().min(1),
  occurrenceId: z.string().min(1),
  scheduledFor: z.iso.datetime(),
  seriesRevision: z.number().int().nonnegative(),
  retryCount: z.number().int().min(0).max(3),
});

type Boss = Pick<PgBoss, "createQueue" | "getQueue" | "upsert" | "findJobs" | "work" | "offWork">;
export type RecurringProjection = { delivery: RecurringDelivery; wakeAt: Date };
export type RecurringMessageWorker = {
  ensureQueue: () => Promise<void>;
  project: (projection: RecurringProjection) => Promise<"CURRENT" | "UNCONFIRMED">;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createRecurringMessageWorker({
  boss,
  executor,
  recurring,
  store,
  logger,
}: {
  boss: Boss;
  executor: RecurringMessageExecutor;
  recurring: Pick<RecurringMessageStore, "find">;
  store: Pick<RecurringRuntimeStore, "load">;
  logger: Pick<Logger, "info" | "warn">;
}): RecurringMessageWorker {
  let workerId: string | undefined;
  let startPromise: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  const inFlight = new Set<Promise<void>>();
  const key = (delivery: RecurringDelivery) => `${delivery.occurrenceId}:${delivery.retryCount}`;
  const matches = async (projection: RecurringProjection): Promise<boolean> => {
    const jobs = await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: key(projection.delivery) });
    return jobs.some((job) => {
      if (job.state !== "created" && job.state !== "active") return false;
      const parsed = schema.safeParse(job.data);
      if (!parsed.success) return false;
      const data = parsed.data;
      const expected = projection.delivery;
      return (
        data.kind === expected.kind &&
        data.scheduledActionId === expected.scheduledActionId &&
        data.occurrenceId === expected.occurrenceId &&
        data.scheduledFor === expected.scheduledFor &&
        data.seriesRevision === expected.seriesRevision &&
        data.retryCount === expected.retryCount &&
        (job.state !== "created" || job.startAfter.getTime() === projection.wakeAt.getTime())
      );
    });
  };
  const project = async (projection: RecurringProjection): Promise<"CURRENT" | "UNCONFIRMED"> => {
    try {
      if (await matches(projection)) return "CURRENT";
    } catch {
      return "UNCONFIRMED";
    }
    try {
      await boss.upsert(RECURRING_MESSAGE_QUEUE, projection.delivery, {
        singletonKey: key(projection.delivery),
        startAfter: projection.wakeAt,
        retryLimit: 0,
        expireInSeconds: 900,
      });
    } catch {
      /* inspect the effective projection below */
    }
    try {
      return (await matches(projection)) ? "CURRENT" : "UNCONFIRMED";
    } catch {
      return "UNCONFIRMED";
    }
  };
  const process = async (job: JobWithMetadata<unknown>): Promise<void> => {
    const parsed = schema.safeParse(job.data);
    if (!parsed.success) {
      logger.warn(
        { event: "recurring_delivery_invalid", jobId: job.id },
        "Recurring delivery is invalid",
      );
      return;
    }
    const delivery = parsed.data;
    let definition;
    try {
      definition = await store.load(delivery.occurrenceId);
    } catch {
      logger.warn(
        { event: "recurring_delivery_state_unreadable", occurrenceId: delivery.occurrenceId },
        "Recurring delivery state is unreadable",
      );
      return;
    }
    if (
      definition === undefined ||
      definition.action.id !== delivery.scheduledActionId ||
      definition.occurrence.retryCount !== delivery.retryCount
    )
      return;
    let result;
    try {
      result = await executor.execute(delivery);
    } catch {
      logger.warn(
        { event: "recurring_execution_unconfirmed", occurrenceId: delivery.occurrenceId },
        "Recurring execution is unconfirmed",
      );
      return;
    }
    logger.info(
      {
        event: "recurring_execution_finished",
        occurrenceId: delivery.occurrenceId,
        outcome: result.outcome,
        ...(result.outcome === "FAILED" ? { failureCode: result.code } : {}),
      },
      "Recurring execution finished",
    );
    if (result.outcome === "RETRY_PENDING") {
      const projected = await project({
        delivery: { ...delivery, retryCount: result.retryCount },
        wakeAt: result.wakeAt,
      });
      if (projected === "UNCONFIRMED")
        logger.warn(
          { event: "recurring_projection_unconfirmed", occurrenceId: delivery.occurrenceId },
          "Recurring retry projection is unconfirmed",
        );
    } else if (result.outcome === "COMPLETED" || result.outcome === "FAILED") {
      try {
        const series = await recurring.find(delivery.scheduledActionId);
        if (series?.action.status === "ACTIVE" && series.occurrence?.status === "PENDING") {
          const next = series.occurrence;
          await project({
            delivery: {
              kind: "recurring-message-occurrence",
              scheduledActionId: delivery.scheduledActionId,
              occurrenceId: next.id,
              scheduledFor: next.scheduledFor.toISOString(),
              seriesRevision: series.revision,
              retryCount: 0,
            },
            wakeAt: next.scheduledFor,
          });
        }
      } catch {
        logger.warn(
          { event: "recurring_next_projection_unconfirmed", occurrenceId: delivery.occurrenceId },
          "Recurring next projection is unconfirmed",
        );
      }
    }
  };
  const handler = (jobs: JobWithMetadata<unknown>[]): Promise<void> => {
    const invocation = (async () => {
      if (jobs.length === 1) await process(jobs[0]!);
    })();
    inFlight.add(invocation);
    void invocation.then(
      () => inFlight.delete(invocation),
      () => inFlight.delete(invocation),
    );
    return invocation;
  };
  return {
    async ensureQueue() {
      await boss.createQueue(RECURRING_MESSAGE_QUEUE, queueOptions);
      const queue: QueueResult | null = await boss.getQueue(RECURRING_MESSAGE_QUEUE);
      if (queue?.policy !== "exclusive" || queue.retryLimit !== 0 || queue.expireInSeconds !== 900)
        throw new Error("Recurring queue configuration is invalid");
    },
    project,
    start() {
      startPromise ??= (async () => {
        workerId = await boss.work<unknown, void, typeof workOptions>(
          RECURRING_MESSAGE_QUEUE,
          workOptions,
          handler,
        );
      })();
      return startPromise;
    },
    stop() {
      stopPromise ??= (async () => {
        await startPromise?.catch(() => undefined);
        if (workerId !== undefined)
          await boss.offWork(RECURRING_MESSAGE_QUEUE, { id: workerId, wait: true });
        while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
      })();
      return stopPromise;
    },
  };
}
