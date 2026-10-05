import type { GuildSettingsStore } from "../../src/guild-settings.js";
import { parseOneTimeScheduleOptions } from "../../src/one-time-message-schedule.js";
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
  const logger = { warn: vi.fn() };
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
  const getOrCreate = vi.fn<GuildSettingsStore["getOrCreate"]>(() =>
    Promise.resolve({
      guildId: "guild-id",
      timezone: "UTC",
      closedPrefix: "[CLOSED]",
      linkPreviewMode: "hybrid",
      auditLogChannelId: null,
      autoCloseInactivitySeconds: 604800,
      autoCloseBotMessagesCountAsActivity: false,
      createdAt: establishedAt,
      updatedAt: establishedAt,
    }),
  );
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
    guildSettings: { getOrCreate },
  });
  return {
    service,
    now,
    getOrCreate,
    logger,
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
      schedule: { kind: "AFTER", durationMs: 3_600_000 },
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
        schedule: { kind: "AFTER", durationMs: 60_000 },
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
        schedule: { kind: "AFTER", durationMs: 3_600_000 },
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
        schedule: { kind: "AFTER", durationMs: 3_600_000 },
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
        schedule: { kind: "AFTER", durationMs: 7_200_000 },
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
        schedule: { kind: "AFTER", durationMs: 60_000 },
      }),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: { revision: 1, action: { executeAt: newExecuteAt } },
      deliveryPendingReconciliation: true,
    });
    expect(f.reschedule).toHaveBeenCalledTimes(1);
  });
});

const createInput = {
  guildId: "guild-id",
  channelId: "channel-id",
  actorUserId: "actor-id",
  payload: { content: "scheduled content", embed: null },
};
const rescheduleInput = { ...createInput, scheduledActionId: "schedule-id" };
const absolute = { kind: "AT", localDateTime: "2030-01-02 12:06" } as const;

async function timezone(f: ReturnType<typeof fixture>, value: string) {
  f.getOrCreate.mockResolvedValue({ ...(await f.getOrCreate("guild-id")), timezone: value });
  f.getOrCreate.mockClear();
}

function editable(f: ReturnType<typeof fixture>) {
  f.findEditable.mockResolvedValue({ outcome: "ACTIVE", definition: f.definition });
  f.reschedule.mockImplementation((input) =>
    Promise.resolve({
      outcome: "RESCHEDULED",
      definition: {
        ...f.definition,
        revision: input.expectedRevision + 1,
        action: { ...f.definition.action, executeAt: input.executeAt },
      },
    }),
  );
}

describe("one-time selector application authority", () => {
  it("normalizes AT in the current Tokyo timezone with one clock and canonical audit/projection input", async () => {
    const f = fixture();
    await timezone(f, "asia/tokyo");
    await expect(f.service.create({ ...createInput, schedule: absolute })).resolves.toMatchObject({
      outcome: "SUCCESS",
      definition: { action: { executeAt: new Date("2030-01-02T03:06:00Z") } },
    });
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(f.getOrCreate).toHaveBeenCalledWith("guild-id");
    expect(f.authorizeCreation.mock.invocationCallOrder[0]).toBeLessThan(
      f.getOrCreate.mock.invocationCallOrder[0]!,
    );
    expect(f.getOrCreate.mock.invocationCallOrder[0]).toBeLessThan(
      f.now.mock.invocationCallOrder[0]!,
    );
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        executeAt: new Date("2030-01-02T03:06:00Z"),
        occurredAt: establishedAt,
      }),
    );
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty("schedule");
    expect(f.create.mock.calls[0]![0]).not.toHaveProperty("timezone");
    expect(f.ensureScheduledMessageDelivery).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      executeAt: new Date("2030-01-02T03:06:00Z"),
      revision: 0,
    });
  });

  it("uses UTC and produces the same instant for equivalent AFTER/AT inputs", async () => {
    const f = fixture();
    f.now.mockReturnValue(new Date("2030-01-02T03:05:00Z"));
    await f.service.create({
      ...createInput,
      schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" },
    });
    const at = f.create.mock.calls[0]![0].executeAt;
    f.getOrCreate.mockClear();
    await f.service.create({ ...createInput, schedule: { kind: "AFTER", durationMs: 60_000 } });
    expect(f.create.mock.calls[1]![0].executeAt).toEqual(at);
    expect(f.getOrCreate).not.toHaveBeenCalled();
    expect(f.now).toHaveBeenCalledTimes(2);
  });

  it.each(["create", "reschedule"] as const)(
    "rejects AT made too soon during %s preflight using only the final clock",
    async (operation) => {
      const f = fixture();
      let clock = new Date("2030-01-02T03:04:00Z");
      f.now.mockImplementation(() => clock);
      const selector = parseOneTimeScheduleOptions(null, "2030-01-02 03:06");
      expect(selector.ok).toBe(true);
      if (!selector.ok) throw new Error("invalid test input");
      if (operation === "create") {
        f.authorizeCreation.mockImplementation(() => {
          clock = new Date("2030-01-02T03:05:00.001Z");
          return Promise.resolve({ outcome: "AUTHORIZED" });
        });
        await expect(
          f.service.create({ ...createInput, schedule: selector.schedule }),
        ).resolves.toEqual({ outcome: "FAILURE", code: "TOO_SOON" });
      } else {
        editable(f);
        f.findEditable.mockImplementation(() => {
          clock = new Date("2030-01-02T03:05:00.001Z");
          return Promise.resolve({ outcome: "ACTIVE", definition: f.definition });
        });
        await expect(
          f.service.reschedule({ ...rescheduleInput, schedule: selector.schedule }),
        ).resolves.toEqual({ outcome: "TOO_SOON" });
      }
      expect(f.now).toHaveBeenCalledTimes(1);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.reschedule).not.toHaveBeenCalled();
      expect(f.ensureScheduledMessageDelivery).not.toHaveBeenCalled();
    },
  );

  it("captures the clock after timezone lookup completes", async () => {
    const f = fixture();
    const settings = await f.getOrCreate("guild-id");
    f.getOrCreate.mockImplementation(() => {
      f.now.mockReturnValue(new Date("2030-01-02T03:05:30Z"));
      return Promise.resolve(settings);
    });
    await expect(
      f.service.create({
        ...createInput,
        schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "TOO_SOON" });
    expect(f.now).toHaveBeenCalledTimes(1);
  });

  it("preserves AFTER establishment after preflight delay and avoids timezone lookup", async () => {
    const f = fixture();
    const delayed = new Date(establishedAt.getTime() + 3_600_000);
    f.authorizeCreation.mockImplementation(() => {
      f.now.mockReturnValue(delayed);
      return Promise.resolve({ outcome: "AUTHORIZED" });
    });
    await f.service.create({ ...createInput, schedule: { kind: "AFTER", durationMs: 60_000 } });
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        executeAt: new Date(delayed.getTime() + 60_000),
        occurredAt: delayed,
      }),
    );
    expect(f.getOrCreate).not.toHaveBeenCalled();
    expect(f.now).toHaveBeenCalledTimes(1);
  });

  it.each(["create", "reschedule"] as const)(
    "returns bounded saved-timezone and availability failures for %s",
    async (operation) => {
      for (const zone of ["JST", "invalid/saved-zone", "+09:00", "-05:00", ""]) {
        const f = fixture();
        editable(f);
        await timezone(f, zone);
        const result =
          operation === "create"
            ? await f.service.create({ ...createInput, schedule: absolute })
            : await f.service.reschedule({ ...rescheduleInput, schedule: absolute });
        expect(result).toEqual(
          operation === "create"
            ? { outcome: "FAILURE", code: "INVALID_GUILD_TIMEZONE" }
            : { outcome: "INVALID_GUILD_TIMEZONE" },
        );
        expect(f.now).not.toHaveBeenCalled();
        expect(f.create).not.toHaveBeenCalled();
        expect(f.reschedule).not.toHaveBeenCalled();
      }
      const f = fixture();
      editable(f);
      f.getOrCreate.mockRejectedValue(new Error("private database details"));
      const result =
        operation === "create"
          ? await f.service.create({ ...createInput, schedule: absolute })
          : await f.service.reschedule({ ...rescheduleInput, schedule: absolute });
      expect(result).toEqual(
        operation === "create"
          ? { outcome: "FAILURE", code: "TIMEZONE_UNAVAILABLE" }
          : { outcome: "TIMEZONE_UNAVAILABLE" },
      );
      expect(f.now).not.toHaveBeenCalled();
      expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("private database details");
    },
  );

  it.each([
    ["2030-02-29 12:00", "UTC", "INVALID_AT_DATE"],
    ["2030-01-02T12:00", "UTC", "INVALID_AT_FORMAT"],
    ["2030-03-10 02:30", "America/New_York", "DST_GAP"],
    ["2030-11-03 01:30", "America/New_York", "DST_OVERLAP"],
    ["2030-01-02 03:05", "UTC", "TOO_SOON"],
    ["2031-01-03 03:05", "UTC", "TOO_FAR"],
  ])(
    "authoritatively revalidates %s and does not persist or project",
    async (localDateTime, zone, code) => {
      const f = fixture();
      await timezone(f, zone);
      await expect(
        f.service.create({ ...createInput, schedule: { kind: "AT", localDateTime } }),
      ).resolves.toEqual({ outcome: "FAILURE", code });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.ensureScheduledMessageDelivery).not.toHaveBeenCalled();
    },
  );

  it("uses the reschedule operation's current timezone and replaces the old instant with the current revision", async () => {
    const f = fixture();
    editable(f);
    await timezone(f, "Asia/Tokyo");
    await expect(
      f.service.reschedule({ ...rescheduleInput, schedule: absolute }),
    ).resolves.toMatchObject({
      outcome: "RESCHEDULED",
      definition: {
        revision: 1,
        action: { executeAt: new Date("2030-01-02T03:06:00Z") },
        payload: f.definition.payload,
        creatorUserId: f.definition.creatorUserId,
        retryCount: 0,
        resultMessageId: null,
      },
    });
    expect(f.reschedule).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        executeAt: new Date("2030-01-02T03:06:00Z"),
        occurredAt: establishedAt,
      }),
    );
    expect(f.now).toHaveBeenCalledTimes(1);
    await timezone(f, "UTC");
    await f.service.reschedule({ ...rescheduleInput, schedule: absolute });
    expect(f.reschedule.mock.calls[1]![0].executeAt).toEqual(new Date("2030-01-02T12:06:00Z"));
  });

  it.each(["EXECUTING", "CANCELLED", "COMPLETED", "FAILED"] as const)(
    "preserves %s rejection before timezone lookup or clock access",
    async (outcome) => {
      const f = fixture();
      f.findEditable.mockResolvedValue({ outcome });
      await expect(
        f.service.reschedule({ ...rescheduleInput, schedule: absolute }),
      ).resolves.toEqual({ outcome });
      expect(f.getOrCreate).not.toHaveBeenCalled();
      expect(f.now).not.toHaveBeenCalled();
      expect(f.reschedule).not.toHaveBeenCalled();
    },
  );

  it("does not introduce a no-op for the same canonical execution instant", async () => {
    const f = fixture();
    editable(f);
    f.now.mockReturnValue(new Date("2030-01-02T03:04:00Z"));
    f.definition.action.executeAt = new Date("2030-01-02T03:06:00Z");
    await expect(
      f.service.reschedule({
        ...rescheduleInput,
        schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" },
      }),
    ).resolves.toMatchObject({ outcome: "RESCHEDULED", definition: { revision: 1 } });
    expect(f.reschedule).toHaveBeenCalledTimes(1);
  });

  it("preserves persistence uncertainty without projecting delivery", async () => {
    const f = fixture();
    f.create.mockRejectedValue(new Error("private database details"));
    await expect(f.service.create({ ...createInput, schedule: absolute })).resolves.toEqual({
      outcome: "FAILURE",
      code: "PERSISTENCE_UNCONFIRMED",
    });
    expect(f.ensureScheduledMessageDelivery).not.toHaveBeenCalled();
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("private database details");
  });
});

describe("absolute normalization preserves existing delivery boundaries", () => {
  it.each(["create", "reschedule"] as const)(
    "leaves %s committed when AT projection fails",
    async (operation) => {
      const f = fixture();
      editable(f);
      f.ensureScheduledMessageDelivery.mockRejectedValue(new Error("projection unavailable"));
      const result =
        operation === "create"
          ? await f.service.create({ ...createInput, schedule: absolute })
          : await f.service.reschedule({ ...rescheduleInput, schedule: absolute });
      expect(result).toMatchObject({
        outcome: operation === "create" ? "SUCCESS" : "RESCHEDULED",
        deliveryPendingReconciliation: true,
      });
      expect(f.now).toHaveBeenCalledTimes(1);
      expect(operation === "create" ? f.create : f.reschedule).toHaveBeenCalledTimes(1);
    },
  );

  it("does not revalidate minimum lead time at persistence commit", async () => {
    const f = fixture();
    f.now.mockReturnValue(new Date("2030-01-02T03:05:00Z"));
    f.create.mockImplementation((input) => {
      f.now.mockReturnValue(new Date("2030-01-02T03:07:00Z"));
      return Promise.resolve({
        ...f.definition,
        action: { ...f.definition.action, executeAt: input.executeAt },
      });
    });
    await expect(
      f.service.create({
        ...createInput,
        schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" },
      }),
    ).resolves.toMatchObject({ outcome: "SUCCESS" });
    expect(f.now).toHaveBeenCalledTimes(1);
    expect(f.ensureScheduledMessageDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ executeAt: new Date("2030-01-02T03:06:00Z") }),
    );
  });

  it.each([59_999, 31_536_000_001, NaN])(
    "revalidates invalid AFTER milliseconds %s",
    async (durationMs) => {
      const f = fixture();
      await expect(
        f.service.create({ ...createInput, schedule: { kind: "AFTER", durationMs } }),
      ).resolves.toEqual({ outcome: "FAILURE", code: "INVALID_DURATION" });
      expect(f.create).not.toHaveBeenCalled();
      expect(f.getOrCreate).not.toHaveBeenCalled();
    },
  );
});
