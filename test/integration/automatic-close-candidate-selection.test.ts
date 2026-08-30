import { inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
  autoCloseThreadRetirements,
  createAutomaticClosePersistenceStore,
  type AutomaticCloseCandidate,
} from "../../src/automatic-close-persistence.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild-settings.js";

const guildIds = ["candidate-guild-a", "candidate-guild-b", "candidate-guild-c"] as const;
const parentIds = ["candidate-parent-a", "candidate-parent-b"] as const;
const asOf = new Date("2035-01-15T12:00:00.000Z");

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

describe("automatic close candidate selection persistence", () => {
  it("returns only old activity under a currently allowlisted parent without an exclusion", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 3_600);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await insertActivities([
      activity("eligible", parentIds[0], secondsBeforeAsOf(3_600)),
      activity("wrong-parent", parentIds[1], secondsBeforeAsOf(7_200)),
      activity("excluded", parentIds[0], secondsBeforeAsOf(7_200)),
      activity("too-new", parentIds[0], secondsBeforeAsOf(3_599)),
    ]);
    await store.addThreadExclusion(guildIds[0], "excluded");

    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("eligible", parentIds[0], secondsBeforeAsOf(3_600)),
    ]);
  });

  it("uses an inclusive inactivity boundary", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 3_600);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    const exactBoundary = secondsBeforeAsOf(3_600);
    const oneMillisecondNewer = new Date(exactBoundary.getTime() + 1);
    await insertActivities([
      activity("exact-boundary", parentIds[0], exactBoundary),
      activity("one-millisecond-newer", parentIds[0], oneMillisecondNewer),
    ]);

    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("exact-boundary", parentIds[0], exactBoundary),
    ]);
  });

  it("applies each guild's current inactivity duration", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 3_600);
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[1], 7_200);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.addParentChannel(guildIds[1], parentIds[0]);
    const sharedActivityAt = secondsBeforeAsOf(5_400);
    await insertActivities([
      activity("shared-age", parentIds[0], sharedActivityAt, guildIds[0]),
      activity("shared-age", parentIds[0], sharedActivityAt, guildIds[1]),
    ]);

    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("shared-age", parentIds[0], sharedActivityAt, guildIds[0]),
    ]);
  });

  it("uses the seven-day default without creating missing guild settings", async () => {
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await insertActivities([
      activity("default-exact", parentIds[0], secondsBeforeAsOf(604_800)),
      activity("default-too-new", parentIds[0], secondsBeforeAsOf(604_799)),
    ]);

    await expect(settingsRows()).resolves.toEqual([]);
    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("default-exact", parentIds[0], secondsBeforeAsOf(604_800)),
    ]);
    await expect(settingsRows()).resolves.toEqual([]);
  });

  it("matches the stored parent identity and isolates exclusions by guild and thread", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[1], 300);
    await store.addParentChannel(guildIds[0], parentIds[1]);
    await store.addParentChannel(guildIds[1], parentIds[0]);
    const old = secondsBeforeAsOf(600);
    await insertActivities([
      activity("wrong-parent", parentIds[0], old, guildIds[0]),
      activity("kept", parentIds[1], old, guildIds[0]),
      activity("kept", parentIds[0], old, guildIds[1]),
    ]);
    await store.addThreadExclusion(guildIds[1], "another-thread");
    await store.addThreadExclusion(guildIds[2], "kept");

    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("kept", parentIds[1], old, guildIds[0]),
      candidate("kept", parentIds[0], old, guildIds[1]),
    ]);
  });

  it("orders equal timestamps by guild and thread and decodes every timestamp as Date", async () => {
    for (const guildId of [guildIds[0], guildIds[1]]) {
      await settingsStore.setAutoCloseInactivitySeconds(guildId, 300);
      await store.addParentChannel(guildId, parentIds[0]);
    }
    const earlier = secondsBeforeAsOf(900);
    const equal = secondsBeforeAsOf(600);
    await insertActivities([
      activity("thread-b", parentIds[0], equal, guildIds[0]),
      activity("thread-a", parentIds[0], equal, guildIds[1]),
      activity("thread-a", parentIds[0], equal, guildIds[0]),
      activity("thread-z", parentIds[0], earlier, guildIds[1]),
    ]);

    const result = await store.findInactiveCandidatesPage({ asOf });

    expect(result).toEqual([
      candidate("thread-z", parentIds[0], earlier, guildIds[1]),
      candidate("thread-a", parentIds[0], equal, guildIds[0]),
      candidate("thread-b", parentIds[0], equal, guildIds[0]),
      candidate("thread-a", parentIds[0], equal, guildIds[1]),
    ]);
    for (const row of result) {
      expect(row.lastActivityAt).toBeInstanceOf(Date);
      expect(row.lastActivityAt.toISOString()).toBe(
        row.threadId === "thread-z" ? earlier.toISOString() : equal.toISOString(),
      );
    }
  });

  it("paginates more than 100 equal-timestamp candidates without duplicates or omissions", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    const old = secondsBeforeAsOf(600);
    const expected = Array.from({ length: 205 }, (_, index) =>
      activity(`page-thread-${String(index).padStart(3, "0")}`, parentIds[0], old),
    );
    await insertActivities([...expected].reverse());

    const first = await store.findInactiveCandidatesPage({ asOf });
    expect(first).toHaveLength(100);
    const finalFirst = first.at(-1)!;
    const second = await store.findInactiveCandidatesPage({
      asOf,
      cursor: {
        lastActivityAt: finalFirst.lastActivityAt,
        guildId: finalFirst.guildId,
        threadId: finalFirst.threadId,
      },
    });

    expect(second).toHaveLength(100);
    expect(second[0]?.threadId).toBe("page-thread-100");
    const finalSecond = second.at(-1)!;
    const third = await store.findInactiveCandidatesPage({
      asOf,
      cursor: {
        lastActivityAt: finalSecond.lastActivityAt,
        guildId: finalSecond.guildId,
        threadId: finalSecond.threadId,
      },
    });

    expect(third).toHaveLength(5);
    expect(third[0]?.threadId).toBe("page-thread-200");
    const combined = [...first, ...second, ...third];
    expect(combined).toHaveLength(205);
    expect(new Set(combined.map(candidateKey)).size).toBe(205);
    expect(combined.map((row) => row.threadId)).toEqual(expected.map((row) => row.threadId));
  });

  it("applies the full strictly-after lexicographic cursor", async () => {
    for (const guildId of [guildIds[0], guildIds[1], guildIds[2]]) {
      await settingsStore.setAutoCloseInactivitySeconds(guildId, 300);
      await store.addParentChannel(guildId, parentIds[0]);
    }
    const beforeCursorAt = secondsBeforeAsOf(601);
    const cursorAt = secondsBeforeAsOf(600);
    const newer = secondsBeforeAsOf(599);
    await insertActivities([
      activity("thread-z", parentIds[0], beforeCursorAt, guildIds[2]),
      activity("thread-a", parentIds[0], cursorAt, guildIds[0]),
      activity("thread-a", parentIds[0], cursorAt, guildIds[1]),
      activity("thread-b", parentIds[0], cursorAt, guildIds[1]),
      activity("thread-c", parentIds[0], cursorAt, guildIds[1]),
      activity("thread-a", parentIds[0], cursorAt, guildIds[2]),
      activity("thread-z", parentIds[0], newer, guildIds[0]),
    ]);

    await expect(
      store.findInactiveCandidatesPage({
        asOf,
        cursor: { lastActivityAt: cursorAt, guildId: guildIds[1], threadId: "thread-b" },
      }),
    ).resolves.toEqual([
      candidate("thread-c", parentIds[0], cursorAt, guildIds[1]),
      candidate("thread-a", parentIds[0], cursorAt, guildIds[2]),
      candidate("thread-z", parentIds[0], newer, guildIds[0]),
    ]);
  });

  it("does not modify automatic-close policy or activity rows", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.addThreadExclusion(guildIds[0], "excluded");
    await insertActivities([
      activity("eligible", parentIds[0], secondsBeforeAsOf(600)),
      activity("excluded", parentIds[0], secondsBeforeAsOf(600)),
    ]);
    const before = await allRows();

    await store.findInactiveCandidatesPage({ asOf });

    await expect(allRows()).resolves.toEqual(before);
  });

  it("excludes only a retirement matching the current activity episode", async () => {
    await settingsStore.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    const retiredAt = secondsBeforeAsOf(900);
    const currentAt = secondsBeforeAsOf(600);
    await insertActivities([
      activity("exact-retirement", parentIds[0], retiredAt),
      activity("older-retirement", parentIds[0], currentAt),
    ]);
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: "exact-retirement",
      lastActivityAt: retiredAt,
    });
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: "older-retirement",
      lastActivityAt: retiredAt,
    });

    await expect(store.findInactiveCandidatesPage({ asOf })).resolves.toEqual([
      candidate("older-retirement", parentIds[0], currentAt),
    ]);
  });
});

function activity(
  threadId: string,
  parentChannelId: string,
  lastActivityAt: Date,
  guildId: string = guildIds[0],
) {
  return { guildId, threadId, parentChannelId, lastActivityAt };
}

function candidate(
  threadId: string,
  parentChannelId: string,
  lastActivityAt: Date,
  guildId: string = guildIds[0],
): AutomaticCloseCandidate {
  return { guildId, threadId, parentChannelId, lastActivityAt };
}

function secondsBeforeAsOf(seconds: number): Date {
  return new Date(asOf.getTime() - seconds * 1_000);
}

function candidateKey(candidateRow: AutomaticCloseCandidate): string {
  return `${candidateRow.guildId}:${candidateRow.threadId}`;
}

async function insertActivities(rows: (typeof autoCloseThreadActivity.$inferInsert)[]) {
  await database.client.insert(autoCloseThreadActivity).values(rows);
}

function settingsRows() {
  return database.client
    .select()
    .from(guildSettings)
    .where(inArray(guildSettings.guildId, guildIds));
}

function allRows() {
  return Promise.all([
    database.client
      .select()
      .from(autoCloseParentChannels)
      .where(inArray(autoCloseParentChannels.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadExclusions)
      .where(inArray(autoCloseThreadExclusions.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadActivity)
      .where(inArray(autoCloseThreadActivity.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadRetirements)
      .where(inArray(autoCloseThreadRetirements.guildId, guildIds)),
    settingsRows(),
  ]);
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(autoCloseThreadRetirements)
    .where(inArray(autoCloseThreadRetirements.guildId, guildIds));
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
