import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createPgBossRuntime, type PgBossRuntime } from "../../src/pg-boss.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseStartupReconciler } from "../../src/scheduled-thread-close-reconciler.js";
import {
  createScheduledThreadCloseWorkerController,
  SCHEDULED_THREAD_CLOSE_QUEUE,
  type ScheduledThreadCloseWorkerController,
} from "../../src/scheduled-thread-close-worker.js";
import type { ScheduledThreadCloseExecutor } from "../../src/scheduled-thread-close.js";

const testGuildId = "scheduled-recovery-test-guild";
const config = loadTestDatabaseConfig();
const database = createDatabase(config);
const store = createScheduledActionStore(database.client);
const logger = createLogger();
let runtime: PgBossRuntime;
let controller: ScheduledThreadCloseWorkerController;
let recoverAtStartup: () => Promise<void>;

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(async () => {
  await cleanupActions();
  runtime = createPgBossRuntime(config, logger);
  await runtime.start();
  const existingQueue = await runtime.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  if (existingQueue !== null) {
    await runtime.client.deleteAllJobs(SCHEDULED_THREAD_CLOSE_QUEUE);
    await runtime.client.deleteQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  }
  createRecoveryFixture();
  await controller.ensureQueue();
});

afterEach(async () => {
  if ((await runtime.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE)) !== null) {
    await runtime.client.deleteAllJobs(SCHEDULED_THREAD_CLOSE_QUEUE);
    await runtime.client.deleteQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  }
  await runtime.stop();
  await cleanupActions();
});

afterAll(async () => {
  await database.close();
});

describe("scheduled thread close startup recovery", () => {
  it("repairs a DB-to-enqueue gap idempotently and preserves future executeAt", async () => {
    const action = await createAction("future-gap", new Date("2999-01-01T00:00:00Z"));

    await recoverAtStartup();
    await recoverAtStartup();

    const jobs = await findJobs(action.id);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ singletonKey: action.id, startAfter: action.executeAt });
    await expect(runtime.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE)).resolves.toEqual([]);
  });

  it("makes an overdue recovered action immediately runnable", async () => {
    const action = await createAction("overdue-gap", new Date(0));

    await recoverAtStartup();

    const [job] = await runtime.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE, {
      includeMetadata: true,
    });
    expect(job).toMatchObject({ state: "active", singletonKey: action.id });
  });

  it("cancels a crash-stale ACTIVE blocker and creates a new delivery after restart", async () => {
    const action = await createAction("active-crash", new Date(0));
    await controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    const [fetched] = await runtime.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE, {
      includeMetadata: true,
    });
    expect(fetched).toMatchObject({ state: "active", singletonKey: action.id });

    await runtime.stop();
    runtime = createPgBossRuntime(config, logger);
    await runtime.start();
    createRecoveryFixture();
    await controller.ensureQueue();

    await expect(controller.enqueueScheduledThreadClose(action.id, action.executeAt)).resolves.toBe(
      "ALREADY_PRESENT",
    );
    await recoverAtStartup();

    const jobs = await findJobs(action.id);
    expect(jobs.some((job) => job.state === "active")).toBe(false);
    expect(jobs.filter((job) => job.state === "cancelled")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
  });

  it("releases interrupted EXECUTING after stale cleanup and enqueues it in the ACTIVE pass", async () => {
    const action = await createAction("executing-crash", new Date(0));
    await controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await store.claimExecution(action.id);
    await runtime.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE, { includeMetadata: true });

    await recoverAtStartup();

    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "ACTIVE" });
    const jobs = await findJobs(action.id);
    expect(jobs.some((job) => job.state === "active")).toBe(false);
    expect(jobs.filter((job) => job.state === "cancelled")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
  });

  it("creates a new delivery when terminal failed history has exhausted its singleton", async () => {
    const action = await createAction("failed-history", new Date(0));
    const jobId = await runtime.client.send(
      SCHEDULED_THREAD_CLOSE_QUEUE,
      { scheduledActionId: action.id },
      { singletonKey: action.id, startAfter: action.executeAt, retryLimit: 0 },
    );
    expect(jobId).not.toBeNull();
    const [fetched] = await runtime.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE, {
      includeMetadata: true,
    });
    await runtime.client.fail(SCHEDULED_THREAD_CLOSE_QUEUE, fetched!.id);
    await expect(findJobs(action.id)).resolves.toEqual([
      expect.objectContaining({ state: "failed" }),
    ]);

    await recoverAtStartup();

    const jobs = await findJobs(action.id);
    expect(jobs.filter((job) => job.state === "failed")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
  });
});

function createRecoveryFixture(): void {
  const executor = {
    execute: vi.fn(() => Promise.reject(new Error("Recovery must not invoke the executor"))),
  } satisfies ScheduledThreadCloseExecutor;
  controller = createScheduledThreadCloseWorkerController({
    boss: runtime.client,
    scheduledActions: store,
    executor,
    logger,
  });
  recoverAtStartup = createScheduledThreadCloseStartupReconciler({
    scheduledActions: store,
    delivery: controller,
    logger,
  }).recoverAtStartup;
}

async function createAction(id: string, executeAt: Date) {
  return store.create({
    id,
    guildId: testGuildId,
    actionType: "CLOSE_THREAD",
    targetId: `thread-${id}`,
    executeAt,
  });
}

async function findJobs(scheduledActionId: string) {
  return runtime.client.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE, { key: scheduledActionId });
}

async function cleanupActions(): Promise<void> {
  await database.client.delete(scheduledActions).where(eq(scheduledActions.guildId, testGuildId));
}

function createLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
