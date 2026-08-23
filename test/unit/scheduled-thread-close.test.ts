import { describe, expect, it, vi } from "vitest";

import type {
  ScheduledAction,
  ScheduledActionStatus,
  ScheduledActionStore,
  ScheduledActionTransitionResult,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseExecutor } from "../../src/scheduled-thread-close.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

describe("scheduled thread close executor", () => {
  it("skips a mismatched action type without claiming or auditing", async () => {
    const fixture = createFixture({ actionType: "SEND_MESSAGE" });

    await expect(fixture.executor.execute(fixture.action, "attempt-audit-id")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "ACTION_TYPE_MISMATCH",
      action: fixture.action,
    });

    expect(fixture.store.claimExecution).not.toHaveBeenCalled();
    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    expect(fixture.current.status).toBe("ACTIVE");
  });

  it("claims, performs a SYSTEM close with the attempt audit ID, and completes", async () => {
    const fixture = createFixture();

    const result = await fixture.executor.execute(fixture.action, "attempt-audit-id");

    expect(result).toMatchObject({ outcome: "SUCCESS", action: { status: "COMPLETED" } });
    expect(fixture.closeAsSystem).toHaveBeenCalledWith(
      fixture.action.guildId,
      fixture.action.targetId,
      "attempt-audit-id",
    );
    expect(fixture.store.completeExecution).toHaveBeenCalledOnce();
    expect(fixture.current.status).toBe("COMPLETED");
  });

  it("releases a retryable failure and marks a permanent failure", async () => {
    const retryable = createFixture({
      lifecycleResult: { outcome: "RETRYABLE_FAILURE", code: "DISCORD_FETCH_TIMEOUT" },
    });
    await expect(
      retryable.executor.execute(retryable.action, "retry-audit"),
    ).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "DISCORD_FETCH_TIMEOUT",
      action: { status: "ACTIVE" },
    });
    expect(retryable.store.releaseExecutionForRetry).toHaveBeenCalledOnce();

    const permanent = createFixture({
      lifecycleResult: { outcome: "PERMANENT_FAILURE", code: "BOT_PERMISSION_MISSING" },
    });
    await expect(
      permanent.executor.execute(permanent.action, "permanent-audit"),
    ).resolves.toMatchObject({
      outcome: "PERMANENT_FAILURE",
      code: "BOT_PERMISSION_MISSING",
      action: { status: "FAILED" },
    });
    expect(permanent.store.failExecution).toHaveBeenCalledOnce();
  });

  it("does not execute when the conditional claim loses", async () => {
    const fixture = createFixture();
    fixture.current = { ...fixture.current, status: "CANCELLED" };

    await expect(
      fixture.executor.execute(fixture.action, "attempt-audit-id"),
    ).resolves.toMatchObject({
      outcome: "SKIPPED",
      reason: "NOT_ACTIVE",
      action: { status: "CANCELLED" },
    });
    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
  });

  it("confirms a final transition after response loss without repeating the write", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.store.completeExecution).mockImplementationOnce(() => {
      fixture.current = { ...fixture.current, status: "COMPLETED", updatedAt: new Date() };
      return Promise.reject(new Error("response lost"));
    });

    await expect(
      fixture.executor.execute(fixture.action, "attempt-audit-id"),
    ).resolves.toMatchObject({
      outcome: "SUCCESS",
      action: { status: "COMPLETED" },
    });
    expect(fixture.store.completeExecution).toHaveBeenCalledOnce();
    expect(fixture.store.findById).toHaveBeenCalledOnce();
  });

  it("does not blindly repeat an uncertain retry release", async () => {
    const fixture = createFixture({
      lifecycleResult: { outcome: "RETRYABLE_FAILURE", code: "DISCORD_FETCH_FAILED" },
    });
    vi.mocked(fixture.store.releaseExecutionForRetry).mockRejectedValueOnce(
      new Error("response lost"),
    );

    await expect(
      fixture.executor.execute(fixture.action, "attempt-audit-id"),
    ).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "SCHEDULED_ACTION_TRANSITION_FAILED",
      action: { status: "EXECUTING" },
    });
    expect(fixture.store.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.current.status).toBe("EXECUTING");
  });
});

function createFixture({
  actionType = "CLOSE_THREAD",
  lifecycleResult = { outcome: "SUCCESS", changed: true } as const,
}: {
  actionType?: ScheduledAction["actionType"];
  lifecycleResult?: Awaited<ReturnType<ThreadLifecycleService["closeAsSystem"]>>;
} = {}) {
  const action: ScheduledAction = {
    id: `action-${actionType}`,
    guildId: "guild-id",
    actionType,
    targetId: "thread-id",
    status: "ACTIVE",
    executeAt: new Date("2030-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
  let current = action;
  const transition = (
    expected: ScheduledActionStatus,
    next: ScheduledActionStatus,
  ): Promise<ScheduledActionTransitionResult> => {
    if (current.status !== expected) {
      return Promise.resolve({ transitioned: false, current });
    }
    current = { ...current, status: next, updatedAt: new Date() };
    return Promise.resolve({ transitioned: true, current });
  };
  const store: ScheduledActionStore = {
    create: vi.fn(),
    findById: vi.fn(() => Promise.resolve(current)),
    findActiveThreadClosesPage: vi.fn(() => Promise.resolve([])),
    findExecutingThreadClosesPage: vi.fn(() => Promise.resolve([])),
    cancel: vi.fn(),
    claimExecution: vi.fn(() => transition("ACTIVE", "EXECUTING")),
    completeExecution: vi.fn(() => transition("EXECUTING", "COMPLETED")),
    failExecution: vi.fn(() => transition("EXECUTING", "FAILED")),
    releaseExecutionForRetry: vi.fn(() => transition("EXECUTING", "ACTIVE")),
  };
  const closeAsSystem = vi.fn(() => Promise.resolve(lifecycleResult));
  const executor = createScheduledThreadCloseExecutor({
    scheduledActions: store,
    threadLifecycle: { closeAsSystem },
  });

  return {
    action,
    store,
    closeAsSystem,
    executor,
    get current() {
      return current;
    },
    set current(value: ScheduledAction) {
      current = value;
    },
  };
}
