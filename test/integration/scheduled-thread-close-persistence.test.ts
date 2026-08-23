import { and, eq, inArray, or, sql } from "drizzle-orm";
import { ChannelType } from "discord.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import type { DatabaseClient } from "../../src/database.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
  scheduledThreadCloseAdvisoryLockKeys,
} from "../../src/scheduled-thread-close-persistence.js";

const guildIds = ["scheduled-command-guild-one", "scheduled-command-guild-two"] as const;
const threadIds = [
  "scheduled-command-thread-one",
  "scheduled-command-thread-two",
  "scheduled-command-thread-three",
] as const;
const database = createDatabase(loadTestDatabaseConfig());
const store = createScheduledThreadCloseStore(database.client);
const actionStore = createScheduledActionStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("scheduled thread close creation persistence", () => {
  it("creates one ACTIVE action and matching USER audit atomically", async () => {
    const executeAt = new Date("2030-01-02T03:04:05.678Z");

    const result = await store.createOrReplace({
      scheduledActionId: "created-action",
      auditId: "created-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt,
    });

    expect(result).toMatchObject({
      outcome: "CREATED",
      action: {
        id: "created-action",
        guildId: guildIds[0],
        actionType: "CLOSE_THREAD",
        targetId: threadIds[0],
        status: "ACTIVE",
        executeAt,
      },
    });
    await expect(store.findAuditById("created-audit")).resolves.toMatchObject({
      scheduledActionId: "created-action",
      guildId: guildIds[0],
      threadId: threadIds[0],
      event: "CREATED",
      actorType: "USER",
      actorId: "actor-id",
      previousScheduledActionId: null,
      previousExecuteAt: null,
      executeAt,
      outcome: "SUCCESS",
      failureCode: null,
    });
  });

  it("cancels the prior ACTIVE action and records replacement lineage", async () => {
    const previousExecuteAt = new Date("2030-02-01T00:00:00Z");
    const executeAt = new Date("2030-02-02T00:00:00Z");
    await store.createOrReplace({
      scheduledActionId: "previous-action",
      auditId: "previous-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: previousExecuteAt,
    });

    const result = await store.createOrReplace({
      scheduledActionId: "replacement-action",
      auditId: "replacement-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "replacement-actor",
      executeAt,
    });

    expect(result).toMatchObject({
      outcome: "REPLACED",
      action: { id: "replacement-action", status: "ACTIVE" },
      previousAction: { id: "previous-action", status: "CANCELLED" },
    });
    await expect(actionStore.findById("previous-action")).resolves.toMatchObject({
      status: "CANCELLED",
    });
    await expect(store.findAuditById("replacement-audit")).resolves.toMatchObject({
      event: "REPLACED",
      scheduledActionId: "replacement-action",
      actorType: "USER",
      actorId: "replacement-actor",
      previousScheduledActionId: "previous-action",
      previousExecuteAt,
      executeAt,
      outcome: "SUCCESS",
    });
  });

  it("serializes concurrent replacements for the same guild and thread", async () => {
    const results = await Promise.all([
      store.createOrReplace({
        scheduledActionId: "concurrent-action-one",
        auditId: "concurrent-audit-one",
        guildId: guildIds[0],
        threadId: threadIds[1],
        actorId: "actor-one",
        executeAt: new Date("2030-03-01T00:00:00Z"),
      }),
      store.createOrReplace({
        scheduledActionId: "concurrent-action-two",
        auditId: "concurrent-audit-two",
        guildId: guildIds[0],
        threadId: threadIds[1],
        actorId: "actor-two",
        executeAt: new Date("2030-03-02T00:00:00Z"),
      }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLACED"]);
    const rows = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(eq(scheduledActions.guildId, guildIds[0]), eq(scheduledActions.targetId, threadIds[1])),
      );
    expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(1);
    const audits = await database.client
      .select()
      .from(scheduledThreadCloseAudits)
      .where(
        inArray(scheduledThreadCloseAudits.id, ["concurrent-audit-one", "concurrent-audit-two"]),
      );
    expect(audits).toHaveLength(2);
  });

  it("serializes concurrent replacements of an existing ACTIVE close", async () => {
    await store.createOrReplace({
      scheduledActionId: "replacement-race-original",
      auditId: "replacement-race-original-audit",
      guildId: guildIds[0],
      threadId: threadIds[2],
      actorId: "original-actor",
      executeAt: new Date("2030-03-10T00:00:00Z"),
    });

    const results = await Promise.all([
      store.createOrReplace({
        scheduledActionId: "replacement-race-one",
        auditId: "replacement-race-one-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-one",
        executeAt: new Date("2030-03-11T00:00:00Z"),
      }),
      store.createOrReplace({
        scheduledActionId: "replacement-race-two",
        auditId: "replacement-race-two-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-two",
        executeAt: new Date("2030-03-12T00:00:00Z"),
      }),
    ]);

    expect(results.every((result) => result.outcome === "REPLACED")).toBe(true);
    const rows = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(eq(scheduledActions.guildId, guildIds[0]), eq(scheduledActions.targetId, threadIds[2])),
      );
    expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(2);
  });

  it("does not replace or audit while the scheduled close is EXECUTING", async () => {
    await store.createOrReplace({
      scheduledActionId: "executing-action",
      auditId: "executing-created-audit",
      guildId: guildIds[0],
      threadId: threadIds[2],
      actorId: "actor-id",
      executeAt: new Date("2030-04-01T00:00:00Z"),
    });
    await actionStore.claimExecution("executing-action");

    await expect(
      store.createOrReplace({
        scheduledActionId: "blocked-action",
        auditId: "blocked-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-id",
        executeAt: new Date("2030-04-02T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "EXECUTION_IN_PROGRESS",
      current: { id: "executing-action", status: "EXECUTING" },
    });

    await expect(actionStore.findById("blocked-action")).resolves.toBeUndefined();
    await expect(store.findAuditById("blocked-audit")).resolves.toBeUndefined();
  });

  it("keeps worker-claim-first and replacement-first orderings safe", async () => {
    await store.createOrReplace({
      scheduledActionId: "worker-wins-action",
      auditId: "worker-wins-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-04-10T00:00:00Z"),
    });
    await expect(actionStore.claimExecution("worker-wins-action")).resolves.toMatchObject({
      transitioned: true,
    });
    await expect(
      store.createOrReplace({
        scheduledActionId: "worker-wins-blocked-action",
        auditId: "worker-wins-blocked-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-04-11T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "EXECUTION_IN_PROGRESS" });

    await store.createOrReplace({
      scheduledActionId: "replacement-wins-original",
      auditId: "replacement-wins-original-audit",
      guildId: guildIds[1],
      threadId: threadIds[1],
      actorId: "actor-id",
      executeAt: new Date("2030-04-12T00:00:00Z"),
    });
    await expect(
      store.createOrReplace({
        scheduledActionId: "replacement-wins-new",
        auditId: "replacement-wins-new-audit",
        guildId: guildIds[1],
        threadId: threadIds[1],
        actorId: "actor-id",
        executeAt: new Date("2030-04-13T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "REPLACED" });
    await expect(actionStore.claimExecution("replacement-wins-original")).resolves.toMatchObject({
      transitioned: false,
      current: { status: "CANCELLED" },
    });
  });

  it("rolls back cancellation and insertion when the audit write fails", async () => {
    await store.createOrReplace({
      scheduledActionId: "rollback-previous-action",
      auditId: "duplicate-audit-id",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-05-01T00:00:00Z"),
    });

    await expect(
      store.createOrReplace({
        scheduledActionId: "rollback-new-action",
        auditId: "duplicate-audit-id",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-05-02T00:00:00Z"),
      }),
    ).rejects.toThrow();

    await expect(actionStore.findById("rollback-previous-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(actionStore.findById("rollback-new-action")).resolves.toBeUndefined();
  });

  it("confirms a committed transaction after simulated response loss without rerunning it", async () => {
    let transactionCalls = 0;
    const responseLossDatabase = {
      select: database.client.select.bind(database.client),
      transaction: async (work: Parameters<DatabaseClient["transaction"]>[0]) => {
        transactionCalls += 1;
        await database.client.transaction(work);
        throw new Error("simulated response loss after commit");
      },
    } as unknown as DatabaseClient;
    const responseLossStore = createScheduledThreadCloseStore(responseLossDatabase);

    await expect(
      responseLossStore.createOrReplace({
        scheduledActionId: "response-loss-action",
        auditId: "response-loss-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-06-01T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "CREATED", action: { id: "response-loss-action" } });

    expect(transactionCalls).toBe(1);
    await expect(actionStore.findById("response-loss-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(store.findAuditById("response-loss-audit")).resolves.toMatchObject({
      event: "CREATED",
      outcome: "SUCCESS",
    });
  });

  it("confirms a committed replacement after simulated response loss without rerunning it", async () => {
    const previousExecuteAt = new Date("2030-06-02T00:00:00Z");
    const replacementExecuteAt = new Date("2030-06-03T00:00:00Z");
    await store.createOrReplace({
      scheduledActionId: "response-loss-previous-action",
      auditId: "response-loss-previous-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "previous-actor",
      executeAt: previousExecuteAt,
    });

    let transactionCalls = 0;
    const responseLossDatabase = {
      select: database.client.select.bind(database.client),
      transaction: async (work: Parameters<DatabaseClient["transaction"]>[0]) => {
        transactionCalls += 1;
        await database.client.transaction(work);
        throw new Error("simulated response loss after replacement commit");
      },
    } as unknown as DatabaseClient;
    const responseLossStore = createScheduledThreadCloseStore(responseLossDatabase);

    await expect(
      responseLossStore.createOrReplace({
        scheduledActionId: "response-loss-replacement-action",
        auditId: "response-loss-replacement-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "replacement-actor",
        executeAt: replacementExecuteAt,
      }),
    ).resolves.toMatchObject({
      outcome: "REPLACED",
      action: {
        id: "response-loss-replacement-action",
        status: "ACTIVE",
        executeAt: replacementExecuteAt,
      },
      previousAction: {
        id: "response-loss-previous-action",
        status: "CANCELLED",
        executeAt: previousExecuteAt,
      },
    });

    expect(transactionCalls).toBe(1);
    const actions = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.guildId, guildIds[0]),
          eq(scheduledActions.actionType, "CLOSE_THREAD"),
          eq(scheduledActions.targetId, threadIds[0]),
        ),
      );
    expect(actions).toHaveLength(2);
    expect(actions.filter((action) => action.status === "ACTIVE")).toEqual([
      expect.objectContaining({
        id: "response-loss-replacement-action",
        executeAt: replacementExecuteAt,
      }),
    ]);
    expect(actions.filter((action) => action.status === "CANCELLED")).toEqual([
      expect.objectContaining({
        id: "response-loss-previous-action",
        executeAt: previousExecuteAt,
      }),
    ]);

    const replacementAudits = await database.client
      .select()
      .from(scheduledThreadCloseAudits)
      .where(eq(scheduledThreadCloseAudits.id, "response-loss-replacement-audit"));
    expect(replacementAudits).toEqual([
      expect.objectContaining({
        id: "response-loss-replacement-audit",
        scheduledActionId: "response-loss-replacement-action",
        guildId: guildIds[0],
        threadId: threadIds[0],
        event: "REPLACED",
        actorType: "USER",
        actorId: "replacement-actor",
        previousScheduledActionId: "response-loss-previous-action",
        previousExecuteAt,
        executeAt: replacementExecuteAt,
        outcome: "SUCCESS",
        failureCode: null,
      }),
    ]);
  });

  it("commits the action and audit before invoking the enqueue boundary", async () => {
    const observer = createDatabase(loadTestDatabaseConfig());
    const now = new Date("2030-06-04T00:00:00Z");
    const executeAt = new Date("2030-06-04T00:30:00Z");
    let observedAtEnqueue:
      | {
          action: typeof scheduledActions.$inferSelect | undefined;
          audit: typeof scheduledThreadCloseAudits.$inferSelect | undefined;
        }
      | undefined;
    const enqueueScheduledThreadClose = vi.fn(async (scheduledActionId: string) => {
      const [[action], [audit]] = await Promise.all([
        observer.client
          .select()
          .from(scheduledActions)
          .where(eq(scheduledActions.id, scheduledActionId))
          .limit(1),
        observer.client
          .select()
          .from(scheduledThreadCloseAudits)
          .where(eq(scheduledThreadCloseAudits.id, "commit-order-audit"))
          .limit(1),
      ]);
      observedAtEnqueue = { action, audit };
      return "ENQUEUED" as const;
    });
    const ids = ["commit-order-action", "commit-order-audit"];
    const service = createScheduledThreadCloseCommandService({
      discord: {
        fetchThread: () =>
          Promise.resolve({
            guildId: guildIds[1],
            threadId: threadIds[2],
            type: ChannelType.PublicThread,
            name: "Topic",
            archived: false,
            locked: false,
          }),
        actorCanManage: () => Promise.resolve(true),
        botCanManage: () => Promise.resolve(true),
      },
      schedules: store,
      delivery: {
        enqueueScheduledThreadClose,
        hasCreatedOrRetryDelivery: () => Promise.resolve(false),
      },
      logger: { warn: vi.fn() },
      now: () => now,
      generateId: () => ids.shift()!,
    });

    try {
      await expect(
        service.schedule(guildIds[1], threadIds[2], "actor-id", "30m"),
      ).resolves.toMatchObject({
        ok: true,
        outcome: "CREATED",
        action: { id: "commit-order-action", executeAt },
      });
    } finally {
      await observer.close();
    }

    expect(enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(observedAtEnqueue).toMatchObject({
      action: {
        id: "commit-order-action",
        guildId: guildIds[1],
        actionType: "CLOSE_THREAD",
        targetId: threadIds[2],
        status: "ACTIVE",
        executeAt,
      },
      audit: {
        id: "commit-order-audit",
        scheduledActionId: "commit-order-action",
        guildId: guildIds[1],
        threadId: threadIds[2],
        event: "CREATED",
        actorType: "USER",
        actorId: "actor-id",
        executeAt,
        outcome: "SUCCESS",
      },
    });
  });

  it("enforces audit actor, outcome, and replacement checks in PostgreSQL", async () => {
    const insertInvalidAudit = (id: string, actorId: string | null, failureCode: string | null) =>
      database.client.execute(sql`
        insert into scheduled_thread_close_audits
          (id, scheduled_action_id, guild_id, thread_id, event, actor_type, actor_id,
           execute_at, outcome, failure_code)
        values (
          ${id}, ${"constraint-action"}, ${guildIds[0]}, ${threadIds[0]}, ${"CREATED"},
          ${"USER"}, ${actorId}, ${new Date("2030-07-01T00:00:00Z")}, ${"SUCCESS"},
          ${failureCode}
        )
      `);

    await expect(insertInvalidAudit("missing-user-actor", null, null)).rejects.toThrow();
    await expect(
      insertInvalidAudit("success-with-failure", "actor-id", "FAILURE"),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into scheduled_thread_close_audits
          (id, scheduled_action_id, guild_id, thread_id, event, actor_type, actor_id,
           execute_at, outcome)
        values (
          ${"replacement-without-lineage"}, ${"constraint-action"}, ${guildIds[0]},
          ${threadIds[0]}, ${"REPLACED"}, ${"USER"}, ${"actor-id"},
          ${new Date("2030-07-01T00:00:00Z")}, ${"SUCCESS"}
        )
      `),
    ).rejects.toThrow();
  });

  it("uses separate advisory lock namespaces for distinct guild/thread pairs", () => {
    const first = scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]);

    expect(first).toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]));
    expect(first).not.toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[1], threadIds[0]));
    expect(first).not.toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[1]));
    expect(first.every(Number.isInteger)).toBe(true);
  });

  it("does not serialize administration for a different guild/thread lock key", async () => {
    const [key1, key2] = scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]);
    let releaseLock: (() => void) | undefined;
    let notifyLockHeld: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      notifyLockHeld = resolve;
    });
    const holdTransaction = database.client.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${key1}::integer, ${key2}::integer)`,
      );
      notifyLockHeld?.();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await lockHeld;

    try {
      await expect(
        store.createOrReplace({
          scheduledActionId: "different-lock-action",
          auditId: "different-lock-audit",
          guildId: guildIds[1],
          threadId: threadIds[1],
          actorId: "actor-id",
          executeAt: new Date("2030-06-15T00:00:00Z"),
        }),
      ).resolves.toMatchObject({ outcome: "CREATED" });
    } finally {
      releaseLock?.();
      await holdTransaction;
    }
  });

  it("installs only the intended audit table fields, checks, and indexes", async () => {
    const columns = await database.client.execute<{ columnName: string; dataType: string }>(sql`
      select column_name as "columnName", data_type as "dataType"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'scheduled_thread_close_audits'
      order by ordinal_position
    `);
    expect(columns.rows.map((row) => row.columnName)).toEqual([
      "id",
      "scheduled_action_id",
      "guild_id",
      "thread_id",
      "event",
      "actor_type",
      "actor_id",
      "previous_scheduled_action_id",
      "previous_execute_at",
      "execute_at",
      "outcome",
      "failure_code",
      "created_at",
    ]);
    expect(columns.rows.find((row) => row.columnName === "execute_at")?.dataType).toBe(
      "timestamp with time zone",
    );

    const indexes = await database.client.execute<{ indexName: string }>(sql`
      select indexname as "indexName"
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'scheduled_thread_close_audits'
      order by indexname
    `);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "scheduled_thread_close_audits_action_id_idx",
      "scheduled_thread_close_audits_guild_thread_created_at_idx",
      "scheduled_thread_close_audits_pkey",
    ]);

    const foreignKeys = await database.client.execute<{ count: string }>(sql`
      select count(*)::text as count
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'scheduled_thread_close_audits'
        and constraint_type = 'FOREIGN KEY'
    `);
    expect(foreignKeys.rows[0]?.count).toBe("0");
  });
});

async function cleanup(): Promise<void> {
  await database.client
    .delete(scheduledThreadCloseAudits)
    .where(inArray(scheduledThreadCloseAudits.guildId, guildIds));
  await database.client
    .delete(scheduledActions)
    .where(
      or(
        inArray(scheduledActions.guildId, guildIds),
        and(
          eq(scheduledActions.actionType, "CLOSE_THREAD"),
          inArray(scheduledActions.targetId, threadIds),
        ),
      ),
    );
}
