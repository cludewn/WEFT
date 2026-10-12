import {
  ChannelType,
  Client as DiscordClient,
  DiscordAPIError,
  Embed as DiscordEmbed,
  EmbedType,
  EmbedMediaFlags,
  HTTPError,
  PermissionFlagsBits,
  Routes,
  Message as DiscordMessage,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { Client, Embed, Message } from "discord.js";

import {
  createManagedMessageDiscord,
  isSupportedManagedMessageTargetType,
  projectManagedMessageEmbed,
} from "../../src/managed-message-discord.js";
import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
} from "../../src/managed-message-payload.js";
import type { ManagedMessageStore } from "../../src/managed-message-persistence.js";
import { createManagedMessageService } from "../../src/managed-message.js";

describe("managed message send diagnostics", () => {
  it.each([
    [
      "projection failure",
      { future_private_key: "private metadata" },
      "private content",
      "PROJECTION_FAILED",
      "UNKNOWN_RICH_FIELD",
    ],
    [
      "unknown image field",
      {
        image: { url: "https://private.invalid/image.png", private_image_key: "private metadata" },
      },
      "private content",
      "PROJECTION_FAILED",
      "UNKNOWN_IMAGE_FIELD",
    ],
    [
      "invalid rich ID",
      { id: "private-invalid-id" },
      "private content",
      "PROJECTION_FAILED",
      "INVALID_RICH_ID",
    ],
    [
      "embed semantic mismatch",
      { title: "different private title" },
      "private content",
      "SEMANTIC_MISMATCH",
      undefined,
    ],
    ["content semantic mismatch", {}, "different private content", "SEMANTIC_MISMATCH", undefined],
    [
      "image semantic mismatch",
      { image: { url: "https://private.invalid/image.png", flags: 0 } },
      "private content",
      "SEMANTIC_MISMATCH",
      undefined,
    ],
  ] as const)(
    "classifies %s with real discord.js representations without logging payloads",
    async (_label, returnedState, content, payloadFailureReason, projectionFailureReason) => {
      // discord.js exposes the runtime constructor but marks it private in its typings.
      const raw = Reflect.construct(DiscordMessage, [
        new DiscordClient({ intents: [] }),
        {
          id: "900000000000000001",
          channel_id: "channel-id",
          guild_id: "guild-id",
          type: 0,
          author: { id: "bot-id", username: "WEFT", discriminator: "0", avatar: null, bot: true },
          content,
          embeds: [
            {
              type: EmbedType.Rich,
              title: "private title",
              content_scan_version: 0,
              id: "101",
              ...returnedState,
            },
          ],
          mentions: [],
          mention_roles: [],
          attachments: [],
          components: [],
          pinned: false,
          tts: false,
          mention_everyone: false,
          flags: 0,
        },
      ]) as Message;
      for (const deleteConfirmed of [true, false]) {
        const fixture = createFixture({ returnedMessage: raw });
        const deleteRequest = vi.fn().mockResolvedValue(undefined);
        if (!deleteConfirmed) deleteRequest.mockRejectedValue(new Error("private deletion detail"));
        fixture.client.rest.delete = deleteRequest;
        const store = {
          create: vi.fn<ManagedMessageStore["create"]>(),
          confirmCreation: vi.fn<ManagedMessageStore["confirmCreation"]>(),
          find: vi.fn<ManagedMessageStore["find"]>(),
          edit: vi.fn<ManagedMessageStore["edit"]>(),
          confirmEdit: vi.fn<ManagedMessageStore["confirmEdit"]>(),
          markDeleted: vi.fn<ManagedMessageStore["markDeleted"]>(),
          confirmDeletion: vi.fn<ManagedMessageStore["confirmDeletion"]>(),
          readCompensationSafety: vi.fn<ManagedMessageStore["readCompensationSafety"]>(),
        } satisfies ManagedMessageStore;
        const logger = { warn: vi.fn() };
        const service = createManagedMessageService({
          discord: createManagedMessageDiscord(fixture.client),
          store,
          logger,
          generateNonce: () => "stable-nonce",
          generateAuditId: () => "stable-audit-id",
        });
        await expect(
          service.send({
            ...sendInput,
            payload: { content: "private content", embed: { title: "private title" } },
          }),
        ).resolves.toEqual(
          deleteConfirmed
            ? { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" }
            : { outcome: "PARTIAL_FAILURE", messageId: raw.id },
        );
        expect(store.create).not.toHaveBeenCalled();
        expect(store.confirmCreation).not.toHaveBeenCalled();
        expect(fixture.send).toHaveBeenCalledOnce();
        expect(deleteRequest).toHaveBeenCalledOnce();
        expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
          {
            event: deleteConfirmed
              ? "managed_message_send_confirmation_compensated"
              : "managed_message_send_confirmation_partial_failure",
            guildId: "guild-id",
            channelId: "channel-id",
            messageId: raw.id,
            failureCode: "RETURNED_PAYLOAD_MISMATCH",
            payloadFailureReason,
            ...(projectionFailureReason === undefined ? {} : { projectionFailureReason }),
          },
          "Managed message operation could not be confirmed",
        );
        const logs = JSON.stringify(logger.warn.mock.calls);
        for (const privateValue of [
          "private content",
          "private title",
          "private metadata",
          "future_private_key",
          "private_image_key",
          "https://private.invalid/image.png",
          "private deletion detail",
          "private-invalid-id",
        ]) {
          expect(logs).not.toContain(privateValue);
        }
      }
    },
  );
});

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
    { content: "Test", embed: { title: "Test Title" }, returned: { title: "Test Title" } },
    {
      content: "",
      embed: { imageUrl: "https://example.invalid/image.png" },
      returned: { image: { url: "https://example.invalid/image.png", flags: 0 } },
    },
    {
      content: "Test",
      embed: { imageUrl: "https://example.invalid/image.png" },
      returned: { image: { url: "https://example.invalid/image.png", flags: 32 } },
    },
  ])("persists a send with a bounded rich ID without false compensation %#", async (state) => {
    const fixture = createFixture({
      returnedContent: state.content,
      returnedEmbeds: [
        Reflect.construct(DiscordEmbed, [
          { type: EmbedType.Rich, id: "101", content_scan_version: 0, ...state.returned },
        ]) as Embed,
      ],
    });
    const deleteRequest = vi.fn().mockResolvedValue(undefined);
    fixture.client.rest.delete = deleteRequest;
    const store = {
      create: vi.fn<ManagedMessageStore["create"]>().mockImplementation((creation) =>
        Promise.resolve({
          ...creation,
          revision: 1,
          status: "ACTIVE" as const,
          updatedAt: creation.createdAt,
        }),
      ),
      confirmCreation: vi.fn<ManagedMessageStore["confirmCreation"]>().mockResolvedValue("MATCH"),
      find: vi.fn<ManagedMessageStore["find"]>(),
      edit: vi.fn<ManagedMessageStore["edit"]>(),
      confirmEdit: vi.fn<ManagedMessageStore["confirmEdit"]>(),
      markDeleted: vi.fn<ManagedMessageStore["markDeleted"]>(),
      confirmDeletion: vi.fn<ManagedMessageStore["confirmDeletion"]>(),
      readCompensationSafety: vi.fn<ManagedMessageStore["readCompensationSafety"]>(),
    } satisfies ManagedMessageStore;
    const logger = { warn: vi.fn() };
    const service = createManagedMessageService({
      discord: createManagedMessageDiscord(fixture.client),
      store,
      logger,
      generateNonce: () => "stable-nonce",
      generateAuditId: () => "stable-audit-id",
    });
    const payload = { content: state.content, embed: state.embed };
    const creation = {
      auditId: "stable-audit-id",
      messageId: "message-id",
      guildId: sendInput.guildId,
      channelId: sendInput.channelId,
      creatorUserId: sendInput.actorUserId,
      createdAt,
      payload,
    };
    for (const responseLost of [false, true]) {
      store.create.mockClear();
      store.confirmCreation.mockClear();
      logger.warn.mockClear();
      if (responseLost) store.create.mockRejectedValueOnce(new Error("creation response lost"));
      await expect(service.send({ ...sendInput, payload })).resolves.toEqual({
        outcome: "SUCCESS",
        messageId: "message-id",
      });
      expect(store.create).toHaveBeenCalledExactlyOnceWith(creation);
      if (responseLost) expect(store.confirmCreation).toHaveBeenCalledExactlyOnceWith(creation);
      else expect(store.confirmCreation).not.toHaveBeenCalled();
      expect(deleteRequest).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(responseLost ? 1 : 0);
    }
    expect(fixture.send).toHaveBeenCalledTimes(2);
    expect(fixture.send).toHaveBeenCalledWith(
      expect.objectContaining({
        nonce: "stable-nonce",
        enforceNonce: true,
        allowedMentions: { parse: [] },
      }),
    );
  });

  it.each([undefined, 0, 1, 2, 4])(
    "projects text and title-only with scan version %s without a diagnostic failure",
    async (content_scan_version) => {
      const fixture = createFixture({
        returnedContent: "Test",
        returnedEmbeds: [richEmbed({ title: "Test Title", content_scan_version })],
      });
      await expect(
        createManagedMessageDiscord(fixture.client).sendManagedMessage({
          ...sendInput,
          payload: { content: "Test", embed: { title: "Test Title" } },
        }),
      ).resolves.toEqual({
        outcome: "SENT",
        message: {
          guildId: "guild-id",
          channelId: "channel-id",
          messageId: "message-id",
          createdAt,
          payload: { content: "Test", embed: { title: "Test Title" } },
        },
      });
    },
  );

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
    if (type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement) {
      expect(fixture.fetchParent).not.toHaveBeenCalled();
      expect(fixture.permissionChecks).toContainEqual([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]);
    } else {
      expect(fixture.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
      expect(fixture.permissionChecks).toContainEqual([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
      ]);
    }
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

  it("uses refreshed parent overwrites for thread sends", async () => {
    const fixture = createFixture({
      type: ChannelType.PublicThread,
      parentCanSendAfterFetch: false,
    });
    await expect(
      createManagedMessageDiscord(fixture.client).sendManagedMessage(sendInput),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.fetchParent).toHaveBeenCalledExactlyOnceWith("parent-id", { force: true });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("does not use stale parent permissions when refresh fails", async () => {
    const fixture = createFixture({
      type: ChannelType.PublicThread,
      parentFetchFailure: new Error("offline"),
    });
    await expect(
      createManagedMessageDiscord(fixture.client).sendManagedMessage(sendInput),
    ).resolves.toEqual({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
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
  it("projects the observed rich ID representation without changing a title-only payload", () => {
    const returned = Reflect.construct(DiscordEmbed, [
      { type: EmbedType.Rich, title: "Test Title", content_scan_version: 0, id: "101" },
    ]) as Embed;
    expect(projectManagedMessageEmbed([returned])).toEqual({
      ok: true,
      embed: { title: "Test Title" },
    });
  });

  it.each([undefined, "1", "101", "900000000000000002", "99999999999999999999"])(
    "validates and omits response IDs from the authored projection: %s",
    (id) => {
      for (const authored of [
        { title: "Test Title" },
        { image: { url: imageUrl, flags: 0 } },
        {
          title: "Title",
          description: "Description",
          color: 0,
          image: { url: imageUrl, flags: 32 },
        },
      ]) {
        const projection = projectManagedMessageEmbed([
          richEmbed({ ...authored, content_scan_version: 2, ...(id === undefined ? {} : { id }) }),
        ]);
        expect(projection).toEqual({
          ok: true,
          embed: {
            ...(authored.title === undefined ? {} : { title: authored.title }),
            ...(authored.description === undefined ? {} : { description: authored.description }),
            ...(authored.color === undefined ? {} : { color: authored.color }),
            ...(authored.image === undefined ? {} : { imageUrl }),
          },
        });
      }
    },
  );

  it.each([
    undefined,
    null,
    0,
    1,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    false,
    true,
    [],
    {},
    "",
    "0",
    "00",
    "01",
    "abc",
    "-1",
    "+1",
    "1.0",
    "1e2",
    "1 ",
    " 1",
    "1\n",
    "1\r\n",
    "1\u2028",
    "１２３",
    "9".repeat(21),
  ])("rejects a present invalid rich ID with a fixed reason: %j", (id) => {
    expect(projectManagedMessageEmbed([richEmbed({ title: "Test Title", id })])).toEqual({
      ok: false,
      reason: "INVALID_RICH_ID",
    });
  });

  it("does not treat a valid response ID as authored identity or weaken semantic equality", () => {
    const authored = { content: "Test", embed: { title: "Test Title" } };
    for (const id of ["101", "202", "99999999999999999999"]) {
      const projection = projectManagedMessageEmbed([richEmbed({ title: "Test Title", id })]);
      expect(projection).toEqual({ ok: true, embed: authored.embed });
      if (!projection.ok) throw new Error("Expected a valid rich projection");
      expect(
        managedMessagePayloadsEqual({ content: "Test", embed: projection.embed }, authored),
      ).toBe(true);
      expect(
        managedMessagePayloadsEqual({ content: "Changed", embed: projection.embed }, authored),
      ).toBe(false);
      expect(
        managedMessagePayloadsEqual({ content: "Test", embed: { title: "Changed" } }, authored),
      ).toBe(false);
    }
  });

  it.each([undefined, 0, 1, 2, 4, Number.MAX_SAFE_INTEGER])(
    "ignores a valid response-only scan-filter version %s after validation",
    (content_scan_version) => {
      for (const authored of [
        { title: "Test Title" },
        { image: { url: imageUrl, flags: 0 } },
        {
          title: "Title",
          description: "Description",
          color: 0,
          image: { url: imageUrl, flags: 32 },
        },
      ]) {
        const projection = projectManagedMessageEmbed([
          richEmbed({ ...authored, content_scan_version }),
        ]);
        expect(projection).toEqual({
          ok: true,
          embed: {
            ...(authored.title === undefined ? {} : { title: authored.title }),
            ...(authored.description === undefined ? {} : { description: authored.description }),
            ...(authored.color === undefined ? {} : { color: authored.color }),
            ...(authored.image === undefined ? {} : { imageUrl }),
          },
        });
      }
    },
  );

  it.each([
    null,
    "0",
    "1",
    false,
    {},
    [],
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])("rejects malformed scan version %j", (content_scan_version) => {
    expect(
      projectManagedMessageEmbed([richEmbed({ title: "Test Title", content_scan_version })]),
    ).toEqual({ ok: false, reason: "INVALID_CONTENT_SCAN_VERSION" });
  });

  it.each([
    [{ future_state: 0 }, "UNKNOWN_RICH_FIELD"],
    [{ fields: [{ name: "n", value: "v" }] }, "UNSUPPORTED_RICH_STATE"],
    [{ flags: 32 }, "UNSUPPORTED_RICH_STATE"],
    [{ title: null }, "INVALID_RICH_FIELD"],
    [{ image: { url: imageUrl, future_state: 0 } }, "UNKNOWN_IMAGE_FIELD"],
    [{ image: { url: imageUrl, flags: 33 } }, "INVALID_IMAGE_METADATA"],
  ])(
    "does not let response IDs and scan metadata conceal unsupported state %#",
    (state, reason) => {
      expect(
        projectManagedMessageEmbed([
          richEmbed({ title: "Test Title", id: "101", content_scan_version: 0, ...state }),
        ]),
      ).toEqual({ ok: false, reason });
    },
  );

  it("projects a textual rich embed with Discord-added content_scan_version: 0", () => {
    expect(
      projectManagedMessageEmbed([
        richEmbed({
          title: "Test Title",
          content_scan_version: 0,
        }),
      ]),
    ).toEqual({ ok: true, embed: { title: "Test Title" } });
  });

  it.each([
    { title: null },
    { title: 0 },
    { title: " " },
    { title: "x".repeat(257) },
    { description: null },
    { description: false },
    { description: " " },
    { description: "x".repeat(4_001) },
    { color: null },
    { color: "000000" },
    { color: -1 },
    { color: 0.5 },
  ])("classifies invalid authored rich fields without normalizing them away %#", (state) => {
    expect(projectManagedMessageEmbed([richEmbed({ title: "valid", ...state })])).toEqual({
      ok: false,
      reason: "INVALID_RICH_FIELD",
    });
  });

  it.each([null, [], "rich", 0])("rejects malformed returned embed data %j", (data) => {
    expect(projectManagedMessageEmbed([{ data } as unknown as Embed])).toEqual({
      ok: false,
      reason: "INVALID_EMBED_SHAPE",
    });
  });

  it.each([
    ["image-only", "", {}],
    ["content and image", "content", {}],
    ["complete embed", "content", { title: "Title", description: "Description", color: 0 }],
  ])("projects %s with compatible metadata combinations", (_label, content, authored) => {
    const imageUrl = "https://example.invalid/image.png";
    for (const flags of [undefined, 0, EmbedMediaFlags.IsAnimated]) {
      for (const description of [undefined, ""]) {
        for (const topFlags of [undefined, 0]) {
          for (const fields of [undefined, []]) {
            for (const metadata of [
              {},
              {
                proxy_url: "https://proxy.invalid/another-resource",
                width: 0,
                height: 100,
                content_type: "image/png",
                placeholder: "placeholder",
                placeholder_version: 1,
              },
            ]) {
              const projection = projectManagedMessageEmbed([
                richEmbed({
                  ...authored,
                  flags: topFlags,
                  fields,
                  image: { url: imageUrl, ...metadata, flags, description },
                }),
              ]);
              expect(projection).toEqual({ ok: true, embed: { ...authored, imageUrl } });
              if (projection.ok)
                expect(
                  managedMessagePayloadsEqual(
                    { content, embed: projection.embed },
                    { content, embed: { ...authored, imageUrl } },
                  ),
                ).toBe(true);
            }
          }
        }
      }
    }
  });

  it.each([
    1,
    33,
    -1,
    0.5,
    "0",
    "32",
    null,
    true,
    2 ** 32,
    2 ** 32 + 32,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects image flags %s without coercion or bitfield truncation", (flags) => {
    expect(projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, flags } })])).toEqual({
      ok: false,
      reason: "INVALID_IMAGE_METADATA",
    });
  });

  it.each(["alt text", " ", "\t\n", null, 0, false, {}, []])(
    "rejects meaningful or malformed image description %j",
    (description) => {
      expect(
        projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, description } })]),
      ).toEqual({ ok: false, reason: "INVALID_IMAGE_METADATA" });
    },
  );

  it.each(["proxy_url", "content_type", "placeholder"])(
    "validates the response-only string %s",
    (key) => {
      for (const value of [null, 0, false, {}, []]) {
        expect(
          projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, [key]: value } })]),
        ).toEqual({ ok: false, reason: "INVALID_IMAGE_METADATA" });
      }
      expect(
        projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, [key]: "" } })]),
      ).toEqual({ ok: true, embed: { imageUrl } });
    },
  );

  it.each(["width", "height", "placeholder_version"])(
    "validates the response-only non-negative safe integer %s",
    (key) => {
      for (const value of [
        null,
        "1",
        false,
        -1,
        0.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.MAX_SAFE_INTEGER + 1,
        {},
        [],
      ]) {
        expect(
          projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, [key]: value } })]),
        ).toEqual({ ok: false, reason: "INVALID_IMAGE_METADATA" });
      }
      for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
        expect(
          projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl, [key]: value } })]),
        ).toEqual({ ok: true, embed: { imageUrl } });
      }
    },
  );

  it.each([
    [null, "INVALID_IMAGE_METADATA"],
    [[], "INVALID_IMAGE_METADATA"],
    ["image", "INVALID_IMAGE_METADATA"],
    [1, "INVALID_IMAGE_METADATA"],
    [{}, "INVALID_IMAGE_URL"],
    [{ url: null }, "INVALID_IMAGE_URL"],
    [{ url: 1 }, "INVALID_IMAGE_URL"],
  ])("rejects malformed image shape %j", (image, reason) => {
    expect(projectManagedMessageEmbed([richEmbed({ title: "Title", image })])).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    [32, "UNSUPPORTED_RICH_STATE"],
    [1, "UNSUPPORTED_RICH_STATE"],
    [33, "UNSUPPORTED_RICH_STATE"],
    [-1, "INVALID_RICH_FIELD"],
    [0.5, "INVALID_RICH_FIELD"],
    ["0", "INVALID_RICH_FIELD"],
    [null, "INVALID_RICH_FIELD"],
    [false, "INVALID_RICH_FIELD"],
    [2 ** 32, "UNSUPPORTED_RICH_STATE"],
    [Number.NaN, "INVALID_RICH_FIELD"],
  ])("rejects top-level flags %j independently of media flags", (flags, reason) => {
    expect(
      projectManagedMessageEmbed([richEmbed({ flags, image: { url: imageUrl, flags: 32 } })]),
    ).toEqual({ ok: false, reason });
  });

  it.each([
    [null, "INVALID_RICH_FIELD"],
    [{}, "INVALID_RICH_FIELD"],
    [{ length: 0 }, "INVALID_RICH_FIELD"],
    ["", "INVALID_RICH_FIELD"],
    [0, "INVALID_RICH_FIELD"],
    [false, "INVALID_RICH_FIELD"],
    [[{ name: "n", value: "v" }], "UNSUPPORTED_RICH_STATE"],
  ])("rejects nonempty or malformed fields %j", (fields, reason) => {
    expect(projectManagedMessageEmbed([richEmbed({ title: "Title", fields })])).toEqual({
      ok: false,
      reason,
    });
  });

  it.each([
    ["url", "UNSUPPORTED_RICH_STATE"],
    ["timestamp", "UNSUPPORTED_RICH_STATE"],
    ["footer", "UNSUPPORTED_RICH_STATE"],
    ["thumbnail", "UNSUPPORTED_RICH_STATE"],
    ["author", "UNSUPPORTED_RICH_STATE"],
    ["provider", "UNSUPPORTED_RICH_STATE"],
    ["video", "UNSUPPORTED_RICH_STATE"],
    ["future_state", "UNKNOWN_RICH_FIELD"],
    ["components", "UNKNOWN_RICH_FIELD"],
  ])("rejects unsupported rich key %s", (key, reason) => {
    expect(
      projectManagedMessageEmbed([richEmbed({ image: { url: imageUrl }, [key]: {} })]),
    ).toEqual({ ok: false, reason });
  });

  it.each([
    undefined,
    null,
    0,
    {},
    [],
    "unknown",
    EmbedType.PollResult,
    EmbedType.AutoModerationMessage,
  ])("rejects missing or unsupported type %j", (type) => {
    expect(projectManagedMessageEmbed([richEmbed({ type, image: { url: imageUrl } })])).toEqual({
      ok: false,
      reason: "INVALID_EMBED_TYPE",
    });
  });

  it.each([EmbedType.Link, EmbedType.Article, EmbedType.Image, EmbedType.Video, EmbedType.GIFV])(
    "preserves ignored preview/media type %s",
    (type) => {
      const preview = richEmbed({ type, url: "https://preview.invalid", image: { flags: 123 } });
      expect(projectManagedMessageEmbed([preview])).toEqual({ ok: true, embed: null });
      expect(
        projectManagedMessageEmbed([preview, richEmbed({ image: { url: imageUrl, flags: 0 } })]),
      ).toEqual({ ok: true, embed: { imageUrl } });
    },
  );

  it.each([
    "relative.png",
    "ftp://example.invalid/image.png",
    "attachment://image.png",
    "",
    "https://",
    " https://example.invalid/image.png ",
    "HTTPS://EXAMPLE.INVALID:443/image.png",
  ])("rejects invalid or noncanonical returned URL %j", (url) => {
    expect(projectManagedMessageEmbed([richEmbed({ image: { url } })])).toEqual({
      ok: false,
      reason: "INVALID_IMAGE_URL",
    });
  });

  it("compares canonical authored URLs without treating other resources or proxies as equivalent", () => {
    const validation = validateManagedMessagePayload({
      content: "",
      embed: {
        imageUrl: " HTTPS://EXAMPLE.INVALID:443/a/../image.png?size=2#frame ",
      },
    });
    expect(validation).toEqual({
      ok: true,
      payload: {
        content: "",
        embed: {
          imageUrl: "https://example.invalid/image.png?size=2#frame",
        },
      },
    });
    if (!validation.ok) throw new Error("Expected valid authored URL");
    for (const url of [
      "https://example.invalid/image.png?size=2#frame",
      "https://example.invalid/other.png?size=2#frame",
      "https://example.invalid/image.png?size=3#frame",
      "https://example.invalid/image.png?size=2#other",
      "https://proxy.invalid/image.png",
    ]) {
      const projection = projectManagedMessageEmbed([
        richEmbed({
          image: {
            url,
            proxy_url: validation.payload.embed?.imageUrl,
            flags: 32,
          },
          content_scan_version: 2,
          id: "101",
        }),
      ]);
      expect(projection.ok).toBe(true);
      if (projection.ok)
        expect(
          managedMessagePayloadsEqual({ content: "", embed: projection.embed }, validation.payload),
        ).toBe(url === validation.payload.embed?.imageUrl);
    }
  });

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
    ["missing type", [richEmbed({ type: undefined })], "INVALID_EMBED_TYPE"],
    ["unknown type", [richEmbed({ type: "unknown" })], "INVALID_EMBED_TYPE"],
    [
      "multiple rich",
      [richEmbed({ title: "a" }), richEmbed({ title: "b" })],
      "MULTIPLE_RICH_EMBEDS",
    ],
    [
      "unsupported URL",
      [richEmbed({ title: "a", url: "https://example.invalid" })],
      "UNSUPPORTED_RICH_STATE",
    ],
    [
      "unsupported fields",
      [richEmbed({ title: "a", fields: [{ name: "n", value: "v" }] })],
      "UNSUPPORTED_RICH_STATE",
    ],
    [
      "image alt text",
      [
        richEmbed({
          title: "a",
          image: { url: "https://example.invalid/image.png", description: "meaningful alt text" },
        }),
      ],
      "INVALID_IMAGE_METADATA",
    ],
    [
      "image media flags with unknown bits",
      [richEmbed({ title: "a", image: { url: "https://example.invalid/image.png", flags: 33 } })],
      "INVALID_IMAGE_METADATA",
    ],
    [
      "unknown image state",
      [
        richEmbed({
          title: "a",
          image: { url: "https://example.invalid/image.png", future_meaningful_state: true },
        }),
      ],
      "UNKNOWN_IMAGE_FIELD",
    ],
    ["color only", [richEmbed({ color: 0 })], "OTHER_PROJECTION_FAILURE"],
  ])("fails conservatively for %s", (_label, embeds, reason) => {
    expect(projectManagedMessageEmbed(embeds)).toEqual({ ok: false, reason });
  });
});

const imageUrl = "https://example.invalid/image.png";
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
    parentCanSendAfterFetch?: boolean;
    parentFetchFailure?: Error;
    sendable?: boolean;
    sendFailure?: Error;
    returnedContent?: string;
    returnedEmbeds?: Embed[];
    returnedMessage?: Message;
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  let parentRef = { id: "parent-id" };
  let parentRefreshed = false;
  const fetchParent = vi.fn(() => {
    if (overrides.parentFetchFailure) return Promise.reject(overrides.parentFetchFailure);
    parentRef = { id: "parent-id" };
    parentRefreshed = true;
    return Promise.resolve(parentRef);
  });
  const permissionChecks: unknown[] = [];
  const fetchMember = vi.fn(({ user }: { user: string }) => Promise.resolve({ id: user }));
  const permissionsFor = vi.fn((member: { id: string }) => ({
    has: (permission: unknown) => {
      permissionChecks.push(permission);
      if (member.id === "actor-id") return overrides.actorCanManage ?? true;
      if (permission === PermissionFlagsBits.EmbedLinks) return overrides.botCanEmbed ?? true;
      if (parentRefreshed && overrides.parentCanSendAfterFetch !== undefined) {
        return overrides.parentCanSendAfterFetch;
      }
      return overrides.botCanSend ?? true;
    },
  }));
  const send = vi.fn(() =>
    overrides.sendFailure === undefined
      ? Promise.resolve(
          overrides.returnedMessage ?? {
            id: "message-id",
            guildId: "guild-id",
            channelId: "channel-id",
            createdAt,
            author: { id: "bot-id" },
            content: overrides.returnedContent ?? sendInput.payload.content,
            embeds: overrides.returnedEmbeds ?? [],
          },
        )
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
    parentId: "parent-id",
    get parent() {
      return parentRef;
    },
    guildId: overrides.guildId ?? "guild-id",
    archived: overrides.archived === undefined ? false : overrides.archived,
    sendable: overrides.sendable ?? true,
    isThread: () => thread,
    guild: { members: { fetch: fetchMember }, channels: { fetch: fetchParent } },
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
  return {
    client,
    fetchChannel,
    fetchMember,
    fetchParent,
    permissionsFor,
    permissionChecks,
    send,
    join,
  };
}

function richEmbed(data: Record<string, unknown>): Embed {
  return {
    data: { type: EmbedType.Rich, ...data },
  } as unknown as Embed;
}
