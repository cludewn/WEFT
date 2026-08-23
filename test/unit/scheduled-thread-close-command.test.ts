import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ScheduledAction } from "../../src/scheduled-action-persistence.js";
import {
  createScheduledThreadCloseCommandService,
  InvalidScheduledThreadCloseDurationError,
  parseScheduledThreadCloseDuration,
} from "../../src/scheduled-thread-close-command.js";
import type {
  CreateOrReplaceScheduledThreadCloseResult,
  ScheduledThreadCloseStore,
} from "../../src/scheduled-thread-close-persistence.js";
import type { ScheduledThreadCloseWorkerController } from "../../src/scheduled-thread-close-worker.js";
import type {
  SupportedThreadType,
  ThreadLifecycleDiscord,
  ThreadSnapshot,
} from "../../src/thread-lifecycle.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");

describe("scheduled thread close duration", () => {
  it.each([
    ["1m", 60_000],
    ["10m", 10 * 60_000],
    [" 30M ", 30 * 60_000],
    ["2h", 2 * 60 * 60_000],
    ["7D", 7 * 24 * 60 * 60_000],
    ["365d", 365 * 24 * 60 * 60_000],
  ])("parses %s as one bounded relative duration", (input, durationMs) => {
    expect(parseScheduledThreadCloseDuration(input, NOW)).toEqual({
      durationMs,
      executeAt: new Date(NOW.getTime() + durationMs),
    });
  });

  it.each([
    "",
    "0m",
    "0001m",
    "01m",
    "00h",
    "-1m",
    "+1m",
    "1.5h",
    "1h30m",
    "1 h",
    "60s",
    "1w",
    "366d",
    "2030-01-01T00:00:00Z",
    `${"9".repeat(1_000)}d`,
  ])("rejects unsupported or out-of-range input %s", (input) => {
    expect(() => parseScheduledThreadCloseDuration(input, NOW)).toThrow(
      InvalidScheduledThreadCloseDurationError,
    );
  });

  it("rejects invalid and overflowing execution dates", () => {
    expect(() => parseScheduledThreadCloseDuration("1m", new Date(Number.NaN))).toThrow(
      InvalidScheduledThreadCloseDurationError,
    );
    expect(() => parseScheduledThreadCloseDuration("365d", new Date(8.64e15))).toThrow(
      InvalidScheduledThreadCloseDurationError,
    );
  });
});

describe("scheduled thread close command service", () => {
  it("rejects invalid durations before reading Discord or PostgreSQL", async () => {
    const fixture = createFixture();

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "1h30m"),
    ).resolves.toEqual({ ok: false, code: "INVALID_DURATION" });

    expect(fixture.discord.fetchThread).not.toHaveBeenCalled();
    expect(fixture.schedules.createOrReplace).not.toHaveBeenCalled();
    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
  });

  it.each<[string, SupportedThreadType]>([
    ["announcement thread", ChannelType.AnnouncementThread],
    ["public thread or forum-post representation", ChannelType.PublicThread],
    ["accessible private thread", ChannelType.PrivateThread],
  ])("creates a close for a supported %s", async (_description, type) => {
    const fixture = createFixture({ thread: createThread({ type }) });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toMatchObject({ ok: true, outcome: "CREATED" });

    expect(fixture.discord.actorCanManage).toHaveBeenCalledWith(
      "guild-id",
      "thread-id",
      "actor-id",
    );
    expect(fixture.discord.botCanManage).toHaveBeenCalledWith("guild-id", "thread-id");
    expect(fixture.schedules.createOrReplace).toHaveBeenCalledWith({
      scheduledActionId: "scheduled-action-id",
      auditId: "audit-id",
      guildId: "guild-id",
      threadId: "thread-id",
      actorId: "actor-id",
      executeAt: new Date("2030-01-01T00:30:00.000Z"),
    });
    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledWith(
      "scheduled-action-id",
      new Date("2030-01-01T00:30:00.000Z"),
    );
  });

  it.each([
    [null, "UNSUPPORTED_CONTEXT"],
    [createThread({ archived: true }), "THREAD_NOT_ACTIVE"],
    [createThread({ locked: true }), "THREAD_LOCKED"],
  ] as const)("rejects an invalid current thread state", async (thread, code) => {
    const fixture = createFixture({ thread });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toEqual({ ok: false, code });

    expect(fixture.schedules.createOrReplace).not.toHaveBeenCalled();
    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
  });

  it.each([
    [false, true, "USER_MISSING_PERMISSION"],
    [true, false, "BOT_MISSING_PERMISSION"],
  ] as const)(
    "requires current actor and bot thread-management permissions",
    async (actorCanManage, botCanManage, code) => {
      const fixture = createFixture({ actorCanManage, botCanManage });

      await expect(
        fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
      ).resolves.toEqual({ ok: false, code });

      expect(fixture.schedules.createOrReplace).not.toHaveBeenCalled();
    },
  );

  it("returns a safe validation failure when a Discord boundary rejects", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.discord.fetchThread).mockRejectedValueOnce(
      new Error("sensitive Discord failure"),
    );

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toEqual({ ok: false, code: "CONTEXT_VALIDATION_FAILURE" });

    expect(fixture.schedules.createOrReplace).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("sensitive");
  });

  it("reports replacement while leaving old delivery cleanup to existing runtime recovery", async () => {
    const previousAction = createAction({ id: "previous-action-id", status: "CANCELLED" });
    const action = createAction();
    const fixture = createFixture({
      persistenceResult: { outcome: "REPLACED", action, previousAction },
      enqueueResult: "ALREADY_PRESENT",
    });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toEqual({ ok: true, outcome: "REPLACED", action });

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(fixture.delivery.cancelStaleActiveDeliveries).not.toHaveBeenCalled();
  });

  it("does not enqueue when an execution already owns the active slot", async () => {
    const current = createAction({ status: "EXECUTING" });
    const fixture = createFixture({
      persistenceResult: { outcome: "EXECUTION_IN_PROGRESS", current },
    });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toEqual({ ok: false, code: "EXECUTION_IN_PROGRESS" });

    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
  });

  it("confirms enqueue response loss through the existing public delivery lookup", async () => {
    const fixture = createFixture({ enqueueFailure: new Error("opaque"), deliveryExists: true });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toMatchObject({ ok: true, outcome: "CREATED" });

    expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(fixture.delivery.hasCreatedOrRetryDelivery).toHaveBeenCalledWith("scheduled-action-id");
  });

  it.each([false, "LOOKUP_FAILURE"] as const)(
    "returns saved delivery pending when enqueue cannot be confirmed",
    async (deliveryConfirmation) => {
      const fixture = createFixture({
        enqueueFailure: new Error("sensitive enqueue failure"),
        deliveryExists: deliveryConfirmation === false ? false : new Error("sensitive lookup"),
      });

      await expect(
        fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
      ).resolves.toMatchObject({
        ok: true,
        outcome: "SAVED_DELIVERY_PENDING",
        savedAs: "CREATED",
      });

      expect(fixture.delivery.enqueueScheduledThreadClose).toHaveBeenCalledOnce();
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "scheduled_thread_close_delivery_unconfirmed",
          scheduledActionId: "scheduled-action-id",
        }),
        "Scheduled thread close delivery could not be confirmed",
      );
      expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("sensitive");
    },
  );

  it("reports persistence failure without attempting delivery or logging raw errors", async () => {
    const fixture = createFixture({ persistenceFailure: new Error("sensitive DB failure") });

    await expect(
      fixture.service.schedule("guild-id", "thread-id", "actor-id", "30m"),
    ).resolves.toEqual({ ok: false, code: "PERSISTENCE_FAILURE" });

    expect(fixture.delivery.enqueueScheduledThreadClose).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("sensitive DB failure");
  });
});

function createFixture({
  thread = createThread(),
  actorCanManage = true,
  botCanManage = true,
  persistenceResult,
  persistenceFailure,
  enqueueResult = "ENQUEUED",
  enqueueFailure,
  deliveryExists = false,
}: {
  thread?: ThreadSnapshot | null;
  actorCanManage?: boolean;
  botCanManage?: boolean;
  persistenceResult?: CreateOrReplaceScheduledThreadCloseResult;
  persistenceFailure?: Error;
  enqueueResult?: "ENQUEUED" | "ALREADY_PRESENT";
  enqueueFailure?: Error;
  deliveryExists?: boolean | Error;
} = {}) {
  const action = createAction();
  const discord = {
    fetchThread: vi.fn(() => Promise.resolve(thread ?? undefined)),
    actorCanManage: vi.fn(() => Promise.resolve(actorCanManage)),
    botCanManage: vi.fn(() => Promise.resolve(botCanManage)),
  } as Pick<ThreadLifecycleDiscord, "fetchThread" | "actorCanManage" | "botCanManage">;
  const createOrReplace = vi.fn<ScheduledThreadCloseStore["createOrReplace"]>(() => {
    if (persistenceFailure !== undefined) {
      return Promise.reject(persistenceFailure);
    }
    return Promise.resolve(persistenceResult ?? { outcome: "CREATED", action });
  });
  const enqueueScheduledThreadClose = vi.fn<
    ScheduledThreadCloseWorkerController["enqueueScheduledThreadClose"]
  >(() =>
    enqueueFailure === undefined ? Promise.resolve(enqueueResult) : Promise.reject(enqueueFailure),
  );
  const hasCreatedOrRetryDelivery = vi.fn<
    ScheduledThreadCloseWorkerController["hasCreatedOrRetryDelivery"]
  >(() =>
    deliveryExists instanceof Error
      ? Promise.reject(deliveryExists)
      : Promise.resolve(deliveryExists),
  );
  const cancelStaleActiveDeliveries = vi.fn();
  const delivery = {
    enqueueScheduledThreadClose,
    hasCreatedOrRetryDelivery,
    cancelStaleActiveDeliveries,
  } as unknown as ScheduledThreadCloseWorkerController;
  const logger = { warn: vi.fn() };
  const ids = ["scheduled-action-id", "audit-id"];
  const service = createScheduledThreadCloseCommandService({
    discord,
    schedules: { createOrReplace },
    delivery,
    logger,
    now: () => NOW,
    generateId: () => ids.shift()!,
  });

  return { service, discord, schedules: { createOrReplace }, delivery, logger };
}

function createThread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    guildId: "guild-id",
    threadId: "thread-id",
    type: ChannelType.PublicThread,
    name: "Topic",
    archived: false,
    locked: false,
    ...overrides,
  };
}

function createAction(overrides: Partial<ScheduledAction> = {}): ScheduledAction {
  return {
    id: "scheduled-action-id",
    guildId: "guild-id",
    actionType: "CLOSE_THREAD",
    targetId: "thread-id",
    status: "ACTIVE",
    executeAt: new Date("2030-01-01T00:30:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}
