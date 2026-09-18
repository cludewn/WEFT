import type { JobWithMetadata, PgBoss, QueueResult } from "pg-boss";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ScheduledAction } from "../../src/scheduled-action-persistence.js";
import type { ScheduledMessageExecutionResult } from "../../src/scheduled-message-execution.js";
import {
  createScheduledMessageWorkerController,
  SCHEDULED_MESSAGE_QUEUE,
  ScheduledMessageDeliveryRetryError,
} from "../../src/scheduled-message-worker.js";

type Handler = (jobs: JobWithMetadata<unknown>[]) => Promise<unknown>;
const requiredQueue = {
  policy: "exclusive",
  retryLimit: 3,
  retryDelay: 30,
  retryBackoff: true,
  retryDelayMax: 900,
  expireInSeconds: 900,
} as QueueResult;

function action(
  status: ScheduledAction["status"] = "ACTIVE",
  actionType: ScheduledAction["actionType"] = "SEND_MESSAGE",
): ScheduledAction {
  return {
    id: "action-id",
    guildId: "guild-id",
    actionType,
    targetId: "channel-id",
    status,
    executeAt: new Date("2020-01-01T00:00:00Z"),
    createdAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: new Date("2020-01-01T00:00:00Z"),
  };
}
function job(data: unknown = { scheduledActionId: "action-id" }): JobWithMetadata<unknown> {
  return {
    id: "job-id",
    name: SCHEDULED_MESSAGE_QUEUE,
    data,
    signal: new AbortController().signal,
    retryCount: 0,
    retryLimit: 3,
  } as JobWithMetadata<unknown>;
}
function deliveryJob(input: {
  state: "created" | "retry" | "active" | "completed";
  data: unknown;
  startAfter?: Date;
}): JobWithMetadata<unknown> {
  return {
    ...job(input.data),
    state: input.state,
    startAfter: input.startAfter ?? new Date("2030-01-01T00:00:00.000Z"),
    singletonKey: "action-id",
  };
}
function fixture(
  result: ScheduledMessageExecutionResult = { outcome: "SUCCESS" },
  configuredCurrent: ScheduledAction | null = action(),
) {
  const current = configuredCurrent === null ? undefined : configuredCurrent;
  let handler: Handler | undefined;
  const boss = {
    createQueue: vi.fn(() => Promise.resolve()),
    getQueue: vi.fn(() => Promise.resolve(requiredQueue)),
    upsert: vi.fn(() => Promise.resolve({ jobs: ["job-id"], updated: 0, inserted: 1 })),
    findJobs: vi.fn(() => Promise.resolve([])),
    cancel: vi.fn(() => Promise.resolve({})),
    work: vi.fn((_queue: string, _options: unknown, registered: Handler) => {
      handler = registered;
      return Promise.resolve("worker-id");
    }),
    offWork: vi.fn(() => Promise.resolve()),
  } as unknown as Pick<
    PgBoss,
    "createQueue" | "getQueue" | "upsert" | "findJobs" | "cancel" | "work" | "offWork"
  >;
  const execute = vi.fn(() => Promise.resolve(result));
  const findById = vi.fn(() => Promise.resolve(current));
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  const controller = createScheduledMessageWorkerController({
    boss,
    scheduledActions: { findById },
    executor: { execute },
    logger,
  });
  const run = async (input = job()) => {
    await controller.start();
    return handler!([input]);
  };
  return { boss, controller, execute, findById, run };
}

describe("scheduled message pg-boss worker", () => {
  it("creates the exact queue and upserts projection metadata", async () => {
    const f = fixture();
    await f.controller.ensureQueue();
    expect(f.boss.createQueue).toHaveBeenCalledWith(SCHEDULED_MESSAGE_QUEUE, {
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    const executeAt = new Date("2030-01-01T00:00:00Z");
    await f.controller.ensureScheduledMessageDelivery({
      scheduledActionId: "action-id",
      executeAt,
      revision: 0,
    });
    expect(f.boss.upsert).toHaveBeenCalledWith(
      SCHEDULED_MESSAGE_QUEUE,
      {
        scheduledActionId: "action-id",
        scheduledExecuteAt: executeAt.toISOString(),
        scheduleRevision: 0,
      },
      expect.objectContaining({ singletonKey: "action-id", startAfter: executeAt }),
    );
  });

  it("validates payload strictly", async () => {
    const f = fixture();
    await f.run(job({ scheduledActionId: "action-id", guildId: "not-allowed" }));
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("classifies projected created/retry timing and ignores revision-only drift", async () => {
    const executeAt = new Date("2030-01-01T00:00:00.000Z");
    const projection = { scheduledActionId: "action-id", executeAt, revision: 9 };
    const f = fixture();
    vi.mocked(f.boss.findJobs).mockResolvedValue([
      deliveryJob({
        state: "created",
        data: {
          scheduledActionId: "action-id",
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 1,
        },
        startAfter: executeAt,
      }),
    ]);
    await expect(f.controller.inspectScheduledMessageDelivery(projection)).resolves.toBe("CURRENT");

    vi.mocked(f.boss.findJobs).mockResolvedValue([
      deliveryJob({
        state: "retry",
        data: {
          scheduledActionId: "action-id",
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 1,
        },
        startAfter: new Date("2030-01-01T00:05:00.000Z"),
      }),
    ]);
    await expect(f.controller.inspectScheduledMessageDelivery(projection)).resolves.toBe("CURRENT");
  });

  it("does not replace a current active delivery", async () => {
    const f = fixture();
    const executeAt = new Date("2030-01-01T00:00:00.000Z");
    vi.mocked(f.boss.findJobs).mockResolvedValue([
      deliveryJob({
        state: "active",
        data: {
          scheduledActionId: "action-id",
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 0,
        },
      }),
    ]);

    await expect(
      f.controller.ensureScheduledMessageDelivery({
        scheduledActionId: "action-id",
        executeAt,
        revision: 1,
      }),
    ).resolves.toBe("CURRENT");
    expect(f.boss.cancel).not.toHaveBeenCalled();
    expect(f.boss.upsert).not.toHaveBeenCalled();
  });

  it("treats malformed or multiple effective deliveries as unconfirmed", async () => {
    const f = fixture();
    const projection = {
      scheduledActionId: "action-id",
      executeAt: new Date("2030-01-01T00:00:00.000Z"),
      revision: 0,
    };
    vi.mocked(f.boss.findJobs).mockResolvedValue([
      deliveryJob({ state: "created", data: { scheduledActionId: "action-id", extra: true } }),
    ]);
    await expect(f.controller.inspectScheduledMessageDelivery(projection)).resolves.toBe(
      "UNCONFIRMED",
    );
    vi.mocked(f.boss.findJobs).mockResolvedValue([
      deliveryJob({ state: "created", data: { scheduledActionId: "action-id" } }),
      deliveryJob({ state: "retry", data: { scheduledActionId: "action-id" } }),
    ]);
    await expect(f.controller.inspectScheduledMessageDelivery(projection)).resolves.toBe(
      "UNCONFIRMED",
    );
  });

  it("adopts legacy retry metadata without rewriting its retry wake time", async () => {
    const f = fixture();
    const retryWake = new Date("2030-01-01T00:05:00.000Z");
    const executeAt = new Date("2030-01-01T00:00:00.000Z");
    vi.mocked(f.boss.findJobs)
      .mockResolvedValueOnce([
        deliveryJob({
          state: "retry",
          data: { scheduledActionId: "action-id" },
          startAfter: retryWake,
        }),
      ])
      .mockResolvedValueOnce([
        deliveryJob({
          state: "retry",
          data: {
            scheduledActionId: "action-id",
            scheduledExecuteAt: executeAt.toISOString(),
            scheduleRevision: 3,
          },
          startAfter: retryWake,
        }),
      ]);
    await expect(
      f.controller.ensureScheduledMessageDelivery({
        scheduledActionId: "action-id",
        executeAt,
        revision: 3,
      }),
    ).resolves.toBe("CURRENT");
    expect(f.boss.upsert).toHaveBeenCalledWith(
      SCHEDULED_MESSAGE_QUEUE,
      expect.objectContaining({ scheduleRevision: 3 }),
      expect.any(Object),
    );
    expect(vi.mocked(f.boss.upsert).mock.calls[0]?.[2]).not.toHaveProperty("startAfter");
  });

  it("confirms an ambiguous upsert result without retrying the mutation", async () => {
    const f = fixture();
    const executeAt = new Date("2030-01-01T00:00:00.000Z");
    vi.mocked(f.boss.findJobs)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        deliveryJob({
          state: "created",
          data: {
            scheduledActionId: "action-id",
            scheduledExecuteAt: executeAt.toISOString(),
            scheduleRevision: 4,
          },
          startAfter: executeAt,
        }),
      ]);
    vi.mocked(f.boss.upsert).mockRejectedValue(new Error("response lost"));

    await expect(
      f.controller.ensureScheduledMessageDelivery({
        scheduledActionId: "action-id",
        executeAt,
        revision: 4,
      }),
    ).resolves.toBe("CURRENT");
    expect(f.boss.upsert).toHaveBeenCalledTimes(1);
  });

  it("does not replace a stale active delivery until cancellation is confirmed", async () => {
    const f = fixture();
    const executeAt = new Date("2030-01-01T00:00:00.000Z");
    const staleActive = deliveryJob({
      state: "active",
      data: {
        scheduledActionId: "action-id",
        scheduledExecuteAt: "2029-12-31T23:00:00.000Z",
        scheduleRevision: 0,
      },
    });
    vi.mocked(f.boss.findJobs).mockResolvedValue([staleActive]);
    vi.mocked(f.boss.cancel).mockRejectedValue(new Error("cancellation unconfirmed"));

    await expect(
      f.controller.ensureScheduledMessageDelivery({
        scheduledActionId: "action-id",
        executeAt,
        revision: 1,
      }),
    ).resolves.toBe("PENDING_RECONCILIATION");
    expect(f.boss.cancel).toHaveBeenCalledExactlyOnceWith(SCHEDULED_MESSAGE_QUEUE, staleActive.id);
    expect(f.boss.upsert).not.toHaveBeenCalled();
  });

  it.each([
    null,
    action("CANCELLED"),
    action("COMPLETED"),
    action("FAILED"),
    action("EXECUTING"),
    action("ACTIVE", "CLOSE_THREAD"),
  ])("does not execute missing, terminal, executing, or wrong-type state %#", async (current) => {
    const f = fixture({ outcome: "SUCCESS" }, current);
    await f.run();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects only a committed safe pre-send retry", async () => {
    const f = fixture({ outcome: "RETRYABLE_FAILURE", code: "CURRENT_STATE_CHECK_FAILED" });
    await expect(f.run()).rejects.toBeInstanceOf(ScheduledMessageDeliveryRetryError);
  });

  it("resolves when authoritative state cannot be read", async () => {
    const f = fixture();
    f.findById.mockRejectedValue(new Error("database unavailable"));
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not execute an action before its persisted execution time", async () => {
    const future = action();
    future.executeAt = new Date("2999-01-01T00:00:00Z");
    const f = fixture({ outcome: "SUCCESS" }, future);
    await expect(f.run()).resolves.toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not turn an unexpected executor error into an unsafe delivery retry", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new Error("unexpected executor failure"));
    await expect(f.run()).resolves.toBeUndefined();
  });

  it.each([
    { outcome: "SUCCESS" } as const,
    { outcome: "SKIPPED", reason: "NOT_ACTIVE" } as const,
    { outcome: "PERMANENT_FAILURE", code: "SEND_REJECTED" } as const,
    { outcome: "UNCONFIRMED", code: "SEND_UNCONFIRMED" } as const,
    { outcome: "PERMANENT_FAILURE", code: "FINALIZATION_FAILED_COMPENSATED" } as const,
    { outcome: "PERMANENT_FAILURE", code: "FINALIZATION_FAILED_UNCOMPENSATED" } as const,
    { outcome: "PERMANENT_FAILURE", code: "RETURNED_MESSAGE_MISMATCH" } as const,
  ])("resolves terminal outcome $outcome/$code", async (result) => {
    const f = fixture(result);
    await expect(f.run()).resolves.toBeUndefined();
  });

  it("cancels only created, retry, and active delivery while preserving terminal history", async () => {
    const f = fixture();
    vi.mocked(f.boss.findJobs)
      .mockResolvedValueOnce([
        { id: "created-id", state: "created" },
        { id: "retry-id", state: "retry" },
        { id: "active-id", state: "active" },
        { id: "completed-id", state: "completed" },
        { id: "cancelled-id", state: "cancelled" },
        { id: "failed-id", state: "failed" },
      ] as never)
      .mockResolvedValueOnce([
        { id: "completed-id", state: "completed" },
        { id: "cancelled-id", state: "cancelled" },
        { id: "failed-id", state: "failed" },
      ] as never);

    await expect(f.controller.cancelScheduledMessageDeliveries("action-id")).resolves.toEqual({
      outcome: "CONFIRMED",
      matchedDeliveryCount: 3,
    });
    expect(f.boss.cancel).toHaveBeenCalledExactlyOnceWith(SCHEDULED_MESSAGE_QUEUE, [
      "created-id",
      "retry-id",
      "active-id",
    ]);
  });

  it("confirms cleanup by rereading even when cancel throws", async () => {
    const f = fixture();
    vi.mocked(f.boss.findJobs)
      .mockResolvedValueOnce([{ id: "created-id", state: "created" }] as never)
      .mockResolvedValueOnce([]);
    vi.mocked(f.boss.cancel).mockRejectedValue(new Error("response lost"));
    await expect(f.controller.cancelScheduledMessageDeliveries("action-id")).resolves.toEqual({
      outcome: "CONFIRMED",
      matchedDeliveryCount: 1,
    });
  });

  it("reports cleanup unconfirmed while cancellable delivery remains", async () => {
    const f = fixture();
    vi.mocked(f.boss.findJobs).mockResolvedValue([{ id: "active-id", state: "active" }] as never);
    await expect(f.controller.cancelScheduledMessageDeliveries("action-id")).resolves.toEqual({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 1,
    });
  });
});
