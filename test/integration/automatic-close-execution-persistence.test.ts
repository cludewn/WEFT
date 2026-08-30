import { and, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
  autoCloseThreadRetirements,
  createAutomaticClosePersistenceStore,
} from "../../src/automatic-close-persistence.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild-settings.js";

const guildIds = ["execution-guild-one", "execution-guild-default"] as const;
const threadIds = ["execution-thread-one", "execution-thread-two"] as const;
const parentIds = ["execution-parent-one", "execution-parent-two"] as const;
const activityAt = new Date("2035-01-01T00:00:00.000Z");
const exactThreshold = new Date("2035-01-01T00:05:00.000Z");

const database = createDatabase(loadTestDatabaseConfig());
const store = createAutomaticClosePersistenceStore(database.client);
const settings = createGuildSettingsStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("automatic close episode retirement persistence", () => {
  it("retires only the exact current episode and removes it from candidate discovery", async () => {
    await seedEligibleEpisode();
    await expect(store.findInactiveCandidatesPage({ asOf: exactThreshold })).resolves.toHaveLength(
      1,
    );

    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: activityAt,
    });

    await expect(store.findInactiveCandidatesPage({ asOf: exactThreshold })).resolves.toEqual([]);
    await expect(
      store.isCandidateEpisodeEligible({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: activityAt,
        revalidatedAt: exactThreshold,
      }),
    ).resolves.toBe(false);
  });

  it("advances retirement monotonically and leaves equal or stale writes unchanged", async () => {
    const newer = new Date("2035-01-02T00:00:00.000Z");
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: activityAt,
    });
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: newer,
    });
    const advanced = await findRetirement(guildIds[0], threadIds[0]);

    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: newer,
    });
    await expect(findRetirement(guildIds[0], threadIds[0])).resolves.toEqual(advanced);

    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: activityAt,
    });
    await expect(findRetirement(guildIds[0], threadIds[0])).resolves.toEqual(advanced);
  });

  it("allows a newer activity episode to outgrow an older retirement", async () => {
    await seedEligibleEpisode();
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: activityAt,
    });
    const newerActivity = new Date("2035-01-02T00:00:00.000Z");
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      occurredAt: newerActivity,
    });

    await expect(
      store.findInactiveCandidatesPage({
        asOf: new Date(newerActivity.getTime() + 300_000),
      }),
    ).resolves.toEqual([
      {
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: newerActivity,
      },
    ]);
  });
});

describe("automatic close exact episode revalidation", () => {
  it("requires exact activity, parent, policy, and the inclusive inactivity threshold", async () => {
    await seedEligibleEpisode();
    const input = {
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      lastActivityAt: activityAt,
      revalidatedAt: exactThreshold,
    };

    await expect(store.isCandidateEpisodeEligible(input)).resolves.toBe(true);
    await expect(
      store.isCandidateEpisodeEligible({
        ...input,
        lastActivityAt: new Date(activityAt.getTime() - 1),
      }),
    ).resolves.toBe(false);
    await expect(
      store.isCandidateEpisodeEligible({ ...input, parentChannelId: parentIds[1] }),
    ).resolves.toBe(false);
    await expect(
      store.isCandidateEpisodeEligible({
        ...input,
        revalidatedAt: new Date(exactThreshold.getTime() - 1),
      }),
    ).resolves.toBe(false);

    await store.addThreadExclusion(guildIds[0], threadIds[0]);
    await expect(store.isCandidateEpisodeEligible(input)).resolves.toBe(false);
    await store.removeThreadExclusion(guildIds[0], threadIds[0]);
    await store.removeParentChannel(guildIds[0], parentIds[0]);
    await expect(store.isCandidateEpisodeEligible(input)).resolves.toBe(false);
  });

  it("returns false for missing activity and remains read-only", async () => {
    await settings.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    const before = await allState();

    await expect(
      store.isCandidateEpisodeEligible({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: activityAt,
        revalidatedAt: exactThreshold,
      }),
    ).resolves.toBe(false);
    await expect(allState()).resolves.toEqual(before);
  });

  it("uses the seven-day missing-settings default without inserting settings", async () => {
    const guildId = guildIds[1];
    await store.addParentChannel(guildId, parentIds[0]);
    await store.recordActivity({
      guildId,
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      occurredAt: activityAt,
    });
    const exactDefault = new Date(activityAt.getTime() + 604_800_000);

    await expect(
      store.isCandidateEpisodeEligible({
        guildId,
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: activityAt,
        revalidatedAt: new Date(exactDefault.getTime() - 1),
      }),
    ).resolves.toBe(false);
    await expect(
      store.isCandidateEpisodeEligible({
        guildId,
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: activityAt,
        revalidatedAt: exactDefault,
      }),
    ).resolves.toBe(true);
    await expect(
      database.client.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)),
    ).resolves.toEqual([]);
  });
});

describe("automatic close archived-thread re-entry persistence", () => {
  it("creates or advances an eligible baseline without moving equal or newer activity backward", async () => {
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.addParentChannel(guildIds[0], parentIds[1]);
    const reopenedAt = new Date("2035-02-01T00:00:00.000Z");

    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt,
      }),
    ).resolves.toBe(true);
    const inserted = await findActivity(guildIds[0], threadIds[0]);
    expect(inserted).toMatchObject({ lastActivityAt: reopenedAt, parentChannelId: parentIds[0] });

    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt,
      }),
    ).resolves.toBe(false);
    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toEqual(inserted);

    const newerMessage = new Date("2035-02-02T00:00:00.000Z");
    await expect(
      store.recordQualifyingMessageActivity({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[1],
        occurredAt: newerMessage,
        authorIsBot: false,
      }),
    ).resolves.toBe(true);
    const beforeStaleReopen = await findActivity(guildIds[0], threadIds[0]);
    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt,
      }),
    ).resolves.toBe(false);
    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toEqual(beforeStaleReopen);
  });

  it("advances an existing older row and updates its current parent", async () => {
    const createdAt = new Date("2020-01-01T00:00:00.000Z");
    const previousUpdatedAt = new Date("2020-01-02T00:00:00.000Z");
    const previousActivityAt = new Date("2035-01-01T00:00:00.000Z");
    const reopenedAt = new Date("2035-02-01T00:00:00.000Z");
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await database.client.insert(autoCloseThreadActivity).values({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[1],
      lastActivityAt: previousActivityAt,
      createdAt,
      updatedAt: previousUpdatedAt,
    });

    const updateStartedAt = new Date();
    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt,
      }),
    ).resolves.toBe(true);
    const updateFinishedAt = new Date();

    const advanced = await findActivity(guildIds[0], threadIds[0]);
    expect(advanced).toMatchObject({
      parentChannelId: parentIds[0],
      lastActivityAt: reopenedAt,
      createdAt,
    });
    expect(advanced!.updatedAt.getTime()).toBeGreaterThan(previousUpdatedAt.getTime());
    expect(advanced!.updatedAt.getTime()).toBeGreaterThanOrEqual(updateStartedAt.getTime());
    expect(advanced!.updatedAt.getTime()).toBeLessThanOrEqual(updateFinishedAt.getTime());
  });

  it("leaves an existing row unchanged when the current parent is disabled", async () => {
    await database.client.insert(autoCloseThreadActivity).values({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[1],
      lastActivityAt: activityAt,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    const before = await findActivity(guildIds[0], threadIds[0]);

    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt: new Date("2035-02-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(false);

    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toEqual(before);
  });

  it("leaves an existing row unchanged when the thread is excluded", async () => {
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.addThreadExclusion(guildIds[0], threadIds[0]);
    await database.client.insert(autoCloseThreadActivity).values({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[1],
      lastActivityAt: activityAt,
      createdAt: new Date("2020-01-01T00:00:00.000Z"),
      updatedAt: new Date("2020-01-02T00:00:00.000Z"),
    });
    const before = await findActivity(guildIds[0], threadIds[0]);

    await expect(
      store.recordThreadReentryBaseline({
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        reopenedAt: new Date("2035-02-01T00:00:00.000Z"),
      }),
    ).resolves.toBe(false);

    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toEqual(before);
  });

  it("does not create under a disabled parent or individual exclusion", async () => {
    const reopenedAt = new Date("2035-02-01T00:00:00.000Z");
    const input = {
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      reopenedAt,
    };

    await expect(store.recordThreadReentryBaseline(input)).resolves.toBe(false);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.addThreadExclusion(guildIds[0], threadIds[0]);
    await expect(store.recordThreadReentryBaseline(input)).resolves.toBe(false);
    await expect(findActivity(guildIds[0], threadIds[0])).resolves.toBeUndefined();
  });

  it("starts a new episode after retirement and becomes eligible at the reopen threshold", async () => {
    await settings.setAutoCloseInactivitySeconds(guildIds[0], 300);
    await store.addParentChannel(guildIds[0], parentIds[0]);
    await store.recordActivity({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      occurredAt: activityAt,
    });
    await store.retireActivityEpisode({
      guildId: guildIds[0],
      threadId: threadIds[0],
      lastActivityAt: activityAt,
    });
    const reopenedAt = new Date("2035-02-01T00:00:00.000Z");
    await store.recordThreadReentryBaseline({
      guildId: guildIds[0],
      threadId: threadIds[0],
      parentChannelId: parentIds[0],
      reopenedAt,
    });

    await expect(
      store.findInactiveCandidatesPage({ asOf: new Date(reopenedAt.getTime() + 300_000 - 1) }),
    ).resolves.toEqual([]);
    await expect(
      store.findInactiveCandidatesPage({ asOf: new Date(reopenedAt.getTime() + 300_000) }),
    ).resolves.toEqual([
      {
        guildId: guildIds[0],
        threadId: threadIds[0],
        parentChannelId: parentIds[0],
        lastActivityAt: reopenedAt,
      },
    ]);
  });
});

async function seedEligibleEpisode(): Promise<void> {
  await settings.setAutoCloseInactivitySeconds(guildIds[0], 300);
  await store.addParentChannel(guildIds[0], parentIds[0]);
  await store.recordActivity({
    guildId: guildIds[0],
    threadId: threadIds[0],
    parentChannelId: parentIds[0],
    occurredAt: activityAt,
  });
}

async function findActivity(guildId: string, threadId: string) {
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
}

async function findRetirement(guildId: string, threadId: string) {
  const [row] = await database.client
    .select()
    .from(autoCloseThreadRetirements)
    .where(
      and(
        eq(autoCloseThreadRetirements.guildId, guildId),
        eq(autoCloseThreadRetirements.threadId, threadId),
      ),
    )
    .limit(1);
  return row;
}

function allState() {
  return Promise.all([
    database.client
      .select()
      .from(autoCloseParentChannels)
      .where(inArray(autoCloseParentChannels.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadActivity)
      .where(inArray(autoCloseThreadActivity.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadExclusions)
      .where(inArray(autoCloseThreadExclusions.guildId, guildIds)),
    database.client
      .select()
      .from(autoCloseThreadRetirements)
      .where(inArray(autoCloseThreadRetirements.guildId, guildIds)),
    database.client.select().from(guildSettings).where(inArray(guildSettings.guildId, guildIds)),
  ]);
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(autoCloseThreadRetirements)
    .where(inArray(autoCloseThreadRetirements.guildId, guildIds));
  await database.client
    .delete(autoCloseThreadExclusions)
    .where(inArray(autoCloseThreadExclusions.guildId, guildIds));
  await database.client
    .delete(autoCloseThreadActivity)
    .where(inArray(autoCloseThreadActivity.guildId, guildIds));
  await database.client
    .delete(autoCloseParentChannels)
    .where(inArray(autoCloseParentChannels.guildId, guildIds));
  await database.client.delete(guildSettings).where(inArray(guildSettings.guildId, guildIds));
}
