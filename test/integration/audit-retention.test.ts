import { randomUUID } from "node:crypto";

import { asc, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { auditLogDestinationAudits } from "../../src/audit-log-destination-persistence.js";
import {
  AUDIT_RETENTION_SOURCES,
  createAuditRetentionStore,
  type AuditRetentionSource,
} from "../../src/audit-retention-persistence.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { guildSettings } from "../../src/guild-settings.js";
import { managedMessageAudits, managedMessages } from "../../src/managed-message-persistence.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "../../src/recurring-message-persistence.js";
import { createRecurringRuntimeStore } from "../../src/recurring-message-runtime-persistence.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/scheduled-message-persistence.js";
import { scheduledThreadCloseAudits } from "../../src/scheduled-thread-close-persistence.js";
import { threadAudits } from "../../src/thread-persistence.js";

const database = createDatabase(loadTestDatabaseConfig());
const store = createAuditRetentionStore(database.client);
const guildId = randomUUID();
const oneTimeId = randomUUID();
const recurringId = randomUUID();
const occurrenceId = randomUUID();
const managedId = randomUUID();
const oneTimeActionIds = [oneTimeId];
const recurringActionIds = [recurringId];
const newId = () => randomUUID();

// The store deletes globally, so keep each fixture earlier than existing audit history,
// including rows left by an interrupted previous test run.
async function isolatedTimes(): Promise<{ cutoff: Date; old: Date; recent: Date }> {
  const oldestRows = await Promise.all([
    database.client
      .select({ at: threadAudits.createdAt })
      .from(threadAudits)
      .orderBy(asc(threadAudits.createdAt))
      .limit(1),
    database.client
      .select({ at: scheduledThreadCloseAudits.createdAt })
      .from(scheduledThreadCloseAudits)
      .orderBy(asc(scheduledThreadCloseAudits.createdAt))
      .limit(1),
    database.client
      .select({ at: managedMessageAudits.occurredAt })
      .from(managedMessageAudits)
      .orderBy(asc(managedMessageAudits.occurredAt))
      .limit(1),
    database.client
      .select({ at: scheduledMessageAudits.occurredAt })
      .from(scheduledMessageAudits)
      .orderBy(asc(scheduledMessageAudits.occurredAt))
      .limit(1),
    database.client
      .select({ at: recurringMessageAudits.occurredAt })
      .from(recurringMessageAudits)
      .orderBy(asc(recurringMessageAudits.occurredAt))
      .limit(1),
    database.client
      .select({ at: auditLogDestinationAudits.occurredAt })
      .from(auditLogDestinationAudits)
      .orderBy(asc(auditLogDestinationAudits.occurredAt))
      .limit(1),
  ]);
  const earliestMs = Math.min(...oldestRows.flatMap((rows) => rows.map((row) => row.at.getTime())));
  const cutoffMs = Math.min(Date.parse("2000-01-01T00:00:00.000Z"), earliestMs - 1);
  if (!Number.isFinite(cutoffMs)) throw new Error("Invalid audit timestamp in test database");
  return {
    cutoff: new Date(cutoffMs),
    old: new Date(cutoffMs - 1),
    recent: new Date(cutoffMs + 1),
  };
}

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await database.client.insert(guildSettings).values({ guildId });
  await database.client.insert(scheduledActions).values([
    {
      id: oneTimeId,
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: new Date("2031-01-01T00:00:00.000Z"),
    },
    {
      id: recurringId,
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: new Date("2031-01-01T09:00:00.000Z"),
    },
  ]);
  await database.client.insert(scheduledMessageStates).values([
    { scheduledActionId: oneTimeId, creatorUserId: "actor", content: "one-time payload" },
    { scheduledActionId: recurringId, creatorUserId: "actor", content: "recurring payload" },
  ]);
  await database.client.insert(recurringMessageSchedules).values({
    scheduledActionId: recurringId,
    timezone: "UTC",
    frequency: "DAILY",
    weekdayMask: 127,
    localTime: "09:00",
    definitionRevision: 0,
    effectiveAt: new Date("2030-12-31T09:00:00.000Z"),
  });
  await database.client.insert(recurringMessageOccurrences).values({
    id: occurrenceId,
    scheduledActionId: recurringId,
    materializedDefinitionRevision: 0,
    intendedLocalDate: "2031-01-01",
    intendedLocalTime: "09:00",
    scheduledFor: new Date("2031-01-01T09:00:00.000Z"),
    status: "PENDING",
  });
  await database.client.insert(managedMessages).values({
    messageId: managedId,
    guildId,
    channelId: "channel",
    creatorUserId: "actor",
    content: "managed payload",
    status: "ACTIVE",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
  });
});

afterAll(async () => {
  try {
    await database.client
      .delete(auditLogDestinationAudits)
      .where(eq(auditLogDestinationAudits.guildId, guildId));
    await database.client
      .delete(recurringMessageAudits)
      .where(eq(recurringMessageAudits.guildId, guildId));
    await database.client
      .delete(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.guildId, guildId));
    await database.client
      .delete(managedMessageAudits)
      .where(eq(managedMessageAudits.guildId, guildId));
    await database.client
      .delete(scheduledThreadCloseAudits)
      .where(eq(scheduledThreadCloseAudits.guildId, guildId));
    await database.client.delete(threadAudits).where(eq(threadAudits.guildId, guildId));
    await database.client
      .delete(recurringMessageOccurrences)
      .where(inArray(recurringMessageOccurrences.scheduledActionId, recurringActionIds));
    await database.client
      .delete(recurringMessageSchedules)
      .where(inArray(recurringMessageSchedules.scheduledActionId, recurringActionIds));
    await database.client
      .delete(scheduledMessageStates)
      .where(
        inArray(scheduledMessageStates.scheduledActionId, [
          ...oneTimeActionIds,
          ...recurringActionIds,
        ]),
      );
    await database.client
      .delete(scheduledActions)
      .where(inArray(scheduledActions.id, [...oneTimeActionIds, ...recurringActionIds]));
    await database.client.delete(managedMessages).where(eq(managedMessages.messageId, managedId));
    await database.client.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
  } finally {
    await database.close();
  }
});

async function insertAudit(source: AuditRetentionSource, id: string, at: Date) {
  switch (source) {
    case "thread_audits":
      await database.client.insert(threadAudits).values({
        id,
        guildId,
        threadId: "thread",
        action: "CLOSE",
        actorType: "USER",
        actorId: "actor",
        outcome: "SUCCESS",
        createdAt: at,
      });
      break;
    case "scheduled_thread_close_audits":
      await database.client.insert(scheduledThreadCloseAudits).values({
        id,
        scheduledActionId: oneTimeId,
        guildId,
        threadId: "thread",
        event: "CREATED",
        actorType: "USER",
        actorId: "actor",
        executeAt: new Date("2031-01-01T00:00:00.000Z"),
        outcome: "SUCCESS",
        createdAt: at,
      });
      break;
    case "managed_message_audits":
      await database.client.insert(managedMessageAudits).values({
        id,
        messageId: managedId,
        guildId,
        channelId: "channel",
        event: "CREATED",
        actorType: "USER",
        actorId: "actor",
        afterContent: "private payload",
        afterRevision: 1,
        afterStatus: "ACTIVE",
        occurredAt: at,
        outcome: "SUCCESS",
      });
      break;
    case "scheduled_message_audits":
      await database.client.insert(scheduledMessageAudits).values({
        id,
        scheduledActionId: oneTimeId,
        guildId,
        channelId: "channel",
        event: "CREATED",
        actorType: "USER",
        actorId: "actor",
        executeAt: new Date("2031-01-01T00:00:00.000Z"),
        content: "private payload",
        occurredAt: at,
        outcome: "SUCCESS",
      });
      break;
    case "recurring_message_audits":
      await database.client.insert(recurringMessageAudits).values({
        id,
        scheduledActionId: recurringId,
        guildId,
        channelId: "channel",
        event: "DST_GAP_SKIPPED",
        actorType: "SYSTEM",
        intendedLocalDate: "2031-03-09",
        intendedLocalTime: "02:30",
        afterTimezone: "UTC",
        afterDefinitionRevision: 0,
        auditSkipReason: "DST_GAP",
        occurredAt: at,
        outcome: "SKIPPED",
      });
      break;
    case "audit_log_destination_audits":
      await database.client.insert(auditLogDestinationAudits).values({
        id,
        guildId,
        actorUserId: "actor",
        previousChannelId: null,
        newChannelId: "channel",
        occurredAt: at,
        outcome: "SUCCESS",
      });
  }
}

async function remaining(source: AuditRetentionSource, ids: string[]): Promise<string[]> {
  const result = await database.client.execute<{ id: string }>(sql`
    select id from ${sql.identifier(source)}
    where id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})
    order by id
  `);
  return result.rows.map((row) => row.id);
}

describe("audit retention PostgreSQL persistence", () => {
  it.each(AUDIT_RETENTION_SOURCES)(
    "deletes only timestamps strictly before cutoff from %s",
    async (source) => {
      const { cutoff, old, recent } = await isolatedTimes();
      const ids = [newId(), newId(), newId()];
      await insertAudit(source, ids[0]!, old);
      await insertAudit(source, ids[1]!, cutoff);
      await insertAudit(source, ids[2]!, recent);
      expect(await store.deleteExpiredBatch(source, cutoff, 1)).toBe(1);
      expect(await store.deleteExpiredBatch(source, cutoff, 1)).toBe(0);
      expect(await remaining(source, ids)).toEqual(ids.slice(1).sort());
    },
  );

  it("uses timestamp then ID for bounded membership and reaches zero", async () => {
    const { cutoff, old } = await isolatedTimes();
    const prefix = randomUUID();
    const ids = [`${prefix}-a`, `${prefix}-b`, `${prefix}-c`];
    for (const id of [...ids].reverse()) await insertAudit("thread_audits", id, old);
    expect(await store.deleteExpiredBatch("thread_audits", cutoff, 1)).toBe(1);
    expect(await remaining("thread_audits", ids)).toEqual(ids.slice(1));
    expect(await store.deleteExpiredBatch("thread_audits", cutoff, 1)).toBe(1);
    expect(await remaining("thread_audits", ids)).toEqual(ids.slice(2));
    expect(await store.deleteExpiredBatch("thread_audits", cutoff, 1)).toBe(1);
    expect(await store.deleteExpiredBatch("thread_audits", cutoff, 1)).toBe(0);
  });

  it("rejects invalid limits and cutoffs before issuing SQL", async () => {
    const cutoff = new Date("2000-01-01T00:00:00.000Z");
    for (const limit of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.deleteExpiredBatch("thread_audits", cutoff, limit)).rejects.toThrow(
        RangeError,
      );
    }
    await expect(store.deleteExpiredBatch("thread_audits", new Date(NaN), 1)).rejects.toThrow(
      RangeError,
    );
  });

  it("preserves current one-time and recurring schedule and managed-message state", async () => {
    const { cutoff, old } = await isolatedTimes();
    const oneTimeBefore = await database.client
      .select()
      .from(scheduledMessageStates)
      .where(eq(scheduledMessageStates.scheduledActionId, oneTimeId));
    const recurringBefore = await database.client
      .select()
      .from(recurringMessageSchedules)
      .where(eq(recurringMessageSchedules.scheduledActionId, recurringId));
    const occurrenceBefore = await database.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrenceId));
    const actionsBefore = await database.client
      .select()
      .from(scheduledActions)
      .where(inArray(scheduledActions.id, [oneTimeId, recurringId]));
    const managedBefore = await database.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, managedId));
    const first = newId();
    const second = newId();
    await insertAudit("scheduled_message_audits", first, old);
    await insertAudit("recurring_message_audits", second, old);
    expect(await store.deleteExpiredBatch("scheduled_message_audits", cutoff, 10)).toBe(1);
    expect(await store.deleteExpiredBatch("recurring_message_audits", cutoff, 10)).toBe(1);
    expect(await remaining("scheduled_message_audits", [first])).toEqual([]);
    expect(await remaining("recurring_message_audits", [second])).toEqual([]);
    expect(
      await database.client
        .select()
        .from(scheduledActions)
        .where(inArray(scheduledActions.id, [oneTimeId, recurringId])),
    ).toEqual(actionsBefore);
    expect(
      await database.client
        .select()
        .from(scheduledMessageStates)
        .where(eq(scheduledMessageStates.scheduledActionId, oneTimeId)),
    ).toEqual(oneTimeBefore);
    expect(
      await database.client
        .select()
        .from(recurringMessageSchedules)
        .where(eq(recurringMessageSchedules.scheduledActionId, recurringId)),
    ).toEqual(recurringBefore);
    expect(
      await database.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, occurrenceId)),
    ).toEqual(occurrenceBefore);
    expect(
      await database.client
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, managedId)),
    ).toEqual(managedBefore);
    expect(
      await createScheduledMessageStore(database.client).findForExecution(oneTimeId),
    ).toMatchObject({ outcome: "FOUND" });
    expect(await createRecurringMessageStore(database.client).find(recurringId)).toMatchObject({
      action: { id: recurringId, status: "ACTIVE" },
      occurrence: { id: occurrenceId, status: "PENDING" },
    });
  });

  it("expires an overdue recurring retry after retention removes its historical retry audit", async () => {
    const { cutoff } = await isolatedTimes();
    const firstAt = new Date(
      Math.floor((cutoff.getTime() - 2 * 24 * 60 * 60 * 1000) / 60_000) * 60_000,
    );
    const actionId = randomUUID();
    const initialOccurrenceId = randomUUID();
    recurringActionIds.push(actionId);
    await database.client.insert(scheduledActions).values({
      id: actionId,
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: firstAt,
    });
    await database.client.insert(scheduledMessageStates).values({
      scheduledActionId: actionId,
      creatorUserId: "actor",
      content: "retry payload",
    });
    await database.client.insert(recurringMessageSchedules).values({
      scheduledActionId: actionId,
      timezone: "UTC",
      frequency: "DAILY",
      weekdayMask: 127,
      localTime: firstAt.toISOString().slice(11, 16),
      definitionRevision: 0,
      effectiveAt: new Date(firstAt.getTime() - 24 * 60 * 60 * 1000),
    });
    await database.client.insert(recurringMessageOccurrences).values({
      id: initialOccurrenceId,
      scheduledActionId: actionId,
      materializedDefinitionRevision: 0,
      intendedLocalDate: firstAt.toISOString().slice(0, 10),
      intendedLocalTime: firstAt.toISOString().slice(11, 16),
      scheduledFor: firstAt,
      status: "PENDING",
    });

    const retryAuditId = newId();
    const terminalAuditId = newId();
    const nextOccurrenceId = randomUUID();
    const recurring = createRecurringMessageStore(database.client);
    const runtime = createRecurringRuntimeStore(database.client);
    expect(
      (
        await recurring.claimInitial({
          occurrenceId: initialOccurrenceId,
          expectedSeriesRevision: 0,
          claimedAt: firstAt,
        })
      ).outcome,
    ).toBe("COMMITTED");
    expect(
      await runtime.recordPreSendFailure({
        occurrenceId: initialOccurrenceId,
        auditId: retryAuditId,
        nextOccurrenceId: randomUUID(),
        occurredAt: firstAt,
      }),
    ).toMatchObject({ outcome: "RETRY_PENDING", retryCount: 1 });
    expect(await remaining("recurring_message_audits", [retryAuditId])).toEqual([retryAuditId]);
    expect(await store.deleteExpiredBatch("recurring_message_audits", cutoff, 500)).toBe(1);
    expect(await remaining("recurring_message_audits", [retryAuditId])).toEqual([]);
    expect(
      await runtime.expireRetry({
        occurrenceId: initialOccurrenceId,
        expectedRetryCount: 1,
        auditId: terminalAuditId,
        nextOccurrenceId,
        occurredAt: new Date(firstAt.getTime() + 15 * 60_000 + 1),
      }),
    ).toBe("COMMITTED");
    expect((await runtime.load(initialOccurrenceId))?.occurrence).toMatchObject({
      status: "FAILED",
      failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
    });
    expect((await runtime.load(nextOccurrenceId))?.occurrence.status).toBe("PENDING");
  });

  it("keeps an already-cancelled one-time schedule idempotent after its audit expires", async () => {
    const { cutoff, old, recent } = await isolatedTimes();
    const actionId = randomUUID();
    oneTimeActionIds.push(actionId);
    await database.client.insert(scheduledActions).values({
      id: actionId,
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: "channel",
      status: "ACTIVE",
      executeAt: new Date("2031-01-01T00:00:00.000Z"),
    });
    await database.client.insert(scheduledMessageStates).values({
      scheduledActionId: actionId,
      creatorUserId: "actor",
      content: "cancel payload",
    });

    const oneTime = createScheduledMessageStore(database.client);
    const cancelledAuditId = newId();
    const noopAuditId = newId();
    const cancellation = {
      scheduledActionId: actionId,
      guildId,
      channelId: "channel",
      actorId: "actor",
      auditId: cancelledAuditId,
      occurredAt: old,
    };
    expect((await oneTime.cancel(cancellation)).outcome).toBe("CANCELLED");
    expect(await store.deleteExpiredBatch("scheduled_message_audits", cutoff, 500)).toBe(1);
    expect(await remaining("scheduled_message_audits", [cancelledAuditId])).toEqual([]);
    const actionBefore = await database.client
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, actionId));
    const stateBefore = await database.client
      .select()
      .from(scheduledMessageStates)
      .where(eq(scheduledMessageStates.scheduledActionId, actionId));
    expect(
      (
        await oneTime.cancel({
          ...cancellation,
          auditId: noopAuditId,
          occurredAt: recent,
        })
      ).outcome,
    ).toBe("ALREADY_CANCELLED");
    expect(await remaining("scheduled_message_audits", [noopAuditId])).toEqual([]);
    expect(
      await database.client
        .select()
        .from(scheduledActions)
        .where(eq(scheduledActions.id, actionId)),
    ).toEqual(actionBefore);
    expect(
      await database.client
        .select()
        .from(scheduledMessageStates)
        .where(eq(scheduledMessageStates.scheduledActionId, actionId)),
    ).toEqual(stateBefore);
  });
});
