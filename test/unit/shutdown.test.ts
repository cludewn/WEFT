import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createShutdown } from "../../src/shutdown.js";

function createLogger(): Logger {
  return {
    info: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

describe("createShutdown", () => {
  it("closes resources only once when shutdown is requested repeatedly", async () => {
    const closeResources = vi.fn(() => Promise.resolve());
    const shutdown = createShutdown([{ name: "database", close: closeResources }], createLogger());

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(closeResources).toHaveBeenCalledOnce();
  });

  it("propagates resource cleanup failures", async () => {
    const failure = new Error("cleanup failed");
    const shutdown = createShutdown(
      [{ name: "database", close: async () => Promise.reject(failure) }],
      createLogger(),
    );

    await expect(shutdown("SIGTERM")).rejects.toEqual(
      expect.objectContaining({ errors: [failure] }),
    );
  });

  it("drains scheduled workers before pg-boss, Discord, and the database", async () => {
    const calls: string[] = [];
    const pgBossFailure = new Error("pg-boss shutdown failed");
    const shutdown = createShutdown(
      [
        {
          name: "scheduled-thread-close-workers",
          close: () => {
            calls.push("scheduled-thread-close-workers");
          },
        },
        {
          name: "pg-boss",
          close: () => {
            calls.push("pg-boss");
            throw pgBossFailure;
          },
        },
        {
          name: "discord",
          close: () => {
            calls.push("discord");
          },
        },
        {
          name: "database",
          close: () => {
            calls.push("database");
          },
        },
      ],
      createLogger(),
    );

    await expect(shutdown("SIGTERM")).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(["scheduled-thread-close-workers", "pg-boss", "discord", "database"]);
  });
});
