import { managedMessageExecutionFailureAudits } from "../messages/managed-message-execution-audit.js";
import { administrativeOperationFailureAudits } from "./administrative-operation-failure-audit.js";
import { guildConfigurationAudits } from "../guild/guild-configuration-audit.js";
import { sql } from "drizzle-orm";

import { linkPreviewAudits } from "../link-previews/link-preview-persistence.js";
import { auditLogDestinationAudits } from "./audit-log-destination-persistence.js";
import type { DatabaseClient } from "../database.js";
import { managedMessageAudits } from "../messages/managed-message-persistence.js";
import { recurringMessageAudits } from "../messages/recurring-message-persistence.js";
import { scheduledMessageAudits } from "../messages/scheduled-message-persistence.js";
import { scheduledThreadCloseAudits } from "../threads/scheduled-thread-close-persistence.js";
import { threadAudits } from "../threads/thread-persistence.js";

export const AUDIT_RETENTION_SOURCES = [
  "thread_audits",
  "scheduled_thread_close_audits",
  "managed_message_audits",
  "scheduled_message_audits",
  "recurring_message_audits",
  "audit_log_destination_audits",
  "link_preview_audits",
  "guild_configuration_audits",
  "administrative_operation_failure_audits",
  "managed_message_execution_failure_audits",
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
          case "managed_message_execution_failure_audits":
            return {
              table: managedMessageExecutionFailureAudits,
              timestamp: managedMessageExecutionFailureAudits.occurredAt,
              id: managedMessageExecutionFailureAudits.id,
            };
          case "administrative_operation_failure_audits":
            return {
              table: administrativeOperationFailureAudits,
              timestamp: administrativeOperationFailureAudits.occurredAt,
              id: administrativeOperationFailureAudits.id,
            };
          case "guild_configuration_audits":
            return {
              table: guildConfigurationAudits,
              timestamp: guildConfigurationAudits.occurredAt,
              id: guildConfigurationAudits.id,
            };
          case "link_preview_audits":
            return {
              table: linkPreviewAudits,
              timestamp: linkPreviewAudits.occurredAt,
              id: linkPreviewAudits.id,
            };
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
