import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createScheduledMessageCommandService } from "../../src/scheduled-message-command.js";
import type { ScheduledMessageCreationDiscord } from "../../src/scheduled-message-discord.js";
import type { ScheduledMessageStore } from "../../src/scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "../../src/scheduled-message-worker.js";

const establishedAt = new Date("2030-01-02T03:04:05.678Z");
const executeAt = new Date("2030-01-02T04:04:05.678Z");

function fixture() {
  const callOrder: string[] = [];
  const definition = {
    action: {
      id: "schedule-id",
      guildId: "guild-id",
      actionType: "SEND_MESSAGE" as const,
      targetId: "channel-id",
      status: "ACTIVE" as const,
      executeAt,
      createdAt: establishedAt,
      updatedAt: establishedAt,
    },
    creatorUserId: "actor-id",
    retryCount: 0,
    revision: 0,
    payload: { content: "scheduled content", embed: null },
    resultMessageId: null,
  };
  const authorizeCreation = vi.fn<ScheduledMessageCreationDiscord["authorizeCreation"]>(() => {
    callOrder.push("authorize");
    return Promise.resolve({ outcome: "AUTHORIZED" as const });
  });
  const create = vi.fn<ScheduledMessageStore["create"]>((input) => {
    callOrder.push("persist");
    return Promise.resolve({
      ...definition,
      action: { ...definition.action, executeAt: input.executeAt },
      payload: input.payload,
    });
  });
  const cancel = vi.fn<ScheduledMessageStore["cancel"]>(() =>
    Promise.resolve({ outcome: "CANCELLED", definition }),
  );
  const findStatus = vi.fn<ScheduledMessageStore["findStatus"]>(() =>
    Promise.resolve({
      outcome: "FOUND",
      schedule: {
        scheduledActionId: "schedule-id",
        status: "ACTIVE",
        guildId: "guild-id",
        channelId: "channel-id",
        executeAt,
        creatorUserId: "actor-id",
        retryCount: 0,
        resultMessageId: null,
      },
    }),
  );
  const ensureScheduledMessageDelivery = vi.fn<
    ScheduledMessageWorkerController["ensureScheduledMessageDelivery"]
  >(() => Promise.resolve("CURRENT"));
  const cancelScheduledMessageDeliveries = vi.fn<
    ScheduledMessageWorkerController["cancelScheduledMessageDeliveries"]
  >(() => Promise.resolve({ outcome: "CONFIRMED", matchedDeliveryCount: 1 }));
  const generateId = vi
    .fn<() => string>()
    .mockReturnValueOnce("schedule-id")
    .mockReturnValueOnce("creation-audit-id")
    .mockReturnValueOnce("cancellation-audit-id");
  const now = vi.fn(() => establishedAt);
  const logger = { warn: vi.fn() } as unknown as Logger;
  const listNonterminal = vi.fn<ScheduledMessageStore["listNonterminal"]>(() =>
    Promise.resolve({ outcome: "FOUND", schedules: [] }),
  );
  const findEditable = vi.fn<ScheduledMessageStore["findEditable"]>(() =>
    Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
  );
  const edit = vi.fn<ScheduledMessageStore["edit"]>(() =>
    Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
  );
  const reschedule = vi.fn<ScheduledMessageStore["reschedule"]>(() =>
    Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
  );
  const find = vi.fn(() => Promise.resolve(definition));
  const service = createScheduledMessageCommandService({
    discord: { authorizeCreation },
    store: {
      create,
      cancel,
      findStatus,
      listNonterminal,
      findEditable,
      edit,
      reschedule,
      find,
    },
    delivery: {
      ensureScheduledMessageDelivery,
      cancelScheduledMessageDeliveries,
    },
    generateId,
    now,
    logger,
  });
  return {
    service,
    callOrder,
    authorizeCreation,
    create,
    cancel,
    findStatus,
    definition,
    findEditable,
    edit,
    reschedule,
    find,
    ensureScheduledMessageDelivery,
    cancelScheduledMessageDeliveries,
  };
}

describe("scheduled message command service", () => {
  it("freshly authorizes before capturing one establishment timestamp and persisting", async () => {
    const f = fixture();
    const result = await f.service.create({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      durationMs: 3_600_000,
      payload: { content: "scheduled content", embed: null },
    });

    expect(result).toMatchObject({ outcome: "SUCCESS", deliveryPendingReconciliation: false });
    expect(f.callOrder).toEqual(["authorize", "persist"]);
    expect(f.create).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      auditId: "creation-audit-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorId: "actor-id",
      executeAt,
      payload: { content: "scheduled content", embed: null },
      occurredAt: establishedAt,
    });
    expect(f.ensureScheduledMessageDelivery).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      executeAt,
      revision: 0,
    });
  });

  it("does not persist or enqueue when fresh authorization fails", async () => {
    const f = fixture();
    f.authorizeCreation.mockResolvedValue({
      outcome: "FAILURE",
      code: "ACTOR_PERMISSION_MISSING",
    });
    await expect(
      f.service.create({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        durationMs: 60_000,
        payload: { content: "scheduled content", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.ensureScheduledMessageDelivery).not.toHaveBeenCalled();
  });

  it("accepts a confirmed effective delivery", async () => {
    const f = fixture();
    f.ensureScheduledMessageDelivery.mockResolvedValue("CURRENT");
    await expect(
      f.service.create({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        durationMs: 3_600_000,
        payload: { content: "scheduled content", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "SUCCESS", deliveryPendingReconciliation: false });
  });

  it("keeps the authoritative schedule active when delivery needs reconciliation", async () => {
    const f = fixture();
    f.ensureScheduledMessageDelivery.mockResolvedValue("PENDING_RECONCILIATION");
    await expect(
      f.service.create({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        durationMs: 3_600_000,
        payload: { content: "scheduled content", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "SUCCESS", deliveryPendingReconciliation: true });
  });

  it("cleans delivery only after confirmed cancellation and preserves cancellation on cleanup failure", async () => {
    const f = fixture();
    f.cancelScheduledMessageDeliveries.mockResolvedValue({
      outcome: "UNCONFIRMED",
      matchedDeliveryCount: 1,
    });
    await expect(
      f.service.cancel({
        scheduledActionId: "schedule-id",
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
      }),
    ).resolves.toEqual({ outcome: "CANCELLED", deliveryCleanupPending: true });

    f.cancel.mockResolvedValue({ outcome: "EXECUTING" });
    await expect(
      f.service.cancel({
        scheduledActionId: "schedule-id",
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
      }),
    ).resolves.toEqual({ outcome: "EXECUTING" });
    expect(f.cancelScheduledMessageDeliveries).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid list pages before persistence", async () => {
    const f = fixture();
    await expect(
      f.service.list({ guildId: "guild-id", channelId: "channel-id", page: 0 }),
    ).resolves.toEqual({ outcome: "INVALID_PAGE" });
  });

  it("reschedules relative to one establishment time and repairs the authoritative projection", async () => {
    const f = fixture();
    f.findEditable.mockResolvedValue({ outcome: "ACTIVE", definition: f.definition });
    const newExecuteAt = new Date(establishedAt.getTime() + 7_200_000);
    const rescheduled = {
      ...f.definition,
      revision: 1,
      action: { ...f.definition.action, executeAt: newExecuteAt },
    };
    f.reschedule.mockResolvedValue({ outcome: "RESCHEDULED", definition: rescheduled });
    f.find.mockResolvedValue(rescheduled);

    await expect(
      f.service.reschedule({
        scheduledActionId: "schedule-id",
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "administrator-id",
        durationMs: 7_200_000,
      }),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: { revision: 1, action: { executeAt: newExecuteAt } },
      deliveryPendingReconciliation: false,
    });
    expect(f.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        executeAt: newExecuteAt,
        occurredAt: establishedAt,
      }),
    );
    expect(f.ensureScheduledMessageDelivery).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      executeAt: newExecuteAt,
      revision: 1,
    });
  });

  it("keeps a committed reschedule authoritative when delivery repair fails", async () => {
    const f = fixture();
    f.findEditable.mockResolvedValue({ outcome: "ACTIVE", definition: f.definition });
    const newExecuteAt = new Date(establishedAt.getTime() + 60_000);
    const rescheduled = {
      ...f.definition,
      revision: 1,
      action: { ...f.definition.action, executeAt: newExecuteAt },
    };
    f.reschedule.mockResolvedValue({ outcome: "RESCHEDULED", definition: rescheduled });
    f.find.mockResolvedValue(rescheduled);
    f.ensureScheduledMessageDelivery.mockRejectedValue(new Error("pg-boss unavailable"));

    await expect(
      f.service.reschedule({
        scheduledActionId: "schedule-id",
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "administrator-id",
        durationMs: 60_000,
      }),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: { revision: 1, action: { executeAt: newExecuteAt } },
      deliveryPendingReconciliation: true,
    });
    expect(f.reschedule).toHaveBeenCalledTimes(1);
  });
});
