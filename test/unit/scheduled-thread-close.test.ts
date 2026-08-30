import { describe, expect, it, vi } from "vitest";

import type {
  ScheduledAction,
  ScheduledActionStatus,
  ScheduledActionStore,
  ScheduledActionTransitionResult,
} from "../../src/scheduled-action-persistence.js";
import type {
  ScheduledThreadCloseExecutionTransitionResult,
  ScheduledThreadCloseStore,
} from "../../src/scheduled-thread-close-persistence.js";
import { createScheduledThreadCloseExecutor } from "../../src/scheduled-thread-close.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

const auditIds = { attemptAuditId: "attempt-audit-id", executionAuditId: "execution-audit-id" };

describe("scheduled thread close executor", () => {
  it("skips a mismatched action type without claiming or auditing", async () => {
    const fixture = createFixture({ actionType: "SEND_MESSAGE" });

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "ACTION_TYPE_MISMATCH",
      action: fixture.action,
    });

    expect(fixture.store.claimExecution).not.toHaveBeenCalled();
    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    expect(fixture.executionAudits).toHaveLength(0);
    expect(fixture.current.status).toBe("ACTIVE");
  });

  it("uses separate lifecycle and scheduled-execution audit identifiers", async () => {
    const fixture = createFixture();

    const result = await fixture.executor.execute(fixture.action, auditIds);

    expect(result).toMatchObject({ outcome: "SUCCESS", action: { status: "COMPLETED" } });
    expect(fixture.closeAsSystem).toHaveBeenCalledWith(
      fixture.action.guildId,
      fixture.action.targetId,
      "attempt-audit-id",
    );
    expect(fixture.schedules.completeExecution).toHaveBeenCalledExactlyOnceWith({
      scheduledActionId: fixture.action.id,
      auditId: "execution-audit-id",
    });
    expect(fixture.executionAudits).toEqual([
      { scheduledActionId: fixture.action.id, auditId: "execution-audit-id", event: "COMPLETED" },
    ]);
    expect(fixture.current.status).toBe("COMPLETED");
  });

  it("releases a retryable failure with its concrete failure code", async () => {
    const fixture = createFixture({
      lifecycleResult: { outcome: "RETRYABLE_FAILURE", code: "DISCORD_FETCH_TIMEOUT" },
    });

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "DISCORD_FETCH_TIMEOUT",
      action: { status: "ACTIVE" },
    });

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledExactlyOnceWith({
      scheduledActionId: fixture.action.id,
      auditId: "execution-audit-id",
      failureCode: "DISCORD_FETCH_TIMEOUT",
    });
    expect(fixture.executionAudits).toHaveLength(1);
  });

  it("fails a permanent failure with its concrete failure code", async () => {
    const fixture = createFixture({
      lifecycleResult: { outcome: "PERMANENT_FAILURE", code: "BOT_PERMISSION_MISSING" },
    });

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "PERMANENT_FAILURE",
      code: "BOT_PERMISSION_MISSING",
      action: { status: "FAILED" },
    });

    expect(fixture.schedules.failExecution).toHaveBeenCalledExactlyOnceWith({
      scheduledActionId: fixture.action.id,
      auditId: "execution-audit-id",
      failureCode: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.executionAudits).toHaveLength(1);
  });

  it("releases an unexpected lifecycle failure as an audited retry", async () => {
    const fixture = createFixture();
    fixture.closeAsSystem.mockRejectedValueOnce(new Error("lifecycle exploded"));

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
      action: { status: "ACTIVE" },
    });

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledExactlyOnceWith({
      scheduledActionId: fixture.action.id,
      auditId: "execution-audit-id",
      failureCode: "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
    });
  });

  it("writes no execution audit when the claim response is lost", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.store.claimExecution).mockRejectedValueOnce(new Error("response lost"));

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "SCHEDULED_ACTION_CLAIM_FAILED",
    });

    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    expect(fixture.executionAudits).toHaveLength(0);
  });

  it("writes no execution audit for a missing action", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.store.claimExecution).mockRejectedValueOnce(new Error("response lost"));
    vi.mocked(fixture.store.findById).mockResolvedValueOnce(undefined);

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "MISSING",
    });

    expect(fixture.executionAudits).toHaveLength(0);
  });

  it("writes no execution audit when the conditional claim loses", async () => {
    const fixture = createFixture();
    fixture.current = { ...fixture.current, status: "CANCELLED" };

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "SKIPPED",
      reason: "NOT_ACTIVE",
      action: { status: "CANCELLED" },
    });

    expect(fixture.closeAsSystem).not.toHaveBeenCalled();
    expect(fixture.executionAudits).toHaveLength(0);
  });

  it("treats a confirmed committed transition as the intended outcome", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.schedules.completeExecution).mockImplementationOnce(() => {
      fixture.current = { ...fixture.current, status: "COMPLETED", updatedAt: new Date() };
      return Promise.resolve({ outcome: "ALREADY_COMMITTED", action: fixture.current });
    });

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "SUCCESS",
      action: { status: "COMPLETED" },
    });

    expect(fixture.schedules.completeExecution).toHaveBeenCalledOnce();
    expect(fixture.store.findById).not.toHaveBeenCalled();
  });

  it("classifies an unconfirmed transition as retryable without repeating the write", async () => {
    const fixture = createFixture({
      lifecycleResult: { outcome: "RETRYABLE_FAILURE", code: "DISCORD_FETCH_FAILED" },
    });
    vi.mocked(fixture.schedules.releaseExecutionForRetry).mockRejectedValueOnce(
      new Error("response lost"),
    );

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "SCHEDULED_ACTION_TRANSITION_FAILED",
      action: { status: "EXECUTING" },
    });

    expect(fixture.schedules.releaseExecutionForRetry).toHaveBeenCalledOnce();
    expect(fixture.store.findById).not.toHaveBeenCalled();
    expect(fixture.current.status).toBe("EXECUTING");
  });

  it("classifies a lost conditional transition as retryable", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.schedules.completeExecution).mockImplementationOnce(() => {
      fixture.current = { ...fixture.current, status: "CANCELLED", updatedAt: new Date() };
      return Promise.resolve({ outcome: "NOT_TRANSITIONED", current: fixture.current });
    });

    await expect(fixture.executor.execute(fixture.action, auditIds)).resolves.toMatchObject({
      outcome: "RETRYABLE_FAILURE",
      code: "SCHEDULED_ACTION_TRANSITION_FAILED",
      action: { status: "CANCELLED" },
    });

    expect(fixture.executionAudits).toHaveLength(0);
  });
});

type RecordedExecutionAudit = {
  scheduledActionId: string;
  auditId: string;
  event: "COMPLETED" | "FAILED" | "RETRY";
};

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
  const executionAudits: RecordedExecutionAudit[] = [];

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

  const auditedTransition = (
    next: ScheduledActionStatus,
    event: RecordedExecutionAudit["event"],
    input: { scheduledActionId: string; auditId: string },
  ): Promise<ScheduledThreadCloseExecutionTransitionResult> => {
    if (current.status !== "EXECUTING") {
      return Promise.resolve({ outcome: "NOT_TRANSITIONED", current });
    }
    current = { ...current, status: next, updatedAt: new Date() };
    executionAudits.push({
      scheduledActionId: input.scheduledActionId,
      auditId: input.auditId,
      event,
    });
    return Promise.resolve({ outcome: "TRANSITIONED", action: current });
  };

  const store: ScheduledActionStore = {
    create: vi.fn(),
    findById: vi.fn(() => Promise.resolve(current)),
    findActiveThreadClosesPage: vi.fn(() => Promise.resolve([])),
    findExecutingThreadClosesPage: vi.fn(() => Promise.resolve([])),
    findCurrentThreadClose: vi.fn(() => Promise.resolve(undefined)),
    cancel: vi.fn(),
    claimExecution: vi.fn(() => transition("ACTIVE", "EXECUTING")),
  };

  const schedules: ScheduledThreadCloseStore = {
    createOrReplace: vi.fn(),
    cancel: vi.fn(),
    findAuditById: vi.fn(),
    completeExecution: vi.fn<ScheduledThreadCloseStore["completeExecution"]>((input) =>
      auditedTransition("COMPLETED", "COMPLETED", input),
    ),
    failExecution: vi.fn<ScheduledThreadCloseStore["failExecution"]>((input) =>
      auditedTransition("FAILED", "FAILED", input),
    ),
    releaseExecutionForRetry: vi.fn<ScheduledThreadCloseStore["releaseExecutionForRetry"]>(
      (input) => auditedTransition("ACTIVE", "RETRY", input),
    ),
  };

  const closeAsSystem = vi.fn(() => Promise.resolve(lifecycleResult));
  const executor = createScheduledThreadCloseExecutor({
    scheduledActions: store,
    schedules,
    threadLifecycle: { closeAsSystem },
  });

  return {
    action,
    store,
    schedules,
    executionAudits,
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
