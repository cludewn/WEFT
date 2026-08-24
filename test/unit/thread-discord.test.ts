import { ChannelType, HTTPError, Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "discord.js";

import {
  classifyThreadDiscordMutationFailure,
  createAutoCloseDiscord,
  createThreadLifecycleDiscord,
  isSupportedThreadType,
} from "../../src/thread-discord.js";

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

    await discord.renameThread("guild-id", "thread-id", "Renamed thread");
    await discord.archiveThread("guild-id", "thread-id", "Closed thread");

    expect(patch).toHaveBeenNthCalledWith(1, Routes.channel("thread-id"), {
      body: { name: "Renamed thread" },
      reason: "WEFT thread lifecycle update",
    });
    expect(patch).toHaveBeenNthCalledWith(2, Routes.channel("thread-id"), {
      body: { name: "Closed thread", archived: true },
      reason: "WEFT soft close",
    });
  });

  it("classifies public REST errors without parsing messages", () => {
    const request = { body: undefined, files: undefined };
    expect(
      classifyThreadDiscordMutationFailure(
        new HTTPError(403, "Forbidden", "PATCH", "https://discord.invalid", request),
      ),
    ).toBe("PERMANENT");
    expect(
      classifyThreadDiscordMutationFailure(
        new HTTPError(503, "Unavailable", "PATCH", "https://discord.invalid", request),
      ),
    ).toBe("RETRYABLE");
    expect(classifyThreadDiscordMutationFailure(new Error("transport failure"))).toBe("RETRYABLE");
  });
});

describe("automatic close active thread enumeration", () => {
  it("reads the guild active threads once and projects the minimum thread facts", async () => {
    const fetchActiveThreads = vi.fn(() =>
      Promise.resolve({
        threads: new Map([
          [
            "thread-one",
            { id: "thread-one", parentId: "parent-one", type: ChannelType.PublicThread },
          ],
          ["thread-two", { id: "thread-two", parentId: null, type: ChannelType.PrivateThread }],
        ]),
      }),
    );
    const fetchGuild = vi.fn(() => Promise.resolve({ channels: { fetchActiveThreads } }));
    const discord = createAutoCloseDiscord({
      guilds: { fetch: fetchGuild },
    } as unknown as Client);

    await expect(discord.fetchActiveThreadSummaries("guild-id")).resolves.toEqual([
      { threadId: "thread-one", parentId: "parent-one", type: ChannelType.PublicThread },
      { threadId: "thread-two", parentId: null, type: ChannelType.PrivateThread },
    ]);

    expect(fetchGuild).toHaveBeenCalledExactlyOnceWith("guild-id");
    expect(fetchActiveThreads).toHaveBeenCalledOnce();
  });
});
