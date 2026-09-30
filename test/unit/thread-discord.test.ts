import { ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits, Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "discord.js";

import {
  classifyThreadDiscordMutationFailure,
  createAutoCloseDiscord,
  createAutomaticCloseExecutionDiscord,
  createAutomaticCloseThreadMaintenanceDiscord,
  createThreadLifecycleDiscord,
  isSupportedThreadType,
} from "../../src/thread-discord.js";

describe("Discord thread support", () => {
  it.each([true, false])(
    "force-fetches members and parent before lifecycle checks when refreshed permission is %s",
    async (allowedAfterRefresh) => {
      const parent = { id: "parent-id" };
      const fetchMember = vi.fn(({ user }: { user: string }) => Promise.resolve({ id: user }));
      let parentPermission = true;
      const fetchParent = vi.fn((id: string, options: unknown) => {
        expect(id).toBe("parent-id");
        expect(options).toEqual({ force: true });
        parentPermission = allowedAfterRefresh;
        return Promise.resolve(parent);
      });
      const permissionsFor = vi.fn(() => ({ has: () => parentPermission }));
      const guild = {
        channels: { fetch: vi.fn() },
        members: { fetch: fetchMember },
      };
      const thread = {
        id: "thread-id",
        guildId: "guild-id",
        type: ChannelType.PublicThread,
        parentId: "parent-id",
        parent,
        guild,
        isThread: () => true,
        permissionsFor,
      };
      guild.channels.fetch.mockImplementation((id: string, options: unknown) =>
        id === "thread-id" ? Promise.resolve(thread) : fetchParent(id, options),
      );
      const discord = createThreadLifecycleDiscord({
        guilds: { fetch: vi.fn(() => Promise.resolve(guild)) },
        user: { id: "bot-id" },
      } as unknown as Client);

      await expect(discord.actorCanManage("guild-id", "thread-id", "actor-id")).resolves.toBe(
        allowedAfterRefresh,
      );
      await expect(discord.botCanManage("guild-id", "thread-id")).resolves.toBe(
        allowedAfterRefresh,
      );
      expect(fetchMember).toHaveBeenCalledWith({ user: "actor-id", force: true });
      expect(fetchMember).toHaveBeenCalledWith({ user: "bot-id", force: true });
      expect(fetchParent).toHaveBeenCalledTimes(2);
      expect(permissionsFor).toHaveBeenCalledTimes(2);
    },
  );
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

  it.each([
    ["channel", 10_003, 404, "CONFIRMED_UNAVAILABLE"],
    ["guild", 10_004, 404, "CONFIRMED_UNAVAILABLE"],
    ["channel", 50_001, 403, "PERMANENT_UNCONFIRMED"],
    ["guild", 50_013, 403, "PERMANENT_UNCONFIRMED"],
    ["guild", 10_003, 404, "RETRYABLE"],
    ["channel", 10_004, 404, "RETRYABLE"],
    ["channel", 99_999, 404, "RETRYABLE"],
    ["channel", 50_001, 503, "RETRYABLE"],
  ] as const)(
    "classifies structured %s read code %s and status %s as %s",
    async (stage, code, status, classification) => {
      const request = { body: undefined, files: undefined };
      const error = new DiscordAPIError(
        { message: "opaque", code },
        code,
        status,
        "GET",
        "https://discord.invalid",
        request,
      );
      const fetchChannel = vi.fn(() => Promise.reject(error));
      const fetchGuild = vi.fn(() =>
        stage === "guild"
          ? Promise.reject(error)
          : Promise.resolve({ channels: { fetch: fetchChannel } }),
      );
      const discord = createThreadLifecycleDiscord({
        guilds: { fetch: fetchGuild },
      } as unknown as Client);
      const rejected = await discord.fetchThread("guild-id", "thread-id").then(
        () => undefined,
        (failure: unknown) => failure,
      );

      expect(discord.classifyReconciliationReadFailure(rejected)).toBe(classification);
      expect(fetchGuild).toHaveBeenCalledOnce();
      expect(fetchChannel).toHaveBeenCalledTimes(stage === "channel" ? 1 : 0);
    },
  );

  it.each([
    [401, "PERMANENT_UNCONFIRMED"],
    [403, "PERMANENT_UNCONFIRMED"],
    [404, "RETRYABLE"],
    [408, "RETRYABLE"],
    [425, "RETRYABLE"],
    [429, "RETRYABLE"],
    [503, "RETRYABLE"],
  ] as const)("classifies HTTP %s channel reads as %s", async (status, classification) => {
    const error = new HTTPError(status, "opaque", "GET", "https://discord.invalid", {
      body: undefined,
      files: undefined,
    });
    const discord = createThreadLifecycleDiscord({
      guilds: {
        fetch: vi.fn(() =>
          Promise.resolve({ channels: { fetch: vi.fn(() => Promise.reject(error)) } }),
        ),
      },
    } as unknown as Client);
    const rejected = await discord.fetchThread("guild-id", "thread-id").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(discord.classifyReconciliationReadFailure(rejected)).toBe(classification);
  });

  it.each([
    new Error("Unknown Channel"),
    Object.assign(new Error("transport"), { code: "ECONNRESET" }),
    new DOMException("aborted", "AbortError"),
    Object.assign(new Error("opaque"), { code: 50_001 }),
  ])("keeps unstructured read failures retryable", async (error) => {
    const discord = createThreadLifecycleDiscord({
      guilds: {
        fetch: vi.fn(() => Promise.reject(error)),
      },
    } as unknown as Client);
    const rejected = await discord.fetchThread("guild-id", "thread-id").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(discord.classifyReconciliationReadFailure(rejected)).toBe("RETRYABLE");
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

  it("rejects maintenance when a refreshed parent overwrite removes ManageThreads", async () => {
    const fixture = createMaintenanceClient({ parentCanManageAfterFetch: false });
    await expect(
      createAutomaticCloseThreadMaintenanceDiscord(fixture.client).inspectThread(
        "guild-id",
        "thread-id",
        "actor-id",
      ),
    ).resolves.toEqual({ parentChannelId: "parent-id", actorCanManage: false });
    expect(fixture.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
  });

  it("does not authorize maintenance from stale permissions after parent refresh fails", async () => {
    const fixture = createMaintenanceClient({ parentFetchFailure: new Error("offline") });
    await expect(
      createAutomaticCloseThreadMaintenanceDiscord(fixture.client).inspectThread(
        "guild-id",
        "thread-id",
        "actor-id",
      ),
    ).rejects.toThrow("offline");
    expect(fixture.permissionsFor).not.toHaveBeenCalled();
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

describe("automatic close execution inspection", () => {
  it("returns the current parent and archived state from one forced fetch", async () => {
    const fixture = createMaintenanceClient({ archived: true });
    const discord = createAutomaticCloseExecutionDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id")).resolves.toEqual({
      outcome: "AVAILABLE",
      parentChannelId: "parent-id",
      archived: true,
    });
    expect(fixture.fetchChannel).toHaveBeenCalledExactlyOnceWith("thread-id", { force: true });
    expect(fixture.fetchMember).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["non-thread", { type: ChannelType.GuildText, isThread: () => false }],
    ["unsupported thread", { type: ChannelType.GuildText, isThread: () => true }],
    ["wrong guild", { guildId: "other-guild" }],
    ["parentless", { parentId: null }],
  ])("confirms %s as unavailable", async (_label, channelOverride) => {
    const fixture =
      channelOverride === null
        ? createExecutionClientWithResult(null)
        : createMaintenanceClient(channelOverride);
    const discord = createAutomaticCloseExecutionDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id")).resolves.toEqual({
      outcome: "UNAVAILABLE",
    });
  });

  it("classifies Discord's public Unknown Channel code as unavailable", async () => {
    const request = { body: undefined, files: undefined };
    const unknownChannel = new DiscordAPIError(
      { message: "Unknown Channel", code: 10_003 },
      10_003,
      404,
      "GET",
      "https://discord.invalid",
      request,
    );
    const fixture = createExecutionClientWithFailure(unknownChannel);
    const discord = createAutomaticCloseExecutionDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id")).resolves.toEqual({
      outcome: "UNAVAILABLE",
    });
  });

  it.each([
    new Error("transport failure"),
    new HTTPError(503, "Unavailable", "GET", "https://discord.invalid", {
      body: undefined,
      files: undefined,
    }),
    new HTTPError(403, "Forbidden", "GET", "https://discord.invalid", {
      body: undefined,
      files: undefined,
    }),
  ])("propagates an unconfirmed inspection failure", async (failure) => {
    const fixture = createExecutionClientWithFailure(failure);
    const discord = createAutomaticCloseExecutionDiscord(fixture.client);

    await expect(discord.inspectThread("guild-id", "thread-id")).rejects.toBe(failure);
  });
});

function createMaintenanceClient(
  overrides: {
    type?: ChannelType;
    guildId?: string;
    parentId?: string | null;
    isThread?: () => boolean;
    canManage?: boolean;
    parentCanManageAfterFetch?: boolean;
    parentFetchFailure?: Error;
    archived?: boolean;
    locked?: boolean;
    clientUser?: { id: string } | null;
  } = {},
) {
  let parentRef = { id: "parent-id" };
  let parentRefreshed = false;
  const fetchParent = vi.fn(() => {
    if (overrides.parentFetchFailure) return Promise.reject(overrides.parentFetchFailure);
    parentRef = { id: "parent-id" };
    parentRefreshed = true;
    return Promise.resolve(parentRef);
  });
  const fetchMember = vi.fn(() => Promise.resolve({ id: "actor-id" }));
  const permissionHas = vi.fn(() =>
    parentRefreshed && overrides.parentCanManageAfterFetch !== undefined
      ? overrides.parentCanManageAfterFetch
      : (overrides.canManage ?? true),
  );
  const permissionsFor = vi.fn(() => ({ has: permissionHas }));
  const channel = {
    id: "thread-id",
    type: overrides.type ?? ChannelType.PublicThread,
    guildId: overrides.guildId ?? "guild-id",
    parentId: overrides.parentId === undefined ? "parent-id" : overrides.parentId,
    get parent() {
      return parentRef;
    },
    archived: overrides.archived ?? false,
    locked: overrides.locked ?? false,
    isThread: overrides.isThread ?? (() => true),
    guild: { members: { fetch: fetchMember }, channels: { fetch: fetchParent } },
    permissionsFor,
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    channels: { fetch: fetchChannel },
    user: overrides.clientUser ?? null,
  } as unknown as Client;
  return { client, fetchChannel, fetchParent, fetchMember, permissionsFor, permissionHas };
}

function createExecutionClientWithResult(channel: null) {
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  return {
    client: { channels: { fetch: fetchChannel } } as unknown as Client,
    fetchChannel,
  };
}

function createExecutionClientWithFailure(failure: Error) {
  const fetchChannel = vi.fn(() => Promise.reject(failure));
  return {
    client: { channels: { fetch: fetchChannel } } as unknown as Client,
    fetchChannel,
  };
}
