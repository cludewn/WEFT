import { ChannelType } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createAutomaticCloseConfigurationService,
  type ActiveThreadSummary,
  type AutoCloseDiscord,
} from "../../src/automatic-close-configuration.js";
import type { AutomaticClosePersistenceStore } from "../../src/automatic-close-persistence.js";
import type { GuildSettings, GuildSettingsStore } from "../../src/guild-settings.js";

const guildId = "guild-id";
const parentChannelId = "parent-id";

const settings: GuildSettings = {
  guildId,
  timezone: "UTC",
  closedPrefix: "[CLOSED]",
  autoCloseInactivitySeconds: 604_800,
  autoCloseBotMessagesCountAsActivity: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("automatic close configuration service", () => {
  it("composes the configuration view", async () => {
    const fixture = createFixture({ configuredParents: ["b", "a"] });

    await expect(fixture.service.show(guildId)).resolves.toEqual({
      inactivitySeconds: 604_800,
      botMessagesCountAsActivity: false,
      parentChannelIds: ["b", "a"],
    });
  });

  it("returns an idempotent result without enumerating an already enabled parent", async () => {
    const fixture = createFixture({ configuredParents: [parentChannelId] });

    await expect(fixture.service.addParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "ALREADY_ENABLED",
    });

    expect(fixture.fetchActiveThreadSummaries).not.toHaveBeenCalled();
    expect(fixture.schedules.enableParentChannelWithBaselines).not.toHaveBeenCalled();
    expect(fixture.guildSettings.getOrCreate).not.toHaveBeenCalled();
  });

  it("does not enable the parent when active-thread enumeration fails", async () => {
    const fixture = createFixture();
    fixture.fetchActiveThreadSummaries.mockRejectedValueOnce(new Error("discord unavailable"));

    await expect(fixture.service.addParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "ENUMERATION_FAILED",
    });

    expect(fixture.schedules.enableParentChannelWithBaselines).not.toHaveBeenCalled();
    expect(fixture.guildSettings.getOrCreate).not.toHaveBeenCalled();
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "automatic_close_parent_enumeration_failed",
        errorName: "Error",
      }),
      expect.any(String),
    );
  });

  it("selects only supported threads under the requested parent", async () => {
    const fixture = createFixture({
      activeThreads: [
        { threadId: "public", parentId: parentChannelId, type: ChannelType.PublicThread },
        { threadId: "private", parentId: parentChannelId, type: ChannelType.PrivateThread },
        {
          threadId: "announcement",
          parentId: parentChannelId,
          type: ChannelType.AnnouncementThread,
        },
        { threadId: "other-parent", parentId: "other", type: ChannelType.PublicThread },
        { threadId: "orphan", parentId: null, type: ChannelType.PublicThread },
        { threadId: "not-a-thread", parentId: parentChannelId, type: ChannelType.GuildText },
      ],
    });

    await fixture.service.addParentChannel(guildId, parentChannelId);

    expect(fixture.schedules.enableParentChannelWithBaselines).toHaveBeenCalledOnce();
    const [input] = vi.mocked(fixture.schedules.enableParentChannelWithBaselines).mock.calls[0]!;
    expect(input.activeThreadIds).toEqual(["public", "private", "announcement"]);
    expect(input.guildId).toBe(guildId);
    expect(input.parentChannelId).toBe(parentChannelId);
  });

  it("captures the enable timestamp after enumeration and before persistence", async () => {
    const order: string[] = [];
    const fixture = createFixture();
    let enumerationCompletedAt = 0;
    fixture.fetchActiveThreadSummaries.mockImplementationOnce(async () => {
      order.push("enumerate");
      await Promise.resolve();
      enumerationCompletedAt = Date.now();
      return [];
    });
    vi.mocked(fixture.guildSettings.getOrCreate).mockImplementationOnce(() => {
      order.push("get-or-create");
      return Promise.resolve(settings);
    });
    vi.mocked(fixture.schedules.enableParentChannelWithBaselines).mockImplementationOnce(
      (input) => {
        order.push("enable");
        expect(input.enabledAt.getTime()).toBeGreaterThanOrEqual(enumerationCompletedAt);
        return Promise.resolve({ outcome: "ENABLED", baselinesApplied: 0 });
      },
    );

    await fixture.service.addParentChannel(guildId, parentChannelId);

    expect(order).toEqual(["enumerate", "get-or-create", "enable"]);
  });

  it("maps a lost enable race to an idempotent result", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.schedules.enableParentChannelWithBaselines).mockResolvedValueOnce({
      outcome: "ALREADY_ENABLED",
    });

    await expect(fixture.service.addParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "ALREADY_ENABLED",
    });
  });

  it("reports how many baselines were applied", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.schedules.enableParentChannelWithBaselines).mockResolvedValueOnce({
      outcome: "ENABLED",
      baselinesApplied: 4,
    });

    await expect(fixture.service.addParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "ENABLED",
      baselinesApplied: 4,
    });
  });

  it("maps parent removal outcomes", async () => {
    const fixture = createFixture();

    vi.mocked(fixture.schedules.removeParentChannel).mockResolvedValueOnce(true);
    await expect(fixture.service.removeParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "REMOVED",
    });

    vi.mocked(fixture.schedules.removeParentChannel).mockResolvedValueOnce(false);
    await expect(fixture.service.removeParentChannel(guildId, parentChannelId)).resolves.toEqual({
      outcome: "NOT_CONFIGURED",
    });
  });
});

function createFixture({
  configuredParents = [],
  activeThreads = [],
}: {
  configuredParents?: string[];
  activeThreads?: ActiveThreadSummary[];
} = {}) {
  const guildSettings = {
    getOrCreate: vi.fn(() => Promise.resolve(settings)),
    setAutoCloseInactivitySeconds: vi.fn(() => Promise.resolve(settings)),
    setAutoCloseBotMessagesCountAsActivity: vi.fn(() => Promise.resolve(settings)),
  } satisfies Pick<
    GuildSettingsStore,
    "getOrCreate" | "setAutoCloseInactivitySeconds" | "setAutoCloseBotMessagesCountAsActivity"
  >;

  const schedules = {
    listParentChannels: vi.fn(() => Promise.resolve(configuredParents)),
    enableParentChannelWithBaselines: vi.fn<
      AutomaticClosePersistenceStore["enableParentChannelWithBaselines"]
    >(() => Promise.resolve({ outcome: "ENABLED", baselinesApplied: 0 })),
    removeParentChannel: vi.fn(() => Promise.resolve(true)),
  } satisfies Pick<
    AutomaticClosePersistenceStore,
    "listParentChannels" | "enableParentChannelWithBaselines" | "removeParentChannel"
  >;

  const fetchActiveThreadSummaries = vi.fn<AutoCloseDiscord["fetchActiveThreadSummaries"]>(() =>
    Promise.resolve(activeThreads),
  );
  const logger = { warn: vi.fn() } as unknown as Pick<Logger, "warn">;

  const service = createAutomaticCloseConfigurationService({
    guildSettings,
    schedules,
    discord: { fetchActiveThreadSummaries },
    logger,
  });

  return { service, guildSettings, schedules, fetchActiveThreadSummaries, logger };
}
