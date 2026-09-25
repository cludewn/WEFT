import { getTableName } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { AuditNotificationPublisher } from "../../src/audit-notification-dispatcher.js";
import type { AuditSource } from "../../src/audit-notification-format.js";
import {
  publishAuditDestinationChanges,
  publishExistingAudits,
  publishManagedMessageAudits,
  publishRecurringMessageAudits,
  publishScheduledMessageAudits,
  publishScheduledThreadCloseAudits,
} from "../../src/audit-notification-publication.js";
import type { AuditLogDestinationStore } from "../../src/audit-log-destination-persistence.js";
import type { DatabaseClient } from "../../src/database.js";
import type { ManagedMessageStore } from "../../src/managed-message-persistence.js";
import type { RecurringMessageStore } from "../../src/recurring-message-persistence.js";
import type { ScheduledMessageStore } from "../../src/scheduled-message-persistence.js";
import type { ScheduledThreadCloseStore } from "../../src/scheduled-thread-close-persistence.js";
import { createThreadAuditStore } from "../../src/thread-persistence.js";

function fixture(committed: Record<AuditSource, string[]>) {
  const publish = vi.fn<AuditNotificationPublisher["publish"]>();
  const publisher: AuditNotificationPublisher = { publish };
  let selectedSource: AuditSource | undefined;
  const database = {
    select: () => ({
      from(table: AnyPgTable) {
        const names: Record<string, AuditSource> = {
          thread_audits: "THREAD",
          scheduled_thread_close_audits: "SCHEDULED_THREAD_CLOSE",
          managed_message_audits: "MANAGED_MESSAGE",
          scheduled_message_audits: "SCHEDULED_MESSAGE",
          recurring_message_audits: "RECURRING_MESSAGE",
          audit_log_destination_audits: "AUDIT_LOG_DESTINATION",
        };
        selectedSource = names[getTableName(table)];
        return this;
      },
      where: () => Promise.resolve((committed[selectedSource!] ?? []).map((id) => ({ id }))),
    }),
  } as unknown as DatabaseClient;
  return { database, publisher, publish };
}

const empty: Record<AuditSource, string[]> = {
  THREAD: [],
  SCHEDULED_THREAD_CLOSE: [],
  MANAGED_MESSAGE: [],
  SCHEDULED_MESSAGE: [],
  RECURRING_MESSAGE: [],
  AUDIT_LOG_DESTINATION: [],
};
const id = "11111111-1111-4111-8111-111111111111";
const gap = "22222222-2222-4222-8222-222222222222";
const unused = "33333333-3333-4333-8333-333333333333";

// Fake persistence returns the existing result union while the exact-ID reader models the
// committed audit rows. This tests publication decisions without a live Discord connection.
describe("audit publication after confirmed persistence", () => {
  it("publishes only the actual zero, one, or many recurring audit rows", async () => {
    for (const rows of [[], [id], [id, gap]]) {
      const current = fixture({ ...empty, RECURRING_MESSAGE: rows });
      const store = {
        create: vi.fn(() => Promise.resolve({ outcome: "COMMITTED", series: {} })),
      } as unknown as RecurringMessageStore;
      const wrapped = publishRecurringMessageAudits(current.database, current.publisher, store);
      await wrapped.create({ auditId: id, gapAuditIds: [gap, unused] } as Parameters<
        RecurringMessageStore["create"]
      >[0]);
      expect(current.publish.mock.calls.map(([reference]) => reference)).toEqual(
        rows.map((auditId) => ({ source: "RECURRING_MESSAGE", auditId })),
      );
    }
  });

  it("does not publish unused recurring candidates on an unconfirmed result", async () => {
    const current = fixture({ ...empty, RECURRING_MESSAGE: [id, gap] });
    const store = {
      editRecurrence: vi.fn(() => Promise.resolve({ outcome: "PERSISTENCE_UNCONFIRMED" })),
    } as unknown as RecurringMessageStore;
    const wrapped = publishRecurringMessageAudits(current.database, current.publisher, store);
    await wrapped.editRecurrence({ auditId: id, gapAuditIds: [gap] } as Parameters<
      RecurringMessageStore["editRecurrence"]
    >[0]);
    expect(current.publish).not.toHaveBeenCalled();
  });

  it("publishes both covered sources after a scheduled finalization", async () => {
    const current = fixture({ ...empty, SCHEDULED_MESSAGE: [id], MANAGED_MESSAGE: [gap] });
    const store = {
      finalizeSuccess: vi.fn(() => Promise.resolve("COMMITTED")),
    } as unknown as ScheduledMessageStore;
    const wrapped = publishScheduledMessageAudits(current.database, current.publisher, store);
    await wrapped.finalizeSuccess({
      executionAuditId: id,
      managedMessageAuditId: gap,
    } as Parameters<ScheduledMessageStore["finalizeSuccess"]>[0]);
    expect(current.publish.mock.calls.map(([reference]) => reference)).toEqual([
      { source: "MANAGED_MESSAGE", auditId: gap },
      { source: "SCHEDULED_MESSAGE", auditId: id },
    ]);
  });

  it("does not infer the supplied cancellation audit from ALREADY_CANCELLED", async () => {
    const current = fixture(empty);
    const store = {
      cancel: vi.fn(() => Promise.resolve({ outcome: "ALREADY_CANCELLED", definition: {} })),
    } as unknown as ScheduledMessageStore;
    const wrapped = publishScheduledMessageAudits(current.database, current.publisher, store);
    await wrapped.cancel({ auditId: id } as Parameters<ScheduledMessageStore["cancel"]>[0]);
    expect(current.publish).not.toHaveBeenCalled();
  });

  it("publishes exact managed, scheduled close, and destination audit IDs only for confirmed outcomes", async () => {
    const current = fixture({
      ...empty,
      MANAGED_MESSAGE: [id],
      SCHEDULED_THREAD_CLOSE: [gap],
      AUDIT_LOG_DESTINATION: [unused],
    });
    const managed = publishManagedMessageAudits(current.database, current.publisher, {
      edit: vi.fn(() => Promise.resolve("TRANSITIONED")),
      confirmEdit: vi.fn(() => Promise.resolve("MATCH")),
    } as unknown as ManagedMessageStore);
    const close = publishScheduledThreadCloseAudits(current.database, current.publisher, {
      completeExecution: vi.fn(() => Promise.resolve({ outcome: "ALREADY_COMMITTED", action: {} })),
    } as unknown as ScheduledThreadCloseStore);
    const destination = publishAuditDestinationChanges(current.database, current.publisher, {
      change: vi.fn(() => Promise.resolve({ outcome: "CHANGED", previousChannelId: null })),
    } as unknown as AuditLogDestinationStore);
    await managed.edit({ auditId: id } as Parameters<ManagedMessageStore["edit"]>[0]);
    await managed.confirmEdit({ auditId: id } as Parameters<ManagedMessageStore["confirmEdit"]>[0]);
    await close.completeExecution({ auditId: gap } as Parameters<
      ScheduledThreadCloseStore["completeExecution"]
    >[0]);
    await destination.change({ auditId: unused } as Parameters<
      AuditLogDestinationStore["change"]
    >[0]);
    expect(current.publish.mock.calls.map(([reference]) => reference)).toEqual([
      { source: "MANAGED_MESSAGE", auditId: id },
      { source: "MANAGED_MESSAGE", auditId: id },
      { source: "SCHEDULED_THREAD_CLOSE", auditId: gap },
      { source: "AUDIT_LOG_DESTINATION", auditId: unused },
    ]);
  });

  it("publishes a thread audit after direct insert and exact same-ID confirmation", async () => {
    const publish = vi.fn<AuditNotificationPublisher["publish"]>();
    let inserted = true;
    const audit = {
      id,
      guildId: "100000000000000001",
      threadId: "100000000000000002",
      action: "CLOSE" as const,
      actorType: "SYSTEM" as const,
      outcome: "SUCCESS" as const,
    };
    const database = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({
            returning: () => Promise.resolve(inserted ? [{ id }] : []),
          }),
        }),
      }),
      select: () => ({
        from() {
          return this;
        },
        where() {
          return this;
        },
        limit: () => Promise.resolve([{ ...audit, actorId: null, failureCode: null }]),
      }),
    } as unknown as DatabaseClient;
    const store = createThreadAuditStore(database, { publish });
    await store.record(audit);
    inserted = false;
    await store.record(audit);
    expect(publish.mock.calls.map(([reference]) => reference)).toEqual([
      { source: "THREAD", auditId: id },
      { source: "THREAD", auditId: id },
    ]);
  });

  it("contains exact-read and publisher failures", async () => {
    const current = fixture({ ...empty, THREAD: [id] });
    current.publisher.publish = () => {
      throw new Error("private");
    };
    await expect(
      publishExistingAudits(current.database, current.publisher, "THREAD", [id]),
    ).resolves.toBeUndefined();
    const broken = {
      select: () => {
        throw new Error("private");
      },
    } as unknown as DatabaseClient;
    await expect(
      publishExistingAudits(broken, current.publisher, "THREAD", [id]),
    ).resolves.toBeUndefined();
  });
});
