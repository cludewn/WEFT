import { eq, sql } from "drizzle-orm";
import { check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";

export const managedMessages = pgTable(
  "managed_messages",
  {
    messageId: text("message_id").primaryKey(),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    creatorUserId: text("creator_user_id").notNull(),
    content: text("content").notNull(),
    revision: integer("revision").notNull().default(1),
    status: text("status").$type<"ACTIVE">().notNull().default("ACTIVE"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("managed_messages_revision_check", sql`${table.revision} >= 1`),
    check("managed_messages_status_check", sql`${table.status} = 'ACTIVE'`),
    check(
      "managed_messages_content_length_check",
      sql`char_length(${table.content}) between 1 and 2000`,
    ),
  ],
);

export type ManagedMessage = typeof managedMessages.$inferSelect;

export type CreateManagedMessage = {
  messageId: string;
  guildId: string;
  channelId: string;
  creatorUserId: string;
  content: string;
  createdAt: Date;
};

export type ManagedMessageCreationConfirmation = "MATCH" | "MISSING" | "CONFLICT";

export type ManagedMessageStore = {
  create: (input: CreateManagedMessage) => Promise<ManagedMessage>;
  confirmCreation: (input: CreateManagedMessage) => Promise<ManagedMessageCreationConfirmation>;
};

function matchesCreation(existing: ManagedMessage, expected: CreateManagedMessage): boolean {
  return (
    existing.messageId === expected.messageId &&
    existing.guildId === expected.guildId &&
    existing.channelId === expected.channelId &&
    existing.creatorUserId === expected.creatorUserId &&
    existing.content === expected.content &&
    existing.revision === 1 &&
    existing.status === "ACTIVE" &&
    existing.createdAt.getTime() === expected.createdAt.getTime()
  );
}

export function createManagedMessageStore(database: DatabaseClient): ManagedMessageStore {
  return {
    async create(input) {
      const [created] = await database.insert(managedMessages).values(input).returning();
      if (created === undefined) {
        throw new Error("Managed message could not be created");
      }
      return created;
    },

    async confirmCreation(input) {
      const [existing] = await database
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, input.messageId))
        .limit(1);
      if (existing === undefined) {
        return "MISSING";
      }
      return matchesCreation(existing, input) ? "MATCH" : "CONFLICT";
    },
  };
}
