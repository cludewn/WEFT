import { ChannelType, Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "discord.js";

import { createThreadLifecycleDiscord, isSupportedThreadType } from "../../src/thread-discord.js";

describe("Discord thread support", () => {
  it("supports public, private, announcement, and forum-post thread types", () => {
    expect(isSupportedThreadType(ChannelType.PublicThread)).toBe(true);
    expect(isSupportedThreadType(ChannelType.PrivateThread)).toBe(true);
    expect(isSupportedThreadType(ChannelType.AnnouncementThread)).toBe(true);
    // Discord represents forum posts as public threads.
    expect(isSupportedThreadType(ChannelType.PublicThread)).toBe(true);
  });

  it("rejects non-thread channel types", () => {
    expect(isSupportedThreadType(ChannelType.GuildText)).toBe(false);
    expect(isSupportedThreadType(ChannelType.GuildForum)).toBe(false);
  });

  it("renames and archives with direct channel mutations", async () => {
    const patch = vi.fn(() => Promise.resolve({}));
    const discord = createThreadLifecycleDiscord({ rest: { patch } } as unknown as Client);
    const controller = new AbortController();

    await discord.renameThread("guild-id", "thread-id", "Renamed thread", controller.signal);
    await discord.archiveThread("guild-id", "thread-id", "Closed thread", controller.signal);

    expect(patch).toHaveBeenNthCalledWith(1, Routes.channel("thread-id"), {
      body: { name: "Renamed thread" },
      reason: "WEFT thread lifecycle update",
      signal: controller.signal,
    });
    expect(patch).toHaveBeenNthCalledWith(2, Routes.channel("thread-id"), {
      body: { name: "Closed thread", archived: true },
      reason: "WEFT soft close",
      signal: controller.signal,
    });
  });
});
