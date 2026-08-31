import { and, eq, sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";

export const MANAGED_MESSAGE_STATUSES = ["ACTIVE", "DELETED"] as const;
export type ManagedMessageStatus = (typeof MANAGED_MESSAGE_STATUSES)[number];
export const MANAGED_MESSAGE_AUDIT_EVENTS = ["CREATED", "EDITED", "DELETION_DETECTED"] as const;
export type ManagedMessageAuditEvent = (typeof MANAGED_MESSAGE_AUDIT_EVENTS)[number];
export type ManagedMessageAuditActorType = "USER" | "SYSTEM";

export const managedMessages = pgTable(
  "managed_messages",
  {
    messageId: text("message_id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    content: text("content").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<ManagedMessageStatus>().notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("managed_messages_revision_check", sql`${table.revision} >= 1`),
    check("managed_messages_status_check", sql`${table.status} in ('ACTIVE', 'DELETED')`),
    check(
      "managed_messages_content_length_check",
      sql`char_length(${table.content}) between 1 and 2000`,
    ),
  ],
);

export const managedMessageAudits = pgTable(
  "managed_message_audits",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").notNull(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    event: text("event").$type<ManagedMessageAuditEvent>().notNull(),
    actorType: text("actor_type").$type<ManagedMessageAuditActorType>().notNull(),
    actorId: text("actor_id"),
    beforeContent: text("before_content"),
    afterContent: text("after_content").notNull(),
    beforeRevision: integer("before_revision"),
    afterRevision: integer("after_revision").notNull(),
    beforeStatus: text("before_status").$type<ManagedMessageStatus>(),
    afterStatus: text("after_status").$type<ManagedMessageStatus>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<"SUCCESS">().notNull(),
  },
  (table) => [
    check(
      "managed_message_audits_event_check",
      sql`${table.event} in ('CREATED', 'EDITED', 'DELETION_DETECTED')`,
    ),
    check("managed_message_audits_actor_type_check", sql`${table.actorType} in ('USER', 'SYSTEM')`),
    check("managed_message_audits_outcome_check", sql`${table.outcome} = 'SUCCESS'`),
    check(
      "managed_message_audits_revision_check",
      sql`${table.afterRevision} >= 1 and (${table.beforeRevision} is null or ${table.beforeRevision} >= 1)`,
    ),
    check(
      "managed_message_audits_status_check",
      sql`${table.afterStatus} in ('ACTIVE', 'DELETED') and (${table.beforeStatus} is null or ${table.beforeStatus} in ('ACTIVE', 'DELETED'))`,
    ),
    check(
      "managed_message_audits_content_length_check",
      sql`char_length(${table.afterContent}) between 1 and 2000 and (${table.beforeContent} is null or char_length(${table.beforeContent}) between 1 and 2000)`,
    ),
    check(
      "managed_message_audits_event_shape_check",
      sql`(
        ${table.event} = 'CREATED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.beforeContent} is null and ${table.beforeRevision} is null and ${table.beforeStatus} is null
        and ${table.afterRevision} = 1 and ${table.afterStatus} = 'ACTIVE'
      ) or (
        ${table.event} = 'EDITED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.beforeContent} is not null and ${table.beforeRevision} is not null
        and ${table.beforeStatus} = 'ACTIVE' and ${table.afterStatus} = 'ACTIVE'
        and ${table.afterRevision} = ${table.beforeRevision} + 1
        and ${table.afterContent} <> ${table.beforeContent}
      ) or (
        ${table.event} = 'DELETION_DETECTED'
        and ${table.actorType} = 'SYSTEM' and ${table.actorId} is null
        and ${table.beforeContent} is not null and ${table.beforeRevision} is not null
        and ${table.beforeStatus} = 'ACTIVE' and ${table.afterStatus} = 'DELETED'
        and ${table.afterRevision} = ${table.beforeRevision}
        and ${table.afterContent} = ${table.beforeContent}
      )`,
    ),
  ],
);

export type ManagedMessage = typeof managedMessages.$inferSelect;
export type ManagedMessageAudit = typeof managedMessageAudits.$inferSelect;

export type CreateManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  creatorUserId: string;
  content: string;
  createdAt: Date;
};
export type EditManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  actorUserId: string;
  expectedRevision: number;
  previousContent: string;
  content: string;
  occurredAt: Date;
};
export type DeleteManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  expectedRevision: number;
  content: string;
  occurredAt: Date;
};

export type ManagedMessageConfirmation = "MATCH" | "MISSING" | "CONFLICT";
export type ManagedMessageTransitionResult = "TRANSITIONED" | "NOT_TRANSITIONED";
export type ManagedMessageCompensationSafety = "SAFE" | "UNSAFE";

export type ManagedMessageStore = {
  find: (messageId: string) => Promise<ManagedMessage | undefined>;
  create: (input: CreateManagedMessage) => Promise<ManagedMessage>;
  confirmCreation: (input: CreateManagedMessage) => Promise<ManagedMessageConfirmation>;
  edit: (input: EditManagedMessage) => Promise<ManagedMessageTransitionResult>;
  confirmEdit: (input: EditManagedMessage) => Promise<ManagedMessageConfirmation>;
  markDeleted: (input: DeleteManagedMessage) => Promise<ManagedMessageTransitionResult>;
  confirmDeletion: (input: DeleteManagedMessage) => Promise<ManagedMessageConfirmation>;
  readCompensationSafety: (input: EditManagedMessage) => Promise<ManagedMessageCompensationSafety>;
};

function matchesCreation(
  existing: ManagedMessage | undefined,
  audit: ManagedMessageAudit | undefined,
  expected: CreateManagedMessage,
): boolean {
  return (
    existing !== undefined &&
    audit !== undefined &&
    existing.messageId === expected.messageId &&
    existing.guildId === expected.guildId &&
    existing.channelId === expected.channelId &&
    existing.creatorUserId === expected.creatorUserId &&
    existing.content === expected.content &&
    existing.revision === 1 &&
    existing.status === "ACTIVE" &&
    existing.createdAt.getTime() === expected.createdAt.getTime() &&
    audit.id === expected.auditId &&
    audit.messageId === expected.messageId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "CREATED" &&
    audit.actorType === "USER" &&
    audit.actorId === expected.creatorUserId &&
    audit.beforeContent === null &&
    audit.afterContent === expected.content &&
    audit.beforeRevision === null &&
    audit.afterRevision === 1 &&
    audit.beforeStatus === null &&
    audit.afterStatus === "ACTIVE" &&
    audit.occurredAt.getTime() === expected.createdAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function matchesEdit(
  existing: ManagedMessage | undefined,
  audit: ManagedMessageAudit | undefined,
  expected: EditManagedMessage,
): boolean {
  return (
    existing !== undefined &&
    audit !== undefined &&
    existing.messageId === expected.messageId &&
    existing.guildId === expected.guildId &&
    existing.channelId === expected.channelId &&
    existing.status === "ACTIVE" &&
    existing.content === expected.content &&
    existing.revision === expected.expectedRevision + 1 &&
    audit.id === expected.auditId &&
    audit.messageId === expected.messageId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "EDITED" &&
    audit.actorType === "USER" &&
    audit.actorId === expected.actorUserId &&
    audit.beforeContent === expected.previousContent &&
    audit.afterContent === expected.content &&
    audit.beforeRevision === expected.expectedRevision &&
    audit.afterRevision === expected.expectedRevision + 1 &&
    audit.beforeStatus === "ACTIVE" &&
    audit.afterStatus === "ACTIVE" &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function matchesDeletion(
  existing: ManagedMessage | undefined,
  audit: ManagedMessageAudit | undefined,
  expected: DeleteManagedMessage,
): boolean {
  return (
    existing !== undefined &&
    audit !== undefined &&
    existing.messageId === expected.messageId &&
    existing.guildId === expected.guildId &&
    existing.channelId === expected.channelId &&
    existing.status === "DELETED" &&
    existing.content === expected.content &&
    existing.revision === expected.expectedRevision &&
    audit.id === expected.auditId &&
    audit.messageId === expected.messageId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "DELETION_DETECTED" &&
    audit.actorType === "SYSTEM" &&
    audit.actorId === null &&
    audit.beforeContent === expected.content &&
    audit.afterContent === expected.content &&
    audit.beforeRevision === expected.expectedRevision &&
    audit.afterRevision === expected.expectedRevision &&
    audit.beforeStatus === "ACTIVE" &&
    audit.afterStatus === "DELETED" &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

export function createManagedMessageStore(database: DatabaseClient): ManagedMessageStore {
  const readStateAndAudit = async (messageId: string, auditId: string) => {
    const [result] = await database
      .select({ message: managedMessages, audit: managedMessageAudits })
      .from(managedMessages)
      .leftJoin(managedMessageAudits, eq(managedMessageAudits.id, auditId))
      .where(eq(managedMessages.messageId, messageId))
      .limit(1);
    return { message: result?.message, audit: result?.audit ?? undefined };
  };

  return {
    async find(messageId) {
      const [message] = await database
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, messageId))
        .limit(1);
      return message;
    },
    async create(input) {
      return database.transaction(async (transaction) => {
        const [created] = await transaction
          .insert(managedMessages)
          .values({
            messageId: input.messageId,
            guildId: input.guildId,
            channelId: input.channelId,
            creatorUserId: input.creatorUserId,
            content: input.content,
            createdAt: input.createdAt,
          })
          .returning();
        if (created === undefined) throw new Error("Managed message could not be created");
        await transaction.insert(managedMessageAudits).values({
          id: input.auditId,
          messageId: input.messageId,
          guildId: input.guildId,
          channelId: input.channelId,
          event: "CREATED",
          actorType: "USER",
          actorId: input.creatorUserId,
          afterContent: input.content,
          afterRevision: 1,
          afterStatus: "ACTIVE",
          occurredAt: input.createdAt,
          outcome: "SUCCESS",
        });
        return created;
      });
    },
    async confirmCreation(input) {
      const state = await readStateAndAudit(input.messageId, input.auditId);
      if (state.message === undefined && state.audit === undefined) return "MISSING";
      return matchesCreation(state.message, state.audit, input) ? "MATCH" : "CONFLICT";
    },
    async edit(input) {
      return database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(managedMessages)
          .set({
            content: input.content,
            revision: input.expectedRevision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(managedMessages.messageId, input.messageId),
              eq(managedMessages.guildId, input.guildId),
              eq(managedMessages.channelId, input.channelId),
              eq(managedMessages.status, "ACTIVE"),
              eq(managedMessages.revision, input.expectedRevision),
              eq(managedMessages.content, input.previousContent),
            ),
          )
          .returning();
        if (updated === undefined) return "NOT_TRANSITIONED";
        await transaction.insert(managedMessageAudits).values({
          id: input.auditId,
          messageId: input.messageId,
          guildId: input.guildId,
          channelId: input.channelId,
          event: "EDITED",
          actorType: "USER",
          actorId: input.actorUserId,
          beforeContent: input.previousContent,
          afterContent: input.content,
          beforeRevision: input.expectedRevision,
          afterRevision: input.expectedRevision + 1,
          beforeStatus: "ACTIVE",
          afterStatus: "ACTIVE",
          occurredAt: input.occurredAt,
          outcome: "SUCCESS",
        });
        return "TRANSITIONED";
      });
    },
    async confirmEdit(input) {
      const state = await readStateAndAudit(input.messageId, input.auditId);
      if (state.message === undefined && state.audit === undefined) return "MISSING";
      return matchesEdit(state.message, state.audit, input) ? "MATCH" : "CONFLICT";
    },
    async markDeleted(input) {
      return database.transaction(async (transaction) => {
        const [updated] = await transaction
          .update(managedMessages)
          .set({ status: "DELETED", updatedAt: new Date() })
          .where(
            and(
              eq(managedMessages.messageId, input.messageId),
              eq(managedMessages.guildId, input.guildId),
              eq(managedMessages.channelId, input.channelId),
              eq(managedMessages.status, "ACTIVE"),
              eq(managedMessages.revision, input.expectedRevision),
              eq(managedMessages.content, input.content),
            ),
          )
          .returning();
        if (updated === undefined) return "NOT_TRANSITIONED";
        await transaction.insert(managedMessageAudits).values({
          id: input.auditId,
          messageId: input.messageId,
          guildId: input.guildId,
          channelId: input.channelId,
          event: "DELETION_DETECTED",
          actorType: "SYSTEM",
          beforeContent: input.content,
          afterContent: input.content,
          beforeRevision: input.expectedRevision,
          afterRevision: input.expectedRevision,
          beforeStatus: "ACTIVE",
          afterStatus: "DELETED",
          occurredAt: input.occurredAt,
          outcome: "SUCCESS",
        });
        return "TRANSITIONED";
      });
    },
    async confirmDeletion(input) {
      const state = await readStateAndAudit(input.messageId, input.auditId);
      if (state.message === undefined && state.audit === undefined) return "MISSING";
      return matchesDeletion(state.message, state.audit, input) ? "MATCH" : "CONFLICT";
    },
    async readCompensationSafety(input) {
      const state = await readStateAndAudit(input.messageId, input.auditId);
      return state.message !== undefined &&
        state.message.guildId === input.guildId &&
        state.message.channelId === input.channelId &&
        state.message.status === "ACTIVE" &&
        state.message.revision === input.expectedRevision &&
        state.message.content === input.previousContent &&
        state.audit === undefined
        ? "SAFE"
        : "UNSAFE";
    },
  };
}
