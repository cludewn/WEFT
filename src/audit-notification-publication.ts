import { inArray } from "drizzle-orm";

import {
  auditLogDestinationAudits,
  type AuditLogDestinationStore,
} from "./audit-log-destination-persistence.js";
import type { AuditNotificationPublisher } from "./audit-notification-dispatcher.js";
import type { AuditReference, AuditSource } from "./audit-notification-format.js";
import type { DatabaseClient } from "./database.js";
import { managedMessageAudits, type ManagedMessageStore } from "./managed-message-persistence.js";
import {
  recurringMessageAudits,
  type RecurringMessageStore,
} from "./recurring-message-persistence.js";
import {
  scheduledMessageAudits,
  type ScheduledMessageStore,
} from "./scheduled-message-persistence.js";
import {
  scheduledThreadCloseAudits,
  type ScheduledThreadCloseStore,
} from "./scheduled-thread-close-persistence.js";
import { threadAudits } from "./thread-persistence.js";

export function publishCommittedAudit(
  publisher: AuditNotificationPublisher | undefined,
  reference: AuditReference,
): void {
  try {
    publisher?.publish(reference);
  } catch {
    // Notification publication must never change an authoritative result.
  }
}

// Candidate IDs may be unused by a conditional transaction. The explicit PK query returns only
// rows that actually committed, and is run only after the transaction or exact confirmation.
export async function publishExistingAudits(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher | undefined,
  source: AuditSource,
  candidates: readonly string[],
): Promise<void> {
  if (publisher === undefined || candidates.length === 0) return;
  const ids = [...new Set(candidates)];
  try {
    let committed: { id: string }[];
    switch (source) {
      case "THREAD":
        committed = await database
          .select({ id: threadAudits.id })
          .from(threadAudits)
          .where(inArray(threadAudits.id, ids));
        break;
      case "SCHEDULED_THREAD_CLOSE":
        committed = await database
          .select({ id: scheduledThreadCloseAudits.id })
          .from(scheduledThreadCloseAudits)
          .where(inArray(scheduledThreadCloseAudits.id, ids));
        break;
      case "MANAGED_MESSAGE":
        committed = await database
          .select({ id: managedMessageAudits.id })
          .from(managedMessageAudits)
          .where(inArray(managedMessageAudits.id, ids));
        break;
      case "SCHEDULED_MESSAGE":
        committed = await database
          .select({ id: scheduledMessageAudits.id })
          .from(scheduledMessageAudits)
          .where(inArray(scheduledMessageAudits.id, ids));
        break;
      case "RECURRING_MESSAGE":
        committed = await database
          .select({ id: recurringMessageAudits.id })
          .from(recurringMessageAudits)
          .where(inArray(recurringMessageAudits.id, ids));
        break;
      case "AUDIT_LOG_DESTINATION":
        committed = await database
          .select({ id: auditLogDestinationAudits.id })
          .from(auditLogDestinationAudits)
          .where(inArray(auditLogDestinationAudits.id, ids));
        break;
    }
    for (const { id } of committed) publishCommittedAudit(publisher, { source, auditId: id });
  } catch {
    // Projection delivery is best effort. A failed confirmation read is not proof of commit.
  }
}

// These focused adapters publish only after their persistence methods have returned. A primary
// operation's outcome never depends on the extra exact-ID read or on notification delivery.
export function publishScheduledThreadCloseAudits(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher,
  store: ScheduledThreadCloseStore,
): ScheduledThreadCloseStore {
  const publish = (id: string) =>
    publishExistingAudits(database, publisher, "SCHEDULED_THREAD_CLOSE", [id]);
  return {
    ...store,
    async createOrReplace(input) {
      const result = await store.createOrReplace(input);
      if (result.outcome === "CREATED" || result.outcome === "REPLACED")
        await publish(input.auditId);
      return result;
    },
    async cancel(input) {
      const result = await store.cancel(input);
      if (result.outcome === "CANCELLED") await publish(input.auditId);
      return result;
    },
    async completeExecution(input) {
      const result = await store.completeExecution(input);
      if (result.outcome === "TRANSITIONED" || result.outcome === "ALREADY_COMMITTED")
        await publish(input.auditId);
      return result;
    },
    async failExecution(input) {
      const result = await store.failExecution(input);
      if (result.outcome === "TRANSITIONED" || result.outcome === "ALREADY_COMMITTED")
        await publish(input.auditId);
      return result;
    },
    async releaseExecutionForRetry(input) {
      const result = await store.releaseExecutionForRetry(input);
      if (result.outcome === "TRANSITIONED" || result.outcome === "ALREADY_COMMITTED")
        await publish(input.auditId);
      return result;
    },
  };
}

export function publishManagedMessageAudits(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher,
  store: ManagedMessageStore,
): ManagedMessageStore {
  const publish = (id: string) =>
    publishExistingAudits(database, publisher, "MANAGED_MESSAGE", [id]);
  return {
    ...store,
    async create(input) {
      const result = await store.create(input);
      await publish(input.auditId);
      return result;
    },
    async confirmCreation(input) {
      const result = await store.confirmCreation(input);
      if (result === "MATCH") await publish(input.auditId);
      return result;
    },
    async edit(input) {
      const result = await store.edit(input);
      if (result === "TRANSITIONED") await publish(input.auditId);
      return result;
    },
    async confirmEdit(input) {
      const result = await store.confirmEdit(input);
      if (result === "MATCH") await publish(input.auditId);
      return result;
    },
    async markDeleted(input) {
      const result = await store.markDeleted(input);
      if (result === "TRANSITIONED") await publish(input.auditId);
      return result;
    },
    async confirmDeletion(input) {
      const result = await store.confirmDeletion(input);
      if (result === "MATCH") await publish(input.auditId);
      return result;
    },
  };
}

export function publishScheduledMessageAudits(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher,
  store: ScheduledMessageStore,
): ScheduledMessageStore {
  const publish = (id: string) =>
    publishExistingAudits(database, publisher, "SCHEDULED_MESSAGE", [id]);
  return {
    ...store,
    async create(input) {
      const result = await store.create(input);
      await publish(input.auditId);
      return result;
    },
    async confirmCreation(input) {
      const result = await store.confirmCreation(input);
      if (result.outcome === "MATCH") await publish(input.auditId);
      return result;
    },
    async retryPreSendFailure(input) {
      const result = await store.retryPreSendFailure(input);
      if (result.outcome === "COMMITTED") await publish(input.auditId);
      return result;
    },
    async failExecution(input) {
      const result = await store.failExecution(input);
      if (result.outcome === "COMMITTED") await publish(input.auditId);
      return result;
    },
    async failMissingState(input) {
      const result = await store.failMissingState(input);
      if (result.outcome === "COMMITTED") await publish(input.auditId);
      return result;
    },
    async finalizeSuccess(input) {
      const result = await store.finalizeSuccess(input);
      if (result === "COMMITTED") {
        await publishExistingAudits(database, publisher, "MANAGED_MESSAGE", [
          input.managedMessageAuditId,
        ]);
        await publish(input.executionAuditId);
      }
      return result;
    },
    async edit(input) {
      const result = await store.edit(input);
      if (result.outcome === "EDITED") await publish(input.auditId);
      return result;
    },
    async reschedule(input) {
      const result = await store.reschedule(input);
      if (result.outcome === "RESCHEDULED") await publish(input.auditId);
      return result;
    },
    async cancel(input) {
      const result = await store.cancel(input);
      if (result.outcome === "CANCELLED" || result.outcome === "ALREADY_CANCELLED") {
        // ALREADY_CANCELLED may refer to an older audit with another ID. The exact query
        // ensures the supplied ID exists before publication.
        await publish(input.auditId);
      }
      return result;
    },
  };
}

export function publishRecurringMessageAudits(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher,
  store: RecurringMessageStore,
): RecurringMessageStore {
  const publish = (ids: readonly string[]) =>
    publishExistingAudits(database, publisher, "RECURRING_MESSAGE", ids);
  return {
    ...store,
    async create(input) {
      const result = await store.create(input);
      if (result.outcome === "COMMITTED") await publish([input.auditId, ...input.gapAuditIds]);
      return result;
    },
    async editPayload(input) {
      const result = await store.editPayload(input);
      if (result.outcome === "COMMITTED") await publish([input.auditId]);
      return result;
    },
    async editRecurrence(input) {
      const result = await store.editRecurrence(input);
      if (result.outcome === "COMMITTED") await publish([input.auditId, ...input.gapAuditIds]);
      return result;
    },
    async cancel(input) {
      const result = await store.cancel(input);
      if (result.outcome === "COMMITTED") await publish([input.auditId]);
      return result;
    },
  };
}

export function publishAuditDestinationChanges(
  database: DatabaseClient,
  publisher: AuditNotificationPublisher,
  store: AuditLogDestinationStore,
): AuditLogDestinationStore {
  return {
    ...store,
    async change(input) {
      const result = await store.change(input);
      if (result.outcome === "CHANGED") {
        await publishExistingAudits(database, publisher, "AUDIT_LOG_DESTINATION", [input.auditId]);
      }
      return result;
    },
  };
}
