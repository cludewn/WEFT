import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AutomaticCloseExecutionResult,
  AutomaticCloseExecutor,
} from "../../src/automatic-close-execution.js";
import type {
  AutomaticCloseCandidate,
  AutomaticClosePersistenceStore,
} from "../../src/automatic-close-persistence.js";
import {
  AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS,
  createAutomaticCloseRuntime,
} from "../../src/automatic-close-runtime.js";

type CandidateStore = Pick<AutomaticClosePersistenceStore, "findInactiveCandidatesPage">;

const continuationCases: Array<[string, () => Promise<AutomaticCloseExecutionResult>]> = [
  ["SUCCESS", () => Promise.resolve({ outcome: "SUCCESS", changed: false })],
  ["SKIPPED", () => Promise.resolve({ outcome: "SKIPPED", reason: "NOT_CURRENTLY_ELIGIBLE" })],
  [
    "RETRYABLE_FAILURE",
    () => Promise.resolve({ outcome: "RETRYABLE_FAILURE", code: "DISCORD_INSPECTION_FAILED" }),
  ],
  [
    "ATTEMPT_FAILURE",
    () => Promise.resolve({ outcome: "ATTEMPT_FAILURE", code: "BOT_PERMISSION_MISSING" }),
  ],
  ["unexpected rejection", () => Promise.reject(new Error("private executor detail"))],
];

function createCandidate(
  threadId: string,
  lastActivityAt = new Date("2030-01-01T00:00:00.000Z"),
): AutomaticCloseCandidate {
  return {
    guildId: `guild-${threadId}`,
    threadId,
    parentChannelId: `parent-${threadId}`,
    lastActivityAt,
  };
}

function createDeferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve: (value: T) => resolve?.(value),
    reject: (reason?: unknown) => reject?.(reason),
  };
}

function createFixture(now: () => Date = () => new Date("2040-01-01T00:00:00.000Z")) {
  const persistence: CandidateStore = {
    findInactiveCandidatesPage: vi.fn(() => Promise.resolve([])),
  };
  const executor: AutomaticCloseExecutor = {
    execute: vi.fn<AutomaticCloseExecutor["execute"]>(() =>
      Promise.resolve({ outcome: "SUCCESS", changed: false }),
    ),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
  } as unknown as Pick<Logger, "info" | "warn">;
  const runtime = createAutomaticCloseRuntime({ persistence, executor, logger, now });
  return { executor, logger, persistence, runtime };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("automatic close runtime sweep", () => {
  it("reuses one asOf across keyset pages and captures a new one for the next sweep", async () => {
    const firstAsOf = new Date("2040-01-01T00:00:00.000Z");
    const secondAsOf = new Date("2040-01-01T00:05:00.000Z");
    const now = vi.fn().mockReturnValueOnce(firstAsOf).mockReturnValueOnce(secondAsOf);
    const fixture = createFixture(now);
    const first = createCandidate("one", new Date("2030-01-01T00:00:00.000Z"));
    const second = createCandidate("two", new Date("2030-01-02T00:00:00.000Z"));
    const third = createCandidate("three", new Date("2030-01-03T00:00:00.000Z"));
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([third])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await fixture.runtime.sweepOnce();
    await fixture.runtime.sweepOnce();

    expect(now).toHaveBeenCalledTimes(2);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenNthCalledWith(1, {
      asOf: firstAsOf,
    });
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenNthCalledWith(2, {
      asOf: firstAsOf,
      cursor: {
        lastActivityAt: second.lastActivityAt,
        guildId: second.guildId,
        threadId: second.threadId,
      },
    });
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenNthCalledWith(3, {
      asOf: firstAsOf,
      cursor: {
        lastActivityAt: third.lastActivityAt,
        guildId: third.guildId,
        threadId: third.threadId,
      },
    });
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenNthCalledWith(4, {
      asOf: secondAsOf,
    });
  });

  it("waits for each candidate to settle before starting the next", async () => {
    const fixture = createFixture();
    const first = createCandidate("one");
    const second = createCandidate("two");
    const firstExecution = createDeferred<AutomaticCloseExecutionResult>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.executor.execute)
      .mockReturnValueOnce(firstExecution.promise)
      .mockResolvedValueOnce({ outcome: "SUCCESS", changed: false });

    const sweep = fixture.runtime.sweepOnce();
    await Promise.resolve();
    expect(fixture.executor.execute).toHaveBeenCalledTimes(1);
    expect(fixture.executor.execute).toHaveBeenCalledWith(first);

    firstExecution.resolve({ outcome: "SUCCESS", changed: true });
    await Promise.resolve();
    expect(fixture.executor.execute).toHaveBeenCalledTimes(2);
    expect(fixture.executor.execute).toHaveBeenLastCalledWith(second);
    await sweep;
  });

  it("contains every bounded result and unexpected rejection while reporting aggregate counts", async () => {
    const fixture = createFixture();
    const candidates = ["success", "skipped", "retryable", "attempt", "unexpected"].map((id) =>
      createCandidate(id),
    );
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockResolvedValueOnce(candidates)
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.executor.execute)
      .mockResolvedValueOnce({ outcome: "SUCCESS", changed: true })
      .mockResolvedValueOnce({ outcome: "SKIPPED", reason: "NOT_CURRENTLY_ELIGIBLE" })
      .mockResolvedValueOnce({
        outcome: "RETRYABLE_FAILURE",
        code: "DISCORD_INSPECTION_FAILED",
      })
      .mockResolvedValueOnce({ outcome: "ATTEMPT_FAILURE", code: "BOT_PERMISSION_MISSING" })
      .mockRejectedValueOnce(new Error("private executor detail"));

    await fixture.runtime.sweepOnce();

    expect(fixture.executor.execute).toHaveBeenCalledTimes(5);
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "automatic_close_sweep_completed",
        pageCount: 1,
        candidateCount: 5,
        successCount: 1,
        changedCount: 1,
        skippedCount: 1,
        retryableFailureCount: 1,
        attemptFailureCount: 1,
        unexpectedFailureCount: 1,
      }),
      expect.any(String),
    );
    expect(fixture.logger.warn).toHaveBeenCalledTimes(3);
    const metadata = vi.mocked(fixture.logger.warn).mock.calls.map(([fields]) => fields);
    expect(JSON.stringify(metadata)).not.toContain("private executor detail");
    expect(metadata).not.toContainEqual(expect.any(Error));
  });

  it.each(continuationCases)("continues after %s", async (_name, firstResult) => {
    const fixture = createFixture();
    const first = createCandidate("one");
    const second = createCandidate("two");
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([]);
    vi.mocked(fixture.executor.execute)
      .mockImplementationOnce(firstResult)
      .mockResolvedValueOnce({ outcome: "SUCCESS", changed: false });

    await fixture.runtime.sweepOnce();

    expect(fixture.executor.execute).toHaveBeenNthCalledWith(1, first);
    expect(fixture.executor.execute).toHaveBeenNthCalledWith(2, second);
  });

  it("stops a failed page scan and begins the next periodic sweep from a fresh snapshot", async () => {
    const firstAsOf = new Date("2040-01-01T00:00:00.000Z");
    const secondAsOf = new Date("2040-01-01T00:05:00.000Z");
    const now = vi.fn().mockReturnValueOnce(firstAsOf).mockReturnValueOnce(secondAsOf);
    const fixture = createFixture(now);
    const candidate = createCandidate("one");
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockResolvedValueOnce([candidate])
      .mockRejectedValueOnce(new TypeError("private database detail"))
      .mockResolvedValueOnce([]);

    await fixture.runtime.start();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledTimes(2);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "automatic_close_sweep_scan_failed",
        errorName: "TypeError",
      }),
      expect.any(String),
    );

    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenNthCalledWith(3, {
      asOf: secondAsOf,
    });
  });

  it("returns the exact in-flight Promise to overlapping callers", async () => {
    const now = vi.fn(() => new Date("2040-01-01T00:00:00.000Z"));
    const fixture = createFixture(now);
    const page = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage).mockReturnValueOnce(page.promise);

    const first = fixture.runtime.sweepOnce();
    const second = fixture.runtime.sweepOnce();

    expect(second).toBe(first);
    expect(now).toHaveBeenCalledOnce();
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    page.resolve([]);
    await first;
  });
});

describe("automatic close runtime scheduling", () => {
  it("waits a full fixed delay before the first and every later sweep", async () => {
    const fixture = createFixture();
    const firstPage = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockReturnValueOnce(firstPage.promise)
      .mockResolvedValueOnce([]);

    await fixture.runtime.start();
    expect(fixture.persistence.findInactiveCandidatesPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    expect(fixture.persistence.findInactiveCandidatesPage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS * 2);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    firstPage.resolve([]);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledTimes(2);
  });

  it("makes a manual owner reset the pending periodic delay", async () => {
    const fixture = createFixture();
    const manualPage = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockReturnValueOnce(manualPage.promise)
      .mockResolvedValueOnce([]);

    await fixture.runtime.start();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    const manual = fixture.runtime.sweepOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();

    manualPage.resolve([]);
    await manual;
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledTimes(2);
  });

  it("does not schedule around a pre-start manual sweep until that sweep settles", async () => {
    const fixture = createFixture();
    const manualPage = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage)
      .mockReturnValueOnce(manualPage.promise)
      .mockResolvedValueOnce([]);

    const manual = fixture.runtime.sweepOnce();
    await fixture.runtime.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS * 2);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();

    manualPage.resolve([]);
    await manual;
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS - 1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledTimes(2);
  });

  it("lets boundary-time manual calls join the timer-owned sweep without rescheduling twice", async () => {
    const fixture = createFixture();
    const page = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage).mockReturnValueOnce(page.promise);

    await fixture.runtime.start();
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS);
    const owner = fixture.runtime.sweepOnce();
    const joiner = fixture.runtime.sweepOnce();
    expect(joiner).toBe(owner);
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();

    page.resolve([]);
    await owner;
    expect(vi.getTimerCount()).toBe(1);
  });

  it("treats repeated start as a logged-once no-op", async () => {
    const fixture = createFixture();

    await fixture.runtime.start();
    await fixture.runtime.start();

    expect(vi.getTimerCount()).toBe(1);
    expect(fixture.logger.info).toHaveBeenCalledTimes(1);
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: "automatic_close_runtime_started" }),
      expect.any(String),
    );
  });
});

describe("automatic close runtime stop", () => {
  it("clears a pending timer and shares one stop operation", async () => {
    const fixture = createFixture();
    await fixture.runtime.start();

    const first = fixture.runtime.stop();
    const second = fixture.runtime.stop();

    expect(second).toBe(first);
    expect(vi.getTimerCount()).toBe(0);
    await first;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS);
    expect(fixture.persistence.findInactiveCandidatesPage).not.toHaveBeenCalled();
    expect(fixture.logger.info).toHaveBeenCalledTimes(2);
  });

  it("waits for an active page read and executes none of its returned candidates", async () => {
    const fixture = createFixture();
    const page = createDeferred<AutomaticCloseCandidate[]>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage).mockReturnValueOnce(page.promise);
    await fixture.runtime.start();
    const sweep = fixture.runtime.sweepOnce();

    let stopped = false;
    const stop = fixture.runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(fixture.runtime.start()).rejects.toThrow("Automatic close runtime has stopped");
    page.resolve([createCandidate("one")]);
    await Promise.all([sweep, stop]);

    expect(fixture.executor.execute).not.toHaveBeenCalled();
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for the current candidate and starts no later work", async () => {
    const fixture = createFixture();
    const first = createCandidate("one");
    const second = createCandidate("two");
    const execution = createDeferred<AutomaticCloseExecutionResult>();
    vi.mocked(fixture.persistence.findInactiveCandidatesPage).mockResolvedValueOnce([
      first,
      second,
    ]);
    vi.mocked(fixture.executor.execute).mockReturnValueOnce(execution.promise);
    await fixture.runtime.start();
    const sweep = fixture.runtime.sweepOnce();
    await Promise.resolve();

    const stop = fixture.runtime.stop();
    execution.resolve({ outcome: "SUCCESS", changed: true });
    await Promise.all([sweep, stop]);

    expect(fixture.executor.execute).toHaveBeenCalledOnce();
    expect(fixture.persistence.findInactiveCandidatesPage).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects start after stop and never restarts", async () => {
    const fixture = createFixture();
    await fixture.runtime.stop();

    await expect(fixture.runtime.start()).rejects.toThrow("Automatic close runtime has stopped");
    expect(vi.getTimerCount()).toBe(0);
    expect(fixture.persistence.findInactiveCandidatesPage).not.toHaveBeenCalled();
  });

  it("keeps a successful zero-candidate sweep silent at info", async () => {
    const fixture = createFixture();

    await fixture.runtime.sweepOnce();

    expect(fixture.logger.info).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });
});
