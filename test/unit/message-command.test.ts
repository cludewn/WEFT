import {
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  TextInputStyle,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction } from "discord.js";

import {
  createManagedMessageSendModal,
  createManagedMessageEditModal,
  handleManagedMessageModalSubmit,
  handleMessageCommand,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  MANAGED_MESSAGE_EDIT_MODAL_PREFIX,
  MANAGED_MESSAGE_SEND_MODAL_ID,
  messageCommandDefinition,
  parseManagedMessageEditModalId,
  parseManagedMessageReference,
} from "../../src/message-command.js";
import type { ManagedMessageService } from "../../src/managed-message.js";

describe("message command", () => {
  it("defines guild-only /message send with ManageMessages and no input options", () => {
    const definition = messageCommandDefinition.toJSON();
    expect(definition.name).toBe("message");
    expect(definition.contexts).toEqual([InteractionContextType.Guild]);
    expect(definition.default_member_permissions).toBe(
      PermissionFlagsBits.ManageMessages.toString(),
    );
    expect(definition.options).toHaveLength(2);
    expect(definition.options?.[0]).toMatchObject({ name: "send", options: [] });
    expect(definition.options?.[1]).toMatchObject({
      name: "edit",
      options: [{ name: "message", required: true }],
    });
  });

  it("creates the exact required paragraph modal", () => {
    const modal = createManagedMessageSendModal().toJSON();
    expect(modal).toMatchObject({
      custom_id: MANAGED_MESSAGE_SEND_MODAL_ID,
      title: "Send managed message",
    });
    expect(modal.components).toHaveLength(1);
    expect(modal.components[0]).toMatchObject({
      type: ComponentType.Label,
      label: "Message content",
      component: {
        type: ComponentType.TextInput,
        custom_id: MANAGED_MESSAGE_CONTENT_INPUT_ID,
        style: TextInputStyle.Paragraph,
        required: true,
        min_length: 1,
        max_length: 2_000,
      },
    });
  });

  it("creates an exact prefilled edit modal with only message ID and revision in its custom ID", () => {
    const modal = createManagedMessageEditModal(
      "900000000000000001",
      4,
      "  exact <@123> content  ",
    ).toJSON();
    expect(modal.custom_id).toBe(`${MANAGED_MESSAGE_EDIT_MODAL_PREFIX}900000000000000001:4`);
    expect(JSON.stringify(modal.custom_id)).not.toContain("exact");
    expect(modal.components[0]).toMatchObject({
      component: { value: "  exact <@123> content  " },
    });
  });

  it.each([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])("opens the modal in supported active target %s", async (type) => {
    const fixture = createCommandInteraction({ type });
    await handleMessageCommand(fixture.interaction, fixture.service);
    expect(fixture.showModal).toHaveBeenCalledOnce();
    expect(fixture.reply).not.toHaveBeenCalled();
  });

  it.each([ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.DM])(
    "rejects unsupported target %s",
    async (type) => {
      const fixture = createCommandInteraction({ type });
      await handleMessageCommand(fixture.interaction, fixture.service);
      expect(fixture.showModal).not.toHaveBeenCalled();
      expect(fixture.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    },
  );

  it("rejects an archived or unknown-state thread", async () => {
    for (const archived of [true, null]) {
      const fixture = createCommandInteraction({ type: ChannelType.PublicThread, archived });
      await handleMessageCommand(fixture.interaction, fixture.service);
      expect(fixture.showModal).not.toHaveBeenCalled();
    }
  });

  it("rejects non-guild and missing ManageMessages before opening a modal", async () => {
    const nonGuild = createCommandInteraction({ inGuild: false });
    const denied = createCommandInteraction({ canManage: false });
    await handleMessageCommand(nonGuild.interaction, nonGuild.service);
    await handleMessageCommand(denied.interaction, denied.service);
    expect(nonGuild.showModal).not.toHaveBeenCalled();
    expect(denied.showModal).not.toHaveBeenCalled();
  });

  it("loads one current-channel managed row and opens a revision-bound prefilled edit modal", async () => {
    const fixture = createCommandInteraction({
      subcommand: "edit",
      messageReference: "900000000000000001",
    });
    fixture.service.findForEdit.mockResolvedValueOnce({
      outcome: "FOUND",
      messageId: "900000000000000001",
      revision: 7,
      content: "persisted exact content",
    });

    await handleMessageCommand(fixture.interaction, fixture.service);

    expect(fixture.service.findForEdit).toHaveBeenCalledExactlyOnceWith({
      guildId: "700000000000000001",
      channelId: "800000000000000001",
      messageId: "900000000000000001",
    });
    expect(fixture.showModal).toHaveBeenCalledOnce();
    const shownModal = fixture.showModal.mock.calls[0]?.[0];
    expect(shownModal?.toJSON()).toMatchObject({
      custom_id: "managed-message:edit:900000000000000001:7",
      components: [{ component: { value: "persisted exact content" } }],
    });
  });

  it("does not read managed state for an invalid link or missing local permission", async () => {
    const invalid = createCommandInteraction({ subcommand: "edit", messageReference: "bad" });
    const denied = createCommandInteraction({
      subcommand: "edit",
      messageReference: "900000000000000001",
      canManage: false,
    });
    await handleMessageCommand(invalid.interaction, invalid.service);
    await handleMessageCommand(denied.interaction, denied.service);
    expect(invalid.service.findForEdit).not.toHaveBeenCalled();
    expect(denied.service.findForEdit).not.toHaveBeenCalled();
  });

  it.each(["NOT_FOUND", "DELETED"] as const)(
    "does not open an edit modal for %s managed state",
    async (outcome) => {
      const fixture = createCommandInteraction({ subcommand: "edit" });
      fixture.service.findForEdit.mockResolvedValueOnce({ outcome });
      await handleMessageCommand(fixture.interaction, fixture.service);
      expect(fixture.showModal).not.toHaveBeenCalled();
      expect(fixture.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    },
  );
});

describe("managed message reference parsing", () => {
  const guildId = "700000000000000001";
  const channelId = "800000000000000001";
  const messageId = "900000000000000001";

  it("accepts a strict bare snowflake and canonical discord.com link", () => {
    expect(parseManagedMessageReference(messageId, guildId, channelId)).toEqual({
      ok: true,
      messageId,
    });
    expect(
      parseManagedMessageReference(
        `https://discord.com/channels/${guildId}/${channelId}/${messageId}`,
        guildId,
        channelId,
      ),
    ).toEqual({ ok: true, messageId });
  });

  it.each([
    "0",
    "123",
    "0900000000000000001",
    "18446744073709551616",
    "https://canary.discord.com/channels/700000000000000001/800000000000000001/900000000000000001",
    "https://ptb.discord.com/channels/700000000000000001/800000000000000001/900000000000000001",
    "https://discordapp.com/channels/700000000000000001/800000000000000001/900000000000000001",
    "https://discord.com/channels/700000000000000001/800000000000000001/900000000000000001/",
    "https://discord.com/channels/700000000000000001/800000000000000001/900000000000000001?x=1",
    "https://discord.com/channels/700000000000000001/800000000000000001/900000000000000001#x",
  ])("rejects non-canonical target %s", (value) => {
    expect(parseManagedMessageReference(value, guildId, channelId)).toEqual({
      ok: false,
      code: "INVALID",
    });
  });

  it("rejects guild and channel mismatch before a managed-message lookup", () => {
    expect(
      parseManagedMessageReference(
        `https://discord.com/channels/700000000000000002/${channelId}/${messageId}`,
        guildId,
        channelId,
      ),
    ).toMatchObject({ ok: false, code: "CURRENT_CHANNEL_MISMATCH" });
    expect(
      parseManagedMessageReference(
        `https://discord.com/channels/${guildId}/800000000000000002/${messageId}`,
        guildId,
        channelId,
      ),
    ).toMatchObject({ ok: false, code: "CURRENT_CHANNEL_MISMATCH" });
  });

  it("strictly parses owned edit modal IDs and bounded revisions", () => {
    expect(parseManagedMessageEditModalId("managed-message:edit:900000000000000001:4")).toEqual({
      messageId: "900000000000000001",
      expectedRevision: 4,
    });
    expect(
      parseManagedMessageEditModalId("managed-message:edit:900000000000000001:04"),
    ).toBeUndefined();
    expect(
      parseManagedMessageEditModalId("managed-message:edit:900000000000000001:2147483647"),
    ).toBeUndefined();
  });
});

describe("managed message modal submit", () => {
  it("silently ignores unrelated modal IDs", async () => {
    const fixture = createModalInteraction({ customId: "unrelated:modal" });
    await expect(
      handleManagedMessageModalSubmit(fixture.interaction, fixture.service),
    ).resolves.toBe(false);
    expect(fixture.deferReply).not.toHaveBeenCalled();
    expect(fixture.service.send).not.toHaveBeenCalled();
  });

  it.each(["", "   ", "x".repeat(2_001)])(
    "rejects invalid content synchronously",
    async (content) => {
      const fixture = createModalInteraction({ content });
      await expect(
        handleManagedMessageModalSubmit(fixture.interaction, fixture.service),
      ).resolves.toBe(true);
      expect(fixture.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
      expect(fixture.deferReply).not.toHaveBeenCalled();
      expect(fixture.service.send).not.toHaveBeenCalled();
    },
  );

  it("waits for deferReply to settle before starting service work", async () => {
    let settleDefer!: () => void;
    const pendingDefer = new Promise<void>((resolve) => {
      settleDefer = resolve;
    });
    const fixture = createModalInteraction({
      content: "<@123> exact",
      deferImplementation: () => pendingDefer,
    });

    const handling = handleManagedMessageModalSubmit(fixture.interaction, fixture.service);

    await vi.waitFor(() => expect(fixture.deferReply).toHaveBeenCalledOnce());
    expect(fixture.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(fixture.service.send).not.toHaveBeenCalled();

    settleDefer();
    await Promise.resolve();
    await vi.waitFor(() => expect(fixture.service.send).toHaveBeenCalledOnce());
    await expect(handling).resolves.toBe(true);

    expect(fixture.service.send).toHaveBeenCalledWith({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      content: "<@123> exact",
    });
    expect(fixture.editReply).toHaveBeenCalledWith({
      content: "Managed message sent.",
      allowedMentions: { parse: [] },
    });
  });

  it("includes only the known message ID in a partial-failure response", async () => {
    const fixture = createModalInteraction({
      content: "sensitive content",
      sendImplementation: () =>
        Promise.resolve({
          outcome: "PARTIAL_FAILURE",
          messageId: "999999999999999999",
        }),
    });
    await handleManagedMessageModalSubmit(fixture.interaction, fixture.service);
    const rendered = JSON.stringify(fixture.editReply.mock.calls);
    expect(rendered).toContain("999999999999999999");
    expect(rendered).not.toContain("sensitive content");
  });

  it("rejects malformed owned edit IDs but silently ignores unrelated IDs", async () => {
    const malformed = createModalInteraction({ customId: "managed-message:edit:bad:1" });
    const unrelated = createModalInteraction({ customId: "another:edit:900000000000000001:1" });
    await expect(
      handleManagedMessageModalSubmit(malformed.interaction, malformed.service),
    ).resolves.toBe(true);
    await expect(
      handleManagedMessageModalSubmit(unrelated.interaction, unrelated.service),
    ).resolves.toBe(false);
    expect(malformed.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(malformed.service.edit).not.toHaveBeenCalled();
    expect(unrelated.reply).not.toHaveBeenCalled();
  });

  it("waits for defer settlement before starting edit service work", async () => {
    let settleDefer!: () => void;
    const fixture = createModalInteraction({
      customId: "managed-message:edit:900000000000000001:3",
      content: "edited exact content",
      deferImplementation: () =>
        new Promise<void>((resolve) => {
          settleDefer = resolve;
        }),
    });
    const handling = handleManagedMessageModalSubmit(fixture.interaction, fixture.service);
    await vi.waitFor(() => expect(fixture.deferReply).toHaveBeenCalledOnce());
    expect(fixture.service.edit).not.toHaveBeenCalled();
    settleDefer();
    await expect(handling).resolves.toBe(true);
    expect(fixture.service.edit).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      channelId: "channel-id",
      messageId: "900000000000000001",
      actorUserId: "actor-id",
      expectedRevision: 3,
      content: "edited exact content",
    });
  });
});

function createCommandInteraction(
  overrides: {
    type?: ChannelType;
    archived?: boolean | null;
    inGuild?: boolean;
    canManage?: boolean;
    subcommand?: "send" | "edit";
    messageReference?: string;
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  const reply = vi.fn(() => Promise.resolve());
  const showModal = vi.fn((modal: ModalBuilder) => {
    void modal;
    return Promise.resolve();
  });
  const channel = {
    type,
    archived: overrides.archived === undefined ? false : overrides.archived,
    isThread: () =>
      [
        ChannelType.PublicThread,
        ChannelType.PrivateThread,
        ChannelType.AnnouncementThread,
      ].includes(type),
  };
  const interaction = {
    options: {
      getSubcommand: () => overrides.subcommand ?? "send",
      getString: () => overrides.messageReference ?? "900000000000000001",
    },
    inGuild: () => overrides.inGuild ?? true,
    channel,
    memberPermissions: { has: () => overrides.canManage ?? true },
    guildId: "700000000000000001",
    channelId: "800000000000000001",
    reply,
    showModal,
  } as unknown as ChatInputCommandInteraction;
  const service = {
    send: vi.fn(),
    findForEdit: vi.fn(),
    edit: vi.fn(),
  } satisfies ManagedMessageService;
  return { interaction, reply, showModal, service };
}

function createModalInteraction(
  overrides: {
    customId?: string;
    content?: string;
    inGuild?: boolean;
    deferImplementation?: () => Promise<void>;
    sendImplementation?: ManagedMessageService["send"];
  } = {},
) {
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(overrides.deferImplementation ?? (() => Promise.resolve()));
  const editReply = vi.fn(() => Promise.resolve());
  const sendImplementation: ManagedMessageService["send"] =
    overrides.sendImplementation ??
    (() => Promise.resolve({ outcome: "SUCCESS", messageId: "message-id" } as const));
  const send = vi.fn(sendImplementation);
  const service = {
    send,
    findForEdit: vi.fn(),
    edit: vi.fn(() =>
      Promise.resolve({ outcome: "SUCCESS", messageId: "message-id", revision: 2 } as const),
    ),
  } satisfies ManagedMessageService;
  const interaction = {
    customId: overrides.customId ?? MANAGED_MESSAGE_SEND_MODAL_ID,
    fields: { getTextInputValue: () => overrides.content ?? "content" },
    inGuild: () => overrides.inGuild ?? true,
    guildId: "guild-id",
    channelId: "channel-id",
    user: { id: "actor-id" },
    reply,
    deferReply,
    editReply,
  } as unknown as ModalSubmitInteraction;
  return { interaction, service, reply, deferReply, editReply };
}
