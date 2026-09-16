import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type { ScheduledAction } from "../../src/scheduled-action-persistence.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageStore,
} from "../../src/scheduled-message-persistence.js";
import {
  createScheduledMessageRuntimeReconciler,
  createScheduledMessageStartupReconciler,
  ScheduledMessageStartupRecoveryError,
} from "../../src/scheduled-message-reconciler.js";

const executeAt = new Date("2030-01-01T00:00:00Z");
function action(id: string, status: ScheduledAction["status"]): ScheduledAction {
  return {
    id,
    guildId: "guild-id",
    actionType: "SEND_MESSAGE",
    targetId: "channel-id",
    status,
    executeAt,
    createdAt: executeAt,
    updatedAt: executeAt,
  };
}
function definition(value: ScheduledAction): ScheduledMessageDefinition {
  return {
    action: value,
    creatorUserId: "creator-id",
    retryCount: 2,
    payload: { content: "content", embed: null },
    resultMessageId: null,
  };
}
function logger(): Logger {
  return { info: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

describe("scheduled message reconciliation", () => {
  it("terminally recovers EXECUTING before reconciling ACTIVE delivery", async () => {
    const executing = action("executing-id", "EXECUTING");
    const active = action("active-id", "ACTIVE");
    const calls: string[] = [];
    const findExecutingScheduledMessagesPage = vi
      .fn()
      .mockResolvedValueOnce([executing])
      .mockResolvedValueOnce([]);
    const findActiveScheduledMessagesPage = vi
      .fn()
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([]);
    const failExecution = vi.fn<ScheduledMessageStore["failExecution"]>((input) => {
      calls.push(`fail:${input.failureCode}`);
      return Promise.resolve({
        outcome: "COMMITTED" as const,
        definition: {
          ...input.definition,
          action: { ...input.definition.action, status: "FAILED" as const },
        },
      });
    });
    const enqueueScheduledMessage = vi.fn(() => {
      calls.push("enqueue");
      return Promise.resolve("ENQUEUED" as const);
    });
    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: { findExecutingScheduledMessagesPage, findActiveScheduledMessagesPage },
      store: { find: vi.fn(() => Promise.resolve(definition(executing))), failExecution },
      executor: { execute: vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const })) },
      delivery: {
        cancelStaleActiveDeliveries: vi.fn((id) => {
          calls.push(`cancel:${id}`);
          return Promise.resolve(1);
        }),
        hasCreatedOrRetryDelivery: vi.fn(() => Promise.resolve(false)),
        enqueueScheduledMessage,
      },
      logger: logger(),
      now: () => new Date("2030-01-01T00:00:00Z"),
      generateId: () => "recovery-audit-id",
    });

    await reconciler.recoverAtStartup();
    expect(calls).toEqual([
      "cancel:executing-id",
      "fail:EXECUTION_INTERRUPTED_UNCONFIRMED",
      "cancel:active-id",
      "enqueue",
    ]);
    expect(failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ auditId: "recovery-audit-id", resultMessageId: null }),
    );
  });

  it("fails startup when interrupted execution terminalization is not exactly confirmed", async () => {
    const executing = action("executing-id", "EXECUTING");
    const findActiveScheduledMessagesPage = vi.fn(() => Promise.resolve([]));
    const execute = vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const }));
    const enqueueScheduledMessage = vi.fn(() => Promise.resolve("ENQUEUED" as const));
    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: {
        findExecutingScheduledMessagesPage: vi
          .fn()
          .mockResolvedValueOnce([executing])
          .mockResolvedValueOnce([]),
        findActiveScheduledMessagesPage,
      },
      store: {
        find: vi.fn(() => Promise.resolve(definition(executing))),
        failExecution: vi.fn(() =>
          Promise.resolve({ outcome: "NOT_TRANSITIONED" as const, current: definition(executing) }),
        ),
      },
      executor: { execute },
      delivery: {
        cancelStaleActiveDeliveries: vi.fn(() => Promise.resolve(1)),
        hasCreatedOrRetryDelivery: vi.fn(() => Promise.resolve(false)),
        enqueueScheduledMessage,
      },
      logger: logger(),
    });

    await expect(reconciler.recoverAtStartup()).rejects.toBeInstanceOf(
      ScheduledMessageStartupRecoveryError,
    );
    expect(execute).not.toHaveBeenCalled();
    expect(findActiveScheduledMessagesPage).not.toHaveBeenCalled();
    expect(enqueueScheduledMessage).not.toHaveBeenCalled();
  });

  it("runtime reconciliation scans ACTIVE only and never resets retry state", async () => {
    const active = action("active-id", "ACTIVE");
    const findActiveScheduledMessagesPage = vi
      .fn()
      .mockResolvedValueOnce([active])
      .mockResolvedValueOnce([]);
    const enqueueScheduledMessage = vi.fn(() => Promise.resolve("ENQUEUED" as const));
    const executor = { execute: vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const })) };
    const reconciler = createScheduledMessageRuntimeReconciler({
      scheduledActions: { findActiveScheduledMessagesPage },
      executor,
      delivery: { enqueueScheduledMessage },
      logger: logger(),
      now: () => executeAt,
    });

    await reconciler.reconcileOnce();
    expect(enqueueScheduledMessage).toHaveBeenCalledWith("active-id", executeAt);
    expect(executor.execute).not.toHaveBeenCalled();
    await reconciler.stop();
  });

  it("claims and audits an ACTIVE action outside grace without enqueueing", async () => {
    const expired = action("expired-id", "ACTIVE");
    const findActiveScheduledMessagesPage = vi
      .fn()
      .mockResolvedValueOnce([expired])
      .mockResolvedValueOnce([]);
    const execute = vi.fn(() =>
      Promise.resolve({
        outcome: "PERMANENT_FAILURE" as const,
        code: "OVERDUE_GRACE_EXCEEDED" as const,
      }),
    );
    const enqueueScheduledMessage = vi.fn(() => Promise.resolve("ENQUEUED" as const));
    const reconciler = createScheduledMessageRuntimeReconciler({
      scheduledActions: { findActiveScheduledMessagesPage },
      executor: { execute },
      delivery: { enqueueScheduledMessage },
      logger: logger(),
      now: () => new Date(executeAt.getTime() + 3_600_001),
    });

    await reconciler.reconcileOnce();
    expect(execute).toHaveBeenCalledWith("expired-id");
    expect(enqueueScheduledMessage).not.toHaveBeenCalled();
    await reconciler.stop();
  });
});
