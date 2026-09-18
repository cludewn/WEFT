import { ChannelType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, ModalBuilder, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ManagedMessageService } from "../../src/managed-message.js";
import {
  createScheduledMessageCreateModalId,
  handleManagedMessageModalSubmit,
  handleMessageCommand,
  MANAGED_MESSAGE_CONTENT_INPUT_ID,
  MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
  MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
  MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
  MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
  parseScheduledMessageCreateModalId,
  SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX,
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
  } satisfies ScheduledMessageCommandService;
  const managed = {
    send: vi.fn(),
    findForEdit: vi.fn(),
    edit: vi.fn(),
  } satisfies ManagedMessageService;
  return { managed, scheduled, create, cancel };
}

function commandInteraction(input: {
  subcommand: "create" | "cancel" | "status";
  value: string;
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
      getString: () => input.value,
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

function modalInteraction(customId: string) {
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const values: Record<string, string> = {
    [MANAGED_MESSAGE_CONTENT_INPUT_ID]: "sensitive scheduled content",
    [MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID]: "",
    [MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID]: "",
  };
  const interaction = {
    customId,
    fields: { getTextInputValue: (id: string) => values[id] ?? "" },
    inGuild: () => true,
    guildId: "guild-id",
    channelId: "channel-id",
    user: { id: "actor-id" },
    reply,
    deferReply,
    editReply,
  } as unknown as ModalSubmitInteraction;
  return { interaction, reply, deferReply, editReply };
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
