import { ChannelType, HTTPError, PermissionFlagsBits, Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "discord.js";

import {
  classifyThreadDiscordMutationFailure,
  createAutoCloseDiscord,
  createAutomaticCloseThreadMaintenanceDiscord,
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

describe("automatic close thread maintenance inspection", () => {
  it.each([ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread])(
    "accepts supported thread type %s with one fresh channel fetch",
    async (type) => {
      const fixture = createMaintenanceClient({ type });
      const discord = createAutomaticCloseThreadMaintenanceDiscord(fixture.client);

      await expect(discord.inspectThread("guild-id", "thread-id", "actor-id")).resolves.toEqual({
        parentChannelId: "parent-id",
        actorCanManage: true,
      });
      expect(fixture.fetchChannel).toHaveBeenCalledExactlyOnceWith("thread-id", { force: true });
      expect(fixture.fetchMember).toHaveBeenCalledExactlyOnceWith({
        user: "actor-id",
        force: true,
      });
      expect(fixture.permissionsFor).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["non-thread", { type: ChannelType.GuildText, isThread: () => false }],
    ["unsupported thread", { type: ChannelType.GuildText, isThread: () => true }],
    ["guild mismatch", { guildId: "other-guild" }],
    ["parentless", { parentId: null }],
  ])("rejects %s resources before fetching the member", async (_label, override) => {
    const fixture = createMaintenanceClient(override);
    const discord = createAutomaticCloseThreadMaintenanceDiscord(fixture.client);

    await expect(
      discord.inspectThread("guild-id", "thread-id", "actor-id"),
    ).resolves.toBeUndefined();
    expect(fixture.fetchChannel).toHaveBeenCalledOnce();
    expect(fixture.fetchMember).not.toHaveBeenCalled();
  });

  it("returns the actor's actual ManageThreads permission only", async () => {
    const fixture = createMaintenanceClient({ canManage: false });
    const discord = createAutomaticCloseThreadMaintenanceDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id", "actor-id")).resolves.toEqual({
      parentChannelId: "parent-id",
      actorCanManage: false,
    });
    expect(fixture.permissionHas).toHaveBeenCalledExactlyOnceWith(
      PermissionFlagsBits.ManageThreads,
    );
  });

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])("accepts archived=%s locked=%s without checking bot permissions", async (archived, locked) => {
    const fixture = createMaintenanceClient({ archived, locked, clientUser: null });
    const discord = createAutomaticCloseThreadMaintenanceDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id", "actor-id")).resolves.toMatchObject(
      { actorCanManage: true },
    );
    expect(fixture.fetchChannel).toHaveBeenCalledOnce();
  });

  it("propagates unexpected Discord failures", async () => {
    const failure = new Error("opaque Discord failure");
    const fetchChannel = vi.fn(() => Promise.reject(failure));
    const discord = createAutomaticCloseThreadMaintenanceDiscord({
      channels: { fetch: fetchChannel },
    } as unknown as Client);

    await expect(discord.inspectThread("guild-id", "thread-id", "actor-id")).rejects.toBe(failure);
    expect(fetchChannel).toHaveBeenCalledExactlyOnceWith("thread-id", { force: true });
  });
});

function createMaintenanceClient(
  overrides: {
    type?: ChannelType;
    guildId?: string;
    parentId?: string | null;
    isThread?: () => boolean;
    canManage?: boolean;
    archived?: boolean;
    locked?: boolean;
    clientUser?: { id: string } | null;
  } = {},
) {
  const fetchMember = vi.fn(() => Promise.resolve({ id: "actor-id" }));
  const permissionHas = vi.fn(() => overrides.canManage ?? true);
  const permissionsFor = vi.fn(() => ({ has: permissionHas }));
  const channel = {
    id: "thread-id",
    type: overrides.type ?? ChannelType.PublicThread,
    guildId: overrides.guildId ?? "guild-id",
    parentId: overrides.parentId === undefined ? "parent-id" : overrides.parentId,
    archived: overrides.archived ?? false,
    locked: overrides.locked ?? false,
    isThread: overrides.isThread ?? (() => true),
    guild: { members: { fetch: fetchMember } },
    permissionsFor,
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    channels: { fetch: fetchChannel },
    user: overrides.clientUser ?? null,
  } as unknown as Client;
  return { client, fetchChannel, fetchMember, permissionsFor, permissionHas };
}
