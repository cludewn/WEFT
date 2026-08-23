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
import {
  createScheduledThreadCloseRuntimeReconciler,
  createScheduledThreadCloseStartupReconciler,
} from "../../src/scheduled-thread-close-reconciler.js";
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
let reconcileAtRuntime: () => Promise<void>;
let executeScheduledClose: ReturnType<typeof vi.fn<ScheduledThreadCloseExecutor["execute"]>>;

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
  await controller.stop();
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

describe("scheduled thread close runtime reconciliation", () => {
  it("repairs ACTIVE delivery while excluding other action types and states", async () => {
    const active = await createAction("runtime-active", new Date(0));
    const executing = await createAction("runtime-executing", new Date(0));
    await store.claimExecution(executing.id);
    const cancelled = await createAction("runtime-cancelled", new Date(0));
    await store.cancel(cancelled.id);
    const completed = await createAction("runtime-completed", new Date(0));
    await store.claimExecution(completed.id);
    await store.completeExecution(completed.id);
    const failed = await createAction("runtime-failed", new Date(0));
    await store.claimExecution(failed.id);
    await store.failExecution(failed.id);
    const message = await store.create({
      id: "runtime-message",
      guildId: testGuildId,
      actionType: "SEND_MESSAGE",
      targetId: "message-channel",
      executeAt: new Date(0),
    });

    await reconcileAtRuntime();

    await expect(findJobs(active.id)).resolves.toEqual([
      expect.objectContaining({ singletonKey: active.id }),
    ]);
    for (const excluded of [executing, cancelled, completed, failed, message]) {
      await expect(findJobs(excluded.id)).resolves.toEqual([]);
    }
    await expect(store.findById(executing.id)).resolves.toMatchObject({ status: "EXECUTING" });
    expect(executeScheduledClose).not.toHaveBeenCalled();
  });

  it("preserves future and overdue timestamps through idempotent runtime enqueue", async () => {
    const overdue = await createAction("runtime-overdue", new Date(0));
    const future = await createAction("runtime-future", new Date("2999-01-01T00:00:00Z"));

    await reconcileAtRuntime();
    await reconcileAtRuntime();

    await expect(findJobs(overdue.id)).resolves.toEqual([
      expect.objectContaining({ singletonKey: overdue.id, startAfter: overdue.executeAt }),
    ]);
    await expect(findJobs(future.id)).resolves.toEqual([
      expect.objectContaining({ singletonKey: future.id, startAfter: future.executeAt }),
    ]);
    await expect(
      runtime.client.fetch<{ scheduledActionId: string }>(SCHEDULED_THREAD_CLOSE_QUEUE),
    ).resolves.toEqual([expect.objectContaining({ data: { scheduledActionId: overdue.id } })]);
  });

  it("reconciles more than one page with stable identical executeAt ordering", async () => {
    const executeAt = new Date("2999-01-01T00:00:00Z");
    const ids = Array.from(
      { length: 105 },
      (_, index) => `runtime-page-${String(index).padStart(3, "0")}`,
    );
    await Promise.all(ids.map((id) => createAction(id, executeAt)));

    await reconcileAtRuntime();

    const jobs = await runtime.client.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE);
    expect(jobs).toHaveLength(ids.length);
    expect(new Set(jobs.map((job) => job.singletonKey))).toEqual(new Set(ids));
    expect(jobs.every((job) => job.startAfter.getTime() === executeAt.getTime())).toBe(true);
  });

  it("creates a new runtime delivery cycle after terminal retry exhaustion", async () => {
    const action = await createAction("runtime-exhausted", new Date(0));
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

    await reconcileAtRuntime();

    const jobs = await findJobs(action.id);
    expect(jobs.filter((job) => job.state === "failed")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "ACTIVE" });
  });

  it("deduplicates on a later sweep after an enqueue response is lost", async () => {
    const action = await createAction("runtime-response-loss", new Date(0));
    let loseResponse = true;
    const reconciler = createScheduledThreadCloseRuntimeReconciler({
      scheduledActions: store,
      delivery: {
        enqueueScheduledThreadClose: async (scheduledActionId, executeAt) => {
          const result = await controller.enqueueScheduledThreadClose(scheduledActionId, executeAt);
          if (loseResponse) {
            loseResponse = false;
            throw new Error("response lost");
          }
          return result;
        },
      },
      logger,
    });

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    const jobs = await findJobs(action.id);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
    await reconciler.stop();
  });

  it("allows a stale delivery after scan but leaves cancellation authoritative", async () => {
    const action = await createAction("runtime-cancel-race", new Date(0));
    let cancelled = false;
    const reconciler = createScheduledThreadCloseRuntimeReconciler({
      scheduledActions: {
        findActiveThreadClosesPage: async (cursor) => {
          const page = await store.findActiveThreadClosesPage(cursor);
          if (!cancelled && page.some((candidate) => candidate.id === action.id)) {
            await store.cancel(action.id);
            cancelled = true;
          }
          return page;
        },
      },
      delivery: controller,
      logger,
    });

    await reconciler.reconcileOnce();
    await controller.start();
    await waitFor(async () => (await findJobs(action.id))[0]?.state === "completed");

    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "CANCELLED" });
    expect(executeScheduledClose).not.toHaveBeenCalled();
    await reconciler.stop();
  });
});

function createRecoveryFixture(): void {
  executeScheduledClose = vi.fn(() =>
    Promise.reject(new Error("Recovery must not invoke the executor")),
  );
  const executor = { execute: executeScheduledClose } satisfies ScheduledThreadCloseExecutor;
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
  reconcileAtRuntime = createScheduledThreadCloseRuntimeReconciler({
    scheduledActions: store,
    delivery: controller,
    logger,
  }).reconcileOnce;
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for pg-boss reconciliation state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function createLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
