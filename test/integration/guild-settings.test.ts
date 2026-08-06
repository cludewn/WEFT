import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createGuildSettingsStore,
  DEFAULT_CLOSED_PREFIX,
  DEFAULT_GUILD_TIMEZONE,
  guildSettings,
} from "../../src/guild-settings.js";

const guildIds = ["100000000000000001", "100000000000000002", "100000000000000003"] as const;
const database = createDatabase(loadTestDatabaseConfig());
const store = createGuildSettingsStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await deleteTestSettings();
});

afterAll(async () => {
  await deleteTestSettings();
  await database.close();
});

describe("guild settings persistence", () => {
  it("creates default settings without overwriting existing values", async () => {
    const created = await store.getOrCreate(guildIds[0]);
    expect(created).toMatchObject({
      guildId: guildIds[0],
      timezone: DEFAULT_GUILD_TIMEZONE,
      closedPrefix: DEFAULT_CLOSED_PREFIX,
    });

    await store.setTimezone(guildIds[0], "Asia/Tokyo");
    await store.setClosedPrefix(guildIds[0], "[DONE]");

    const existing = await store.getOrCreate(guildIds[0]);
    expect(existing).toMatchObject({ timezone: "Asia/Tokyo", closedPrefix: "[DONE]" });
  });

  it("stores settings separately for each guild", async () => {
    await store.getOrCreate(guildIds[1]);
    await store.setTimezone(guildIds[1], "Europe/Paris");

    await expect(store.getOrCreate(guildIds[0])).resolves.toMatchObject({
      timezone: "Asia/Tokyo",
    });
    await expect(store.getOrCreate(guildIds[1])).resolves.toMatchObject({
      timezone: "Europe/Paris",
      closedPrefix: DEFAULT_CLOSED_PREFIX,
    });
  });

  it("handles concurrent default creation idempotently", async () => {
    const results = await Promise.all([
      store.getOrCreate(guildIds[2]),
      store.getOrCreate(guildIds[2]),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((settings) => settings.timezone === DEFAULT_GUILD_TIMEZONE)).toBe(true);
  });
});

async function deleteTestSettings(): Promise<void> {
  await database.client.delete(guildSettings).where(inArray(guildSettings.guildId, guildIds));
}
