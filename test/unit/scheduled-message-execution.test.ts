import { describe, expect, it, vi } from "vitest";

import type { ScheduledMessageDiscord } from "../../src/scheduled-message-discord.js";
import {
  createScheduledMessageExecutor,
  deriveScheduledMessageNonce,
  isWithinScheduledMessageGrace,
  returnedScheduledMessageMatches,
} from "../../src/scheduled-message-execution.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageStore,
} from "../../src/scheduled-message-persistence.js";

const executeAt = new Date("2030-01-01T00:00:00.000Z");

function definition(
  overrides: Partial<ScheduledMessageDefinition> = {},
): ScheduledMessageDefinition {
  return {
    action: {
      id: "action-id",
      guildId: "guild-id",
      actionType: "SEND_MESSAGE",
      targetId: "channel-id",
      status: "ACTIVE",
      executeAt,
      createdAt: executeAt,
      updatedAt: executeAt,
    },
    creatorUserId: "creator-id",
    retryCount: 0,
    revision: 0,
    payload: { content: "scheduled content", embed: null },
    resultMessageId: null,
    ...overrides,
  };
}

function fixture(
  options: {
    loaded?: ScheduledMessageDefinition;
    now?: Date[];
  } = {},
) {
  const loaded = options.loaded ?? definition();
  const executing = { ...loaded, action: { ...loaded.action, status: "EXECUTING" as const } };
  const target = { guildId: "guild-id", channelId: "channel-id", botUserId: "bot-id", token: {} };
  const message = {
    guildId: "guild-id",
    channelId: "channel-id",
    messageId: "message-id",
    authorId: "bot-id",
    nonce: deriveScheduledMessageNonce(loaded.action.id),
    createdAt: new Date("2030-01-01T00:00:01.000Z"),
    payload: loaded.payload,
  };
  const store = {
    findForExecution: vi.fn<ScheduledMessageStore["findForExecution"]>(() =>
      Promise.resolve({ outcome: "FOUND", definition: loaded }),
    ),
    claimExecution: vi.fn<ScheduledMessageStore["claimExecution"]>(() =>
      Promise.resolve({ outcome: "COMMITTED", definition: executing }),
    ),
    retryPreSendFailure: vi.fn<ScheduledMessageStore["retryPreSendFailure"]>((input) =>
      Promise.resolve({
        outcome: "COMMITTED",
        definition: { ...input.definition, retryCount: input.definition.retryCount + 1 },
      }),
    ),
    failExecution: vi.fn<ScheduledMessageStore["failExecution"]>((input) =>
      Promise.resolve({
        outcome: "COMMITTED",
        definition: {
          ...input.definition,
          action: { ...input.definition.action, status: "FAILED" },
        },
      }),
    ),
    failMissingState: vi.fn<ScheduledMessageStore["failMissingState"]>(() =>
      Promise.resolve({ outcome: "COMMITTED" }),
    ),
    finalizeSuccess: vi.fn<ScheduledMessageStore["finalizeSuccess"]>(() =>
      Promise.resolve("COMMITTED"),
    ),
  } satisfies Pick<
    ScheduledMessageStore,
    | "findForExecution"
    | "claimExecution"
    | "retryPreSendFailure"
    | "failExecution"
    | "failMissingState"
    | "finalizeSuccess"
  >;
  const discord = {
    preflight: vi.fn<ScheduledMessageDiscord["preflight"]>(() =>
      Promise.resolve({ outcome: "READY", target }),
    ),
    createMessage: vi.fn<ScheduledMessageDiscord["createMessage"]>(() =>
      Promise.resolve({ outcome: "CREATED", message }),
    ),
    deleteMessage: vi.fn<ScheduledMessageDiscord["deleteMessage"]>(() =>
      Promise.resolve({ outcome: "DELETED" }),
    ),
  } satisfies ScheduledMessageDiscord;
  const times = options.now ?? [executeAt, executeAt, new Date(executeAt.getTime() + 1_000)];
  let timeIndex = 0;
  const executor = createScheduledMessageExecutor({
    store,
    discord,
    now: () => times[Math.min(timeIndex++, times.length - 1)]!,
    generateId: vi
      .fn()
      .mockReturnValueOnce("audit-1")
      .mockReturnValueOnce("audit-2")
      .mockReturnValue("audit-3"),
  });
  return { discord, executor, executing, loaded, message, store, target };
}

describe("scheduled message execution rules", () => {
  it("derives a stable bounded nonce per scheduled action", () => {
    const first = deriveScheduledMessageNonce("action-one");
    expect(first).toBe(deriveScheduledMessageNonce("action-one"));
    expect(first).not.toBe(deriveScheduledMessageNonce("action-two"));
    expect(first.length).toBeLessThanOrEqual(25);
  });

  it("keeps the 60-minute grace boundary inclusive", () => {
    expect(
      isWithinScheduledMessageGrace(executeAt, new Date(executeAt.getTime() + 3_600_000)),
    ).toBe(true);
    expect(
      isWithinScheduledMessageGrace(executeAt, new Date(executeAt.getTime() + 3_600_001)),
    ).toBe(false);
  });

  it("keeps a genuinely missing action as a side-effect-free skip", async () => {
    const f = fixture();
    f.store.findForExecution.mockResolvedValue({ outcome: "MISSING_ACTION" });

    await expect(f.executor.execute("missing-action")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "MISSING",
    });
    expect(f.store.claimExecution).not.toHaveBeenCalled();
    expect(f.store.failMissingState).not.toHaveBeenCalled();
    expect(f.discord.preflight).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("skips an authoritative ACTIVE definition whose execution time is still future", async () => {
    const futureExecuteAt = new Date(executeAt.getTime() + 60_000);
    const loaded = definition({
      action: { ...definition().action, executeAt: futureExecuteAt },
      revision: 1,
    });
    const f = fixture({ loaded, now: [executeAt] });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_DUE",
    });
    expect(f.discord.preflight).not.toHaveBeenCalled();
    expect(f.store.claimExecution).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.store.failExecution).not.toHaveBeenCalled();
    expect(f.store.finalizeSuccess).not.toHaveBeenCalled();
  });

  it("terminally fails a claimed ACTIVE SEND_MESSAGE whose required state is missing", async () => {
    const f = fixture();
    f.store.findForExecution.mockResolvedValue({
      outcome: "STATE_MISSING",
      action: f.loaded.action,
    });
    f.store.claimExecution.mockResolvedValue({
      outcome: "COMMITTED_STATE_MISSING",
      action: f.executing.action,
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "PERSISTED_PAYLOAD_INVALID",
    });
    expect(f.store.claimExecution).toHaveBeenCalledWith("action-id", undefined);
    expect(f.store.failMissingState).toHaveBeenCalledWith(
      expect.objectContaining({ action: f.executing.action }),
    );
    expect(f.store.failExecution).not.toHaveBeenCalled();
    expect(f.discord.preflight).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("does not audit a missing state when another caller wins the claim", async () => {
    const f = fixture();
    f.store.findForExecution.mockResolvedValue({
      outcome: "STATE_MISSING",
      action: f.loaded.action,
    });
    f.store.claimExecution.mockResolvedValue({ outcome: "NOT_TRANSITIONED", current: undefined });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_ACTIVE",
    });
    expect(f.store.failMissingState).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("checks preflight before claiming and sends only after winning the claim", async () => {
    const f = fixture();
    const calls: string[] = [];
    f.discord.preflight.mockImplementation(() => {
      calls.push("preflight");
      return Promise.resolve({ outcome: "READY", target: f.target });
    });
    f.store.claimExecution.mockImplementation(() => {
      calls.push("claim");
      return Promise.resolve({ outcome: "NOT_TRANSITIONED", current: f.loaded });
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_ACTIVE",
    });
    expect(calls).toEqual(["preflight", "claim"]);
    expect(f.store.claimExecution).toHaveBeenCalledWith("action-id", f.loaded.revision);
    expect(f.discord.createMessage).not.toHaveBeenCalled();
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.store.failExecution).not.toHaveBeenCalled();
  });

  it("accounts a retryable preflight failure only after the claim", async () => {
    const f = fixture();
    f.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "RETRYABLE_FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
    expect(f.store.claimExecution).toHaveBeenCalledOnce();
    expect(f.store.retryPreSendFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: f.executing,
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      }),
    );
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("does not record a retryable preflight result when it loses the claim", async () => {
    const f = fixture();
    f.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
    f.store.claimExecution.mockResolvedValue({ outcome: "NOT_TRANSITIONED", current: f.loaded });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_ACTIVE",
    });
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.store.failExecution).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("turns another retryable failure at retry count three into terminal failure", async () => {
    const f = fixture({ loaded: definition({ retryCount: 3 }) });
    f.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "CURRENT_STATE_CHECK_FAILED" }),
    );
  });

  it("records a permanent preflight failure only after winning the claim", async () => {
    const f = fixture();
    f.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "ARCHIVED_THREAD",
      retryable: false,
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "ARCHIVED_THREAD",
    });
    expect(f.store.claimExecution).toHaveBeenCalledOnce();
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ definition: f.executing, failureCode: "ARCHIVED_THREAD" }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("records a confirmed generic preflight rejection without using the retry transition", async () => {
    const f = fixture();
    f.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_REJECTED",
      retryable: false,
    });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "CURRENT_STATE_CHECK_REJECTED",
    });
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "CURRENT_STATE_CHECK_REJECTED" }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("lets post-preflight grace expiry override a successful stale preflight", async () => {
    const f = fixture({ now: [executeAt, new Date(executeAt.getTime() + 3_600_001), executeAt] });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "OVERDUE_GRACE_EXCEEDED",
    });
    expect(f.store.claimExecution).toHaveBeenCalledOnce();
    expect(f.discord.createMessage).not.toHaveBeenCalled();
  });

  it("replays an ambiguous create once with the exact same request", async () => {
    const f = fixture();
    f.discord.createMessage
      .mockResolvedValueOnce({ outcome: "AMBIGUOUS" })
      .mockResolvedValueOnce({ outcome: "CREATED", message: f.message });

    await expect(f.executor.execute("action-id")).resolves.toEqual({ outcome: "SUCCESS" });
    expect(f.discord.createMessage).toHaveBeenCalledTimes(2);
    expect(f.discord.createMessage.mock.calls[1]?.[0]).toEqual(
      f.discord.createMessage.mock.calls[0]?.[0],
    );
  });

  it("finalizes exact creation once with stable managed and execution audit IDs", async () => {
    const f = fixture();

    await expect(f.executor.execute("action-id")).resolves.toEqual({ outcome: "SUCCESS" });
    expect(f.store.finalizeSuccess).toHaveBeenCalledExactlyOnceWith({
      definition: f.executing,
      messageId: "message-id",
      messageCreatedAt: f.message.createdAt,
      managedMessageAuditId: "audit-1",
      executionAuditId: "audit-2",
      occurredAt: new Date(executeAt.getTime() + 1_000),
    });
    expect(f.discord.createMessage).toHaveBeenCalledOnce();
    expect(f.discord.deleteMessage).not.toHaveBeenCalled();
  });

  it("makes a confirmed Create Message rejection terminal without replay or retry", async () => {
    const f = fixture();
    f.discord.createMessage.mockResolvedValue({ outcome: "REJECTED" });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "SEND_REJECTED",
    });
    expect(f.discord.createMessage).toHaveBeenCalledOnce();
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "SEND_REJECTED" }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
  });

  it("treats replay rejection after ambiguity as unconfirmed and never retries", async () => {
    const f = fixture();
    f.discord.createMessage
      .mockResolvedValueOnce({ outcome: "AMBIGUOUS" })
      .mockResolvedValueOnce({ outcome: "REJECTED" });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "UNCONFIRMED",
      code: "SEND_UNCONFIRMED",
    });
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.discord.createMessage).toHaveBeenCalledTimes(2);
  });

  it("stops after one same-nonce replay when both create attempts are ambiguous", async () => {
    const f = fixture();
    f.discord.createMessage.mockResolvedValue({ outcome: "AMBIGUOUS" });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "UNCONFIRMED",
      code: "SEND_UNCONFIRMED",
    });
    expect(f.discord.createMessage).toHaveBeenCalledTimes(2);
    expect(f.discord.createMessage.mock.calls[1]?.[0]).toEqual(
      f.discord.createMessage.mock.calls[0]?.[0],
    );
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "SEND_UNCONFIRMED", resultMessageId: null }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
  });

  it("accepts a null returned nonce but rejects a non-null mismatch", async () => {
    const f = fixture();
    expect(
      returnedScheduledMessageMatches(
        { ...f.message, nonce: null },
        f.executing,
        f.target,
        deriveScheduledMessageNonce("action-id"),
      ),
    ).toBe(true);
    expect(
      returnedScheduledMessageMatches(
        { ...f.message, nonce: "wrong" },
        f.executing,
        f.target,
        deriveScheduledMessageNonce("action-id"),
      ),
    ).toBe(false);

    f.discord.createMessage.mockResolvedValue({
      outcome: "CREATED",
      message: { ...f.message, nonce: "wrong" },
    });
    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "RETURNED_MESSAGE_MISMATCH",
    });
    expect(f.discord.deleteMessage).toHaveBeenCalledOnce();
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
  });

  it("keeps a returned mismatch terminal and records a known ID when deletion is unconfirmed", async () => {
    const f = fixture();
    f.discord.createMessage.mockResolvedValue({
      outcome: "CREATED",
      message: { ...f.message, channelId: "wrong-channel" },
    });
    f.discord.deleteMessage.mockResolvedValue({ outcome: "UNCONFIRMED" });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "RETURNED_MESSAGE_MISMATCH",
    });
    expect(f.discord.deleteMessage).toHaveBeenCalledOnce();
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "RETURNED_MESSAGE_MISMATCH",
        resultMessageId: "message-id",
      }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
  });

  it("does not delete or resend when finalization commit status is unknown", async () => {
    const f = fixture();
    f.store.finalizeSuccess.mockRejectedValue(new Error("ambiguous response"));

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "UNCONFIRMED",
      code: "PERSISTENCE_UNCONFIRMED",
    });
    expect(f.discord.deleteMessage).not.toHaveBeenCalled();
    expect(f.discord.createMessage).toHaveBeenCalledOnce();
    expect(f.store.failExecution).not.toHaveBeenCalled();
  });

  it("makes confirmed finalization compensation terminal without consuming retry count", async () => {
    const f = fixture();
    f.store.finalizeSuccess.mockResolvedValue("PROVEN_UNCOMMITTED");

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "FINALIZATION_FAILED_COMPENSATED",
    });
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        failureCode: "FINALIZATION_FAILED_COMPENSATED",
        resultMessageId: null,
      }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
  });

  it("records the known message and remains terminal when compensation cannot be confirmed", async () => {
    const f = fixture();
    f.store.finalizeSuccess.mockResolvedValue("PROVEN_UNCOMMITTED");
    f.discord.deleteMessage.mockResolvedValue({ outcome: "UNCONFIRMED" });

    await expect(f.executor.execute("action-id")).resolves.toEqual({
      outcome: "PERMANENT_FAILURE",
      code: "FINALIZATION_FAILED_UNCOMPENSATED",
    });
    expect(f.store.failExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: f.executing,
        failureCode: "FINALIZATION_FAILED_UNCOMPENSATED",
        resultMessageId: "message-id",
      }),
    );
    expect(f.store.retryPreSendFailure).not.toHaveBeenCalled();
    expect(f.discord.createMessage).toHaveBeenCalledOnce();
  });
});
