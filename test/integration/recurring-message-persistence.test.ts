import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
  type CreateRecurringMessageSeries,
  type RecurringMessageStore,
  type RecurringMutationResult,
  type RecurrenceEditResult,
} from "../../src/recurring-message-persistence.js";
import { ALL_WEEKDAYS_MASK, findNextOccurrence } from "../../src/recurring-message.js";
import type { ScheduledMessageDiscord } from "../../src/scheduled-message-discord.js";
import { createScheduledMessageExecutor } from "../../src/scheduled-message-execution.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/scheduled-message-persistence.js";

const database = createDatabase(loadTestDatabaseConfig());
const recurring = createRecurringMessageStore(database.client);
const oneTime = createScheduledMessageStore(database.client);
const actions = createScheduledActionStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("recurring message persistence", () => {
  it("decides recurrence no-op under the series lock after revision validation", async () => {
    const input = createInput("recurrence-noop");
    await recurring.create(input);
    const before = await recurring.find(input.scheduledActionId);
    const unchanged = await recurring.editRecurrence({
      scheduledActionId: input.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      recurrence: { ...dailyRecurrence, timezone: "utc" },
      effectiveAt: new Date("2030-01-01T09:01:00.000Z"),
      replacementOccurrenceId: "unused-noop-occurrence",
      auditId: "unused-noop-audit",
      gapAuditIds: [],
    });
    expect(unchanged).toEqual({ outcome: "UNCHANGED" });
    const after = await recurring.find(input.scheduledActionId);
    expect(after).toMatchObject({ revision: 0, recurrence: { definitionRevision: 0 } });
    expect(after?.action.executeAt).toEqual(before?.action.executeAt);
    expect(after?.occurrence?.id).toBe(input.occurrenceId);
    await expect(
      database.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, "unused-noop-audit")),
    ).resolves.toHaveLength(0);
    await recurring.editPayload({
      scheduledActionId: input.scheduledActionId,
      actorId: "other-editor",
      expectedRevision: 0,
      payload: { content: "changed", embed: null },
      auditId: "noop-race-payload-audit",
      occurredAt: new Date("2030-01-01T09:02:00.000Z"),
    });
    await expect(
      recurring.editRecurrence({
        scheduledActionId: input.scheduledActionId,
        actorId: "editor",
        expectedRevision: 0,
        recurrence: dailyRecurrence,
        effectiveAt: new Date("2030-01-01T09:03:00.000Z"),
        replacementOccurrenceId: "unused-stale-occurrence",
        auditId: "unused-stale-audit",
        gapAuditIds: [],
      }),
    ).resolves.toEqual({ outcome: "CONFLICT" });
  });

  it("accepts unused gap identities when a claim wins before recurrence edit", async () => {
    const input = {
      ...createInput("gap-claim-race"),
      effectiveAt: new Date("2024-03-10T05:00:00.000Z"),
    };
    await recurring.create(input);
    const replacement = {
      frequency: "DAILY" as const,
      weekdayMask: 127,
      localTime: "02:30",
      timezone: "America/New_York",
    };
    const effectiveAt = new Date("2024-03-10T06:00:00.000Z");
    expect(findNextOccurrence(replacement, 1, effectiveAt).skippedGaps).toHaveLength(1);
    await recurring.claimInitial({
      occurrenceId: input.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: effectiveAt,
    });
    const result = await recurring.editRecurrence({
      scheduledActionId: input.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      recurrence: replacement,
      effectiveAt,
      replacementOccurrenceId: "unused-gap-race-occurrence",
      auditId: "gap-race-edit-audit",
      gapAuditIds: ["unused-gap-race-audit"],
    });
    expect(result).toMatchObject({
      outcome: "COMMITTED",
      effect: {
        deferredMaterialization: true,
        replacementOccurrenceId: null,
        replacementScheduledFor: null,
      },
    });
    await expect(
      database.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, "unused-gap-race-audit")),
    ).resolves.toHaveLength(0);
    await expect(
      database.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, "unused-gap-race-occurrence")),
    ).resolves.toHaveLength(0);
  });

  it("uses the supplied gap audit identity while the locked occurrence remains pending", async () => {
    const input = {
      ...createInput("pending-gap-edit"),
      effectiveAt: new Date("2024-03-10T05:00:00.000Z"),
    };
    await recurring.create(input);
    const replacement = {
      frequency: "DAILY" as const,
      weekdayMask: 127,
      localTime: "02:30",
      timezone: "America/New_York",
    };
    const effectiveAt = new Date("2024-03-10T06:00:00.000Z");
    const selection = findNextOccurrence(replacement, 1, effectiveAt);
    expect(selection.skippedGaps).toHaveLength(1);
    await expect(
      recurring.editRecurrence({
        scheduledActionId: input.scheduledActionId,
        actorId: "editor",
        expectedRevision: 0,
        recurrence: replacement,
        effectiveAt,
        replacementOccurrenceId: "pending-gap-replacement",
        auditId: "pending-gap-edit-audit",
        gapAuditIds: ["pending-gap-audit"],
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: false,
        replacementOccurrenceId: "pending-gap-replacement",
        replacementScheduledFor: selection.occurrence.scheduledFor,
      },
    });
    const [gapAudit] = await database.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, "pending-gap-audit"));
    expect(gapAudit?.event).toBe("DST_GAP_SKIPPED");
  });
  it("atomically creates the discriminator, exact audit, and one initial occurrence", async () => {
    const input = createInput("create");
    input.recurrence = { ...input.recurrence, timezone: "america/new_york" };
    const result = await recurring.create(input);
    expect(result).toMatchObject({
      outcome: "COMMITTED",
      series: {
        revision: 0,
        recurrence: {
          timezone: "America/New_York",
          definitionRevision: 0,
          effectiveAt: input.effectiveAt,
        },
        occurrence: { id: input.occurrenceId, status: "PENDING" },
      },
    });
    await expect(database.client.select().from(recurringMessageSchedules)).resolves.toHaveLength(1);
    await expect(database.client.select().from(recurringMessageOccurrences)).resolves.toHaveLength(
      1,
    );
    await expect(database.client.select().from(recurringMessageAudits)).resolves.toEqual([
      expect.objectContaining({
        id: input.auditId,
        event: "SERIES_CREATED",
        occurredAt: input.effectiveAt,
        selectedNextOccurrenceId: input.occurrenceId,
      }),
    ]);
    const [action] = await database.client
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, input.scheduledActionId));
    expect(action?.executeAt).toEqual(
      result.outcome === "COMMITTED" ? result.series.occurrence?.scheduledFor : null,
    );
    await expect(
      recurring.create({
        ...createInput("invalid-offset"),
        recurrence: { ...dailyRecurrence, timezone: "+05:30" },
      }),
    ).resolves.toEqual({ outcome: "INVALID_RECURRENCE" });
  });

  it("keeps a pending occurrence stable across payload edit and snapshots only at claim", async () => {
    const input = createInput("payload");
    const created = await recurring.create(input);
    expect(created.outcome).toBe("COMMITTED");
    if (created.outcome !== "COMMITTED" || created.series.occurrence === null) {
      throw new Error("fixture creation failed");
    }
    const originalOccurrence = created.series.occurrence;
    const edited = await recurring.editPayload({
      scheduledActionId: input.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      payload: { content: "edited", embed: null },
      auditId: "payload-edit-audit",
      occurredAt: new Date("2026-09-18T02:00:00.000Z"),
    });
    expect(edited).toMatchObject({
      outcome: "COMMITTED",
      series: {
        revision: 1,
        recurrence: { definitionRevision: 0 },
        occurrence: {
          id: originalOccurrence.id,
          scheduledFor: originalOccurrence.scheduledFor,
          status: "PENDING",
        },
      },
    });
    await expect(
      recurring.claimInitial({
        occurrenceId: originalOccurrence.id,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2030-01-01T09:00:00.000Z"),
      }),
    ).resolves.toEqual({ outcome: "NOT_CLAIMED" });
    const claimTime = new Date("2030-01-01T09:00:01.000Z");
    const claim = await recurring.claimInitial({
      occurrenceId: originalOccurrence.id,
      expectedSeriesRevision: 1,
      claimedAt: claimTime,
    });
    expect(claim).toMatchObject({
      outcome: "COMMITTED",
      occurrence: {
        claimContent: "edited",
        firstAttemptedAt: claimTime,
        claimedAt: claimTime,
        claimedSeriesRevision: 1,
        claimedDefinitionRevision: 0,
        materializedDefinitionRevision: 0,
      },
    });
    await recurring.editPayload({
      scheduledActionId: input.scheduledActionId,
      actorId: "editor",
      expectedRevision: 1,
      payload: { content: "future canonical", embed: null },
      auditId: "payload-edit-after-claim",
      occurredAt: new Date("2030-01-01T09:00:02.000Z"),
    });
    const [persisted] = await database.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, originalOccurrence.id));
    expect(persisted?.claimContent).toBe("edited");
    expect(persisted?.claimedSeriesRevision).toBe(1);
  });

  it("supersedes pending on recurrence edit but defers while executing", async () => {
    const pendingInput = createInput("recurrence-pending");
    await recurring.create(pendingInput);
    const effectiveAt = new Date("2026-09-18T03:00:00.000Z");
    const edited = await recurring.editRecurrence({
      scheduledActionId: pendingInput.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      recurrence: {
        frequency: "WEEKLY",
        weekdayMask: 0b000_0001,
        localTime: "10:30",
        timezone: "Asia/Tokyo",
      },
      effectiveAt,
      replacementOccurrenceId: "replacement-pending",
      auditId: "recurrence-edit-pending-audit",
      gapAuditIds: [],
    });
    expect(edited).toMatchObject({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: false,
        replacementOccurrenceId: "replacement-pending",
      },
    });
    await expect(recurring.find(pendingInput.scheduledActionId)).resolves.toMatchObject({
      revision: 1,
      recurrence: { definitionRevision: 1, effectiveAt },
      occurrence: { id: "replacement-pending", status: "PENDING" },
    });
    const [old] = await database.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, pendingInput.occurrenceId));
    expect(old).toMatchObject({ status: "SKIPPED", skipReason: "RECURRENCE_EDITED" });
    await expect(
      recurring.claimInitial({
        occurrenceId: pendingInput.occurrenceId,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2026-09-18T03:00:01.000Z"),
      }),
    ).resolves.toEqual({ outcome: "NOT_CLAIMED" });

    const executingInput = createInput("recurrence-executing");
    await recurring.create(executingInput);
    await recurring.claimInitial({
      occurrenceId: executingInput.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    const before = await recurring.find(executingInput.scheduledActionId);
    const deferred = await recurring.editRecurrence({
      scheduledActionId: executingInput.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      recurrence: { ...dailyRecurrence, timezone: "Asia/Tokyo" },
      effectiveAt,
      replacementOccurrenceId: "unused-deferred-id",
      auditId: "recurrence-edit-deferred-audit",
      gapAuditIds: [],
    });
    expect(deferred).toMatchObject({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: true,
        replacementOccurrenceId: null,
        replacementScheduledFor: null,
      },
    });
    const deferredSeries = await recurring.find(executingInput.scheduledActionId);
    expect(deferredSeries).toMatchObject({
      revision: 1,
      recurrence: { definitionRevision: 1 },
      occurrence: {
        id: executingInput.occurrenceId,
        status: "EXECUTING",
        claimContent: "original",
      },
    });
    expect(deferredSeries?.action.executeAt).toEqual(before?.action.executeAt);
  });

  it("preserves retry-pending snapshots through recurrence edit and cancellation", async () => {
    const input = createInput("retry-pending");
    await recurring.create(input);
    await recurring.claimInitial({
      occurrenceId: input.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    await database.client
      .update(recurringMessageOccurrences)
      .set({ status: "RETRY_PENDING", retryCount: 1 })
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    const before = await recurring.find(input.scheduledActionId);
    const edited = await recurring.editRecurrence({
      scheduledActionId: input.scheduledActionId,
      actorId: "editor",
      expectedRevision: 0,
      recurrence: { ...dailyRecurrence, timezone: "Asia/Tokyo" },
      effectiveAt: new Date("2030-01-01T09:01:00.000Z"),
      replacementOccurrenceId: "unused-retry-replacement",
      auditId: "retry-recurrence-audit",
      gapAuditIds: [],
    });
    expect(edited).toMatchObject({
      outcome: "COMMITTED",
    });
    const editedSeries = await recurring.find(input.scheduledActionId);
    expect(editedSeries).toMatchObject({
      revision: 1,
      occurrence: {
        id: input.occurrenceId,
        status: "RETRY_PENDING",
        retryCount: 1,
        claimContent: "original",
      },
    });
    expect(editedSeries?.action.executeAt).toEqual(before?.action.executeAt);
    const cancelled = await recurring.cancel({
      scheduledActionId: input.scheduledActionId,
      actorId: "canceller",
      expectedRevision: 1,
      auditId: "retry-cancel-audit",
      occurredAt: new Date("2030-01-01T09:02:00.000Z"),
    });
    expect(cancelled).toMatchObject({
      outcome: "COMMITTED",
      series: { action: { status: "CANCELLED" }, revision: 2, occurrence: null },
    });
    const [persisted] = await database.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    expect(persisted).toMatchObject({
      status: "SKIPPED",
      skipReason: "SERIES_CANCELLED",
      retryCount: 1,
      claimContent: "original",
    });
  });

  it("materializes idempotently and refuses a second nonterminal candidate", async () => {
    const input = createInput("materialize");
    await recurring.create(input);
    await database.client
      .update(recurringMessageOccurrences)
      .set({
        status: "SKIPPED",
        skipReason: "MISSED_GRACE_EXCEEDED",
        terminalAt: new Date("2030-01-01T10:00:00.000Z"),
      })
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    const materialization = {
      scheduledActionId: input.scheduledActionId,
      occurrenceId: "materialized-next",
      expectedDefinitionRevision: 0,
      intendedLocalDate: "2030-01-02",
      intendedLocalTime: "09:00",
      scheduledFor: new Date("2030-01-02T09:00:00.000Z"),
    };
    await expect(recurring.materialize(materialization)).resolves.toMatchObject({
      outcome: "COMMITTED",
      occurrence: { id: "materialized-next", status: "PENDING" },
    });
    await expect(recurring.materialize(materialization)).resolves.toMatchObject({
      outcome: "COMMITTED",
      occurrence: { id: "materialized-next" },
    });
    await expect(
      recurring.materialize({ ...materialization, occurrenceId: "conflicting-stable-id" }),
    ).resolves.toEqual({ outcome: "NOT_MATERIALIZED" });
    await expect(
      recurring.materialize({
        ...materialization,
        occurrenceId: "different-candidate",
        intendedLocalDate: "2030-01-03",
        scheduledFor: new Date("2030-01-03T09:00:00.000Z"),
      }),
    ).resolves.toEqual({ outcome: "NOT_MATERIALIZED" });
    for (const intendedLocalTime of ["09:00:00", "9:00", "09:00:30", "09:00.5"]) {
      await expect(
        recurring.materialize({
          ...materialization,
          occurrenceId: `invalid-time-${intendedLocalTime}`,
          intendedLocalDate: "2030-01-04",
          intendedLocalTime,
          scheduledFor: new Date("2030-01-04T09:00:00.000Z"),
        }),
      ).resolves.toEqual({ outcome: "NOT_MATERIALIZED" });
    }
  });

  it("confirms an exact materialization after transaction response loss", async () => {
    const input = createInput("materialize-response-loss");
    await recurring.create(input);
    await database.client
      .update(recurringMessageOccurrences)
      .set({
        status: "SKIPPED",
        skipReason: "MISSED_GRACE_EXCEEDED",
        terminalAt: new Date("2030-01-01T10:00:00.000Z"),
      })
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    const responseLossStore = createRecurringMessageStore(
      responseLossDatabase(() => Promise.resolve()),
    );
    await expect(
      responseLossStore.materialize({
        scheduledActionId: input.scheduledActionId,
        occurrenceId: "materialize-response-loss-next",
        expectedDefinitionRevision: 0,
        intendedLocalDate: "2030-01-02",
        intendedLocalTime: "09:00",
        scheduledFor: new Date("2030-01-02T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      occurrence: {
        id: "materialize-response-loss-next",
        status: "PENDING",
        retryCount: 0,
      },
    });
  });

  it("confirms historical materialization after a later valid recurrence edit", async () => {
    const input = createInput("materialize-then-edit-response-loss");
    await recurring.create(input);
    await database.client
      .update(recurringMessageOccurrences)
      .set({
        status: "SKIPPED",
        skipReason: "MISSED_GRACE_EXCEEDED",
        terminalAt: new Date("2030-01-01T10:00:00.000Z"),
      })
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    const responseLossStore = createRecurringMessageStore(
      responseLossDatabase(async () => {
        await expect(
          recurring.editRecurrence({
            scheduledActionId: input.scheduledActionId,
            actorId: "later-editor",
            expectedRevision: 0,
            recurrence: { ...dailyRecurrence, localTime: "10:00" },
            effectiveAt: new Date("2030-01-02T09:00:01.000Z"),
            replacementOccurrenceId: "materialize-then-edit-replacement",
            auditId: "materialize-then-edit-audit",
            gapAuditIds: [],
          }),
        ).resolves.toMatchObject({ outcome: "COMMITTED" });
      }),
    );
    await expect(
      responseLossStore.materialize({
        scheduledActionId: input.scheduledActionId,
        occurrenceId: "materialize-then-edit-original",
        expectedDefinitionRevision: 0,
        intendedLocalDate: "2030-01-02",
        intendedLocalTime: "09:00",
        scheduledFor: new Date("2030-01-02T09:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      occurrence: {
        id: "materialize-then-edit-original",
        status: "SKIPPED",
        skipReason: "RECURRENCE_EDITED",
      },
    });
    await expect(recurring.find(input.scheduledActionId)).resolves.toMatchObject({
      recurrence: { definitionRevision: 1 },
      occurrence: { id: "materialize-then-edit-replacement" },
    });
  });

  it("leaves materialization unconfirmed when the transaction did not commit", async () => {
    const input = createInput("materialize-rolled-back");
    await recurring.create(input);
    await database.client
      .update(recurringMessageOccurrences)
      .set({
        status: "SKIPPED",
        skipReason: "MISSED_GRACE_EXCEEDED",
        terminalAt: new Date("2030-01-01T10:00:00.000Z"),
      })
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
    const transaction = database.client.transaction.bind(database.client);
    const rollbackDatabase = new Proxy(database.client, {
      get(target, property): unknown {
        if (property === "transaction") {
          return async (callback: never) =>
            transaction(async (transactionClient) => {
              await (callback as unknown as (client: typeof transactionClient) => Promise<unknown>)(
                transactionClient,
              );
              throw new Error("injected rollback before commit");
            });
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      createRecurringMessageStore(rollbackDatabase).materialize({
        scheduledActionId: input.scheduledActionId,
        occurrenceId: "materialize-rolled-back-next",
        expectedDefinitionRevision: 0,
        intendedLocalDate: "2030-01-02",
        intendedLocalTime: "09:00",
        scheduledFor: new Date("2030-01-02T09:00:00.000Z"),
      }),
    ).resolves.toEqual({ outcome: "PERSISTENCE_UNCONFIRMED" });
    await expect(
      database.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, "materialize-rolled-back-next")),
    ).resolves.toEqual([]);
  });

  it("confirms exact historical mutation audits after a later valid revision", async () => {
    const creationInput = createInput("creation-response-loss");
    const responseLossCreationStore = createRecurringMessageStore(
      responseLossDatabase(() => Promise.resolve()),
    );
    await expect(responseLossCreationStore.create(creationInput)).resolves.toMatchObject({
      outcome: "COMMITTED",
      series: { revision: 0, occurrence: { id: creationInput.occurrenceId } },
    });

    const input = createInput("response-loss");
    await recurring.create(input);
    const responseLossPayloadStore = createRecurringMessageStore(
      responseLossDatabase(async () => {
        await recurring.editPayload({
          scheduledActionId: input.scheduledActionId,
          actorId: "later-editor",
          expectedRevision: 1,
          payload: { content: "second edit", embed: null },
          auditId: "second-edit-audit",
          occurredAt: new Date("2026-09-18T05:00:01.000Z"),
        });
      }),
    );
    await expect(
      responseLossPayloadStore.editPayload({
        scheduledActionId: input.scheduledActionId,
        actorId: "first-editor",
        expectedRevision: 0,
        payload: { content: "first edit", embed: null },
        auditId: "first-edit-audit",
        occurredAt: new Date("2026-09-18T05:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED", series: { revision: 2 } });
    await expect(recurring.find(input.scheduledActionId)).resolves.toMatchObject({
      revision: 2,
      payload: { content: "second edit" },
    });

    const recurrenceInput = createInput("recurrence-response-loss");
    await recurring.create(recurrenceInput);
    const responseLossRecurrenceStore = createRecurringMessageStore(
      responseLossDatabase(async () => {
        await recurring.editRecurrence({
          scheduledActionId: recurrenceInput.scheduledActionId,
          actorId: "later-editor",
          expectedRevision: 1,
          recurrence: { ...dailyRecurrence, localTime: "11:00" },
          effectiveAt: new Date("2026-09-18T06:00:01.000Z"),
          replacementOccurrenceId: "later-recurrence-occurrence",
          auditId: "later-recurrence-audit",
          gapAuditIds: [],
        });
      }),
    );
    await expect(
      responseLossRecurrenceStore.editRecurrence({
        scheduledActionId: recurrenceInput.scheduledActionId,
        actorId: "first-editor",
        expectedRevision: 0,
        recurrence: { ...dailyRecurrence, localTime: "10:00" },
        effectiveAt: new Date("2026-09-18T06:00:00.000Z"),
        replacementOccurrenceId: "first-recurrence-occurrence",
        auditId: "first-recurrence-audit",
        gapAuditIds: [],
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: false,
        replacementOccurrenceId: "first-recurrence-occurrence",
      },
    });
    await expect(recurring.find(recurrenceInput.scheduledActionId)).resolves.toMatchObject({
      revision: 2,
    });

    const deferredInput = createInput("deferred-recurrence-response-loss");
    await recurring.create(deferredInput);
    await recurring.claimInitial({
      occurrenceId: deferredInput.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    const responseLossDeferredStore = createRecurringMessageStore(
      responseLossDatabase(async () => {
        await recurring.cancel({
          scheduledActionId: deferredInput.scheduledActionId,
          actorId: "later-canceller",
          expectedRevision: 1,
          auditId: "later-deferred-cancel-audit",
          occurredAt: new Date("2030-01-01T09:02:00.000Z"),
        });
      }),
    );
    await expect(
      responseLossDeferredStore.editRecurrence({
        scheduledActionId: deferredInput.scheduledActionId,
        actorId: "first-editor",
        expectedRevision: 0,
        recurrence: { ...dailyRecurrence, localTime: "10:00" },
        effectiveAt: new Date("2030-01-01T09:01:00.000Z"),
        replacementOccurrenceId: "unused-deferred-response-loss-replacement",
        auditId: "first-deferred-recurrence-audit",
        gapAuditIds: [],
      }),
    ).resolves.toEqual({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: true,
        replacementOccurrenceId: null,
        replacementScheduledFor: null,
      },
    });
    await expect(recurring.find(deferredInput.scheduledActionId)).resolves.toMatchObject({
      revision: 2,
      action: { status: "CANCELLED" },
    });

    const cancellationInput = createInput("cancellation-response-loss");
    await recurring.create(cancellationInput);
    const responseLossCancellationStore = createRecurringMessageStore(
      responseLossDatabase(() => Promise.resolve()),
    );
    await expect(
      responseLossCancellationStore.cancel({
        scheduledActionId: cancellationInput.scheduledActionId,
        actorId: "canceller",
        expectedRevision: 0,
        auditId: "response-loss-cancellation-audit",
        occurredAt: new Date("2026-09-18T07:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      series: { action: { status: "CANCELLED" }, revision: 1 },
    });
  });

  it("supports atomic terminal advancement for active and cancelled series", async () => {
    const activeInput = createInput("terminal-active");
    const activeCreated = await recurring.create(activeInput);
    if (activeCreated.outcome !== "COMMITTED" || activeCreated.series.occurrence === null) {
      throw new Error("active terminal fixture creation failed");
    }
    const activeClaim = await recurring.claimInitial({
      occurrenceId: activeInput.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    if (activeClaim.outcome !== "COMMITTED") throw new Error("active terminal claim failed");
    const nextScheduledFor = new Date("2030-01-02T09:00:00.000Z");
    await database.client.transaction(async (transaction) => {
      await transaction
        .update(recurringMessageOccurrences)
        .set({
          status: "COMPLETED",
          resultMessageId: "terminal-result",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, activeClaim.occurrence.id));
      await transaction.insert(recurringMessageOccurrences).values({
        id: "terminal-active-next",
        scheduledActionId: activeInput.scheduledActionId,
        materializedDefinitionRevision: 0,
        intendedLocalDate: "2030-01-02",
        intendedLocalTime: "09:00",
        scheduledFor: nextScheduledFor,
        status: "PENDING",
        retryCount: 0,
      });
      await transaction
        .update(scheduledActions)
        .set({ executeAt: nextScheduledFor })
        .where(eq(scheduledActions.id, activeInput.scheduledActionId));
      await transaction.insert(recurringMessageAudits).values({
        id: "terminal-active-audit",
        scheduledActionId: activeInput.scheduledActionId,
        occurrenceId: activeClaim.occurrence.id,
        guildId: activeInput.guildId,
        channelId: activeInput.channelId,
        event: "OCCURRENCE_COMPLETED",
        actorType: "SYSTEM",
        intendedLocalDate: activeClaim.occurrence.intendedLocalDate,
        intendedLocalTime: activeClaim.occurrence.intendedLocalTime,
        scheduledFor: activeClaim.occurrence.scheduledFor,
        claimedSeriesRevision: activeClaim.occurrence.claimedSeriesRevision,
        claimedDefinitionRevision: activeClaim.occurrence.claimedDefinitionRevision,
        retryCount: activeClaim.occurrence.retryCount,
        resultMessageId: "terminal-result",
        nextOccurrenceId: "terminal-active-next",
        nextIntendedLocalDate: "2030-01-02",
        nextIntendedLocalTime: "09:00",
        nextScheduledFor,
        postSeriesStatus: "ACTIVE",
        occurredAt: new Date("2030-01-01T09:01:00.000Z"),
        outcome: "SUCCESS",
      });
    });
    await expect(recurring.find(activeInput.scheduledActionId)).resolves.toMatchObject({
      action: { executeAt: nextScheduledFor },
      occurrence: { id: "terminal-active-next", status: "PENDING" },
    });

    const cancelledInput = createInput("terminal-cancelled");
    await recurring.create(cancelledInput);
    const cancelledClaim = await recurring.claimInitial({
      occurrenceId: cancelledInput.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    if (cancelledClaim.outcome !== "COMMITTED") {
      throw new Error("cancelled terminal claim failed");
    }
    await recurring.cancel({
      scheduledActionId: cancelledInput.scheduledActionId,
      actorId: "terminal-canceller",
      expectedRevision: 0,
      auditId: "terminal-cancel-audit",
      occurredAt: new Date("2030-01-01T09:00:30.000Z"),
    });
    await database.client.transaction(async (transaction) => {
      await transaction
        .update(recurringMessageOccurrences)
        .set({
          status: "FAILED",
          failureCode: "SEND_REJECTED",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, cancelledClaim.occurrence.id));
      await transaction.insert(recurringMessageAudits).values({
        id: "terminal-cancelled-audit",
        scheduledActionId: cancelledInput.scheduledActionId,
        occurrenceId: cancelledClaim.occurrence.id,
        guildId: cancelledInput.guildId,
        channelId: cancelledInput.channelId,
        event: "OCCURRENCE_FAILED",
        actorType: "SYSTEM",
        intendedLocalDate: cancelledClaim.occurrence.intendedLocalDate,
        intendedLocalTime: cancelledClaim.occurrence.intendedLocalTime,
        scheduledFor: cancelledClaim.occurrence.scheduledFor,
        claimedSeriesRevision: cancelledClaim.occurrence.claimedSeriesRevision,
        claimedDefinitionRevision: cancelledClaim.occurrence.claimedDefinitionRevision,
        retryCount: cancelledClaim.occurrence.retryCount,
        failureCode: "SEND_REJECTED",
        postSeriesStatus: "CANCELLED",
        occurredAt: new Date("2030-01-01T09:01:00.000Z"),
        outcome: "FAILURE",
      });
    });
    await expect(recurring.find(cancelledInput.scheduledActionId)).resolves.toMatchObject({
      action: { status: "CANCELLED" },
      occurrence: null,
    });
  });

  it("enforces the occurrence lifecycle matrix for every status", async () => {
    const createAndClaim = async (suffix: string) => {
      const input = createInput(`lifecycle-${suffix}`);
      await recurring.create(input);
      const claim = await recurring.claimInitial({
        occurrenceId: input.occurrenceId,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2030-01-01T09:00:00.000Z"),
      });
      if (claim.outcome !== "COMMITTED") throw new Error(`lifecycle ${suffix} claim failed`);
      return { input, occurrence: claim.occurrence };
    };

    const executing = await createAndClaim("executing");
    expect(executing.occurrence.status).toBe("EXECUTING");
    for (const invalidShape of [
      { claimContent: null },
      { claimedDefinitionRevision: null },
      { claimedSeriesRevision: null },
      { firstAttemptedAt: null },
      { resultMessageId: "result-before-terminal" },
      { failureCode: "SEND_REJECTED" as const },
      { terminalAt: new Date("2030-01-01T09:01:00.000Z") },
    ]) {
      await expect(
        database.client
          .update(recurringMessageOccurrences)
          .set(invalidShape)
          .where(eq(recurringMessageOccurrences.id, executing.occurrence.id)),
      ).rejects.toThrow();
    }

    const retry = await createAndClaim("retry");
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({ status: "RETRY_PENDING", retryCount: 1 })
        .where(eq(recurringMessageOccurrences.id, retry.occurrence.id)),
    ).resolves.toBeDefined();
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({ retryCount: 0 })
        .where(eq(recurringMessageOccurrences.id, retry.occurrence.id)),
    ).rejects.toThrow();

    const completed = await createAndClaim("completed");
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({
          status: "COMPLETED",
          resultMessageId: "lifecycle-result",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, completed.occurrence.id)),
    ).resolves.toBeDefined();
    for (const invalidShape of [
      { resultMessageId: null },
      { failureCode: "SEND_REJECTED" as const },
      { terminalAt: null },
    ]) {
      await expect(
        database.client
          .update(recurringMessageOccurrences)
          .set(invalidShape)
          .where(eq(recurringMessageOccurrences.id, completed.occurrence.id)),
      ).rejects.toThrow();
    }

    const failed = await createAndClaim("failed");
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({
          status: "FAILED",
          failureCode: "SEND_REJECTED",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, failed.occurrence.id)),
    ).resolves.toBeDefined();
    for (const invalidShape of [
      { failureCode: null },
      { resultMessageId: "result-with-invalid-failure" },
      { terminalAt: null },
    ]) {
      await expect(
        database.client
          .update(recurringMessageOccurrences)
          .set(invalidShape)
          .where(eq(recurringMessageOccurrences.id, failed.occurrence.id)),
      ).rejects.toThrow();
    }

    const unclaimedSkipped = createInput("lifecycle-unclaimed-skipped");
    await recurring.create(unclaimedSkipped);
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({
          status: "SKIPPED",
          skipReason: "RECURRENCE_EDITED",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, unclaimedSkipped.occurrenceId)),
    ).resolves.toBeDefined();

    const claimedSkipped = await createAndClaim("claimed-skipped");
    await database.client
      .update(recurringMessageOccurrences)
      .set({ status: "RETRY_PENDING", retryCount: 1 })
      .where(eq(recurringMessageOccurrences.id, claimedSkipped.occurrence.id));
    await expect(
      database.client
        .update(recurringMessageOccurrences)
        .set({
          status: "SKIPPED",
          skipReason: "SERIES_CANCELLED",
          terminalAt: new Date("2030-01-01T09:01:00.000Z"),
        })
        .where(eq(recurringMessageOccurrences.id, claimedSkipped.occurrence.id)),
    ).resolves.toBeDefined();

    const invalid = createInput("lifecycle-invalid");
    await recurring.create(invalid);
    for (const invalidShape of [
      { status: "EXECUTING" as const },
      { status: "RETRY_PENDING" as const, retryCount: 1 },
      {
        status: "COMPLETED" as const,
        resultMessageId: "result-without-claim",
        terminalAt: new Date("2030-01-01T09:01:00.000Z"),
      },
      {
        status: "FAILED" as const,
        failureCode: "SEND_REJECTED" as const,
        terminalAt: new Date("2030-01-01T09:01:00.000Z"),
      },
      { status: "SKIPPED" as const, terminalAt: new Date("2030-01-01T09:01:00.000Z") },
      { status: "PENDING" as const, resultMessageId: "invalid-pending-result" },
    ]) {
      await expect(
        database.client
          .update(recurringMessageOccurrences)
          .set(invalidShape)
          .where(eq(recurringMessageOccurrences.id, invalid.occurrenceId)),
      ).rejects.toThrow();
    }
  });

  it("serializes cancellation with claims in both winning orders", async () => {
    const cancellationWins = createInput("cancel-first");
    await recurring.create(cancellationWins);
    await expect(
      recurring.cancel({
        scheduledActionId: cancellationWins.scheduledActionId,
        actorId: "canceller",
        expectedRevision: 0,
        auditId: "cancel-first-audit",
        occurredAt: new Date("2026-09-18T04:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      series: { action: { status: "CANCELLED" }, revision: 1, occurrence: null },
    });
    await expect(
      recurring.claimInitial({
        occurrenceId: cancellationWins.occurrenceId,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2026-09-18T04:00:01.000Z"),
      }),
    ).resolves.toEqual({ outcome: "NOT_CLAIMED" });

    const claimWins = createInput("claim-first");
    await recurring.create(claimWins);
    await recurring.claimInitial({
      occurrenceId: claimWins.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2026-09-18T04:01:00.000Z"),
    });
    const cancelled = await recurring.cancel({
      scheduledActionId: claimWins.scheduledActionId,
      actorId: "canceller",
      expectedRevision: 0,
      auditId: "claim-first-cancel-audit",
      occurredAt: new Date("2026-09-18T04:01:01.000Z"),
    });
    expect(cancelled).toMatchObject({
      outcome: "COMMITTED",
      series: {
        action: { status: "CANCELLED" },
        occurrence: { id: claimWins.occurrenceId, status: "EXECUTING" },
      },
    });
  });

  for (const mutation of ["payload", "recurrence", "cancel"] as const) {
    it(`serializes a real PostgreSQL ${mutation} transaction before a claim`, async () => {
      const input = createInput(`${mutation}-transaction-first`);
      await recurring.create(input);
      const ready = deferred<void>();
      const release = deferred<void>();
      const pausedStore = createRecurringMessageStore(
        pauseTransactionBeforeCommitDatabase(ready, release),
      );
      const mutationPromise = runConcurrentMutation(pausedStore, mutation, input, "first");
      await ready.promise;
      const claimPromise = recurring.claimInitial({
        occurrenceId: input.occurrenceId,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2030-01-01T09:00:00.000Z"),
      });
      await expectPromisePending(claimPromise);
      release.resolve();
      await expect(mutationPromise).resolves.toMatchObject({ outcome: "COMMITTED" });
      await expect(claimPromise).resolves.toEqual({ outcome: "NOT_CLAIMED" });
      const [oldOccurrence] = await database.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, input.occurrenceId));
      expect(oldOccurrence?.claimedAt).toBeNull();
      if (mutation === "recurrence") {
        expect(oldOccurrence).toMatchObject({ status: "SKIPPED", skipReason: "RECURRENCE_EDITED" });
        await expect(recurring.find(input.scheduledActionId)).resolves.toMatchObject({
          revision: 1,
          recurrence: { definitionRevision: 1 },
          occurrence: { materializedDefinitionRevision: 1, status: "PENDING" },
        });
      } else if (mutation === "cancel") {
        expect(oldOccurrence).toMatchObject({ status: "SKIPPED", skipReason: "SERIES_CANCELLED" });
      } else {
        expect(oldOccurrence).toMatchObject({ status: "PENDING" });
      }
    });

    it(`serializes a real PostgreSQL claim before a ${mutation} transaction`, async () => {
      const input = createInput(`claim-before-${mutation}`);
      await recurring.create(input);
      const ready = deferred<void>();
      const release = deferred<void>();
      const pausedStore = createRecurringMessageStore(
        pauseTransactionBeforeCommitDatabase(ready, release),
      );
      const claimPromise = pausedStore.claimInitial({
        occurrenceId: input.occurrenceId,
        expectedSeriesRevision: 0,
        claimedAt: new Date("2030-01-01T09:00:00.000Z"),
      });
      await ready.promise;
      const mutationPromise = runConcurrentMutation(recurring, mutation, input, "second");
      await expectPromisePending(mutationPromise);
      release.resolve();
      await expect(claimPromise).resolves.toMatchObject({
        outcome: "COMMITTED",
        occurrence: {
          claimedSeriesRevision: 0,
          claimedDefinitionRevision: 0,
          claimContent: "original",
        },
      });
      await expect(mutationPromise).resolves.toMatchObject({ outcome: "COMMITTED" });
      const persisted = await recurring.find(input.scheduledActionId);
      expect(persisted?.occurrence).toMatchObject({
        id: input.occurrenceId,
        status: "EXECUTING",
        claimedSeriesRevision: 0,
        claimedDefinitionRevision: 0,
        claimContent: "original",
      });
      if (mutation === "payload") {
        expect(persisted).toMatchObject({
          revision: 1,
          payload: { content: "concurrently edited" },
          recurrence: { definitionRevision: 0 },
        });
      } else if (mutation === "recurrence") {
        expect(persisted).toMatchObject({
          revision: 1,
          recurrence: { definitionRevision: 1 },
        });
        expect(persisted?.recurrence.localTime.slice(0, 5)).toBe("10:00");
        const [editAudit] = await database.client
          .select()
          .from(recurringMessageAudits)
          .where(eq(recurringMessageAudits.id, `${input.auditId}-second-recurrence`));
        expect(editAudit).toMatchObject({ deferredMaterialization: true });
      } else {
        expect(persisted).toMatchObject({ action: { status: "CANCELLED" }, revision: 1 });
      }
    });
  }

  it("keeps find coherent when a recurrence edit commits after its first SELECT", async () => {
    const input = createInput("coherent-find");
    await recurring.create(input);
    const firstSelectFinished = deferred<void>();
    const releaseFirstResult = deferred<void>();
    let selectCount = 0;
    const gateQuery = (query: object): object =>
      new Proxy(query, {
        get(target, property): unknown {
          const value: unknown = Reflect.get(target, property, target);
          if (property === "then") {
            const then = value as (
              onFulfilled: (rows: unknown) => Promise<unknown>,
            ) => Promise<unknown>;
            return (
              onFulfilled?: (rows: unknown) => unknown,
              onRejected?: (error: unknown) => unknown,
            ) =>
              then
                .call(target, async (rows) => {
                  // The SQL statement has finished, but find has not received its rows yet.
                  firstSelectFinished.resolve();
                  await releaseFirstResult.promise;
                  return rows;
                })
                .then(onFulfilled, onRejected);
          }
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            const next: unknown = value.apply(target, args);
            return next !== null && typeof next === "object" ? gateQuery(next) : next;
          };
        },
      });
    const gatedDatabase = new Proxy(database.client, {
      get(target, property): unknown {
        const value: unknown = Reflect.get(target, property, target);
        if (property === "select") {
          return (...args: unknown[]) => {
            const query = (value as (...args: unknown[]) => object).apply(target, args);
            selectCount += 1;
            return selectCount === 1 ? gateQuery(query) : query;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const readPromise = createRecurringMessageStore(gatedDatabase).find(input.scheduledActionId);
    void readPromise.catch((error: unknown) => firstSelectFinished.reject(error));
    let editResult: RecurringMutationResult | RecurrenceEditResult | undefined;
    let editError: unknown;
    try {
      await firstSelectFinished.promise;
      editResult = await runConcurrentMutation(recurring, "recurrence", input, "coherent");
    } catch (error) {
      editError = error;
    } finally {
      releaseFirstResult.resolve();
    }
    const read = await readPromise;
    if (editError !== undefined) {
      throw editError instanceof Error
        ? editError
        : new Error("recurrence edit failed", { cause: editError });
    }
    expect(editResult).toMatchObject({ outcome: "COMMITTED" });
    expect(selectCount).toBe(1);
    // A second SELECT here would see the replacement occurrence and tear this old series read.
    expect(read).toMatchObject({
      revision: 0,
      recurrence: { definitionRevision: 0 },
      occurrence: { id: input.occurrenceId, materializedDefinitionRevision: 0 },
    });
    await expect(recurring.find(input.scheduledActionId)).resolves.toMatchObject({
      revision: 1,
      recurrence: { definitionRevision: 1 },
      occurrence: {
        id: `${input.occurrenceId}-coherent-replacement`,
        materializedDefinitionRevision: 1,
      },
    });
  });

  it("excludes recurring rows from every one-time authority and administration path", async () => {
    const input = createInput("isolation");
    await recurring.create(input);
    await expect(actions.findActiveScheduledMessagesPage()).resolves.toEqual([]);
    await database.client
      .update(scheduledActions)
      .set({ status: "EXECUTING" })
      .where(eq(scheduledActions.id, input.scheduledActionId));
    await expect(actions.findExecutingScheduledMessagesPage()).resolves.toEqual([]);
    await database.client
      .update(scheduledActions)
      .set({ status: "ACTIVE" })
      .where(eq(scheduledActions.id, input.scheduledActionId));
    await expect(oneTime.findForExecution(input.scheduledActionId)).resolves.toEqual({
      outcome: "MISSING_ACTION",
    });
    await expect(oneTime.claimExecution(input.scheduledActionId, 0)).resolves.toEqual({
      outcome: "NOT_TRANSITIONED",
      current: undefined,
    });
    const discord = {
      preflight: vi.fn<ScheduledMessageDiscord["preflight"]>(),
      createMessage: vi.fn<ScheduledMessageDiscord["createMessage"]>(),
      deleteMessage: vi.fn<ScheduledMessageDiscord["deleteMessage"]>(),
    } satisfies ScheduledMessageDiscord;
    const executor = createScheduledMessageExecutor({ store: oneTime, discord });
    await expect(executor.execute(input.scheduledActionId)).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "MISSING",
    });
    expect(discord.preflight).not.toHaveBeenCalled();
    expect(discord.createMessage).not.toHaveBeenCalled();
    await expect(
      oneTime.findStatus(input.scheduledActionId, input.guildId, input.channelId),
    ).resolves.toEqual({
      outcome: "NOT_FOUND_OR_WRONG_CONTEXT",
    });
    await expect(oneTime.listNonterminal(input.guildId, input.channelId, 0)).resolves.toEqual({
      outcome: "FOUND",
      schedules: [],
    });
    await expect(
      oneTime.findEditable(input.scheduledActionId, input.guildId, input.channelId),
    ).resolves.toEqual({
      outcome: "NOT_FOUND_OR_WRONG_CONTEXT",
    });
    await expect(
      oneTime.edit({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: "one-time-admin",
        expectedRevision: 0,
        payload: { content: "must not edit", embed: null },
        auditId: "one-time-edit-recurring",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });
    await expect(
      oneTime.reschedule({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: "one-time-admin",
        expectedRevision: 0,
        executeAt: new Date("2035-01-01T00:00:00.000Z"),
        auditId: "one-time-reschedule-recurring",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });
    await expect(
      oneTime.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: "one-time-admin",
        auditId: "one-time-cancel-recurring",
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });
    expect((await recurring.find(input.scheduledActionId))?.action.status).toBe("ACTIVE");

    const oneTimeInput = {
      scheduledActionId: "one-time-control",
      auditId: "one-time-control-audit",
      guildId: input.guildId,
      channelId: input.channelId,
      actorId: "one-time-actor",
      executeAt: new Date("2030-01-01T00:00:00.000Z"),
      payload: { content: "one-time control", embed: null },
      occurredAt: new Date("2026-09-18T01:00:00.000Z"),
    };
    await oneTime.create(oneTimeInput);
    await expect(oneTime.findForExecution(oneTimeInput.scheduledActionId)).resolves.toMatchObject({
      outcome: "FOUND",
      definition: { action: { id: oneTimeInput.scheduledActionId } },
    });
    await expect(actions.findActiveScheduledMessagesPage()).resolves.toEqual([
      expect.objectContaining({ id: oneTimeInput.scheduledActionId }),
    ]);
    await expect(oneTime.listNonterminal(input.guildId, input.channelId, 0)).resolves.toMatchObject(
      {
        outcome: "FOUND",
        schedules: [expect.objectContaining({ scheduledActionId: oneTimeInput.scheduledActionId })],
      },
    );
  });

  it("enforces discriminator, uniqueness, lifecycle, and bounded values in PostgreSQL", async () => {
    const input = createInput("constraints");
    await recurring.create(input);
    const claim = await recurring.claimInitial({
      occurrenceId: input.occurrenceId,
      expectedSeriesRevision: 0,
      claimedAt: new Date("2030-01-01T09:00:00.000Z"),
    });
    if (claim.outcome !== "COMMITTED") throw new Error("fixture claim failed");
    const occurrence = claim.occurrence;
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "active-terminal-shape",
        scheduledActionId: input.scheduledActionId,
        occurrenceId: occurrence.id,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "OCCURRENCE_COMPLETED",
        actorType: "SYSTEM",
        intendedLocalDate: occurrence.intendedLocalDate,
        intendedLocalTime: occurrence.intendedLocalTime,
        scheduledFor: occurrence.scheduledFor,
        claimedSeriesRevision: occurrence.claimedSeriesRevision,
        claimedDefinitionRevision: occurrence.claimedDefinitionRevision,
        retryCount: occurrence.retryCount,
        resultMessageId: "result-message",
        nextOccurrenceId: "historical-next",
        nextIntendedLocalDate: "2030-01-02",
        nextIntendedLocalTime: "09:00",
        nextScheduledFor: new Date("2030-01-02T09:00:00.000Z"),
        postSeriesStatus: "ACTIVE",
        occurredAt: new Date("2030-01-01T09:01:00.000Z"),
        outcome: "SUCCESS",
      }),
    ).resolves.toBeDefined();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "cancelled-terminal-shape",
        scheduledActionId: input.scheduledActionId,
        occurrenceId: occurrence.id,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "OCCURRENCE_FAILED",
        actorType: "SYSTEM",
        intendedLocalDate: occurrence.intendedLocalDate,
        intendedLocalTime: occurrence.intendedLocalTime,
        scheduledFor: occurrence.scheduledFor,
        claimedSeriesRevision: occurrence.claimedSeriesRevision,
        claimedDefinitionRevision: occurrence.claimedDefinitionRevision,
        retryCount: occurrence.retryCount,
        failureCode: "SEND_REJECTED",
        postSeriesStatus: "CANCELLED",
        occurredAt: new Date("2030-01-01T09:02:00.000Z"),
        outcome: "FAILURE",
      }),
    ).resolves.toBeDefined();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "retry-audit-shape",
        scheduledActionId: input.scheduledActionId,
        occurrenceId: occurrence.id,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "OCCURRENCE_RETRY",
        actorType: "SYSTEM",
        intendedLocalDate: occurrence.intendedLocalDate,
        intendedLocalTime: occurrence.intendedLocalTime,
        scheduledFor: occurrence.scheduledFor,
        claimedSeriesRevision: occurrence.claimedSeriesRevision,
        claimedDefinitionRevision: occurrence.claimedDefinitionRevision,
        retryCount: 1,
        failureCode: "CURRENT_STATE_CHECK_FAILED",
        occurredAt: new Date("2030-01-01T09:00:30.000Z"),
        outcome: "FAILURE",
      }),
    ).resolves.toBeDefined();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "dst-gap-audit-shape",
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "DST_GAP_SKIPPED",
        actorType: "USER",
        actorId: input.actorId,
        intendedLocalDate: "2030-03-10",
        intendedLocalTime: "02:30",
        afterTimezone: "America/New_York",
        afterDefinitionRevision: 0,
        auditSkipReason: "DST_GAP",
        occurredAt: new Date("2030-03-01T00:00:00.000Z"),
        outcome: "SKIPPED",
      }),
    ).resolves.toBeDefined();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "missed-range-audit-shape",
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "MISSED_RANGE_SKIPPED",
        actorType: "SYSTEM",
        afterTimezone: "UTC",
        afterDefinitionRevision: 0,
        skippedFromLocalDate: "2030-01-01",
        skippedFromLocalTime: "09:00",
        skippedThroughLocalDate: "2030-01-31",
        skippedThroughLocalTime: "09:00",
        selectedNextLocalDate: "2030-02-01",
        selectedNextLocalTime: "09:00",
        selectedNextScheduledFor: new Date("2030-02-01T09:00:00.000Z"),
        auditSkipReason: "MISSED_GRACE_EXCEEDED",
        occurredAt: new Date("2030-02-01T00:00:00.000Z"),
        outcome: "SKIPPED",
      }),
    ).resolves.toBeDefined();

    const matrixInput = createInput("audit-matrix");
    await expect(recurring.create(matrixInput)).resolves.toMatchObject({ outcome: "COMMITTED" });
    await expect(
      recurring.editPayload({
        scheduledActionId: matrixInput.scheduledActionId,
        actorId: "matrix-editor",
        expectedRevision: 0,
        payload: { content: "matrix edit", embed: null },
        auditId: "matrix-payload",
        occurredAt: new Date("2030-01-01T10:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED" });
    await expect(
      recurring.editRecurrence({
        scheduledActionId: matrixInput.scheduledActionId,
        actorId: "matrix-editor",
        expectedRevision: 1,
        recurrence: { ...dailyRecurrence, localTime: "10:00" },
        effectiveAt: new Date("2030-01-01T10:00:01.000Z"),
        replacementOccurrenceId: "matrix-replacement",
        auditId: "matrix-recurrence",
        gapAuditIds: [],
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED" });
    await expect(
      recurring.cancel({
        scheduledActionId: matrixInput.scheduledActionId,
        actorId: "matrix-editor",
        expectedRevision: 2,
        auditId: "matrix-cancel",
        occurredAt: new Date("2030-01-01T10:00:02.000Z"),
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED" });

    const positiveAuditIds = [
      matrixInput.auditId,
      "matrix-payload",
      "matrix-recurrence",
      "matrix-cancel",
      "retry-audit-shape",
      "active-terminal-shape",
      "cancelled-terminal-shape",
      "dst-gap-audit-shape",
      "missed-range-audit-shape",
    ];
    const positiveAudits = await database.client
      .select()
      .from(recurringMessageAudits)
      .where(inArray(recurringMessageAudits.id, positiveAuditIds));
    expect(new Set(positiveAudits.map((audit) => audit.event))).toEqual(
      new Set([
        "SERIES_CREATED",
        "PAYLOAD_EDITED",
        "RECURRENCE_EDITED",
        "SERIES_CANCELLED",
        "OCCURRENCE_RETRY",
        "OCCURRENCE_COMPLETED",
        "OCCURRENCE_FAILED",
        "DST_GAP_SKIPPED",
        "MISSED_RANGE_SKIPPED",
      ]),
    );
    const missingRequired = {
      SERIES_CREATED: "afterContent",
      PAYLOAD_EDITED: "beforeContent",
      RECURRENCE_EDITED: "beforeFrequency",
      SERIES_CANCELLED: "beforeRevision",
      OCCURRENCE_RETRY: "occurrenceId",
      OCCURRENCE_COMPLETED: "resultMessageId",
      OCCURRENCE_FAILED: "failureCode",
      DST_GAP_SKIPPED: "intendedLocalTime",
      MISSED_RANGE_SKIPPED: "afterDefinitionRevision",
    } as const;
    const extraneous = {
      SERIES_CREATED: ["failureCode", "SEND_REJECTED"],
      PAYLOAD_EDITED: ["afterTimezone", "UTC"],
      RECURRENCE_EDITED: ["nextOccurrenceId", "contaminating-next"],
      SERIES_CANCELLED: ["resultMessageId", "contaminating-result"],
      OCCURRENCE_RETRY: ["nextOccurrenceId", "contaminating-next"],
      OCCURRENCE_COMPLETED: ["failureCode", "SEND_REJECTED"],
      OCCURRENCE_FAILED: ["auditSkipReason", "DST_GAP"],
      DST_GAP_SKIPPED: ["scheduledFor", new Date("2030-03-10T07:30:00.000Z")],
      MISSED_RANGE_SKIPPED: ["resultMessageId", "contaminating-result"],
    } as const;
    for (const audit of positiveAudits) {
      const missing = {
        ...audit,
        id: `missing-${audit.event}`,
        [missingRequired[audit.event]]: null,
      } as typeof recurringMessageAudits.$inferInsert;
      await expect(
        database.client.insert(recurringMessageAudits).values(missing),
      ).rejects.toThrow();
      const [column, value] = extraneous[audit.event];
      const contaminated = {
        ...audit,
        id: `extraneous-${audit.event}`,
        [column]: value,
      } as typeof recurringMessageAudits.$inferInsert;
      await expect(
        database.client.insert(recurringMessageAudits).values(contaminated),
      ).rejects.toThrow();
    }
    const createdAudit = positiveAudits.find((audit) => audit.event === "SERIES_CREATED");
    if (createdAudit === undefined) throw new Error("matrix creation audit missing");
    await expect(
      database.client.insert(recurringMessageAudits).values({
        ...createdAudit,
        id: "missing-created-post-status",
        postSeriesStatus: null,
      }),
    ).rejects.toThrow();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        ...createdAudit,
        id: "extraneous-series-created-skip",
        occurrenceSkipReason: "SERIES_CANCELLED",
      }),
    ).rejects.toThrow();
    const gapAudit = positiveAudits.find((audit) => audit.event === "DST_GAP_SKIPPED");
    if (gapAudit === undefined) throw new Error("matrix DST gap audit missing");
    await expect(
      database.client.insert(recurringMessageAudits).values({
        ...gapAudit,
        id: "missing-dst-skip-reason",
        auditSkipReason: null,
      }),
    ).rejects.toThrow();

    for (const [index, timezone] of [
      "+05",
      "+0530",
      "+05:30",
      "+00",
      "-08",
      "-0800",
      "-08:00",
    ].entries()) {
      const scheduledActionId = `offset-zone-${index}`;
      await database.client.insert(scheduledActions).values({
        id: scheduledActionId,
        guildId: "constraint-guild",
        actionType: "SEND_MESSAGE",
        targetId: "constraint-channel",
        status: "ACTIVE",
        executeAt: new Date("2030-01-01T00:00:00.000Z"),
      });
      await expect(
        database.client.insert(recurringMessageSchedules).values({
          scheduledActionId,
          timezone,
          frequency: "DAILY",
          weekdayMask: ALL_WEEKDAYS_MASK,
          localTime: "09:00",
          definitionRevision: 0,
          effectiveAt: new Date("2030-01-01T00:00:00.000Z"),
        }),
      ).rejects.toThrow();
    }

    await database.client.insert(scheduledActions).values({
      id: "seconds-schedule-parent",
      guildId: "constraint-guild",
      actionType: "SEND_MESSAGE",
      targetId: "constraint-channel",
      status: "ACTIVE",
      executeAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await expect(
      database.client.insert(recurringMessageSchedules).values({
        scheduledActionId: "seconds-schedule-parent",
        timezone: "UTC",
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00:30",
        definitionRevision: 0,
        effectiveAt: new Date("2030-01-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(
      database.client.insert(recurringMessageOccurrences).values({
        id: "seconds-occurrence",
        scheduledActionId: input.scheduledActionId,
        materializedDefinitionRevision: 8,
        intendedLocalDate: "2038-01-01",
        intendedLocalTime: "09:00:30",
        scheduledFor: new Date("2038-01-01T09:00:30.000Z"),
        status: "SKIPPED",
        retryCount: 0,
        skipReason: "MISSED_GRACE_EXCEEDED",
        terminalAt: new Date("2038-01-01T10:00:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(
      database.client.insert(recurringMessageAudits).values({
        id: "seconds-audit",
        scheduledActionId: input.scheduledActionId,
        guildId: input.guildId,
        channelId: input.channelId,
        event: "DST_GAP_SKIPPED",
        actorType: "SYSTEM",
        intendedLocalDate: "2038-03-14",
        intendedLocalTime: "02:30:15",
        afterTimezone: "America/New_York",
        afterDefinitionRevision: 0,
        auditSkipReason: "DST_GAP",
        occurredAt: new Date("2038-03-14T00:00:00.000Z"),
        outcome: "SKIPPED",
      }),
    ).rejects.toThrow();

    for (const [index, skipReason] of (
      ["RECURRENCE_EDITED", "SERIES_CANCELLED", "MISSED_GRACE_EXCEEDED"] as const
    ).entries()) {
      await expect(
        database.client.insert(recurringMessageOccurrences).values({
          id: `unclaimed-skip-${index}`,
          scheduledActionId: input.scheduledActionId,
          materializedDefinitionRevision: 20 + index,
          intendedLocalDate: `2040-01-0${index + 1}`,
          intendedLocalTime: "09:00",
          scheduledFor: new Date(`2040-01-0${index + 1}T09:00:00.000Z`),
          status: "SKIPPED",
          retryCount: 0,
          skipReason,
          terminalAt: new Date(`2040-01-0${index + 1}T10:00:00.000Z`),
        }),
      ).resolves.toBeDefined();
    }
    const claimedSkipped = {
      scheduledActionId: input.scheduledActionId,
      materializedDefinitionRevision: 30,
      intendedLocalDate: "2041-01-01",
      intendedLocalTime: "09:00",
      scheduledFor: new Date("2041-01-01T09:00:00.000Z"),
      status: "SKIPPED" as const,
      retryCount: 1,
      firstAttemptedAt: new Date("2041-01-01T09:00:00.000Z"),
      claimedAt: new Date("2041-01-01T09:01:00.000Z"),
      claimedSeriesRevision: 0,
      claimedDefinitionRevision: 30,
      claimContent: "claimed payload",
      terminalAt: new Date("2041-01-01T09:02:00.000Z"),
    };
    await expect(
      database.client.insert(recurringMessageOccurrences).values({
        ...claimedSkipped,
        id: "claimed-series-cancelled",
        skipReason: "SERIES_CANCELLED",
      }),
    ).resolves.toBeDefined();
    for (const [index, skipReason] of (
      ["RECURRENCE_EDITED", "MISSED_GRACE_EXCEEDED"] as const
    ).entries()) {
      await expect(
        database.client.insert(recurringMessageOccurrences).values({
          ...claimedSkipped,
          id: `invalid-claimed-skip-${index}`,
          materializedDefinitionRevision: 31 + index,
          intendedLocalDate: `2041-01-0${index + 2}`,
          claimedDefinitionRevision: 31 + index,
          skipReason,
        }),
      ).rejects.toThrow();
    }

    await expect(
      database.client.execute(sql`
        insert into recurring_message_occurrences
          (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
           intended_local_time, scheduled_for, status, retry_count)
        values ('second-nonterminal', ${input.scheduledActionId}, 0, '2030-01-02', '09:00',
          ${new Date("2030-01-02T09:00:00.000Z")}, 'PENDING', 0)
      `),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        update recurring_message_occurrences set status = 'FAILED', failure_code = 'NOT_BOUNDED'
        where id = ${input.occurrenceId}
      `),
    ).rejects.toThrow();
    await database.client.insert(scheduledActions).values({
      id: "one-time-parent",
      guildId: "guild",
      actionType: "SEND_MESSAGE",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    await database.client.insert(scheduledMessageStates).values({
      scheduledActionId: "one-time-parent",
      creatorUserId: "actor",
      content: "one-time",
      retryCount: 0,
      revision: 0,
    });
    await expect(
      database.client.execute(sql`
        insert into recurring_message_occurrences
          (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
           intended_local_time, scheduled_for, status, retry_count)
        values ('invalid-one-time-child', 'one-time-parent', 0, '2030-01-02', '09:00',
          ${new Date("2030-01-02T09:00:00.000Z")}, 'PENDING', 0)
      `),
    ).rejects.toThrow();
  });
});

const dailyRecurrence = {
  frequency: "DAILY" as const,
  weekdayMask: ALL_WEEKDAYS_MASK,
  localTime: "09:00",
  timezone: "UTC",
};

function createInput(suffix: string): CreateRecurringMessageSeries {
  return {
    scheduledActionId: `recurring-${suffix}`,
    occurrenceId: `occurrence-${suffix}`,
    auditId: `audit-${suffix}`,
    gapAuditIds: [],
    guildId: "recurring-guild",
    channelId: "recurring-channel",
    actorId: "recurring-actor",
    payload: { content: "original", embed: null },
    recurrence: dailyRecurrence,
    effectiveAt: new Date("2026-09-18T01:00:00.000Z"),
  };
}

async function cleanup(): Promise<void> {
  await database.client.delete(recurringMessageAudits);
  await database.client.delete(recurringMessageOccurrences);
  await database.client.delete(recurringMessageSchedules);
  await database.client.delete(scheduledMessageAudits);
  await database.client.delete(scheduledMessageStates);
  await database.client.delete(scheduledActions);
}

function responseLossDatabase(afterCommit: () => Promise<void>): DatabaseClient {
  const transaction = database.client.transaction.bind(database.client);
  return new Proxy(database.client, {
    get(target, property): unknown {
      if (property === "transaction") {
        return async (callback: never) => {
          await transaction(callback);
          await afterCommit();
          throw new Error("injected transaction response loss");
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function pauseTransactionBeforeCommitDatabase(
  ready: ReturnType<typeof deferred<void>>,
  release: ReturnType<typeof deferred<void>>,
): DatabaseClient {
  const transaction = database.client.transaction.bind(database.client);
  return new Proxy(database.client, {
    get(target, property): unknown {
      if (property === "transaction") {
        return async (callback: never) =>
          transaction(async (transactionClient) => {
            const result = await (
              callback as unknown as (client: typeof transactionClient) => Promise<unknown>
            )(transactionClient);
            ready.resolve();
            await release.promise;
            return result;
          });
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
}

function runConcurrentMutation(
  store: RecurringMessageStore,
  mutation: "payload" | "recurrence" | "cancel",
  input: CreateRecurringMessageSeries,
  suffix: string,
): Promise<RecurringMutationResult | RecurrenceEditResult> {
  if (mutation === "payload") {
    return store.editPayload({
      scheduledActionId: input.scheduledActionId,
      actorId: "concurrent-editor",
      expectedRevision: 0,
      payload: { content: "concurrently edited", embed: null },
      auditId: `${input.auditId}-${suffix}-payload`,
      occurredAt: new Date("2030-01-01T09:00:01.000Z"),
    });
  }
  if (mutation === "recurrence") {
    return store.editRecurrence({
      scheduledActionId: input.scheduledActionId,
      actorId: "concurrent-editor",
      expectedRevision: 0,
      recurrence: { ...dailyRecurrence, localTime: "10:00" },
      effectiveAt: new Date("2030-01-01T09:00:01.000Z"),
      replacementOccurrenceId: `${input.occurrenceId}-${suffix}-replacement`,
      auditId: `${input.auditId}-${suffix}-recurrence`,
      gapAuditIds: [],
    });
  }
  return store.cancel({
    scheduledActionId: input.scheduledActionId,
    actorId: "concurrent-canceller",
    expectedRevision: 0,
    auditId: `${input.auditId}-${suffix}-cancel`,
    occurredAt: new Date("2030-01-01T09:00:01.000Z"),
  });
}
