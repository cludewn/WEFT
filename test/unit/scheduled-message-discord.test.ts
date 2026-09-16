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
  } = {},
) {
  const fetchMember = vi.fn(() => Promise.resolve({ id: "bot-id" }));
  const permissionChecks: bigint[] = [];
  const permissionsFor = vi.fn(() => ({
    has: (permission: bigint | bigint[]) => {
      const values = Array.isArray(permission) ? permission : [permission];
      permissionChecks.push(...values);
      if (values.includes(PermissionFlagsBits.EmbedLinks)) return options.botCanEmbed ?? true;
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
    guildId: options.guildId ?? "guild-id",
    archived: options.archived ?? false,
    sendable: true,
    isThread: () => thread,
    guild: { members: { fetch: fetchMember } },
    permissionsFor,
    send,
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    user: { id: "bot-id" },
    channels: { fetch: fetchChannel },
    rest: { delete: vi.fn(() => Promise.resolve()) },
  } as unknown as Client;
  return { client, fetchChannel, fetchMember, permissionChecks, send };
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
