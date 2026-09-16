import { and, eq, sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import type { ManagedMessagePayload } from "./managed-message-payload.js";
import { scheduledActions, type ScheduledAction } from "./scheduled-action-persistence.js";

export const scheduledMessageStates = pgTable(
  "scheduled_message_states",
  {
    scheduledActionId: text("scheduled_action_id")
      .primaryKey()
      .references(() => scheduledActions.id),
    content: text("content").notNull(),
    embedTitle: text("embed_title"),
    embedDescription: text("embed_description"),
    embedColor: integer("embed_color"),
    embedImageUrl: text("embed_image_url"),
    resultMessageId: text("result_message_id"),
  },
  (table) => [
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
    event: text("event").$type<"CREATED">().notNull(),
    actorType: text("actor_type").$type<"USER">().notNull(),
    actorId: text("actor_id").notNull(),
    executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
    content: text("content").notNull(),
    embedTitle: text("embed_title"),
    embedDescription: text("embed_description"),
    embedColor: integer("embed_color"),
    embedImageUrl: text("embed_image_url"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<"SUCCESS">().notNull(),
  },
  (table) => [
    check("scheduled_message_audits_event_check", sql`${table.event} = 'CREATED'`),
    check("scheduled_message_audits_actor_type_check", sql`${table.actorType} = 'USER'`),
    check("scheduled_message_audits_outcome_check", sql`${table.outcome} = 'SUCCESS'`),
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
  payload: ManagedMessagePayload;
  resultMessageId: string | null;
};

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

export type ScheduledMessageStore = {
  create: (input: CreateScheduledMessage) => Promise<ScheduledMessageDefinition>;
  find: (scheduledActionId: string) => Promise<ScheduledMessageDefinition | undefined>;
  confirmCreation: (input: CreateScheduledMessage) => Promise<ScheduledMessageCreationConfirmation>;
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

export function matchesScheduledMessageCreation(
  action: ScheduledAction | undefined,
  state: ScheduledMessageState | undefined,
  audit: ScheduledMessageAudit | undefined,
  expected: CreateScheduledMessage,
): boolean {
  return (
    action !== undefined &&
    state !== undefined &&
    audit !== undefined &&
    action.id === expected.scheduledActionId &&
    action.guildId === expected.guildId &&
    action.targetId === expected.channelId &&
    action.actionType === "SEND_MESSAGE" &&
    action.status === "ACTIVE" &&
    action.executeAt.getTime() === expected.executeAt.getTime() &&
    state.scheduledActionId === expected.scheduledActionId &&
    payloadColumnsMatch(state, expected.payload) &&
    state.resultMessageId === null &&
    audit.id === expected.auditId &&
    audit.scheduledActionId === expected.scheduledActionId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "CREATED" &&
    audit.actorType === "USER" &&
    audit.actorId === expected.actorId &&
    audit.executeAt.getTime() === expected.executeAt.getTime() &&
    payloadColumnsMatch(audit, expected.payload) &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function toDefinition(
  action: ScheduledAction,
  state: ScheduledMessageState,
): ScheduledMessageDefinition {
  return {
    action,
    payload: scheduledMessagePayloadFromColumns(state),
    resultMessageId: state.resultMessageId,
  };
}

export function createScheduledMessageStore(database: DatabaseClient): ScheduledMessageStore {
  const readCreation = async (input: CreateScheduledMessage) => {
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
      database
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, input.auditId))
        .limit(1)
        .then((rows) => rows[0]),
    ]);
    return { action, state, audit };
  };

  const confirmCreation = async (
    input: CreateScheduledMessage,
  ): Promise<ScheduledMessageCreationConfirmation> => {
    const persisted = await readCreation(input);
    if (
      persisted.action === undefined &&
      persisted.state === undefined &&
      persisted.audit === undefined
    ) {
      return { outcome: "MISSING" };
    }
    if (
      persisted.action === undefined ||
      persisted.state === undefined ||
      persisted.audit === undefined ||
      !matchesScheduledMessageCreation(persisted.action, persisted.state, persisted.audit, input)
    ) {
      return { outcome: "CONFLICT" };
    }
    return {
      outcome: "MATCH",
      definition: toDefinition(persisted.action, persisted.state),
    };
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
          if (action === undefined) {
            throw new Error("Scheduled message action could not be created");
          }

          const [state] = await transaction
            .insert(scheduledMessageStates)
            .values({
              scheduledActionId: input.scheduledActionId,
              ...scheduledMessagePayloadToColumns(input.payload),
              resultMessageId: null,
            })
            .returning();
          if (state === undefined) {
            throw new Error("Scheduled message state could not be created");
          }

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
          // Preserve the original transaction error when confirmation cannot be read.
        }
        throw error;
      }
    },
    async find(scheduledActionId) {
      const [result] = await database
        .select({ action: scheduledActions, state: scheduledMessageStates })
        .from(scheduledActions)
        .innerJoin(
          scheduledMessageStates,
          eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
        )
        .where(
          and(
            eq(scheduledActions.id, scheduledActionId),
            eq(scheduledActions.actionType, "SEND_MESSAGE"),
          ),
        )
        .limit(1);
      return result === undefined ? undefined : toDefinition(result.action, result.state);
    },
    confirmCreation,
  };
}
