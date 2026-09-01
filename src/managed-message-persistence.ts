import { and, eq, isNull, sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import type { ManagedMessagePayload } from "./managed-message-payload.js";

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
    embedTitle: text("embed_title"),
    embedDescription: text("embed_description"),
    embedColor: integer("embed_color"),
    embedImageUrl: text("embed_image_url"),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<ManagedMessageStatus>().notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("managed_messages_revision_check", sql`${table.revision} >= 1`),
    check("managed_messages_status_check", sql`${table.status} in ('ACTIVE', 'DELETED')`),
    check(
      "managed_messages_payload_check",
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
    beforeEmbedTitle: text("before_embed_title"),
    afterEmbedTitle: text("after_embed_title"),
    beforeEmbedDescription: text("before_embed_description"),
    afterEmbedDescription: text("after_embed_description"),
    beforeEmbedColor: integer("before_embed_color"),
    afterEmbedColor: integer("after_embed_color"),
    beforeEmbedImageUrl: text("before_embed_image_url"),
    afterEmbedImageUrl: text("after_embed_image_url"),
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
      "managed_message_audits_payload_check",
      sql`char_length(${table.afterContent}) between 0 and 2000
        and (${table.beforeContent} is null or char_length(${table.beforeContent}) between 0 and 2000)
        and (${table.afterEmbedTitle} is null or char_length(${table.afterEmbedTitle}) between 1 and 256)
        and (${table.beforeEmbedTitle} is null or char_length(${table.beforeEmbedTitle}) between 1 and 256)
        and (${table.afterEmbedDescription} is null or char_length(${table.afterEmbedDescription}) between 1 and 4000)
        and (${table.beforeEmbedDescription} is null or char_length(${table.beforeEmbedDescription}) between 1 and 4000)
        and (${table.afterEmbedColor} is null or ${table.afterEmbedColor} between 0 and 16777215)
        and (${table.beforeEmbedColor} is null or ${table.beforeEmbedColor} between 0 and 16777215)
        and (${table.afterEmbedImageUrl} is null or char_length(${table.afterEmbedImageUrl}) between 1 and 2048)
        and (${table.beforeEmbedImageUrl} is null or char_length(${table.beforeEmbedImageUrl}) between 1 and 2048)
        and (${table.afterEmbedColor} is null or ${table.afterEmbedTitle} is not null or ${table.afterEmbedDescription} is not null or ${table.afterEmbedImageUrl} is not null)
        and (char_length(${table.afterContent}) > 0 or ${table.afterEmbedTitle} is not null or ${table.afterEmbedDescription} is not null or ${table.afterEmbedImageUrl} is not null)
        and (${table.beforeContent} is null or (
          (${table.beforeEmbedColor} is null or ${table.beforeEmbedTitle} is not null or ${table.beforeEmbedDescription} is not null or ${table.beforeEmbedImageUrl} is not null)
          and (char_length(${table.beforeContent}) > 0 or ${table.beforeEmbedTitle} is not null or ${table.beforeEmbedDescription} is not null or ${table.beforeEmbedImageUrl} is not null)
        ))`,
    ),
    check(
      "managed_message_audits_event_shape_check",
      sql`(
        ${table.event} = 'CREATED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.beforeContent} is null and ${table.beforeEmbedTitle} is null
        and ${table.beforeEmbedDescription} is null and ${table.beforeEmbedColor} is null
        and ${table.beforeEmbedImageUrl} is null and ${table.beforeRevision} is null
        and ${table.beforeStatus} is null
        and ${table.afterRevision} = 1 and ${table.afterStatus} = 'ACTIVE'
      ) or (
        ${table.event} = 'EDITED'
        and ${table.actorType} = 'USER' and ${table.actorId} is not null
        and ${table.beforeContent} is not null and ${table.beforeRevision} is not null
        and ${table.beforeStatus} = 'ACTIVE' and ${table.afterStatus} = 'ACTIVE'
        and ${table.afterRevision} = ${table.beforeRevision} + 1
        and (
          ${table.afterContent} is distinct from ${table.beforeContent}
          or ${table.afterEmbedTitle} is distinct from ${table.beforeEmbedTitle}
          or ${table.afterEmbedDescription} is distinct from ${table.beforeEmbedDescription}
          or ${table.afterEmbedColor} is distinct from ${table.beforeEmbedColor}
          or ${table.afterEmbedImageUrl} is distinct from ${table.beforeEmbedImageUrl}
        )
      ) or (
        ${table.event} = 'DELETION_DETECTED'
        and ${table.actorType} = 'SYSTEM' and ${table.actorId} is null
        and ${table.beforeContent} is not null and ${table.beforeRevision} is not null
        and ${table.beforeStatus} = 'ACTIVE' and ${table.afterStatus} = 'DELETED'
        and ${table.afterRevision} = ${table.beforeRevision}
        and ${table.afterContent} is not distinct from ${table.beforeContent}
        and ${table.afterEmbedTitle} is not distinct from ${table.beforeEmbedTitle}
        and ${table.afterEmbedDescription} is not distinct from ${table.beforeEmbedDescription}
        and ${table.afterEmbedColor} is not distinct from ${table.beforeEmbedColor}
        and ${table.afterEmbedImageUrl} is not distinct from ${table.beforeEmbedImageUrl}
      )`,
    ),
  ],
);

type ManagedMessageRow = typeof managedMessages.$inferSelect;
export type ManagedMessageAudit = typeof managedMessageAudits.$inferSelect;
export type ManagedMessage = Omit<
  ManagedMessageRow,
  "content" | "embedTitle" | "embedDescription" | "embedColor" | "embedImageUrl"
> & { payload: ManagedMessagePayload };

export type CreateManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  creatorUserId: string;
  payload: ManagedMessagePayload;
  createdAt: Date;
};
export type EditManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  actorUserId: string;
  expectedRevision: number;
  previousPayload: ManagedMessagePayload;
  payload: ManagedMessagePayload;
  occurredAt: Date;
};
export type DeleteManagedMessage = {
  auditId: string;
  messageId: string;
  guildId: string;
  channelId: string;
  expectedRevision: number;
  payload: ManagedMessagePayload;
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

type FlatPayload = {
  content: string;
  embedTitle: string | null;
  embedDescription: string | null;
  embedColor: number | null;
  embedImageUrl: string | null;
};

function flattenPayload(payload: ManagedMessagePayload): FlatPayload {
  return {
    content: payload.content,
    embedTitle: payload.embed?.title ?? null,
    embedDescription: payload.embed?.description ?? null,
    embedColor: payload.embed?.color ?? null,
    embedImageUrl: payload.embed?.imageUrl ?? null,
  };
}

function unflattenPayload(row: FlatPayload): ManagedMessagePayload {
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

function toManagedMessage(row: ManagedMessageRow): ManagedMessage {
  const { content, embedTitle, embedDescription, embedColor, embedImageUrl, ...metadata } = row;
  return {
    ...metadata,
    payload: unflattenPayload({ content, embedTitle, embedDescription, embedColor, embedImageUrl }),
  };
}

function rowPayloadMatches(row: FlatPayload, payload: ManagedMessagePayload): boolean {
  const expected = flattenPayload(payload);
  return (
    row.content === expected.content &&
    row.embedTitle === expected.embedTitle &&
    row.embedDescription === expected.embedDescription &&
    row.embedColor === expected.embedColor &&
    row.embedImageUrl === expected.embedImageUrl
  );
}

function auditPayloadMatches(
  audit: ManagedMessageAudit,
  side: "before" | "after",
  payload: ManagedMessagePayload | null,
): boolean {
  if (payload === null) {
    return (
      audit.beforeContent === null &&
      audit.beforeEmbedTitle === null &&
      audit.beforeEmbedDescription === null &&
      audit.beforeEmbedColor === null &&
      audit.beforeEmbedImageUrl === null
    );
  }
  const flat = flattenPayload(payload);
  return side === "before"
    ? audit.beforeContent === flat.content &&
        audit.beforeEmbedTitle === flat.embedTitle &&
        audit.beforeEmbedDescription === flat.embedDescription &&
        audit.beforeEmbedColor === flat.embedColor &&
        audit.beforeEmbedImageUrl === flat.embedImageUrl
    : audit.afterContent === flat.content &&
        audit.afterEmbedTitle === flat.embedTitle &&
        audit.afterEmbedDescription === flat.embedDescription &&
        audit.afterEmbedColor === flat.embedColor &&
        audit.afterEmbedImageUrl === flat.embedImageUrl;
}

function matchesCreation(
  existing: ManagedMessageRow | undefined,
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
    rowPayloadMatches(existing, expected.payload) &&
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
    auditPayloadMatches(audit, "before", null) &&
    auditPayloadMatches(audit, "after", expected.payload) &&
    audit.beforeRevision === null &&
    audit.afterRevision === 1 &&
    audit.beforeStatus === null &&
    audit.afterStatus === "ACTIVE" &&
    audit.occurredAt.getTime() === expected.createdAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function matchesEdit(
  existing: ManagedMessageRow | undefined,
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
    rowPayloadMatches(existing, expected.payload) &&
    existing.revision === expected.expectedRevision + 1 &&
    audit.id === expected.auditId &&
    audit.messageId === expected.messageId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "EDITED" &&
    audit.actorType === "USER" &&
    audit.actorId === expected.actorUserId &&
    auditPayloadMatches(audit, "before", expected.previousPayload) &&
    auditPayloadMatches(audit, "after", expected.payload) &&
    audit.beforeRevision === expected.expectedRevision &&
    audit.afterRevision === expected.expectedRevision + 1 &&
    audit.beforeStatus === "ACTIVE" &&
    audit.afterStatus === "ACTIVE" &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function matchesDeletion(
  existing: ManagedMessageRow | undefined,
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
    rowPayloadMatches(existing, expected.payload) &&
    existing.revision === expected.expectedRevision &&
    audit.id === expected.auditId &&
    audit.messageId === expected.messageId &&
    audit.guildId === expected.guildId &&
    audit.channelId === expected.channelId &&
    audit.event === "DELETION_DETECTED" &&
    audit.actorType === "SYSTEM" &&
    audit.actorId === null &&
    auditPayloadMatches(audit, "before", expected.payload) &&
    auditPayloadMatches(audit, "after", expected.payload) &&
    audit.beforeRevision === expected.expectedRevision &&
    audit.afterRevision === expected.expectedRevision &&
    audit.beforeStatus === "ACTIVE" &&
    audit.afterStatus === "DELETED" &&
    audit.occurredAt.getTime() === expected.occurredAt.getTime() &&
    audit.outcome === "SUCCESS"
  );
}

function payloadConditions(payload: ManagedMessagePayload) {
  const flat = flattenPayload(payload);
  return [
    eq(managedMessages.content, flat.content),
    flat.embedTitle === null
      ? isNull(managedMessages.embedTitle)
      : eq(managedMessages.embedTitle, flat.embedTitle),
    flat.embedDescription === null
      ? isNull(managedMessages.embedDescription)
      : eq(managedMessages.embedDescription, flat.embedDescription),
    flat.embedColor === null
      ? isNull(managedMessages.embedColor)
      : eq(managedMessages.embedColor, flat.embedColor),
    flat.embedImageUrl === null
      ? isNull(managedMessages.embedImageUrl)
      : eq(managedMessages.embedImageUrl, flat.embedImageUrl),
  ];
}

function auditPayloadValues(
  prefix: "before",
  payload: ManagedMessagePayload,
): {
  beforeContent: string;
  beforeEmbedTitle: string | null;
  beforeEmbedDescription: string | null;
  beforeEmbedColor: number | null;
  beforeEmbedImageUrl: string | null;
};
function auditPayloadValues(
  prefix: "after",
  payload: ManagedMessagePayload,
): {
  afterContent: string;
  afterEmbedTitle: string | null;
  afterEmbedDescription: string | null;
  afterEmbedColor: number | null;
  afterEmbedImageUrl: string | null;
};
function auditPayloadValues(prefix: "before" | "after", payload: ManagedMessagePayload) {
  const flat = flattenPayload(payload);
  return prefix === "before"
    ? {
        beforeContent: flat.content,
        beforeEmbedTitle: flat.embedTitle,
        beforeEmbedDescription: flat.embedDescription,
        beforeEmbedColor: flat.embedColor,
        beforeEmbedImageUrl: flat.embedImageUrl,
      }
    : {
        afterContent: flat.content,
        afterEmbedTitle: flat.embedTitle,
        afterEmbedDescription: flat.embedDescription,
        afterEmbedColor: flat.embedColor,
        afterEmbedImageUrl: flat.embedImageUrl,
      };
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
      return message === undefined ? undefined : toManagedMessage(message);
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
            ...flattenPayload(input.payload),
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
          ...auditPayloadValues("after", input.payload),
          afterRevision: 1,
          afterStatus: "ACTIVE",
          occurredAt: input.createdAt,
          outcome: "SUCCESS",
        });
        return toManagedMessage(created);
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
            ...flattenPayload(input.payload),
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
              ...payloadConditions(input.previousPayload),
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
          ...auditPayloadValues("before", input.previousPayload),
          ...auditPayloadValues("after", input.payload),
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
              ...payloadConditions(input.payload),
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
          ...auditPayloadValues("before", input.payload),
          ...auditPayloadValues("after", input.payload),
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
        rowPayloadMatches(state.message, input.previousPayload) &&
        state.audit === undefined
        ? "SAFE"
        : "UNSAFE";
    },
  };
}
