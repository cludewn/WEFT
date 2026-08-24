import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ScheduledAction,
  ScheduledActionStore,
} from "../../src/scheduled-action-persistence.js";
import type { ScheduledThreadCloseStore } from "../../src/scheduled-thread-close-persistence.js";
import {
  createScheduledThreadCloseRuntimeReconciler,
  createScheduledThreadCloseStartupReconciler,
  SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS,
} from "../../src/scheduled-thread-close-reconciler.js";
import type { ScheduledThreadCloseStartupRecoveryError } from "../../src/scheduled-thread-close-reconciler.js";
import type { ScheduledThreadCloseWorkerController } from "../../src/scheduled-thread-close-worker.js";

type RecoveryStore = Pick<
  ScheduledActionStore,
  "findActiveThreadClosesPage" | "findExecutingThreadClosesPage"
>;

type RecoverySchedules = Pick<ScheduledThreadCloseStore, "releaseExecutionForRetry">;

type RecoveryDelivery = Pick<
  ScheduledThreadCloseWorkerController,
  "cancelStaleActiveDeliveries" | "enqueueScheduledThreadClose" | "hasCreatedOrRetryDelivery"
>;

function createAction(
  id: string,
  status: ScheduledAction["status"],
  executeAt = new Date("2030-01-01T00:00:00Z"),
): ScheduledAction {
  return {
    id,
    guildId: "guild-id",
    actionType: "CLOSE_THREAD",
    targetId: `thread-${id}`,
    status,
    executeAt,
    createdAt: new Date("2029-01-01T00:00:00Z"),
    updatedAt: new Date("2029-01-01T00:00:00Z"),
  };
}

function createFixture() {
  const scheduledActions: RecoveryStore = {
    findActiveThreadClosesPage: vi.fn(() => Promise.resolve([])),
    findExecutingThreadClosesPage: vi.fn(() => Promise.resolve([])),
  };
  const schedules: RecoverySchedules = {
    releaseExecutionForRetry: vi.fn<RecoverySchedules["releaseExecutionForRetry"]>((input) =>
      Promise.resolve({
        outcome: "TRANSITIONED",
        action: createAction(input.scheduledActionId, "ACTIVE"),
      }),
    ),
  };
  const delivery: RecoveryDelivery = {
    cancelStaleActiveDeliveries: vi.fn(() => Promise.resolve(0)),
    enqueueScheduledThreadClose: vi.fn(() => Promise.resolve("ENQUEUED" as const)),
    hasCreatedOrRetryDelivery: vi.fn(() => Promise.resolve(false)),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Pick<Logger, "info" | "warn">;
  const reconciler = createScheduledThreadCloseStartupReconciler({
    scheduledActions,
    schedules,
    delivery,
    logger,
  });
  return { delivery, logger, reconciler, scheduledActions, schedules };
}

function createRuntimeFixture() {
  const fixture = createFixture();
  const reconciler = createScheduledThreadCloseRuntimeReconciler({
    scheduledActions: fixture.scheduledActions,
    delivery: fixture.delivery,
    logger: fixture.logger,
  });
  return { ...fixture, reconciler };
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve: (value) => resolve?.(value) };
}

describe("scheduled thread close startup reconciliation", () => {
  it("completes clean startup with no recovery work", async () => {
    const fixture = createFixture();

    await expect(fixture.reconciler.recoverAtStartup()).resolves.toBeUndefined();

    expect(fixture.delivery.cancelStaleActiveDeliveries).not.toHaveBeenCalled();
    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ activeScanned: 0, executingScanned: 0 }),
      expect.any(String),
    );
  });

  it("recovers every EXECUTING action before scanning ACTIVE actions", async () => {
    const fixture = createFixture();
    const calls: string[] = [];
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockImplementationOnce(() => {
        calls.push("executing-page");
        return Promise.resolve([executing]);
      })
      .mockImplementationOnce(() => Promise.resolve([]));
    vi.mocked(fixture.delivery.cancelStaleActiveDeliveries).mockImplementation(() => {
      calls.push("cleanup");
      return Promise.resolve(1);
    });
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockImplementation(() => {
      calls.push("release");
      return Promise.resolve({
        outcome: "TRANSITIONED",
        action: { ...executing, status: "ACTIVE" },
      });
    });
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage).mockImplementation(() => {
      calls.push("active-page");
      return Promise.resolve([]);
    });

    await fixture.reconciler.recoverAtStartup();

    expect(calls).toEqual(["executing-page", "cleanup", "release", "active-page"]);
    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
  });

  it("cleans stale ACTIVE delivery and enqueues with persisted future and overdue times", async () => {
    const fixture = createFixture();
    const overdue = createAction("overdue", "ACTIVE", new Date(0));
    const future = createAction("future", "ACTIVE", new Date("2999-01-01T00:00:00Z"));
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([overdue, future])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.delivery.cancelStaleActiveDeliveries)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);

    await fixture.reconciler.recoverAtStartup();

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenNthCalledWith(
      1,
      overdue.id,
      overdue.executeAt,
    );
    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenNthCalledWith(
      2,
      future.id,
      future.executeAt,
    );
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduled_thread_close_startup_recovery_completed",
        activeScanned: 2,
        staleActiveCancelled: 1,
        enqueued: 2,
      }),
      expect.any(String),
    );
  });

  it("uses the last row as each focused keyset cursor", async () => {
    const fixture = createFixture();
    const executingOne = createAction("exec-a", "EXECUTING");
    const executingTwo = createAction("exec-b", "EXECUTING");
    const executeAt = new Date("2030-02-01T00:00:00Z");
    const activeOne = createAction("active-a", "ACTIVE", executeAt);
    const activeTwo = createAction("active-b", "ACTIVE", executeAt);
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executingOne, executingTwo])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([activeOne, activeTwo])
      .mockResolvedValueOnce([]);

    await fixture.reconciler.recoverAtStartup();

    expect(fixture.scheduledActions.findExecutingThreadClosesPage).toHaveBeenNthCalledWith(
      2,
      executingTwo.id,
    );
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenNthCalledWith(2, {
      executeAt,
      id: activeTwo.id,
    });
  });

  it.each(["CANCELLED", "COMPLETED", "FAILED"] as const)(
    "does not enqueue an EXECUTING row that is currently %s",
    async (status) => {
      const fixture = createFixture();
      const executing = createAction("executing", "EXECUTING");
      vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
        .mockResolvedValueOnce([executing])
        .mockResolvedValueOnce([]);
      vi.mocked(fixture.schedules.releaseExecutionForRetry).mockResolvedValue({
        outcome: "NOT_TRANSITIONED",
        current: { ...executing, status },
      });

      await fixture.reconciler.recoverAtStartup();

      expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
    },
  );

  it("releases an interrupted execution with one stable recovery audit ID", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);

    await fixture.reconciler.recoverAtStartup();

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
    const [release] = vi.mocked(fixture.schedules.releaseExecutionForRetry).mock.calls[0]!;
    expect(release.scheduledActionId).toBe(executing.id);
    expect(release.failureCode).toBe("EXECUTION_INTERRUPTED");
    expect(release.auditId).toMatch(/\S/);
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ executingScanned: 1, interruptedReleased: 1 }),
      expect.any(String),
    );
  });

  it("generates a distinct stable recovery audit ID for each interrupted action", async () => {
    const fixture = createFixture();
    const first = createAction("exec-one", "EXECUTING");
    const second = createAction("exec-two", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([]);

    await fixture.reconciler.recoverAtStartup();

    const auditIds = vi
      .mocked(fixture.schedules.releaseExecutionForRetry)
      .mock.calls.map(([input]) => input.auditId);
    expect(auditIds).toHaveLength(2);
    expect(new Set(auditIds).size).toBe(2);
  });

  it("accepts a release the persistence boundary confirmed as already committed", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockResolvedValue({
      outcome: "ALREADY_COMMITTED",
      action: { ...executing, status: "ACTIVE" },
    });

    await expect(fixture.reconciler.recoverAtStartup()).resolves.toBeUndefined();

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ interruptedReleased: 1 }),
      expect.any(String),
    );
  });

  it("fails startup when an ACTIVE action lacks this attempt's recovery audit", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage).mockResolvedValueOnce([
      executing,
    ]);
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockResolvedValue({
      outcome: "NOT_TRANSITIONED",
      current: { ...executing, status: "ACTIVE" },
    });

    await expect(fixture.reconciler.recoverAtStartup()).rejects.toMatchObject({
      name: "ScheduledThreadCloseStartupRecoveryError",
      failureCode: "EXECUTING_RELEASE_UNCONFIRMED",
    } satisfies Partial<ScheduledThreadCloseStartupRecoveryError>);
    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
  });

  it("fails startup without repeating an unconfirmed release", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage).mockResolvedValueOnce([
      executing,
    ]);
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockRejectedValue(
      new Error("response lost"),
    );

    await expect(fixture.reconciler.recoverAtStartup()).rejects.toMatchObject({
      name: "ScheduledThreadCloseStartupRecoveryError",
      failureCode: "EXECUTING_RELEASE_UNCONFIRMED",
    } satisfies Partial<ScheduledThreadCloseStartupRecoveryError>);
    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
  });

  it("continues recovery without enqueue when an interrupted action is missing", async () => {
    const fixture = createFixture();
    const executing = createAction("missing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockResolvedValue({
      outcome: "NOT_TRANSITIONED",
      current: undefined,
    });

    await expect(fixture.reconciler.recoverAtStartup()).resolves.toBeUndefined();

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();
    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
    expect(fixture.delivery.hasCreatedOrRetryDelivery).not.toHaveBeenCalled();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ skippedCurrentState: 1 }),
      expect.any(String),
    );
  });

  it("fails startup when an interrupted action remains EXECUTING", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage).mockResolvedValueOnce([
      executing,
    ]);
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockResolvedValue({
      outcome: "NOT_TRANSITIONED",
      current: executing,
    });

    await expect(fixture.reconciler.recoverAtStartup()).rejects.toMatchObject({
      name: "ScheduledThreadCloseStartupRecoveryError",
      failureCode: "EXECUTING_RELEASE_UNCONFIRMED",
    } satisfies Partial<ScheduledThreadCloseStartupRecoveryError>);
  });

  it("confirms an enqueue that succeeded before its client promise rejects", async () => {
    const fixture = createFixture();
    const active = createAction("active", "ACTIVE");
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.delivery.enqueueScheduledThreadClose).mockRejectedValue(
      new Error("response lost"),
    );
    vi.mocked(fixture.delivery.hasCreatedOrRetryDelivery).mockResolvedValue(true);

    await fixture.reconciler.recoverAtStartup();

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(fixture.delivery.hasCreatedOrRetryDelivery).toHaveBeenCalledWith(active.id);
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alreadyPresent: 1 }),
      expect.any(String),
    );
  });

  it("accepts an existing singleton without starting a second delivery", async () => {
    const fixture = createFixture();
    const active = createAction("active", "ACTIVE");
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.delivery.enqueueScheduledThreadClose).mockResolvedValue("ALREADY_PRESENT");

    await fixture.reconciler.recoverAtStartup();

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alreadyPresent: 1, enqueued: 0 }),
      expect.any(String),
    );
  });

  it("fails safely without logging raw enqueue errors when delivery cannot be confirmed", async () => {
    const fixture = createFixture();
    const active = createAction("active", "ACTIVE");
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage).mockResolvedValueOnce([active]);
    vi.mocked(fixture.delivery.enqueueScheduledThreadClose).mockRejectedValue(
      new Error("sensitive database detail"),
    );

    await expect(fixture.reconciler.recoverAtStartup()).rejects.toMatchObject({
      failureCode: "ENQUEUE_UNCONFIRMED",
    });
    expect(
      JSON.stringify((fixture.logger.warn as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("sensitive database detail");
  });
});

describe("scheduled thread close runtime reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconciles only ACTIVE pages with persisted execution times", async () => {
    const fixture = createRuntimeFixture();
    const overdue = createAction("overdue", "ACTIVE", new Date(0));
    const executeAt = new Date("2999-01-01T00:00:00Z");
    const futureOne = createAction("future-a", "ACTIVE", executeAt);
    const futureTwo = createAction("future-b", "ACTIVE", executeAt);
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([overdue, futureOne])
      .mockResolvedValueOnce([futureTwo])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.delivery.enqueueScheduledThreadClose)
      .mockResolvedValueOnce("ENQUEUED")
      .mockResolvedValueOnce("ALREADY_PRESENT")
      .mockResolvedValueOnce("ENQUEUED");

    await fixture.reconciler.reconcileOnce();

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenNthCalledWith(
      1,
      overdue.id,
      overdue.executeAt,
    );
    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenNthCalledWith(
      2,
      futureOne.id,
      futureOne.executeAt,
    );
    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenNthCalledWith(
      3,
      futureTwo.id,
      futureTwo.executeAt,
    );
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenNthCalledWith(2, {
      executeAt,
      id: futureOne.id,
    });
    expect(fixture.scheduledActions.findExecutingThreadClosesPage).not.toHaveBeenCalled();
    expect(fixture.schedules.releaseExecutionForRetry).not.toHaveBeenCalled();
    expect(fixture.delivery.cancelStaleActiveDeliveries).not.toHaveBeenCalled();
    expect(fixture.delivery.hasCreatedOrRetryDelivery).not.toHaveBeenCalled();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "periodic",
        pageCount: 2,
        scanned: 3,
        enqueued: 2,
        alreadyPresent: 1,
        outcome: "COMPLETED",
      }),
      expect.any(String),
    );
  });

  it("starts idempotently and performs the first periodic sweep after 60 seconds", async () => {
    const fixture = createRuntimeFixture();

    await fixture.reconciler.start();
    await fixture.reconciler.start();
    expect(fixture.scheduledActions.findActiveThreadClosesPage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS - 1);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "scheduled_thread_close_runtime_reconciliation_started",
        intervalMs: SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS,
      }),
      expect.any(String),
    );

    await fixture.reconciler.stop();
  });

  it("keeps manual and periodic reconciliation single-flight and delays from settlement", async () => {
    const fixture = createRuntimeFixture();
    const page = createDeferred<ScheduledAction[]>();
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockReturnValueOnce(page.promise)
      .mockResolvedValue([]);
    await fixture.reconciler.start();

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);
    const manualOne = fixture.reconciler.reconcileOnce();
    const manualTwo = fixture.reconciler.reconcileOnce();
    expect(manualOne).toBe(manualTwo);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();

    page.resolve([]);
    await manualOne;
    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS - 1);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledTimes(2);

    await fixture.reconciler.stop();
  });

  it("stops a failed sweep and retries from the beginning on the next cycle", async () => {
    const fixture = createRuntimeFixture();
    const first = createAction("first", "ACTIVE");
    const second = createAction("second", "ACTIVE");
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.delivery.enqueueScheduledThreadClose)
      .mockRejectedValueOnce(new Error("sensitive enqueue detail"))
      .mockResolvedValue("ENQUEUED");
    await fixture.reconciler.start();

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenNthCalledWith(
      1,
      undefined,
    );
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "ENQUEUE_FAILED", outcome: "FAILED", scanned: 1 }),
      expect.any(String),
    );
    expect(
      JSON.stringify((fixture.logger.warn as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("sensitive enqueue detail");

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);

    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenNthCalledWith(
      2,
      undefined,
    );
    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledTimes(3);
    await fixture.reconciler.stop();
  });

  it("logs a safe page failure and retries on the next cycle", async () => {
    const fixture = createRuntimeFixture();
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage)
      .mockRejectedValueOnce(new Error("sensitive database detail"))
      .mockResolvedValueOnce([]);
    await fixture.reconciler.start();

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "ACTIVE_SCAN_FAILED", outcome: "FAILED" }),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenNthCalledWith(
      2,
      undefined,
    );
    expect(
      JSON.stringify((fixture.logger.warn as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain("sensitive database detail");
    await fixture.reconciler.stop();
  });

  it("stops idempotently, cancels the timer, and never schedules another sweep", async () => {
    const fixture = createRuntimeFixture();
    await fixture.reconciler.start();

    const firstStop = fixture.reconciler.stop();
    const secondStop = fixture.reconciler.stop();
    expect(firstStop).toBe(secondStop);
    await firstStop;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS * 2);

    expect(fixture.scheduledActions.findActiveThreadClosesPage).not.toHaveBeenCalled();
    await fixture.reconciler.reconcileOnce();
    expect(fixture.scheduledActions.findActiveThreadClosesPage).not.toHaveBeenCalled();
  });

  it("waits for an in-flight sweep without aborting it during stop", async () => {
    const fixture = createRuntimeFixture();
    const page = createDeferred<ScheduledAction[]>();
    vi.mocked(fixture.scheduledActions.findActiveThreadClosesPage).mockReturnValue(page.promise);
    await fixture.reconciler.start();
    const sweep = fixture.reconciler.reconcileOnce();
    let stopped = false;

    const stop = fixture.reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    page.resolve([]);
    await sweep;
    await stop;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(SCHEDULED_THREAD_CLOSE_RECONCILIATION_INTERVAL_MS * 2);
    expect(fixture.scheduledActions.findActiveThreadClosesPage).toHaveBeenCalledOnce();
  });
});
