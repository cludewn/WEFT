import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  createAuditLogDestinationStore,
  auditLogDestinationAudits,
} from "../../src/audit-log-destination-persistence.js";
import type { AuditNotificationPublisher } from "../../src/audit-notification-dispatcher.js";
import { createAuditNotificationProjection } from "../../src/audit-notification-projection.js";
import { publishExistingAudits } from "../../src/audit-notification-publication.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { guildSettings } from "../../src/guild-settings.js";
import {
  createManagedMessageStore,
  managedMessageAudits,
  managedMessages,
} from "../../src/managed-message-persistence.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "../../src/recurring-message-persistence.js";
import { ALL_WEEKDAYS_MASK } from "../../src/recurring-message.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/scheduled-message-persistence.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
} from "../../src/scheduled-thread-close-persistence.js";
import { createThreadAuditStore, threadAudits } from "../../src/thread-persistence.js";

const database = createDatabase(loadTestDatabaseConfig());
const projection = createAuditNotificationProjection(database.client);
const guildId = randomUUID();
const channelId = "100000000000000001";
const actorId = "100000000000000002";
const content = "PRIVATE_MESSAGE_PAYLOAD_SHOULD_NOT_APPEAR";
const ids = {
  thread: randomUUID(),
  close: randomUUID(),
  managed: randomUUID(),
  scheduled: randomUUID(),
  recurring: randomUUID(),
  gap: randomUUID(),
  destination: randomUUID(),
  closeAction: randomUUID(),
  scheduledAction: randomUUID(),
  recurringAction: randomUUID(),
  recurringOccurrence: randomUUID(),
  managedMessage: randomUUID(),
};

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  try {
    await database.client
      .delete(auditLogDestinationAudits)
      .where(eq(auditLogDestinationAudits.id, ids.destination));
    await database.client
      .delete(recurringMessageAudits)
      .where(eq(recurringMessageAudits.scheduledActionId, ids.recurringAction));
    await database.client
      .delete(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, ids.scheduledAction));
    await database.client
      .delete(scheduledThreadCloseAudits)
      .where(eq(scheduledThreadCloseAudits.id, ids.close));
    await database.client
      .delete(managedMessageAudits)
      .where(eq(managedMessageAudits.id, ids.managed));
    await database.client.delete(threadAudits).where(eq(threadAudits.id, ids.thread));
    await database.client
      .delete(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.scheduledActionId, ids.recurringAction));
    await database.client
      .delete(recurringMessageSchedules)
      .where(eq(recurringMessageSchedules.scheduledActionId, ids.recurringAction));
    await database.client
      .delete(scheduledMessageStates)
      .where(
        inArray(scheduledMessageStates.scheduledActionId, [
          ids.scheduledAction,
          ids.recurringAction,
        ]),
      );
    await database.client
      .delete(managedMessages)
      .where(eq(managedMessages.messageId, ids.managedMessage));
    for (const actionId of [ids.closeAction, ids.scheduledAction, ids.recurringAction]) {
      await database.client.delete(scheduledActions).where(eq(scheduledActions.id, actionId));
    }
    await database.client.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
  } finally {
    await database.close();
  }
});

describe("audit notification PostgreSQL projection", () => {
  it("projects each of the six committed source tables by exact ID without message payload", async () => {
    const at = new Date("2030-01-01T00:00:00.000Z");
    await createThreadAuditStore(database.client).record({
      id: ids.thread,
      guildId,
      threadId: channelId,
      action: "CLOSE",
      actorType: "USER",
      actorId,
      outcome: "SUCCESS",
    });
    await createScheduledThreadCloseStore(database.client).createOrReplace({
      scheduledActionId: ids.closeAction,
      auditId: ids.close,
      guildId,
      threadId: channelId,
      actorId,
      executeAt: new Date("2030-01-02T00:00:00.000Z"),
    });
    await createManagedMessageStore(database.client).create({
      auditId: ids.managed,
      messageId: ids.managedMessage,
      guildId,
      channelId,
      creatorUserId: actorId,
      payload: { content, embed: { title: content } },
      createdAt: at,
    });
    await createScheduledMessageStore(database.client).create({
      scheduledActionId: ids.scheduledAction,
      auditId: ids.scheduled,
      guildId,
      channelId,
      actorId,
      executeAt: new Date("2030-01-03T00:00:00.000Z"),
      payload: { content, embed: null },
      occurredAt: at,
    });
    await createRecurringMessageStore(database.client).create({
      scheduledActionId: ids.recurringAction,
      occurrenceId: ids.recurringOccurrence,
      auditId: ids.recurring,
      gapAuditIds: [],
      guildId,
      channelId,
      actorId,
      payload: { content, embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00",
        timezone: "UTC",
      },
      effectiveAt: at,
    });
    await createAuditLogDestinationStore(database.client).change({
      guildId,
      actorUserId: actorId,
      newChannelId: channelId,
      auditId: ids.destination,
      occurredAt: at,
    });

    const expected = [
      ["THREAD", ids.thread, "CLOSE"],
      ["SCHEDULED_THREAD_CLOSE", ids.close, "CREATED"],
      ["MANAGED_MESSAGE", ids.managed, "CREATED"],
      ["SCHEDULED_MESSAGE", ids.scheduled, "CREATED"],
      ["RECURRING_MESSAGE", ids.recurring, "SERIES_CREATED"],
      ["AUDIT_LOG_DESTINATION", ids.destination, "ENABLE"],
    ] as const;
    for (const [source, auditId, event] of expected) {
      const result = await projection.load({ source, auditId });
      expect(result).toMatchObject({ source, auditId, guildId, event, outcome: "SUCCESS" });
      expect(JSON.stringify(result)).not.toContain(content);
      expect(result).not.toHaveProperty("content");
      expect(result).not.toHaveProperty("beforeContent");
      expect(result).not.toHaveProperty("afterContent");
    }
    await expect(
      projection.load({ source: "THREAD", auditId: ids.managed }),
    ).resolves.toBeUndefined();
    await expect(
      projection.load({ source: "RECURRING_MESSAGE", auditId: randomUUID() }),
    ).resolves.toBeUndefined();
  });

  it("publishes exactly the committed recurring subset, including a skip audit", async () => {
    await database.client.insert(recurringMessageAudits).values({
      id: ids.gap,
      scheduledActionId: ids.recurringAction,
      guildId,
      channelId,
      event: "DST_GAP_SKIPPED",
      actorType: "SYSTEM",
      intendedLocalDate: "2030-03-10",
      intendedLocalTime: "02:30",
      afterTimezone: "UTC",
      afterDefinitionRevision: 0,
      auditSkipReason: "DST_GAP",
      occurredAt: new Date("2030-01-01T00:00:00.000Z"),
      outcome: "SKIPPED",
    });
    const gapRecord = await projection.load({ source: "RECURRING_MESSAGE", auditId: ids.gap });
    expect(gapRecord).toMatchObject({
      event: "DST_GAP_SKIPPED",
      outcome: "SKIPPED",
      skipReason: "DST_GAP",
    });
    const publish = vi.fn<AuditNotificationPublisher["publish"]>();
    const publisher: AuditNotificationPublisher = { publish };
    await publishExistingAudits(database.client, publisher, "RECURRING_MESSAGE", [randomUUID()]);
    expect(publish).not.toHaveBeenCalled();
    await publishExistingAudits(database.client, publisher, "RECURRING_MESSAGE", [
      ids.recurring,
      randomUUID(),
      ids.gap,
    ]);
    expect(publish.mock.calls.map(([reference]) => reference)).toEqual(
      expect.arrayContaining([
        { source: "RECURRING_MESSAGE", auditId: ids.recurring },
        { source: "RECURRING_MESSAGE", auditId: ids.gap },
      ]),
    );
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
