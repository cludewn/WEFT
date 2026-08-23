import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  ScheduledAction,
  ScheduledActionStore,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseStartupReconciler } from "../../src/scheduled-thread-close-reconciler.js";
import type { ScheduledThreadCloseStartupRecoveryError } from "../../src/scheduled-thread-close-reconciler.js";
import type { ScheduledThreadCloseWorkerController } from "../../src/scheduled-thread-close-worker.js";

type RecoveryStore = Pick<
  ScheduledActionStore,
  | "findById"
  | "findActiveThreadClosesPage"
  | "findExecutingThreadClosesPage"
  | "releaseExecutionForRetry"
>;

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
    findById: vi.fn(() => Promise.resolve(undefined)),
    findActiveThreadClosesPage: vi.fn(() => Promise.resolve([])),
    findExecutingThreadClosesPage: vi.fn(() => Promise.resolve([])),
    releaseExecutionForRetry: vi.fn((id: string) =>
      Promise.resolve({ transitioned: true, current: createAction(id, "ACTIVE") }),
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
    delivery,
    logger,
  });
  return { delivery, logger, reconciler, scheduledActions };
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
    vi.mocked(fixture.scheduledActions.releaseExecutionForRetry).mockImplementation(() => {
      calls.push("release");
      return Promise.resolve({
        transitioned: true,
        current: { ...executing, status: "ACTIVE" },
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
      vi.mocked(fixture.scheduledActions.releaseExecutionForRetry).mockResolvedValue({
        transitioned: false,
        current: { ...executing, status },
      });

      await fixture.reconciler.recoverAtStartup();

      expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
    },
  );

  it("confirms an applied release after its client promise rejects", async () => {
    const fixture = createFixture();
    const executing = createAction("executing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.scheduledActions.releaseExecutionForRetry).mockRejectedValue(
      new Error("response lost"),
    );
    vi.mocked(fixture.scheduledActions.findById).mockResolvedValue({
      ...executing,
      status: "ACTIVE",
    });

    await expect(fixture.reconciler.recoverAtStartup()).resolves.toBeUndefined();

    expect(fixture.scheduledActions.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.scheduledActions.findById).toHaveBeenCalledOnce();
  });

  it("continues recovery without enqueue when an interrupted action is missing", async () => {
    const fixture = createFixture();
    const executing = createAction("missing", "EXECUTING");
    vi.mocked(fixture.scheduledActions.findExecutingThreadClosesPage)
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.scheduledActions.releaseExecutionForRetry).mockRejectedValue(
      new Error("response lost"),
    );
    vi.mocked(fixture.scheduledActions.findById).mockResolvedValue(undefined);

    await expect(fixture.reconciler.recoverAtStartup()).resolves.toBeUndefined();

    expect(fixture.scheduledActions.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.scheduledActions.findById).toHaveBeenCalledWith(executing.id);
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
    vi.mocked(fixture.scheduledActions.releaseExecutionForRetry).mockResolvedValue({
      transitioned: false,
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
