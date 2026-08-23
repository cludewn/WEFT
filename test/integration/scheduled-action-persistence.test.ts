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

  it("installs timestamptz and the required partial indexes", async () => {
    const column = await database.client.execute<{ dataType: string }>(sql`
      select data_type as "dataType"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'scheduled_actions'
        and column_name = 'execute_at'
    `);
    expect(column.rows[0]?.dataType).toBe("timestamp with time zone");

    const indexes = await database.client.execute<{ indexName: string }>(sql`
      select indexname as "indexName"
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
  });
});

async function cleanup(): Promise<void> {
  await database.client
    .delete(scheduledActions)
    .where(
      and(eq(scheduledActions.guildId, guildId), inArray(scheduledActions.targetId, targetIds)),
    );
}
