import { setImmediate } from "node:timers/promises";

import { describe, expect, it } from "vitest";

import { OperationTimeoutError, withTimeout } from "../../src/operation-timeout.js";

describe("withTimeout", () => {
  it("consumes a late rejection after reporting a timeout", async () => {
    let rejectOperation: ((reason: Error) => void) | undefined;
    const operation = new Promise<void>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(withTimeout(operation, 5)).rejects.toBeInstanceOf(OperationTimeoutError);
      rejectOperation?.(new Error("late operation failure"));
      await setImmediate();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });
});
