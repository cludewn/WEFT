import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";
import { check, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import type { DatabaseClient } from "./database.js";

export const MANAGED_THREAD_STATES = ["OPEN", "CLOSED"] as const;
export type ManagedThreadLifecycleState = (typeof MANAGED_THREAD_STATES)[number];

export const THREAD_AUDIT_ACTIONS = ["CLOSE", "OPEN", "AUTO_OPEN"] as const;
export type ThreadAuditAction = (typeof THREAD_AUDIT_ACTIONS)[number];

export const THREAD_AUDIT_OUTCOMES = ["SUCCESS", "FAILURE"] as const;
export type ThreadAuditOutcome = (typeof THREAD_AUDIT_OUTCOMES)[number];

export const THREAD_AUDIT_ACTOR_TYPES = ["USER", "SYSTEM"] as const;
export type ThreadAuditActorType = (typeof THREAD_AUDIT_ACTOR_TYPES)[number];

export const managedThreads = pgTable(
  "managed_threads",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    appliedPrefix: text("applied_prefix").notNull(),
    lifecycleState: text("lifecycle_state").$type<ManagedThreadLifecycleState>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.threadId] }),
    check(
      "managed_threads_lifecycle_state_check",
      sql`${table.lifecycleState} in ('OPEN', 'CLOSED')`,
    ),
    check("managed_threads_applied_prefix_check", sql`length(${table.appliedPrefix}) > 0`),
  ],
);

export const threadAudits = pgTable(
  "thread_audits",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    action: text("action").$type<ThreadAuditAction>().notNull(),
    actorType: text("actor_type").$type<ThreadAuditActorType>().notNull(),
    actorId: text("actor_id"),
    outcome: text("outcome").$type<ThreadAuditOutcome>().notNull(),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("thread_audits_action_check", sql`${table.action} in ('CLOSE', 'OPEN', 'AUTO_OPEN')`),
    check("thread_audits_actor_type_check", sql`${table.actorType} in ('USER', 'SYSTEM')`),
    check("thread_audits_outcome_check", sql`${table.outcome} in ('SUCCESS', 'FAILURE')`),
    check(
      "thread_audits_actor_check",
      sql`(${table.actorType} = 'USER' and ${table.actorId} is not null) or (${table.actorType} = 'SYSTEM' and ${table.actorId} is null)`,
    ),
    check(
      "thread_audits_failure_check",
      sql`(${table.outcome} = 'SUCCESS' and ${table.failureCode} is null) or (${table.outcome} = 'FAILURE' and ${table.failureCode} is not null)`,
    ),
  ],
);

export type ManagedThread = typeof managedThreads.$inferSelect;

export type ManagedThreadStore = {
  find: (guildId: string, threadId: string) => Promise<ManagedThread | undefined>;
  saveClosed: (guildId: string, threadId: string, appliedPrefix: string) => Promise<ManagedThread>;
  markOpen: (guildId: string, threadId: string) => Promise<ManagedThread>;
};

export type ThreadAuditRecord = {
  guildId: string;
  threadId: string;
  action: ThreadAuditAction;
  actorType: ThreadAuditActorType;
  actorId?: string;
  outcome: ThreadAuditOutcome;
  failureCode?: string;
};

export type ThreadAuditStore = {
  record: (audit: ThreadAuditRecord) => Promise<void>;
};

export function createManagedThreadStore(database: DatabaseClient): ManagedThreadStore {
  return {
    async find(guildId, threadId) {
      const [state] = await database
        .select()
        .from(managedThreads)
        .where(and(eq(managedThreads.guildId, guildId), eq(managedThreads.threadId, threadId)))
        .limit(1);
      return state;
    },
    async saveClosed(guildId, threadId, appliedPrefix) {
      const [state] = await database
        .insert(managedThreads)
        .values({ guildId, threadId, appliedPrefix, lifecycleState: "CLOSED" })
        .onConflictDoUpdate({
          target: [managedThreads.guildId, managedThreads.threadId],
          set: { appliedPrefix, lifecycleState: "CLOSED", updatedAt: new Date() },
        })
        .returning();

      if (state === undefined) {
        throw new Error("Managed thread state could not be saved");
      }
      return state;
    },
    async markOpen(guildId, threadId) {
      const [state] = await database
        .update(managedThreads)
        .set({ lifecycleState: "OPEN", updatedAt: new Date() })
        .where(and(eq(managedThreads.guildId, guildId), eq(managedThreads.threadId, threadId)))
        .returning();
      if (state === undefined) {
        throw new Error("Managed thread state could not be opened");
      }
      return state;
    },
  };
}

export function createThreadAuditStore(database: DatabaseClient): ThreadAuditStore {
  return {
    async record(audit) {
      await database.insert(threadAudits).values({
        id: randomUUID(),
        guildId: audit.guildId,
        threadId: audit.threadId,
        action: audit.action,
        actorType: audit.actorType,
        ...(audit.actorId === undefined ? {} : { actorId: audit.actorId }),
        outcome: audit.outcome,
        ...(audit.failureCode === undefined ? {} : { failureCode: audit.failureCode }),
      });
    },
  };
}
