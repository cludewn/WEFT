import { describe, expect, it, vi } from "vitest";

import {
  createApplicationRuntime,
  type ApplicationRuntimeDependencies,
} from "../../src/application-runtime.js";

function createDependencies(calls: string[], now: () => number): ApplicationRuntimeDependencies {
  const step = () => Promise.resolve();
  return {
    startHealthListener: step,
    quiesceHealth: () => {},
    drainHealth: step,
    verifyDatabaseConnection: step,
    startPgBoss: step,
    ensureScheduledThreadCloseQueue: step,
    ensureScheduledMessageQueue: step,
    ensureRecurringMessageQueue: step,
    recoverScheduledThreadCloseDeliveries: step,
    recoverScheduledMessageDeliveries: step,
    recoverRecurringMessageDeliveries: step,
    startDiscord: step,
    startScheduledThreadCloseWorkers: step,
    startScheduledMessageWorker: step,
    startRecurringMessageWorker: step,
    startScheduledThreadCloseRuntimeReconciliation: step,
    startScheduledMessageRuntimeReconciliation: step,
    startRecurringMessageRuntimeReconciliation: step,
    reconcileAutomaticCloseBaselines: step,
    startAutomaticCloseRuntime: step,
    quiesce: [
      {
        name: "workers",
        stop: () => {
          calls.push("quiesce");
        },
      },
    ],
    drainThreadLifecycle: () => {
      calls.push("thread-drain");
      return Promise.resolve();
    },
    drainAuditNotifications: () => {
      calls.push("notification-drain");
      return Promise.resolve();
    },
    stopPgBoss: (remainingMs) => {
      calls.push(`boss:${remainingMs}`);
      return Promise.resolve();
    },
    destroyDiscord: vi.fn(() => {
      calls.push("discord");
    }),
    closeDatabase: vi.fn(() => {
      calls.push("database");
      return Promise.resolve();
    }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processControl: { setExitCode: vi.fn(), forceExit: vi.fn(), writeStderr: vi.fn() },
    now,
  };
}

describe("shutdown ordering", () => {
  it("passes only the remaining process-wide budget to pg-boss", async () => {
    let currentTime = 1_000;
    const calls: string[] = [];
    const values = createDependencies(calls, () => currentTime);
    values.drainThreadLifecycle = () => {
      calls.push("thread-drain");
      currentTime += 12_345;
      return Promise.resolve();
    };
    const runtime = createApplicationRuntime(values);
    await runtime.start();

    await runtime.shutdown("SIGTERM");

    expect(values.processControl?.setExitCode).toHaveBeenCalledWith(0);
    expect(calls).toEqual([
      "quiesce",
      "thread-drain",
      "notification-drain",
      "boss:17655",
      "discord",
      "database",
    ]);
  });

  it("continues closing later resources and selects non-zero after cleanup failure", async () => {
    const calls: string[] = [];
    const values = createDependencies(calls, () => 1_000);
    values.stopPgBoss = () => Promise.reject(new TypeError("private failure"));
    const runtime = createApplicationRuntime(values);
    await runtime.start();

    await expect(runtime.shutdown("SIGINT")).rejects.toBeInstanceOf(AggregateError);

    expect(values.destroyDiscord).toHaveBeenCalledOnce();
    expect(values.closeDatabase).toHaveBeenCalledOnce();
    expect(values.processControl?.setExitCode).toHaveBeenCalledWith(1);
    expect(values.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "resource_cleanup_failed",
        resource: "pg-boss",
        errorName: "TypeError",
      }),
      expect.any(String),
    );
  });
});
