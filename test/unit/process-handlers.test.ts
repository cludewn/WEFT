import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { installProcessHandlers } from "../../src/process-handlers.js";

describe("process handlers", () => {
  it("joins repeated signals through runtime shutdown and disposes every listener", async () => {
    const target = new EventEmitter();
    const shutdown = vi.fn(() => Promise.resolve());
    const runtime = {
      shutdown,
      handleFatal: vi.fn(() => Promise.resolve()),
      setProcessHandlerDisposer: vi.fn(),
    };
    const processControl = { setExitCode: vi.fn() };
    const dispose = installProcessHandlers(runtime, processControl, target);

    target.emit("SIGTERM");
    target.emit("SIGINT");
    await Promise.resolve();
    expect(shutdown).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(shutdown).toHaveBeenNthCalledWith(2, "SIGINT");
    expect(processControl.setExitCode).not.toHaveBeenCalled();

    dispose();
    dispose();
    expect(target.listenerCount("SIGTERM")).toBe(0);
    expect(target.listenerCount("SIGINT")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
    expect(target.listenerCount("uncaughtException")).toBe(0);
  });

  it("routes both fatal origins without exposing their raw arguments", async () => {
    const target = new EventEmitter();
    const handleFatal = vi.fn(() => Promise.resolve());
    installProcessHandlers(
      {
        shutdown: vi.fn(() => Promise.resolve()),
        handleFatal,
        setProcessHandlerDisposer: vi.fn(),
      },
      { setExitCode: vi.fn() },
      target,
    );
    const rejection = { private: "reason" };
    const exception = new Error("private message");

    target.emit("unhandledRejection", rejection, Promise.resolve());
    target.emit("uncaughtException", exception);
    await Promise.resolve();

    expect(handleFatal).toHaveBeenNthCalledWith(1, "unhandledRejection", rejection);
    expect(handleFatal).toHaveBeenNthCalledWith(2, "uncaughtException", exception);
  });
});
