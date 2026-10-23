import { randomUUID } from "node:crypto";

import type { FindJobsOptions, PgBoss } from "pg-boss";
import { Pool } from "pg";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";
import { findJobPagesByKey, isEffectiveJob } from "../../src/pg-boss-jobs.js";
import {
  createScheduledMessageWorkerController,
  SCHEDULED_MESSAGE_QUEUE,
} from "../../src/messages/scheduled-message-worker.js";
import {
  createScheduledThreadCloseWorkerController,
  SCHEDULED_THREAD_CLOSE_QUEUE,
} from "../../src/threads/scheduled-thread-close-worker.js";
import {
  createRecurringMessageWorker,
  RECURRING_MESSAGE_QUEUE,
} from "../../src/messages/recurring-message-worker.js";

const config = loadTestDatabaseConfig();
const pool = new Pool({
  host: config.host,
  port: config.port,
  database: config.name,
  user: config.user,
  password: config.password,
  ssl: config.ssl ? { rejectUnauthorized: true } : false,
});
const logger = {
  info: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as Logger;
const runtime = createPgBossRuntime(config, logger);
const boss = runtime.client;
const queues = [SCHEDULED_MESSAGE_QUEUE, SCHEDULED_THREAD_CLOSE_QUEUE, RECURRING_MESSAGE_QUEUE];
const messages = (client: Pick<PgBoss, "findJobs" | "cancel"> = boss) =>
  createScheduledMessageWorkerController({
    boss: {
      createQueue: boss.createQueue.bind(boss),
      getQueue: boss.getQueue.bind(boss),
      upsert: boss.upsert.bind(boss),
      work: boss.work.bind(boss),
      offWork: boss.offWork.bind(boss),
      findJobs: client.findJobs.bind(client),
      cancel: client.cancel.bind(client),
    },
    scheduledActions: { findById: () => Promise.resolve(undefined) },
    executor: { execute: () => Promise.resolve({ outcome: "SKIPPED", reason: "NOT_ACTIVE" }) },
    logger,
  });
const threads = createScheduledThreadCloseWorkerController({
  boss,
  scheduledActions: { findById: () => Promise.resolve(undefined) },
  executor: { execute: () => Promise.resolve({ outcome: "SKIPPED", reason: "NOT_ACTIVE" }) },
  logger,
});
const recurring = createRecurringMessageWorker({
  boss,
  executor: { execute: () => Promise.resolve({ outcome: "SKIPPED" }) },
  recurring: { find: () => Promise.resolve(undefined) },
  store: { load: () => Promise.resolve(undefined) },
  logger,
});

beforeAll(async () => {
  await runtime.start();
  await messages().ensureQueue();
  await threads.ensureQueue();
  await recurring.ensureQueue();
});
afterAll(async () => {
  for (const queue of queues) await boss.deleteQueue(queue);
  await runtime.stop();
  await pool.end();
});

// SQL is confined to disposable test data. Sub-millisecond creation times also exercise the
// library's server-side cursor precision, which must not be reconstructed from JavaScript Dates.
async function history(queue: string, key: string) {
  await pool.query(
    `insert into pgboss.job (id, name, state, singleton_key, policy, created_on, completed_on)
    select gen_random_uuid(), $1, 'completed', $2, 'exclusive', now() - interval '1 day' + n * interval '1 microsecond', now()
    from generate_series(1, 2001) n`,
    [queue, key],
  );
}
async function state(queue: string, id: string, value: "retry" | "active") {
  await pool.query(
    "update pgboss.job set state = $3::pgboss.job_state, started_on = now() where name = $1 and id = $2",
    [queue, id, value],
  );
}
async function effective(queue: string, key: string) {
  const found: string[] = [];
  for await (const page of findJobPagesByKey(boss, queue, key))
    found.push(...page.filter(isEffectiveJob).map((job) => job.id));
  return found;
}

describe("pg-boss 12.38 bounded-history regressions", () => {
  it.each(["created", "retry", "active"] as const)(
    "inspects, preserves and cancels a one-time %s job beyond 2001 terminal jobs",
    async (jobState) => {
      const key = randomUUID();
      const executeAt = new Date(Date.now() + 3600_000);
      await history(SCHEDULED_MESSAGE_QUEUE, key);
      const id = (await boss.send(
        SCHEDULED_MESSAGE_QUEUE,
        {
          scheduledActionId: key,
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 0,
        },
        { singletonKey: key, startAfter: executeAt },
      ))!;
      if (jobState !== "created") await state(SCHEDULED_MESSAGE_QUEUE, id, jobState);
      const firstPage = await boss.findJobs(SCHEDULED_MESSAGE_QUEUE, { key });
      expect(firstPage).toHaveLength(1000);
      expect(firstPage.some(isEffectiveJob)).toBe(false);
      const worker = messages();
      const projection = { scheduledActionId: key, executeAt, revision: 0 };
      expect(await worker.inspectScheduledMessageDelivery(projection)).toBe("CURRENT");
      expect(await worker.ensureScheduledMessageDelivery(projection)).toBe("CURRENT");
      expect(await effective(SCHEDULED_MESSAGE_QUEUE, key)).toEqual([id]);
      expect(await worker.cancelScheduledMessageDeliveries(key)).toEqual({
        outcome: "CONFIRMED",
        matchedDeliveryCount: 1,
      });
      expect(await effective(SCHEDULED_MESSAGE_QUEUE, key)).toEqual([]);
    },
  );

  it("repairs missing and stale active one-time delivery after full history scans", async () => {
    const key = randomUUID();
    const worker = messages();
    const projection = {
      scheduledActionId: key,
      executeAt: new Date(Date.now() + 3600_000),
      revision: 1,
    };
    await history(SCHEDULED_MESSAGE_QUEUE, key);
    expect(await worker.inspectScheduledMessageDelivery(projection)).toBe("MISSING");
    expect(await worker.ensureScheduledMessageDelivery(projection)).toBe("CURRENT");
    const [id] = await effective(SCHEDULED_MESSAGE_QUEUE, key);
    await state(SCHEDULED_MESSAGE_QUEUE, id!, "active");
    projection.executeAt = new Date(projection.executeAt.getTime() + 3600_000);
    expect(await worker.inspectScheduledMessageDelivery(projection)).toBe("STALE");
    expect(await worker.ensureScheduledMessageDelivery(projection)).toBe("CURRENT");
    expect(await effective(SCHEDULED_MESSAGE_QUEUE, key)).not.toContain(id);
  });

  it.each(["created", "retry"] as const)(
    "finds thread-close %s beyond history and preserves it during cleanup",
    async (jobState) => {
      const key = randomUUID();
      await history(SCHEDULED_THREAD_CLOSE_QUEUE, key);
      const id = (await boss.send(
        SCHEDULED_THREAD_CLOSE_QUEUE,
        { scheduledActionId: key },
        { singletonKey: key, startAfter: new Date(Date.now() + 3600_000) },
      ))!;
      if (jobState === "retry") await state(SCHEDULED_THREAD_CLOSE_QUEUE, id, "retry");
      expect(await threads.hasCreatedOrRetryDelivery(key)).toBe(true);
      expect(await threads.cancelStaleActiveDeliveries(key)).toBe(0);
      await boss.cancel(SCHEDULED_THREAD_CLOSE_QUEUE, id);
      expect(await threads.hasCreatedOrRetryDelivery(key)).toBe(false);
    },
  );

  it.each([SCHEDULED_MESSAGE_QUEUE, SCHEDULED_THREAD_CLOSE_QUEUE])(
    "cleans stale active %s delivery beyond terminal history",
    async (queue) => {
      const key = randomUUID();
      await history(queue, key);
      const id = (await boss.send(queue, { scheduledActionId: key }, { singletonKey: key }))!;
      await state(queue, id, "active");
      const worker = queue === SCHEDULED_MESSAGE_QUEUE ? messages() : threads;
      expect(await worker.cancelStaleActiveDeliveries(key)).toBe(1);
      expect(await effective(queue, key)).toEqual([]);
    },
  );

  it("confirms recurring projection beyond terminal history", async () => {
    const occurrenceId = randomUUID();
    const key = `${occurrenceId}:0`;
    const wakeAt = new Date(Date.now() + 3600_000);
    const delivery = {
      kind: "recurring-message-occurrence" as const,
      scheduledActionId: randomUUID(),
      occurrenceId,
      scheduledFor: wakeAt.toISOString(),
      seriesRevision: 0,
      retryCount: 0,
    };
    await history(RECURRING_MESSAGE_QUEUE, key);
    expect(await recurring.project({ delivery, wakeAt })).toBe("CURRENT");
    const before = await effective(RECURRING_MESSAGE_QUEUE, key);
    expect(await recurring.project({ delivery, wakeAt })).toBe("CURRENT");
    expect(await effective(RECURRING_MESSAGE_QUEUE, key)).toEqual(before);
  });

  it("propagates real anchor deletion rather than confirming absence", async () => {
    const key = randomUUID();
    await history(SCHEDULED_MESSAGE_QUEUE, key);
    const pages = findJobPagesByKey(boss, SCHEDULED_MESSAGE_QUEUE, key);
    const first = await pages.next();
    if (first.done) throw new Error("Expected a full first page");
    const anchor = first.value.at(-1)!.id;
    await boss.deleteJob(SCHEDULED_MESSAGE_QUEUE, anchor);
    await expect(pages.next()).rejects.toThrow("no longer exists");
  });

  it("keeps cancellation, stale cleanup and replacement unconfirmed when the target remains active", async () => {
    const key = randomUUID();
    await history(SCHEDULED_MESSAGE_QUEUE, key);
    const id = (await boss.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: key },
      { singletonKey: key },
    ))!;
    await state(SCHEDULED_MESSAGE_QUEUE, id, "active");
    const worker = messages({
      findJobs: boss.findJobs.bind(boss),
      cancel: () => Promise.reject(new Error("timeout")),
    });
    const projection = {
      scheduledActionId: key,
      executeAt: new Date(Date.now() + 3600_000),
      revision: 0,
    };
    expect(await worker.inspectScheduledMessageDelivery(projection)).toBe("STALE");
    expect(await worker.ensureScheduledMessageDelivery(projection)).toBe("PENDING_RECONCILIATION");
    expect(await worker.cancelScheduledMessageDeliveries(key)).toEqual({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 1,
    });
    await expect(worker.cancelStaleActiveDeliveries(key)).rejects.toThrow(
      "cleanup could not be confirmed",
    );
    expect(await effective(SCHEDULED_MESSAGE_QUEUE, key)).toEqual([id]);
  });

  it("confirms cancellation applied despite response loss", async () => {
    const key = randomUUID();
    await history(SCHEDULED_MESSAGE_QUEUE, key);
    await boss.send(SCHEDULED_MESSAGE_QUEUE, { scheduledActionId: key }, { singletonKey: key });
    const worker = messages({
      findJobs: boss.findJobs.bind(boss),
      cancel: async (queue, ids) => {
        await boss.cancel(queue, ids);
        throw new Error("response lost");
      },
    });
    expect(await worker.cancelScheduledMessageDeliveries(key)).toEqual({
      outcome: "CONFIRMED",
      matchedDeliveryCount: 1,
    });
  });

  it("keeps inspection and cancellation unconfirmed on a continuation failure", async () => {
    const key = randomUUID();
    await history(SCHEDULED_MESSAGE_QUEUE, key);
    const findJobs = <T>(queue: string, options?: FindJobsOptions) =>
      options?.after
        ? Promise.reject(new Error("DB unavailable"))
        : boss.findJobs<T>(queue, options);
    const worker = messages({ findJobs, cancel: boss.cancel.bind(boss) });
    const projection = {
      scheduledActionId: key,
      executeAt: new Date(Date.now() + 3600_000),
      revision: 0,
    };
    expect(await worker.inspectScheduledMessageDelivery(projection)).toBe("UNCONFIRMED");
    expect(await worker.ensureScheduledMessageDelivery(projection)).toBe("PENDING_RECONCILIATION");
    expect((await worker.cancelScheduledMessageDeliveries(key)).outcome).toBe("UNCONFIRMED");
  });
});
