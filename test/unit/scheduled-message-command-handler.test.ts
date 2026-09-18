import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ManagedMessageService } from "../../src/managed-message.js";
import {
  createScheduledMessageCreateModalId,
  createScheduledMessageEditModalId,
  handleManagedMessageModalSubmit,
  handleMessageCommand,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
  MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
  MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
  MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
  parseScheduledMessageCreateModalId,
  parseScheduledMessageEditModalId,
  SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX,
  SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX,
} from "../../src/message-command.js";
import type { ScheduledMessageCommandService } from "../../src/scheduled-message-command.js";

const executeAt = new Date("2030-01-02T03:04:05.000Z");

function services(
  status: "ACTIVE" | "COMPLETED" = "ACTIVE",
  deliveryPendingReconciliation = false,
) {
  const create = vi.fn<ScheduledMessageCommandService["create"]>(() =>
    Promise.resolve({
      outcome: "SUCCESS",
      definition: {
        action: {
          id: "schedule-id",
          guildId: "guild-id",
          actionType: "SEND_MESSAGE",
          targetId: "channel-id",
          status: "ACTIVE",
          executeAt,
          createdAt: executeAt,
          updatedAt: executeAt,
        },
        creatorUserId: "actor-id",
        retryCount: 0,
        revision: 0,
        payload: {
          content: "sensitive scheduled content",
          embed: {
            title: "sensitive embed title",
            description: "sensitive embed description",
            color: 0,
            imageUrl: "https://sensitive.invalid/image.png",
          },
        },
        resultMessageId: null,
      },
      deliveryPendingReconciliation,
    }),
  );
  const cancel = vi.fn<ScheduledMessageCommandService["cancel"]>(() =>
    Promise.resolve({ outcome: "CANCELLED", deliveryCleanupPending: false }),
  );
  const statusResult =
    status === "COMPLETED"
      ? {
          outcome: "FOUND" as const,
          schedule: {
            scheduledActionId: "schedule-id",
            status,
            guildId: "guild-id",
            channelId: "channel-id",
            executeAt,
            creatorUserId: "actor-id",
            retryCount: 1,
            resultMessageId: "message-id",
          },
        }
      : {
          outcome: "FOUND" as const,
          schedule: {
            scheduledActionId: "schedule-id",
            status,
            guildId: "guild-id",
            channelId: "channel-id",
            executeAt,
            creatorUserId: "actor-id",
            retryCount: 0,
            resultMessageId: null,
          },
        };
  const scheduled = {
    create,
    cancel,
    status: vi.fn<ScheduledMessageCommandService["status"]>(() => Promise.resolve(statusResult)),
    list: vi.fn<ScheduledMessageCommandService["list"]>(() =>
      Promise.resolve({ outcome: "FOUND", schedules: [] }),
    ),
    findEditable: vi.fn<ScheduledMessageCommandService["findEditable"]>(() =>
      Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
    ),
    edit: vi.fn<ScheduledMessageCommandService["edit"]>(() =>
      Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
    ),
    reschedule: vi.fn<ScheduledMessageCommandService["reschedule"]>(() =>
      Promise.resolve({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" }),
    ),
  } satisfies ScheduledMessageCommandService;
  const managed = {
    send: vi.fn(),
    findForEdit: vi.fn(),
    edit: vi.fn(),
  } satisfies ManagedMessageService;
  return { managed, scheduled, create, cancel };
}

function commandInteraction(input: {
  subcommand: "create" | "cancel" | "status" | "list" | "edit" | "reschedule";
  value: string;
  after?: string;
  archived?: boolean;
}) {
  const showModal = vi.fn((modal: ModalBuilder) => {
    void modal;
    return Promise.resolve();
  });
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const channel = {
    type: input.archived ? ChannelType.PublicThread : ChannelType.GuildText,
    archived: input.archived ?? false,
    isThread: () => input.archived ?? false,
  };
  const interaction = {
    options: {
      getSubcommand: () => input.subcommand,
      getSubcommandGroup: () => "schedule",
      getString: (name: string) => (name === "after" ? (input.after ?? input.value) : input.value),
      getInteger: () => 1,
    },
    inGuild: () => true,
    channel,
    memberPermissions: {
      has: (permission: bigint) => permission === PermissionFlagsBits.ManageMessages,
    },
    guildId: "guild-id",
    channelId: "channel-id",
    user: { id: "actor-id" },
    reply,
    deferReply,
    editReply,
    showModal,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, showModal, reply, deferReply, editReply };
}

function modalInteraction(
  customId: string,
  options: {
    authorized?: boolean;
    content?: string;
    inGuild?: boolean;
    channel?: ModalSubmitInteraction["channel"];
  } = {},
) {
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const values: Record<string, string> = {
    [MANAGED_MESSAGE_CONTENT_INPUT_ID]: options.content ?? "sensitive scheduled content",
    [MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID]: "",
  };
  const getTextInputValue = vi.fn((id: string) => values[id] ?? "");
  const interaction = {
    customId,
    fields: { getTextInputValue },
    inGuild: () => options.inGuild ?? true,
    guildId: "guild-id",
    channelId: "channel-id",
    channel: options.channel ?? { type: ChannelType.GuildText },
    memberPermissions: {
      has: (permission: bigint) =>
        (options.authorized ?? true) && permission === PermissionFlagsBits.ManageMessages,
    },
    user: { id: "actor-id" },
    reply,
    deferReply,
    editReply,
  } as unknown as ModalSubmitInteraction;
  return { interaction, reply, deferReply, editReply, getTextInputValue };
}

describe("scheduled message command handler", () => {
  it("round-trips only a validated relative delay in the modal custom ID", () => {
    const customId = createScheduledMessageCreateModalId(3_600_000);
    expect(customId).toBe(`${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}3600000`);
    expect(parseScheduledMessageCreateModalId(customId)).toBe(3_600_000);
    expect(
      parseScheduledMessageCreateModalId(`${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}60001`),
    ).toBe(undefined);
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("opens schedule create only after cheap duration and context validation", async () => {
    const f = commandInteraction({ subcommand: "create", value: "30m" });
    const s = services();
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.showModal.mock.calls[0]?.[0].toJSON()).toMatchObject({
      custom_id: createScheduledMessageCreateModalId(1_800_000),
      title: "Schedule managed message",
    });
    expect(f.deferReply).not.toHaveBeenCalled();
  });

  it("routes a validated schedule modal after ephemeral acknowledgement without Discord create", async () => {
    const f = modalInteraction(createScheduledMessageCreateModalId(3_600_000));
    const s = services();
    await expect(
      handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled),
    ).resolves.toBe(true);
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(s.create).toHaveBeenCalledWith({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      durationMs: 3_600_000,
      payload: { content: "sensitive scheduled content", embed: null },
    });
    expect(s.managed.send).not.toHaveBeenCalled();
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("schedule-id");
    expect(response).toContain("Target: <#channel-id>");
    expect(response).toContain("Runs: <t:1893553445:F> (<t:1893553445:R>)");
    expect(response).not.toContain("sensitive scheduled content");
    expect(response).not.toContain("sensitive embed title");
    expect(response).not.toContain("sensitive embed description");
    expect(response).not.toContain("https://sensitive.invalid/image.png");
    expect(f.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
  });

  it("retains schedule metadata when delivery is pending reconciliation", async () => {
    const f = modalInteraction(createScheduledMessageCreateModalId(3_600_000));
    const s = services("ACTIVE", true);
    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("schedule-id");
    expect(response).toContain("Target: <#channel-id>");
    expect(response).toContain("Runs: <t:1893553445:F> (<t:1893553445:R>)");
    expect(response).toContain("Delivery is pending reconciliation");
    expect(response).not.toContain("sensitive scheduled content");
    expect(response).not.toContain("sensitive embed title");
    expect(response).not.toContain("sensitive embed description");
    expect(response).not.toContain("https://sensitive.invalid/image.png");
  });

  it("rejects a tampered owned modal synchronously", async () => {
    const f = modalInteraction(`${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}60001`);
    const s = services();
    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);
    expect(f.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(s.create).not.toHaveBeenCalled();
  });

  it("round-trips only schedule identity and revision in the edit modal ID", () => {
    const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
    const customId = createScheduledMessageEditModalId(scheduleId, 0);
    expect(customId).toBe(`${SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX}${scheduleId}:0`);
    expect(parseScheduledMessageEditModalId(customId)).toEqual({
      scheduledActionId: scheduleId,
      expectedRevision: 0,
    });
    expect(parseScheduledMessageEditModalId(`${SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX}bad:0`)).toBe(
      undefined,
    );
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("loads a scoped ACTIVE schedule and prefills edit without deferring", async () => {
    const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
    const f = commandInteraction({ subcommand: "edit", value: scheduleId, archived: true });
    const s = services();
    s.scheduled.findEditable.mockResolvedValue({
      outcome: "ACTIVE",
      definition: {
        action: {
          id: scheduleId,
          guildId: "guild-id",
          actionType: "SEND_MESSAGE",
          targetId: "channel-id",
          status: "ACTIVE",
          executeAt,
          createdAt: executeAt,
          updatedAt: executeAt,
        },
        creatorUserId: "creator-id",
        retryCount: 2,
        revision: 4,
        payload: {
          content: "prefilled content",
          embed: { title: "prefilled title", color: 0 },
        },
        resultMessageId: null,
      },
    });

    await handleMessageCommand(f.interaction, s.managed, s.scheduled);

    expect(f.deferReply).not.toHaveBeenCalled();
    expect(s.scheduled.findEditable).toHaveBeenCalledWith({
      scheduledActionId: scheduleId,
      guildId: "guild-id",
      channelId: "channel-id",
    });
    const modal = f.showModal.mock.calls[0]?.[0].toJSON();
    expect(modal).toMatchObject({
      custom_id: createScheduledMessageEditModalId(scheduleId, 4),
      title: "Edit scheduled message",
    });
    expect(JSON.stringify(modal)).toContain("prefilled content");
    expect(JSON.stringify(modal)).toContain("prefilled title");
  });

  it("rejects malformed scheduled edit modal IDs before acknowledgement", async () => {
    const f = modalInteraction(`${SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX}tampered:0`);
    const s = services();
    await expect(
      handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled),
    ).resolves.toBe(true);
    expect(f.reply).toHaveBeenCalledWith(
      expect.objectContaining({ flags: MessageFlags.Ephemeral }),
    );
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(s.scheduled.edit).not.toHaveBeenCalled();
  });

  it("rejects a scheduled edit that lost authorization before reading invalid payload", async () => {
    const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
    const f = modalInteraction(createScheduledMessageEditModalId(scheduleId, 7), {
      authorized: false,
      content: "",
    });
    const s = services();

    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);

    expect(f.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "You need the Manage Messages permission to manage messages.",
      }),
    );
    expect(f.getTextInputValue).not.toHaveBeenCalled();
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(s.scheduled.edit).not.toHaveBeenCalled();
  });

  it("rejects a scheduled edit outside guild context before reading invalid payload", async () => {
    const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
    const f = modalInteraction(createScheduledMessageEditModalId(scheduleId, 7), {
      content: "",
      inGuild: false,
    });
    const s = services();

    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);

    expect(f.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Scheduled-message administration is only supported in a guild text or thread channel.",
      }),
    );
    expect(f.getTextInputValue).not.toHaveBeenCalled();
    expect(s.scheduled.edit).not.toHaveBeenCalled();
  });

  it("submits a canonical scheduled edit with the modal revision", async () => {
    const scheduleId = "123e4567-e89b-42d3-a456-426614174000";
    const f = modalInteraction(createScheduledMessageEditModalId(scheduleId, 7));
    const s = services();
    s.scheduled.edit.mockResolvedValue({
      outcome: "EDITED",
      definition: {
        action: {
          id: scheduleId,
          guildId: "guild-id",
          actionType: "SEND_MESSAGE",
          targetId: "channel-id",
          status: "ACTIVE",
          executeAt,
          createdAt: executeAt,
          updatedAt: executeAt,
        },
        creatorUserId: "creator-id",
        retryCount: 0,
        revision: 8,
        payload: { content: "sensitive scheduled content", embed: null },
        resultMessageId: null,
      },
    });

    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);

    expect(s.scheduled.edit).toHaveBeenCalledWith({
      scheduledActionId: scheduleId,
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      expectedRevision: 7,
      payload: { content: "sensitive scheduled content", embed: null },
    });
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it("renders list metadata without scheduled payload", async () => {
    const f = commandInteraction({ subcommand: "list", value: "" });
    const s = services();
    s.scheduled.list.mockResolvedValue({
      outcome: "FOUND",
      schedules: [
        {
          scheduledActionId: "full-schedule-id",
          status: "ACTIVE",
          executeAt,
          creatorUserId: "creator-id",
        },
      ],
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("full-schedule-id");
    expect(response).toContain("ACTIVE");
    expect(response).toContain("creator-id");
    expect(response).not.toContain("sensitive scheduled content");
  });

  it("parses reschedule duration before deferring and routes the focused operation", async () => {
    const f = commandInteraction({
      subcommand: "reschedule",
      value: "schedule-id",
      after: "2h",
    });
    const s = services();
    s.scheduled.reschedule.mockResolvedValue({ outcome: "EXECUTING" });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(s.scheduled.reschedule).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      durationMs: 7_200_000,
    });
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it("allows cancellation from an archived supported thread and defers before persistence", async () => {
    const f = commandInteraction({ subcommand: "cancel", value: "schedule-id", archived: true });
    const s = services();
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(s.cancel).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
    });
  });

  it("renders completed status with a canonical link and without payload", async () => {
    const f = commandInteraction({ subcommand: "status", value: "schedule-id" });
    const s = services("COMPLETED");
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("schedule-id");
    expect(response).toContain("COMPLETED");
    expect(response).toContain("Target: <#channel-id>");
    expect(response).toContain("Runs: <t:1893553445:F> (<t:1893553445:R>)");
    expect(response).toContain("actor-id");
    expect(response).toContain("Retry count: 1");
    expect(response).toContain("https://discord.com/channels/guild-id/channel-id/message-id");
    expect(response).not.toContain("sensitive scheduled content");
    expect(response).not.toContain("sensitive embed title");
    expect(response).not.toContain("sensitive embed description");
    expect(response).not.toContain("https://sensitive.invalid/image.png");
    expect(f.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ allowedMentions: { parse: [] } }),
    );
  });
});
