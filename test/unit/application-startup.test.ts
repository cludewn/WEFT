import { describe, expect, it, vi } from "vitest";

import {
  createApplicationRuntime,
  type ApplicationRuntimeDependencies,
} from "../../src/application-runtime.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

const startupSteps = [
  "verifyDatabaseConnection",
  "startPgBoss",
  "ensureScheduledThreadCloseQueue",
  "ensureScheduledMessageQueue",
  "ensureRecurringMessageQueue",
  "recoverScheduledThreadCloseDeliveries",
  "recoverScheduledMessageDeliveries",
  "recoverRecurringMessageDeliveries",
  "startDiscord",
  "startScheduledThreadCloseWorkers",
  "startScheduledMessageWorker",
  "startRecurringMessageWorker",
  "startScheduledThreadCloseRuntimeReconciliation",
  "startScheduledMessageRuntimeReconciliation",
  "startRecurringMessageRuntimeReconciliation",
  "reconcileAutomaticCloseBaselines",
  "startAutomaticCloseRuntime",
] as const satisfies readonly (keyof ApplicationRuntimeDependencies)[];

const partialStartupFailures = [
  ["database verification", "verifyDatabaseConnection", "database_verify"],
  ["pg-boss start", "startPgBoss", "pg_boss_start"],
  ["queue validation", "ensureScheduledThreadCloseQueue", "queue_validation"],
  ["startup recovery", "recoverScheduledThreadCloseDeliveries", "startup_recovery"],
  ["Discord readiness", "startDiscord", "discord_login"],
  ["worker registration", "startScheduledThreadCloseWorkers", "worker_start"],
  ["reconciler scheduling", "startScheduledThreadCloseRuntimeReconciliation", "reconciler_start"],
  ["automatic-close start", "startAutomaticCloseRuntime", "automatic_close_start"],
] as const satisfies readonly (readonly [string, (typeof startupSteps)[number], string])[];

function dependencies(): ApplicationRuntimeDependencies {
  const resolved = () => Promise.resolve();
  return {
    verifyDatabaseConnection: vi.fn(resolved),
    startPgBoss: vi.fn(resolved),
    ensureScheduledThreadCloseQueue: vi.fn(resolved),
    ensureScheduledMessageQueue: vi.fn(resolved),
    ensureRecurringMessageQueue: vi.fn(resolved),
    recoverScheduledThreadCloseDeliveries: vi.fn(resolved),
    recoverScheduledMessageDeliveries: vi.fn(resolved),
    recoverRecurringMessageDeliveries: vi.fn(resolved),
    startDiscord: vi.fn(resolved),
    startScheduledThreadCloseWorkers: vi.fn(resolved),
    startScheduledMessageWorker: vi.fn(resolved),
    startRecurringMessageWorker: vi.fn(resolved),
    startScheduledThreadCloseRuntimeReconciliation: vi.fn(resolved),
    startScheduledMessageRuntimeReconciliation: vi.fn(resolved),
    startRecurringMessageRuntimeReconciliation: vi.fn(resolved),
    reconcileAutomaticCloseBaselines: vi.fn(resolved),
    startAutomaticCloseRuntime: vi.fn(resolved),
    quiesce: [],
    drainThreadLifecycle: vi.fn(resolved),
    stopPgBoss: vi.fn(resolved),
    destroyDiscord: vi.fn(resolved),
    closeDatabase: vi.fn(resolved),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    processControl: { setExitCode: vi.fn(), forceExit: vi.fn(), writeStderr: vi.fn() },
  };
}

describe("startup serialization", () => {
  it.each(startupSteps)(
    "does not race cleanup or continue after shutdown during %s",
    async (key) => {
      const active = deferred();
      const values = dependencies();
      const activeStep = vi.fn(() => active.promise);
      Object.assign(values, { [key]: activeStep });
      const runtime = createApplicationRuntime(values);
      const startup = runtime.start();
      await vi.waitFor(() => expect(activeStep).toHaveBeenCalledOnce());

      const shutdown = runtime.shutdown("SIGTERM");
      await Promise.resolve();
      expect(values.stopPgBoss).not.toHaveBeenCalled();
      const nextIndex = startupSteps.indexOf(key) + 1;
      if (nextIndex < startupSteps.length) {
        expect(values[startupSteps[nextIndex]!]).not.toHaveBeenCalled();
      }

      active.resolve();
      await Promise.all([startup, shutdown]);
      expect(values.stopPgBoss).toHaveBeenCalledOnce();
      expect(values.destroyDiscord).toHaveBeenCalledOnce();
      expect(values.closeDatabase).toHaveBeenCalledOnce();
    },
  );

  it.each(partialStartupFailures)(
    "cleans up once and preserves the primary %s failure",
    async (_label, key, startupStep) => {
      const values = dependencies();
      const failure = new TypeError("private startup failure detail");
      const firstProducerStop = vi.fn(() => Promise.resolve());
      const secondProducerStop = vi.fn(() => Promise.resolve());
      const failedStep = vi.fn(() => Promise.reject(failure));
      Object.assign(values, {
        [key]: failedStep,
        quiesce: [
          { name: "first-producer", stop: firstProducerStop },
          { name: "second-producer", stop: secondProducerStop },
        ],
      });
      const runtime = createApplicationRuntime(values);

      await expect(runtime.start()).rejects.toBe(failure);

      expect(failedStep).toHaveBeenCalledOnce();
      for (const laterStep of startupSteps.slice(startupSteps.indexOf(key) + 1)) {
        expect(values[laterStep]).not.toHaveBeenCalled();
      }
      expect(firstProducerStop).toHaveBeenCalledOnce();
      expect(secondProducerStop).toHaveBeenCalledOnce();
      expect(values.drainThreadLifecycle).toHaveBeenCalledOnce();
      expect(values.stopPgBoss).toHaveBeenCalledOnce();
      expect(values.destroyDiscord).toHaveBeenCalledOnce();
      expect(values.closeDatabase).toHaveBeenCalledOnce();
      expect(values.logger.error).toHaveBeenCalledWith(
        { event: "startup_step_failed", startupStep, errorName: "TypeError" },
        "Application startup failed",
      );
      expect(JSON.stringify(vi.mocked(values.logger.error).mock.calls)).not.toContain(
        "private startup failure detail",
      );
      expect(values.processControl?.setExitCode).toHaveBeenCalledWith(1);
      expect(values.processControl?.setExitCode).not.toHaveBeenCalledWith(0);

      await runtime.shutdown("startup_failure");
      expect(firstProducerStop).toHaveBeenCalledOnce();
      expect(secondProducerStop).toHaveBeenCalledOnce();
      expect(values.drainThreadLifecycle).toHaveBeenCalledOnce();
      expect(values.stopPgBoss).toHaveBeenCalledOnce();
      expect(values.destroyDiscord).toHaveBeenCalledOnce();
      expect(values.closeDatabase).toHaveBeenCalledOnce();
    },
  );

  it("keeps automatic-close baseline failure best-effort", async () => {
    const values = dependencies();
    const failure = new Error("private baseline detail");
    vi.mocked(values.reconcileAutomaticCloseBaselines).mockRejectedValue(failure);
    const runtime = createApplicationRuntime(values);

    await runtime.start();

    expect(runtime.getState()).toBe("READY");
    expect(values.startAutomaticCloseRuntime).toHaveBeenCalledOnce();
    expect(values.logger.warn).toHaveBeenCalledWith(
      { event: "automatic_close_baseline_reconciliation_failed", errorName: "Error" },
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(values.logger.warn).mock.calls)).not.toContain(
      "private baseline detail",
    );
  });
});
