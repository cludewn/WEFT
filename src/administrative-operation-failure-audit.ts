import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Logger } from "pino";

import type { DatabaseClient } from "./database.js";
import type { AdministrativeAttempt } from "./administrative-transaction.js";
import type { AuditNotificationPublisher } from "./audit-notification-dispatcher.js";
import { publishCommittedAudit } from "./audit-notification-publication.js";

export type GuildAdministrativeOperation =
  | "GUILD_TIMEZONE_SET"
  | "GUILD_CLOSED_PREFIX_SET"
  | "AUTO_CLOSE_INACTIVITY_SET"
  | "AUTO_CLOSE_BOT_MESSAGES_SET"
  | "AUDIT_DESTINATION_DISABLE"
  | "LINK_PREVIEW_MODE_SET";
export type ThreadAdministrativeOperation =
  | "THREAD_TRACK"
  | "THREAD_UNTRACK"
  | "THREAD_CLOSE_AFTER_SET"
  | "THREAD_CANCEL_CLOSE"
  | "MANUAL_CLOSE_PREPARATION"
  | "BULK_CLOSE_PREPARATION";
export type ScheduleAdministrativeOperation =
  | "ONE_TIME_MESSAGE_CANCEL"
  | "ONE_TIME_MESSAGE_EDIT"
  | "ONE_TIME_MESSAGE_RESCHEDULE"
  | "RECURRING_MESSAGE_CANCEL"
  | "RECURRING_MESSAGE_PAYLOAD_EDIT"
  | "RECURRING_MESSAGE_RECURRENCE_EDIT";
export type CreationAdministrativeOperation =
  "ONE_TIME_MESSAGE_CREATE" | "RECURRING_MESSAGE_CREATE";
export type AdministrativeOperation =
  | GuildAdministrativeOperation
  | ThreadAdministrativeOperation
  | ScheduleAdministrativeOperation
  | CreationAdministrativeOperation
  | "AUTO_CLOSE_PARENT_ADD"
  | "AUTO_CLOSE_PARENT_REMOVE"
  | "AUDIT_DESTINATION_SET";

export type AdministrativeDatabaseFailure =
  | { failureStage: "DATABASE_START"; failureReasonCode: "TRANSACTION_START_FAILED" }
  | { failureStage: "DATABASE_TRANSACTION"; failureReasonCode: "TRANSACTION_ROLLED_BACK" }
  | { failureStage: "DATABASE_COMMIT"; failureReasonCode: "COMMIT_REJECTED" };
export type AdministrativeReadFailure = {
  failureStage: "DATABASE_READ";
  failureReasonCode: "REQUIRED_STATE_READ_FAILED";
};
export type AdministrativeDiscordFailure =
  | {
      failureStage: "DISCORD_PREFLIGHT";
      failureReasonCode: "BOT_PERMISSION_MISSING" | "BOT_CONTEXT_UNAVAILABLE";
    }
  | {
      failureStage: "DISCORD_READ";
      failureReasonCode: "REQUIRED_RESOURCE_READ_FAILED" | "REQUIRED_RESOURCE_UNAVAILABLE";
    };
type EnumerationFailure = {
  failureStage: "DISCORD_ENUMERATION";
  failureReasonCode: "ACTIVE_THREAD_ENUMERATION_FAILED";
};

type Target<Operation, Kind, Id = string> = {
  operationCode: Operation;
  targetType: Kind;
  targetId: Id;
};
export type AdministrativeFailureDescriptor =
  | (Target<GuildAdministrativeOperation, "GUILD"> & AdministrativeDatabaseFailure)
  | (Target<"AUTO_CLOSE_PARENT_REMOVE", "PARENT_CHANNEL"> & AdministrativeDatabaseFailure)
  | (Target<"AUTO_CLOSE_PARENT_ADD", "PARENT_CHANNEL"> &
      (AdministrativeDatabaseFailure | AdministrativeReadFailure | EnumerationFailure))
  | (Target<Exclude<ThreadAdministrativeOperation, "THREAD_CLOSE_AFTER_SET">, "THREAD"> &
      AdministrativeDatabaseFailure)
  | (Target<"THREAD_CLOSE_AFTER_SET", "THREAD"> &
      (AdministrativeDatabaseFailure | AdministrativeDiscordFailure))
  | (Target<
      Exclude<
        ScheduleAdministrativeOperation,
        "RECURRING_MESSAGE_CANCEL" | "RECURRING_MESSAGE_PAYLOAD_EDIT"
      >,
      "SCHEDULE"
    > &
      AdministrativeDatabaseFailure)
  | (Target<"RECURRING_MESSAGE_CANCEL" | "RECURRING_MESSAGE_PAYLOAD_EDIT", "SCHEDULE"> &
      (AdministrativeDatabaseFailure | AdministrativeReadFailure))
  | (Target<"ONE_TIME_MESSAGE_CREATE", "CHANNEL"> &
      (AdministrativeDatabaseFailure | AdministrativeReadFailure | AdministrativeDiscordFailure))
  | (Target<"RECURRING_MESSAGE_CREATE", "CHANNEL"> &
      (AdministrativeDatabaseFailure | AdministrativeDiscordFailure))
  | (Target<"AUDIT_DESTINATION_SET", "CHANNEL"> &
      (AdministrativeDatabaseFailure | AdministrativeDiscordFailure))
  | (Target<"AUDIT_DESTINATION_SET", "CHANNEL", null> &
      Extract<AdministrativeDiscordFailure, { failureStage: "DISCORD_READ" }>);

export const administrativeOperationFailureAudits = pgTable(
  "administrative_operation_failure_audits",
  {
    id: uuid("id").primaryKey(),
    operationId: uuid("operation_id").notNull().unique(),
    guildId: text("guild_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    operationCode: text("operation_code").$type<AdministrativeOperation>().notNull(),
    failureStage: text("failure_stage")
      .$type<AdministrativeFailureDescriptor["failureStage"]>()
      .notNull(),
    failureReasonCode: text("failure_reason_code")
      .$type<AdministrativeFailureDescriptor["failureReasonCode"]>()
      .notNull(),
    targetType: text("target_type")
      .$type<AdministrativeFailureDescriptor["targetType"]>()
      .notNull(),
    targetId: text("target_id"),
    outcome: text("outcome").$type<"FAILURE">().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "administrative_failure_identity_check",
      sql`${t.guildId} <> '' and ${t.actorUserId} <> '' and (${t.targetId} is null or ${t.targetId} <> '')`,
    ),
    check("administrative_failure_outcome_check", sql`${t.outcome} = 'FAILURE'`),
    check(
      "administrative_failure_target_check",
      sql`(
    (${t.operationCode} in ('GUILD_TIMEZONE_SET','GUILD_CLOSED_PREFIX_SET','AUTO_CLOSE_INACTIVITY_SET','AUTO_CLOSE_BOT_MESSAGES_SET','AUDIT_DESTINATION_DISABLE','LINK_PREVIEW_MODE_SET') and ${t.targetType} = 'GUILD' and ${t.targetId} = ${t.guildId})
    or (${t.operationCode} in ('AUTO_CLOSE_PARENT_ADD','AUTO_CLOSE_PARENT_REMOVE') and ${t.targetType} = 'PARENT_CHANNEL' and ${t.targetId} is not null)
    or (${t.operationCode} in ('THREAD_TRACK','THREAD_UNTRACK','THREAD_CLOSE_AFTER_SET','THREAD_CANCEL_CLOSE','MANUAL_CLOSE_PREPARATION','BULK_CLOSE_PREPARATION') and ${t.targetType} = 'THREAD' and ${t.targetId} is not null)
    or (${t.operationCode} in ('ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CREATE') and ${t.targetType} = 'CHANNEL' and ${t.targetId} is not null)
    or (${t.operationCode} = 'AUDIT_DESTINATION_SET' and ${t.targetType} = 'CHANNEL' and (${t.targetId} is not null or ${t.failureStage} = 'DISCORD_READ'))
    or (${t.operationCode} in ('ONE_TIME_MESSAGE_CANCEL','ONE_TIME_MESSAGE_EDIT','ONE_TIME_MESSAGE_RESCHEDULE','RECURRING_MESSAGE_CANCEL','RECURRING_MESSAGE_PAYLOAD_EDIT','RECURRING_MESSAGE_RECURRENCE_EDIT') and ${t.targetType} = 'SCHEDULE' and ${t.targetId} is not null and ${t.targetId} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) is true`,
    ),
    check(
      "administrative_failure_stage_check",
      sql`(
    (${t.failureStage} = 'DATABASE_START' and ${t.failureReasonCode} = 'TRANSACTION_START_FAILED')
    or (${t.failureStage} = 'DATABASE_TRANSACTION' and ${t.failureReasonCode} = 'TRANSACTION_ROLLED_BACK')
    or (${t.failureStage} = 'DATABASE_COMMIT' and ${t.failureReasonCode} = 'COMMIT_REJECTED')
    or (${t.operationCode} in ('AUTO_CLOSE_PARENT_ADD','ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CANCEL','RECURRING_MESSAGE_PAYLOAD_EDIT') and ${t.failureStage} = 'DATABASE_READ' and ${t.failureReasonCode} = 'REQUIRED_STATE_READ_FAILED')
    or (${t.operationCode} = 'AUTO_CLOSE_PARENT_ADD' and ${t.failureStage} = 'DISCORD_ENUMERATION' and ${t.failureReasonCode} = 'ACTIVE_THREAD_ENUMERATION_FAILED')
    or (${t.operationCode} in ('AUDIT_DESTINATION_SET','THREAD_CLOSE_AFTER_SET','ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CREATE') and (
      (${t.failureStage} = 'DISCORD_PREFLIGHT' and ${t.failureReasonCode} in ('BOT_PERMISSION_MISSING','BOT_CONTEXT_UNAVAILABLE'))
      or (${t.failureStage} = 'DISCORD_READ' and ${t.failureReasonCode} in ('REQUIRED_RESOURCE_READ_FAILED','REQUIRED_RESOURCE_UNAVAILABLE'))
    ))
  ) is true`,
    ),
    index("administrative_failure_retention_idx").on(t.occurredAt, t.id),
  ],
);
export type AdministrativeFailureAudit = typeof administrativeOperationFailureAudits.$inferSelect;
export type AdministrativeFailureRecorder = {
  record: (
    attempt: AdministrativeAttempt,
    guildId: string,
    actorUserId: string,
    failure: AdministrativeFailureDescriptor,
  ) => Promise<void>;
};

export function confirmedAdministrativeDatabaseFailure(
  attempt: AdministrativeAttempt,
): AdministrativeDatabaseFailure | undefined {
  if (attempt.normalGuard) return undefined;
  switch (attempt.transactionEvidence?.disposition) {
    case "START_FAILED":
      return { failureStage: "DATABASE_START", failureReasonCode: "TRANSACTION_START_FAILED" };
    case "ROLLED_BACK":
      return { failureStage: "DATABASE_TRANSACTION", failureReasonCode: "TRANSACTION_ROLLED_BACK" };
    case "COMMIT_REJECTED":
      return { failureStage: "DATABASE_COMMIT", failureReasonCode: "COMMIT_REJECTED" };
    default:
      return undefined;
  }
}

export function exactAdministrativeFailureAudit(
  actual: AdministrativeFailureAudit | undefined,
  expected: AdministrativeFailureAudit,
): boolean {
  return (
    actual !== undefined &&
    (Object.keys(expected) as (keyof AdministrativeFailureAudit)[]).every((key) =>
      key === "occurredAt"
        ? actual.occurredAt.getTime() === expected.occurredAt.getTime()
        : actual[key] === expected[key],
    )
  );
}

export function createAdministrativeFailureRecorder(
  database: DatabaseClient,
  logger: Pick<Logger, "warn">,
  publisher?: AuditNotificationPublisher,
  clock: { generateId?: () => string; now?: () => Date } = {},
): AdministrativeFailureRecorder {
  return {
    async record(attempt, guildId, actorUserId, failure) {
      const expected: AdministrativeFailureAudit = {
        ...failure,
        id: (clock.generateId ?? randomUUID)(),
        operationId: attempt.operationId,
        guildId,
        actorUserId,
        outcome: "FAILURE",
        occurredAt: (clock.now ?? (() => new Date()))(),
      };
      let confirmed = false;
      try {
        const [actual] = await database
          .insert(administrativeOperationFailureAudits)
          .values(expected)
          .returning();
        confirmed = exactAdministrativeFailureAudit(actual, expected);
      } catch {
        try {
          const [actual] = await database
            .select()
            .from(administrativeOperationFailureAudits)
            .where(eq(administrativeOperationFailureAudits.id, expected.id))
            .limit(1);
          confirmed = exactAdministrativeFailureAudit(actual, expected);
        } catch {
          /* Do not publish missing, mismatched or unreadable evidence. */
        }
      }
      if (confirmed)
        publishCommittedAudit(publisher, {
          source: "ADMINISTRATIVE_OPERATION_FAILURE",
          auditId: expected.id,
        });
      else {
        try {
          logger.warn(
            { event: "administrative_failure_audit_unconfirmed" },
            "Administrative failure audit could not be confirmed",
          );
        } catch {
          /* Logging cannot replace the business result. */
        }
      }
    },
  };
}
