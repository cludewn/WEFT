import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
} from "discord.js";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createScheduledMessageDiscord } from "../../src/scheduled-message-discord.js";

function fixture(
  options: {
    type?: ChannelType;
    guildId?: string;
    archived?: boolean | null;
    botCanSend?: boolean;
    botCanEmbed?: boolean;
    actorCanManage?: boolean;
    parentCanSendAfterFetch?: boolean;
    parentFetchFailure?: Error;
  } = {},
) {
  let parentRef = { id: "parent-id" };
  let parentRefreshed = false;
  const fetchParent = vi.fn(() => {
    if (options.parentFetchFailure) return Promise.reject(options.parentFetchFailure);
    parentRef = { id: "parent-id" };
    parentRefreshed = true;
    return Promise.resolve(parentRef);
  });
  const fetchMember = vi.fn((input: { user: string }) => Promise.resolve({ id: input.user }));
  const permissionChecks: bigint[] = [];
  const permissionsFor = vi.fn((member: { id: string }) => ({
    has: (permission: bigint | bigint[]) => {
      const values = Array.isArray(permission) ? permission : [permission];
      permissionChecks.push(...values);
      if (values.includes(PermissionFlagsBits.ManageMessages))
        return member.id === "actor-id" && (options.actorCanManage ?? true);
      if (values.includes(PermissionFlagsBits.EmbedLinks)) return options.botCanEmbed ?? true;
      if (parentRefreshed && options.parentCanSendAfterFetch !== undefined) {
        return options.parentCanSendAfterFetch;
      }
      return options.botCanSend ?? true;
    },
  }));
  const send = vi.fn(() =>
    Promise.resolve({
      id: "message-id",
      guildId: "guild-id",
      channelId: "channel-id",
      author: { id: "bot-id" },
      nonce: "stable-nonce",
      createdAt: new Date("2030-01-01T00:00:00Z"),
      content: "https://example.invalid",
      embeds: [],
    }),
  );
  const type = options.type ?? ChannelType.GuildText;
  const thread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type);
  const channel = {
    type,
    parentId: "parent-id",
    get parent() {
      return parentRef;
    },
    guildId: options.guildId ?? "guild-id",
    archived: options.archived ?? false,
    sendable: true,
    isThread: () => thread,
    guild: { members: { fetch: fetchMember }, channels: { fetch: fetchParent } },
    permissionsFor,
    send,
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    user: { id: "bot-id" },
    channels: { fetch: fetchChannel },
    rest: { delete: vi.fn(() => Promise.resolve()) },
  } as unknown as Client;
  return { client, fetchChannel, fetchMember, fetchParent, permissionChecks, send };
}

function discordApiError(code: number, status: number): DiscordAPIError {
  return new DiscordAPIError(
    { code, message: "structured Discord failure" },
    code,
    status,
    "GET",
    "https://discord.invalid/api/resource",
    { body: null, files: undefined },
  );
}

function httpError(status: number): HTTPError {
  return new HTTPError(status, "structured HTTP failure", "GET", "https://discord.invalid", {
    body: null,
    files: undefined,
  });
}

describe("scheduled message Discord boundary", () => {
  it("freshly authorizes the actor and bot for creation without sending", async () => {
    const f = fixture();
    await expect(
      createScheduledMessageDiscord(f.client).authorizeCreation({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "AUTHORIZED" });
    expect(f.fetchMember).toHaveBeenNthCalledWith(1, { user: "actor-id", force: true });
    expect(f.fetchMember).toHaveBeenNthCalledWith(2, { user: "bot-id", force: true });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("rejects missing actor permission and requires EmbedLinks only for explicit embeds", async () => {
    const deniedActor = fixture({ actorCanManage: false });
    await expect(
      createScheduledMessageDiscord(deniedActor.client).authorizeCreation({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" });
    expect(deniedActor.send).not.toHaveBeenCalled();

    const text = fixture({ botCanEmbed: false });
    await expect(
      createScheduledMessageDiscord(text.client).authorizeCreation({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        payload: { content: "https://example.invalid", embed: null },
      }),
    ).resolves.toEqual({ outcome: "AUTHORIZED" });

    const embed = fixture({ botCanEmbed: false });
    await expect(
      createScheduledMessageDiscord(embed.client).authorizeCreation({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        payload: { content: "", embed: { title: "title" } },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" });
  });

  it("uses refreshed parent overwrites for thread creation authorization", async () => {
    const f = fixture({ type: ChannelType.PublicThread, parentCanSendAfterFetch: false });
    await expect(
      createScheduledMessageDiscord(f.client).authorizeCreation({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" });
    expect(f.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
  });

  it.each([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])("preflights supported target type %s without querying the creator", async (type) => {
    const f = fixture({ type });
    const result = await createScheduledMessageDiscord(f.client).preflight({
      guildId: "guild-id",
      channelId: "channel-id",
      payload: { content: "text", embed: null },
    });
    expect(result).toMatchObject({ outcome: "READY" });
    expect(f.fetchChannel).toHaveBeenCalledWith("channel-id", { force: true });
    expect(f.fetchMember).toHaveBeenCalledExactlyOnceWith({ user: "bot-id", force: true });
    if (type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement) {
      expect(f.fetchParent).not.toHaveBeenCalled();
      expect(f.permissionChecks).toContain(PermissionFlagsBits.SendMessages);
      expect(f.permissionChecks).not.toContain(PermissionFlagsBits.SendMessagesInThreads);
    } else {
      expect(f.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
      expect(f.permissionChecks).toContain(PermissionFlagsBits.SendMessagesInThreads);
    }
  });

  it("distinguishes guild mismatch, archived thread, and missing bot permission", async () => {
    const mismatch = fixture({ guildId: "other-guild" });
    await expect(
      createScheduledMessageDiscord(mismatch.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toMatchObject({
      outcome: "FAILURE",
      code: "TARGET_GUILD_MISMATCH",
      retryable: false,
    });

    const archived = fixture({ type: ChannelType.PublicThread, archived: true });
    await expect(
      createScheduledMessageDiscord(archived.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "FAILURE", code: "ARCHIVED_THREAD", retryable: false });

    const denied = fixture({ botCanSend: false });
    await expect(
      createScheduledMessageDiscord(denied.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toMatchObject({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });
  });

  it("uses refreshed parent overwrites for scheduled and recurring thread sends", async () => {
    const f = fixture({ type: ChannelType.PublicThread, parentCanSendAfterFetch: false });
    await expect(
      createScheduledMessageDiscord(f.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING", retryable: false });
    expect(f.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("does not preflight from stale thread permissions if the parent refresh fails", async () => {
    const f = fixture({ type: ChannelType.PublicThread, parentFetchFailure: new Error("offline") });
    await expect(
      createScheduledMessageDiscord(f.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED", retryable: true });
    expect(f.send).not.toHaveBeenCalled();
  });

  it("distinguishes unsupported targets from transient current-state failures", async () => {
    const unsupported = fixture({ type: ChannelType.GuildVoice });
    await expect(
      createScheduledMessageDiscord(unsupported.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "UNSUPPORTED_TARGET", retryable: false });

    const transient = fixture();
    transient.fetchChannel.mockRejectedValue(new Error("temporary Discord failure"));
    await expect(
      createScheduledMessageDiscord(transient.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
  });

  it("classifies confirmed channel-fetch absence and access failures as terminal", async () => {
    const missing = fixture();
    missing.fetchChannel.mockRejectedValue(discordApiError(RESTJSONErrorCodes.UnknownChannel, 404));
    await expect(
      createScheduledMessageDiscord(missing.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "UNSUPPORTED_TARGET", retryable: false });

    const denied = fixture();
    denied.fetchChannel.mockRejectedValue(discordApiError(RESTJSONErrorCodes.MissingAccess, 403));
    await expect(
      createScheduledMessageDiscord(denied.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });
  });

  it.each([
    [400, "CURRENT_STATE_CHECK_REJECTED", false],
    [405, "CURRENT_STATE_CHECK_REJECTED", false],
    [408, "CURRENT_STATE_CHECK_FAILED", true],
    [425, "CURRENT_STATE_CHECK_FAILED", true],
    [429, "CURRENT_STATE_CHECK_FAILED", true],
    [503, "CURRENT_STATE_CHECK_FAILED", true],
  ] as const)(
    "classifies structured HTTP status %s without parsing its message",
    async (status, code, retryable) => {
      const f = fixture();
      f.fetchChannel.mockRejectedValue(
        status === 400
          ? discordApiError(RESTJSONErrorCodes.InvalidFormBodyOrContentType, status)
          : httpError(status),
      );
      await expect(
        createScheduledMessageDiscord(f.client).preflight({
          guildId: "guild-id",
          channelId: "channel-id",
          payload: { content: "text", embed: null },
        }),
      ).resolves.toEqual({
        outcome: "FAILURE",
        code,
        retryable,
      });
    },
  );

  it("classifies confirmed bot-member absence or access failure as terminal", async () => {
    const missingBot = fixture();
    missingBot.fetchMember.mockRejectedValue(
      discordApiError(RESTJSONErrorCodes.UnknownMember, 404),
    );
    await expect(
      createScheduledMessageDiscord(missingBot.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });

    const denied = fixture();
    denied.fetchMember.mockRejectedValue(
      discordApiError(RESTJSONErrorCodes.MissingPermissions, 403),
    );
    await expect(
      createScheduledMessageDiscord(denied.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "text", embed: null },
      }),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });
  });

  it("requires EmbedLinks only for an explicit managed embed", async () => {
    const text = fixture({ botCanEmbed: false });
    await expect(
      createScheduledMessageDiscord(text.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "https://example.invalid", embed: null },
      }),
    ).resolves.toMatchObject({ outcome: "READY" });

    const embed = fixture({ botCanEmbed: false });
    await expect(
      createScheduledMessageDiscord(embed.client).preflight({
        guildId: "guild-id",
        channelId: "channel-id",
        payload: { content: "", embed: { title: "title" } },
      }),
    ).resolves.toMatchObject({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" });
  });

  it("sends the exact nonce with mention suppression", async () => {
    const f = fixture();
    const discord = createScheduledMessageDiscord(f.client);
    const preflight = await discord.preflight({
      guildId: "guild-id",
      channelId: "channel-id",
      payload: { content: "https://example.invalid", embed: null },
    });
    if (preflight.outcome !== "READY") throw new Error("preflight failed");
    await expect(
      discord.createMessage({
        target: preflight.target,
        payload: { content: "https://example.invalid", embed: null },
        nonce: "stable-nonce",
      }),
    ).resolves.toMatchObject({ outcome: "CREATED", message: { nonce: "stable-nonce" } });
    expect(f.send).toHaveBeenCalledWith({
      content: "https://example.invalid",
      allowedMentions: { parse: [] },
      nonce: "stable-nonce",
      enforceNonce: true,
    });
  });
});
