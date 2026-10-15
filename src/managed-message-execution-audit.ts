import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { Logger } from "pino";

import type { DatabaseClient } from "./database.js";
import type { AuditNotificationPublisher } from "./audit-notification-dispatcher.js";
import { publishCommittedAudit } from "./audit-notification-publication.js";
import {
  classifyManagedMessageExecution,
  MANAGED_EXECUTION_OPERATIONS,
  MANAGED_EXECUTION_STAGES,
  MANAGED_EXECUTION_REASONS,
  MANAGED_DISCORD_EVIDENCE,
  MANAGED_PAYLOAD_EVIDENCE,
  MANAGED_TRANSACTION_EVIDENCE,
  MANAGED_DATABASE_EFFECTS,
  MANAGED_COMPENSATION_TYPES,
  MANAGED_COMPENSATION_EVIDENCE,
  type ManagedMessageExecutionAttempt,
} from "./managed-message-execution-evidence.js";
import {
  exactManagedMessageHistoricalSuccess,
  managedMessageAudits,
  type ManagedMessageSuccessCandidate,
} from "./managed-message-persistence.js";

// Only fixed application constants reach this SQL fragment, never user input.
const choices = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(","));

export const managedMessageExecutionFailureAudits = pgTable(
  "managed_message_execution_failure_audits",
  {
    id: uuid("id").primaryKey(),
    operationId: uuid("operation_id").notNull().unique(),
    successAuditId: text("success_audit_id").notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    messageId: text("message_id"),
    operationCode: text("operation_code")
      .$type<ManagedMessageExecutionAttempt["operationCode"]>()
      .notNull(),
    stage: text("stage").$type<(typeof MANAGED_EXECUTION_STAGES)[number]>().notNull(),
    reasonCode: text("reason_code").$type<(typeof MANAGED_EXECUTION_REASONS)[number]>().notNull(),
    outcome: text("outcome").$type<"FAILURE" | "PARTIAL">().notNull(),
    discordEvidence: text("discord_evidence")
      .$type<(typeof MANAGED_DISCORD_EVIDENCE)[number]>()
      .notNull(),
    payloadEvidence: text("payload_evidence")
      .$type<(typeof MANAGED_PAYLOAD_EVIDENCE)[number]>()
      .notNull(),
    transactionEvidence: text("transaction_evidence")
      .$type<(typeof MANAGED_TRANSACTION_EVIDENCE)[number]>()
      .notNull(),
    databaseEffect: text("database_effect")
      .$type<(typeof MANAGED_DATABASE_EFFECTS)[number]>()
      .notNull(),
    compensationType: text("compensation_type")
      .$type<(typeof MANAGED_COMPENSATION_TYPES)[number]>()
      .notNull(),
    compensationEvidence: text("compensation_evidence")
      .$type<(typeof MANAGED_COMPENSATION_EVIDENCE)[number]>()
      .notNull(),
    discordEffectAt: timestamp("discord_effect_at", { withTimezone: true }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "managed_execution_codes_check",
      sql`${t.operationCode} in (${choices(MANAGED_EXECUTION_OPERATIONS)})
    and ${t.stage} in (${choices(MANAGED_EXECUTION_STAGES)})
    and ${t.reasonCode} in (${choices(MANAGED_EXECUTION_REASONS)})
    and ${t.outcome} in ('FAILURE','PARTIAL')
    and ${t.discordEvidence} in (${choices(MANAGED_DISCORD_EVIDENCE)})
    and ${t.payloadEvidence} in (${choices(MANAGED_PAYLOAD_EVIDENCE)})
    and ${t.transactionEvidence} in (${choices(MANAGED_TRANSACTION_EVIDENCE)})
    and ${t.databaseEffect} in (${choices(MANAGED_DATABASE_EFFECTS)})
    and ${t.compensationType} in (${choices(MANAGED_COMPENSATION_TYPES)})
    and ${t.compensationEvidence} in (${choices(MANAGED_COMPENSATION_EVIDENCE)})`,
    ),
    check(
      "managed_execution_identity_check",
      sql`(${t.guildId} <> '' and ${t.channelId} <> ''
    and ${t.actorUserId} <> '' and ${t.successAuditId} <> ''
    and (${t.messageId} is null or ${t.messageId} <> '')
    and (${t.operationCode} <> 'MANAGED_MESSAGE_EDIT' or ${t.messageId} is not null)) is true`,
    ),
    check(
      "managed_execution_database_check",
      sql`(
    (${t.databaseEffect} = 'NOT_ATTEMPTED' and ${t.transactionEvidence} = 'NOT_ATTEMPTED')
    or (${t.databaseEffect} = 'NOT_APPLIED' and ${t.transactionEvidence} in ('START_FAILED','ROLLED_BACK','COMMIT_REJECTED'))
    or (${t.databaseEffect} = 'NOT_TRANSITIONED' and ${t.operationCode} = 'MANAGED_MESSAGE_EDIT'
      and ${t.transactionEvidence} in ('COMMITTED','COMMIT_REJECTED','UNCONFIRMED'))
  ) is true`,
    ),
    check(
      "managed_execution_effect_check",
      sql`(
    (${t.discordEvidence} in ('NOT_ATTEMPTED','REJECTED','NOT_APPLIED_BY_READBACK','DELETION_OBSERVED')
      and ${t.compensationType} = 'NONE' and ${t.compensationEvidence} = 'NOT_REQUIRED'
      and ${t.discordEffectAt} is null and ${t.outcome} = 'FAILURE'
      and (${t.discordEvidence} = 'DELETION_OBSERVED' or ${t.databaseEffect} = 'NOT_ATTEMPTED'))
    or (${t.discordEvidence} in ('SEND_CONFIRMED','EDIT_CONFIRMED')
      and ${t.messageId} is not null and ${t.discordEffectAt} is not null
      and ((${t.discordEvidence} = 'SEND_CONFIRMED' and ${t.operationCode} = 'MANAGED_MESSAGE_SEND'
        and ${t.compensationType} = 'DELETE')
        or (${t.discordEvidence} = 'EDIT_CONFIRMED' and ${t.operationCode} = 'MANAGED_MESSAGE_EDIT'
          and ${t.compensationType} = 'RESTORE' and ${t.payloadEvidence} = 'MATCH'))
      and ((${t.outcome} = 'FAILURE' and (${t.compensationEvidence} = 'CONFIRMED'
          or (${t.compensationType} = 'DELETE' and ${t.compensationEvidence} = 'ALREADY_ABSENT')))
        or (${t.outcome} = 'PARTIAL' and (${t.compensationEvidence} in ('NOT_ATTEMPTED','REJECTED')
          or (${t.compensationType} = 'RESTORE' and ${t.compensationEvidence} in
            ('SKIPPED_DATABASE_GUARD','SKIPPED_DISCORD_GUARD','SKIPPED_READ_FAILURE'))))))
  ) is true`,
    ),
    check(
      "managed_execution_stage_check",
      sql`(
    (${t.stage} in ('DISCORD_PREFLIGHT','DISCORD_READ') and ${t.discordEvidence} = 'NOT_ATTEMPTED'
      and ${t.reasonCode} in ('BOT_PERMISSION_MISSING','REQUIRED_RESOURCE_READ_FAILED'))
    or (${t.stage} = 'DISCORD_MUTATION' and ${t.databaseEffect} = 'NOT_ATTEMPTED' and (
      (${t.reasonCode} = 'MUTATION_REJECTED' and ${t.discordEvidence} = 'REJECTED')
      or (${t.reasonCode} = 'EDIT_NOT_APPLIED' and ${t.discordEvidence} = 'NOT_APPLIED_BY_READBACK'
        and ${t.operationCode} = 'MANAGED_MESSAGE_EDIT')))
    or (${t.stage} = 'DISCORD_RESPONSE' and ${t.discordEvidence} = 'SEND_CONFIRMED'
      and ${t.databaseEffect} = 'NOT_ATTEMPTED' and (
        (${t.reasonCode} in ('RETURNED_PAYLOAD_PROJECTION_FAILED','RETURNED_RESPONSE_READ_FAILED')
          and ${t.payloadEvidence} = 'PROJECTION_UNAVAILABLE')
        or (${t.reasonCode} = 'RETURNED_PAYLOAD_MISMATCH' and ${t.payloadEvidence} = 'MISMATCH')))
    or (${t.stage} in ('DATABASE_START','DATABASE_TRANSACTION','DATABASE_COMMIT')
      and ${t.discordEvidence} in ('SEND_CONFIRMED','EDIT_CONFIRMED') and ${t.payloadEvidence} = 'MATCH'
      and ${t.databaseEffect} = 'NOT_APPLIED' and (
        (${t.stage} = 'DATABASE_START' and ${t.reasonCode} = 'TRANSACTION_START_FAILED' and ${t.transactionEvidence} = 'START_FAILED')
        or (${t.stage} = 'DATABASE_TRANSACTION' and ${t.reasonCode} = 'TRANSACTION_ROLLED_BACK' and ${t.transactionEvidence} = 'ROLLED_BACK')
        or (${t.stage} = 'DATABASE_COMMIT' and ${t.reasonCode} = 'COMMIT_REJECTED' and ${t.transactionEvidence} = 'COMMIT_REJECTED')))
    or (${t.stage} = 'DATABASE_GUARD' and ${t.reasonCode} = 'FINALIZATION_NOT_TRANSITIONED'
      and ${t.discordEvidence} = 'EDIT_CONFIRMED' and ${t.databaseEffect} = 'NOT_TRANSITIONED')
    or (${t.stage} = 'DELETION_FINALIZATION' and ${t.operationCode} = 'MANAGED_MESSAGE_EDIT'
      and ${t.discordEvidence} = 'DELETION_OBSERVED' and ${t.databaseEffect} = 'NOT_APPLIED' and (
        (${t.reasonCode} = 'TRANSACTION_START_FAILED' and ${t.transactionEvidence} = 'START_FAILED')
        or (${t.reasonCode} = 'TRANSACTION_ROLLED_BACK' and ${t.transactionEvidence} = 'ROLLED_BACK')
        or (${t.reasonCode} = 'COMMIT_REJECTED' and ${t.transactionEvidence} = 'COMMIT_REJECTED')))
  ) is true`,
    ),
    index("managed_execution_failure_retention_idx").on(t.occurredAt, t.id),
  ],
);

export type ManagedMessageExecutionAudit = typeof managedMessageExecutionFailureAudits.$inferSelect;
export type ManagedMessageExecutionRecorder = {
  record: (
    attempt: ManagedMessageExecutionAttempt,
    identity: {
      guildId: string;
      channelId: string;
      actorUserId: string;
    },
    success?: ManagedMessageSuccessCandidate,
  ) => Promise<void>;
};

export function exactManagedMessageExecutionAudit(
  actual: ManagedMessageExecutionAudit | undefined,
  expected: ManagedMessageExecutionAudit,
): boolean {
  return (
    actual !== undefined &&
    (Object.keys(expected) as (keyof ManagedMessageExecutionAudit)[]).every((key) => {
      const value = expected[key];
      return value instanceof Date
        ? actual[key] instanceof Date && (actual[key] as Date).getTime() === value.getTime()
        : actual[key] === value;
    })
  );
}

export function createManagedMessageExecutionRecorder(
  database: DatabaseClient,
  logger: Pick<Logger, "warn">,
  publisher?: AuditNotificationPublisher,
  clock: { generateId?: () => string; now?: () => Date } = {},
): ManagedMessageExecutionRecorder {
  const recorded = new WeakMap<ManagedMessageExecutionAttempt, Promise<void>>();
  const warn = () => {
    try {
      logger.warn(
        { event: "managed_message_execution_audit_unconfirmed" },
        "Managed message execution audit could not be confirmed",
      );
    } catch {
      /* Diagnostics cannot change business results. */
    }
  };
  const record: ManagedMessageExecutionRecorder["record"] = async (attempt, identity, success) => {
    try {
      if (classifyManagedMessageExecution(attempt) === undefined) return;
      const successAuditId = success?.input.auditId ?? attempt.operationId;
      // Business and compensation have settled. Missing history is never noncommit evidence.
      const existing = await database
        .select()
        .from(managedMessageAudits)
        .where(
          inArray(managedMessageAudits.id, [...new Set([successAuditId, attempt.operationId])]),
        );
      if (existing.length > 0) {
        attempt.historicalSuccess =
          existing.length === 1 &&
          success !== undefined &&
          exactManagedMessageHistoricalSuccess(existing[0]!, success)
            ? "MATCH"
            : "MISMATCH";
        if (attempt.historicalSuccess === "MISMATCH") warn();
        return;
      }
      attempt.historicalSuccess = "MISSING";
      const evidence = classifyManagedMessageExecution(attempt);
      if (evidence === undefined) return;
      const expected: ManagedMessageExecutionAudit = {
        guildId: identity.guildId,
        channelId: identity.channelId,
        actorUserId: identity.actorUserId,
        ...evidence,
        id: (clock.generateId ?? randomUUID)(),
        operationId: attempt.operationId,
        successAuditId,
        operationCode: attempt.operationCode,
        messageId: attempt.messageId,
        discordEffectAt: attempt.discordEffectAt,
        occurredAt: (clock.now ?? (() => new Date()))(),
      };
      let confirmed = false;
      try {
        // Defense in depth, not a substitute for settlement/noncompletion and single ownership.
        const [actual] = await database
          .insert(managedMessageExecutionFailureAudits)
          .select(
            sql`select ${expected.id}::uuid, ${expected.operationId}::uuid, ${expected.successAuditId},
            ${expected.guildId}, ${expected.channelId}, ${expected.actorUserId}, ${expected.messageId},
            ${expected.operationCode}, ${expected.stage}, ${expected.reasonCode}, ${expected.outcome},
            ${expected.discordEvidence}, ${expected.payloadEvidence}, ${expected.transactionEvidence},
            ${expected.databaseEffect}, ${expected.compensationType}, ${expected.compensationEvidence},
            ${expected.discordEffectAt?.toISOString() ?? null}::timestamptz, ${expected.occurredAt.toISOString()}::timestamptz
            where not exists (select 1 from ${managedMessageAudits}
              where ${managedMessageAudits.id} in (${successAuditId}, ${attempt.operationId}))`,
          )
          .returning();
        confirmed = exactManagedMessageExecutionAudit(actual, expected);
      } catch {
        /* Only a same-ID exact read can confirm a lost INSERT response. */
      }
      if (!confirmed) {
        const [actual] = await database
          .select()
          .from(managedMessageExecutionFailureAudits)
          .where(eq(managedMessageExecutionFailureAudits.id, expected.id))
          .limit(1);
        confirmed = exactManagedMessageExecutionAudit(actual, expected);
      }
      if (confirmed)
        publishCommittedAudit(publisher, {
          source: "MANAGED_MESSAGE_EXECUTION_FAILURE",
          auditId: expected.id,
        });
      else warn();
    } catch {
      warn();
    }
  };
  return {
    record(attempt, identity, success) {
      let pending = recorded.get(attempt);
      if (pending === undefined) {
        pending = Promise.resolve().then(() => record(attempt, identity, success));
        recorded.set(attempt, pending);
      }
      return pending;
    },
  };
}
