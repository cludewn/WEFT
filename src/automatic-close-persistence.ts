import { and, eq, sql } from "drizzle-orm";
import { pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";

/**
 * Parent channels whose threads may participate in automatic inactivity closing.
 *
 * The row records only WEFT's configured allowlist intent. Discord resource type and permissions
 * are revalidated by later runtime behavior rather than trusted from stored state.
 */
export const autoCloseParentChannels = pgTable(
  "auto_close_parent_channels",
  {
    guildId: text("guild_id").notNull(),
    parentChannelId: text("parent_channel_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.parentChannelId] })],
);

/**
 * Threads individually excluded from automatic inactivity closing.
 *
 * Row presence means the thread is excluded. Row absence means there is no individual exclusion;
 * it does not by itself make a thread eligible, because allowlisted parent membership is still
 * required.
 */
export const autoCloseThreadExclusions = pgTable(
  "auto_close_thread_exclusions",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.threadId] })],
);

/**
 * Latest qualifying activity observed for a thread.
 *
 * `parent_channel_id` is stored here so that a later database-driven sweep can compare activity
 * rows with parent-channel allowlist membership without fetching Discord state for every stored
 * thread. It is candidate-selection data only.
 */
export const autoCloseThreadActivity = pgTable(
  "auto_close_thread_activity",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentChannelId: text("parent_channel_id").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.threadId] })],
);

export type AutoCloseParentChannel = typeof autoCloseParentChannels.$inferSelect;
export type AutoCloseThreadExclusion = typeof autoCloseThreadExclusions.$inferSelect;
export type AutoCloseThreadActivity = typeof autoCloseThreadActivity.$inferSelect;

export type RecordThreadActivity = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  occurredAt: Date;
};

export type AutomaticClosePersistenceStore = {
  /** Returns whether the allowlist changed. Adding an existing pair is a successful no-op. */
  addParentChannel: (guildId: string, parentChannelId: string) => Promise<boolean>;
  /** Returns whether the allowlist changed. Removing an absent pair is a successful no-op. */
  removeParentChannel: (guildId: string, parentChannelId: string) => Promise<boolean>;
  /** Returns whether the exclusion state changed. */
  addThreadExclusion: (guildId: string, threadId: string) => Promise<boolean>;
  /**
   * Removes an individual exclusion and returns whether the exclusion state changed.
   *
   * This operates on persistence state only. It is not the complete future `/thread track`
   * behavior, which must also reset the activity baseline.
   */
  removeThreadExclusion: (guildId: string, threadId: string) => Promise<boolean>;
  /** Applies `last_activity_at = max(existing, incoming)` atomically in PostgreSQL. */
  recordActivity: (input: RecordThreadActivity) => Promise<void>;
};

export function createAutomaticClosePersistenceStore(
  database: DatabaseClient,
): AutomaticClosePersistenceStore {
  return {
    async addParentChannel(guildId, parentChannelId) {
      const inserted = await database
        .insert(autoCloseParentChannels)
        .values({ guildId, parentChannelId })
        .onConflictDoNothing({
          target: [autoCloseParentChannels.guildId, autoCloseParentChannels.parentChannelId],
        })
        .returning({ guildId: autoCloseParentChannels.guildId });
      return inserted.length > 0;
    },
    async removeParentChannel(guildId, parentChannelId) {
      const removed = await database
        .delete(autoCloseParentChannels)
        .where(
          and(
            eq(autoCloseParentChannels.guildId, guildId),
            eq(autoCloseParentChannels.parentChannelId, parentChannelId),
          ),
        )
        .returning({ guildId: autoCloseParentChannels.guildId });
      return removed.length > 0;
    },
    async addThreadExclusion(guildId, threadId) {
      const inserted = await database
        .insert(autoCloseThreadExclusions)
        .values({ guildId, threadId })
        .onConflictDoNothing({
          target: [autoCloseThreadExclusions.guildId, autoCloseThreadExclusions.threadId],
        })
        .returning({ guildId: autoCloseThreadExclusions.guildId });
      return inserted.length > 0;
    },
    async removeThreadExclusion(guildId, threadId) {
      const removed = await database
        .delete(autoCloseThreadExclusions)
        .where(
          and(
            eq(autoCloseThreadExclusions.guildId, guildId),
            eq(autoCloseThreadExclusions.threadId, threadId),
          ),
        )
        .returning({ guildId: autoCloseThreadExclusions.guildId });
      return removed.length > 0;
    },
    async recordActivity({ guildId, threadId, parentChannelId, occurredAt }) {
      await database
        .insert(autoCloseThreadActivity)
        .values({ guildId, threadId, parentChannelId, lastActivityAt: occurredAt })
        .onConflictDoUpdate({
          target: [autoCloseThreadActivity.guildId, autoCloseThreadActivity.threadId],
          set: {
            lastActivityAt: sql`excluded.last_activity_at`,
            parentChannelId: sql`excluded.parent_channel_id`,
            updatedAt: new Date(),
          },
          setWhere: sql`${autoCloseThreadActivity.lastActivityAt} < excluded.last_activity_at`,
        });
    },
  };
}
