import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type ApplicationStartupDependencies,
  runApplicationStartup,
} from "../../src/application-startup.js";

function createLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function createDependencies(): ApplicationStartupDependencies {
  return {
    verifyDatabaseConnection: vi.fn(() => Promise.resolve()),
    startPgBoss: vi.fn(() => Promise.resolve()),
    ensureScheduledThreadCloseQueue: vi.fn(() => Promise.resolve()),
    recoverScheduledThreadCloseDeliveries: vi.fn(() => Promise.resolve()),
    startDiscord: vi.fn(() => Promise.resolve()),
    startScheduledThreadCloseWorkers: vi.fn(() => Promise.resolve()),
    shutdown: vi.fn(() => Promise.resolve()),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve: () => resolve?.() };
}

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("application startup", () => {
  it("recovers scheduled deliveries before Discord and workers", async () => {
    const databaseVerified = createDeferred();
    const pgBossStarted = createDeferred();
    const queueReady = createDeferred();
    const recoveryCompleted = createDeferred();
    const discordStarted = createDeferred();
    const dependencies = createDependencies();
    vi.mocked(dependencies.verifyDatabaseConnection).mockReturnValue(databaseVerified.promise);
    vi.mocked(dependencies.startPgBoss).mockReturnValue(pgBossStarted.promise);
    vi.mocked(dependencies.ensureScheduledThreadCloseQueue).mockReturnValue(queueReady.promise);
    vi.mocked(dependencies.recoverScheduledThreadCloseDeliveries).mockReturnValue(
      recoveryCompleted.promise,
    );
    vi.mocked(dependencies.startDiscord).mockReturnValue(discordStarted.promise);

    const startup = runApplicationStartup(dependencies, createLogger());
    await Promise.resolve();
    expect(dependencies.verifyDatabaseConnection).toHaveBeenCalledOnce();
    expect(dependencies.startPgBoss).not.toHaveBeenCalled();

    databaseVerified.resolve();
    await Promise.resolve();
    expect(dependencies.startPgBoss).toHaveBeenCalledOnce();
    expect(dependencies.ensureScheduledThreadCloseQueue).not.toHaveBeenCalled();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).not.toHaveBeenCalled();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();

    pgBossStarted.resolve();
    await Promise.resolve();
    expect(dependencies.ensureScheduledThreadCloseQueue).toHaveBeenCalledOnce();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).not.toHaveBeenCalled();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();

    queueReady.resolve();
    await Promise.resolve();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).toHaveBeenCalledOnce();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();

    recoveryCompleted.resolve();
    await Promise.resolve();
    expect(dependencies.startDiscord).toHaveBeenCalledOnce();
    expect(dependencies.startScheduledThreadCloseWorkers).not.toHaveBeenCalled();

    discordStarted.resolve();
    await startup;

    expect(dependencies.startScheduledThreadCloseWorkers).toHaveBeenCalledOnce();
    expect(dependencies.shutdown).not.toHaveBeenCalled();
  });

  it("does not start pg-boss or Discord when database verification fails", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.verifyDatabaseConnection).mockRejectedValue(
      new Error("database unavailable"),
    );

    await runApplicationStartup(dependencies, createLogger());

    expect(dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(dependencies.ensureScheduledThreadCloseQueue).not.toHaveBeenCalled();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).not.toHaveBeenCalled();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();
    expect(dependencies.startScheduledThreadCloseWorkers).not.toHaveBeenCalled();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(process.exitCode).toBe(1);
  });

  it("treats pg-boss startup failure as fatal and runs shutdown cleanup", async () => {
    const failure = new Error("pg-boss unavailable");
    const dependencies = createDependencies();
    vi.mocked(dependencies.startPgBoss).mockRejectedValue(failure);
    const logger = createLogger();

    await runApplicationStartup(dependencies, logger);

    expect(dependencies.verifyDatabaseConnection).toHaveBeenCalledOnce();
    expect(dependencies.ensureScheduledThreadCloseQueue).not.toHaveBeenCalled();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).not.toHaveBeenCalled();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();
    expect(dependencies.startScheduledThreadCloseWorkers).not.toHaveBeenCalled();
    expect(dependencies.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(logger.error).toHaveBeenCalledWith(
      { event: "startup_failed", errorName: "Error" },
      "Application startup failed",
    );
    expect(process.exitCode).toBe(1);
  });

  it("treats queue creation failure as fatal before Discord startup", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.ensureScheduledThreadCloseQueue).mockRejectedValue(
      new Error("queue unavailable"),
    );

    await runApplicationStartup(dependencies, createLogger());

    expect(dependencies.startDiscord).not.toHaveBeenCalled();
    expect(dependencies.recoverScheduledThreadCloseDeliveries).not.toHaveBeenCalled();
    expect(dependencies.startScheduledThreadCloseWorkers).not.toHaveBeenCalled();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(process.exitCode).toBe(1);
  });

  it("treats startup recovery failure as fatal before Discord and workers", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.recoverScheduledThreadCloseDeliveries).mockRejectedValue(
      new Error("recovery unavailable"),
    );

    await runApplicationStartup(dependencies, createLogger());

    expect(dependencies.startDiscord).not.toHaveBeenCalled();
    expect(dependencies.startScheduledThreadCloseWorkers).not.toHaveBeenCalled();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(process.exitCode).toBe(1);
  });

  it("treats worker registration failure as fatal after Discord startup", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.startScheduledThreadCloseWorkers).mockRejectedValue(
      new Error("worker unavailable"),
    );

    await runApplicationStartup(dependencies, createLogger());

    expect(dependencies.startDiscord).toHaveBeenCalledOnce();
    expect(dependencies.startScheduledThreadCloseWorkers).toHaveBeenCalledOnce();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(process.exitCode).toBe(1);
  });
});
