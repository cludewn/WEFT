import { describe, expect, it, vi } from "vitest";
import { createScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import type { ScheduledMessageStore } from "../../src/messages/scheduled-message-persistence.js";
import type { AdministrativeFailureRecorder } from "../../src/audit/administrative-operation-failure-audit.js";
import type { OneTimeScheduleInput } from "../../src/messages/one-time-message-schedule.js";
import type { RecurringMessageStore } from "../../src/messages/recurring-message-persistence.js";

const at = new Date("2030-01-01T00:00:00Z");
const input = {
  guildId: "guild",
  channelId: "channel",
  actorUserId: "actor",
  payload: { content: "text" },
};
function fixture(
  options: {
    bot?: boolean;
    denied?: boolean;
    unverified?: boolean;
    timezoneReadFails?: boolean;
    formalReadFails?: boolean;
    timezone?: string;
    formalTimezone?: string;
    rawCodeOnly?: boolean;
    projectionFails?: boolean;
    logFails?: boolean;
    later?: Date;
    preliminaryClockFails?: boolean;
  } = {},
) {
  const record = vi.fn<AdministrativeFailureRecorder["record"]>(async () => {});
  const readTimezone = vi.fn(() => {
    if (options.timezoneReadFails) return Promise.reject(new Error("unavailable"));
    return Promise.resolve(options.timezone ?? "UTC");
  });
  const getOrCreate = vi.fn(() => {
    if (options.formalReadFails) return Promise.reject(new Error("unavailable"));
    return Promise.resolve({ timezone: options.formalTimezone ?? options.timezone ?? "UTC" });
  });
  const create = vi.fn<ScheduledMessageStore["create"]>((request) =>
    Promise.resolve({
      action: { id: request.scheduledActionId, executeAt: request.executeAt },
      revision: 0,
    } as Awaited<ReturnType<ScheduledMessageStore["create"]>>),
  );
  let timeCalls = 0;
  const service = createScheduledMessageCommandService({
    discord: {
      authorizeCreation: async (request) => {
        if (options.denied) return { outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" };
        if (options.unverified) return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
        await request.afterActorAuthorized?.();
        if (options.bot === false)
          return {
            outcome: "FAILURE",
            code: "BOT_PERMISSION_MISSING",
            ...(options.rawCodeOnly
              ? {}
              : {
                  administrativeFailure: {
                    failureStage: "DISCORD_PREFLIGHT",
                    failureReasonCode: "BOT_PERMISSION_MISSING",
                  },
                }),
          };
        return { outcome: "AUTHORIZED" };
      },
    },
    store: { create } as unknown as ScheduledMessageStore,
    delivery: {
      ensureScheduledMessageDelivery: () => {
        if (options.projectionFails) return Promise.reject(new Error("queue unavailable"));
        return Promise.resolve("CURRENT");
      },
      cancelScheduledMessageDeliveries: vi.fn(),
    },
    guildSettings: { readTimezone, getOrCreate } as Parameters<
      typeof createScheduledMessageCommandService
    >[0]["guildSettings"] &
      object,
    logger: {
      warn: vi.fn(() => {
        if (options.logFails) throw new Error("log unavailable");
      }),
    },
    failures: { record },
    now: () => {
      timeCalls += 1;
      if (options.preliminaryClockFails && timeCalls === 1)
        throw new Error("preliminary observation unavailable");
      return timeCalls === 1 ? at : (options.later ?? at);
    },
  });
  return { service, record, readTimezone, getOrCreate, create };
}

describe("one-time audit eligibility is independent of formal establishment", () => {
  it.each<OneTimeScheduleInput>([
    { kind: "AT", localDateTime: "2030-03-10 02:30" },
    { kind: "AT", localDateTime: "2030-11-03 01:30" },
    { kind: "AT", localDateTime: "2032-01-01 09:00" },
    { kind: "AT", localDateTime: "2029-12-31 19:00" },
    { kind: "AFTER", durationMs: 1 },
  ])(
    "does not audit invalid DST/horizon/duration even with a bot failure: %j",
    async (schedule) => {
      const f = fixture({ bot: false, timezone: "America/New_York" });
      expect(await f.service.create({ ...input, schedule })).toEqual({
        outcome: "FAILURE",
        code: "BOT_PERMISSION_MISSING",
      });
      expect(f.record).not.toHaveBeenCalled();
      expect(f.getOrCreate).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
    },
  );
  it.each([
    { denied: true },
    { unverified: true },
    { bot: false, rawCodeOnly: true },
    { bot: false, timezoneReadFails: true },
  ])(
    "requires positive actor and input evidence, not a failure result name: %j",
    async (options) => {
      const f = fixture(options);
      await f.service.create({
        ...input,
        schedule: { kind: "AT", localDateTime: "2030-01-02 12:00" },
      });
      expect(f.record).not.toHaveBeenCalled();
      expect(f.create).not.toHaveBeenCalled();
      if (options.denied || options.unverified) expect(f.readTimezone).not.toHaveBeenCalled();
    },
  );
  it("records bot deficiency only after the same domain validator admits a resolved request", async () => {
    const f = fixture({ bot: false });
    await f.service.create({
      ...input,
      schedule: { kind: "AT", localDateTime: "2030-01-02 12:00" },
    });
    expect(f.record).toHaveBeenCalledOnce();
    expect(f.record.mock.calls[0]?.[3]).toEqual({
      operationCode: "ONE_TIME_MESSAGE_CREATE",
      targetType: "CHANNEL",
      targetId: input.channelId,
      failureStage: "DISCORD_PREFLIGHT",
      failureReasonCode: "BOT_PERMISSION_MISSING",
    });
    expect(f.getOrCreate).not.toHaveBeenCalled();
  });
  it("uses formal establishment after bot preflight for relative schedules", async () => {
    const later = new Date(at.getTime() + 10000);
    const f = fixture({ later });
    const result = await f.service.create({
      ...input,
      schedule: { kind: "AFTER", durationMs: 3600000 },
    });
    expect(result.outcome).toBe("SUCCESS");
    expect(f.create.mock.calls[0]?.[0].occurredAt).toEqual(later);
    expect(f.create.mock.calls[0]?.[0].executeAt).toEqual(new Date(later.getTime() + 3600000));
    expect(f.record).not.toHaveBeenCalled();
  });
  it("does not reject the business request when preliminary timezone observation is unavailable", async () => {
    const f = fixture({ timezoneReadFails: true });
    const result = await f.service.create({
      ...input,
      schedule: { kind: "AT", localDateTime: "2030-01-02 12:00" },
    });
    expect(result.outcome).toBe("SUCCESS");
    expect(f.getOrCreate).toHaveBeenCalledOnce();
    expect(f.create.mock.calls[0]?.[0].administrativeAttempt?.operationId).toBe(
      f.create.mock.calls[0]?.[0].auditId,
    );
    expect(f.record).not.toHaveBeenCalled();
  });
  it("never audits a formally rejected instant even when preliminary eligibility succeeded", async () => {
    const f = fixture({ timezone: "UTC", formalTimezone: "America/New_York" });
    expect(
      await f.service.create({
        ...input,
        schedule: { kind: "AT", localDateTime: "2030-03-10 02:30" },
      }),
    ).toEqual({ outcome: "FAILURE", code: "DST_GAP" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it("distinguishes a required formal timezone read failure from bot preflight with the same business failure response", async () => {
    const f = fixture({ formalReadFails: true });
    expect(
      await f.service.create({
        ...input,
        schedule: { kind: "AT", localDateTime: "2030-01-02 12:00" },
      }),
    ).toEqual({ outcome: "FAILURE", code: "TIMEZONE_UNAVAILABLE" });
    expect(f.record.mock.calls[0]?.[3].failureStage).toBe("DATABASE_READ");
  });
  it("preserves a successful saved schedule when projection and Pino fail", async () => {
    const f = fixture({ projectionFails: true, logFails: true });
    await expect(
      f.service.create({ ...input, schedule: { kind: "AFTER", durationMs: 3600000 } }),
    ).resolves.toMatchObject({ outcome: "SUCCESS", deliveryPendingReconciliation: true });
    expect(f.record).not.toHaveBeenCalled();
  });
});

describe("unavailable preliminary eligibility", () => {
  it("keeps the original request path when audit-only observation throws", async () => {
    const f = fixture({ preliminaryClockFails: true });
    await expect(
      f.service.create({ ...input, schedule: { kind: "AFTER", durationMs: 3600000 } }),
    ).resolves.toMatchObject({ outcome: "SUCCESS" });
    expect(f.create).toHaveBeenCalledOnce();
    expect(f.record).not.toHaveBeenCalled();
  });
});

describe("recurring creation audit eligibility preserves authorization response order", () => {
  function recurringFixture(options: { denied?: boolean; identityUnavailable?: boolean } = {}) {
    const record = vi.fn<AdministrativeFailureRecorder["record"]>(async () => {});
    const now = vi.fn(() => {
      throw new Error("establishment clock must not run after authorization failure");
    });
    const generateId = vi.fn(() => {
      if (options.identityUnavailable) throw new Error("audit identity unavailable");
      return "12345678-1234-4234-8234-123456789abc";
    });
    const authorizeCreation = vi.fn<
      Parameters<typeof createScheduledMessageCommandService>[0]["discord"]["authorizeCreation"]
    >(async (request) => {
      if (options.denied) return { outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" };
      await request.afterActorAuthorized?.();
      return {
        outcome: "FAILURE",
        code: "BOT_PERMISSION_MISSING",
        administrativeFailure: {
          failureStage: "DISCORD_PREFLIGHT",
          failureReasonCode: "BOT_PERMISSION_MISSING",
        },
      };
    });
    const service = createScheduledMessageCommandService({
      discord: { authorizeCreation },
      store: {} as ScheduledMessageStore,
      recurring: {} as RecurringMessageStore,
      recurringWorker: { project: () => Promise.resolve("CURRENT") },
      guildSettings: { getOrCreate: vi.fn() },
      delivery: {
        ensureScheduledMessageDelivery: vi.fn(),
        cancelScheduledMessageDeliveries: vi.fn(),
      },
      logger: { warn: vi.fn() },
      failures: { record },
      now,
      generateId,
    });
    return { service, record, now, generateId, authorizeCreation };
  }

  it.each([{ denied: true }, { identityUnavailable: true }, {}])(
    "never establishes time for rejected authorization, including audit-only failure: %j",
    async (options) => {
      const f = recurringFixture(options);
      await expect(
        f.service.createRecurring({
          ...input,
          recurrence: { frequency: "daily", time: "09:00", timezone: "UTC" },
        }),
      ).resolves.toEqual({
        outcome: "FAILURE",
        code: "denied" in options ? "ACTOR_PERMISSION_MISSING" : "BOT_PERMISSION_MISSING",
      });
      expect(f.now).not.toHaveBeenCalled();
      if ("denied" in options || "identityUnavailable" in options)
        expect(f.record).not.toHaveBeenCalled();
      else expect(f.record).toHaveBeenCalledOnce();
      if ("denied" in options) expect(f.generateId).not.toHaveBeenCalled();
    },
  );

  it("rejects invalid recurrence before bot preflight without an audit identity", async () => {
    const f = recurringFixture();
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence: { frequency: "daily", time: "25:00", timezone: "UTC" },
      }),
    ).resolves.toEqual({ outcome: "INVALID_RECURRENCE" });
    expect(f.authorizeCreation).not.toHaveBeenCalled();
    expect(f.now).not.toHaveBeenCalled();
    expect(f.generateId).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
});
