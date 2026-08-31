import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createManagedMessageStore,
  managedMessages,
} from "../../src/managed-message-persistence.js";

const guildId = "700000000000000043";
const channelId = "800000000000000043";
const creatorUserId = "900000000000000043";
const createdAt = new Date("2026-08-31T07:08:09.123Z");
const database = createDatabase(loadTestDatabaseConfig());
const store = createManagedMessageStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("managed message persistence", () => {
  it("stores all fields with database-owned initial state and timestamps", async () => {
    const input = creation("999999999999999901", "Plain text https://example.invalid/path");
    const row = await store.create(input);

    expect(row).toMatchObject({
      ...input,
      revision: 1,
      status: "ACTIVE",
    });
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.createdAt.getTime()).toBe(createdAt.getTime());
    expect(row.messageId).toBe("999999999999999901");
  });

  it("accepts the exact 2000-code-point boundary including Unicode", async () => {
    const content = "😀".repeat(2_000);
    await expect(store.create(creation("999999999999999902", content))).resolves.toMatchObject({
      content,
    });
  });

  it("rejects direct over-limit, revision zero, and non-ACTIVE state", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, created_at)
        values (${"999999999999999903"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"x".repeat(2_001)}, ${createdAt})
      `),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, created_at)
        values (${"999999999999999904"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, 0, ${createdAt})
      `),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, status, created_at)
        values (${"999999999999999905"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, ${"DELETED"}, ${createdAt})
      `),
    ).rejects.toThrow();
  });

  it("accepts revision one explicitly", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, created_at)
        values (${"999999999999999906"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, 1, ${createdAt})
      `),
    ).resolves.toBeDefined();
  });

  it("enforces primary-key uniqueness without overwriting", async () => {
    const input = creation("999999999999999907", "original");
    await store.create(input);
    await expect(store.create({ ...input, content: "replacement" })).rejects.toThrow();
    const [row] = await database.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, input.messageId));
    expect(row?.content).toBe("original");
  });

  it("confirms exact creation, missing rows, and every mutable exact-state mismatch", async () => {
    const input = creation("999999999999999908", "exact content");
    await store.create(input);
    await expect(store.confirmCreation(input)).resolves.toBe("MATCH");
    await expect(
      store.confirmCreation({ ...input, messageId: "999999999999999999" }),
    ).resolves.toBe("MISSING");

    for (const mismatch of [
      { guildId: "different-guild" },
      { channelId: "different-channel" },
      { creatorUserId: "different-user" },
      { content: "different content" },
      { createdAt: new Date(createdAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmCreation({ ...input, ...mismatch })).resolves.toBe("CONFLICT");
    }

    await database.client
      .update(managedMessages)
      .set({ revision: 2 })
      .where(eq(managedMessages.messageId, input.messageId));
    await expect(store.confirmCreation(input)).resolves.toBe("CONFLICT");
  });
});

function creation(messageId: string, content: string) {
  return { messageId, guildId, channelId, creatorUserId, content, createdAt };
}

async function cleanup(): Promise<void> {
  await database.client.delete(managedMessages).where(eq(managedMessages.guildId, guildId));
}
