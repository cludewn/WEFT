import type { JobWithMetadata } from "pg-boss";
import { describe, expect, it, vi } from "vitest";

import type { RecurringDelivery } from "../../src/recurring-message-execution.js";
import {
  createRecurringMessageWorker,
  RECURRING_MESSAGE_QUEUE,
} from "../../src/recurring-message-worker.js";

function fixture() {
  const jobs: Array<{ data: RecurringDelivery; state: "created" | "active"; startAfter: Date }> =
    [];
  let handler: ((jobs: JobWithMetadata<unknown>[]) => Promise<void>) | undefined;
  const boss = {
    createQueue: vi.fn().mockResolvedValue(undefined),
    getQueue: vi
      .fn()
      .mockResolvedValue({ policy: "exclusive", retryLimit: 0, expireInSeconds: 900 }),
    findJobs: vi
      .fn()
      .mockImplementation((_name: string, options: { key: string }) =>
        Promise.resolve(
          jobs.filter((job) => `${job.data.occurrenceId}:${job.data.retryCount}` === options.key),
        ),
      ),
    upsert: vi
      .fn()
      .mockImplementation(
        (_name: string, data: RecurringDelivery, options: { startAfter: Date }) => {
          jobs.push({ data, state: "created", startAfter: options.startAfter });
          return Promise.resolve("job");
        },
      ),
    work: vi
      .fn()
      .mockImplementation((_name: string, _options: unknown, callback: typeof handler) => {
        handler = callback;
        return Promise.resolve("worker");
      }),
    offWork: vi.fn().mockResolvedValue(undefined),
  };
  const executor = {
    execute: vi.fn().mockResolvedValue({ outcome: "FAILED", code: "SEND_REJECTED" }),
  };
  const store = {
    load: vi.fn().mockResolvedValue({ action: { id: "series" }, occurrence: { retryCount: 0 } }),
  };
  const recurring = { find: vi.fn().mockResolvedValue(undefined) };
  const logger = { info: vi.fn(), warn: vi.fn() };
  const worker = createRecurringMessageWorker({
    boss,
    executor,
    recurring,
    store,
    logger,
  });
  const delivery: RecurringDelivery = {
    kind: "recurring-message-occurrence",
    scheduledActionId: "series",
    occurrenceId: "occurrence",
    scheduledFor: "2026-01-01T09:00:00.000Z",
    seriesRevision: 0,
    retryCount: 0,
  };
  return { worker, boss, jobs, executor, delivery, logger, handler: () => handler };
}

describe("recurring delivery worker", () => {
  it("creates a dedicated exclusive queue without pg-boss application retry", async () => {
    const { worker, boss } = fixture();
    await worker.ensureQueue();
    expect(boss.createQueue).toHaveBeenCalledWith(RECURRING_MESSAGE_QUEUE, {
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 900,
    });
  });

  it("deduplicates one generation and permits a later generation beside an active old one", async () => {
    const { worker, boss, jobs, delivery } = fixture();
    const wakeAt = new Date(delivery.scheduledFor);
    expect(await worker.project({ delivery, wakeAt })).toBe("CURRENT");
    expect(await worker.project({ delivery, wakeAt })).toBe("CURRENT");
    expect(boss.upsert).toHaveBeenCalledTimes(1);
    jobs[0]!.state = "active";
    expect(
      await worker.project({
        delivery: { ...delivery, retryCount: 1 },
        wakeAt: new Date(wakeAt.getTime() + 30_000),
      }),
    ).toBe("CURRENT");
    expect(boss.upsert).toHaveBeenCalledTimes(2);
    expect(boss.upsert.mock.calls[0]?.[2]).toMatchObject({
      singletonKey: "occurrence:0",
      retryLimit: 0,
    });
    expect(boss.upsert.mock.calls[1]?.[2]).toMatchObject({
      singletonKey: "occurrence:1",
      retryLimit: 0,
    });
  });

  it("returns normally for a stale generation without executing", async () => {
    const { worker, executor, delivery, handler } = fixture();
    await worker.start();
    const callback = handler();
    if (callback === undefined) throw new Error("Worker callback missing");
    await expect(
      callback([{ id: "stale", data: { ...delivery, retryCount: 1 } } as JobWithMetadata<unknown>]),
    ).resolves.toBeUndefined();
    expect(executor.execute).not.toHaveBeenCalled();
    await worker.stop();
  });

  it("does not create a detached bookkeeping rejection when an invocation rejects", async () => {
    const { worker, delivery, handler, logger } = fixture();
    vi.mocked(logger.info).mockImplementation(() => {
      throw new Error("logger rejected the invocation");
    });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      await worker.start();
      const callback = handler();
      if (callback === undefined) throw new Error("Worker callback missing");
      await expect(
        callback([{ id: "current", data: delivery } as JobWithMetadata<unknown>]),
      ).rejects.toThrow("logger rejected the invocation");
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      await worker.stop();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
