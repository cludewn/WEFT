import { createHash } from "node:crypto";

import { and, asc, desc, eq, gt, inArray, isNull } from "drizzle-orm";

import type { DatabaseClient } from "./database.js";
import type { AuditNotificationPublisher } from "./audit-notification-dispatcher.js";
import { publishExistingAudits } from "./audit-notification-publication.js";
import {
  insertManagedMessageCreation,
  managedMessageAudits,
  managedMessages,
  type DatabaseTransaction,
} from "./managed-message-persistence.js";
import type { ManagedMessagePayload } from "./managed-message-payload.js";
import {
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
  type RecurringMessageAudit,
  type RecurringMessageOccurrence,
  type RecurringMessageSchedule,
  type RecurringOccurrenceFailureCode,
} from "./recurring-message-persistence.js";
import {
  decideRecurringRetry,
  findNextOccurrence,
  RECURRING_RETRY_DELAY_MS,
  RECURRING_RETRY_LIFETIME_MS,
  selectMissedAndFutureOccurrences,
} from "./recurring-message.js";
import { scheduledActions, type ScheduledAction } from "./scheduled-action-persistence.js";
import {
  scheduledMessagePayloadFromColumns,
  scheduledMessageStates,
  type ScheduledMessageState,
} from "./scheduled-message-persistence.js";

export type RecurringRuntimeDefinition = {
  action: ScheduledAction;
  state: ScheduledMessageState;
  recurrence: RecurringMessageSchedule;
  occurrence: RecurringMessageOccurrence;
};

export type RecurringRuntimeTransition = "COMMITTED" | "NOT_COMMITTED" | "UNKNOWN";
export type RecurringRetryTransition =
  | { outcome: "RETRY_PENDING"; wakeAt: Date; retryCount: number }
  | { outcome: "FAILED"; failureCode: RecurringOccurrenceFailureCode }
  | { outcome: "NOT_TRANSITIONED" | "UNKNOWN" };

export type RecurringTerminalInput = {
  occurrenceId: string;
  auditId: string;
  nextOccurrenceId: string;
  occurredAt: Date;
  failureCode?: RecurringOccurrenceFailureCode;
  resultMessageId?: string;
  messageCreatedAt?: Date;
  managedMessageAuditId?: string;
};

export type RecurringRuntimeStore = {
  load: (occurrenceId: string) => Promise<RecurringRuntimeDefinition | undefined>;
  page: (
    status: RecurringMessageOccurrence["status"],
    afterId?: string,
  ) => Promise<RecurringRuntimeDefinition[]>;
  pageMissing: (afterId?: string) => Promise<string[]>;
  retryWake: (occurrenceId: string, retryCount: number) => Promise<Date | undefined>;
  resumeRetry: (
    occurrenceId: string,
    retryCount: number,
    at: Date,
  ) => Promise<RecurringMessageOccurrence | undefined>;
  recordPreSendFailure: (input: {
    occurrenceId: string;
    auditId: string;
    nextOccurrenceId: string;
    occurredAt: Date;
  }) => Promise<RecurringRetryTransition>;
  expireRetry: (input: {
    occurrenceId: string;
    expectedRetryCount: number;
    auditId: string;
    nextOccurrenceId: string;
    occurredAt: Date;
  }) => Promise<RecurringRuntimeTransition>;
  terminalize: (input: RecurringTerminalInput) => Promise<RecurringRuntimeTransition>;
  recoverMissed: (input: {
    occurrenceId: string;
    auditId: string;
    nextOccurrenceId: string;
    at: Date;
  }) => Promise<RecurringRuntimeTransition>;
  recoverMissing: (input: {
    scheduledActionId: string;
    auditId: string;
    nextOccurrenceId: string;
    at: Date;
  }) => Promise<RecurringRuntimeTransition>;
};

const activeStatuses = ["PENDING", "EXECUTING", "RETRY_PENDING"] as const;
const graceMs = 15 * 60_000;

function claimPayload(occurrence: RecurringMessageOccurrence): ManagedMessagePayload | undefined {
  if (occurrence.claimContent === null) return undefined;
  return scheduledMessagePayloadFromColumns({
    content: occurrence.claimContent,
    embedTitle: occurrence.claimEmbedTitle,
    embedDescription: occurrence.claimEmbedDescription,
    embedColor: occurrence.claimEmbedColor,
    embedImageUrl: occurrence.claimEmbedImageUrl,
  });
}

function occurrenceAuditFields(occurrence: RecurringMessageOccurrence) {
  if (occurrence.claimedSeriesRevision === null || occurrence.claimedDefinitionRevision === null) {
    throw new Error("Occurrence has no claim snapshot");
  }
  return {
    occurrenceId: occurrence.id,
    intendedLocalDate: occurrence.intendedLocalDate,
    intendedLocalTime: occurrence.intendedLocalTime,
    scheduledFor: occurrence.scheduledFor,
    claimedSeriesRevision: occurrence.claimedSeriesRevision,
    claimedDefinitionRevision: occurrence.claimedDefinitionRevision,
    retryCount: occurrence.retryCount,
  };
}

async function lockedDefinition(
  transaction: DatabaseTransaction,
  occurrenceId: string,
): Promise<RecurringRuntimeDefinition | undefined> {
  const [identity] = await transaction
    .select({ scheduledActionId: recurringMessageOccurrences.scheduledActionId })
    .from(recurringMessageOccurrences)
    .where(eq(recurringMessageOccurrences.id, occurrenceId))
    .limit(1);
  if (identity === undefined) return undefined;
  const [action] = await transaction
    .select()
    .from(scheduledActions)
    .where(eq(scheduledActions.id, identity.scheduledActionId))
    .limit(1)
    .for("update");
  if (action === undefined || action.actionType !== "SEND_MESSAGE") return undefined;
  const [occurrence] = await transaction
    .select()
    .from(recurringMessageOccurrences)
    .where(
      and(
        eq(recurringMessageOccurrences.id, occurrenceId),
        eq(recurringMessageOccurrences.scheduledActionId, action.id),
      ),
    )
    .limit(1)
    .for("update");
  const [state] = await transaction
    .select()
    .from(scheduledMessageStates)
    .where(eq(scheduledMessageStates.scheduledActionId, action.id))
    .limit(1);
  const [recurrence] = await transaction
    .select()
    .from(recurringMessageSchedules)
    .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
    .limit(1);
  if (occurrence === undefined || state === undefined || recurrence === undefined) return undefined;
  return { action, occurrence, state, recurrence };
}

function recurrenceDefinition(recurrence: RecurringMessageSchedule) {
  return {
    frequency: recurrence.frequency,
    weekdayMask: recurrence.weekdayMask,
    localTime: recurrence.localTime.slice(0, 5),
    timezone: recurrence.timezone,
  };
}

async function terminalInTransaction(
  transaction: DatabaseTransaction,
  definition: RecurringRuntimeDefinition,
  input: RecurringTerminalInput,
  gapAuditIds: string[],
): Promise<void> {
  const { action, occurrence, recurrence, state } = definition;
  if (occurrence.status !== "EXECUTING" && occurrence.status !== "RETRY_PENDING") {
    throw new Error("Occurrence is not terminalizable");
  }
  if (
    input.failureCode === undefined &&
    (occurrence.status !== "EXECUTING" ||
      input.resultMessageId === undefined ||
      input.messageCreatedAt === undefined ||
      input.managedMessageAuditId === undefined)
  ) {
    throw new Error("Completion requires a concrete message");
  }
  const completed = input.failureCode === undefined;
  const terminalStatus = completed ? "COMPLETED" : "FAILED";
  const [terminal] = await transaction
    .update(recurringMessageOccurrences)
    .set({
      status: terminalStatus,
      failureCode: input.failureCode ?? null,
      resultMessageId: input.resultMessageId ?? null,
      terminalAt: input.occurredAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(recurringMessageOccurrences.id, occurrence.id),
        eq(recurringMessageOccurrences.status, occurrence.status),
      ),
    )
    .returning();
  if (terminal === undefined) throw new Error("Occurrence terminalization lost ownership");

  let next: RecurringMessageOccurrence | undefined;
  if (action.status === "ACTIVE") {
    const after = new Date(
      Math.max(occurrence.scheduledFor.getTime(), recurrence.effectiveAt.getTime()),
    );
    const found = findNextOccurrence(
      recurrenceDefinition(recurrence),
      recurrence.definitionRevision,
      after,
    );
    [next] = await transaction
      .insert(recurringMessageOccurrences)
      .values({
        id: input.nextOccurrenceId,
        scheduledActionId: action.id,
        materializedDefinitionRevision: recurrence.definitionRevision,
        intendedLocalDate: found.occurrence.intendedLocalDate,
        intendedLocalTime: found.occurrence.intendedLocalTime,
        scheduledFor: found.occurrence.scheduledFor,
        status: "PENDING",
        retryCount: 0,
      })
      .returning();
    if (next === undefined) throw new Error("Next occurrence was not materialized");
    await transaction
      .update(scheduledActions)
      .set({ executeAt: next.scheduledFor, updatedAt: new Date() })
      .where(eq(scheduledActions.id, action.id));
    for (let index = 0; index < found.skippedGaps.length; index += 1) {
      const gap = found.skippedGaps[index]!;
      const gapAuditId = createHash("sha256")
        .update(
          `weft:recurring-gap:v1\0${input.auditId}\0${gap.intendedLocalDate}\0${gap.intendedLocalTime}`,
        )
        .digest("hex");
      await transaction.insert(recurringMessageAudits).values({
        id: gapAuditId,
        scheduledActionId: action.id,
        guildId: action.guildId,
        channelId: action.targetId,
        event: "DST_GAP_SKIPPED",
        actorType: "SYSTEM",
        intendedLocalDate: gap.intendedLocalDate,
        intendedLocalTime: gap.intendedLocalTime,
        afterTimezone: recurrence.timezone,
        afterDefinitionRevision: recurrence.definitionRevision,
        auditSkipReason: "DST_GAP",
        occurredAt: input.occurredAt,
        outcome: "SKIPPED",
      });
      gapAuditIds.push(gapAuditId);
    }
  } else if (action.status !== "CANCELLED") {
    throw new Error("Recurring series has invalid terminal status");
  }
  if (completed) {
    const payload = claimPayload(occurrence);
    if (payload === undefined) throw new Error("Claimed payload missing");
    await insertManagedMessageCreation(transaction, {
      auditId: input.managedMessageAuditId!,
      messageId: input.resultMessageId!,
      guildId: action.guildId,
      channelId: action.targetId,
      creatorUserId: state.creatorUserId,
      payload,
      createdAt: input.messageCreatedAt!,
    });
  }
  await transaction.insert(recurringMessageAudits).values({
    id: input.auditId,
    scheduledActionId: action.id,
    guildId: action.guildId,
    channelId: action.targetId,
    event: completed ? "OCCURRENCE_COMPLETED" : "OCCURRENCE_FAILED",
    actorType: "SYSTEM",
    outcome: completed ? "SUCCESS" : "FAILURE",
    ...occurrenceAuditFields(occurrence),
    resultMessageId: input.resultMessageId ?? null,
    failureCode: input.failureCode ?? null,
    nextOccurrenceId: next?.id ?? null,
    nextIntendedLocalDate: next?.intendedLocalDate ?? null,
    nextIntendedLocalTime: next?.intendedLocalTime ?? null,
    nextScheduledFor: next?.scheduledFor ?? null,
    postSeriesStatus: action.status,
    occurredAt: input.occurredAt,
  });
}

function terminalAuditMatches(
  audit: RecurringMessageAudit,
  input: RecurringTerminalInput,
  occurrence: RecurringMessageOccurrence,
): boolean {
  return (
    audit.id === input.auditId &&
    audit.occurrenceId === input.occurrenceId &&
    audit.event ===
      (input.failureCode === undefined ? "OCCURRENCE_COMPLETED" : "OCCURRENCE_FAILED") &&
    audit.failureCode === (input.failureCode ?? null) &&
    audit.resultMessageId === (input.resultMessageId ?? null) &&
    audit.scheduledActionId === occurrence.scheduledActionId &&
    audit.intendedLocalDate === occurrence.intendedLocalDate &&
    audit.intendedLocalTime === occurrence.intendedLocalTime &&
    audit.claimedSeriesRevision === occurrence.claimedSeriesRevision &&
    audit.claimedDefinitionRevision === occurrence.claimedDefinitionRevision &&
    audit.retryCount === occurrence.retryCount &&
    audit.occurredAt.getTime() === input.occurredAt.getTime() &&
    audit.scheduledFor?.getTime() === occurrence.scheduledFor.getTime() &&
    (audit.postSeriesStatus === "CANCELLED"
      ? audit.nextOccurrenceId === null && audit.nextScheduledFor === null
      : audit.nextOccurrenceId === input.nextOccurrenceId)
  );
}

export function createRecurringRuntimeStore(
  database: DatabaseClient,
  publisher?: AuditNotificationPublisher,
): RecurringRuntimeStore {
  const publish = async (auditIds: string[], managedAuditId?: string) => {
    await publishExistingAudits(database, publisher, "RECURRING_MESSAGE", auditIds);
    if (managedAuditId !== undefined) {
      await publishExistingAudits(database, publisher, "MANAGED_MESSAGE", [managedAuditId]);
    }
  };
  const load = async (occurrenceId: string): Promise<RecurringRuntimeDefinition | undefined> => {
    const [row] = await database
      .select({
        action: scheduledActions,
        state: scheduledMessageStates,
        recurrence: recurringMessageSchedules,
        occurrence: recurringMessageOccurrences,
      })
      .from(recurringMessageOccurrences)
      .innerJoin(
        recurringMessageSchedules,
        eq(
          recurringMessageSchedules.scheduledActionId,
          recurringMessageOccurrences.scheduledActionId,
        ),
      )
      .innerJoin(
        scheduledActions,
        eq(scheduledActions.id, recurringMessageOccurrences.scheduledActionId),
      )
      .innerJoin(
        scheduledMessageStates,
        eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
      )
      .where(
        and(
          eq(recurringMessageOccurrences.id, occurrenceId),
          eq(scheduledActions.actionType, "SEND_MESSAGE"),
        ),
      )
      .limit(1);
    return row;
  };
  const retryWake = async (occurrenceId: string, retryCount: number): Promise<Date | undefined> => {
    const audits = await database
      .select()
      .from(recurringMessageAudits)
      .where(
        and(
          eq(recurringMessageAudits.occurrenceId, occurrenceId),
          eq(recurringMessageAudits.event, "OCCURRENCE_RETRY"),
          eq(recurringMessageAudits.retryCount, retryCount),
        ),
      )
      .limit(2);
    const audit = audits[0];
    if (
      audits.length !== 1 ||
      audit === undefined ||
      audit.failureCode !== "CURRENT_STATE_CHECK_FAILED"
    )
      return undefined;
    return new Date(audit.occurredAt.getTime() + RECURRING_RETRY_DELAY_MS);
  };
  const confirmTerminal = async (
    input: RecurringTerminalInput,
  ): Promise<RecurringRuntimeTransition> => {
    const [audit] = await database
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, input.auditId))
      .limit(1);
    const [occurrence] = await database
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, input.occurrenceId))
      .limit(1);
    if (
      audit !== undefined &&
      occurrence !== undefined &&
      terminalAuditMatches(audit, input, occurrence) &&
      occurrence.status === (input.failureCode === undefined ? "COMPLETED" : "FAILED") &&
      occurrence.failureCode === (input.failureCode ?? null) &&
      occurrence.resultMessageId === (input.resultMessageId ?? null)
    ) {
      if (audit.postSeriesStatus === "ACTIVE") {
        const [next] = await database
          .select()
          .from(recurringMessageOccurrences)
          .where(eq(recurringMessageOccurrences.id, input.nextOccurrenceId))
          .limit(1);
        if (
          next === undefined ||
          next.scheduledActionId !== occurrence.scheduledActionId ||
          next.intendedLocalDate !== audit.nextIntendedLocalDate ||
          next.intendedLocalTime !== audit.nextIntendedLocalTime ||
          next.scheduledFor.getTime() !== audit.nextScheduledFor?.getTime()
        )
          return "UNKNOWN";
        const [action] = await database
          .select()
          .from(scheduledActions)
          .where(eq(scheduledActions.id, occurrence.scheduledActionId))
          .limit(1);
        if (action?.status === "ACTIVE") {
          const [current] = await database
            .select({ id: recurringMessageOccurrences.id })
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                eq(recurringMessageOccurrences.status, "PENDING"),
              ),
            )
            .limit(1);
          if (current?.id === next.id && action.executeAt.getTime() !== next.scheduledFor.getTime())
            return "UNKNOWN";
        }
      }
      if (input.failureCode === undefined) {
        const [state] = await database
          .select({ creatorUserId: scheduledMessageStates.creatorUserId })
          .from(scheduledMessageStates)
          .where(eq(scheduledMessageStates.scheduledActionId, occurrence.scheduledActionId))
          .limit(1);
        const [managed] = await database
          .select()
          .from(managedMessages)
          .where(eq(managedMessages.messageId, input.resultMessageId!))
          .limit(1);
        const [managedAudit] = await database
          .select()
          .from(managedMessageAudits)
          .where(eq(managedMessageAudits.id, input.managedMessageAuditId!))
          .limit(1);
        if (
          state === undefined ||
          managed === undefined ||
          managedAudit === undefined ||
          managed.guildId !== audit.guildId ||
          managed.channelId !== audit.channelId ||
          managed.creatorUserId !== state.creatorUserId ||
          managed.status !== "ACTIVE" ||
          managed.content !== occurrence.claimContent ||
          managed.embedTitle !== occurrence.claimEmbedTitle ||
          managed.embedDescription !== occurrence.claimEmbedDescription ||
          managed.embedColor !== occurrence.claimEmbedColor ||
          managed.embedImageUrl !== occurrence.claimEmbedImageUrl ||
          managedAudit.messageId !== input.resultMessageId ||
          managedAudit.event !== "CREATED" ||
          managedAudit.actorId !== state.creatorUserId ||
          managedAudit.afterContent !== occurrence.claimContent ||
          managedAudit.afterEmbedTitle !== occurrence.claimEmbedTitle ||
          managedAudit.afterEmbedDescription !== occurrence.claimEmbedDescription ||
          managedAudit.afterEmbedColor !== occurrence.claimEmbedColor ||
          managedAudit.afterEmbedImageUrl !== occurrence.claimEmbedImageUrl
        )
          return "UNKNOWN";
      }
      return "COMMITTED";
    }
    if (
      audit === undefined &&
      (occurrence?.status === "EXECUTING" || occurrence?.status === "RETRY_PENDING") &&
      occurrence.resultMessageId === null
    ) {
      const [next] = await database
        .select({ id: recurringMessageOccurrences.id })
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, input.nextOccurrenceId))
        .limit(1);
      const [managed] =
        input.resultMessageId === undefined
          ? []
          : await database
              .select({ messageId: managedMessages.messageId })
              .from(managedMessages)
              .where(eq(managedMessages.messageId, input.resultMessageId))
              .limit(1);
      if (next === undefined && managed === undefined) return "NOT_COMMITTED";
    }
    return "UNKNOWN";
  };
  const terminalize = async (
    input: RecurringTerminalInput,
  ): Promise<RecurringRuntimeTransition> => {
    const gapAuditIds: string[] = [];
    try {
      const committed = await database.transaction(async (transaction) => {
        const definition = await lockedDefinition(transaction, input.occurrenceId);
        if (
          definition === undefined ||
          !activeStatuses.includes(definition.occurrence.status as (typeof activeStatuses)[number])
        )
          return false;
        await terminalInTransaction(transaction, definition, input, gapAuditIds);
        return true;
      });
      if (committed) await publish([input.auditId, ...gapAuditIds], input.managedMessageAuditId);
      return committed ? "COMMITTED" : "NOT_COMMITTED";
    } catch {
      const result = await confirmTerminal(input).catch(() => "UNKNOWN" as const);
      if (result === "COMMITTED")
        await publish([input.auditId, ...gapAuditIds], input.managedMessageAuditId);
      return result;
    }
  };
  return {
    load,
    async page(status, afterId) {
      const rows = await database
        .select({
          action: scheduledActions,
          state: scheduledMessageStates,
          recurrence: recurringMessageSchedules,
          occurrence: recurringMessageOccurrences,
        })
        .from(recurringMessageOccurrences)
        .innerJoin(
          recurringMessageSchedules,
          eq(
            recurringMessageSchedules.scheduledActionId,
            recurringMessageOccurrences.scheduledActionId,
          ),
        )
        .innerJoin(
          scheduledActions,
          eq(scheduledActions.id, recurringMessageOccurrences.scheduledActionId),
        )
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .where(
          and(
            eq(recurringMessageOccurrences.status, status),
            afterId === undefined ? undefined : gt(recurringMessageOccurrences.id, afterId),
          ),
        )
        .orderBy(asc(recurringMessageOccurrences.id))
        .limit(100);
      return rows;
    },
    async pageMissing(afterId) {
      const rows = await database
        .select({ id: scheduledActions.id })
        .from(scheduledActions)
        .innerJoin(
          recurringMessageSchedules,
          eq(recurringMessageSchedules.scheduledActionId, scheduledActions.id),
        )
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .leftJoin(
          recurringMessageOccurrences,
          and(
            eq(recurringMessageOccurrences.scheduledActionId, scheduledActions.id),
            inArray(recurringMessageOccurrences.status, activeStatuses),
          ),
        )
        .where(
          and(
            eq(scheduledActions.status, "ACTIVE"),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
            isNull(recurringMessageOccurrences.id),
            afterId === undefined ? undefined : gt(scheduledActions.id, afterId),
          ),
        )
        .orderBy(asc(scheduledActions.id))
        .limit(100);
      return rows.map((row) => row.id);
    },
    retryWake,
    async resumeRetry(occurrenceId, retryCount, at) {
      try {
        return await database.transaction(async (transaction) => {
          const definition = await lockedDefinition(transaction, occurrenceId);
          if (
            definition === undefined ||
            definition.action.status !== "ACTIVE" ||
            definition.occurrence.status !== "RETRY_PENDING" ||
            definition.occurrence.retryCount !== retryCount ||
            definition.occurrence.firstAttemptedAt === null
          )
            return undefined;
          const retryAudits = await transaction
            .select()
            .from(recurringMessageAudits)
            .where(
              and(
                eq(recurringMessageAudits.occurrenceId, occurrenceId),
                eq(recurringMessageAudits.event, "OCCURRENCE_RETRY"),
                eq(recurringMessageAudits.retryCount, retryCount),
              ),
            )
            .limit(2);
          const retryAudit = retryAudits[0];
          if (
            retryAudits.length !== 1 ||
            retryAudit === undefined ||
            retryAudit.failureCode !== "CURRENT_STATE_CHECK_FAILED" ||
            retryAudit.scheduledActionId !== definition.action.id ||
            retryAudit.occurredAt.getTime() + RECURRING_RETRY_DELAY_MS >
              definition.occurrence.firstAttemptedAt.getTime() + RECURRING_RETRY_LIFETIME_MS ||
            at.getTime() >
              definition.occurrence.firstAttemptedAt.getTime() + RECURRING_RETRY_LIFETIME_MS ||
            at.getTime() < retryAudit.occurredAt.getTime() + RECURRING_RETRY_DELAY_MS
          )
            return undefined;
          const [resumed] = await transaction
            .update(recurringMessageOccurrences)
            .set({ status: "EXECUTING", updatedAt: new Date() })
            .where(
              and(
                eq(recurringMessageOccurrences.id, occurrenceId),
                eq(recurringMessageOccurrences.status, "RETRY_PENDING"),
                eq(recurringMessageOccurrences.retryCount, retryCount),
              ),
            )
            .returning();
          return resumed;
        });
      } catch {
        return undefined;
      }
    },
    async recordPreSendFailure(input) {
      const gapAuditIds: string[] = [];
      try {
        const result = await database.transaction(async (transaction) => {
          const definition = await lockedDefinition(transaction, input.occurrenceId);
          if (
            definition === undefined ||
            definition.occurrence.status !== "EXECUTING" ||
            definition.occurrence.firstAttemptedAt === null
          )
            return { outcome: "NOT_TRANSITIONED" } as const;
          const decision = decideRecurringRetry(
            definition.occurrence.firstAttemptedAt,
            definition.occurrence.retryCount,
            input.occurredAt,
          );
          if (decision.outcome === "FAIL" || definition.action.status === "CANCELLED") {
            const failureCode =
              decision.outcome === "FAIL" ? decision.failureCode : "CURRENT_STATE_CHECK_FAILED";
            await terminalInTransaction(
              transaction,
              definition,
              {
                ...input,
                failureCode,
              },
              gapAuditIds,
            );
            return { outcome: "FAILED", failureCode } as const;
          }
          const [updated] = await transaction
            .update(recurringMessageOccurrences)
            .set({
              status: "RETRY_PENDING",
              retryCount: decision.retryCount,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(recurringMessageOccurrences.id, input.occurrenceId),
                eq(recurringMessageOccurrences.status, "EXECUTING"),
                eq(recurringMessageOccurrences.retryCount, definition.occurrence.retryCount),
              ),
            )
            .returning();
          if (updated === undefined) throw new Error("Retry transition lost ownership");
          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: definition.action.id,
            guildId: definition.action.guildId,
            channelId: definition.action.targetId,
            event: "OCCURRENCE_RETRY",
            actorType: "SYSTEM",
            outcome: "FAILURE",
            ...occurrenceAuditFields(updated),
            failureCode: "CURRENT_STATE_CHECK_FAILED",
            occurredAt: input.occurredAt,
          });
          return {
            outcome: "RETRY_PENDING",
            wakeAt: decision.wakeAt,
            retryCount: decision.retryCount,
          } as const;
        });
        if (result.outcome === "FAILED" || result.outcome === "RETRY_PENDING") {
          await publish([input.auditId, ...gapAuditIds]);
        }
        return result;
      } catch {
        const [audit] = await database
          .select()
          .from(recurringMessageAudits)
          .where(eq(recurringMessageAudits.id, input.auditId))
          .limit(1)
          .catch(() => []);
        const [occurrence] = await database
          .select()
          .from(recurringMessageOccurrences)
          .where(eq(recurringMessageOccurrences.id, input.occurrenceId))
          .limit(1)
          .catch(() => []);
        if (
          audit?.event === "OCCURRENCE_RETRY" &&
          audit.occurrenceId === input.occurrenceId &&
          audit.failureCode === "CURRENT_STATE_CHECK_FAILED" &&
          audit.occurredAt.getTime() === input.occurredAt.getTime() &&
          occurrence !== undefined &&
          audit.retryCount !== null &&
          occurrence.retryCount >= audit.retryCount
        ) {
          await publish([input.auditId, ...gapAuditIds]);
          return {
            outcome: "RETRY_PENDING",
            wakeAt: new Date(audit.occurredAt.getTime() + RECURRING_RETRY_DELAY_MS),
            retryCount: audit.retryCount,
          };
        }
        if (
          audit?.event === "OCCURRENCE_FAILED" &&
          audit.occurrenceId === input.occurrenceId &&
          audit.occurredAt.getTime() === input.occurredAt.getTime() &&
          occurrence?.status === "FAILED" &&
          occurrence.failureCode === audit.failureCode &&
          audit.retryCount === occurrence.retryCount &&
          (audit.postSeriesStatus === "CANCELLED"
            ? audit.nextOccurrenceId === null
            : audit.nextOccurrenceId === input.nextOccurrenceId) &&
          occurrence.failureCode !== null
        ) {
          await publish([input.auditId, ...gapAuditIds]);
          return { outcome: "FAILED", failureCode: occurrence.failureCode };
        }
        return { outcome: "UNKNOWN" };
      }
    },
    async expireRetry(input) {
      const gapAuditIds: string[] = [];
      const terminalInput: RecurringTerminalInput = {
        occurrenceId: input.occurrenceId,
        auditId: input.auditId,
        nextOccurrenceId: input.nextOccurrenceId,
        occurredAt: input.occurredAt,
        failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
      };
      try {
        const expired = await database.transaction(async (transaction) => {
          const definition = await lockedDefinition(transaction, input.occurrenceId);
          if (
            definition === undefined ||
            definition.occurrence.status !== "RETRY_PENDING" ||
            definition.occurrence.retryCount !== input.expectedRetryCount ||
            definition.occurrence.firstAttemptedAt === null
          )
            return false;
          const retryAudits = await transaction
            .select()
            .from(recurringMessageAudits)
            .where(
              and(
                eq(recurringMessageAudits.occurrenceId, input.occurrenceId),
                eq(recurringMessageAudits.event, "OCCURRENCE_RETRY"),
                eq(recurringMessageAudits.retryCount, input.expectedRetryCount),
              ),
            )
            .limit(2);
          const retryAudit = retryAudits[0];
          if (
            retryAudits.length !== 1 ||
            retryAudit === undefined ||
            retryAudit.scheduledActionId !== definition.action.id ||
            retryAudit.failureCode !== "CURRENT_STATE_CHECK_FAILED"
          )
            return false;
          const deadline =
            definition.occurrence.firstAttemptedAt.getTime() + RECURRING_RETRY_LIFETIME_MS;
          const wakeAt = retryAudit.occurredAt.getTime() + RECURRING_RETRY_DELAY_MS;
          if (input.occurredAt.getTime() <= deadline && wakeAt <= deadline) return false;
          await terminalInTransaction(transaction, definition, terminalInput, gapAuditIds);
          return true;
        });
        if (expired) await publish([input.auditId, ...gapAuditIds]);
        return expired ? "COMMITTED" : "NOT_COMMITTED";
      } catch {
        const result = await confirmTerminal(terminalInput).catch(() => "UNKNOWN" as const);
        if (result === "COMMITTED") await publish([input.auditId, ...gapAuditIds]);
        return result;
      }
    },
    terminalize,
    async recoverMissed(input) {
      const { occurrenceId, at } = input;
      let expected:
        | {
            scheduledFor: Date;
            localDate: string;
            localTime: string;
            definitionRevision: number;
            gapIds: string[];
          }
        | undefined;
      try {
        const changed = await database.transaction(async (transaction) => {
          const definition = await lockedDefinition(transaction, occurrenceId);
          if (
            definition === undefined ||
            definition.action.status !== "ACTIVE" ||
            definition.occurrence.status !== "PENDING"
          )
            return false;
          const current = definition.occurrence;
          const recurrence = definition.recurrence;
          const selected = selectMissedAndFutureOccurrences(
            recurrenceDefinition(recurrence),
            recurrence.definitionRevision,
            new Date(
              Math.max(recurrence.effectiveAt.getTime(), current.scheduledFor.getTime() - 1),
            ),
            at,
          );
          if (
            selected.latestMissed?.scheduledFor.getTime() === current.scheduledFor.getTime() &&
            at.getTime() <= current.scheduledFor.getTime() + graceMs
          )
            return false;
          const next =
            selected.latestMissedWithinGrace && selected.latestMissed !== null
              ? selected.latestMissed
              : selected.firstFuture;
          const gapIds = selected.skippedGaps.map((gap) =>
            createHash("sha256")
              .update(
                `weft:recurring-missed-gap:v1\0${input.auditId}\0${gap.intendedLocalDate}\0${gap.intendedLocalTime}`,
              )
              .digest("hex"),
          );
          expected = {
            scheduledFor: next.scheduledFor,
            localDate: next.intendedLocalDate,
            localTime: next.intendedLocalTime,
            definitionRevision: recurrence.definitionRevision,
            gapIds,
          };
          await transaction
            .update(recurringMessageOccurrences)
            .set({
              status: "SKIPPED",
              skipReason: "MISSED_GRACE_EXCEEDED",
              terminalAt: at,
              updatedAt: new Date(),
            })
            .where(eq(recurringMessageOccurrences.id, current.id));
          const nextId = input.nextOccurrenceId;
          await transaction.insert(recurringMessageOccurrences).values({
            id: nextId,
            scheduledActionId: definition.action.id,
            materializedDefinitionRevision: recurrence.definitionRevision,
            intendedLocalDate: next.intendedLocalDate,
            intendedLocalTime: next.intendedLocalTime,
            scheduledFor: next.scheduledFor,
            status: "PENDING",
            retryCount: 0,
          });
          await transaction
            .update(scheduledActions)
            .set({ executeAt: next.scheduledFor, updatedAt: new Date() })
            .where(eq(scheduledActions.id, definition.action.id));
          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: definition.action.id,
            guildId: definition.action.guildId,
            channelId: definition.action.targetId,
            event: "MISSED_RANGE_SKIPPED",
            actorType: "SYSTEM",
            outcome: "SKIPPED",
            afterTimezone: recurrence.timezone,
            afterDefinitionRevision: recurrence.definitionRevision,
            rangeStartOccurrenceId: current.id,
            skippedFromLocalDate: current.intendedLocalDate,
            skippedFromLocalTime: current.intendedLocalTime,
            skippedThroughLocalDate:
              selected.skippedRange?.throughLocalDate ?? current.intendedLocalDate,
            skippedThroughLocalTime:
              selected.skippedRange?.throughLocalTime ?? current.intendedLocalTime,
            selectedNextLocalDate: next.intendedLocalDate,
            selectedNextLocalTime: next.intendedLocalTime,
            selectedNextScheduledFor: next.scheduledFor,
            auditSkipReason: "MISSED_GRACE_EXCEEDED",
            occurredAt: at,
          });
          for (const [index, gap] of selected.skippedGaps.entries())
            await transaction.insert(recurringMessageAudits).values({
              id: gapIds[index]!,
              scheduledActionId: definition.action.id,
              guildId: definition.action.guildId,
              channelId: definition.action.targetId,
              event: "DST_GAP_SKIPPED",
              actorType: "SYSTEM",
              outcome: "SKIPPED",
              intendedLocalDate: gap.intendedLocalDate,
              intendedLocalTime: gap.intendedLocalTime,
              afterTimezone: recurrence.timezone,
              afterDefinitionRevision: recurrence.definitionRevision,
              auditSkipReason: "DST_GAP",
              occurredAt: at,
            });
          return true;
        });
        if (changed) await publish([input.auditId, ...expected!.gapIds]);
        return changed ? "COMMITTED" : "NOT_COMMITTED";
      } catch {
        if (expected === undefined) return "UNKNOWN";
        try {
          const [audit] = await database
            .select()
            .from(recurringMessageAudits)
            .where(eq(recurringMessageAudits.id, input.auditId))
            .limit(1);
          const [old] = await database
            .select()
            .from(recurringMessageOccurrences)
            .where(eq(recurringMessageOccurrences.id, occurrenceId))
            .limit(1);
          const [next] = await database
            .select()
            .from(recurringMessageOccurrences)
            .where(eq(recurringMessageOccurrences.id, input.nextOccurrenceId))
            .limit(1);
          if (
            next === undefined ||
            next.materializedDefinitionRevision !== expected.definitionRevision ||
            next.intendedLocalDate !== expected.localDate ||
            next.intendedLocalTime.slice(0, 5) !== expected.localTime ||
            next.scheduledFor.getTime() !== expected.scheduledFor.getTime()
          )
            return "UNKNOWN";
          const [action] = await database
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, next.scheduledActionId))
            .limit(1);
          if (
            next.status === "PENDING" &&
            (next.retryCount !== 0 ||
              next.firstAttemptedAt !== null ||
              next.claimedAt !== null ||
              next.claimContent !== null ||
              next.failureCode !== null ||
              next.resultMessageId !== null ||
              next.terminalAt !== null)
          )
            return "UNKNOWN";
          for (const gapId of expected.gapIds) {
            const [gapAudit] = await database
              .select()
              .from(recurringMessageAudits)
              .where(eq(recurringMessageAudits.id, gapId))
              .limit(1);
            if (
              gapAudit?.event !== "DST_GAP_SKIPPED" ||
              gapAudit.afterDefinitionRevision !== expected.definitionRevision ||
              gapAudit.occurredAt.getTime() !== at.getTime()
            )
              return "UNKNOWN";
          }
          const confirmed =
            audit?.event === "MISSED_RANGE_SKIPPED" &&
            audit.rangeStartOccurrenceId === occurrenceId &&
            audit.selectedNextLocalDate === next?.intendedLocalDate &&
            audit.selectedNextLocalTime?.slice(0, 5) === expected.localTime &&
            audit.selectedNextScheduledFor?.getTime() === next?.scheduledFor.getTime() &&
            old?.status === "SKIPPED" &&
            old.skipReason === "MISSED_GRACE_EXCEEDED" &&
            old.terminalAt?.getTime() === at.getTime() &&
            (next.status !== "PENDING" ||
              action?.status !== "ACTIVE" ||
              action.executeAt.getTime() === next.scheduledFor.getTime()) &&
            audit.occurredAt.getTime() === at.getTime()
              ? "COMMITTED"
              : "UNKNOWN";
          if (confirmed === "COMMITTED") await publish([input.auditId, ...expected.gapIds]);
          return confirmed;
        } catch {
          return "UNKNOWN";
        }
      }
    },
    async recoverMissing(input) {
      let intended:
        | {
            localDate: string;
            localTime: string;
            scheduledFor: Date;
            range: boolean;
            definitionRevision: number;
            gaps: Array<{ id: string; localDate: string; localTime: string }>;
          }
        | undefined;
      try {
        const committed = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1)
            .for("update");
          if (action?.status !== "ACTIVE" || action.actionType !== "SEND_MESSAGE") return false;
          const [recurrence] = await transaction
            .select()
            .from(recurringMessageSchedules)
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .limit(1);
          const [state] = await transaction
            .select({ scheduledActionId: scheduledMessageStates.scheduledActionId })
            .from(scheduledMessageStates)
            .where(eq(scheduledMessageStates.scheduledActionId, action.id))
            .limit(1);
          if (recurrence === undefined || state === undefined) return false;
          const [nonterminal] = await transaction
            .select({ id: recurringMessageOccurrences.id })
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                inArray(recurringMessageOccurrences.status, activeStatuses),
              ),
            )
            .limit(1)
            .for("update");
          if (nonterminal !== undefined) return false;
          const [lastTerminal] = await transaction
            .select()
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                eq(
                  recurringMessageOccurrences.materializedDefinitionRevision,
                  recurrence.definitionRevision,
                ),
                inArray(recurringMessageOccurrences.status, ["COMPLETED", "FAILED", "SKIPPED"]),
              ),
            )
            .orderBy(
              desc(recurringMessageOccurrences.scheduledFor),
              desc(recurringMessageOccurrences.id),
            )
            .limit(1);
          const after = new Date(
            Math.max(
              recurrence.effectiveAt.getTime(),
              lastTerminal?.scheduledFor.getTime() ?? -Infinity,
            ),
          );
          const selection = selectMissedAndFutureOccurrences(
            recurrenceDefinition(recurrence),
            recurrence.definitionRevision,
            after,
            input.at,
          );
          const candidate =
            selection.latestMissedWithinGrace && selection.latestMissed !== null
              ? selection.latestMissed
              : selection.firstFuture;
          const gaps = selection.skippedGaps.map((gap) => ({
            id: createHash("sha256")
              .update(
                `weft:recurring-missing-gap:v1\0${input.auditId}\0${gap.intendedLocalDate}\0${gap.intendedLocalTime}`,
              )
              .digest("hex"),
            localDate: gap.intendedLocalDate,
            localTime: gap.intendedLocalTime,
          }));
          intended = {
            localDate: candidate.intendedLocalDate,
            localTime: candidate.intendedLocalTime,
            scheduledFor: candidate.scheduledFor,
            range: selection.skippedRange !== null,
            definitionRevision: recurrence.definitionRevision,
            gaps,
          };
          await transaction.insert(recurringMessageOccurrences).values({
            id: input.nextOccurrenceId,
            scheduledActionId: action.id,
            materializedDefinitionRevision: recurrence.definitionRevision,
            intendedLocalDate: candidate.intendedLocalDate,
            intendedLocalTime: candidate.intendedLocalTime,
            scheduledFor: candidate.scheduledFor,
            status: "PENDING",
            retryCount: 0,
          });
          await transaction
            .update(scheduledActions)
            .set({ executeAt: candidate.scheduledFor, updatedAt: new Date() })
            .where(eq(scheduledActions.id, action.id));
          if (selection.skippedRange !== null) {
            await transaction.insert(recurringMessageAudits).values({
              id: input.auditId,
              scheduledActionId: action.id,
              guildId: action.guildId,
              channelId: action.targetId,
              event: "MISSED_RANGE_SKIPPED",
              actorType: "SYSTEM",
              outcome: "SKIPPED",
              afterTimezone: recurrence.timezone,
              afterDefinitionRevision: recurrence.definitionRevision,
              rangeStartOccurrenceId: lastTerminal?.id ?? null,
              skippedFromLocalDate: selection.skippedRange.fromLocalDate,
              skippedFromLocalTime: selection.skippedRange.fromLocalTime,
              skippedThroughLocalDate: selection.skippedRange.throughLocalDate,
              skippedThroughLocalTime: selection.skippedRange.throughLocalTime,
              selectedNextLocalDate: candidate.intendedLocalDate,
              selectedNextLocalTime: candidate.intendedLocalTime,
              selectedNextScheduledFor: candidate.scheduledFor,
              auditSkipReason: "MISSED_GRACE_EXCEEDED",
              occurredAt: input.at,
            });
          }
          for (const gap of gaps) {
            await transaction.insert(recurringMessageAudits).values({
              id: gap.id,
              scheduledActionId: action.id,
              guildId: action.guildId,
              channelId: action.targetId,
              event: "DST_GAP_SKIPPED",
              actorType: "SYSTEM",
              outcome: "SKIPPED",
              intendedLocalDate: gap.localDate,
              intendedLocalTime: gap.localTime,
              afterTimezone: recurrence.timezone,
              afterDefinitionRevision: recurrence.definitionRevision,
              auditSkipReason: "DST_GAP",
              occurredAt: input.at,
            });
          }
          return true;
        });
        if (committed) await publish([input.auditId, ...intended!.gaps.map((gap) => gap.id)]);
        return committed ? "COMMITTED" : "NOT_COMMITTED";
      } catch {
        if (intended === undefined) return "UNKNOWN";
        try {
          const [row] = await database
            .select()
            .from(recurringMessageOccurrences)
            .where(eq(recurringMessageOccurrences.id, input.nextOccurrenceId))
            .limit(1);
          const [audit] = await database
            .select()
            .from(recurringMessageAudits)
            .where(eq(recurringMessageAudits.id, input.auditId))
            .limit(1);
          const [action] = await database
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1);
          if (
            row === undefined ||
            row.scheduledActionId !== input.scheduledActionId ||
            row.materializedDefinitionRevision !== intended.definitionRevision ||
            row.intendedLocalDate !== intended.localDate ||
            row.intendedLocalTime.slice(0, 5) !== intended.localTime ||
            row.scheduledFor.getTime() !== intended.scheduledFor.getTime()
          )
            return "UNKNOWN";
          if (
            intended.range &&
            (audit?.event !== "MISSED_RANGE_SKIPPED" ||
              audit.selectedNextScheduledFor?.getTime() !== intended.scheduledFor.getTime() ||
              audit.occurredAt.getTime() !== input.at.getTime())
          )
            return "UNKNOWN";
          if (!intended.range && audit !== undefined) return "UNKNOWN";
          for (const gap of intended.gaps) {
            const [gapAudit] = await database
              .select()
              .from(recurringMessageAudits)
              .where(eq(recurringMessageAudits.id, gap.id))
              .limit(1);
            if (
              gapAudit?.event !== "DST_GAP_SKIPPED" ||
              gapAudit.intendedLocalDate !== gap.localDate ||
              gapAudit.intendedLocalTime?.slice(0, 5) !== gap.localTime ||
              gapAudit.afterDefinitionRevision !== intended.definitionRevision ||
              gapAudit.occurredAt.getTime() !== input.at.getTime()
            )
              return "UNKNOWN";
          }
          if (
            row.status === "PENDING" &&
            action?.status === "ACTIVE" &&
            action.executeAt.getTime() !== intended.scheduledFor.getTime()
          )
            return "UNKNOWN";
          if (
            row.status === "PENDING" &&
            (row.retryCount !== 0 ||
              row.firstAttemptedAt !== null ||
              row.claimedAt !== null ||
              row.claimContent !== null ||
              row.failureCode !== null ||
              row.resultMessageId !== null ||
              row.terminalAt !== null)
          )
            return "UNKNOWN";
          await publish([input.auditId, ...intended.gaps.map((gap) => gap.id)]);
          return "COMMITTED";
        } catch {
          return "UNKNOWN";
        }
      }
    },
  };
}

export function recurringClaimPayload(
  occurrence: RecurringMessageOccurrence,
): ManagedMessagePayload | undefined {
  return claimPayload(occurrence);
}
