import { ChannelType } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import type {
  ActiveThreadSummary,
  AutoCloseDiscord,
} from "../../src/automatic-close-configuration.js";
import type {
  AutoCloseParentChannelRef,
  AutomaticClosePersistenceStore,
} from "../../src/automatic-close-persistence.js";
import { createAutomaticCloseBaselineReconciler } from "../../src/automatic-close-reconciler.js";

describe("automatic close baseline reconciler", () => {
  it("does not touch Discord when no parent channel is configured", async () => {
    const fixture = createFixture({ configured: [] });

    await fixture.reconciler.reconcileMissingBaselines();

    expect(fixture.discord.fetchActiveThreadSummaries).not.toHaveBeenCalled();
    expect(fixture.persistence.initializeMissingActivityBaselines).not.toHaveBeenCalled();
    expect(fixture.logger.info).not.toHaveBeenCalled();
  });

  it("fetches active threads once per configured guild", async () => {
    const fixture = createFixture({
      configured: [
        { guildId: "guild-a", parentChannelId: "parent-a1" },
        { guildId: "guild-a", parentChannelId: "parent-a2" },
        { guildId: "guild-b", parentChannelId: "parent-b1" },
      ],
    });

    await fixture.reconciler.reconcileMissingBaselines();

    expect(fixture.discord.fetchActiveThreadSummaries).toHaveBeenCalledTimes(2);
    expect(fixture.discord.fetchActiveThreadSummaries).toHaveBeenNthCalledWith(1, "guild-a");
    expect(fixture.discord.fetchActiveThreadSummaries).toHaveBeenNthCalledWith(2, "guild-b");
  });

  it("only initializes supported threads under configured parents", async () => {
    const fixture = createFixture({
      configured: [{ guildId: "guild-a", parentChannelId: "parent-a1" }],
      threadsByGuild: {
        "guild-a": [
          summary("kept-public", "parent-a1", ChannelType.PublicThread),
          summary("kept-private", "parent-a1", ChannelType.PrivateThread),
          summary("other-parent", "parent-zz", ChannelType.PublicThread),
          summary("orphan", null, ChannelType.PublicThread),
          summary("not-a-thread", "parent-a1", ChannelType.GuildText),
        ],
      },
    });

    await fixture.reconciler.reconcileMissingBaselines();

    expect(fixture.persistence.initializeMissingActivityBaselines).toHaveBeenCalledOnce();
    const [input] = vi.mocked(fixture.persistence.initializeMissingActivityBaselines).mock
      .calls[0]!;
    expect(input.guildId).toBe("guild-a");
    expect(input.candidates).toEqual([
      { threadId: "kept-public", parentChannelId: "parent-a1" },
      { threadId: "kept-private", parentChannelId: "parent-a1" },
    ]);
    expect(input.baselineAt).toBeInstanceOf(Date);
  });

  it("captures each guild's baseline after that guild's enumeration", async () => {
    const fixture = createFixture({
      configured: [
        { guildId: "guild-a", parentChannelId: "parent-a1" },
        { guildId: "guild-b", parentChannelId: "parent-b1" },
      ],
      threadsByGuild: {
        "guild-a": [summary("thread-a", "parent-a1", ChannelType.PublicThread)],
        "guild-b": [summary("thread-b", "parent-b1", ChannelType.PublicThread)],
      },
    });
    const enumerationCompletedAt: Record<string, number> = {};
    vi.mocked(fixture.discord.fetchActiveThreadSummaries).mockImplementation(
      async (guildId: string) => {
        await Promise.resolve();
        enumerationCompletedAt[guildId] = Date.now();
        return fixture.threadsByGuild[guildId] ?? [];
      },
    );

    await fixture.reconciler.reconcileMissingBaselines();

    const calls = vi.mocked(fixture.persistence.initializeMissingActivityBaselines).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [input] of calls) {
      expect(input.baselineAt.getTime()).toBeGreaterThanOrEqual(
        enumerationCompletedAt[input.guildId]!,
      );
    }
  });

  it("skips a guild whose enumeration fails without stopping other guilds", async () => {
    const fixture = createFixture({
      configured: [
        { guildId: "guild-a", parentChannelId: "parent-a1" },
        { guildId: "guild-b", parentChannelId: "parent-b1" },
      ],
      threadsByGuild: {
        "guild-b": [summary("thread-b", "parent-b1", ChannelType.PublicThread)],
      },
    });
    vi.mocked(fixture.discord.fetchActiveThreadSummaries).mockImplementation((guildId: string) =>
      guildId === "guild-a"
        ? Promise.reject(new RangeError("discord unavailable"))
        : Promise.resolve(fixture.threadsByGuild[guildId] ?? []),
    );

    await expect(fixture.reconciler.reconcileMissingBaselines()).resolves.toBeUndefined();

    expect(fixture.persistence.initializeMissingActivityBaselines).toHaveBeenCalledOnce();
    expect(
      vi.mocked(fixture.persistence.initializeMissingActivityBaselines).mock.calls[0]![0].guildId,
    ).toBe("guild-b");
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "automatic_close_baseline_enumeration_failed",
        guildId: "guild-a",
        errorName: "RangeError",
      }),
      expect.any(String),
    );
  });

  it("skips a guild whose baseline batch fails without stopping other guilds", async () => {
    const fixture = createFixture({
      configured: [
        { guildId: "guild-a", parentChannelId: "parent-a1" },
        { guildId: "guild-b", parentChannelId: "parent-b1" },
      ],
      threadsByGuild: {
        "guild-a": [summary("thread-a", "parent-a1", ChannelType.PublicThread)],
        "guild-b": [summary("thread-b", "parent-b1", ChannelType.PublicThread)],
      },
    });
    vi.mocked(fixture.persistence.initializeMissingActivityBaselines).mockImplementation((input) =>
      input.guildId === "guild-a"
        ? Promise.reject(new TypeError("database unavailable"))
        : Promise.resolve(1),
    );

    await expect(fixture.reconciler.reconcileMissingBaselines()).resolves.toBeUndefined();

    expect(fixture.persistence.initializeMissingActivityBaselines).toHaveBeenCalledTimes(2);
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "automatic_close_baseline_initialization_failed",
        guildId: "guild-a",
        errorName: "TypeError",
      }),
      expect.any(String),
    );
    expect(fixture.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ guildsReconciled: 1, guildsFailed: 1, baselinesInitialized: 1 }),
      expect.any(String),
    );
  });

  it("does not call the batch operation when a guild has no eligible thread", async () => {
    const fixture = createFixture({
      configured: [{ guildId: "guild-a", parentChannelId: "parent-a1" }],
      threadsByGuild: { "guild-a": [] },
    });

    await fixture.reconciler.reconcileMissingBaselines();

    expect(fixture.persistence.initializeMissingActivityBaselines).not.toHaveBeenCalled();
  });

  it("propagates a parent discovery failure for the caller to record once", async () => {
    const fixture = createFixture({ configured: [] });
    vi.mocked(fixture.persistence.listAllParentChannels).mockRejectedValueOnce(
      new Error("database unavailable"),
    );

    await expect(fixture.reconciler.reconcileMissingBaselines()).rejects.toThrow(
      "database unavailable",
    );
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });
});

function summary(
  threadId: string,
  parentId: string | null,
  type: ChannelType,
): ActiveThreadSummary {
  return { threadId, parentId, type };
}

function createFixture({
  configured = [],
  threadsByGuild = {},
}: {
  configured?: AutoCloseParentChannelRef[];
  threadsByGuild?: Record<string, ActiveThreadSummary[]>;
} = {}) {
  const persistence = {
    listAllParentChannels: vi.fn<AutomaticClosePersistenceStore["listAllParentChannels"]>(() =>
      Promise.resolve(configured),
    ),
    initializeMissingActivityBaselines: vi.fn<
      AutomaticClosePersistenceStore["initializeMissingActivityBaselines"]
    >(() => Promise.resolve(1)),
  } satisfies Pick<
    AutomaticClosePersistenceStore,
    "listAllParentChannels" | "initializeMissingActivityBaselines"
  >;

  const discord = {
    fetchActiveThreadSummaries: vi.fn<AutoCloseDiscord["fetchActiveThreadSummaries"]>((guildId) =>
      Promise.resolve(threadsByGuild[guildId] ?? []),
    ),
  } satisfies AutoCloseDiscord;

  const logger = { info: vi.fn(), warn: vi.fn() } as unknown as Pick<Logger, "info" | "warn">;
  const reconciler = createAutomaticCloseBaselineReconciler({ persistence, discord, logger });

  return { reconciler, persistence, discord, logger, threadsByGuild };
}
