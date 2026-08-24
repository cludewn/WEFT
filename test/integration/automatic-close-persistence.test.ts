import { and, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
  createAutomaticClosePersistenceStore,
} from "../../src/automatic-close-persistence.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createGuildSettingsStore,
  DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
  guildSettings,
  InvalidAutoCloseInactivityError,
  MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
  MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
} from "../../src/guild-settings.js";

const guildIds = ["auto-close-guild-one", "auto-close-guild-two"] as const;
const threadIds = ["auto-close-thread-one", "auto-close-thread-two"] as const;
const parentChannelIds = ["auto-close-parent-one", "auto-close-parent-two"] as const;

const database = createDatabase(loadTestDatabaseConfig());
const store = createAutomaticClosePersistenceStore(database.client);
const settingsStore = createGuildSettingsStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("automatic close guild policy persistence", () => {
  it("creates a new guild with the approved automatic-close defaults", async () => {
    await expect(settingsStore.getOrCreate(guildIds[0])).resolves.toMatchObject({
      autoCloseInactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
      autoCloseBotMessagesCountAsActivity: false,
    });
  });

  it("accepts the exact supported inactivity bounds", async () => {
    await expect(
      settingsStore.setAutoCloseInactivitySeconds(
        guildIds[0],
        MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
      ),
    ).resolves.toMatchObject({ autoCloseInactivitySeconds: 300 });
    await expect(
      settingsStore.setAutoCloseInactivitySeconds(
        guildIds[0],
        MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS,
      ),
    ).resolves.toMatchObject({ autoCloseInactivitySeconds: 31_536_000 });
  });

  it("rejects out-of-range inactivity values before reaching the database", async () => {
    await expect(settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 299)).rejects.toThrow(
      InvalidAutoCloseInactivityError,
    );
    await expect(
      settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 31_536_001),
    ).rejects.toThrow(InvalidAutoCloseInactivityError);
  });

  it("rejects out-of-range inactivity values at the database check constraint", async () => {
    await settingsStore.getOrCreate(guildIds[0]);

    for (const invalid of [299, 31_536_001]) {
      await expect(
        database.client.execute(sql`
          update guild_settings
          set auto_close_inactivity_seconds = ${invalid}
          where guild_id = ${guildIds[0]}
        `),
      ).rejects.toThrow();
    }

    await expect(settingsStore.getOrCreate(guildIds[0])).resolves.toMatchObject({
      autoCloseInactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
    });
  });

  it("updates only the targeted guild and keeps guilds independent", async () => {
    await settingsStore.getOrCreate(guildIds[1]);

    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 900);
    await settingsStore.setAutoCloseBotMessagesCountAsActivity(guildIds[0], true);

    await expect(settingsStore.getOrCreate(guildIds[0])).resolves.toMatchObject({
      autoCloseInactivitySeconds: 900,
      autoCloseBotMessagesCountAsActivity: true,
    });
    await expect(settingsStore.getOrCreate(guildIds[1])).resolves.toMatchObject({
      autoCloseInactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
      autoCloseBotMessagesCountAsActivity: false,
    });
  });
});

describe("automatic close parent channel allowlist persistence", () => {
  const rowsFor = (guildId: string) =>
    database.client
      .select()
      .from(autoCloseParentChannels)
      .where(eq(autoCloseParentChannels.guildId, guildId));

  it("adds one row and reports the change", async () => {
    await expect(store.addParentChannel(guildIds[0], parentChannelIds[0])).resolves.toBe(true);

    const rows = await rowsFor(guildIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guildId: guildIds[0],
      parentChannelId: parentChannelIds[0],
    });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("treats a repeated add as an idempotent no-op", async () => {
    await store.addParentChannel(guildIds[0], parentChannelIds[0]);

    await expect(store.addParentChannel(guildIds[0], parentChannelIds[0])).resolves.toBe(false);
    await expect(rowsFor(guildIds[0])).resolves.toHaveLength(1);
  });

  it("removes a row and treats a repeated remove as an idempotent no-op", async () => {
    await store.addParentChannel(guildIds[0], parentChannelIds[0]);

    await expect(store.removeParentChannel(guildIds[0], parentChannelIds[0])).resolves.toBe(true);
    await expect(store.removeParentChannel(guildIds[0], parentChannelIds[0])).resolves.toBe(false);
    await expect(rowsFor(guildIds[0])).resolves.toEqual([]);
  });

  it("respects the guild and parent channel composite identity", async () => {
    await store.addParentChannel(guildIds[0], parentChannelIds[0]);
    await store.addParentChannel(guildIds[0], parentChannelIds[1]);
    await store.addParentChannel(guildIds[1], parentChannelIds[0]);

    await expect(store.removeParentChannel(guildIds[0], parentChannelIds[0])).resolves.toBe(true);

    await expect(rowsFor(guildIds[0])).resolves.toEqual([
      expect.objectContaining({ parentChannelId: parentChannelIds[1] }),
    ]);
    await expect(rowsFor(guildIds[1])).resolves.toEqual([
      expect.objectContaining({ parentChannelId: parentChannelIds[0] }),
    ]);
  });
});

describe("automatic close thread exclusion persistence", () => {
  const rowsFor = (guildId: string) =>
    database.client
      .select()
      .from(autoCloseThreadExclusions)
      .where(eq(autoCloseThreadExclusions.guildId, guildId));

  it("represents no individual exclusion as row absence", async () => {
    await expect(rowsFor(guildIds[0])).resolves.toEqual([]);
  });

  it("creates one exclusion row and treats a repeated exclusion as idempotent", async () => {
    await expect(store.addThreadExclusion(guildIds[0], threadIds[0])).resolves.toBe(true);
    await expect(store.addThreadExclusion(guildIds[0], threadIds[0])).resolves.toBe(false);

    const rows = await rowsFor(guildIds[0]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ guildId: guildIds[0], threadId: threadIds[0] });
    expect(rows[0]?.createdAt).toBeInstanceOf(Date);
  });

  it("removes an exclusion and treats a repeated removal as an idempotent no-op", async () => {
    await store.addThreadExclusion(guildIds[0], threadIds[0]);

    await expect(store.removeThreadExclusion(guildIds[0], threadIds[0])).resolves.toBe(true);
    await expect(store.removeThreadExclusion(guildIds[0], threadIds[0])).resolves.toBe(false);
    await expect(rowsFor(guildIds[0])).resolves.toEqual([]);
  });

  it("respects the guild and thread composite identity", async () => {
    await store.addThreadExclusion(guildIds[0], threadIds[0]);
    await store.addThreadExclusion(guildIds[0], threadIds[1]);
    await store.addThreadExclusion(guildIds[1], threadIds[0]);

    await expect(store.removeThreadExclusion(guildIds[0], threadIds[0])).resolves.toBe(true);

    await expect(rowsFor(guildIds[0])).resolves.toEqual([
      expect.objectContaining({ threadId: threadIds[1] }),
    ]);
    await expect(rowsFor(guildIds[1])).resolves.toEqual([
      expect.objectContaining({ threadId: threadIds[0] }),
    ]);
  });
});

describe("automatic close thread activity persistence", () => {
  const earlier = new Date("2030-01-01T00:00:00.000Z");
  const later = new Date("2030-01-02T00:00:00.000Z");

  const findActivity = async (guildId: string, threadId: string) => {
    const [row] = await database.client
      .select()
      .from(autoCloseThreadActivity)
      .where(
        and(
          eq(autoCloseThreadActivity.guildId, guildId),
          eq(autoCloseThreadActivity.threadId, threadId),
        ),
      )
      .limit(1);
    return row;
  };

  it("creates the activity row with its parent channel", async () => {
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[0],
      occurredAt: earlier,
    });

    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toMatchObject({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[0],
      lastActivityAt: earlier,
    });
  });

  it("advances last activity and updated_at for newer activity", async () => {
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[0],
      occurredAt: earlier,
    });
    const created = await findActivity(guildIds[0], threadIds[0]);

    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[1],
      occurredAt: later,
    });

    const advanced = await findActivity(guildIds[0], threadIds[0]);
    expect(advanced).toMatchObject({
      lastActivityAt: later,
      parentChannelId: parentChannelIds[1],
    });
    expect(advanced!.updatedAt.getTime()).toBeGreaterThanOrEqual(created!.updatedAt.getTime());
    expect(advanced!.createdAt.getTime()).toBe(created!.createdAt.getTime());
  });

  it.each([
    ["older", earlier],
    ["equal", later],
  ])("leaves the row unchanged for %s activity", async (_label, occurredAt) => {
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[0],
      occurredAt: later,
    });
    const before = await findActivity(guildIds[0], threadIds[0]);

    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[1],
      occurredAt,
    });

    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toEqual(before);
  });

  it("keeps the maximum timestamp when an older write commits after a newer write", async () => {
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[0],
      occurredAt: earlier,
    });

    const newerApplied = deferred<void>();
    const releaseNewer = deferred<void>();

    // Apply the newer timestamp inside a transaction that stays open, start the stale write while
    // it is still open, then commit. However the two statements interleave, the stale write can
    // only settle against the committed newer value, so the maximum timestamp must survive and the
    // stale parent channel must not be applied. This test does not assert that the stale write
    // entered a row-lock wait; concurrent convergence is covered separately.
    const newerWrite = database.client.transaction(async (transaction) => {
      await transaction
        .update(autoCloseThreadActivity)
        .set({ lastActivityAt: later, updatedAt: new Date() })
        .where(
          and(
            eq(autoCloseThreadActivity.guildId, guildIds[0]),
            eq(autoCloseThreadActivity.threadId, threadIds[0]),
          ),
        );
      newerApplied.resolve(undefined);
      await releaseNewer.promise;
    });

    await newerApplied.promise;
    const olderWrite = store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentChannelIds[1],
      occurredAt: earlier,
    });
    releaseNewer.resolve(undefined);

    await newerWrite;
    await olderWrite;

    const rows = await database.client
      .select()
      .from(autoCloseThreadActivity)
      .where(eq(autoCloseThreadActivity.guildId, guildIds[0]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lastActivityAt: later,
      parentChannelId: parentChannelIds[0],
    });
  });

  it("converges on the maximum timestamp under concurrent writes", async () => {
    await Promise.all([
      store.recordActivity({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentChannelIds[0],
        occurredAt: later,
      }),
      store.recordActivity({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentChannelIds[0],
        occurredAt: earlier,
      }),
    ]);

    const rows = await database.client
      .select()
      .from(autoCloseThreadActivity)
      .where(eq(autoCloseThreadActivity.guildId, guildIds[0]));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lastActivityAt: later });
  });
});

async function cleanup(): Promise<void> {
  await database.client
    .delete(autoCloseParentChannels)
    .where(inArray(autoCloseParentChannels.guildId, guildIds));
  await database.client
    .delete(autoCloseThreadExclusions)
    .where(inArray(autoCloseThreadExclusions.guildId, guildIds));
  await database.client
    .delete(autoCloseThreadActivity)
    .where(inArray(autoCloseThreadActivity.guildId, guildIds));
  await database.client.delete(guildSettings).where(inArray(guildSettings.guildId, guildIds));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
