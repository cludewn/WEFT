import { ChannelType, DiscordAPIError, HTTPError, PermissionFlagsBits, Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client } from "discord.js";

import {
  createManagedMessageDiscord,
  isSupportedManagedMessageTargetType,
} from "../../src/managed-message-discord.js";

describe("managed message Discord target support", () => {
  it.each([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])("supports target type %s", (type) => {
    expect(isSupportedManagedMessageTargetType(type)).toBe(true);
  });

  it.each([ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.DM])(
    "rejects target type %s",
    (type) => expect(isSupportedManagedMessageTargetType(type)).toBe(false),
  );
});

describe("managed message Discord boundary", () => {
  it.each([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])("fresh-fetches, authorizes, and sends to target type %s", async (type) => {
    const fixture = createFixture({ type });
    const discord = createManagedMessageDiscord(fixture.client);

    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "SENT",
      message: {
        guildId: "guild-id",
        channelId: "channel-id",
        messageId: "message-id",
        createdAt,
      },
    });
    expect(fixture.fetchChannel).toHaveBeenCalledExactlyOnceWith("channel-id", { force: true });
    expect(fixture.fetchMember).toHaveBeenCalledTimes(2);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      content: sendInput.content,
      allowedMentions: { parse: [] },
      nonce: "stable-nonce",
      enforceNonce: true,
    });
    expect(fixture.join).not.toHaveBeenCalled();
  });

  it.each([
    ["unsupported", { type: ChannelType.GuildForum }],
    ["guild mismatch", { guildId: "other-guild" }],
  ])("rejects %s before member fetch", async (_label, overrides) => {
    const fixture = createFixture(overrides);
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "UNSUPPORTED_TARGET",
    });
    expect(fixture.fetchMember).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each([true, null])("rejects thread archived state %s conservatively", async (archived) => {
    const fixture = createFixture({ type: ChannelType.PublicThread, archived });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "ARCHIVED_THREAD",
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("requires the actor's current ManageMessages permission", async () => {
    const fixture = createFixture({ actorCanManage: false });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "ACTOR_PERMISSION_MISSING",
    });
    expect(fixture.permissionChecks).toContain(PermissionFlagsBits.ManageMessages);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("requires ViewChannel and SendMessages for an ordinary channel", async () => {
    const fixture = createFixture({ botCanSend: false });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toMatchObject({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("requires thread permissions and actual sendable state without joining", async () => {
    const fixture = createFixture({ type: ChannelType.PrivateThread, sendable: false });
    const discord = createManagedMessageDiscord(fixture.client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.join).not.toHaveBeenCalled();
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("classifies current-state failures before POST", async () => {
    const fetchChannel = vi.fn(() => Promise.reject(new Error("transport")));
    const discord = createManagedMessageDiscord({
      channels: { fetch: fetchChannel },
    } as unknown as Client);
    await expect(discord.sendManagedMessage(sendInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
  });

  it("distinguishes confirmed 4xx rejection from ambiguous send failures", async () => {
    const request = { body: undefined, files: undefined };
    const forbidden = createFixture({
      sendFailure: new HTTPError(403, "Forbidden", "POST", "https://discord.invalid", request),
    });
    const unavailable = createFixture({
      sendFailure: new HTTPError(503, "Unavailable", "POST", "https://discord.invalid", request),
    });
    await expect(
      createManagedMessageDiscord(forbidden.client).sendManagedMessage(sendInput),
    ).resolves.toMatchObject({ code: "SEND_REJECTED" });
    await expect(
      createManagedMessageDiscord(unavailable.client).sendManagedMessage(sendInput),
    ).resolves.toMatchObject({ code: "SEND_UNCONFIRMED" });
  });

  it("deletes exactly the confirmed message and treats Unknown Message as compensated", async () => {
    const request = { body: undefined, files: undefined };
    const unknownMessage = new DiscordAPIError(
      { message: "Unknown Message", code: 10_008 },
      10_008,
      404,
      "DELETE",
      "https://discord.invalid",
      request,
    );
    const deleteRequest = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(unknownMessage)
      .mockRejectedValueOnce(new Error("transport"));
    const discord = createManagedMessageDiscord({
      rest: { delete: deleteRequest },
    } as unknown as Client);
    const message = {
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "message-id",
      createdAt,
    };

    await expect(discord.deleteManagedMessage(message)).resolves.toEqual({ outcome: "DELETED" });
    await expect(discord.deleteManagedMessage(message)).resolves.toEqual({ outcome: "DELETED" });
    await expect(discord.deleteManagedMessage(message)).resolves.toEqual({
      outcome: "UNCONFIRMED",
    });
    expect(deleteRequest).toHaveBeenNthCalledWith(
      1,
      Routes.channelMessage("channel-id", "message-id"),
    );
  });
});

const createdAt = new Date("2026-08-31T04:05:06.789Z");
const sendInput = {
  guildId: "guild-id",
  channelId: "channel-id",
  actorUserId: "actor-id",
  content: "exact <@123456789012345678> <@&234567890123456789> @everyone @here content",
  nonce: "stable-nonce",
};

function createFixture(
  overrides: {
    type?: ChannelType;
    guildId?: string;
    archived?: boolean | null;
    actorCanManage?: boolean;
    botCanSend?: boolean;
    sendable?: boolean;
    sendFailure?: Error;
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  const permissionChecks: unknown[] = [];
  const fetchMember = vi.fn(({ user }: { user: string }) => Promise.resolve({ id: user }));
  const permissionsFor = vi.fn((member: { id: string }) => ({
    has: (permission: unknown) => {
      permissionChecks.push(permission);
      return member.id === "actor-id"
        ? (overrides.actorCanManage ?? true)
        : (overrides.botCanSend ?? true);
    },
  }));
  const send = vi.fn(() =>
    overrides.sendFailure === undefined
      ? Promise.resolve({
          id: "message-id",
          guildId: "guild-id",
          channelId: "channel-id",
          createdAt,
        })
      : Promise.reject(overrides.sendFailure),
  );
  const join = vi.fn();
  const thread = [
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ].includes(type);
  const channel = {
    id: "channel-id",
    type,
    guildId: overrides.guildId ?? "guild-id",
    archived: overrides.archived === undefined ? false : overrides.archived,
    sendable: overrides.sendable ?? true,
    isThread: () => thread,
    guild: { members: { fetch: fetchMember } },
    permissionsFor,
    send,
    join,
  };
  const fetchChannel = vi.fn(() => Promise.resolve(channel));
  const client = {
    channels: { fetch: fetchChannel },
    user: { id: "bot-id" },
    rest: { delete: vi.fn() },
  } as unknown as Client;
  return { client, fetchChannel, fetchMember, permissionsFor, permissionChecks, send, join };
}
