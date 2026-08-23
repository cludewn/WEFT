import type { ConstructorOptions, StopOptions } from "pg-boss";
import type { Logger } from "pino";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DatabaseConfig } from "../../src/config.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";

const pgBossMock = vi.hoisted(() => ({
  instance: undefined as object | undefined,
  constructorOptions: undefined as ConstructorOptions | undefined,
  listeners: new Map<string, (...args: unknown[]) => void>(),
  start: vi.fn<() => Promise<unknown>>(),
  stop: vi.fn<(options?: StopOptions) => Promise<void>>(),
}));

vi.mock("pg-boss", () => ({
  PgBoss: class {
    constructor(options: ConstructorOptions) {
      pgBossMock.constructorOptions = options;
      pgBossMock.instance = this;
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      pgBossMock.listeners.set(event, listener);
      return this;
    }

    start(): Promise<unknown> {
      return pgBossMock.start();
    }

    stop(options?: StopOptions): Promise<void> {
      return pgBossMock.stop(options);
    }
  },
}));

const databaseConfig: DatabaseConfig = {
  host: "database.internal",
  port: 5432,
  name: "weft",
  user: "weft",
  password: "opaque-password",
  ssl: false,
};

function createLogger(): Logger {
  return { info: vi.fn(), error: vi.fn() } as unknown as Logger;
}

beforeEach(() => {
  pgBossMock.constructorOptions = undefined;
  pgBossMock.instance = undefined;
  pgBossMock.listeners.clear();
  pgBossMock.start.mockReset().mockResolvedValue(undefined);
  pgBossMock.stop.mockReset().mockResolvedValue(undefined);
});

describe("pg-boss runtime", () => {
  it("constructs an independently owned connection from validated database config", () => {
    const runtime = createPgBossRuntime(databaseConfig, createLogger());

    expect(pgBossMock.constructorOptions).toEqual({
      host: "database.internal",
      port: 5432,
      database: "weft",
      user: "weft",
      password: "opaque-password",
      ssl: false,
      application_name: "weft-pg-boss",
      migrate: true,
    });
    expect(pgBossMock.constructorOptions).not.toHaveProperty("db");
    expect(pgBossMock.listeners.has("error")).toBe(true);
    expect(runtime.client).toBe(pgBossMock.instance);
  });

  it("matches the application database SSL semantics", () => {
    createPgBossRuntime({ ...databaseConfig, ssl: true }, createLogger());

    expect(pgBossMock.constructorOptions?.ssl).toEqual({ rejectUnauthorized: true });
  });

  it("starts pg-boss and reports completion", async () => {
    const logger = createLogger();
    const runtime = createPgBossRuntime(databaseConfig, logger);

    await runtime.start();

    expect(pgBossMock.start).toHaveBeenCalledOnce();
    const loggedFields: unknown = (logger.info as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(loggedFields).toMatchObject({ event: "pg_boss_started" });
    expect(typeof (loggedFields as { durationMs?: unknown }).durationMs).toBe("number");
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe(
      "pg-boss startup completed",
    );
  });

  it("rethrows startup failures without logging connection details", async () => {
    const failure = new Error("opaque database failure");
    pgBossMock.start.mockRejectedValue(failure);
    const logger = createLogger();
    const runtime = createPgBossRuntime(databaseConfig, logger);

    await expect(runtime.start()).rejects.toBe(failure);

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "pg_boss_start_failed", errorName: "Error" }),
      "pg-boss startup failed",
    );
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      databaseConfig.password,
    );
  });

  it("delegates cleanup after a partial startup failure without duplicating lifecycle state", async () => {
    pgBossMock.start.mockRejectedValue(new Error("partial startup failure"));
    const runtime = createPgBossRuntime(databaseConfig, createLogger());

    await expect(runtime.start()).rejects.toThrow("partial startup failure");
    await runtime.stop();

    expect(pgBossMock.stop).toHaveBeenCalledWith({ close: true });
  });

  it("waits for stop to close the pg-boss-owned pool", async () => {
    let finishStop: (() => void) | undefined;
    pgBossMock.stop.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishStop = resolve;
        }),
    );
    const logger = createLogger();
    const runtime = createPgBossRuntime(databaseConfig, logger);

    const stopping = runtime.stop();
    await Promise.resolve();
    expect(logger.info).toHaveBeenCalledTimes(1);

    finishStop?.();
    await stopping;
    expect(pgBossMock.stop).toHaveBeenCalledWith({ close: true });
    const loggedFields: unknown = (logger.info as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0];
    expect(loggedFields).toMatchObject({ event: "pg_boss_stopped" });
    expect(typeof (loggedFields as { durationMs?: unknown }).durationMs).toBe("number");
    expect((logger.info as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1]).toBe(
      "pg-boss shutdown completed",
    );
  });

  it("logs runtime errors without raw error details", () => {
    const logger = createLogger();
    createPgBossRuntime(databaseConfig, logger);

    pgBossMock.listeners.get("error")?.(new Error("sensitive connection detail"));

    expect(logger.error).toHaveBeenCalledWith(
      { event: "pg_boss_runtime_error", errorName: "Error" },
      "pg-boss runtime error",
    );
    expect(JSON.stringify((logger.error as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "sensitive connection detail",
    );
  });
});
