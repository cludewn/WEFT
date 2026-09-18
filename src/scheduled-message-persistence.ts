import { and, eq, isNull, sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import {
  validateManagedMessagePayload,
  type ManagedMessagePayload,
} from "./managed-message-payload.js";
import {
  insertManagedMessageCreation,
  managedMessageAudits,
  managedMessages,
  type CreateManagedMessage,
} from "./managed-message-persistence.js";
import { scheduledActions, type ScheduledAction } from "./scheduled-action-persistence.js";

export const SCHEDULED_MESSAGE_AUDIT_EVENTS = [
  "CREATED",
  "CANCELLED",
  "EXECUTION_COMPLETED",
  "EXECUTION_RETRY",
  "EXECUTION_FAILED",
] as const;
export type ScheduledMessageAuditEvent = (typeof SCHEDULED_MESSAGE_AUDIT_EVENTS)[number];

export const SCHEDULED_MESSAGE_FAILURE_CODES = [
  "OVERDUE_GRACE_EXCEEDED",
  "UNSUPPORTED_TARGET",
  "TARGET_GUILD_MISMATCH",
  "ARCHIVED_THREAD",
  "BOT_PERMISSION_MISSING",
  "CURRENT_STATE_CHECK_REJECTED",
  "CURRENT_STATE_CHECK_FAILED",
  "PERSISTED_PAYLOAD_INVALID",
  "SEND_REJECTED",
  "SEND_UNCONFIRMED",
  "RETURNED_MESSAGE_MISMATCH",
  "FINALIZATION_FAILED_COMPENSATED",
  "FINALIZATION_FAILED_UNCOMPENSATED",
  "EXECUTION_INTERRUPTED_UNCONFIRMED",
] as const;
export type ScheduledMessageFailureCode = (typeof SCHEDULED_MESSAGE_FAILURE_CODES)[number];
export type ScheduledMessagePreSendRetryFailureCode = "CURRENT_STATE_CHECK_FAILED";

export const scheduledMessageStates = pgTable(
  "scheduled_message_states",
  {
    scheduledActionId: text("scheduled_action_id")
      .primaryKey()
      .references(() => scheduledActions.id),
    creatorUserId: text("creator_user_id").notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    content: text("content").notNull(),
    embedTitle: text("embed_title"),
    embedDescription: text("embed_description"),
    embedColor: integer("embed_color"),
    embedImageUrl: text("embed_image_url"),
    resultMessageId: text("result_message_id"),
  },
  (table) => [
    check("scheduled_message_states_retry_count_check", sql`${table.retryCount} between 0 and 3`),
    check(
      "scheduled_message_states_payload_check",
      sql`char_length(${table.content}) between 0 and 2000
        and (${table.embedTitle} is null or char_length(${table.embedTitle}) between 1 and 256)
        and (${table.embedDescription} is null or char_length(${table.embedDescription}) between 1 and 4000)
        and (${table.embedColor} is null or ${table.embedColor} between 0 and 16777215)
        and (${table.embedImageUrl} is null or char_length(${table.embedImageUrl}) between 1 and 2048)
        and (${table.embedColor} is null or ${table.embedTitle} is not null or ${table.embedDescription} is not null or ${table.embedImageUrl} is not null)
        and (char_length(${table.content}) > 0 or ${table.embedTitle} is not null or ${table.embedDescription} is not null or ${table.embedImageUrl} is not null)`,
    ),
  ],
);

export const scheduledMessageAudits = pgTable(
  "scheduled_message_audits",
  {
    id: text("id").primaryKey(),
    scheduledActionId: text("scheduled_action_id").notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    event: text("event").$type<ScheduledMessageAuditEvent>().notNull(),
    actorType: text("actor_type").$type<"USER" | "SYSTEM">().notNull(),
    actorId: text("actor_id"),
    executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    embedTitle: text("embed_title"),
    embedDescription: text("embed_description"),
    embedColor: integer("embed_color"),
    embedImageUrl: text("embed_image_url"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<"SUCCESS" | "FAILURE">().notNull(),
    failureCode: text("failure_code").$type<ScheduledMessageFailureCode>(),
    resultMessageId: text("result_message_id"),
  },
  (table) => [
    check(
      "scheduled_message_audits_event_check",
      sql`${table.event} in ('CREATED', 'CANCELLED', 'EXECUTION_COMPLETED', 'EXECUTION_RETRY', 'EXECUTION_FAILED')`,
    ),
    check(
      "scheduled_message_audits_actor_type_check",
      sql`${table.actorType} in ('USER', 'SYSTEM')`,
    ),
    check(
      "scheduled_message_audits_outcome_check",
      sql`${table.outcome} in ('SUCCESS', 'FAILURE')`,
    ),
    check(
      "scheduled_message_audits_shape_check",
      sql`(
        ${table.event} = 'CREATED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.outcome} = 'SUCCESS' and ${table.failureCode} is null
        and ${table.resultMessageId} is null
      ) or (
        ${table.event} = 'CANCELLED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.outcome} = 'SUCCESS' and ${table.failureCode} is null
        and ${table.resultMessageId} is null
      ) or (
        ${table.event} = 'EXECUTION_COMPLETED'
        and ${table.actorType} = 'SYSTEM' and ${table.actorId} is null
        and ${table.outcome} = 'SUCCESS' and ${table.failureCode} is null
        and ${table.resultMessageId} is not null
      ) or (
        ${table.event} = 'EXECUTION_RETRY'
        and ${table.actorType} = 'SYSTEM' and ${table.actorId} is null
        and ${table.outcome} = 'FAILURE' and ${table.failureCode} is not null
        and ${table.resultMessageId} is null
      ) or (
        ${table.event} = 'EXECUTION_FAILED'
        and ${table.actorType} = 'SYSTEM' and ${table.actorId} is null
        and ${table.outcome} = 'FAILURE' and ${table.failureCode} is not null
        and (
          ${table.resultMessageId} is null
          or ${table.failureCode} in ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED')
        )
      )`,
    ),
    check(
      "scheduled_message_audits_payload_check",
      sql`char_length(${table.content}) between 0 and 2000
        and (${table.embedTitle} is null or char_length(${table.embedTitle}) between 1 and 256)
        and (${table.embedDescription} is null or char_length(${table.embedDescription}) between 1 and 4000)
        and (${table.embedColor} is null or ${table.embedColor} between 0 and 16777215)
        and (${table.embedImageUrl} is null or char_length(${table.embedImageUrl}) between 1 and 2048)
        and (${table.embedColor} is null or ${table.embedTitle} is not null or ${table.embedDescription} is not null or ${table.embedImageUrl} is not null)
        and (char_length(${table.content}) > 0 or ${table.embedTitle} is not null or ${table.embedDescription} is not null or ${table.embedImageUrl} is not null)`,
    ),
    index("scheduled_message_audits_action_id_idx").on(table.scheduledActionId),
  ],
);

export type ScheduledMessageState = typeof scheduledMessageStates.$inferSelect;
export type ScheduledMessageAudit = typeof scheduledMessageAudits.$inferSelect;
export type ScheduledMessagePayloadColumns = {
  content: string;
  embedTitle: string | null;
  embedDescription: string | null;
  embedColor: number | null;
  embedImageUrl: string | null;
};
export type ScheduledMessageDefinition = {
  action: ScheduledAction;
  creatorUserId: string;
  retryCount: number;
  payload: ManagedMessagePayload;
  resultMessageId: string | null;
};
export type ScheduledMessageExecutionLoadResult =
  | { outcome: "MISSING_ACTION" }
  | { outcome: "ACTION_TYPE_MISMATCH" }
  | { outcome: "STATE_MISSING"; action: ScheduledAction }
  | { outcome: "FOUND"; definition: ScheduledMessageDefinition };
export type CreateScheduledMessage = {
  scheduledActionId: string;
  auditId: string;
  guildId: string;
  channelId: string;
  actorId: string;
  executeAt: Date;
  payload: ManagedMessagePayload;
  occurredAt: Date;
};
export type ScheduledMessageCreationConfirmation =
  | { outcome: "MATCH"; definition: ScheduledMessageDefinition }
  | { outcome: "MISSING" | "CONFLICT" };
export type ScheduledMessageExecutionTransition =
  | { outcome: "COMMITTED"; definition: ScheduledMessageDefinition }
  | { outcome: "NOT_TRANSITIONED"; current: ScheduledMessageDefinition | undefined };
export type ScheduledMessageExecutionClaimTransition =
  | ScheduledMessageExecutionTransition
  | { outcome: "COMMITTED_STATE_MISSING"; action: ScheduledAction };
export type FailScheduledMessageMissingState = {
  action: ScheduledAction;
  auditId: string;
  occurredAt: Date;
};
export type ScheduledMessageMissingStateTransition =
  { outcome: "COMMITTED" } | { outcome: "NOT_TRANSITIONED" };
export type ScheduledMessageExecutionAuditInput = {
  definition: ScheduledMessageDefinition;
  auditId: string;
  occurredAt: Date;
};
export type RetryScheduledMessageExecution = ScheduledMessageExecutionAuditInput & {
  failureCode: ScheduledMessagePreSendRetryFailureCode;
};
export type FailScheduledMessageExecution = ScheduledMessageExecutionAuditInput & {
  failureCode: ScheduledMessageFailureCode;
  resultMessageId: string | null;
};
export type FinalizeScheduledMessageExecution = {
  definition: ScheduledMessageDefinition;
  messageId: string;
  messageCreatedAt: Date;
  managedMessageAuditId: string;
  executionAuditId: string;
  occurredAt: Date;
};
export type ScheduledMessageFinalizationResult = "COMMITTED" | "PROVEN_UNCOMMITTED";
export type ScheduledMessageStatusView = {
  scheduledActionId: string;
  status: ScheduledAction["status"];
  guildId: string;
  channelId: string;
  executeAt: Date;
  creatorUserId: string;
  retryCount: number;
  resultMessageId: string | null;
};
export type ScheduledMessageStatusResult =
  | { outcome: "FOUND"; schedule: ScheduledMessageStatusView }
  | { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" | "CORRUPT" | "UNAVAILABLE" };
export type CancelScheduledMessage = {
  scheduledActionId: string;
  guildId: string;
  channelId: string;
  actorId: string;
  auditId: string;
  occurredAt: Date;
};
export type CancelScheduledMessageResult =
  | { outcome: "CANCELLED" | "ALREADY_CANCELLED"; definition: ScheduledMessageDefinition }
  | { outcome: "EXECUTING" | "COMPLETED" | "FAILED" }
  | { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" | "PERSISTENCE_UNCONFIRMED" };
export type ScheduledMessageStore = {
  create: (input: CreateScheduledMessage) => Promise<ScheduledMessageDefinition>;
  find: (scheduledActionId: string) => Promise<ScheduledMessageDefinition | undefined>;
  findForExecution: (scheduledActionId: string) => Promise<ScheduledMessageExecutionLoadResult>;
  confirmCreation: (input: CreateScheduledMessage) => Promise<ScheduledMessageCreationConfirmation>;
  claimExecution: (scheduledActionId: string) => Promise<ScheduledMessageExecutionClaimTransition>;
  retryPreSendFailure: (
    input: RetryScheduledMessageExecution,
  ) => Promise<ScheduledMessageExecutionTransition>;
  failExecution: (
    input: FailScheduledMessageExecution,
  ) => Promise<ScheduledMessageExecutionTransition>;
  failMissingState: (
    input: FailScheduledMessageMissingState,
  ) => Promise<ScheduledMessageMissingStateTransition>;
  finalizeSuccess: (
    input: FinalizeScheduledMessageExecution,
  ) => Promise<ScheduledMessageFinalizationResult>;
  findStatus: (
    scheduledActionId: string,
    guildId: string,
    channelId: string,
  ) => Promise<ScheduledMessageStatusResult>;
  cancel: (input: CancelScheduledMessage) => Promise<CancelScheduledMessageResult>;
};

export function scheduledMessagePayloadToColumns(
  payload: ManagedMessagePayload,
): ScheduledMessagePayloadColumns {
  return {
    content: payload.content,
    embedTitle: payload.embed?.title ?? null,
    embedDescription: payload.embed?.description ?? null,
    embedColor: payload.embed?.color ?? null,
    embedImageUrl: payload.embed?.imageUrl ?? null,
  };
}

export function scheduledMessagePayloadFromColumns(
  row: ScheduledMessagePayloadColumns,
): ManagedMessagePayload {
  const visible =
    row.embedTitle !== null || row.embedDescription !== null || row.embedImageUrl !== null;
  return {
    content: row.content,
    embed: visible
      ? {
          ...(row.embedTitle === null ? {} : { title: row.embedTitle }),
          ...(row.embedDescription === null ? {} : { description: row.embedDescription }),
          ...(row.embedColor === null ? {} : { color: row.embedColor }),
          ...(row.embedImageUrl === null ? {} : { imageUrl: row.embedImageUrl }),
        }
      : null,
  };
}

function payloadColumnsMatch(
  row: ScheduledMessagePayloadColumns,
  payload: ManagedMessagePayload,
): boolean {
  const expected = scheduledMessagePayloadToColumns(payload);
  return (
    row.content === expected.content &&
    row.embedTitle === expected.embedTitle &&
    row.embedDescription === expected.embedDescription &&
    row.embedColor === expected.embedColor &&
    row.embedImageUrl === expected.embedImageUrl
  );
}

function toDefinition(
  action: ScheduledAction,
  state: ScheduledMessageState,
): ScheduledMessageDefinition {
  return {
    action,
    creatorUserId: state.creatorUserId,
    retryCount: state.retryCount,
    payload: scheduledMessagePayloadFromColumns(state),
    resultMessageId: state.resultMessageId,
  };
}

type ExpectedAudit = {
  id: string;
  definition: ScheduledMessageDefinition;
  event: ScheduledMessageAuditEvent;
  actorType: "USER" | "SYSTEM";
  actorId: string | null;
  outcome: "SUCCESS" | "FAILURE";
  failureCode: ScheduledMessageFailureCode | null;
  resultMessageId: string | null;
  occurredAt: Date;
};

function matchesAudit(audit: ScheduledMessageAudit | undefined, expected: ExpectedAudit): boolean {
  const { action } = expected.definition;
  return (
    audit !== undefined &&
    audit.id === expected.id &&
    audit.scheduledActionId === action.id &&
    audit.guildId === action.guildId &&
    audit.channelId === action.targetId &&
    audit.event === expected.event &&
    audit.actorType === expected.actorType &&
    audit.actorId === expected.actorId &&
    audit.executeAt.getTime() === action.executeAt.getTime() &&
    payloadColumnsMatch(audit, expected.definition.payload) &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === expected.outcome &&
    audit.failureCode === expected.failureCode &&
    audit.resultMessageId === expected.resultMessageId
  );
}

export function matchesScheduledMessageCreation(
  action: ScheduledAction | undefined,
  state: ScheduledMessageState | undefined,
  audit: ScheduledMessageAudit | undefined,
  expected: CreateScheduledMessage,
): boolean {
  if (action === undefined || state === undefined || audit === undefined) return false;
  const definition: ScheduledMessageDefinition = {
    action,
    creatorUserId: state.creatorUserId,
    retryCount: state.retryCount,
    payload: scheduledMessagePayloadFromColumns(state),
    resultMessageId: state.resultMessageId,
  };
  return (
    action.id === expected.scheduledActionId &&
    action.guildId === expected.guildId &&
    action.targetId === expected.channelId &&
    action.actionType === "SEND_MESSAGE" &&
    action.status === "ACTIVE" &&
    action.executeAt.getTime() === expected.executeAt.getTime() &&
    state.scheduledActionId === expected.scheduledActionId &&
    state.creatorUserId === expected.actorId &&
    state.retryCount === 0 &&
    payloadColumnsMatch(state, expected.payload) &&
    state.resultMessageId === null &&
    matchesAudit(audit, {
      id: expected.auditId,
      definition,
      event: "CREATED",
      actorType: "USER",
      actorId: expected.actorId,
      outcome: "SUCCESS",
      failureCode: null,
      resultMessageId: null,
      occurredAt: expected.occurredAt,
    })
  );
}

function definitionMatches(
  actual: ScheduledMessageDefinition | undefined,
  expected: ScheduledMessageDefinition,
  status: ScheduledAction["status"],
  retryCount: number,
  resultMessageId: string | null,
): boolean {
  return (
    actual !== undefined &&
    actual.action.id === expected.action.id &&
    actual.action.actionType === "SEND_MESSAGE" &&
    actual.action.guildId === expected.action.guildId &&
    actual.action.targetId === expected.action.targetId &&
    actual.action.executeAt.getTime() === expected.action.executeAt.getTime() &&
    actual.action.status === status &&
    actual.creatorUserId === expected.creatorUserId &&
    actual.retryCount === retryCount &&
    payloadColumnsMatch(scheduledMessagePayloadToColumns(actual.payload), expected.payload) &&
    actual.resultMessageId === resultMessageId
  );
}

function stateIsValid(state: ScheduledMessageState, status: ScheduledAction["status"]): boolean {
  const payload = validateManagedMessagePayload({
    content: state.content,
    embed: {
      title: state.embedTitle,
      description: state.embedDescription,
      color: state.embedColor,
      imageUrl: state.embedImageUrl,
    },
  });
  return (
    payload.ok &&
    payloadColumnsMatch(state, payload.payload) &&
    state.creatorUserId.length > 0 &&
    Number.isInteger(state.retryCount) &&
    state.retryCount >= 0 &&
    state.retryCount <= 3 &&
    (status === "COMPLETED" ? state.resultMessageId !== null : state.resultMessageId === null)
  );
}

function toStatusView(definition: ScheduledMessageDefinition): ScheduledMessageStatusView {
  return {
    scheduledActionId: definition.action.id,
    status: definition.action.status,
    guildId: definition.action.guildId,
    channelId: definition.action.targetId,
    executeAt: definition.action.executeAt,
    creatorUserId: definition.creatorUserId,
    retryCount: definition.retryCount,
    resultMessageId: definition.resultMessageId,
  };
}

function payloadConditions(payload: ManagedMessagePayload) {
  const flat = scheduledMessagePayloadToColumns(payload);
  return [
    eq(scheduledMessageStates.content, flat.content),
    flat.embedTitle === null
      ? isNull(scheduledMessageStates.embedTitle)
      : eq(scheduledMessageStates.embedTitle, flat.embedTitle),
    flat.embedDescription === null
      ? isNull(scheduledMessageStates.embedDescription)
      : eq(scheduledMessageStates.embedDescription, flat.embedDescription),
    flat.embedColor === null
      ? isNull(scheduledMessageStates.embedColor)
      : eq(scheduledMessageStates.embedColor, flat.embedColor),
    flat.embedImageUrl === null
      ? isNull(scheduledMessageStates.embedImageUrl)
      : eq(scheduledMessageStates.embedImageUrl, flat.embedImageUrl),
  ];
}

export function createScheduledMessageStore(database: DatabaseClient): ScheduledMessageStore {
  const findScoped = async (scheduledActionId: string, guildId: string, channelId: string) => {
    const [result] = await database
      .select({ action: scheduledActions, state: scheduledMessageStates })
      .from(scheduledActions)
      .leftJoin(
        scheduledMessageStates,
        eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
      )
      .where(
        and(
          eq(scheduledActions.id, scheduledActionId),
          eq(scheduledActions.guildId, guildId),
          eq(scheduledActions.targetId, channelId),
          eq(scheduledActions.actionType, "SEND_MESSAGE"),
        ),
      )
      .limit(1);
    return result;
  };
  const findForExecution = async (
    scheduledActionId: string,
  ): Promise<ScheduledMessageExecutionLoadResult> => {
    const [result] = await database
      .select({ action: scheduledActions, state: scheduledMessageStates })
      .from(scheduledActions)
      .leftJoin(
        scheduledMessageStates,
        eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
      )
      .where(eq(scheduledActions.id, scheduledActionId))
      .limit(1);
    if (result === undefined) return { outcome: "MISSING_ACTION" };
    if (result.action.actionType !== "SEND_MESSAGE") return { outcome: "ACTION_TYPE_MISMATCH" };
    if (result.state === null) return { outcome: "STATE_MISSING", action: result.action };
    return { outcome: "FOUND", definition: toDefinition(result.action, result.state) };
  };
  const find = async (
    scheduledActionId: string,
  ): Promise<ScheduledMessageDefinition | undefined> => {
    const result = await findForExecution(scheduledActionId);
    return result.outcome === "FOUND" ? result.definition : undefined;
  };
  const findAudit = async (id: string): Promise<ScheduledMessageAudit | undefined> => {
    const [audit] = await database
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.id, id))
      .limit(1);
    return audit;
  };
  const cancellationAuditMatches = (
    audit: ScheduledMessageAudit | undefined,
    definition: ScheduledMessageDefinition,
    expected?: Pick<CancelScheduledMessage, "auditId" | "actorId" | "occurredAt">,
  ): boolean =>
    audit !== undefined &&
    audit.event === "CANCELLED" &&
    audit.actorId !== null &&
    matchesAudit(audit, {
      id: expected?.auditId ?? audit.id,
      definition,
      event: "CANCELLED",
      actorType: "USER",
      actorId: expected?.actorId ?? audit.actorId,
      outcome: "SUCCESS",
      failureCode: null,
      resultMessageId: null,
      occurredAt: expected?.occurredAt ?? audit.occurredAt,
    });
  const findMatchingCancellationAudit = async (
    definition: ScheduledMessageDefinition,
  ): Promise<ScheduledMessageAudit | undefined> => {
    const audits = await database
      .select()
      .from(scheduledMessageAudits)
      .where(
        and(
          eq(scheduledMessageAudits.scheduledActionId, definition.action.id),
          eq(scheduledMessageAudits.guildId, definition.action.guildId),
          eq(scheduledMessageAudits.channelId, definition.action.targetId),
          eq(scheduledMessageAudits.event, "CANCELLED"),
          eq(scheduledMessageAudits.actorType, "USER"),
          sql`${scheduledMessageAudits.actorId} is not null`,
          eq(scheduledMessageAudits.executeAt, definition.action.executeAt),
          eq(scheduledMessageAudits.outcome, "SUCCESS"),
          isNull(scheduledMessageAudits.failureCode),
          isNull(scheduledMessageAudits.resultMessageId),
        ),
      );
    return audits.find((audit) => cancellationAuditMatches(audit, definition));
  };
  const confirmCancellation = async (
    input: CancelScheduledMessage,
  ): Promise<CancelScheduledMessageResult> => {
    const scoped = await findScoped(input.scheduledActionId, input.guildId, input.channelId);
    if (scoped === undefined || scoped.state === null)
      return { outcome: "PERSISTENCE_UNCONFIRMED" };
    const definition = toDefinition(scoped.action, scoped.state);
    if (
      !stateIsValid(scoped.state, scoped.action.status) ||
      definition.action.status !== "CANCELLED"
    )
      return { outcome: "PERSISTENCE_UNCONFIRMED" };
    const ownAudit = await findAudit(input.auditId);
    if (cancellationAuditMatches(ownAudit, definition, input)) {
      return { outcome: "CANCELLED", definition };
    }
    const previousAudit = await findMatchingCancellationAudit(definition);
    return previousAudit === undefined
      ? { outcome: "PERSISTENCE_UNCONFIRMED" }
      : { outcome: "ALREADY_CANCELLED", definition };
  };
  const confirmCreation = async (
    input: CreateScheduledMessage,
  ): Promise<ScheduledMessageCreationConfirmation> => {
    const [action, state, audit] = await Promise.all([
      database
        .select()
        .from(scheduledActions)
        .where(eq(scheduledActions.id, input.scheduledActionId))
        .limit(1)
        .then((rows) => rows[0]),
      database
        .select()
        .from(scheduledMessageStates)
        .where(eq(scheduledMessageStates.scheduledActionId, input.scheduledActionId))
        .limit(1)
        .then((rows) => rows[0]),
      findAudit(input.auditId),
    ]);
    if (action === undefined && state === undefined && audit === undefined)
      return { outcome: "MISSING" };
    if (!matchesScheduledMessageCreation(action, state, audit, input))
      return { outcome: "CONFLICT" };
    return { outcome: "MATCH", definition: toDefinition(action!, state!) };
  };
  const confirmTransition = async (
    expected: ScheduledMessageDefinition,
    audit: ExpectedAudit,
    status: ScheduledAction["status"],
    retryCount: number,
  ): Promise<ScheduledMessageExecutionTransition | undefined> => {
    const [definition, persistedAudit] = await Promise.all([
      find(expected.action.id),
      findAudit(audit.id),
    ]);
    return definitionMatches(definition, expected, status, retryCount, null) &&
      matchesAudit(persistedAudit, audit)
      ? { outcome: "COMMITTED", definition: definition! }
      : undefined;
  };
  const applyFailureTransition = async (
    input: RetryScheduledMessageExecution | FailScheduledMessageExecution,
    retry: boolean,
  ): Promise<ScheduledMessageExecutionTransition> => {
    const expectedRetryCount = retry
      ? input.definition.retryCount + 1
      : input.definition.retryCount;
    const nextStatus = retry ? "ACTIVE" : "FAILED";
    const audit: ExpectedAudit = {
      id: input.auditId,
      definition: input.definition,
      event: retry ? "EXECUTION_RETRY" : "EXECUTION_FAILED",
      actorType: "SYSTEM",
      actorId: null,
      outcome: "FAILURE",
      failureCode: input.failureCode,
      resultMessageId: retry ? null : (input as FailScheduledMessageExecution).resultMessageId,
      occurredAt: input.occurredAt,
    };
    try {
      return await database.transaction(async (transaction) => {
        const [transitioned] = await transaction
          .update(scheduledActions)
          .set({ status: nextStatus, updatedAt: new Date() })
          .where(
            and(
              eq(scheduledActions.id, input.definition.action.id),
              eq(scheduledActions.actionType, "SEND_MESSAGE"),
              eq(scheduledActions.status, "EXECUTING"),
            ),
          )
          .returning();
        if (transitioned === undefined)
          return { outcome: "NOT_TRANSITIONED", current: await find(input.definition.action.id) };
        if (retry) {
          const [updatedState] = await transaction
            .update(scheduledMessageStates)
            .set({ retryCount: expectedRetryCount })
            .where(
              and(
                eq(scheduledMessageStates.scheduledActionId, input.definition.action.id),
                eq(scheduledMessageStates.retryCount, input.definition.retryCount),
                sql`${scheduledMessageStates.retryCount} < 3`,
                isNull(scheduledMessageStates.resultMessageId),
              ),
            )
            .returning();
          if (updatedState === undefined) throw new Error("Scheduled message retry count changed");
        }
        await transaction.insert(scheduledMessageAudits).values({
          id: audit.id,
          scheduledActionId: transitioned.id,
          guildId: transitioned.guildId,
          channelId: transitioned.targetId,
          event: audit.event,
          actorType: "SYSTEM",
          executeAt: transitioned.executeAt,
          ...scheduledMessagePayloadToColumns(input.definition.payload),
          occurredAt: audit.occurredAt,
          outcome: "FAILURE",
          failureCode: audit.failureCode,
          resultMessageId: audit.resultMessageId,
        });
        return {
          outcome: "COMMITTED",
          definition: { ...input.definition, action: transitioned, retryCount: expectedRetryCount },
        };
      });
    } catch (error) {
      try {
        const confirmed = await confirmTransition(
          input.definition,
          audit,
          nextStatus,
          expectedRetryCount,
        );
        if (confirmed !== undefined) return confirmed;
      } catch {
        /* exact confirmation unreadable */
      }
      throw error;
    }
  };
  const managedCreationMatches = (
    input: FinalizeScheduledMessageExecution,
    message: typeof managedMessages.$inferSelect | null,
    audit: typeof managedMessageAudits.$inferSelect | null,
  ): boolean => {
    const flat = scheduledMessagePayloadToColumns(input.definition.payload);
    return (
      message !== null &&
      audit !== null &&
      audit !== undefined &&
      message.guildId === input.definition.action.guildId &&
      message.channelId === input.definition.action.targetId &&
      message.creatorUserId === input.definition.creatorUserId &&
      payloadColumnsMatch(message, input.definition.payload) &&
      message.revision === 1 &&
      message.status === "ACTIVE" &&
      message.createdAt.getTime() === input.messageCreatedAt.getTime() &&
      audit.id === input.managedMessageAuditId &&
      audit.messageId === input.messageId &&
      audit.guildId === input.definition.action.guildId &&
      audit.channelId === input.definition.action.targetId &&
      audit.event === "CREATED" &&
      audit.actorType === "USER" &&
      audit.actorId === input.definition.creatorUserId &&
      audit.beforeContent === null &&
      audit.afterContent === flat.content &&
      audit.beforeEmbedTitle === null &&
      audit.afterEmbedTitle === flat.embedTitle &&
      audit.beforeEmbedDescription === null &&
      audit.afterEmbedDescription === flat.embedDescription &&
      audit.beforeEmbedColor === null &&
      audit.afterEmbedColor === flat.embedColor &&
      audit.beforeEmbedImageUrl === null &&
      audit.afterEmbedImageUrl === flat.embedImageUrl &&
      audit.beforeRevision === null &&
      audit.afterRevision === 1 &&
      audit.beforeStatus === null &&
      audit.afterStatus === "ACTIVE" &&
      audit.occurredAt.getTime() === input.messageCreatedAt.getTime() &&
      audit.outcome === "SUCCESS"
    );
  };
  const confirmSuccessfulFinalization = async (
    input: FinalizeScheduledMessageExecution,
  ): Promise<ScheduledMessageFinalizationResult | undefined> => {
    // One statement supplies a coherent observation for both committed and proven-uncommitted
    // classification. Mixing separate reads could otherwise race with a concurrent commit.
    const [persisted] = await database
      .select({
        action: scheduledActions,
        state: scheduledMessageStates,
        executionAudit: scheduledMessageAudits,
        message: managedMessages,
        managedAudit: managedMessageAudits,
      })
      .from(scheduledActions)
      .innerJoin(
        scheduledMessageStates,
        eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
      )
      .leftJoin(scheduledMessageAudits, eq(scheduledMessageAudits.id, input.executionAuditId))
      .leftJoin(managedMessages, eq(managedMessages.messageId, input.messageId))
      .leftJoin(managedMessageAudits, eq(managedMessageAudits.id, input.managedMessageAuditId))
      .where(eq(scheduledActions.id, input.definition.action.id))
      .limit(1);
    const definition =
      persisted === undefined ? undefined : toDefinition(persisted.action, persisted.state);
    const executionAudit = persisted?.executionAudit ?? undefined;
    if (
      definitionMatches(
        definition,
        input.definition,
        "COMPLETED",
        input.definition.retryCount,
        input.messageId,
      ) &&
      matchesAudit(executionAudit, {
        id: input.executionAuditId,
        definition: input.definition,
        event: "EXECUTION_COMPLETED",
        actorType: "SYSTEM",
        actorId: null,
        outcome: "SUCCESS",
        failureCode: null,
        resultMessageId: input.messageId,
        occurredAt: input.occurredAt,
      }) &&
      persisted !== undefined &&
      managedCreationMatches(input, persisted.message, persisted.managedAudit)
    )
      return "COMMITTED";
    if (
      definitionMatches(
        definition,
        input.definition,
        "EXECUTING",
        input.definition.retryCount,
        null,
      ) &&
      executionAudit === undefined &&
      persisted?.message === null &&
      persisted.managedAudit === null
    )
      return "PROVEN_UNCOMMITTED";
    return undefined;
  };
  const findCreationAuditSources = (action: ScheduledAction) =>
    database
      .select()
      .from(scheduledMessageAudits)
      .where(
        and(
          eq(scheduledMessageAudits.scheduledActionId, action.id),
          eq(scheduledMessageAudits.guildId, action.guildId),
          eq(scheduledMessageAudits.channelId, action.targetId),
          eq(scheduledMessageAudits.executeAt, action.executeAt),
          eq(scheduledMessageAudits.event, "CREATED"),
          eq(scheduledMessageAudits.actorType, "USER"),
          sql`${scheduledMessageAudits.actorId} is not null`,
          eq(scheduledMessageAudits.outcome, "SUCCESS"),
          isNull(scheduledMessageAudits.failureCode),
          isNull(scheduledMessageAudits.resultMessageId),
        ),
      )
      .limit(2);
  const confirmMissingStateFailure = async (
    input: FailScheduledMessageMissingState,
  ): Promise<boolean> => {
    const [load, sources, audit] = await Promise.all([
      findForExecution(input.action.id),
      findCreationAuditSources(input.action),
      findAudit(input.auditId),
    ]);
    if (
      load.outcome !== "STATE_MISSING" ||
      load.action.status !== "FAILED" ||
      load.action.guildId !== input.action.guildId ||
      load.action.targetId !== input.action.targetId ||
      load.action.executeAt.getTime() !== input.action.executeAt.getTime() ||
      sources.length !== 1
    ) {
      return false;
    }
    const source = sources[0]!;
    return matchesAudit(audit, {
      id: input.auditId,
      definition: {
        action: input.action,
        creatorUserId: source.actorId!,
        retryCount: 0,
        payload: scheduledMessagePayloadFromColumns(source),
        resultMessageId: null,
      },
      event: "EXECUTION_FAILED",
      actorType: "SYSTEM",
      actorId: null,
      outcome: "FAILURE",
      failureCode: "PERSISTED_PAYLOAD_INVALID",
      resultMessageId: null,
      occurredAt: input.occurredAt,
    });
  };

  return {
    async create(input) {
      try {
        return await database.transaction(async (transaction) => {
          const [action] = await transaction
            .insert(scheduledActions)
            .values({
              id: input.scheduledActionId,
              guildId: input.guildId,
              actionType: "SEND_MESSAGE",
              targetId: input.channelId,
              status: "ACTIVE",
              executeAt: input.executeAt,
            })
            .returning();
          if (action === undefined)
            throw new Error("Scheduled message action could not be created");
          const [state] = await transaction
            .insert(scheduledMessageStates)
            .values({
              scheduledActionId: input.scheduledActionId,
              creatorUserId: input.actorId,
              retryCount: 0,
              ...scheduledMessagePayloadToColumns(input.payload),
              resultMessageId: null,
            })
            .returning();
          if (state === undefined) throw new Error("Scheduled message state could not be created");
          await transaction.insert(scheduledMessageAudits).values({
            id: input.auditId,
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
            event: "CREATED",
            actorType: "USER",
            actorId: input.actorId,
            executeAt: input.executeAt,
            ...scheduledMessagePayloadToColumns(input.payload),
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
          });
          return toDefinition(action, state);
        });
      } catch (error) {
        try {
          const confirmation = await confirmCreation(input);
          if (confirmation.outcome === "MATCH") return confirmation.definition;
        } catch {
          /* preserve original error */
        }
        throw error;
      }
    },
    find,
    findForExecution,
    confirmCreation,
    async claimExecution(scheduledActionId) {
      const [transitioned] = await database
        .update(scheduledActions)
        .set({ status: "EXECUTING", updatedAt: new Date() })
        .where(
          and(
            eq(scheduledActions.id, scheduledActionId),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
            eq(scheduledActions.status, "ACTIVE"),
          ),
        )
        .returning();
      if (transitioned === undefined)
        return { outcome: "NOT_TRANSITIONED", current: await find(scheduledActionId) };
      const current = await find(scheduledActionId);
      if (current === undefined)
        return { outcome: "COMMITTED_STATE_MISSING", action: transitioned };
      return { outcome: "COMMITTED", definition: current };
    },
    retryPreSendFailure(input) {
      return applyFailureTransition(input, true);
    },
    failExecution(input) {
      return applyFailureTransition(input, false);
    },
    async failMissingState(input) {
      try {
        return await database.transaction(async (transaction) => {
          const [transitioned] = await transaction
            .update(scheduledActions)
            .set({ status: "FAILED", updatedAt: new Date() })
            .where(
              and(
                eq(scheduledActions.id, input.action.id),
                eq(scheduledActions.actionType, "SEND_MESSAGE"),
                eq(scheduledActions.status, "EXECUTING"),
              ),
            )
            .returning();
          if (transitioned === undefined) return { outcome: "NOT_TRANSITIONED" };

          const [state, sources] = await Promise.all([
            transaction
              .select({ id: scheduledMessageStates.scheduledActionId })
              .from(scheduledMessageStates)
              .where(eq(scheduledMessageStates.scheduledActionId, input.action.id))
              .limit(1)
              .then((rows) => rows[0]),
            transaction
              .select()
              .from(scheduledMessageAudits)
              .where(
                and(
                  eq(scheduledMessageAudits.scheduledActionId, input.action.id),
                  eq(scheduledMessageAudits.guildId, input.action.guildId),
                  eq(scheduledMessageAudits.channelId, input.action.targetId),
                  eq(scheduledMessageAudits.executeAt, input.action.executeAt),
                  eq(scheduledMessageAudits.event, "CREATED"),
                  eq(scheduledMessageAudits.actorType, "USER"),
                  sql`${scheduledMessageAudits.actorId} is not null`,
                  eq(scheduledMessageAudits.outcome, "SUCCESS"),
                  isNull(scheduledMessageAudits.failureCode),
                  isNull(scheduledMessageAudits.resultMessageId),
                ),
              )
              .limit(2),
          ]);
          if (state !== undefined || sources.length !== 1) {
            throw new Error("Scheduled message missing-state evidence is invalid");
          }
          const source = sources[0]!;
          await transaction.insert(scheduledMessageAudits).values({
            id: input.auditId,
            scheduledActionId: transitioned.id,
            guildId: transitioned.guildId,
            channelId: transitioned.targetId,
            event: "EXECUTION_FAILED",
            actorType: "SYSTEM",
            actorId: null,
            executeAt: transitioned.executeAt,
            content: source.content,
            embedTitle: source.embedTitle,
            embedDescription: source.embedDescription,
            embedColor: source.embedColor,
            embedImageUrl: source.embedImageUrl,
            occurredAt: input.occurredAt,
            outcome: "FAILURE",
            failureCode: "PERSISTED_PAYLOAD_INVALID",
            resultMessageId: null,
          });
          return { outcome: "COMMITTED" };
        });
      } catch (error) {
        try {
          if (await confirmMissingStateFailure(input)) return { outcome: "COMMITTED" };
        } catch {
          /* exact confirmation unreadable */
        }
        throw error;
      }
    },
    async finalizeSuccess(input) {
      const managedCreation: CreateManagedMessage = {
        auditId: input.managedMessageAuditId,
        messageId: input.messageId,
        guildId: input.definition.action.guildId,
        channelId: input.definition.action.targetId,
        creatorUserId: input.definition.creatorUserId,
        payload: input.definition.payload,
        createdAt: input.messageCreatedAt,
      };
      try {
        const committed = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .update(scheduledActions)
            .set({ status: "COMPLETED", updatedAt: new Date() })
            .where(
              and(
                eq(scheduledActions.id, input.definition.action.id),
                eq(scheduledActions.actionType, "SEND_MESSAGE"),
                eq(scheduledActions.status, "EXECUTING"),
              ),
            )
            .returning();
          if (action === undefined) {
            throw new Error("Scheduled message successful finalization lost execution ownership");
          }
          const [state] = await transaction
            .update(scheduledMessageStates)
            .set({ resultMessageId: input.messageId })
            .where(
              and(
                eq(scheduledMessageStates.scheduledActionId, input.definition.action.id),
                eq(scheduledMessageStates.creatorUserId, input.definition.creatorUserId),
                eq(scheduledMessageStates.retryCount, input.definition.retryCount),
                isNull(scheduledMessageStates.resultMessageId),
                ...payloadConditions(input.definition.payload),
              ),
            )
            .returning();
          if (state === undefined) throw new Error("Scheduled message finalization state changed");
          await insertManagedMessageCreation(transaction, managedCreation);
          await transaction.insert(scheduledMessageAudits).values({
            id: input.executionAuditId,
            scheduledActionId: action.id,
            guildId: action.guildId,
            channelId: action.targetId,
            event: "EXECUTION_COMPLETED",
            actorType: "SYSTEM",
            executeAt: action.executeAt,
            ...scheduledMessagePayloadToColumns(input.definition.payload),
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
            resultMessageId: input.messageId,
          });
          return true;
        });
        return committed ? "COMMITTED" : "PROVEN_UNCOMMITTED";
      } catch (error) {
        try {
          const confirmation = await confirmSuccessfulFinalization(input);
          if (confirmation !== undefined) return confirmation;
        } catch {
          /* commit status remains unknown */
        }
        throw error;
      }
    },
    async findStatus(scheduledActionId, guildId, channelId) {
      try {
        const scoped = await findScoped(scheduledActionId, guildId, channelId);
        if (scoped === undefined) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" };
        if (scoped.state === null) return { outcome: "CORRUPT" };
        const definition = toDefinition(scoped.action, scoped.state);
        return stateIsValid(scoped.state, scoped.action.status)
          ? { outcome: "FOUND", schedule: toStatusView(definition) }
          : { outcome: "CORRUPT" };
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
    },
    async cancel(input) {
      try {
        return await database.transaction(async (transaction) => {
          const [scoped] = await transaction
            .select({ action: scheduledActions, state: scheduledMessageStates })
            .from(scheduledActions)
            .leftJoin(
              scheduledMessageStates,
              eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
            )
            .where(
              and(
                eq(scheduledActions.id, input.scheduledActionId),
                eq(scheduledActions.guildId, input.guildId),
                eq(scheduledActions.targetId, input.channelId),
                eq(scheduledActions.actionType, "SEND_MESSAGE"),
              ),
            )
            .limit(1);
          if (scoped === undefined) return { outcome: "NOT_FOUND_OR_WRONG_CONTEXT" } as const;
          if (scoped.state === null) return { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
          const definition = toDefinition(scoped.action, scoped.state);
          if (!stateIsValid(scoped.state, scoped.action.status))
            return { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
          if (definition.action.status === "CANCELLED") {
            const previousAudit = await transaction
              .select()
              .from(scheduledMessageAudits)
              .where(
                and(
                  eq(scheduledMessageAudits.scheduledActionId, definition.action.id),
                  eq(scheduledMessageAudits.event, "CANCELLED"),
                ),
              );
            return previousAudit.some((audit) => cancellationAuditMatches(audit, definition))
              ? ({ outcome: "ALREADY_CANCELLED", definition } as const)
              : ({ outcome: "PERSISTENCE_UNCONFIRMED" } as const);
          }
          if (definition.action.status !== "ACTIVE") {
            return { outcome: definition.action.status };
          }

          const [cancelled] = await transaction
            .update(scheduledActions)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(
              and(
                eq(scheduledActions.id, input.scheduledActionId),
                eq(scheduledActions.guildId, input.guildId),
                eq(scheduledActions.targetId, input.channelId),
                eq(scheduledActions.actionType, "SEND_MESSAGE"),
                eq(scheduledActions.status, "ACTIVE"),
              ),
            )
            .returning();
          if (cancelled === undefined) {
            const [current] = await transaction
              .select({ status: scheduledActions.status })
              .from(scheduledActions)
              .where(
                and(
                  eq(scheduledActions.id, input.scheduledActionId),
                  eq(scheduledActions.guildId, input.guildId),
                  eq(scheduledActions.targetId, input.channelId),
                  eq(scheduledActions.actionType, "SEND_MESSAGE"),
                ),
              )
              .limit(1);
            if (
              current?.status === "EXECUTING" ||
              current?.status === "COMPLETED" ||
              current?.status === "FAILED"
            ) {
              return { outcome: current.status };
            }
            if (current?.status === "CANCELLED") {
              const previousAudits = await transaction
                .select()
                .from(scheduledMessageAudits)
                .where(
                  and(
                    eq(scheduledMessageAudits.scheduledActionId, definition.action.id),
                    eq(scheduledMessageAudits.event, "CANCELLED"),
                  ),
                );
              return previousAudits.some((audit) => cancellationAuditMatches(audit, definition))
                ? ({ outcome: "ALREADY_CANCELLED", definition } as const)
                : ({ outcome: "PERSISTENCE_UNCONFIRMED" } as const);
            }
            return { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
          }
          await transaction.insert(scheduledMessageAudits).values({
            id: input.auditId,
            scheduledActionId: cancelled.id,
            guildId: cancelled.guildId,
            channelId: cancelled.targetId,
            event: "CANCELLED",
            actorType: "USER",
            actorId: input.actorId,
            executeAt: cancelled.executeAt,
            ...scheduledMessagePayloadToColumns(definition.payload),
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
            failureCode: null,
            resultMessageId: null,
          });
          return {
            outcome: "CANCELLED",
            definition: { ...definition, action: cancelled },
          } as const;
        });
      } catch {
        try {
          return await confirmCancellation(input);
        } catch {
          return { outcome: "PERSISTENCE_UNCONFIRMED" };
        }
      }
    },
  };
}
