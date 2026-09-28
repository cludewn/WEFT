import { describe, expect, it, vi } from "vitest";

import { createRecurringMessageReconciler } from "../../src/recurring-message-reconciler.js";
import type { RecurringRuntimeDefinition } from "../../src/recurring-message-runtime-persistence.js";

function fixture() {
  const executing = {
    action: { id: "series", status: "ACTIVE" },
    occurrence: { id: "occurrence", status: "EXECUTING" },
    state: { revision: 0 },
  } as RecurringRuntimeDefinition;
  const store = {
    page: vi
      .fn()
      .mockImplementation((status: string) =>
        Promise.resolve(status === "EXECUTING" ? [executing] : []),
      ),
    pageMissing: vi.fn().mockResolvedValue([]),
    terminalize: vi.fn().mockResolvedValue("COMMITTED"),
    expireRetry: vi.fn().mockResolvedValue("NOT_COMMITTED"),
    recoverMissed: vi.fn(),
    recoverMissing: vi.fn(),
    load: vi.fn(),
    retryWake: vi.fn(),
    resumeRetry: vi.fn(),
    recordPreSendFailure: vi.fn(),
  };
  const worker = { project: vi.fn().mockResolvedValue("CURRENT") };
  const logger = { warn: vi.fn() };
  const reconciler = createRecurringMessageReconciler({
    store,
    worker,
    logger,
    now: () => new Date("2026-01-01T09:00:00.000Z"),
  });
  return { store, worker, logger, reconciler };
}

describe("recurring reconciliation", () => {
  it("terminalizes an orphaned executing occurrence at startup without projection", async () => {
    const { store, worker, reconciler } = fixture();
    await reconciler.recoverAtStartup();
    expect(store.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        occurrenceId: "occurrence",
        failureCode: "EXECUTION_INTERRUPTED_UNCONFIRMED",
      }),
    );
    expect(worker.project).not.toHaveBeenCalled();
  });

  it("does not classify a live executing occurrence as interrupted during runtime", async () => {
    vi.useFakeTimers();
    try {
      const { store, reconciler } = fixture();
      await reconciler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.page).not.toHaveBeenCalledWith("EXECUTING", undefined);
      expect(store.terminalize).not.toHaveBeenCalled();
      await reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the guarded expiry transition for a stale retry-pending page", async () => {
    const { store, worker, reconciler } = fixture();
    const retry = {
      action: { id: "series", status: "ACTIVE" },
      occurrence: {
        id: "occurrence",
        status: "RETRY_PENDING",
        retryCount: 2,
        firstAttemptedAt: new Date("2026-01-01T08:00:00.000Z"),
      },
      state: { revision: 0 },
    } as RecurringRuntimeDefinition;
    store.page.mockImplementation((status: string) =>
      Promise.resolve(status === "RETRY_PENDING" ? [retry] : []),
    );
    store.retryWake.mockResolvedValue(undefined);
    await reconciler.recoverAtStartup();
    expect(store.expireRetry).toHaveBeenCalledWith(
      expect.objectContaining({ occurrenceId: "occurrence", expectedRetryCount: 2 }),
    );
    expect(store.retryWake).not.toHaveBeenCalled();
    expect(store.terminalize).not.toHaveBeenCalled();
    expect(worker.project).not.toHaveBeenCalled();
  });

  it.each([
    ["within the lifetime", "2026-01-01T08:50:00.000Z"],
    ["exactly at the deadline", "2026-01-01T08:45:00.000Z"],
  ])("remains conservative with no retry audit %s", async (_label, firstAttemptedAt) => {
    const { store, worker, logger, reconciler } = fixture();
    const retry = {
      action: { id: "series", status: "ACTIVE" },
      occurrence: {
        id: "occurrence",
        status: "RETRY_PENDING",
        retryCount: 1,
        firstAttemptedAt: new Date(firstAttemptedAt),
      },
      state: { revision: 0 },
    } as RecurringRuntimeDefinition;
    store.page.mockImplementation((status: string) =>
      Promise.resolve(status === "RETRY_PENDING" ? [retry] : []),
    );
    store.retryWake.mockResolvedValue(undefined);
    await reconciler.recoverAtStartup();
    expect(store.retryWake).toHaveBeenCalledWith("occurrence", 1);
    expect(logger.warn).toHaveBeenCalledWith(
      { event: "recurring_retry_audit_missing", occurrenceId: "occurrence" },
      "Recurring retry audit is missing",
    );
    expect(store.expireRetry).not.toHaveBeenCalled();
    expect(store.resumeRetry).not.toHaveBeenCalled();
    expect(worker.project).not.toHaveBeenCalled();
  });

  it.each([
    ["within the lifetime", "2026-01-01T09:04:00.000Z", false],
    ["at the inclusive deadline", "2026-01-01T09:05:00.000Z", false],
    ["beyond the lifetime", "2026-01-01T09:05:00.001Z", true],
  ])("uses the recorded retry wake %s", async (_label, wake, expired) => {
    const { store, worker, reconciler } = fixture();
    const retry = {
      action: { id: "series", status: "ACTIVE" },
      occurrence: {
        id: "occurrence",
        status: "RETRY_PENDING",
        retryCount: 1,
        scheduledFor: new Date("2026-01-01T08:50:00.000Z"),
        firstAttemptedAt: new Date("2026-01-01T08:50:00.000Z"),
      },
      state: { revision: 0 },
    } as RecurringRuntimeDefinition;
    store.page.mockImplementation((status: string) =>
      Promise.resolve(status === "RETRY_PENDING" ? [retry] : []),
    );
    const wakeAt = new Date(wake);
    store.retryWake.mockResolvedValue(wakeAt);
    await reconciler.recoverAtStartup();
    expect(store.retryWake).toHaveBeenCalledWith("occurrence", 1);
    if (expired) {
      expect(store.expireRetry).toHaveBeenCalledWith(
        expect.objectContaining({ occurrenceId: "occurrence", expectedRetryCount: 1 }),
      );
      expect(worker.project).not.toHaveBeenCalled();
    } else {
      expect(store.expireRetry).not.toHaveBeenCalled();
      expect(worker.project).toHaveBeenCalledWith({
        delivery: {
          kind: "recurring-message-occurrence",
          scheduledActionId: "series",
          occurrenceId: "occurrence",
          scheduledFor: retry.occurrence.scheduledFor.toISOString(),
          seriesRevision: 0,
          retryCount: 1,
        },
        wakeAt,
      });
    }
  });

  it("does not overlap runtime sweeps while a page read is in progress", async () => {
    vi.useFakeTimers();
    try {
      const { store, reconciler } = fixture();
      let finish!: (value: RecurringRuntimeDefinition[]) => void;
      const pendingPage = new Promise<RecurringRuntimeDefinition[]>((resolve) => {
        finish = resolve;
      });
      store.page.mockImplementation((status: string) =>
        status === "PENDING" ? pendingPage : Promise.resolve([]),
      );
      await reconciler.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.page).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(store.page).toHaveBeenCalledTimes(1);
      finish([]);
      await reconciler.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
