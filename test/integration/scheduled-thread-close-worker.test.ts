import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseExecutor } from "../../src/scheduled-thread-close.js";
import {
  createScheduledThreadCloseWorkerController,
  SCHEDULED_THREAD_CLOSE_QUEUE,
  type ScheduledThreadCloseWorkerController,
} from "../../src/scheduled-thread-close-worker.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

const testGuildId = "scheduled-worker-test-guild";
const config = loadTestDatabaseConfig();
const database = createDatabase(config);
const pgBoss = createPgBossRuntime(config, createLogger());
const store = createScheduledActionStore(database.client);
const controllers: ScheduledThreadCloseWorkerController[] = [];

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await pgBoss.start();
  const existingQueue = await pgBoss.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  if (existingQueue !== null) {
    await pgBoss.client.deleteQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  }
  await cleanupActions();
});

afterEach(async () => {
  for (const controller of controllers.splice(0).toReversed()) {
    await controller.stop();
  }
  if ((await pgBoss.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE)) !== null) {
    await pgBoss.client.deleteAllJobs(SCHEDULED_THREAD_CLOSE_QUEUE);
  }
  await cleanupActions();
});

afterAll(async () => {
  if ((await pgBoss.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE)) !== null) {
    await pgBoss.client.deleteQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
  }
  await pgBoss.stop();
  await database.close();
});

describe("scheduled thread close pg-boss delivery", () => {
  it("creates the required queue and deduplicates a scheduled action singleton", async () => {
    const fixture = createFixture();
    await fixture.controller.ensureQueue();
    const executeAt = new Date("2030-01-01T00:00:00Z");

    await expect(
      fixture.controller.enqueueScheduledThreadClose("duplicate-action", executeAt),
    ).resolves.toBe("ENQUEUED");
    await expect(
      fixture.controller.enqueueScheduledThreadClose("duplicate-action", executeAt),
    ).resolves.toBe("ALREADY_PRESENT");

    const queue = await pgBoss.client.getQueue(SCHEDULED_THREAD_CLOSE_QUEUE);
    expect(queue).toMatchObject({
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 86_399,
    });
    const jobs = await pgBoss.client.findJobs<{ scheduledActionId: string }>(
      SCHEDULED_THREAD_CLOSE_QUEUE,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      data: { scheduledActionId: "duplicate-action" },
      singletonKey: "duplicate-action",
      startAfter: executeAt,
    });
  });

  it("does not make a future startAfter job runnable early", async () => {
    const fixture = createFixture();
    await fixture.controller.ensureQueue();
    const executeAt = new Date("2999-01-01T00:00:00Z");
    await fixture.controller.enqueueScheduledThreadClose("future-action", executeAt);

    await expect(pgBoss.client.fetch(SCHEDULED_THREAD_CLOSE_QUEUE)).resolves.toEqual([]);

    const [job] = await pgBoss.client.findJobs(SCHEDULED_THREAD_CLOSE_QUEUE);
    expect(job).toMatchObject({ state: "created", startAfter: executeAt });
    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
  });

  it("retries a safely released action and completes on a later attempt", async () => {
    const action = await createDueAction("retry-action", "retry-thread");
    const fixture = createFixture([
      { outcome: "RETRYABLE_FAILURE", code: "DISCORD_FETCH_TIMEOUT" },
      { outcome: "SUCCESS", changed: true },
    ]);
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.start();

    await waitFor(async () => {
      const current = await store.findById(action.id);
      const job = await findJob(action.id);
      return (
        fixture.closeAsSystem.mock.calls.length === 1 &&
        current?.status === "ACTIVE" &&
        job?.state === "retry"
      );
    });

    const retryJob = await findJob(action.id);
    await pgBoss.client.update(SCHEDULED_THREAD_CLOSE_QUEUE, undefined, {
      id: retryJob!.id,
      startAfter: new Date(0),
    });
    notifyWorkers();

    await waitFor(async () => (await store.findById(action.id))?.status === "COMPLETED");
    expect(fixture.closeAsSystem).toHaveBeenCalledTimes(2);
    await expect(findJob(action.id)).resolves.toMatchObject({
      state: "completed",
      retryCount: 1,
    });
  });

  it("completes delivery without retrying a permanent action failure", async () => {
    const action = await createDueAction("permanent-action", "permanent-thread");
    const fixture = createFixture([
      { outcome: "PERMANENT_FAILURE", code: "BOT_PERMISSION_MISSING" },
    ]);
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.start();

    await waitFor(async () => (await store.findById(action.id))?.status === "FAILED");

    expect(fixture.closeAsSystem).toHaveBeenCalledOnce();
    await expect(findJob(action.id)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
  });

  it("does not execute a cancelled stale delivery", async () => {
    const action = await createDueAction("cancelled-action", "cancelled-thread");
    const fixture = createFixture();
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await store.cancel(action.id);
    await fixture.controller.start();

    await waitFor(async () => (await findJob(action.id))?.state === "completed");

    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "CANCELLED" });
  });

  it("resolves stale EXECUTING delivery without changing application authority", async () => {
    const action = await createDueAction("executing-action", "executing-thread");
    await store.claimExecution(action.id);
    const fixture = createFixture();
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.start();

    await waitFor(async () => (await findJob(action.id))?.state === "completed");

    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "EXECUTING" });
  });

  it("allows only one execution from duplicate singleton enqueue attempts", async () => {
    const action = await createDueAction("duplicate-worker-action", "duplicate-worker-thread");
    const fixture = createFixture();
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.start();

    await waitFor(async () => (await store.findById(action.id))?.status === "COMPLETED");

    expect(fixture.closeAsSystem).toHaveBeenCalledOnce();
  });

  it("keeps worker drain pending until an in-flight SYSTEM close settles", async () => {
    const action = await createDueAction("drain-action", "drain-thread");
    let finishClose: ((result: { outcome: "SUCCESS"; changed: boolean }) => void) | undefined;
    const closeResult = new Promise<{ outcome: "SUCCESS"; changed: boolean }>((resolve) => {
      finishClose = resolve;
    });
    const fixture = createFixture([closeResult]);
    await fixture.controller.ensureQueue();
    await fixture.controller.enqueueScheduledThreadClose(action.id, action.executeAt);
    await fixture.controller.start();
    await waitFor(() => fixture.closeAsSystem.mock.calls.length === 1);

    let stopped = false;
    const stopping = fixture.controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishClose?.({ outcome: "SUCCESS", changed: true });
    await stopping;

    expect(stopped).toBe(true);
    await expect(store.findById(action.id)).resolves.toMatchObject({ status: "COMPLETED" });
  });
});

function createFixture(
  lifecycleResults: Array<
    | Awaited<ReturnType<ThreadLifecycleService["closeAsSystem"]>>
    | Promise<Awaited<ReturnType<ThreadLifecycleService["closeAsSystem"]>>>
  > = [{ outcome: "SUCCESS", changed: true }],
) {
  const closeAsSystem = vi.fn<ThreadLifecycleService["closeAsSystem"]>();
  for (const result of lifecycleResults) {
    closeAsSystem.mockImplementationOnce(() => Promise.resolve(result));
  }
  const executor = createScheduledThreadCloseExecutor({
    scheduledActions: store,
    threadLifecycle: { closeAsSystem },
  });
  const controller = createScheduledThreadCloseWorkerController({
    boss: pgBoss.client,
    scheduledActions: store,
    executor,
    logger: createLogger(),
  });
  controllers.push(controller);
  return { closeAsSystem, controller };
}

async function createDueAction(id: string, targetId: string) {
  return store.create({
    id,
    guildId: testGuildId,
    actionType: "CLOSE_THREAD",
    targetId,
    executeAt: new Date(0),
  });
}

async function findJob(scheduledActionId: string) {
  const jobs = await pgBoss.client.findJobs<{ scheduledActionId: string }>(
    SCHEDULED_THREAD_CLOSE_QUEUE,
  );
  return jobs.find((job) => job.singletonKey === scheduledActionId);
}

function notifyWorkers(): void {
  for (const worker of pgBoss.client
    .getWipData()
    .filter((candidate) => candidate.name === SCHEDULED_THREAD_CLOSE_QUEUE)) {
    pgBoss.client.notifyWorker(worker.id);
  }
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
      throw new Error("Timed out waiting for pg-boss integration state");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
