import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createManagedThreadStore,
  createThreadAuditStore,
  managedThreads,
  threadAudits,
} from "../../src/thread-persistence.js";

const guildId = "700000000000000001";
const threadIds = ["800000000000000001", "800000000000000002"] as const;
const database = createDatabase(loadTestDatabaseConfig());
const managedStore = createManagedThreadStore(database.client);
const auditStore = createThreadAuditStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("thread lifecycle persistence", () => {
  it("upserts closed state with its applied prefix and marks it open", async () => {
    await managedStore.saveClosed(guildId, threadIds[0], "[OLD]");
    await managedStore.saveClosed(guildId, threadIds[0], "[CLOSED]");

    await expect(managedStore.find(guildId, threadIds[0])).resolves.toMatchObject({
      guildId,
      threadId: threadIds[0],
      appliedPrefix: "[CLOSED]",
      lifecycleState: "CLOSED",
    });

    await managedStore.markOpen(guildId, threadIds[0]);
    await expect(managedStore.find(guildId, threadIds[0])).resolves.toMatchObject({
      lifecycleState: "OPEN",
      appliedPrefix: "[CLOSED]",
    });
  });

  it("stores success and classified failure audits with valid actors", async () => {
    await auditStore.record({
      guildId,
      threadId: threadIds[0],
      action: "CLOSE",
      actorType: "USER",
      actorId: "900000000000000001",
      outcome: "SUCCESS",
    });
    await auditStore.record({
      guildId,
      threadId: threadIds[1],
      action: "AUTO_OPEN",
      actorType: "SYSTEM",
      outcome: "FAILURE",
      failureCode: "DISCORD_RENAME_FAILED",
    });

    const rows = await database.client
      .select()
      .from(threadAudits)
      .where(eq(threadAudits.guildId, guildId));
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorType: "USER", outcome: "SUCCESS", failureCode: null }),
        expect.objectContaining({
          actorType: "SYSTEM",
          actorId: null,
          outcome: "FAILURE",
          failureCode: "DISCORD_RENAME_FAILED",
        }),
      ]),
    );
  });

  it("enforces lifecycle and audit consistency constraints", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_threads
          (guild_id, thread_id, applied_prefix, lifecycle_state)
        values (${guildId}, ${threadIds[1]}, ${"[CLOSED]"}, ${"INVALID"})
      `),
    ).rejects.toThrow();

    await expect(
      database.client.execute(sql`
        insert into thread_audits
          (id, guild_id, thread_id, action, actor_type, outcome, failure_code)
        values (
          ${"invalid-audit"}, ${guildId}, ${threadIds[1]}, ${"OPEN"}, ${"SYSTEM"},
          ${"SUCCESS"}, ${"SHOULD_BE_NULL"}
        )
      `),
    ).rejects.toThrow();
  });
});

async function cleanup(): Promise<void> {
  await database.client.delete(threadAudits).where(eq(threadAudits.guildId, guildId));
  await database.client
    .delete(managedThreads)
    .where(and(eq(managedThreads.guildId, guildId), inArray(managedThreads.threadId, threadIds)));
}
