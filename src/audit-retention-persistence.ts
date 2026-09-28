import { sql } from "drizzle-orm";

import { auditLogDestinationAudits } from "./audit-log-destination-persistence.js";
import type { DatabaseClient } from "./database.js";
import { managedMessageAudits } from "./managed-message-persistence.js";
import { recurringMessageAudits } from "./recurring-message-persistence.js";
import { scheduledMessageAudits } from "./scheduled-message-persistence.js";
import { scheduledThreadCloseAudits } from "./scheduled-thread-close-persistence.js";
import { threadAudits } from "./thread-persistence.js";

export const AUDIT_RETENTION_SOURCES = [
  "thread_audits",
  "scheduled_thread_close_audits",
  "managed_message_audits",
  "scheduled_message_audits",
  "recurring_message_audits",
  "audit_log_destination_audits",
] as const;

export type AuditRetentionSource = (typeof AUDIT_RETENTION_SOURCES)[number];

export type AuditRetentionStore = {
  deleteExpiredBatch: (
    source: AuditRetentionSource,
    cutoff: Date,
    limit: number,
  ) => Promise<number>;
};

export function createAuditRetentionStore(database: DatabaseClient): AuditRetentionStore {
  return {
    async deleteExpiredBatch(source, cutoff, limit) {
      if (!Number.isSafeInteger(limit) || limit <= 0) {
        throw new RangeError("Audit retention batch limit must be a positive safe integer");
      }
      if (!(cutoff instanceof Date) || !Number.isFinite(cutoff.getTime())) {
        throw new RangeError("Audit retention cutoff must be a valid Date");
      }

      const target = (() => {
        switch (source) {
          case "thread_audits":
            return { table: threadAudits, timestamp: threadAudits.createdAt, id: threadAudits.id };
          case "scheduled_thread_close_audits":
            return {
              table: scheduledThreadCloseAudits,
              timestamp: scheduledThreadCloseAudits.createdAt,
              id: scheduledThreadCloseAudits.id,
            };
          case "managed_message_audits":
            return {
              table: managedMessageAudits,
              timestamp: managedMessageAudits.occurredAt,
              id: managedMessageAudits.id,
            };
          case "scheduled_message_audits":
            return {
              table: scheduledMessageAudits,
              timestamp: scheduledMessageAudits.occurredAt,
              id: scheduledMessageAudits.id,
            };
          case "recurring_message_audits":
            return {
              table: recurringMessageAudits,
              timestamp: recurringMessageAudits.occurredAt,
              id: recurringMessageAudits.id,
            };
          case "audit_log_destination_audits":
            return {
              table: auditLogDestinationAudits,
              timestamp: auditLogDestinationAudits.occurredAt,
              id: auditLogDestinationAudits.id,
            };
        }
      })();

      const deleted = await database.execute<{ id: string }>(sql`
        with expired as (
          select ${target.id} as id
          from ${target.table}
          where ${target.timestamp} < ${cutoff}
          order by ${target.timestamp} asc, ${target.id} asc
          limit ${limit}
        )
        delete from ${target.table}
        where ${target.id} in (select id from expired)
        returning ${target.id} as id
      `);
      return deleted.rows.length;
    },
  };
}
