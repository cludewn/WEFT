import {
  ChannelType,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputStyle,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";

import {
  createManagedMessageSendModal,
  createManagedMessageEditModal,
  createScheduledMessageCreateModal,
  createScheduledMessageEditModal,
  createRecurringMessageCreateModal,
  createRecurringMessageCreateModalId,
  parseRecurringMessageCreateModalId,
  handleManagedMessageModalSubmit,
  handleMessageCommand,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
  MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
  MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
  MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
  MANAGED_MESSAGE_EDIT_MODAL_PREFIX,
  MANAGED_MESSAGE_SEND_MODAL_ID,
  messageCommandDefinition,
  parseManagedMessageEditModalId,
  parseManagedMessageReference,
} from "../../src/messages/message-command.js";
import type { ManagedMessageService } from "../../src/messages/managed-message.js";

describe("message command", () => {
  it("transports compact recurring state without losing omitted versus explicit UTC", () => {
    const omitted = createRecurringMessageCreateModalId({ frequency: "daily", time: "09:30" });
    const explicit = createRecurringMessageCreateModalId({
      frequency: "daily",
      time: "09:30",
      timezone: "UTC",
    });
    expect(omitted.length).toBeLessThanOrEqual(100);
    expect(explicit.length).toBeLessThanOrEqual(100);
    expect(omitted).not.toBe(explicit);
    expect(parseRecurringMessageCreateModalId(omitted)).toEqual({
      frequency: "daily",
      time: "09:30",
    });
    expect(parseRecurringMessageCreateModalId(explicit)).toEqual({
      frequency: "daily",
      time: "09:30",
      timezone: "UTC",
    });
    expect(
      parseRecurringMessageCreateModalId(
        createRecurringMessageCreateModalId({
          frequency: "weekly",
          time: "01:30",
          weekdays: "mon,fri",
          timezone: "America/New_York",
        }),
      ),
    ).toEqual({
      frequency: "weekly",
      time: "01:30",
      weekdays: "mon,fri",
      timezone: "America/New_York",
    });
    expect(
      parseRecurringMessageCreateModalId("recurring-message:create:w:0930:0:-"),
    ).toBeUndefined();
    expect(
      parseRecurringMessageCreateModalId("recurring-message:create:d:0930:1:-"),
    ).toBeUndefined();
    expect(
      parseRecurringMessageCreateModalId("recurring-message:create:d:0930:127:%GG"),
    ).toBeUndefined();
  });
  it("defines guild-only /message send with ManageMessages and no input options", () => {
    const definition = messageCommandDefinition.toJSON();
    expect(definition.name).toBe("message");
    expect(definition.contexts).toEqual([InteractionContextType.Guild]);
    expect(definition.default_member_permissions).toBe(
      PermissionFlagsBits.ManageMessages.toString(),
    );
    expect(definition.options).toHaveLength(3);
    expect(definition.options?.[0]).toMatchObject({ name: "send", options: [] });
    expect(definition.options?.[1]).toMatchObject({
      name: "edit",
      options: [{ name: "message", required: true }],
    });
    expect(definition.options?.[2]).toMatchObject({
      name: "schedule",
      description: "Manage scheduled messages",
      options: [
        {
          name: "create",
          options: [
            { name: "after", required: false },
            { name: "at", required: false, min_length: 16, max_length: 16 },
          ],
        },
        {
          name: "recurring-create",
          options: [
            {
              name: "frequency",
              required: true,
              choices: [
                { name: "daily", value: "daily" },
                { name: "weekly", value: "weekly" },
              ],
            },
            { name: "time", required: true },
            { name: "weekdays", required: false },
            { name: "timezone", required: false },
          ],
        },
        { name: "cancel", options: [{ name: "id", required: true }] },
        { name: "status", options: [{ name: "id", required: true }] },
        { name: "list", options: [{ name: "page", required: false, min_value: 1 }] },
        { name: "edit", options: [{ name: "id", required: true }] },
        {
          name: "reschedule",
          options: [
            { name: "id", required: true },
            { name: "after", required: false },
            { name: "at", required: false, min_length: 16, max_length: 16 },
          ],
        },
        {
          name: "recurrence-edit",
          options: [
            { name: "id", required: true },
            {
              name: "frequency",
              required: true,
              choices: [
                { name: "daily", value: "daily" },
                { name: "weekly", value: "weekly" },
              ],
            },
            { name: "time", required: true },
            { name: "weekdays", required: false },
            { name: "timezone", required: false },
          ],
        },
      ],
    });
  });

  it("creates the exact five optional fields for the send modal", () => {
    const modal = createManagedMessageSendModal().toJSON();
    expect(modal).toMatchObject({
      custom_id: MANAGED_MESSAGE_SEND_MODAL_ID,
      title: "Send managed message",
    });
    expect(modal.components).toHaveLength(5);
    expect(modal.components[0]).toMatchObject({
      type: ComponentType.Label,
      label: "Message content",
      component: {
        type: ComponentType.TextInput,
        custom_id: MANAGED_MESSAGE_CONTENT_INPUT_ID,
        style: TextInputStyle.Paragraph,
        required: false,
        max_length: 2_000,
      },
    });
    const components = modal.components.map((component) =>
      "component" in component ? component.component : undefined,
    );
    expect(components).toMatchObject([
      {
        custom_id: MANAGED_MESSAGE_CONTENT_INPUT_ID,
        style: TextInputStyle.Paragraph,
        max_length: 2_000,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 256,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
        style: TextInputStyle.Paragraph,
        max_length: 4_000,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 7,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 2_048,
      },
    ]);
    expect(JSON.stringify(modal.components)).not.toContain("min_length");
    expect(JSON.stringify(modal.components)).not.toContain("value");
  });

  it("creates an exact prefilled edit modal with only message ID and revision in its custom ID", () => {
    const modal = createManagedMessageEditModal("900000000000000001", 4, {
      content: "  exact <@123> content  ",
      embed: {
        title: "Title",
        description: "Description",
        color: 0x00ff7f,
        imageUrl: "https://example.invalid/image.png",
      },
    }).toJSON();
    expect(modal.custom_id).toBe(`${MANAGED_MESSAGE_EDIT_MODAL_PREFIX}900000000000000001:4`);
    expect(JSON.stringify(modal.custom_id)).not.toContain("exact");
    expect(
      modal.components.map((component) =>
        "component" in component ? component.component : undefined,
      ),
    ).toMatchObject([
      { value: "  exact <@123> content  " },
      { value: "Title" },
      { value: "Description" },
      { value: "#00FF7F" },
      { value: "https://example.invalid/image.png" },
    ]);
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
      payload: {
        content: "persisted exact content",
        embed: { title: "persisted title", color: 0 },
      },
    });

    await handleMessageCommand(fixture.interaction, fixture.service);

    expect(fixture.service.findForEdit).toHaveBeenCalledExactlyOnceWith({
      guildId: "700000000000000001",
      channelId: "800000000000000001",
      messageId: "900000000000000001",
    });
    expect(fixture.showModal).toHaveBeenCalledOnce();
    const shownModal = fixture.showModal.mock.calls[0]?.[0];
    expect(
      shownModal === undefined ? undefined : ModalBuilder.from(shownModal).toJSON(),
    ).toMatchObject({
      custom_id: "managed-message:edit:900000000000000001:7",
      components: [
        { component: { value: "persisted exact content" } },
        { component: { value: "persisted title" } },
        {},
        { component: { value: "#000000" } },
        {},
      ],
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
      payload: { content: "<@123> exact", embed: null },
    });
    expect(fixture.editReply).toHaveBeenCalledWith({
      content: "Managed message `message-id` sent.",
      allowedMentions: { parse: [] },
    });
  });

  it("normalizes one embed-only modal payload before service work", async () => {
    const fixture = createModalInteraction({
      content: "",
      embedTitle: "  Title  ",
      embedDescription: " Description ",
      embedColor: "#00ff7f",
      embedImageUrl: " HTTPS://EXAMPLE.INVALID/a/../image.png ",
    });
    await expect(
      handleManagedMessageModalSubmit(fixture.interaction, fixture.service),
    ).resolves.toBe(true);
    expect(fixture.service.send).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      payload: {
        content: "",
        embed: {
          title: "Title",
          description: "Description",
          color: 0x00ff7f,
          imageUrl: "https://example.invalid/image.png",
        },
      },
    });
  });

  it("includes only the known message ID in a partial-failure response", async () => {
    const fixture = createModalInteraction({
      content: "sensitive content",
      sendImplementation: () =>
        Promise.resolve({
          outcome: "PARTIAL_FAILURE",
          deletionOutcome: "UNCONFIRMED",
          messageId: "999999999999999999",
        }),
    });
    await handleManagedMessageModalSubmit(fixture.interaction, fixture.service);
    const rendered = JSON.stringify(fixture.editReply.mock.calls);
    expect(rendered).toContain("999999999999999999");
    expect(rendered).not.toContain("sensitive content");
  });

  it.each([
    [{ outcome: "UNCONFIRMED", messageId: "999999999999999999" }, "did not attempt removal"],
    [
      { outcome: "PARTIAL_FAILURE", messageId: "999999999999999999", deletionOutcome: "REJECTED" },
      "Discord rejected removal",
    ],
    [{ outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT" }, "already absent"],
  ] as const)(
    "renders send uncertainty or compensation truthfully %#",
    async (result, expected) => {
      const fixture = createModalInteraction({
        content: "sensitive content",
        sendImplementation: () => Promise.resolve(result),
      });
      await handleManagedMessageModalSubmit(fixture.interaction, fixture.service);
      const rendered = JSON.stringify(fixture.editReply.mock.calls);
      expect(rendered).toContain(expected);
      expect(rendered).not.toContain("sensitive content");
      expect(rendered).not.toContain("Managed message sent.");
      expect(fixture.service.send).toHaveBeenCalledOnce();
    },
  );

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
      payload: { content: "edited exact content", embed: null },
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
  const showModal = vi.fn((modal: Parameters<typeof ModalBuilder.from>[0]) => {
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
      getSubcommandGroup: () => null,
      getString: () => overrides.messageReference ?? "900000000000000001",
    },
    createdTimestamp: Date.now(),
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
    embedTitle?: string;
    embedDescription?: string;
    embedColor?: string;
    embedImageUrl?: string;
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
    edit: vi.fn<ManagedMessageService["edit"]>(() =>
      Promise.resolve({ outcome: "SUCCESS", messageId: "message-id", revision: 2 } as const),
    ),
  } satisfies ManagedMessageService;
  const interaction = {
    customId: overrides.customId ?? MANAGED_MESSAGE_SEND_MODAL_ID,
    fields: {
      getTextInputValue: (customId: string) => {
        switch (customId) {
          case MANAGED_MESSAGE_CONTENT_INPUT_ID:
            return overrides.content ?? "content";
          case MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID:
            return overrides.embedTitle ?? "";
          case MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID:
            return overrides.embedDescription ?? "";
          case MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID:
            return overrides.embedColor ?? "";
          case MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID:
            return overrides.embedImageUrl ?? "";
          default:
            throw new Error(`Unexpected field ${customId}`);
        }
      },
    },
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

it("keeps one-time option descriptions within Discord's 100-character limit", () => {
  const group = messageCommandDefinition
    .toJSON()
    .options?.find((option) => option.name === "schedule");
  if (group === undefined || !("options" in group)) throw new Error("missing schedule group");
  for (const command of group.options ?? []) {
    if (command.name !== "create" && command.name !== "reschedule") continue;
    expect(command.description.length).toBeLessThanOrEqual(100);
    if ("options" in command) {
      for (const option of command.options ?? [])
        expect(option.description.length).toBeLessThanOrEqual(100);
    }
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingLookup() {
  let resolve!: (value: Awaited<ReturnType<ManagedMessageService["findForEdit"]>>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Awaited<ReturnType<ManagedMessageService["findForEdit"]>>>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    },
  );
  return { promise, resolve, reject };
}
const editableMessage = {
  outcome: "FOUND" as const,
  messageId: "900000000000000001",
  revision: 3,
  payload: { content: "persisted", embed: null },
};

describe("managed edit bounded Modal preparation", () => {
  it.each([1_999, 2_000, 2_001])("enforces the creation deadline at %sms", async (age) => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    const gate = pendingLookup();
    f.service.findForEdit.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, f.service);
    await vi.advanceTimersByTimeAsync(age);
    gate.resolve(editableMessage);
    await operation;
    expect(f.showModal).toHaveBeenCalledTimes(age < 2_000 ? 1 : 0);
    expect(f.reply).toHaveBeenCalledTimes(age < 2_000 ? 0 : 1);
    expect(f.service.findForEdit).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([1_999, 2_000, 2_499, 2_500, 2_501])(
    "uses the interaction age before starting a lookup at %sms",
    async (age) => {
      vi.useFakeTimers();
      const f = createCommandInteraction({ subcommand: "edit" });
      Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - age });
      f.service.findForEdit.mockResolvedValueOnce(editableMessage);
      await handleMessageCommand(f.interaction, f.service);
      expect(f.service.findForEdit).toHaveBeenCalledTimes(age < 2_000 ? 1 : 0);
      expect(f.showModal).toHaveBeenCalledTimes(age < 2_000 ? 1 : 0);
      expect(f.reply).toHaveBeenCalledTimes(age >= 2_000 && age < 2_500 ? 1 : 0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["resolve", "reject"])(
    "keeps the handler pending after timeout until late %s",
    async (outcome) => {
      vi.useFakeTimers();
      const f = createCommandInteraction({ subcommand: "edit" });
      const gate = pendingLookup();
      f.service.findForEdit.mockReturnValueOnce(gate.promise);
      let done = false;
      const operation = handleMessageCommand(f.interaction, f.service).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.reply).toHaveBeenCalledExactlyOnceWith({
        content: "WEFT could not load the managed message. Please try again later.",
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      });
      expect(done).toBe(false);
      if (outcome === "resolve") gate.resolve(editableMessage);
      else gate.reject(new Error("late private DB error"));
      await operation;
      expect(done).toBe(true);
      expect(f.showModal).not.toHaveBeenCalled();
      expect(f.reply).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("retains the read and preserves a failed timeout response over late DB rejection", async () => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    const gate = pendingLookup();
    const error = new Error("timeout reply lost");
    f.reply.mockRejectedValueOnce(error);
    f.service.findForEdit.mockReturnValueOnce(gate.promise);
    let done = false;
    const operation = handleMessageCommand(f.interaction, f.service).catch((reason: unknown) => {
      done = true;
      return reason;
    });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(done).toBe(false);
    gate.reject(new Error("late DB failure"));
    expect(await operation).toBe(error);
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it.each([2_499, 2_500, 2_501])(
    "does not start a timeout response past the response ceiling (%s)",
    async (age) => {
      vi.useFakeTimers();
      const f = createCommandInteraction({ subcommand: "edit" });
      const gate = pendingLookup();
      f.service.findForEdit.mockReturnValueOnce(gate.promise);
      const operation = handleMessageCommand(f.interaction, f.service);
      await vi.advanceTimersByTimeAsync(0);
      // Simulate a busy event loop: the timeout callback cannot run until this age.
      vi.spyOn(performance, "now").mockReturnValue(age);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.reply).toHaveBeenCalledTimes(age < 2_500 ? 1 : 0);
      gate.resolve(editableMessage);
      await operation;
      expect(f.showModal).not.toHaveBeenCalled();
    },
  );

  it("checks elapsed time when a DB microtask wins before the timeout callback", async () => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    const gate = pendingLookup();
    f.service.findForEdit.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, f.service);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, "now").mockReturnValue(2_001);
    gate.resolve(editableMessage);
    await operation;
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("includes serialization in the budget and rechecks immediately before showModal", async () => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    f.service.findForEdit.mockResolvedValueOnce(editableMessage);
    const data = createManagedMessageEditModal(
      editableMessage.messageId,
      editableMessage.revision,
      editableMessage.payload,
    ).toJSON();
    vi.spyOn(ModalBuilder.prototype, "toJSON").mockImplementationOnce(() => {
      vi.spyOn(performance, "now").mockReturnValue(2_000);
      return data;
    });
    await handleMessageCommand(f.interaction, f.service);
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses monotonic elapsed time even when wall time moves backwards", async () => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    const gate = pendingLookup();
    f.service.findForEdit.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, f.service);
    vi.setSystemTime(Date.now() - 60_000);
    await vi.advanceTimersByTimeAsync(2_000);
    gate.resolve(editableMessage);
    await operation;
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledOnce();
  });

  it.each(["lookup", "construction", "serialization", "showModal"])(
    "keeps %s failure separate and never retries a Modal response",
    async (stage) => {
      const f = createCommandInteraction({ subcommand: "edit" });
      const error = new Error(`private ${stage} failure`);
      f.service.findForEdit.mockResolvedValueOnce(editableMessage);
      if (stage === "lookup") f.service.findForEdit.mockReset().mockRejectedValueOnce(error);
      if (stage === "construction")
        vi.spyOn(ModalBuilder.prototype, "setTitle").mockImplementationOnce(() => {
          throw error;
        });
      if (stage === "serialization")
        vi.spyOn(ModalBuilder.prototype, "toJSON").mockImplementationOnce(() => {
          throw error;
        });
      if (stage === "showModal") f.showModal.mockRejectedValueOnce(error);
      await expect(handleMessageCommand(f.interaction, f.service)).rejects.toBe(error);
      expect(f.reply).toHaveBeenCalledTimes(stage === "showModal" ? 0 : 1);
      expect(f.showModal).toHaveBeenCalledTimes(stage === "showModal" ? 1 : 0);
      expect(f.service.findForEdit).toHaveBeenCalledOnce();
    },
  );
});

it.each([499, 500, 501])(
  "subtracts the managed interaction's existing age from the lookup budget (%sms)",
  async (delay) => {
    vi.useFakeTimers();
    const f = createCommandInteraction({ subcommand: "edit" });
    Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - 1_500 });
    const gate = pendingLookup();
    f.service.findForEdit.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, f.service);
    await vi.advanceTimersByTimeAsync(delay);
    gate.resolve(editableMessage);
    await operation;
    expect(f.showModal).toHaveBeenCalledTimes(delay < 500 ? 1 : 0);
    expect(f.reply).toHaveBeenCalledTimes(delay < 500 ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["context", "authorization", "reference"])(
  "does not start a late managed edit validation response (%s)",
  async (failure) => {
    vi.useFakeTimers();
    const f = createCommandInteraction({
      subcommand: "edit",
      inGuild: failure !== "context",
      canManage: failure !== "authorization",
      messageReference: failure === "reference" ? "bad" : editableMessage.messageId,
    });
    Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - 2_500 });
    await handleMessageCommand(f.interaction, f.service);
    expect(f.reply).not.toHaveBeenCalled();
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.service.findForEdit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["send", "edit", "scheduled-create", "scheduled-edit", "recurring-create"] as const)(
  "serializes concise labels and five optional inputs for %s without changing identity or values",
  (kind) => {
    const payload = {
      content: "**Keep** <@123>",
      embed: {
        title: "Title",
        description: "Description",
        color: 0x5865f2,
        imageUrl: "https://example.invalid/image.png",
      },
    };
    const scheduleId = "11111111-1111-4111-8111-111111111111";
    const modals = {
      send: createManagedMessageSendModal(),
      edit: createManagedMessageEditModal("900000000000000001", 3, payload),
      "scheduled-create": createScheduledMessageCreateModal({ kind: "AFTER", durationMs: 60_000 }),
      "scheduled-edit": createScheduledMessageEditModal(scheduleId, 3, payload),
      "recurring-create": createRecurringMessageCreateModal({ frequency: "daily", time: "09:30" }),
    };
    const expectedIds = {
      send: "managed-message:send",
      edit: "managed-message:edit:900000000000000001:3",
      "scheduled-create": "scheduled-message:schedule-create:60000",
      "scheduled-edit": `scheduled-message:schedule-edit:${scheduleId}:3`,
      "recurring-create": "recurring-message:create:d:0930:127:-",
    };
    const modal = modals[kind].toJSON();
    expect(modal.custom_id).toBe(expectedIds[kind]);
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(ModalBuilder.from(modal).toJSON()).toEqual(modal);
    expect(modal.components).toHaveLength(5);
    const labels = modal.components.map((label) => {
      if (!("label" in label)) throw new Error("Expected Modal label");
      return label;
    });
    expect(labels.map(({ label, description }) => ({ label, description }))).toEqual([
      { label: "Message content", description: "Enter text or provide a visible embed." },
      { label: "Embed title", description: undefined },
      { label: "Embed description", description: undefined },
      { label: "Embed color", description: "Hex color: RRGGBB or #RRGGBB." },
      { label: "Embed image URL", description: "Absolute HTTP or HTTPS URL." },
    ]);
    expect(Object.hasOwn(labels[1]!, "description")).toBe(false);
    expect(Object.hasOwn(labels[2]!, "description")).toBe(false);
    const inputs = labels.map((label) => label.component);
    const expectedInputs = [
      {
        custom_id: MANAGED_MESSAGE_CONTENT_INPUT_ID,
        style: TextInputStyle.Paragraph,
        max_length: 2000,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 256,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
        style: TextInputStyle.Paragraph,
        max_length: 4000,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 7,
      },
      {
        custom_id: MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
        style: TextInputStyle.Short,
        max_length: 2048,
      },
    ];
    const prefilled = kind === "edit" || kind === "scheduled-edit";
    const values = [payload.content, "Title", "Description", "#5865F2", payload.embed.imageUrl];
    for (const [index, input] of inputs.entries()) {
      expect(input).toMatchObject({
        ...expectedInputs[index],
        type: ComponentType.TextInput,
        required: false,
      });
      if (prefilled) expect(input).toMatchObject({ value: values[index] });
      else expect(Object.hasOwn(input, "value")).toBe(false);
    }
    for (const label of labels) {
      expect(label.label.length).toBeLessThanOrEqual(45);
      if (label.description !== undefined) {
        expect(label.description.length).toBeLessThanOrEqual(100);
        expect(label.description).not.toMatch(/optional|leave empty|whitespace/i);
      }
    }
  },
);

it("identifies confirmed send, edit and unchanged results while retaining management uncertainty", async () => {
  const messageId = "18446744073709551615";
  const send = createModalInteraction({
    sendImplementation: () => Promise.resolve({ outcome: "SUCCESS", messageId }),
  });
  await handleManagedMessageModalSubmit(send.interaction, send.service);
  expect(send.editReply).toHaveBeenCalledWith({
    content: `Managed message \`${messageId}\` sent.`,
    allowedMentions: { parse: [] },
  });
  for (const outcome of ["SUCCESS", "UNCHANGED"] as const) {
    const edit = createModalInteraction({ customId: "managed-message:edit:900000000000000001:3" });
    edit.service.edit.mockResolvedValue(
      outcome === "SUCCESS" ? { outcome, messageId, revision: 4 } : { outcome, messageId },
    );
    await handleManagedMessageModalSubmit(edit.interaction, edit.service);
    expect(edit.editReply).toHaveBeenCalledWith({
      content: `Managed message \`${messageId}\` ${outcome === "SUCCESS" ? "edited" : "unchanged"}.`,
      allowedMentions: { parse: [] },
    });
    expect(edit.service.send).not.toHaveBeenCalled();
  }
  const uncertain = createModalInteraction({
    sendImplementation: () => Promise.resolve({ outcome: "UNCONFIRMED", messageId }),
  });
  await handleManagedMessageModalSubmit(uncertain.interaction, uncertain.service);
  expect(uncertain.editReply).toHaveBeenCalledWith({
    content: `WEFT sent message \`${messageId}\`, but could not confirm whether it is managed. WEFT did not attempt removal. Check its state before retrying or deleting it.`,
    allowedMentions: { parse: [] },
  });
});

it("distinguishes configured scheduling timezones from preserved recurring timezones", () => {
  const group = messageCommandDefinition
    .toJSON()
    .options?.find((option) => option.name === "schedule");
  if (!group || !("options" in group)) throw new Error("Expected schedule group");
  const descriptions = new Map(
    group.options?.map((command) => [command.name, JSON.stringify(command)]),
  );
  expect(descriptions.get("create")).toContain("configured guild timezone");
  expect(descriptions.get("reschedule")).toContain("configured guild timezone");
  expect(descriptions.get("recurring-create")).toContain("defaults to current guild timezone");
  expect(descriptions.get("recurrence-edit")).toContain(
    "omitted keeps the existing series timezone",
  );
  for (const name of ["recurring-create", "recurrence-edit"]) {
    expect(descriptions.get(name)).toContain("Asia/Tokyo or UTC");
    expect(descriptions.get(name)).toContain("HH:MM");
    expect(descriptions.get(name)).toContain("mon,tue,wed,thu,fri,sat,sun");
  }
});
