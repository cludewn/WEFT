import {
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  TextInputStyle,
} from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";

import {
  createManagedMessageSendModal,
  handleManagedMessageModalSubmit,
  handleMessageCommand,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  MANAGED_MESSAGE_SEND_MODAL_ID,
  messageCommandDefinition,
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
    expect(definition.options).toHaveLength(1);
    expect(definition.options?.[0]).toMatchObject({ name: "send", options: [] });
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

  it.each([
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ])("opens the modal in supported active target %s", async (type) => {
    const fixture = createCommandInteraction({ type });
    await handleMessageCommand(fixture.interaction);
    expect(fixture.showModal).toHaveBeenCalledOnce();
    expect(fixture.reply).not.toHaveBeenCalled();
  });

  it.each([ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.DM])(
    "rejects unsupported target %s",
    async (type) => {
      const fixture = createCommandInteraction({ type });
      await handleMessageCommand(fixture.interaction);
      expect(fixture.showModal).not.toHaveBeenCalled();
      expect(fixture.reply).toHaveBeenCalledWith(
        expect.objectContaining({ flags: MessageFlags.Ephemeral }),
      );
    },
  );

  it("rejects an archived or unknown-state thread", async () => {
    for (const archived of [true, null]) {
      const fixture = createCommandInteraction({ type: ChannelType.PublicThread, archived });
      await handleMessageCommand(fixture.interaction);
      expect(fixture.showModal).not.toHaveBeenCalled();
    }
  });

  it("rejects non-guild and missing ManageMessages before opening a modal", async () => {
    const nonGuild = createCommandInteraction({ inGuild: false });
    const denied = createCommandInteraction({ canManage: false });
    await handleMessageCommand(nonGuild.interaction);
    await handleMessageCommand(denied.interaction);
    expect(nonGuild.showModal).not.toHaveBeenCalled();
    expect(denied.showModal).not.toHaveBeenCalled();
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
});

function createCommandInteraction(
  overrides: {
    type?: ChannelType;
    archived?: boolean | null;
    inGuild?: boolean;
    canManage?: boolean;
  } = {},
) {
  const type = overrides.type ?? ChannelType.GuildText;
  const reply = vi.fn(() => Promise.resolve());
  const showModal = vi.fn(() => Promise.resolve());
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
    options: { getSubcommand: () => "send" },
    inGuild: () => overrides.inGuild ?? true,
    channel,
    memberPermissions: { has: () => overrides.canManage ?? true },
    reply,
    showModal,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, showModal };
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
  const service = { send } satisfies ManagedMessageService;
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
