import type { JobWithMetadata, PgBoss, QueueResult } from "pg-boss";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduledAction } from "../../src/scheduled-action-persistence.js";
import type {
  ScheduledThreadCloseExecutionResult,
  ScheduledThreadCloseExecutor,
} from "../../src/scheduled-thread-close.js";
import {
  createScheduledThreadCloseWorkerController,
  SCHEDULED_THREAD_CLOSE_QUEUE,
  ScheduledThreadCloseDeliveryRetryError,
} from "../../src/scheduled-thread-close-worker.js";

type WorkerHandler = (jobs: JobWithMetadata<unknown>[]) => Promise<unknown>;

const requiredQueue = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 86_399,
} as QueueResult;

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Logger;
}

function createAction(
  status: ScheduledAction["status"] = "ACTIVE",
  overrides: Partial<ScheduledAction> = {},
): ScheduledAction {
  return {
    id: "scheduled-action-id",
    guildId: "guild-id",
    actionType: "CLOSE_THREAD",
    targetId: "thread-id",
    status,
    executeAt: new Date("2020-01-01T00:00:00Z"),
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
    ...overrides,
  };
}

function createJob(
  data: unknown = { scheduledActionId: "scheduled-action-id" },
  overrides: Partial<JobWithMetadata<unknown>> = {},
): JobWithMetadata<unknown> {
  return {
    id: "pg-boss-job-id",
    name: SCHEDULED_THREAD_CLOSE_QUEUE,
    data,
    signal: new AbortController().signal,
    retryCount: 0,
    retryLimit: 3,
    ...overrides,
  } as JobWithMetadata<unknown>;
}

function createFixture({
  action: configuredAction,
  executionResult: configuredExecutionResult,
}: {
  action?: ScheduledAction | null;
  executionResult?: ScheduledThreadCloseExecutionResult;
} = {}) {
  const action = configuredAction === null ? undefined : (configuredAction ?? createAction());
  const executionResult: ScheduledThreadCloseExecutionResult = configuredExecutionResult ?? {
    outcome: "SUCCESS",
    action: action ?? createAction(),
  };
  const handlers: WorkerHandler[] = [];
  let workerSequence = 0;
  const boss = {
    createQueue: vi.fn(() => Promise.resolve()),
    getQueue: vi.fn(() => Promise.resolve(requiredQueue)),
    send: vi.fn(() => Promise.resolve("pg-boss-job-id" as string | null)),
    findJobs: vi.fn(() => Promise.resolve([])),
    cancel: vi.fn(() => Promise.resolve({})),
    work: vi.fn((_name: string, _options: unknown, handler: WorkerHandler) => {
      handlers.push(handler);
      workerSequence += 1;
      return Promise.resolve(`worker-${workerSequence}`);
    }),
    offWork: vi.fn(() => Promise.resolve()),
  } as unknown as Pick<
    PgBoss,
    "createQueue" | "getQueue" | "send" | "findJobs" | "cancel" | "work" | "offWork"
  >;
  const findById = vi.fn(() => Promise.resolve(action));
  const execute = vi.fn<ScheduledThreadCloseExecutor["execute"]>(() =>
    Promise.resolve(executionResult),
  );
  const logger = createLogger();
  const controller = createScheduledThreadCloseWorkerController({
    boss,
    scheduledActions: { findById },
    executor: { execute },
    logger,
  });

  return { boss, controller, execute, findById, handlers, logger };
}

async function startAndRun(
  fixture: ReturnType<typeof createFixture>,
  job = createJob(),
): Promise<unknown> {
  await fixture.controller.start();
  return fixture.handlers[0]!([job] satisfies JobWithMetadata<unknown>[]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("scheduled thread close pg-boss worker", () => {
  it("creates and verifies the exact queue configuration", async () => {
    const fixture = createFixture();

    await fixture.controller.ensureQueue();

    expect(fixture.boss.createQueue).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 86_399,
    });
    expect(fixture.boss.getQueue).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE);
  });

  it("fails queue startup when an existing queue has different configuration", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.getQueue).mockResolvedValue({
      ...requiredQueue,
      retryLimit: 2,
    });

    await expect(fixture.controller.ensureQueue()).rejects.toThrow(
      "Scheduled thread close queue configuration is invalid",
    );
    expect(fixture.boss.createQueue).toHaveBeenCalledOnce();
  });

  it("enqueues only the action ID with singleton and absolute execution time", async () => {
    const fixture = createFixture();
    const executeAt = new Date("2030-01-02T03:04:05Z");

    await expect(
      fixture.controller.enqueueScheduledThreadClose("scheduled-action-id", executeAt),
    ).resolves.toBe("ENQUEUED");
    expect(fixture.boss.send).toHaveBeenCalledWith(
      SCHEDULED_THREAD_CLOSE_QUEUE,
      { scheduledActionId: "scheduled-action-id" },
      { singletonKey: "scheduled-action-id", startAfter: executeAt },
    );

    vi.mocked(fixture.boss.send).mockResolvedValueOnce(null);
    await expect(
      fixture.controller.enqueueScheduledThreadClose("scheduled-action-id", executeAt),
    ).resolves.toBe("ALREADY_PRESENT");
    expect(fixture.logger.debug).toHaveBeenCalledTimes(2);
    expect(fixture.logger.debug).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "scheduled_thread_close_enqueued",
        enqueueResult: "ALREADY_PRESENT",
      }),
      expect.any(String),
    );
    expect(fixture.logger.info).not.toHaveBeenCalled();
  });

  it("preserves created and retry deliveries during startup cleanup", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.findJobs).mockResolvedValue([
      createJob(undefined, { id: "created-job", state: "created" }),
      createJob(undefined, { id: "retry-job", state: "retry" }),
    ]);

    await expect(
      fixture.controller.cancelStaleActiveDeliveries("scheduled-action-id"),
    ).resolves.toBe(0);

    expect(fixture.boss.cancel).not.toHaveBeenCalled();
  });

  it("cancels every active delivery and ignores terminal history", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.findJobs)
      .mockResolvedValueOnce([
        createJob(undefined, { id: "completed-job", state: "completed" }),
        createJob(undefined, { id: "active-job-one", state: "active" }),
        createJob(undefined, { id: "active-job-two", state: "active" }),
      ])
      .mockResolvedValueOnce([
        createJob(undefined, { id: "completed-job", state: "completed" }),
        createJob(undefined, { id: "active-job-one", state: "cancelled" }),
        createJob(undefined, { id: "active-job-two", state: "cancelled" }),
      ]);

    await expect(
      fixture.controller.cancelStaleActiveDeliveries("scheduled-action-id"),
    ).resolves.toBe(2);

    expect(fixture.boss.cancel).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, [
      "active-job-one",
      "active-job-two",
    ]);
    expect(fixture.boss.findJobs).toHaveBeenNthCalledWith(1, SCHEDULED_THREAD_CLOSE_QUEUE, {
      key: "scheduled-action-id",
    });
    expect(fixture.boss.findJobs).toHaveBeenNthCalledWith(2, SCHEDULED_THREAD_CLOSE_QUEUE, {
      key: "scheduled-action-id",
    });
  });

  it("confirms cancellation after the cancel promise rejects", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.findJobs)
      .mockResolvedValueOnce([createJob(undefined, { state: "active" })])
      .mockResolvedValueOnce([createJob(undefined, { state: "cancelled" })]);
    vi.mocked(fixture.boss.cancel).mockRejectedValue(new Error("response lost"));

    await expect(
      fixture.controller.cancelStaleActiveDeliveries("scheduled-action-id"),
    ).resolves.toBe(1);
  });

  it("fails cleanup when an active delivery remains after cancellation", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.findJobs).mockResolvedValue([createJob(undefined, { state: "active" })]);

    await expect(
      fixture.controller.cancelStaleActiveDeliveries("scheduled-action-id"),
    ).rejects.toThrow("Scheduled thread close stale delivery cleanup could not be confirmed");
  });

  it("confirms only created or retry deliveries after an ambiguous enqueue", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.boss.findJobs)
      .mockResolvedValueOnce([createJob(undefined, { state: "completed" })])
      .mockResolvedValueOnce([createJob(undefined, { state: "retry" })]);

    await expect(fixture.controller.hasCreatedOrRetryDelivery("scheduled-action-id")).resolves.toBe(
      false,
    );
    await expect(fixture.controller.hasCreatedOrRetryDelivery("scheduled-action-id")).resolves.toBe(
      true,
    );
  });

  it.each([
    undefined,
    null,
    {},
    { scheduledActionId: "" },
    { scheduledActionId: "scheduled-action-id", extra: true },
  ])("resolves malformed payload without reading application state: %j", async (payload) => {
    const fixture = createFixture();

    await expect(
      startAndRun(fixture, createJob(payload, { data: payload })),
    ).resolves.toBeUndefined();

    expect(fixture.findById).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
    const loggedFields: unknown = (fixture.logger.warn as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[0];
    expect(loggedFields).not.toHaveProperty("payload");
    expect(loggedFields).not.toHaveProperty("data");
  });

  it.each(["CANCELLED", "COMPLETED", "FAILED"] as const)(
    "resolves a %s action without invoking the executor",
    async (status) => {
      const fixture = createFixture({ action: createAction(status) });

      await expect(startAndRun(fixture)).resolves.toBeUndefined();

      expect(fixture.execute).not.toHaveBeenCalled();
    },
  );

  it("resolves a missing action without invoking the executor", async () => {
    const fixture = createFixture({ action: null });

    await expect(startAndRun(fixture)).resolves.toBeUndefined();

    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("leaves an EXECUTING action for Phase 4E recovery", async () => {
    const fixture = createFixture({ action: createAction("EXECUTING") });

    await expect(startAndRun(fixture)).resolves.toBeUndefined();

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduled_thread_close_execution_recovery_required",
        persistedStatus: "EXECUTING",
      }),
      expect.any(String),
    );
  });

  it("does not invoke the executor for an action type mismatch", async () => {
    const fixture = createFixture({
      action: createAction("ACTIVE", { actionType: "SEND_MESSAGE" }),
    });

    await expect(startAndRun(fixture)).resolves.toBeUndefined();

    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("does not execute an ACTIVE action before its persisted executeAt", async () => {
    const fixture = createFixture({
      action: createAction("ACTIVE", { executeAt: new Date("2999-01-01T00:00:00Z") }),
    });

    await expect(startAndRun(fixture)).resolves.toBeUndefined();

    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduled_thread_close_delivery_not_due" }),
      expect.any(String),
    );
  });

  it("turns an application-state load rejection into a sanitized retry error", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.findById).mockRejectedValue(new Error("sensitive database detail"));

    await expect(startAndRun(fixture)).rejects.toMatchObject({
      name: "ScheduledThreadCloseDeliveryRetryError",
      failureCode: "SCHEDULED_ACTION_LOAD_FAILED",
    });
    expect(
      JSON.stringify((fixture.logger.warn as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("sensitive database detail");
  });

  it.each([
    { outcome: "SUCCESS", action: createAction("COMPLETED") },
    { outcome: "SKIPPED", reason: "NOT_ACTIVE", action: createAction("CANCELLED") },
    {
      outcome: "PERMANENT_FAILURE",
      code: "BOT_PERMISSION_MISSING",
      action: createAction("FAILED"),
    },
  ] satisfies ScheduledThreadCloseExecutionResult[])(
    "resolves executor outcome $outcome",
    async (executionResult) => {
      const fixture = createFixture({ executionResult });

      await expect(startAndRun(fixture)).resolves.toBeUndefined();

      expect(fixture.execute).toHaveBeenCalledOnce();
    },
  );

  it("rejects only a retryable executor result with a sanitized error", async () => {
    const action = createAction("ACTIVE");
    const fixture = createFixture({
      action,
      executionResult: {
        outcome: "RETRYABLE_FAILURE",
        code: "DISCORD_FETCH_TIMEOUT",
        action,
      },
    });

    await expect(startAndRun(fixture)).rejects.toBeInstanceOf(
      ScheduledThreadCloseDeliveryRetryError,
    );
  });

  it("generates separate lifecycle and execution audit UUIDs for each invocation", async () => {
    const fixture = createFixture();
    await fixture.controller.start();

    await fixture.handlers[0]!([createJob()]);
    await fixture.handlers[0]!([createJob(undefined, { id: "second-job" })]);

    const first = fixture.execute.mock.calls[0]?.[1];
    const second = fixture.execute.mock.calls[1]?.[1];
    for (const auditId of [
      first?.attemptAuditId,
      first?.executionAuditId,
      second?.attemptAuditId,
      second?.executionAuditId,
    ]) {
      expect(auditId).toMatch(UUID_PATTERN);
    }
    expect(first?.executionAuditId).not.toBe(first?.attemptAuditId);
    expect(second?.attemptAuditId).not.toBe(first?.attemptAuditId);
    expect(second?.executionAuditId).not.toBe(first?.executionAuditId);
  });

  it("uses public retry metadata to warn before the retry budget is exhausted", async () => {
    const action = createAction();
    const fixture = createFixture({
      action,
      executionResult: {
        outcome: "RETRYABLE_FAILURE",
        code: "DISCORD_FETCH_TIMEOUT",
        action,
      },
    });

    await expect(
      startAndRun(fixture, createJob(undefined, { retryCount: 3, retryLimit: 3 })),
    ).rejects.toBeInstanceOf(ScheduledThreadCloseDeliveryRetryError);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduled_thread_close_delivery_retry_exhausted" }),
      expect.any(String),
    );
  });

  it("reports an exhausted retry budget without any terminal application transition", async () => {
    const action = createAction();
    const fixture = createFixture({
      action,
      executionResult: {
        outcome: "RETRYABLE_FAILURE",
        code: "DISCORD_FETCH_TIMEOUT",
        action: { ...action, status: "ACTIVE" },
      },
    });

    await expect(
      startAndRun(fixture, createJob(undefined, { retryCount: 3, retryLimit: 3 })),
    ).rejects.toBeInstanceOf(ScheduledThreadCloseDeliveryRetryError);

    // Delivery exhaustion is reported through logging only. The worker owns no audit or
    // state-changing store, so it cannot mark the action FAILED or write an EXECUTION_FAILED audit.
    expect(fixture.execute).toHaveBeenCalledOnce();
    expect(fixture.findById).toHaveBeenCalledOnce();
    expect(fixture.logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "scheduled_thread_close_execution_finished" }),
      expect.any(String),
    );
  });

  it("registers four independent single-job workers and stops every returned ID", async () => {
    const fixture = createFixture();

    await fixture.controller.start();

    expect(fixture.boss.work).toHaveBeenCalledTimes(4);
    for (const call of vi.mocked(fixture.boss.work).mock.calls) {
      expect(call[0]).toBe(SCHEDULED_THREAD_CLOSE_QUEUE);
      expect(call[1]).toEqual({ batchSize: 1, includeMetadata: true });
    }

    await fixture.controller.stop();

    expect(fixture.boss.offWork).toHaveBeenCalledTimes(4);
    for (let index = 1; index <= 4; index += 1) {
      expect(fixture.boss.offWork).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, {
        id: `worker-${index}`,
        wait: true,
      });
    }
  });

  it("cleans up workers registered before a partial registration failure", async () => {
    const fixture = createFixture();
    const registrationFailure = new Error("registration failed");
    vi.mocked(fixture.boss.work)
      .mockResolvedValueOnce("worker-a")
      .mockResolvedValueOnce("worker-b")
      .mockRejectedValueOnce(registrationFailure);

    await expect(fixture.controller.start()).rejects.toBe(registrationFailure);

    expect(fixture.boss.offWork).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, {
      id: "worker-a",
      wait: true,
    });
    expect(fixture.boss.offWork).toHaveBeenCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, {
      id: "worker-b",
      wait: true,
    });
  });

  it("preserves the registration error and retries failed cleanup during shutdown", async () => {
    const fixture = createFixture();
    const registrationFailure = new Error("registration failed");
    vi.mocked(fixture.boss.work)
      .mockResolvedValueOnce("worker-a")
      .mockRejectedValueOnce(registrationFailure);
    vi.mocked(fixture.boss.offWork)
      .mockRejectedValueOnce(new Error("cleanup failed"))
      .mockResolvedValueOnce(undefined);

    await expect(fixture.controller.start()).rejects.toBe(registrationFailure);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduled_thread_close_worker_startup_cleanup_failed",
      }),
      expect.any(String),
    );

    await fixture.controller.stop();

    expect(fixture.boss.offWork).toHaveBeenCalledTimes(2);
    expect(fixture.boss.offWork).toHaveBeenLastCalledWith(SCHEDULED_THREAD_CLOSE_QUEUE, {
      id: "worker-a",
      wait: true,
    });
  });

  it("tracks the raw handler invocation until it settles during drain", async () => {
    let finishExecution: ((result: ScheduledThreadCloseExecutionResult) => void) | undefined;
    const fixture = createFixture();
    vi.mocked(fixture.execute).mockReturnValueOnce(
      new Promise((resolve) => {
        finishExecution = resolve;
      }),
    );
    await fixture.controller.start();
    const invocation = fixture.handlers[0]!([createJob()]);
    await Promise.resolve();

    let stopped = false;
    const stopping = fixture.controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishExecution?.({ outcome: "SUCCESS", action: createAction("COMPLETED") });
    await invocation;
    await stopping;
    expect(stopped).toBe(true);
  });

  it("does not propagate an aborted pg-boss Job.signal to the executor", async () => {
    const fixture = createFixture();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      startAndRun(fixture, createJob(undefined, { signal: abortController.signal })),
    ).resolves.toBeUndefined();

    expect(fixture.execute).toHaveBeenCalledOnce();
    const [executedAction, executedAuditIds] = fixture.execute.mock.calls[0]!;
    expect(executedAction).toMatchObject({ id: "scheduled-action-id" });
    expect(executedAuditIds.attemptAuditId).toMatch(UUID_PATTERN);
    expect(executedAuditIds.executionAuditId).toMatch(UUID_PATTERN);
    expect(fixture.execute.mock.calls[0]).toHaveLength(2);
  });
});
