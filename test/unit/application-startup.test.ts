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
    startDiscord: vi.fn(() => Promise.resolve()),
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
  it("starts pg-boss after database verification and Discord after pg-boss", async () => {
    const databaseVerified = createDeferred();
    const pgBossStarted = createDeferred();
    const dependencies = createDependencies();
    vi.mocked(dependencies.verifyDatabaseConnection).mockReturnValue(databaseVerified.promise);
    vi.mocked(dependencies.startPgBoss).mockReturnValue(pgBossStarted.promise);

    const startup = runApplicationStartup(dependencies, createLogger());
    await Promise.resolve();
    expect(dependencies.verifyDatabaseConnection).toHaveBeenCalledOnce();
    expect(dependencies.startPgBoss).not.toHaveBeenCalled();

    databaseVerified.resolve();
    await Promise.resolve();
    expect(dependencies.startPgBoss).toHaveBeenCalledOnce();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();

    pgBossStarted.resolve();
    await startup;

    expect(dependencies.startDiscord).toHaveBeenCalledOnce();
    expect(dependencies.shutdown).not.toHaveBeenCalled();
  });

  it("does not start pg-boss or Discord when database verification fails", async () => {
    const dependencies = createDependencies();
    vi.mocked(dependencies.verifyDatabaseConnection).mockRejectedValue(
      new Error("database unavailable"),
    );

    await runApplicationStartup(dependencies, createLogger());

    expect(dependencies.startPgBoss).not.toHaveBeenCalled();
    expect(dependencies.startDiscord).not.toHaveBeenCalled();
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
    expect(dependencies.startDiscord).not.toHaveBeenCalled();
    expect(dependencies.shutdown).toHaveBeenCalledOnce();
    expect(dependencies.shutdown).toHaveBeenCalledWith("startup_failure");
    expect(logger.error).toHaveBeenCalledWith(
      { event: "startup_failed", errorName: "Error" },
      "Application startup failed",
    );
    expect(process.exitCode).toBe(1);
  });
});
