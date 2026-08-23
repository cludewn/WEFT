import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  ActiveScheduledCloseConflictError,
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";

const guildId = "710000000000000001";
const targetIds = [
  "810000000000000001",
  "810000000000000002",
  "810000000000000003",
  "810000000000000004",
  "810000000000000005",
  "810000000000000006",
  "810000000000000007",
  "810000000000000008",
  "810000000000000009",
  "810000000000000010",
] as const;
const database = createDatabase(loadTestDatabaseConfig());
const store = createScheduledActionStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("scheduled action persistence", () => {
  it("creates and loads the supported scheduling envelopes", async () => {
    const executeAt = new Date("2030-01-02T03:04:05.678Z");
    const close = await store.create({
      id: "scheduled-close",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[0],
      executeAt,
    });
    const message = await store.create({
      id: "scheduled-message",
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: targetIds[0],
      executeAt,
    });

    expect(close).toMatchObject({ status: "ACTIVE", executeAt });
    await expect(store.findById(close.id)).resolves.toEqual(close);
    await expect(store.findById(message.id)).resolves.toEqual(message);
    await expect(store.findById("missing-action")).resolves.toBeUndefined();
  });

  it("enforces action type and lifecycle status checks", async () => {
    await expect(
      database.client.execute(sql`
        insert into scheduled_actions
          (id, guild_id, action_type, target_id, status, execute_at)
        values (
          ${"invalid-action-type"}, ${guildId}, ${"UNKNOWN"}, ${targetIds[1]},
          ${"ACTIVE"}, ${new Date("2030-02-01T00:00:00Z")}
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.client.execute(sql`
        insert into scheduled_actions
          (id, guild_id, action_type, target_id, status, execute_at)
        values (
          ${"invalid-action-status"}, ${guildId}, ${"SEND_MESSAGE"}, ${targetIds[1]},
          ${"UNKNOWN"}, ${new Date("2030-02-01T00:00:00Z")}
        )
      `),
    ).rejects.toThrow();
  });

  it("maps only the active scheduled close conflict", async () => {
    await store.create({
      id: "unique-close-first",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[1],
      executeAt: new Date("2030-03-01T00:00:00Z"),
    });

    await expect(
      store.create({
        id: "unique-close-second",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[1],
        executeAt: new Date("2030-03-02T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(ActiveScheduledCloseConflictError);

    await expect(
      store.create({
        id: "unique-close-first",
        guildId,
        actionType: "SEND_MESSAGE",
        targetId: targetIds[2],
        executeAt: new Date("2030-03-03T00:00:00Z"),
      }),
    ).rejects.not.toBeInstanceOf(ActiveScheduledCloseConflictError);
  });

  it("allows only one concurrent active close for a guild and thread", async () => {
    const results = await Promise.allSettled([
      store.create({
        id: "concurrent-close-first",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[2],
        executeAt: new Date("2030-04-01T00:00:00Z"),
      }),
      store.create({
        id: "concurrent-close-second",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[2],
        executeAt: new Date("2030-04-02T00:00:00Z"),
      }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [rejected] = results.filter((result) => result.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(ActiveScheduledCloseConflictError);

    const active = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.guildId, guildId),
          eq(scheduledActions.targetId, targetIds[2]),
          eq(scheduledActions.status, "ACTIVE"),
        ),
      );
    expect(active).toHaveLength(1);
  });

  it("cancels active actions idempotently and returns current terminal state", async () => {
    const active = await store.create({
      id: "cancelled-close",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[3],
      executeAt: new Date("2030-05-01T00:00:00Z"),
    });
    const cancelled = await store.cancel(active.id);
    const cancelledAgain = await store.cancel(active.id);

    expect(cancelled).toMatchObject({ status: "CANCELLED" });
    expect(cancelledAgain).toEqual(cancelled);

    const replacementSlot = await store.create({
      id: "close-after-cancel",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[3],
      executeAt: new Date("2030-05-02T00:00:00Z"),
    });
    expect(replacementSlot.status).toBe("ACTIVE");

    const [completed] = await database.client
      .insert(scheduledActions)
      .values({
        id: "completed-close",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[4],
        status: "COMPLETED",
        executeAt: new Date("2030-05-03T00:00:00Z"),
      })
      .returning();
    const [failed] = await database.client
      .insert(scheduledActions)
      .values({
        id: "failed-close",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[4],
        status: "FAILED",
        executeAt: new Date("2030-05-04T00:00:00Z"),
      })
      .returning();
    const activeWithTerminalRows = await store.create({
      id: "active-with-terminal-closes",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[4],
      executeAt: new Date("2030-05-05T00:00:00Z"),
    });

    await expect(store.cancel(completed!.id)).resolves.toEqual(completed);
    await expect(store.cancel(failed!.id)).resolves.toEqual(failed);
    await expect(store.cancel("missing-action")).resolves.toBeUndefined();
    expect(activeWithTerminalRows.status).toBe("ACTIVE");
  });

  it("allows only one concurrent execution claim", async () => {
    const action = await store.create({
      id: "concurrent-claim",
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: targetIds[5],
      executeAt: new Date("2030-06-01T00:00:00Z"),
    });

    const claims = await Promise.all([
      store.claimExecution(action.id),
      store.claimExecution(action.id),
    ]);

    const successfulClaims = claims.filter((claim) => claim.transitioned);
    const rejectedClaims = claims.filter((claim) => !claim.transitioned);
    expect(successfulClaims).toHaveLength(1);
    expect(successfulClaims[0]?.current.status).toBe("EXECUTING");
    expect(rejectedClaims).toHaveLength(1);
    expect(rejectedClaims[0]?.current?.status).toBe("EXECUTING");
  });

  it("linearizes a concurrent claim and cancel at the ACTIVE transition", async () => {
    const action = await store.create({
      id: "claim-cancel-race",
      guildId,
      actionType: "SEND_MESSAGE",
      targetId: targetIds[6],
      executeAt: new Date("2030-06-02T00:00:00Z"),
    });

    const [claim, cancelled] = await Promise.all([
      store.claimExecution(action.id),
      store.cancel(action.id),
    ]);
    const current = await store.findById(action.id);

    expect(["EXECUTING", "CANCELLED"]).toContain(current?.status);
    if (current?.status === "EXECUTING") {
      expect(claim.transitioned).toBe(true);
      expect(cancelled?.status).toBe("EXECUTING");
    } else {
      expect(claim.transitioned).toBe(false);
      expect(cancelled?.status).toBe("CANCELLED");
    }
  });

  it("keeps EXECUTING actions uncancellable and in the active close unique slot", async () => {
    const action = await store.create({
      id: "executing-close",
      guildId,
      actionType: "CLOSE_THREAD",
      targetId: targetIds[7],
      executeAt: new Date("2030-06-03T00:00:00Z"),
    });
    const claimed = await store.claimExecution(action.id);
    expect(claimed).toMatchObject({ transitioned: true, current: { status: "EXECUTING" } });
    const beforeCancel = claimed.current;

    await expect(store.cancel(action.id)).resolves.toEqual(beforeCancel);
    await expect(
      store.create({
        id: "close-conflicting-with-executing",
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: targetIds[7],
        executeAt: new Date("2030-06-04T00:00:00Z"),
      }),
    ).rejects.toBeInstanceOf(ActiveScheduledCloseConflictError);
  });

  it("conditionally completes, fails, and releases only EXECUTING actions", async () => {
    const inputs = [
      ["complete-transition", targetIds[8]],
      ["fail-transition", targetIds[9]],
      ["release-transition", targetIds[5]],
    ] as const;
    for (const [id, targetId] of inputs) {
      await store.create({
        id,
        guildId,
        actionType: "SEND_MESSAGE",
        targetId,
        executeAt: new Date("2030-07-01T00:00:00Z"),
      });
      await store.claimExecution(id);
    }

    await expect(store.completeExecution("complete-transition")).resolves.toMatchObject({
      transitioned: true,
      current: { status: "COMPLETED" },
    });
    await expect(store.failExecution("fail-transition")).resolves.toMatchObject({
      transitioned: true,
      current: { status: "FAILED" },
    });
    await expect(store.releaseExecutionForRetry("release-transition")).resolves.toMatchObject({
      transitioned: true,
      current: { status: "ACTIVE" },
    });

    await expect(store.failExecution("complete-transition")).resolves.toMatchObject({
      transitioned: false,
      current: { status: "COMPLETED" },
    });
    await expect(store.releaseExecutionForRetry("fail-transition")).resolves.toMatchObject({
      transitioned: false,
      current: { status: "FAILED" },
    });
    await expect(store.completeExecution("release-transition")).resolves.toMatchObject({
      transitioned: false,
      current: { status: "ACTIVE" },
    });
  });

  it("installs timestamptz and the required partial indexes", async () => {
    const column = await database.client.execute<{ dataType: string }>(sql`
      select data_type as "dataType"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'scheduled_actions'
        and column_name = 'execute_at'
    `);
    expect(column.rows[0]?.dataType).toBe("timestamp with time zone");

    const indexes = await database.client.execute<{
      indexName: string;
      indexDefinition: string;
    }>(sql`
      select indexname as "indexName", indexdef as "indexDefinition"
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'scheduled_actions'
        and indexname in (
          'scheduled_actions_active_close_unique',
          'scheduled_actions_active_execute_at_idx'
        )
    `);
    expect(indexes.rows.map((row) => row.indexName).sort()).toEqual([
      "scheduled_actions_active_close_unique",
      "scheduled_actions_active_execute_at_idx",
    ]);
    expect(
      indexes.rows.find((row) => row.indexName === "scheduled_actions_active_close_unique")
        ?.indexDefinition,
    ).toContain("status = ANY (ARRAY['ACTIVE'::text, 'EXECUTING'::text])");
    expect(
      indexes.rows.find((row) => row.indexName === "scheduled_actions_active_execute_at_idx")
        ?.indexDefinition,
    ).toContain("status = 'ACTIVE'::text");
  });
});

async function cleanup(): Promise<void> {
  await database.client
    .delete(scheduledActions)
    .where(
      and(eq(scheduledActions.guildId, guildId), inArray(scheduledActions.targetId, targetIds)),
    );
}
