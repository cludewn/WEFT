import {
  ChannelType,
  DiscordAPIError,
  EmbedType,
  HTTPError,
  PermissionFlagsBits,
  Routes,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client, Embed } from "discord.js";

import {
  createManagedMessageDiscord,
  isSupportedManagedMessageTargetType,
  projectManagedMessageEmbed,
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
        payload: sendInput.payload,
      },
    });
    expect(fixture.fetchChannel).toHaveBeenCalledExactlyOnceWith("channel-id", { force: true });
    expect(fixture.fetchMember).toHaveBeenCalledTimes(2);
    expect(fixture.send).toHaveBeenCalledExactlyOnceWith({
      content: sendInput.payload.content,
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

  it("sends embed-only and combined payloads with exactly one explicit supported embed", async () => {
    const managedEmbed = richEmbed({
      title: "Title",
      description: "Description",
      color: 0,
      image: { url: "https://example.invalid/image.png", proxy_url: "https://proxy.invalid/x" },
    });
    for (const content of ["", "combined"] as const) {
      const fixture = createFixture({ returnedContent: content, returnedEmbeds: [managedEmbed] });
      const payload = {
        content,
        embed: {
          title: "Title",
          description: "Description",
          color: 0,
          imageUrl: "https://example.invalid/image.png",
        },
      };
      await expect(
        createManagedMessageDiscord(fixture.client).sendManagedMessage({
          ...sendInput,
          payload,
        }),
      ).resolves.toMatchObject({ outcome: "SENT", message: { payload } });
      const sent = (
        fixture.send.mock.calls as unknown as Array<
          [
            {
              content?: string;
              embeds?: Array<{ toJSON: () => unknown }>;
            },
          ]
        >
      )[0]?.[0];
      expect(sent?.content).toBe(content === "" ? undefined : content);
      expect(sent?.embeds).toHaveLength(1);
      expect(sent?.embeds?.[0]?.toJSON()).toEqual({
        title: "Title",
        description: "Description",
        color: 0,
        image: { url: "https://example.invalid/image.png" },
      });
    }
  });

  it("requires EmbedLinks only when the outgoing operation has a managed embed", async () => {
    const text = createFixture({ botCanEmbed: false });
    await expect(
      createManagedMessageDiscord(text.client).sendManagedMessage(sendInput),
    ).resolves.toMatchObject({ outcome: "SENT" });

    const embed = createFixture({ botCanEmbed: false });
    await expect(
      createManagedMessageDiscord(embed.client).sendManagedMessage({
        ...sendInput,
        payload: { content: "", embed: { title: "Title" } },
      }),
    ).resolves.toEqual({ outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" });
    expect(embed.send).not.toHaveBeenCalled();
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
      payload: sendInput.payload,
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

describe("managed rich embed projection", () => {
  it("ignores documented non-rich URL previews and projects one supported rich embed", () => {
    expect(
      projectManagedMessageEmbed([
        richEmbed({ type: EmbedType.Link, title: "preview" }),
        richEmbed({
          title: "Managed",
          image: {
            url: "https://example.invalid/image.png",
            proxy_url: "https://proxy.invalid/image.png",
            width: 100,
            height: 50,
            content_type: "image/png",
            placeholder: "response-placeholder",
            placeholder_version: 1,
          },
        }),
      ]),
    ).toEqual({
      ok: true,
      embed: { title: "Managed", imageUrl: "https://example.invalid/image.png" },
    });
  });

  it.each([
    ["missing type", [richEmbed({ type: undefined })]],
    ["unknown type", [richEmbed({ type: "unknown" })]],
    ["multiple rich", [richEmbed({ title: "a" }), richEmbed({ title: "b" })]],
    ["unsupported URL", [richEmbed({ title: "a", url: "https://example.invalid" })]],
    ["unsupported fields", [richEmbed({ title: "a", fields: [{ name: "n", value: "v" }] })]],
    [
      "image alt text",
      [
        richEmbed({
          title: "a",
          image: { url: "https://example.invalid/image.png", description: "meaningful alt text" },
        }),
      ],
    ],
    [
      "image media flags",
      [richEmbed({ title: "a", image: { url: "https://example.invalid/image.png", flags: 32 } })],
    ],
    [
      "unknown image state",
      [
        richEmbed({
          title: "a",
          image: { url: "https://example.invalid/image.png", future_meaningful_state: true },
        }),
      ],
    ],
    ["color only", [richEmbed({ color: 0 })]],
  ])("fails conservatively for %s", (_label, embeds) => {
    expect(projectManagedMessageEmbed(embeds)).toEqual({ ok: false });
  });
});

const createdAt = new Date("2026-08-31T04:05:06.789Z");
const sendInput = {
  guildId: "guild-id",
  channelId: "channel-id",
  actorUserId: "actor-id",
  payload: {
    content: "exact <@123456789012345678> <@&234567890123456789> @everyone @here content",
    embed: null,
  },
  nonce: "stable-nonce",
};

function createFixture(
  overrides: {
    type?: ChannelType;
    guildId?: string;
    archived?: boolean | null;
    actorCanManage?: boolean;
    botCanSend?: boolean;
    botCanEmbed?: boolean;
    sendable?: boolean;
    sendFailure?: Error;
    returnedContent?: string;
    returnedEmbeds?: Embed[];
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  const permissionChecks: unknown[] = [];
  const fetchMember = vi.fn(({ user }: { user: string }) => Promise.resolve({ id: user }));
  const permissionsFor = vi.fn((member: { id: string }) => ({
    has: (permission: unknown) => {
      permissionChecks.push(permission);
      if (member.id === "actor-id") return overrides.actorCanManage ?? true;
      if (permission === PermissionFlagsBits.EmbedLinks) return overrides.botCanEmbed ?? true;
      return overrides.botCanSend ?? true;
    },
  }));
  const send = vi.fn(() =>
    overrides.sendFailure === undefined
      ? Promise.resolve({
          id: "message-id",
          guildId: "guild-id",
          channelId: "channel-id",
          createdAt,
          author: { id: "bot-id" },
          content: overrides.returnedContent ?? sendInput.payload.content,
          embeds: overrides.returnedEmbeds ?? [],
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

function richEmbed(data: Record<string, unknown>): Embed {
  return {
    data: { type: EmbedType.Rich, ...data },
  } as unknown as Embed;
}
