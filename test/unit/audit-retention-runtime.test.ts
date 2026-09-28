import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_RETENTION_SOURCES,
  type AuditRetentionStore,
} from "../../src/audit-retention-persistence.js";
import {
  AUDIT_RETENTION_BATCH_SIZE,
  AUDIT_RETENTION_DURATION_MS,
  AUDIT_RETENTION_SWEEP_INTERVAL_MS,
  createAuditRetentionRuntime,
} from "../../src/audit-retention-runtime.js";

function deferred() {
  let resolve!: (count: number) => void;
  const promise = new Promise<number>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(now = () => new Date("2030-04-01T12:00:00.000Z")) {
  const persistence: AuditRetentionStore = {
    deleteExpiredBatch: vi.fn(() => Promise.resolve(0)),
  };
  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
  return {
    persistence,
    logger,
    runtime: createAuditRetentionRuntime({ persistence, logger, now }),
  };
}

afterEach(() => vi.useRealTimers());

describe("audit retention runtime", () => {
  it("shares one fixed 90-day cutoff across all six sources and every batch", async () => {
    const current = new Date("2030-04-01T12:00:00.000Z");
    const now = vi.fn(() => current);
    const { runtime, persistence } = fixture(now);
    const calls = new Map<string, number>();
    vi.mocked(persistence.deleteExpiredBatch).mockImplementation((source) => {
      const count = calls.get(source) ?? 0;
      calls.set(source, count + 1);
      return Promise.resolve(count === 0 ? 1 : 0);
    });
    await runtime.sweepOnce();
    expect(now).toHaveBeenCalledOnce();
    expect([...calls.keys()]).toEqual([...AUDIT_RETENTION_SOURCES]);
    expect([...calls.values()]).toEqual(Array(6).fill(2));
    const cutoff = new Date(current.getTime() - AUDIT_RETENTION_DURATION_MS);
    for (const [source, actualCutoff, limit] of vi.mocked(persistence.deleteExpiredBatch).mock
      .calls) {
      expect(AUDIT_RETENTION_SOURCES).toContain(source);
      expect(actualCutoff).toEqual(cutoff);
      expect(limit).toBe(AUDIT_RETENTION_BATCH_SIZE);
    }
  });

  it("isolates a source failure, logs only its safe error name, and remains usable", async () => {
    const { runtime, persistence, logger } = fixture();
    vi.mocked(persistence.deleteExpiredBatch).mockImplementation((source) =>
      source === "scheduled_thread_close_audits"
        ? Promise.reject(new TypeError("private SQL or credential detail"))
        : Promise.resolve(0),
    );
    await runtime.sweepOnce();
    expect(vi.mocked(persistence.deleteExpiredBatch).mock.calls.map(([source]) => source)).toEqual([
      ...AUDIT_RETENTION_SOURCES,
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "audit_retention_source_cleanup_failed",
        source: "scheduled_thread_close_audits",
        errorName: "TypeError",
      }),
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain("private SQL");
    await runtime.sweepOnce();
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledTimes(12);
  });

  it("starts asynchronously, shares in-flight work, and waits 24 hours after settlement", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const { runtime, persistence } = fixture();
    vi.mocked(persistence.deleteExpiredBatch).mockImplementationOnce(() => pending.promise);
    await runtime.start();
    expect(persistence.deleteExpiredBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledOnce();
    const first = runtime.sweepOnce();
    const second = runtime.sweepOnce();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(AUDIT_RETENTION_SWEEP_INTERVAL_MS);
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledOnce();
    pending.resolve(0);
    await first;
    await vi.advanceTimersByTimeAsync(AUDIT_RETENTION_SWEEP_INTERVAL_MS - 1);
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(persistence.deleteExpiredBatch).toHaveBeenCalledTimes(12);
    await runtime.stop();
  });

  it("cancels the initial timer and drains an active statement without another batch", async () => {
    vi.useFakeTimers();
    const beforeStart = fixture();
    await beforeStart.runtime.start();
    await beforeStart.runtime.stop();
    await vi.runAllTimersAsync();
    expect(beforeStart.persistence.deleteExpiredBatch).not.toHaveBeenCalled();

    const pending = deferred();
    const active = fixture();
    vi.mocked(active.persistence.deleteExpiredBatch).mockImplementationOnce(() => pending.promise);
    const sweep = active.runtime.sweepOnce();
    const stop = active.runtime.stop();
    expect(active.runtime.stop()).toBe(stop);
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    pending.resolve(1);
    await Promise.all([sweep, stop]);
    expect(active.persistence.deleteExpiredBatch).toHaveBeenCalledOnce();
    expect(stopped).toBe(true);
  });
});
