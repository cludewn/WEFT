import { ChannelType } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createGuildConfigurationService } from "../../src/guild-configuration.js";
import { createConfigurationAuditContext } from "../../src/guild-configuration-audit.js";
import { createAutomaticCloseConfigurationService } from "../../src/automatic-close-configuration.js";
import { createAutomaticCloseThreadMaintenanceService } from "../../src/automatic-close-thread-maintenance.js";
import { createAuditLogDestinationService } from "../../src/audit-log-destination.js";
import { createLinkPreviewConfiguration } from "../../src/link-preview-configuration.js";
import { createScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import { createScheduledMessageCommandService } from "../../src/scheduled-message-command.js";
import type {
  AdministrativeAttempt,
  AdministrativeTransactionEvidence,
} from "../../src/administrative-transaction.js";
import type {
  AdministrativeFailureRecorder,
  AdministrativeOperation,
} from "../../src/administrative-operation-failure-audit.js";
import type { GuildSettingsStore } from "../../src/guild-settings.js";
import type { AutomaticClosePersistenceStore } from "../../src/automatic-close-persistence.js";
import type {
  ScheduledMessageStore,
  ScheduledMessageDefinition,
} from "../../src/scheduled-message-persistence.js";
import type { RecurringMessageStore } from "../../src/recurring-message-persistence.js";
import type { BulkThreadCloseHooks } from "../../src/thread-lifecycle.js";

const guildId = "111111111111111111",
  actorUserId = "222222222222222222",
  channelId = "333333333333333333",
  threadId = "444444444444444444",
  scheduleId = "12345678-1234-4234-8234-123456789abc";
const at = new Date("2030-01-01T00:00:00Z");
const scope = { guildId, channelId, actorUserId, scheduledActionId: scheduleId };
const definition = {
  action: {
    id: scheduleId,
    guildId,
    targetId: channelId,
    status: "ACTIVE",
    executeAt: new Date("2030-01-01T01:00:00Z"),
  },
  revision: 0,
  payload: { content: "before", embed: null },
  recurrence: { timezone: "UTC" },
} as unknown as ScheduledMessageDefinition;
const recurrence = { frequency: "daily", time: "09:00", timezone: "UTC" };

function fixture(
  evidence: AdministrativeTransactionEvidence = {
    disposition: "ROLLED_BACK",
    callbackEntered: true,
    commitAttempted: false,
  },
) {
  const record = vi.fn<AdministrativeFailureRecorder["record"]>(async () => {});
  const failures = { record };
  const logger = { warn: vi.fn() };
  const rollback = (input: { administrativeAttempt?: AdministrativeAttempt }) => {
    if (input.administrativeAttempt) input.administrativeAttempt.transactionEvidence = evidence;
  };
  const scalar = vi.fn(
    (_guild: string, _value: unknown, input: { administrativeAttempt?: AdministrativeAttempt }) => {
      rollback(input);
      return Promise.resolve({ outcome: "UNCONFIRMED" });
    },
  );
  const settings = {
    setTimezone: scalar,
    setClosedPrefix: scalar,
    setAutoCloseInactivitySeconds: scalar,
    setAutoCloseBotMessagesCountAsActivity: scalar,
    getOrCreate: () => Promise.resolve({ timezone: "UTC" }),
    readTimezone: () => Promise.resolve("UTC"),
  } as unknown as GuildSettingsStore;
  const policy = {
    listParentChannels: () => Promise.resolve([]),
    enableParentChannelWithBaselines: (input: {
      administrativeAttempt?: AdministrativeAttempt;
    }) => {
      rollback(input);
      return Promise.resolve({ outcome: "UNCONFIRMED" });
    },
    removeParentChannel: (
      _guild: string,
      _target: string,
      input: { administrativeAttempt?: AdministrativeAttempt },
    ) => {
      rollback(input);
      return Promise.resolve({ outcome: "UNCONFIRMED" });
    },
    trackThread: (input: { administrativeAttempt?: AdministrativeAttempt }) => {
      rollback(input);
      return Promise.resolve({ outcome: "UNCONFIRMED" });
    },
    addThreadExclusion: (
      _guild: string,
      _target: string,
      input: { administrativeAttempt?: AdministrativeAttempt },
    ) => {
      rollback(input);
      return Promise.resolve({ outcome: "UNCONFIRMED" });
    },
  } as unknown as AutomaticClosePersistenceStore;
  const config = createGuildConfigurationService(settings, failures);
  const automatic = createAutomaticCloseConfigurationService({
    guildSettings: settings,
    schedules: policy,
    discord: { fetchActiveThreadSummaries: () => Promise.resolve([]) },
    logger,
    failures,
  });
  const maintenance = createAutomaticCloseThreadMaintenanceService({
    discord: {
      inspectThread: () => Promise.resolve({ parentChannelId: channelId, actorCanManage: true }),
    },
    persistence: policy,
    scheduledActions: { findCurrentThreadClose: () => Promise.resolve(undefined) },
    logger,
    failures,
  });
  const destination = createAuditLogDestinationService(
    {
      read: () => Promise.resolve(null),
      change: (input) => {
        rollback(input);
        return Promise.resolve({ outcome: "UNCONFIRMED" });
      },
    },
    { preflight: () => Promise.resolve({ ok: true, targetId: channelId }) },
    failures,
  );
  const preview = createLinkPreviewConfiguration(
    {
      read: () => Promise.resolve("hybrid"),
      change: (input) => {
        rollback(input);
        return Promise.resolve({ outcome: "UNCONFIRMED" });
      },
    },
    failures,
  );
  const close = createScheduledThreadCloseCommandService({
    discord: {
      fetchThread: () =>
        Promise.resolve({
          guildId,
          threadId,
          type: ChannelType.PublicThread,
          name: "thread",
          archived: false,
          locked: false,
        }),
      actorCanManage: () => Promise.resolve(true),
      botCanManage: () => Promise.resolve(true),
    },
    schedules: {
      createOrReplace: (input) => {
        rollback(input);
        return Promise.reject(new Error("business rejected"));
      },
      cancel: (input) => {
        rollback(input);
        return Promise.reject(new Error("business rejected"));
      },
    },
    delivery: {
      enqueueScheduledThreadClose: () => Promise.resolve("ENQUEUED"),
      hasCreatedOrRetryDelivery: () => Promise.resolve(false),
    },
    threadLifecycle: {
      close: async (_guild, _thread, _actor, prepare) => {
        await prepare?.();
        return { ok: true, changed: false };
      },
    },
    logger,
    failures,
    now: () => at,
  });
  let kind: "ONE_TIME" | "RECURRING" = "ONE_TIME";
  const unconfirmed = (input: { administrativeAttempt?: AdministrativeAttempt }) => {
    rollback(input);
    return Promise.resolve({ outcome: "PERSISTENCE_UNCONFIRMED" });
  };
  const messageStore = {
    create: (input: { administrativeAttempt?: AdministrativeAttempt }) => {
      rollback(input);
      return Promise.reject(new Error("business rejected"));
    },
    cancel: unconfirmed,
    edit: unconfirmed,
    reschedule: unconfirmed,
    findEditable: () => Promise.resolve({ outcome: "ACTIVE", definition }),
    find: () => Promise.resolve(definition),
  } as unknown as ScheduledMessageStore;
  const recurring = {
    create: unconfirmed,
    editPayload: unconfirmed,
    editRecurrence: unconfirmed,
    cancel: unconfirmed,
    find: () => Promise.resolve(definition),
  } as unknown as RecurringMessageStore;
  const messages = createScheduledMessageCommandService({
    discord: {
      authorizeCreation: async (input) => {
        await input.afterActorAuthorized?.();
        return { outcome: "AUTHORIZED" };
      },
    },
    store: messageStore,
    recurring,
    administration: { findKind: () => Promise.resolve(kind) } as unknown as NonNullable<
      Parameters<typeof createScheduledMessageCommandService>[0]["administration"]
    >,
    recurringWorker: { project: () => Promise.resolve("CURRENT") },
    guildSettings: settings,
    delivery: {
      ensureScheduledMessageDelivery: () => Promise.resolve("CURRENT"),
      cancelScheduledMessageDeliveries: () =>
        Promise.resolve({
          outcome: "CONFIRMED",
          matchedDeliveryCount: 0,
        }),
    },
    logger,
    failures,
    now: () => at,
  });
  const calls: Record<AdministrativeOperation, () => Promise<unknown>> = {
    GUILD_TIMEZONE_SET: () =>
      config.setTimezone(guildId, "Asia/Tokyo", createConfigurationAuditContext(actorUserId)),
    GUILD_CLOSED_PREFIX_SET: () =>
      config.setClosedPrefix(guildId, "[DONE]", createConfigurationAuditContext(actorUserId)),
    AUTO_CLOSE_INACTIVITY_SET: () => automatic.setInactivitySeconds(guildId, 3600, actorUserId),
    AUTO_CLOSE_BOT_MESSAGES_SET: () =>
      automatic.setBotMessagesCountAsActivity(guildId, true, actorUserId),
    AUTO_CLOSE_PARENT_ADD: () => automatic.addParentChannel(guildId, channelId, actorUserId),
    AUTO_CLOSE_PARENT_REMOVE: () => automatic.removeParentChannel(guildId, channelId, actorUserId),
    AUDIT_DESTINATION_SET: () => destination.set(guildId, actorUserId, channelId),
    AUDIT_DESTINATION_DISABLE: () => destination.disable(guildId, actorUserId),
    LINK_PREVIEW_MODE_SET: () => preview.set(guildId, actorUserId, "off"),
    THREAD_TRACK: () => maintenance.track(guildId, threadId, actorUserId),
    THREAD_UNTRACK: () => maintenance.untrack(guildId, threadId, actorUserId),
    THREAD_CLOSE_AFTER_SET: () => close.schedule(guildId, threadId, actorUserId, "1h"),
    THREAD_CANCEL_CLOSE: () => close.cancel(guildId, threadId, actorUserId),
    MANUAL_CLOSE_PREPARATION: () => close.closeManually(guildId, threadId, actorUserId),
    BULK_CLOSE_PREPARATION: () =>
      close.closeManually(guildId, threadId, actorUserId, {} as BulkThreadCloseHooks),
    ONE_TIME_MESSAGE_CREATE: () =>
      messages.create({
        ...scope,
        schedule: { kind: "AFTER", durationMs: 3600000 },
        payload: { content: "message" },
      }),
    ONE_TIME_MESSAGE_CANCEL: () => messages.cancel(scope),
    ONE_TIME_MESSAGE_EDIT: () =>
      messages.edit({ ...scope, expectedRevision: 0, payload: { content: "after" } }),
    ONE_TIME_MESSAGE_RESCHEDULE: () =>
      messages.reschedule({ ...scope, schedule: { kind: "AFTER", durationMs: 3600000 } }),
    RECURRING_MESSAGE_CREATE: () => {
      kind = "RECURRING";
      return messages.createRecurring({ ...scope, recurrence, payload: { content: "message" } });
    },
    RECURRING_MESSAGE_CANCEL: () => {
      kind = "RECURRING";
      return messages.cancel(scope);
    },
    RECURRING_MESSAGE_PAYLOAD_EDIT: () => {
      kind = "RECURRING";
      return messages.edit({ ...scope, expectedRevision: 0, payload: { content: "after" } });
    },
    RECURRING_MESSAGE_RECURRENCE_EDIT: () => {
      kind = "RECURRING";
      return messages.editRecurrence({ ...scope, recurrence });
    },
  };
  return { calls, record, scalar, settings, messageStore, recurring, failures, logger };
}

const operations = Object.keys(fixture().calls) as AdministrativeOperation[];
describe("23 administrative operation owners", () => {
  it.each(operations)(
    "records exactly one confirmed rollback for %s with a separate stable identity",
    async (operationCode) => {
      const f = fixture();
      await f.calls[operationCode]();
      expect(f.record).toHaveBeenCalledOnce();
      const [attempt, guild, actor, descriptor] = f.record.mock.calls[0]!;
      expect(guild).toBe(guildId);
      expect(actor).toBe(actorUserId);
      expect(attempt.operationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(descriptor).toMatchObject({
        operationCode,
        failureStage: "DATABASE_TRANSACTION",
        failureReasonCode: "TRANSACTION_ROLLED_BACK",
      });
      expect(descriptor.targetId).toBe(
        descriptor.targetType === "GUILD"
          ? guildId
          : descriptor.targetType === "THREAD"
            ? threadId
            : descriptor.targetType === "SCHEDULE"
              ? scheduleId
              : channelId,
      );
    },
  );
  it.each(operations)(
    "does not turn COMMIT response loss or a post-commit auxiliary failure into FAILURE for %s",
    async (operationCode) => {
      for (const disposition of ["UNCONFIRMED", "COMMITTED"] as const) {
        const f = fixture({ disposition, callbackEntered: true, commitAttempted: true });
        await f.calls[operationCode]();
        expect(f.record).not.toHaveBeenCalled();
      }
    },
  );
  it("does not record invalid scalar, preview, duration or message input", async () => {
    const f = fixture();
    await expect(
      createGuildConfigurationService(f.settings, f.failures).setTimezone(
        guildId,
        "not-a-zone",
        createConfigurationAuditContext(actorUserId),
      ),
    ).rejects.toThrow();
    const preview = createLinkPreviewConfiguration(
      { read: () => Promise.resolve("hybrid"), change: vi.fn() },
      f.failures,
    );
    expect(await preview.set(guildId, actorUserId, "unknown")).toEqual({ outcome: "INVALID" });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.scalar).not.toHaveBeenCalled();
  });
  it("awaits failure persistence and preserves the original result if the recorder rejects", async () => {
    const f = fixture();
    let resolve!: () => void;
    f.record.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const work = f.calls.GUILD_TIMEZONE_SET();
    let settled = false;
    void work.then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    resolve();
    await expect(work).resolves.toEqual({ outcome: "UNCONFIRMED" });
    f.record.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(f.calls.GUILD_CLOSED_PREFIX_SET()).resolves.toEqual({ outcome: "UNCONFIRMED" });
  });
  it("does not audit denied or unverified thread authorization", async () => {
    const f = fixture();
    for (const inspection of [
      () => Promise.resolve({ parentChannelId: channelId, actorCanManage: false }),
      () => {
        return Promise.reject(new Error("authorization unreadable"));
      },
    ]) {
      const service = createAutomaticCloseThreadMaintenanceService({
        discord: { inspectThread: inspection },
        persistence: {} as AutomaticClosePersistenceStore,
        scheduledActions: { findCurrentThreadClose: () => Promise.resolve(undefined) },
        failures: f.failures,
        logger: f.logger,
      });
      await service.track(guildId, threadId, actorUserId);
      await service.untrack(guildId, threadId, actorUserId);
    }
    expect(f.record).not.toHaveBeenCalled();
  });
  it("uses a distinct identity for each admitted bulk thread", async () => {
    const f = fixture();
    await f.calls.BULK_CLOSE_PREPARATION();
    await f.calls.BULK_CLOSE_PREPARATION();
    expect(f.record).toHaveBeenCalledTimes(2);
    expect(f.record.mock.calls[0]?.[0].operationId).not.toBe(
      f.record.mock.calls[1]?.[0].operationId,
    );
    expect(f.record.mock.calls.map((call) => call[3].operationCode)).toEqual([
      "BULK_CLOSE_PREPARATION",
      "BULK_CLOSE_PREPARATION",
    ]);
  });
});

describe("authorized pre-transaction administrative failures", () => {
  it("records parent enumeration failure without enabling or writing baselines", async () => {
    const f = fixture(),
      enable = vi.fn();
    const service = createAutomaticCloseConfigurationService({
      guildSettings: f.settings,
      schedules: {
        listParentChannels: () => Promise.resolve([]),
        enableParentChannelWithBaselines: enable,
        removeParentChannel: vi.fn(),
      },
      discord: {
        fetchActiveThreadSummaries: () => {
          return Promise.reject(new Error("private enumeration failure"));
        },
      },
      failures: f.failures,
      logger: {
        warn: () => {
          throw new Error("logger unavailable");
        },
      },
    });
    await expect(service.addParentChannel(guildId, channelId, actorUserId)).resolves.toEqual({
      outcome: "ENUMERATION_FAILED",
    });
    expect(enable).not.toHaveBeenCalled();
    expect(f.record.mock.calls[0]?.[3]).toMatchObject({
      operationCode: "AUTO_CLOSE_PARENT_ADD",
      failureStage: "DISCORD_ENUMERATION",
      failureReasonCode: "ACTIVE_THREAD_ENUMERATION_FAILED",
    });
  });
  it("retains an unverified destination as NULL only for required reads", async () => {
    const f = fixture(),
      change = vi.fn();
    const service = createAuditLogDestinationService(
      { read: () => Promise.resolve(null), change },
      {
        preflight: () =>
          Promise.resolve({
            ok: false,
            targetId: null,
            failure: {
              failureStage: "DISCORD_READ",
              failureReasonCode: "REQUIRED_RESOURCE_UNAVAILABLE",
            },
          }),
      },
      f.failures,
    );
    await expect(service.set(guildId, actorUserId, channelId)).resolves.toEqual({
      outcome: "VALIDATION_FAILED",
    });
    expect(change).not.toHaveBeenCalled();
    expect(f.record.mock.calls[0]?.[3]).toEqual({
      operationCode: "AUDIT_DESTINATION_SET",
      targetType: "CHANNEL",
      targetId: null,
      failureStage: "DISCORD_READ",
      failureReasonCode: "REQUIRED_RESOURCE_UNAVAILABLE",
    });
  });
  it.each(["denied", "unverified"] as const)(
    "does not start scheduled-close bot or DB boundaries when actor is %s",
    async (kind) => {
      const f = fixture(),
        botCanManage = vi.fn(),
        createOrReplace = vi.fn();
      const service = createScheduledThreadCloseCommandService({
        discord: {
          fetchThread: () =>
            Promise.resolve({
              guildId,
              threadId,
              type: ChannelType.PublicThread,
              name: "thread",
              archived: false,
              locked: false,
            }),
          actorCanManage: () => {
            if (kind === "unverified") return Promise.reject(new Error("private actor read"));
            return Promise.resolve(false);
          },
          botCanManage,
        },
        schedules: { createOrReplace, cancel: vi.fn() },
        delivery: { enqueueScheduledThreadClose: vi.fn(), hasCreatedOrRetryDelivery: vi.fn() },
        threadLifecycle: { close: vi.fn() },
        logger: f.logger,
        failures: f.failures,
        now: () => at,
      });
      await service.schedule(guildId, threadId, actorUserId, "1h");
      expect(f.record).not.toHaveBeenCalled();
      expect(botCanManage).not.toHaveBeenCalled();
      expect(createOrReplace).not.toHaveBeenCalled();
    },
  );
  it("records no preparation failure when lifecycle rejects before invoking cancellation", async () => {
    const f = fixture(),
      cancel = vi.fn();
    const service = createScheduledThreadCloseCommandService({
      discord: { fetchThread: vi.fn(), actorCanManage: vi.fn(), botCanManage: vi.fn() },
      schedules: { createOrReplace: vi.fn(), cancel },
      delivery: { enqueueScheduledThreadClose: vi.fn(), hasCreatedOrRetryDelivery: vi.fn() },
      threadLifecycle: {
        close: () => Promise.resolve({ ok: false, code: "ACTOR_PERMISSION_MISSING" }),
      },
      logger: f.logger,
      failures: f.failures,
    });
    await service.closeManually(guildId, threadId, actorUserId);
    expect(cancel).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});

describe("scheduled-close authorized bot evidence", () => {
  it.each([
    { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_PERMISSION_MISSING" },
    { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_CONTEXT_UNAVAILABLE" },
    { failureStage: "DISCORD_READ", failureReasonCode: "REQUIRED_RESOURCE_READ_FAILED" },
    { failureStage: "DISCORD_READ", failureReasonCode: "REQUIRED_RESOURCE_UNAVAILABLE" },
  ] as const)("records the verified stage without conflating result codes: %j", async (failure) => {
    const f = fixture(),
      persist = vi.fn();
    const service = createScheduledThreadCloseCommandService({
      discord: {
        fetchThread: () =>
          Promise.resolve({
            guildId,
            threadId,
            type: ChannelType.PublicThread,
            name: "thread",
            archived: false,
            locked: false,
          }),
        actorCanManage: () => Promise.resolve(true),
        botCanManage: () => Promise.resolve(false),
        administrativeBotPreflight: () =>
          Promise.resolve({
            ok: false,
            failure,
            code:
              failure.failureStage === "DISCORD_PREFLIGHT"
                ? "BOT_MISSING_PERMISSION"
                : "CONTEXT_VALIDATION_FAILURE",
          }),
      },
      schedules: { createOrReplace: persist, cancel: vi.fn() },
      delivery: { enqueueScheduledThreadClose: vi.fn(), hasCreatedOrRetryDelivery: vi.fn() },
      threadLifecycle: { close: vi.fn() },
      logger: f.logger,
      failures: f.failures,
      now: () => at,
    });
    await expect(service.schedule(guildId, threadId, actorUserId, "1h")).resolves.toEqual({
      ok: false,
      code:
        failure.failureStage === "DISCORD_PREFLIGHT"
          ? "BOT_MISSING_PERMISSION"
          : "CONTEXT_VALIDATION_FAILURE",
    });
    expect(f.record.mock.calls[0]?.[3]).toEqual({
      operationCode: "THREAD_CLOSE_AFTER_SET",
      targetType: "THREAD",
      targetId: threadId,
      ...failure,
    });
    expect(f.record).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
  });
  it("lets exact successful store results suppress failure despite rejected-transaction evidence", async () => {
    const f = fixture();
    f.scalar.mockImplementation((_guild, _value, input) => {
      if (input.administrativeAttempt)
        input.administrativeAttempt.transactionEvidence = {
          disposition: "ROLLED_BACK",
          callbackEntered: true,
          commitAttempted: false,
        };
      return Promise.resolve({ outcome: "CHANGED" });
    });
    expect(await f.calls.GUILD_TIMEZONE_SET()).toEqual({ outcome: "CHANGED" });
    expect(f.record).not.toHaveBeenCalled();
  });
});
