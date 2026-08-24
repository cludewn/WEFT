import { createHash } from "node:crypto";

import { and, eq, inArray, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import { scheduledActions, type ScheduledAction } from "./scheduled-action-persistence.js";
import type { ThreadFailureCode } from "./thread-lifecycle.js";

export const SCHEDULED_THREAD_CLOSE_AUDIT_EVENTS = [
  "CREATED",
  "REPLACED",
  "CANCELLED",
  "EXECUTION_COMPLETED",
  "EXECUTION_RETRY",
  "EXECUTION_FAILED",
] as const;
export type ScheduledThreadCloseAuditEvent = (typeof SCHEDULED_THREAD_CLOSE_AUDIT_EVENTS)[number];

export const SCHEDULED_THREAD_CLOSE_AUDIT_ACTOR_TYPES = ["USER", "SYSTEM"] as const;
export type ScheduledThreadCloseAuditActorType =
  (typeof SCHEDULED_THREAD_CLOSE_AUDIT_ACTOR_TYPES)[number];

export const SCHEDULED_THREAD_CLOSE_AUDIT_OUTCOMES = ["SUCCESS", "FAILURE"] as const;
export type ScheduledThreadCloseAuditOutcome =
  (typeof SCHEDULED_THREAD_CLOSE_AUDIT_OUTCOMES)[number];

export const scheduledThreadCloseAudits = pgTable(
  "scheduled_thread_close_audits",
  {
    id: text("id").primaryKey(),
    scheduledActionId: text("scheduled_action_id").notNull(),
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    event: text("event").$type<ScheduledThreadCloseAuditEvent>().notNull(),
    actorType: text("actor_type").$type<ScheduledThreadCloseAuditActorType>().notNull(),
    actorId: text("actor_id"),
    previousScheduledActionId: text("previous_scheduled_action_id"),
    previousExecuteAt: timestamp("previous_execute_at", { withTimezone: true }),
    executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<ScheduledThreadCloseAuditOutcome>().notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "scheduled_thread_close_audits_event_check",
      sql`${table.event} in ('CREATED', 'REPLACED', 'CANCELLED', 'EXECUTION_COMPLETED', 'EXECUTION_RETRY', 'EXECUTION_FAILED')`,
    ),
    check(
      "scheduled_thread_close_audits_actor_type_check",
      sql`${table.actorType} in ('USER', 'SYSTEM')`,
    ),
    check(
      "scheduled_thread_close_audits_outcome_check",
      sql`${table.outcome} in ('SUCCESS', 'FAILURE')`,
    ),
    check(
      "scheduled_thread_close_audits_actor_check",
      sql`(${table.actorType} = 'USER' and ${table.actorId} is not null) or (${table.actorType} = 'SYSTEM' and ${table.actorId} is null)`,
    ),
    check(
      "scheduled_thread_close_audits_failure_check",
      sql`(${table.outcome} = 'SUCCESS' and ${table.failureCode} is null) or (${table.outcome} = 'FAILURE' and ${table.failureCode} is not null)`,
    ),
    check(
      "scheduled_thread_close_audits_replacement_check",
      sql`(${table.event} = 'REPLACED' and ${table.previousScheduledActionId} is not null and ${table.previousExecuteAt} is not null) or (${table.event} <> 'REPLACED' and ${table.previousScheduledActionId} is null and ${table.previousExecuteAt} is null)`,
    ),
    index("scheduled_thread_close_audits_action_id_idx").on(table.scheduledActionId),
    index("scheduled_thread_close_audits_guild_thread_created_at_idx").on(
      table.guildId,
      table.threadId,
      table.createdAt,
    ),
  ],
);

export type ScheduledThreadCloseAudit = typeof scheduledThreadCloseAudits.$inferSelect;

export type CreateOrReplaceScheduledThreadClose = {
  scheduledActionId: string;
  auditId: string;
  guildId: string;
  threadId: string;
  actorId: string;
  executeAt: Date;
};

export type CreateOrReplaceScheduledThreadCloseResult =
  | { outcome: "CREATED"; action: ScheduledAction }
  | { outcome: "REPLACED"; action: ScheduledAction; previousAction: ScheduledAction }
  | { outcome: "EXECUTION_IN_PROGRESS"; current: ScheduledAction };

export type CancelScheduledThreadClose = {
  auditId: string;
  guildId: string;
  threadId: string;
  actorId: string;
};

export type CancelScheduledThreadCloseResult =
  | { outcome: "CANCELLED"; action: ScheduledAction }
  | { outcome: "NOT_SCHEDULED" }
  | { outcome: "EXECUTION_IN_PROGRESS"; current: ScheduledAction };

/**
 * Failure codes that may be recorded on a scheduled-close execution audit.
 *
 * Claim and transition failures are intentionally excluded: they never complete an execution
 * transition, so they must never produce an execution audit.
 */
export type ScheduledThreadCloseExecutionAuditFailureCode =
  ThreadFailureCode | "THREAD_LIFECYCLE_UNEXPECTED_FAILURE" | "EXECUTION_INTERRUPTED";

export type CompleteScheduledThreadCloseExecution = {
  scheduledActionId: string;
  auditId: string;
};

export type FinalizeScheduledThreadCloseExecutionFailure = {
  scheduledActionId: string;
  auditId: string;
  failureCode: ScheduledThreadCloseExecutionAuditFailureCode;
};

export type ScheduledThreadCloseExecutionTransitionResult =
  | { outcome: "TRANSITIONED"; action: ScheduledAction }
  | { outcome: "ALREADY_COMMITTED"; action: ScheduledAction }
  | { outcome: "NOT_TRANSITIONED"; current: ScheduledAction | undefined };

export type ScheduledThreadCloseStore = {
  createOrReplace: (
    input: CreateOrReplaceScheduledThreadClose,
  ) => Promise<CreateOrReplaceScheduledThreadCloseResult>;
  cancel: (input: CancelScheduledThreadClose) => Promise<CancelScheduledThreadCloseResult>;
  completeExecution: (
    input: CompleteScheduledThreadCloseExecution,
  ) => Promise<ScheduledThreadCloseExecutionTransitionResult>;
  failExecution: (
    input: FinalizeScheduledThreadCloseExecutionFailure,
  ) => Promise<ScheduledThreadCloseExecutionTransitionResult>;
  releaseExecutionForRetry: (
    input: FinalizeScheduledThreadCloseExecutionFailure,
  ) => Promise<ScheduledThreadCloseExecutionTransitionResult>;
  findAuditById: (id: string) => Promise<ScheduledThreadCloseAudit | undefined>;
};

type ExecutionTransitionDescriptor = {
  scheduledActionId: string;
  auditId: string;
  nextStatus: "COMPLETED" | "FAILED" | "ACTIVE";
  event: "EXECUTION_COMPLETED" | "EXECUTION_FAILED" | "EXECUTION_RETRY";
  outcome: ScheduledThreadCloseAuditOutcome;
  failureCode: ScheduledThreadCloseExecutionAuditFailureCode | null;
};

function matchesExecutionAudit(
  audit: ScheduledThreadCloseAudit | undefined,
  action: ScheduledAction,
  transition: ExecutionTransitionDescriptor,
): boolean {
  return (
    audit !== undefined &&
    audit.id === transition.auditId &&
    audit.scheduledActionId === action.id &&
    audit.guildId === action.guildId &&
    audit.threadId === action.targetId &&
    audit.event === transition.event &&
    audit.actorType === "SYSTEM" &&
    audit.actorId === null &&
    audit.previousScheduledActionId === null &&
    audit.previousExecuteAt === null &&
    audit.outcome === transition.outcome &&
    audit.failureCode === transition.failureCode &&
    audit.executeAt.getTime() === action.executeAt.getTime()
  );
}

export type ScheduledThreadCloseAdvisoryLockKeys = readonly [number, number];

export function scheduledThreadCloseAdvisoryLockKeys(
  guildId: string,
  threadId: string,
): ScheduledThreadCloseAdvisoryLockKeys {
  const hash = createHash("sha256")
    .update("weft:scheduled-thread-close:v1\0")
    .update(`${guildId.length}:`)
    .update(guildId)
    .update(`${threadId.length}:`)
    .update(threadId)
    .digest();
  return [hash.readInt32BE(0), hash.readInt32BE(4)];
}

export function createScheduledThreadCloseStore(
  database: DatabaseClient,
): ScheduledThreadCloseStore {
  const findAuditById = async (id: string): Promise<ScheduledThreadCloseAudit | undefined> => {
    const [audit] = await database
      .select()
      .from(scheduledThreadCloseAudits)
      .where(eq(scheduledThreadCloseAudits.id, id))
      .limit(1);
    return audit;
  };

  const confirmCommittedExecutionTransition = async (
    transition: ExecutionTransitionDescriptor,
  ): Promise<ScheduledThreadCloseExecutionTransitionResult | undefined> => {
    const [action, audit] = await Promise.all([
      database
        .select()
        .from(scheduledActions)
        .where(eq(scheduledActions.id, transition.scheduledActionId))
        .limit(1)
        .then((rows) => rows[0]),
      findAuditById(transition.auditId),
    ]);
    if (action === undefined || action.status !== transition.nextStatus) {
      return undefined;
    }
    return matchesExecutionAudit(audit, action, transition)
      ? { outcome: "ALREADY_COMMITTED", action }
      : undefined;
  };

  const applyExecutionTransition = async (
    transition: ExecutionTransitionDescriptor,
  ): Promise<ScheduledThreadCloseExecutionTransitionResult> => {
    try {
      return await database.transaction(
        async (dbTransaction): Promise<ScheduledThreadCloseExecutionTransitionResult> => {
          const [transitioned] = await dbTransaction
            .update(scheduledActions)
            .set({ status: transition.nextStatus, updatedAt: new Date() })
            .where(
              and(
                eq(scheduledActions.id, transition.scheduledActionId),
                eq(scheduledActions.status, "EXECUTING"),
              ),
            )
            .returning();

          if (transitioned === undefined) {
            const [current] = await dbTransaction
              .select()
              .from(scheduledActions)
              .where(eq(scheduledActions.id, transition.scheduledActionId))
              .limit(1);
            if (current === undefined || current.status !== transition.nextStatus) {
              return { outcome: "NOT_TRANSITIONED", current };
            }

            const [audit] = await dbTransaction
              .select()
              .from(scheduledThreadCloseAudits)
              .where(eq(scheduledThreadCloseAudits.id, transition.auditId))
              .limit(1);
            return matchesExecutionAudit(audit, current, transition)
              ? { outcome: "ALREADY_COMMITTED", action: current }
              : { outcome: "NOT_TRANSITIONED", current };
          }

          await dbTransaction.insert(scheduledThreadCloseAudits).values({
            id: transition.auditId,
            scheduledActionId: transitioned.id,
            guildId: transitioned.guildId,
            threadId: transitioned.targetId,
            event: transition.event,
            actorType: "SYSTEM",
            executeAt: transitioned.executeAt,
            outcome: transition.outcome,
            ...(transition.failureCode === null ? {} : { failureCode: transition.failureCode }),
          });

          return { outcome: "TRANSITIONED", action: transitioned };
        },
      );
    } catch (error) {
      try {
        const confirmed = await confirmCommittedExecutionTransition(transition);
        if (confirmed !== undefined) {
          return confirmed;
        }
      } catch {
        // The original execution transition result remains unconfirmed.
      }
      throw error;
    }
  };

  const confirmCommittedOperation = async (
    input: CreateOrReplaceScheduledThreadClose,
  ): Promise<CreateOrReplaceScheduledThreadCloseResult | undefined> => {
    const [action, audit] = await Promise.all([
      database
        .select()
        .from(scheduledActions)
        .where(eq(scheduledActions.id, input.scheduledActionId))
        .limit(1)
        .then((rows) => rows[0]),
      findAuditById(input.auditId),
    ]);
    if (
      action === undefined ||
      audit === undefined ||
      action.guildId !== input.guildId ||
      action.actionType !== "CLOSE_THREAD" ||
      action.targetId !== input.threadId ||
      action.executeAt.getTime() !== input.executeAt.getTime() ||
      audit.scheduledActionId !== input.scheduledActionId ||
      audit.guildId !== input.guildId ||
      audit.threadId !== input.threadId ||
      audit.actorType !== "USER" ||
      audit.actorId !== input.actorId ||
      audit.executeAt.getTime() !== input.executeAt.getTime() ||
      audit.outcome !== "SUCCESS" ||
      audit.failureCode !== null
    ) {
      return undefined;
    }
    if (audit.event === "CREATED") {
      if (audit.previousScheduledActionId !== null || audit.previousExecuteAt !== null) {
        return undefined;
      }
      return { outcome: "CREATED", action };
    }
    if (
      audit.event !== "REPLACED" ||
      audit.previousScheduledActionId === null ||
      audit.previousExecuteAt === null
    ) {
      return undefined;
    }
    const [previousAction] = await database
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, audit.previousScheduledActionId))
      .limit(1);
    if (
      previousAction === undefined ||
      previousAction.guildId !== input.guildId ||
      previousAction.actionType !== "CLOSE_THREAD" ||
      previousAction.targetId !== input.threadId ||
      previousAction.status !== "CANCELLED" ||
      previousAction.executeAt.getTime() !== audit.previousExecuteAt.getTime()
    ) {
      return undefined;
    }
    return { outcome: "REPLACED", action, previousAction };
  };

  const confirmCommittedCancellation = async (
    input: CancelScheduledThreadClose,
  ): Promise<CancelScheduledThreadCloseResult | undefined> => {
    const audit = await findAuditById(input.auditId);
    if (
      audit === undefined ||
      audit.guildId !== input.guildId ||
      audit.threadId !== input.threadId ||
      audit.event !== "CANCELLED" ||
      audit.actorType !== "USER" ||
      audit.actorId !== input.actorId ||
      audit.outcome !== "SUCCESS" ||
      audit.failureCode !== null ||
      audit.previousScheduledActionId !== null ||
      audit.previousExecuteAt !== null
    ) {
      return undefined;
    }

    const [action] = await database
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, audit.scheduledActionId))
      .limit(1);
    if (
      action === undefined ||
      action.guildId !== input.guildId ||
      action.actionType !== "CLOSE_THREAD" ||
      action.targetId !== input.threadId ||
      action.status !== "CANCELLED" ||
      action.executeAt.getTime() !== audit.executeAt.getTime()
    ) {
      return undefined;
    }
    return { outcome: "CANCELLED", action };
  };

  return {
    findAuditById,
    completeExecution: (input) =>
      applyExecutionTransition({
        scheduledActionId: input.scheduledActionId,
        auditId: input.auditId,
        nextStatus: "COMPLETED",
        event: "EXECUTION_COMPLETED",
        outcome: "SUCCESS",
        failureCode: null,
      }),
    failExecution: (input) =>
      applyExecutionTransition({
        scheduledActionId: input.scheduledActionId,
        auditId: input.auditId,
        nextStatus: "FAILED",
        event: "EXECUTION_FAILED",
        outcome: "FAILURE",
        failureCode: input.failureCode,
      }),
    releaseExecutionForRetry: (input) =>
      applyExecutionTransition({
        scheduledActionId: input.scheduledActionId,
        auditId: input.auditId,
        nextStatus: "ACTIVE",
        event: "EXECUTION_RETRY",
        outcome: "FAILURE",
        failureCode: input.failureCode,
      }),
    async createOrReplace(input) {
      try {
        return await database.transaction(async (transaction) => {
          const [key1, key2] = scheduledThreadCloseAdvisoryLockKeys(input.guildId, input.threadId);
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${key1}::integer, ${key2}::integer)`,
          );

          const [current] = await transaction
            .select()
            .from(scheduledActions)
            .where(
              and(
                eq(scheduledActions.guildId, input.guildId),
                eq(scheduledActions.actionType, "CLOSE_THREAD"),
                eq(scheduledActions.targetId, input.threadId),
                inArray(scheduledActions.status, ["ACTIVE", "EXECUTING"]),
              ),
            )
            .limit(1)
            .for("update");

          if (current?.status === "EXECUTING") {
            return { outcome: "EXECUTION_IN_PROGRESS", current };
          }

          let previousAction: ScheduledAction | undefined;
          if (current?.status === "ACTIVE") {
            const [cancelled] = await transaction
              .update(scheduledActions)
              .set({ status: "CANCELLED", updatedAt: new Date() })
              .where(
                and(eq(scheduledActions.id, current.id), eq(scheduledActions.status, "ACTIVE")),
              )
              .returning();
            if (cancelled === undefined) {
              throw new Error("Scheduled thread close replacement lost its conditional update");
            }
            previousAction = cancelled;
          }

          const [action] = await transaction
            .insert(scheduledActions)
            .values({
              id: input.scheduledActionId,
              guildId: input.guildId,
              actionType: "CLOSE_THREAD",
              targetId: input.threadId,
              status: "ACTIVE",
              executeAt: input.executeAt,
            })
            .returning();
          if (action === undefined) {
            throw new Error("Scheduled thread close could not be created");
          }

          const event = previousAction === undefined ? "CREATED" : "REPLACED";
          await transaction.insert(scheduledThreadCloseAudits).values({
            id: input.auditId,
            scheduledActionId: action.id,
            guildId: action.guildId,
            threadId: action.targetId,
            event,
            actorType: "USER",
            actorId: input.actorId,
            ...(previousAction === undefined
              ? {}
              : {
                  previousScheduledActionId: previousAction.id,
                  previousExecuteAt: previousAction.executeAt,
                }),
            executeAt: action.executeAt,
            outcome: "SUCCESS",
          });

          return previousAction === undefined
            ? { outcome: "CREATED", action }
            : { outcome: "REPLACED", action, previousAction };
        });
      } catch (error) {
        try {
          const confirmed = await confirmCommittedOperation(input);
          if (confirmed !== undefined) {
            return confirmed;
          }
        } catch {
          // The original transaction result remains unconfirmed.
        }
        throw error;
      }
    },
    async cancel(input) {
      try {
        return await database.transaction(async (transaction) => {
          const [key1, key2] = scheduledThreadCloseAdvisoryLockKeys(input.guildId, input.threadId);
          await transaction.execute(
            sql`select pg_advisory_xact_lock(${key1}::integer, ${key2}::integer)`,
          );

          const [current] = await transaction
            .select()
            .from(scheduledActions)
            .where(
              and(
                eq(scheduledActions.guildId, input.guildId),
                eq(scheduledActions.actionType, "CLOSE_THREAD"),
                eq(scheduledActions.targetId, input.threadId),
                inArray(scheduledActions.status, ["ACTIVE", "EXECUTING"]),
              ),
            )
            .limit(1)
            .for("update");

          if (current === undefined) {
            return { outcome: "NOT_SCHEDULED" };
          }
          if (current.status === "EXECUTING") {
            return { outcome: "EXECUTION_IN_PROGRESS", current };
          }

          const [cancelled] = await transaction
            .update(scheduledActions)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(and(eq(scheduledActions.id, current.id), eq(scheduledActions.status, "ACTIVE")))
            .returning();
          if (cancelled === undefined) {
            throw new Error("Scheduled thread close cancellation lost its conditional update");
          }

          await transaction.insert(scheduledThreadCloseAudits).values({
            id: input.auditId,
            scheduledActionId: cancelled.id,
            guildId: cancelled.guildId,
            threadId: cancelled.targetId,
            event: "CANCELLED",
            actorType: "USER",
            actorId: input.actorId,
            executeAt: cancelled.executeAt,
            outcome: "SUCCESS",
          });

          return { outcome: "CANCELLED", action: cancelled };
        });
      } catch (error) {
        try {
          const confirmed = await confirmCommittedCancellation(input);
          if (confirmed !== undefined) {
            return confirmed;
          }
        } catch {
          // The original cancellation result remains unconfirmed.
        }
        throw error;
      }
    },
  };
}
