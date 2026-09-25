import { eq } from "drizzle-orm";

import { auditLogDestinationAudits } from "./audit-log-destination-persistence.js";
import type { AuditNotificationRecord, AuditReference } from "./audit-notification-format.js";
import type { DatabaseClient } from "./database.js";
import { managedMessageAudits } from "./managed-message-persistence.js";
import {
  RECURRING_OCCURRENCE_FAILURE_CODES,
  recurringMessageAudits,
} from "./recurring-message-persistence.js";
import {
  SCHEDULED_MESSAGE_FAILURE_CODES,
  scheduledMessageAudits,
} from "./scheduled-message-persistence.js";
import {
  SCHEDULED_THREAD_CLOSE_AUDIT_FAILURE_CODES,
  scheduledThreadCloseAudits,
} from "./scheduled-thread-close-persistence.js";
import { THREAD_FAILURE_CODES } from "./thread-lifecycle.js";
import { threadAudits } from "./thread-persistence.js";

export class InvalidAuditNotificationMetadataError extends Error {
  readonly classification = "INVALID_FAILURE_CODE";

  constructor() {
    super("Invalid audit notification failure code");
  }
}

function assertKnownFailureCode(code: string | null, known: readonly string[]): void {
  if (code !== null && !known.includes(code)) {
    throw new InvalidAuditNotificationMetadataError();
  }
}

export function createAuditNotificationProjection(database: DatabaseClient) {
  return {
    async load(reference: AuditReference): Promise<AuditNotificationRecord | undefined> {
      switch (reference.source) {
        case "THREAD": {
          const [row] = await database
            .select({
              guildId: threadAudits.guildId,
              threadId: threadAudits.threadId,
              event: threadAudits.action,
              outcome: threadAudits.outcome,
              actorType: threadAudits.actorType,
              actorId: threadAudits.actorId,
              failureCode: threadAudits.failureCode,
              occurredAt: threadAudits.createdAt,
            })
            .from(threadAudits)
            .where(eq(threadAudits.id, reference.auditId))
            .limit(1);
          if (row !== undefined) assertKnownFailureCode(row.failureCode, THREAD_FAILURE_CODES);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              threadId: row.threadId,
              event: row.event,
              outcome: row.outcome,
              actorType: row.actorType,
              ...(row.actorId === null ? {} : { actorUserId: row.actorId }),
              ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
              occurredAt: row.occurredAt,
            }
          );
        }
        case "SCHEDULED_THREAD_CLOSE": {
          const [row] = await database
            .select({
              guildId: scheduledThreadCloseAudits.guildId,
              threadId: scheduledThreadCloseAudits.threadId,
              scheduledActionId: scheduledThreadCloseAudits.scheduledActionId,
              event: scheduledThreadCloseAudits.event,
              outcome: scheduledThreadCloseAudits.outcome,
              actorType: scheduledThreadCloseAudits.actorType,
              actorId: scheduledThreadCloseAudits.actorId,
              failureCode: scheduledThreadCloseAudits.failureCode,
              occurredAt: scheduledThreadCloseAudits.createdAt,
            })
            .from(scheduledThreadCloseAudits)
            .where(eq(scheduledThreadCloseAudits.id, reference.auditId))
            .limit(1);
          if (row !== undefined)
            assertKnownFailureCode(row.failureCode, SCHEDULED_THREAD_CLOSE_AUDIT_FAILURE_CODES);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              threadId: row.threadId,
              scheduledActionId: row.scheduledActionId,
              event: row.event,
              outcome: row.outcome,
              actorType: row.actorType,
              ...(row.actorId === null ? {} : { actorUserId: row.actorId }),
              ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
              occurredAt: row.occurredAt,
            }
          );
        }
        case "MANAGED_MESSAGE": {
          const [row] = await database
            .select({
              guildId: managedMessageAudits.guildId,
              channelId: managedMessageAudits.channelId,
              messageId: managedMessageAudits.messageId,
              event: managedMessageAudits.event,
              outcome: managedMessageAudits.outcome,
              actorType: managedMessageAudits.actorType,
              actorId: managedMessageAudits.actorId,
              occurredAt: managedMessageAudits.occurredAt,
            })
            .from(managedMessageAudits)
            .where(eq(managedMessageAudits.id, reference.auditId))
            .limit(1);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              channelId: row.channelId,
              messageId: row.messageId,
              event: row.event,
              outcome: row.outcome,
              actorType: row.actorType,
              ...(row.actorId === null ? {} : { actorUserId: row.actorId }),
              occurredAt: row.occurredAt,
            }
          );
        }
        case "SCHEDULED_MESSAGE": {
          const [row] = await database
            .select({
              guildId: scheduledMessageAudits.guildId,
              channelId: scheduledMessageAudits.channelId,
              scheduledActionId: scheduledMessageAudits.scheduledActionId,
              messageId: scheduledMessageAudits.resultMessageId,
              event: scheduledMessageAudits.event,
              outcome: scheduledMessageAudits.outcome,
              actorType: scheduledMessageAudits.actorType,
              actorId: scheduledMessageAudits.actorId,
              failureCode: scheduledMessageAudits.failureCode,
              occurredAt: scheduledMessageAudits.occurredAt,
            })
            .from(scheduledMessageAudits)
            .where(eq(scheduledMessageAudits.id, reference.auditId))
            .limit(1);
          if (row !== undefined)
            assertKnownFailureCode(row.failureCode, SCHEDULED_MESSAGE_FAILURE_CODES);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              channelId: row.channelId,
              scheduledActionId: row.scheduledActionId,
              ...(row.messageId === null ? {} : { messageId: row.messageId }),
              event: row.event,
              outcome: row.outcome,
              actorType: row.actorType,
              ...(row.actorId === null ? {} : { actorUserId: row.actorId }),
              ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
              occurredAt: row.occurredAt,
            }
          );
        }
        case "RECURRING_MESSAGE": {
          const [row] = await database
            .select({
              guildId: recurringMessageAudits.guildId,
              channelId: recurringMessageAudits.channelId,
              scheduledActionId: recurringMessageAudits.scheduledActionId,
              occurrenceId: recurringMessageAudits.occurrenceId,
              messageId: recurringMessageAudits.resultMessageId,
              event: recurringMessageAudits.event,
              outcome: recurringMessageAudits.outcome,
              actorType: recurringMessageAudits.actorType,
              actorId: recurringMessageAudits.actorId,
              failureCode: recurringMessageAudits.failureCode,
              auditSkipReason: recurringMessageAudits.auditSkipReason,
              occurrenceSkipReason: recurringMessageAudits.occurrenceSkipReason,
              occurredAt: recurringMessageAudits.occurredAt,
            })
            .from(recurringMessageAudits)
            .where(eq(recurringMessageAudits.id, reference.auditId))
            .limit(1);
          if (row !== undefined)
            assertKnownFailureCode(row.failureCode, RECURRING_OCCURRENCE_FAILURE_CODES);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              channelId: row.channelId,
              scheduledActionId: row.scheduledActionId,
              ...(row.occurrenceId === null ? {} : { occurrenceId: row.occurrenceId }),
              ...(row.messageId === null ? {} : { messageId: row.messageId }),
              event: row.event,
              outcome: row.outcome,
              actorType: row.actorType,
              ...(row.actorId === null ? {} : { actorUserId: row.actorId }),
              ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
              ...(row.auditSkipReason === null && row.occurrenceSkipReason === null
                ? {}
                : { skipReason: row.auditSkipReason ?? row.occurrenceSkipReason! }),
              occurredAt: row.occurredAt,
            }
          );
        }
        case "AUDIT_LOG_DESTINATION": {
          const [row] = await database
            .select({
              guildId: auditLogDestinationAudits.guildId,
              actorUserId: auditLogDestinationAudits.actorUserId,
              previousChannelId: auditLogDestinationAudits.previousChannelId,
              newChannelId: auditLogDestinationAudits.newChannelId,
              outcome: auditLogDestinationAudits.outcome,
              occurredAt: auditLogDestinationAudits.occurredAt,
            })
            .from(auditLogDestinationAudits)
            .where(eq(auditLogDestinationAudits.id, reference.auditId))
            .limit(1);
          return (
            row && {
              ...reference,
              guildId: row.guildId,
              actorType: "USER",
              actorUserId: row.actorUserId,
              event:
                row.previousChannelId === null
                  ? "ENABLE"
                  : row.newChannelId === null
                    ? "DISABLE"
                    : "CHANGE",
              outcome: row.outcome,
              ...(row.previousChannelId === null
                ? {}
                : { previousDestinationId: row.previousChannelId }),
              ...(row.newChannelId === null ? {} : { newDestinationId: row.newChannelId }),
              occurredAt: row.occurredAt,
            }
          );
        }
      }
    },
  };
}
