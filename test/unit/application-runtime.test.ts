import type { Logger } from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApplicationRuntime,
  type ApplicationRuntimeDependencies,
  SHUTDOWN_TIMEOUT_MS,
  ShutdownTimeoutError,
} from "../../src/application-runtime.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createFixture(overrides: Partial<ApplicationRuntimeDependencies> = {}) {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve();
    });
  const logger = {
    info: vi.fn((fields: { event?: string }) => calls.push(fields.event ?? "info")),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const processControl = {
    setExitCode: vi.fn(),
    forceExit: vi.fn(),
    writeStderr: vi.fn(),
  };
  const dependencies: ApplicationRuntimeDependencies = {
    startHealthListener: step("health-listener"),
    quiesceHealth: vi.fn(() => calls.push("health-quiesce")),
    drainHealth: step("health-drain"),
    verifyDatabaseConnection: step("database"),
    startPgBoss: step("boss"),
    ensureScheduledThreadCloseQueue: step("thread-queue"),
    ensureScheduledMessageQueue: step("message-queue"),
    ensureRecurringMessageQueue: step("recurring-queue"),
    recoverScheduledThreadCloseDeliveries: step("thread-recovery"),
    recoverScheduledMessageDeliveries: step("message-recovery"),
    recoverRecurringMessageDeliveries: step("recurring-recovery"),
    startDiscord: step("discord-ready"),
    startScheduledThreadCloseWorkers: step("thread-workers"),
    startScheduledMessageWorker: step("message-workers"),
    startRecurringMessageWorker: step("recurring-workers"),
    startScheduledThreadCloseRuntimeReconciliation: step("thread-reconciler"),
    startScheduledMessageRuntimeReconciliation: step("message-reconciler"),
    startRecurringMessageRuntimeReconciliation: step("recurring-reconciler"),
    reconcileAutomaticCloseBaselines: step("automatic-baseline"),
    startAutomaticCloseRuntime: step("automatic-runtime"),
    quiesce: [],
    drainThreadLifecycle: step("thread-drain"),
    drainAuditNotifications: step("audit-drain"),
    stopPgBoss: vi.fn((remainingMs: number) => {
      calls.push(`boss-stop:${remainingMs}`);
      return Promise.resolve();
    }),
    destroyDiscord: step("discord-destroy"),
    closeDatabase: step("database-close"),
    logger,
    processControl,
    ...overrides,
  };
  return {
    runtime: createApplicationRuntime(dependencies),
    dependencies,
    calls,
    logger,
    processControl,
  };
}

afterEach(() => vi.useRealTimers());

describe("application runtime", () => {
  it("opens READY ingress only after the exact startup sequence", async () => {
    const fixture = createFixture();
    const service = vi.fn(() => Promise.resolve("accepted"));

    expect(fixture.runtime.ingress.run(service)).toBeUndefined();
    await fixture.runtime.start();
    await expect(fixture.runtime.ingress.run(service)).resolves.toBe("accepted");

    expect(fixture.runtime.getState()).toBe("READY");
    expect(fixture.calls).toEqual([
      "startup_started",
      "health-listener",
      "database",
      "boss",
      "thread-queue",
      "message-queue",
      "recurring-queue",
      "thread-recovery",
      "message-recovery",
      "recurring-recovery",
      "discord-ready",
      "thread-workers",
      "message-workers",
      "recurring-workers",
      "thread-reconciler",
      "message-reconciler",
      "recurring-reconciler",
      "automatic-baseline",
      "automatic-runtime",
      "application_ready",
    ]);
  });

  it("closes ingress synchronously, quiesces every producer, then drains", async () => {
    const firstStop = deferred();
    const secondStop = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesce: [
        {
          name: "first",
          stop: () => {
            calls.push("stop-first");
            return firstStop.promise;
          },
        },
        {
          name: "second",
          stop: () => {
            calls.push("stop-second");
            return secondStop.promise;
          },
        },
      ],
      drainThreadLifecycle: () => {
        calls.push("drain-thread");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");

    expect(fixture.runtime.getState()).toBe("SHUTTING_DOWN");
    expect(fixture.runtime.ingress.run(vi.fn())).toBeUndefined();
    expect(calls).toEqual(["stop-first", "stop-second"]);
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();

    firstStop.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["stop-first", "stop-second"]);
    secondStop.resolve();
    await vi.waitFor(() => expect(calls).toContain("drain-thread"));
    await shutdown;
    expect(fixture.runtime.getState()).toBe("STOPPED");
    expect(fixture.dependencies.stopPgBoss).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("does not tear down an active startup step or begin the next step", async () => {
    const database = deferred();
    const fixture = createFixture({ verifyDatabaseConnection: () => database.promise });
    const startup = fixture.runtime.start();
    await Promise.resolve();
    const shutdown = fixture.runtime.shutdown("SIGINT");

    expect(fixture.dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    database.resolve();
    await Promise.all([startup, shutdown]);

    expect(fixture.dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
  });

  it("tracks admitted handlers until settlement before closing Discord and PostgreSQL", async () => {
    const admitted = deferred();
    const fixture = createFixture();
    await fixture.runtime.start();
    const operation = fixture.runtime.ingress.run(() => admitted.promise);
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();

    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
    admitted.resolve();
    await operation;
    await shutdown;
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("drains retained thread work created late by an already-admitted handler", async () => {
    const enterThreadLifecycle = deferred();
    const rawMutation = deferred();
    const finalization = deferred();
    let rawActive = false;
    let finalizationActive = false;
    let logicalOperation: Promise<void> | undefined;
    const drainThreadLifecycle = vi.fn(async () => {
      await logicalOperation;
    });
    const fixture = createFixture({ drainThreadLifecycle });
    await fixture.runtime.start();

    const handler = fixture.runtime.ingress.run(async () => {
      await enterThreadLifecycle.promise;
      rawActive = true;
      logicalOperation = rawMutation.promise
        .then(() => {
          rawActive = false;
          finalizationActive = true;
          return finalization.promise;
        })
        .then(() => {
          finalizationActive = false;
        });
      return { ok: false, pending: true } as const;
    });
    expect(logicalOperation).toBeUndefined();

    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();
    expect(drainThreadLifecycle).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    enterThreadLifecycle.resolve();
    await expect(handler).resolves.toEqual({ ok: false, pending: true });
    await vi.waitFor(() => expect(drainThreadLifecycle).toHaveBeenCalledOnce());
    expect(rawActive).toBe(true);
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    rawMutation.resolve();
    await vi.waitFor(() => expect(finalizationActive).toBe(true));
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    finalization.resolve();
    await shutdown;
    expect(finalizationActive).toBe(false);
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("keeps Discord and PostgreSQL available while retained thread-lifecycle work drains", async () => {
    const retained = deferred();
    const fixture = createFixture({ drainThreadLifecycle: () => retained.promise });
    await fixture.runtime.start();

    const shutdown = fixture.runtime.shutdown("SIGTERM");
    await Promise.resolve();
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();

    retained.resolve();
    await shutdown;
    expect(fixture.dependencies.stopPgBoss).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).toHaveBeenCalledOnce();
    expect(fixture.dependencies.closeDatabase).toHaveBeenCalledOnce();
  });

  it("drains late accepted notification delivery after source and thread work, before Discord and DB close", async () => {
    const worker = deferred();
    const thread = deferred();
    const delivery = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesce: [
        {
          name: "worker",
          stop: () => {
            calls.push("worker-stop");
            return worker.promise;
          },
        },
      ],
      drainThreadLifecycle: () => {
        calls.push("thread-drain");
        return thread.promise;
      },
      drainAuditNotifications: () => {
        calls.push("notification-drain");
        return delivery.promise;
      },
      destroyDiscord: () => {
        calls.push("discord-destroy");
      },
      closeDatabase: () => {
        calls.push("database-close");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["worker-stop"]);
    worker.resolve();
    await vi.waitFor(() => expect(calls).toContain("thread-drain"));
    expect(calls).not.toContain("notification-drain");
    thread.resolve();
    await vi.waitFor(() => expect(calls).toContain("notification-drain"));
    expect(calls).not.toContain("discord-destroy");
    expect(calls).not.toContain("database-close");
    delivery.resolve();
    await shutdown;
    expect(calls).toEqual([
      "worker-stop",
      "thread-drain",
      "notification-drain",
      "discord-destroy",
      "database-close",
    ]);
  });

  it("starts health quiescence synchronously but drains it after retained thread work", async () => {
    const retained = deferred();
    const health = deferred();
    const calls: string[] = [];
    const fixture = createFixture({
      quiesceHealth: () => {
        calls.push("health-quiesce");
      },
      drainThreadLifecycle: () => {
        calls.push("thread-drain");
        return retained.promise;
      },
      drainHealth: () => {
        calls.push("health-drain");
        return health.promise;
      },
      stopPgBoss: () => {
        calls.push("boss-stop");
        return Promise.resolve();
      },
      closeDatabase: () => {
        calls.push("database-close");
        return Promise.resolve();
      },
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    expect(calls).toEqual(["health-quiesce"]);
    await vi.waitFor(() => expect(calls).toContain("thread-drain"));
    expect(calls).not.toContain("health-drain");
    retained.resolve();
    await vi.waitFor(() => expect(calls).toContain("health-drain"));
    expect(calls).not.toContain("boss-stop");
    health.resolve();
    await shutdown;
    expect(calls).toEqual([
      "health-quiesce",
      "thread-drain",
      "health-drain",
      "boss-stop",
      "database-close",
    ]);
  });

  it("uses only the existing shared deadline for notification drain", async () => {
    vi.useFakeTimers();
    const setTimer = vi.fn(setTimeout);
    const fixture = createFixture({
      drainAuditNotifications: () => new Promise<void>(() => undefined),
      setTimer,
    });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    const timedOut = expect(shutdown).rejects.toBeInstanceOf(ShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await timedOut;
    expect(setTimer).toHaveBeenCalledOnce();
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
  });

  it("uses the shared deadline when a physical health probe never drains", async () => {
    vi.useFakeTimers();
    const fixture = createFixture({ drainHealth: () => new Promise<void>(() => undefined) });
    await fixture.runtime.start();
    const shutdown = fixture.runtime.shutdown("SIGTERM");
    const assertion = expect(shutdown).rejects.toBeInstanceOf(ShutdownTimeoutError);
    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await assertion;
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.dependencies.stopPgBoss).not.toHaveBeenCalled();
    expect(fixture.dependencies.closeDatabase).not.toHaveBeenCalled();
  });

  it("uses one 30-second deadline and forces a sanitized non-zero timeout", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const first = fixture.runtime.shutdown("SIGTERM");
    const second = fixture.runtime.shutdown("SIGINT");
    expect(second).toBe(first);
    const timedOut = expect(first).rejects.toBeInstanceOf(ShutdownTimeoutError);

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await timedOut;
    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "shutdown_timed_out", shutdownReason: "SIGTERM" },
      expect.any(String),
    );
    expect(fixture.dependencies.destroyDiscord).not.toHaveBeenCalled();
  });

  it("keeps the startup failure primary when cleanup also fails", async () => {
    const primary = new TypeError("private startup detail");
    const fixture = createFixture({
      startPgBoss: () => Promise.reject(primary),
      closeDatabase: () => Promise.reject(new Error("private cleanup detail")),
    });

    await expect(fixture.runtime.start()).rejects.toBe(primary);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "startup_step_failed", startupStep: "pg_boss_start", errorName: "TypeError" },
      expect.any(String),
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "resource_cleanup_failed", resource: "database" }),
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(fixture.logger.error).mock.calls)).not.toContain(
      "private startup detail",
    );
  });

  it("latches fatal events and forces exit on the second fatal", async () => {
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const first = fixture.runtime.handleFatal("unhandledRejection", new RangeError("secret"));

    expect(fixture.runtime.getState()).toBe("SHUTTING_DOWN");
    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "fatal_runtime_failure", origin: "unhandledRejection", errorName: "RangeError" },
      expect.any(String),
    );
    await fixture.runtime.handleFatal("uncaughtException", new Error("second"));
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    void first.catch(() => undefined);
  });

  it("escalates a fatal event during normal shutdown without resetting the shared deadline", async () => {
    vi.useFakeTimers();
    const never = new Promise<void>(() => undefined);
    const fixture = createFixture({ quiesce: [{ name: "worker", stop: () => never }] });
    await fixture.runtime.start();
    const normal = fixture.runtime.shutdown("SIGTERM");
    const fatal = fixture.runtime.handleFatal("uncaughtException", new Error("private"));
    const normalTimeout = expect(normal).rejects.toBeInstanceOf(ShutdownTimeoutError);
    const fatalTimeout = expect(fatal).rejects.toBeInstanceOf(ShutdownTimeoutError);

    await vi.advanceTimersByTimeAsync(SHUTDOWN_TIMEOUT_MS);
    await Promise.all([normalTimeout, fatalTimeout]);

    expect(fixture.processControl.setExitCode).toHaveBeenCalledWith(1);
    expect(fixture.processControl.forceExit).toHaveBeenCalledWith(1);
    expect(fixture.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "fatal_runtime_failure", origin: "uncaughtException" }),
      expect.any(String),
    );
    expect(fixture.logger.error).toHaveBeenCalledWith(
      { event: "shutdown_timed_out", shutdownReason: "SIGTERM" },
      expect.any(String),
    );
  });

  it("uses fixed stderr when fatal structured logging fails", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.logger.error).mockImplementation(() => {
      throw new Error("logger failed");
    });

    await fixture.runtime.handleFatal("uncaughtException", new Error("secret"));
    expect(fixture.processControl.writeStderr).toHaveBeenCalledWith(
      '{"event":"fatal_runtime_failure","logging":"failed"}\n',
    );
  });
});
