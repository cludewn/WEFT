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
    const shutdown = createShutdown(closeResources, createLogger());

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(closeResources).toHaveBeenCalledOnce();
  });

  it("propagates resource cleanup failures", async () => {
    const failure = new Error("cleanup failed");
    const shutdown = createShutdown(async () => Promise.reject(failure), createLogger());

    await expect(shutdown("SIGTERM")).rejects.toBe(failure);
  });
});
