import { describe, expect, it, vi } from "vitest";

import { createScheduledMessageCommandService } from "../../src/scheduled-message-command.js";
import type { ScheduledMessageStore } from "../../src/scheduled-message-persistence.js";
import type {
  ScheduledMessageAdministrationStore,
  RecurringAdministrationView,
} from "../../src/scheduled-message-administration-persistence.js";
import type {
  RecurringMessageSeries,
  RecurringMessageStore,
} from "../../src/recurring-message-persistence.js";
import type { GuildSettingsStore } from "../../src/guild-settings.js";
import type { RecurringMessageWorker } from "../../src/recurring-message-worker.js";
import type { ScheduledMessageCreationDiscord } from "../../src/scheduled-message-discord.js";

const establishedAt = new Date("2030-01-01T00:00:00.000Z");
const input = { guildId: "guild", channelId: "channel", actorUserId: "actor" };
const recurrence = { frequency: "daily", time: "09:00" };

function fixture() {
  const calls: string[] = [];
  const series = {
    action: {
      id: "series-id",
      guildId: "guild",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: new Date("2030-01-01T09:00:00.000Z"),
    },
    revision: 0,
    recurrence: {
      frequency: "DAILY",
      weekdayMask: 127,
      localTime: "09:00",
      timezone: "UTC",
      definitionRevision: 0,
    },
    occurrence: {
      id: "occurrence-id",
      status: "PENDING",
      retryCount: 0,
      scheduledFor: new Date("2030-01-01T09:00:00.000Z"),
    },
    payload: { content: "original", embed: null },
  } as unknown as RecurringMessageSeries;
  const authorizeCreation = vi.fn<ScheduledMessageCreationDiscord["authorizeCreation"]>(() => {
    calls.push("authorize");
    return Promise.resolve({ outcome: "AUTHORIZED" as const });
  });
  const getOrCreate = vi.fn(() => {
    calls.push("timezone");
    return Promise.resolve({ timezone: "UTC" });
  });
  const create = vi.fn<RecurringMessageStore["create"]>(() => {
    calls.push("persist");
    return Promise.resolve({ outcome: "COMMITTED", series });
  });
  const project = vi.fn<RecurringMessageWorker["project"]>(() => {
    calls.push("project");
    return Promise.resolve("CURRENT");
  });
  const findKind = vi.fn<ScheduledMessageAdministrationStore["findKind"]>(() =>
    Promise.resolve("RECURRING"),
  );
  const currentView: RecurringAdministrationView = {
    scheduledActionId: "series-id",
    kind: "RECURRING",
    status: "ACTIVE",
    guildId: "guild",
    channelId: "channel",
    executeAt: new Date("2030-01-01T10:00:00.000Z"),
    creatorUserId: "actor",
    revision: 1,
    frequency: "DAILY",
    weekdayMask: 127,
    localTime: "09:00",
    timezone: "UTC",
    currentOccurrenceId: "replacement-id",
    currentOccurrenceStatus: "PENDING",
    retryCount: 0,
  };
  const findRecurringStatus = vi.fn<ScheduledMessageAdministrationStore["findRecurringStatus"]>(
    () => Promise.resolve(currentView),
  );
  const find = vi.fn<RecurringMessageStore["find"]>(() => Promise.resolve(series));
  const editRecurrence = vi.fn<RecurringMessageStore["editRecurrence"]>(() =>
    Promise.resolve({
      outcome: "COMMITTED" as const,
      series,
      effect: {
        committedRevision: 1,
        deferredMaterialization: false,
        replacementOccurrenceId: "replacement-id",
        replacementScheduledFor: new Date("2030-01-01T10:00:00.000Z"),
      },
    }),
  );
  const editPayload = vi.fn<RecurringMessageStore["editPayload"]>(() =>
    Promise.resolve({ outcome: "COMMITTED", series }),
  );
  const cancel = vi.fn<RecurringMessageStore["cancel"]>(() =>
    Promise.resolve({ outcome: "COMMITTED", series }),
  );
  const oneTimeReschedule = vi.fn();
  const listCombined = vi.fn<ScheduledMessageAdministrationStore["listCombined"]>(() =>
    Promise.resolve([]),
  );
  let nextId = 0;
  const service = createScheduledMessageCommandService({
    discord: { authorizeCreation },
    store: { reschedule: oneTimeReschedule } as unknown as Pick<
      ScheduledMessageStore,
      | "create"
      | "cancel"
      | "findStatus"
      | "listNonterminal"
      | "findEditable"
      | "edit"
      | "reschedule"
      | "find"
    >,
    delivery: {
      ensureScheduledMessageDelivery: vi.fn(),
      cancelScheduledMessageDeliveries: vi.fn(),
    },
    administration: {
      findKind,
      findRecurringStatus,
      listCombined,
    },
    recurring: { create, find, editRecurrence, editPayload, cancel },
    recurringWorker: { project },
    guildSettings: { getOrCreate } as unknown as Pick<GuildSettingsStore, "getOrCreate">,
    logger: { warn: vi.fn() },
    generateId: () =>
      ["series-id", "occurrence-id", "audit-id", "replacement-id", "edit-audit-id"][nextId++] ??
      `id-${nextId}`,
    now: () => establishedAt,
  });
  return {
    service,
    calls,
    series,
    authorizeCreation,
    getOrCreate,
    create,
    project,
    findKind,
    findRecurringStatus,
    currentView,
    find,
    editRecurrence,
    editPayload,
    cancel,
    oneTimeReschedule,
    listCombined,
  };
}

describe("recurring scheduled-message administration service", () => {
  it("loads omitted guild timezone at submission and projects only after confirmed creation", async () => {
    const f = fixture();
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence,
        payload: { content: "hello", embed: null },
      }),
    ).resolves.toMatchObject({
      outcome: "SUCCESS",
      scheduledActionId: "series-id",
      deliveryPendingReconciliation: false,
    });
    expect(f.calls).toEqual(["timezone", "authorize", "persist", "project"]);
    expect(f.create).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledActionId: "series-id",
        occurrenceId: "occurrence-id",
        auditId: "audit-id",
        effectiveAt: establishedAt,
        recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "09:00", timezone: "UTC" },
      }),
    );
    expect(f.project).toHaveBeenCalledWith({
      delivery: {
        kind: "recurring-message-occurrence",
        scheduledActionId: "series-id",
        occurrenceId: "occurrence-id",
        scheduledFor: "2030-01-01T09:00:00.000Z",
        seriesRevision: 0,
        retryCount: 0,
      },
      wakeAt: new Date("2030-01-01T09:00:00.000Z"),
    });
  });

  it("uses explicit timezone and stops when guild timezone is invalid", async () => {
    const f = fixture();
    f.getOrCreate.mockResolvedValue({ timezone: "+09:00" });
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence,
        payload: { content: "hello", embed: null },
      }),
    ).resolves.toEqual({ outcome: "INVALID_GUILD_TIMEZONE" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.authorizeCreation).not.toHaveBeenCalled();
    await f.service.createRecurring({
      ...input,
      recurrence: { ...recurrence, timezone: "Asia/Tokyo" },
      payload: { content: "hello", embed: null },
    });
    expect(f.getOrCreate).toHaveBeenCalledTimes(1);
    expect(f.create.mock.calls.at(-1)?.[0].recurrence.timezone).toBe("Asia/Tokyo");
  });

  it("does not project an unconfirmed creation", async () => {
    const f = fixture();
    f.create.mockResolvedValueOnce({ outcome: "PERSISTENCE_UNCONFIRMED" });
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence,
        payload: { content: "hello", embed: null },
      }),
    ).resolves.toEqual({ outcome: "PERSISTENCE_UNCONFIRMED" });
    expect(f.project).not.toHaveBeenCalled();
  });

  it("does not persist after fresh creation authorization fails", async () => {
    const f = fixture();
    f.authorizeCreation.mockResolvedValueOnce({
      outcome: "FAILURE",
      code: "ACTOR_PERMISSION_MISSING",
    });
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence,
        payload: { content: "hello", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.project).not.toHaveBeenCalled();
  });

  it("leaves a committed series authoritative when projection is unconfirmed", async () => {
    const f = fixture();
    f.project.mockResolvedValueOnce("UNCONFIRMED");
    await expect(
      f.service.createRecurring({
        ...input,
        recurrence,
        payload: { content: "hello", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "SUCCESS", deliveryPendingReconciliation: true });
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("preserves persisted timezone on edit and skips an ineligible replacement projection", async () => {
    const f = fixture();
    f.findRecurringStatus.mockResolvedValueOnce({
      ...f.currentView,
      currentOccurrenceStatus: "EXECUTING",
    });
    const result = await f.service.editRecurrence({
      ...input,
      scheduledActionId: "series-id",
      recurrence: { frequency: "weekly", time: "10:00", weekdays: "mon" },
    });
    expect(result).toMatchObject({
      outcome: "COMMITTED",
      effect: { replacementOccurrenceId: "replacement-id" },
    });
    expect(f.editRecurrence).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        recurrence: { frequency: "WEEKLY", weekdayMask: 1, localTime: "10:00", timezone: "UTC" },
      }),
    );
    expect(f.project).not.toHaveBeenCalled();
  });

  it("projects an eligible replacement after the status read", async () => {
    const f = fixture();
    await expect(
      f.service.editRecurrence({
        ...input,
        scheduledActionId: "series-id",
        recurrence: { frequency: "weekly", time: "10:00", weekdays: "mon" },
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED", deliveryPendingReconciliation: false });
    expect(f.findRecurringStatus).toHaveBeenCalledTimes(1);
    expect(f.project).toHaveBeenCalledTimes(1);
    expect(f.project.mock.calls[0]?.[0].delivery).toMatchObject({
      occurrenceId: "replacement-id",
      seriesRevision: 1,
    });
  });

  it("keeps recurring IDs out of one-time reschedule persistence", async () => {
    const f = fixture();
    await expect(
      f.service.reschedule({ ...input, scheduledActionId: "series-id", durationMs: 60_000 }),
    ).resolves.toEqual({ outcome: "WRONG_KIND" });
    expect(f.oneTimeReschedule).not.toHaveBeenCalled();
  });

  it("rejects a one-time ID before recurring recurrence persistence", async () => {
    const f = fixture();
    f.findKind.mockResolvedValueOnce("ONE_TIME");
    await expect(
      f.service.editRecurrence({ ...input, scheduledActionId: "one-time-id", recurrence }),
    ).resolves.toEqual({ outcome: "WRONG_KIND" });
    expect(f.editRecurrence).not.toHaveBeenCalled();
  });

  it("routes shared edit and cancellation to recurring persistence without one-time delivery cleanup", async () => {
    const f = fixture();
    await expect(
      f.service.edit({
        ...input,
        scheduledActionId: "series-id",
        expectedRevision: 0,
        payload: { content: "new content", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "EDITED" });
    expect(f.editPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduledActionId: "series-id",
        expectedRevision: 0,
        payload: { content: "new content", embed: null },
      }),
    );
    await expect(f.service.cancel({ ...input, scheduledActionId: "series-id" })).resolves.toEqual({
      outcome: "CANCELLED",
      deliveryCleanupPending: false,
    });
    expect(f.cancel).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 0 }));
  });

  it("uses focused recurring status and combined list reads", async () => {
    const f = fixture();
    await expect(
      f.service.status({ scheduledActionId: "series-id", guildId: "guild", channelId: "channel" }),
    ).resolves.toMatchObject({
      outcome: "FOUND",
      schedule: { kind: "RECURRING", currentOccurrenceStatus: "PENDING" },
    });
    expect(f.findRecurringStatus).toHaveBeenCalledTimes(1);
    await expect(
      f.service.list({ guildId: "guild", channelId: "channel", page: 2 }),
    ).resolves.toEqual({ outcome: "FOUND", schedules: [] });
    expect(f.listCombined).toHaveBeenCalledWith("guild", "channel", 10);
  });
});
