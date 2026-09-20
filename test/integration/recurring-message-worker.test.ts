import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";
import type { RecurringDelivery } from "../../src/recurring-message-execution.js";
import { createRecurringMessageReconciler } from "../../src/recurring-message-reconciler.js";
import type {
  RecurringRuntimeDefinition,
  RecurringRuntimeStore,
} from "../../src/recurring-message-runtime-persistence.js";
import {
  createRecurringMessageWorker,
  RECURRING_MESSAGE_QUEUE,
} from "../../src/recurring-message-worker.js";

const config = loadTestDatabaseConfig();
const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;
const runtime = createPgBossRuntime(config, logger);
const boss = runtime.client;
const worker = createRecurringMessageWorker({
  boss,
  executor: { execute: () => Promise.resolve({ outcome: "SKIPPED" as const }) },
  recurring: { find: () => Promise.resolve(undefined) },
  store: { load: () => Promise.resolve(undefined) },
  logger,
});

beforeAll(async () => {
  await runtime.start();
  await worker.ensureQueue();
});
afterAll(async () => {
  await worker.stop();
  await boss.deleteAllJobs(RECURRING_MESSAGE_QUEUE);
  await boss.deleteQueue(RECURRING_MESSAGE_QUEUE);
  await runtime.stop();
});

function delivery(occurrenceId: string, retryCount: number): RecurringDelivery {
  return {
    kind: "recurring-message-occurrence",
    scheduledActionId: `series-${occurrenceId}`,
    occurrenceId,
    scheduledFor: new Date(Date.now() - 60_000).toISOString(),
    seriesRevision: 0,
    retryCount,
  };
}

describe("recurring pg-boss delivery", () => {
  it("uses an exclusive queue with no built-in retry", async () => {
    expect(await boss.getQueue(RECURRING_MESSAGE_QUEUE)).toMatchObject({
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 900,
    });
  });

  it("deduplicates one generation and projects the next while the old is active", async () => {
    const occurrenceId = randomUUID();
    const initial = delivery(occurrenceId, 0);
    const wakeAt = new Date(initial.scheduledFor);
    expect(await worker.project({ delivery: initial, wakeAt })).toBe("CURRENT");
    expect(await worker.project({ delivery: initial, wakeAt })).toBe("CURRENT");
    expect(
      (await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:0` })).filter(
        (job) => job.state === "created",
      ),
    ).toHaveLength(1);
    const fetched = await boss.fetch<RecurringDelivery>(RECURRING_MESSAGE_QUEUE, {
      batchSize: 1,
      includeMetadata: true,
    });
    expect(fetched.some((job) => job.data.occurrenceId === occurrenceId)).toBe(true);
    expect(await worker.project({ delivery: { ...initial, retryCount: 1 }, wakeAt })).toBe(
      "CURRENT",
    );
    expect(
      (await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:1` })).filter(
        (job) => job.state === "created",
      ),
    ).toHaveLength(1);
    await boss.complete(
      RECURRING_MESSAGE_QUEUE,
      fetched.map((job) => job.id),
    );
  });

  it("repairs a missing delivery projection from authoritative pending state", async () => {
    const occurrenceId = randomUUID();
    const scheduledFor = new Date(Date.now() + 10 * 60_000);
    const pending = {
      action: { id: `series-${occurrenceId}`, status: "ACTIVE" },
      state: { revision: 0 },
      occurrence: { id: occurrenceId, status: "PENDING", scheduledFor },
    } as RecurringRuntimeDefinition;
    const reconciler = createRecurringMessageReconciler({
      store: {
        page: (status: RecurringRuntimeDefinition["occurrence"]["status"]) =>
          Promise.resolve(status === "PENDING" ? [pending] : []),
        pageMissing: () => Promise.resolve([]),
      } as unknown as RecurringRuntimeStore,
      worker,
      logger,
    });
    expect(await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:0` })).toHaveLength(
      0,
    );
    await reconciler.recoverAtStartup();
    const [job] = await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:0` });
    expect(job).toMatchObject({ state: "created" });
    expect(job?.startAfter.getTime()).toBe(scheduledFor.getTime());
  });

  it("acknowledges a stale delivery normally without pg-boss retry", async () => {
    await worker.start();
    const occurrenceId = randomUUID();
    const stale = delivery(occurrenceId, 0);
    expect(await worker.project({ delivery: stale, wakeAt: new Date(stale.scheduledFor) })).toBe(
      "CURRENT",
    );
    let state: string | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [job] = await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:0` });
      state = job?.state;
      if (state === "completed") break;
      await setTimeout(200);
    }
    expect(state).toBe("completed");
    const [job] = await boss.findJobs(RECURRING_MESSAGE_QUEUE, { key: `${occurrenceId}:0` });
    expect(job?.retryCount).toBe(0);
  });
});
