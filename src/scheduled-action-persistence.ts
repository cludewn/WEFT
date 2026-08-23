import { and, asc, DrizzleQueryError, eq, gt, or, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { DatabaseError } from "pg";

import type { DatabaseClient } from "./database.js";

export const SCHEDULED_ACTION_TYPES = ["CLOSE_THREAD", "SEND_MESSAGE"] as const;
export type ScheduledActionType = (typeof SCHEDULED_ACTION_TYPES)[number];

export const SCHEDULED_ACTION_STATUSES = [
  "ACTIVE",
  "EXECUTING",
  "CANCELLED",
  "COMPLETED",
  "FAILED",
] as const;
export type ScheduledActionStatus = (typeof SCHEDULED_ACTION_STATUSES)[number];

export const scheduledActions = pgTable(
  "scheduled_actions",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    actionType: text("action_type").$type<ScheduledActionType>().notNull(),
    targetId: text("target_id").notNull(),
    status: text("status").$type<ScheduledActionStatus>().notNull(),
    executeAt: timestamp("execute_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "scheduled_actions_action_type_check",
      sql`${table.actionType} in ('CLOSE_THREAD', 'SEND_MESSAGE')`,
    ),
    check(
      "scheduled_actions_status_check",
      sql`${table.status} in ('ACTIVE', 'EXECUTING', 'CANCELLED', 'COMPLETED', 'FAILED')`,
    ),
    uniqueIndex("scheduled_actions_active_close_unique")
      .on(table.guildId, table.targetId)
      .where(
        sql`${table.actionType} = 'CLOSE_THREAD' and ${table.status} in ('ACTIVE', 'EXECUTING')`,
      ),
    index("scheduled_actions_active_execute_at_idx")
      .on(table.executeAt)
      .where(sql`${table.status} = 'ACTIVE'`),
    index("scheduled_actions_active_close_execute_at_id_idx")
      .on(table.executeAt, table.id)
      .where(sql`${table.actionType} = 'CLOSE_THREAD' and ${table.status} = 'ACTIVE'`),
  ],
);

/** Shared scheduling envelope; action-specific execution data is stored separately when needed. */
export type ScheduledAction = typeof scheduledActions.$inferSelect;

export type CreateScheduledAction = {
  id: string;
  guildId: string;
  actionType: ScheduledActionType;
  targetId: string;
  executeAt: Date;
};

export type ActiveScheduledThreadCloseCursor = {
  executeAt: Date;
  id: string;
};

const SCHEDULED_THREAD_CLOSE_RECOVERY_PAGE_SIZE = 100;

export type ScheduledActionStore = {
  create: (input: CreateScheduledAction) => Promise<ScheduledAction>;
  findById: (id: string) => Promise<ScheduledAction | undefined>;
  findActiveThreadClosesPage: (
    cursor?: ActiveScheduledThreadCloseCursor,
  ) => Promise<ScheduledAction[]>;
  findExecutingThreadClosesPage: (afterId?: string) => Promise<ScheduledAction[]>;
  cancel: (id: string) => Promise<ScheduledAction | undefined>;
  claimExecution: (id: string) => Promise<ScheduledActionTransitionResult>;
  completeExecution: (id: string) => Promise<ScheduledActionTransitionResult>;
  failExecution: (id: string) => Promise<ScheduledActionTransitionResult>;
  releaseExecutionForRetry: (id: string) => Promise<ScheduledActionTransitionResult>;
};

export type ScheduledActionTransitionResult =
  | { transitioned: true; current: ScheduledAction }
  | { transitioned: false; current: ScheduledAction | undefined };

export class ActiveScheduledCloseConflictError extends Error {
  constructor() {
    super("An active scheduled close already exists for this thread");
    this.name = "ActiveScheduledCloseConflictError";
  }
}

export function createScheduledActionStore(database: DatabaseClient): ScheduledActionStore {
  const findById = async (id: string): Promise<ScheduledAction | undefined> => {
    const [action] = await database
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.id, id))
      .limit(1);
    return action;
  };

  const transition = async (
    id: string,
    expectedStatus: ScheduledActionStatus,
    nextStatus: ScheduledActionStatus,
  ): Promise<ScheduledActionTransitionResult> => {
    const [transitioned] = await database
      .update(scheduledActions)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, expectedStatus)))
      .returning();

    if (transitioned !== undefined) {
      return { transitioned: true, current: transitioned };
    }
    return { transitioned: false, current: await findById(id) };
  };

  return {
    async create(input) {
      try {
        const [action] = await database
          .insert(scheduledActions)
          .values({ ...input, status: "ACTIVE" })
          .returning();

        if (action === undefined) {
          throw new Error("Scheduled action could not be created");
        }
        return action;
      } catch (error) {
        if (isActiveScheduledCloseConflict(error)) {
          throw new ActiveScheduledCloseConflictError();
        }
        throw error;
      }
    },
    findById,
    async findActiveThreadClosesPage(cursor) {
      return database
        .select()
        .from(scheduledActions)
        .where(
          and(
            eq(scheduledActions.actionType, "CLOSE_THREAD"),
            eq(scheduledActions.status, "ACTIVE"),
            cursor === undefined
              ? undefined
              : or(
                  gt(scheduledActions.executeAt, cursor.executeAt),
                  and(
                    eq(scheduledActions.executeAt, cursor.executeAt),
                    gt(scheduledActions.id, cursor.id),
                  ),
                ),
          ),
        )
        .orderBy(asc(scheduledActions.executeAt), asc(scheduledActions.id))
        .limit(SCHEDULED_THREAD_CLOSE_RECOVERY_PAGE_SIZE);
    },
    async findExecutingThreadClosesPage(afterId) {
      return database
        .select()
        .from(scheduledActions)
        .where(
          and(
            eq(scheduledActions.actionType, "CLOSE_THREAD"),
            eq(scheduledActions.status, "EXECUTING"),
            afterId === undefined ? undefined : gt(scheduledActions.id, afterId),
          ),
        )
        .orderBy(asc(scheduledActions.id))
        .limit(SCHEDULED_THREAD_CLOSE_RECOVERY_PAGE_SIZE);
    },
    async cancel(id) {
      const [cancelled] = await database
        .update(scheduledActions)
        .set({ status: "CANCELLED", updatedAt: new Date() })
        .where(and(eq(scheduledActions.id, id), eq(scheduledActions.status, "ACTIVE")))
        .returning();

      return cancelled ?? findById(id);
    },
    claimExecution: (id) => transition(id, "ACTIVE", "EXECUTING"),
    completeExecution: (id) => transition(id, "EXECUTING", "COMPLETED"),
    failExecution: (id) => transition(id, "EXECUTING", "FAILED"),
    releaseExecutionForRetry: (id) => transition(id, "EXECUTING", "ACTIVE"),
  };
}

function isActiveScheduledCloseConflict(error: unknown): boolean {
  const cause = error instanceof DrizzleQueryError ? error.cause : error;
  return (
    cause instanceof DatabaseError &&
    cause.code === "23505" &&
    cause.constraint === "scheduled_actions_active_close_unique"
  );
}
