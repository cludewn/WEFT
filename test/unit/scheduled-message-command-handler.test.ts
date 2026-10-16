import { ChannelType, MessageFlags, ModalBuilder, PermissionFlagsBits } from "discord.js";
import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  ModalSubmitInteraction,
} from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedMessageService } from "../../src/messages/managed-message.js";
import {
  createScheduledMessageCreateModalId,
  createRecurringMessageCreateModalId,
  createScheduledMessageEditModalId,
  createScheduledMessageEditModal,
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
} from "../../src/messages/message-command.js";
import { createScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import { ONE_TIME_SCHEDULE_ERRORS } from "../../src/messages/one-time-message-schedule.js";
import type { GuildSettingsStore } from "../../src/guild/guild-settings.js";
import type { ScheduledMessageStore } from "../../src/messages/scheduled-message-persistence.js";
import type { ScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import type { CombinedScheduleListItem } from "../../src/messages/scheduled-message-administration-persistence.js";

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
    createRecurring: vi.fn<NonNullable<ScheduledMessageCommandService["createRecurring"]>>(() =>
      Promise.resolve({
        outcome: "SUCCESS",
        scheduledActionId: "series-id",
        scheduledFor: executeAt,
        deliveryPendingReconciliation: false,
      }),
    ),
    editRecurrence: vi.fn<NonNullable<ScheduledMessageCommandService["editRecurrence"]>>(() =>
      Promise.resolve({ outcome: "UNCHANGED" }),
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
  subcommand:
    | "create"
    | "recurring-create"
    | "cancel"
    | "status"
    | "list"
    | "edit"
    | "reschedule"
    | "recurrence-edit";
  value: string;
  after?: string;
  archived?: boolean;
  page?: number | null;
  authorized?: boolean;
  options?: Record<string, string | null>;
}) {
  const showModal = vi.fn((modal: Parameters<typeof ModalBuilder.from>[0]) => {
    void modal;
    return Promise.resolve();
  });
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn<(options: InteractionEditReplyOptions) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const channel = {
    type: input.archived ? ChannelType.PublicThread : ChannelType.GuildText,
    archived: input.archived ?? false,
    isThread: () => input.archived ?? false,
  };
  const interaction = {
    options: {
      getSubcommand: () => input.subcommand,
      getSubcommandGroup: () => "schedule",
      getString: (name: string) =>
        input.options !== undefined && name in input.options
          ? input.options[name]
          : name === "at"
            ? null
            : name === "after"
              ? (input.after ?? input.value)
              : input.value,
      getInteger: () => input.page ?? null,
    },
    createdTimestamp: Date.now(),
    inGuild: () => true,
    channel,
    memberPermissions: {
      has: (permission: bigint) =>
        (input.authorized ?? true) && permission === PermissionFlagsBits.ManageMessages,
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
  it("opens recurring-create modal without persisting and submits the carried recurrence", async () => {
    const s = services();
    const f = commandInteraction({
      subcommand: "recurring-create",
      value: "",
      options: { frequency: "weekly", time: "09:30", weekdays: "MON,Wed", timezone: null },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.showModal).toHaveBeenCalledTimes(1);
    expect(s.scheduled.createRecurring).not.toHaveBeenCalled();
    const customId = ModalBuilder.from(f.showModal.mock.calls[0]![0]).toJSON().custom_id;
    expect(customId).toBe(
      createRecurringMessageCreateModalId({
        frequency: "weekly",
        time: "09:30",
        weekdays: "mon,wed",
      }),
    );
    const submission = modalInteraction(customId);
    await handleManagedMessageModalSubmit(submission.interaction, s.managed, s.scheduled);
    expect(s.scheduled.createRecurring).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: "guild-id",
        channelId: "channel-id",
        actorUserId: "actor-id",
        recurrence: { frequency: "weekly", time: "09:30", weekdays: "mon,wed" },
      }),
    );
    expect(JSON.stringify(submission.editReply.mock.calls)).toContain("series-id");
  });

  it("rejects malformed recurring modal state before reading its payload", async () => {
    const s = services();
    const f = modalInteraction("recurring-message:create:w:0930:0:-");
    await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);
    expect(f.getTextInputValue).not.toHaveBeenCalled();
    expect(s.scheduled.createRecurring).not.toHaveBeenCalled();
  });

  it("routes recurrence-edit in archived supported threads", async () => {
    const s = services();
    const f = commandInteraction({
      subcommand: "recurrence-edit",
      value: "schedule-id",
      archived: true,
      options: {
        id: "schedule-id",
        frequency: "daily",
        time: "10:00",
        weekdays: null,
        timezone: null,
      },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(s.scheduled.editRecurrence).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      recurrence: { frequency: "daily", time: "10:00" },
    });
  });

  it("labels recurring status by occurrence state without exposing payload", async () => {
    const s = services();
    const f = commandInteraction({ subcommand: "status", value: "series-id", archived: true });
    s.scheduled.status.mockResolvedValueOnce({
      outcome: "FOUND",
      schedule: {
        scheduledActionId: "series-id",
        kind: "RECURRING",
        status: "ACTIVE",
        guildId: "guild-id",
        channelId: "channel-id",
        executeAt,
        creatorUserId: "actor-id",
        revision: 3,
        frequency: "WEEKLY",
        weekdayMask: 5,
        localTime: "09:30",
        timezone: "America/New_York",
        currentOccurrenceId: "occurrence-id",
        currentOccurrenceStatus: "RETRY_PENDING",
        retryCount: 2,
      },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("Current occurrence scheduled time");
    expect(response).not.toContain("Next scheduled occurrence");
    expect(response).not.toContain("sensitive scheduled content");
    expect(response).toContain("mon,wed");
  });

  it("shows no retry count when recurring status has no current occurrence", async () => {
    const s = services();
    const f = commandInteraction({ subcommand: "status", value: "series-id" });
    s.scheduled.status.mockResolvedValueOnce({
      outcome: "FOUND",
      schedule: {
        scheduledActionId: "series-id",
        kind: "RECURRING",
        status: "CANCELLED",
        guildId: "guild-id",
        channelId: "channel-id",
        executeAt,
        creatorUserId: "actor-id",
        revision: 2,
        frequency: "DAILY",
        weekdayMask: 127,
        localTime: "09:00",
        timezone: "UTC",
        currentOccurrenceId: null,
        currentOccurrenceStatus: null,
        retryCount: null,
      },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const response = JSON.stringify(f.editReply.mock.calls);
    expect(response).toContain("retry count: none");
    expect(response).toContain("Historical scheduled time");
  });

  it("labels recurring list rows by state", async () => {
    const s = services();
    const f = commandInteraction({ subcommand: "list", value: "", archived: true });
    s.scheduled.list.mockResolvedValueOnce({
      outcome: "FOUND",
      schedules: [
        {
          scheduledActionId: "one-time-id",
          kind: "ONE_TIME",
          status: "ACTIVE",
          executeAt,
          creatorUserId: "actor-id",
        },
        {
          scheduledActionId: "series-id",
          kind: "RECURRING",
          status: "ACTIVE",
          executeAt,
          creatorUserId: "actor-id",
          frequency: "DAILY",
          weekdayMask: 127,
          localTime: "09:00",
          timezone: "UTC",
          currentOccurrenceStatus: "EXECUTING",
        },
      ],
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const response = f.editReply.mock.calls[0]![0].content!;
    expect(response).toContain("one-time — **ACTIVE**");
    expect(response).toContain("recurring DAILY");
    expect(response).toContain("current: <t:1893553445:F>");
    expect(response).not.toContain("next:");
    expect(response).not.toContain("sensitive scheduled content");
  });
  it("round-trips only a validated relative delay in the modal custom ID", () => {
    const customId = createScheduledMessageCreateModalId({ kind: "AFTER", durationMs: 3_600_000 });
    expect(customId).toBe(`${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}3600000`);
    expect(parseScheduledMessageCreateModalId(customId)).toEqual({
      kind: "AFTER",
      durationMs: 3_600_000,
    });
    expect(
      parseScheduledMessageCreateModalId(`${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}60001`),
    ).toBe(undefined);
    expect(customId.length).toBeLessThanOrEqual(100);
  });

  it("opens schedule create only after cheap duration and context validation", async () => {
    const f = commandInteraction({ subcommand: "create", value: "30m" });
    const s = services();
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(ModalBuilder.from(f.showModal.mock.calls[0]![0]).toJSON()).toMatchObject({
      custom_id: createScheduledMessageCreateModalId({ kind: "AFTER", durationMs: 1_800_000 }),
      title: "Schedule managed message",
    });
    expect(f.deferReply).not.toHaveBeenCalled();
  });

  it("routes a validated schedule modal after ephemeral acknowledgement without Discord create", async () => {
    const f = modalInteraction(
      createScheduledMessageCreateModalId({ kind: "AFTER", durationMs: 3_600_000 }),
    );
    const s = services();
    await expect(
      handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled),
    ).resolves.toBe(true);
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(s.create).toHaveBeenCalledWith({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      schedule: { kind: "AFTER", durationMs: 3_600_000 },
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
    const f = modalInteraction(
      createScheduledMessageCreateModalId({ kind: "AFTER", durationMs: 3_600_000 }),
    );
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
    const modal = ModalBuilder.from(f.showModal.mock.calls[0]![0]).toJSON();
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
    const response = f.editReply.mock.calls[0]![0].content!;
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
      schedule: { kind: "AFTER", durationMs: 7_200_000 },
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

describe("scheduled message list responses", () => {
  function oneTime(index = 0): Extract<CombinedScheduleListItem, { kind: "ONE_TIME" }> {
    return {
      kind: "ONE_TIME",
      scheduledActionId: `123e4567-e89b-42d3-a456-${index.toString().padStart(12, "0")}`,
      creatorUserId: "18446744073709551615",
      status: "EXECUTING",
      executeAt,
    };
  }

  function recurring(index = 0): Extract<CombinedScheduleListItem, { kind: "RECURRING" }> {
    return {
      ...oneTime(index),
      kind: "RECURRING",
      status: "ACTIVE",
      frequency: "WEEKLY",
      weekdayMask: 127,
      localTime: "23:59",
      timezone: "America/Argentina/ComodRivadavia",
      currentOccurrenceStatus: "PENDING",
    };
  }

  async function render(schedules: CombinedScheduleListItem[], page: number | null = null) {
    const f = commandInteraction({ subcommand: "list", value: "", page });
    const s = services();
    s.scheduled.list.mockResolvedValue({ outcome: "FOUND", schedules });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.editReply).toHaveBeenCalledTimes(1);
    const options = f.editReply.mock.calls[0]![0];
    const content = options.content;
    if (typeof content !== "string") throw new Error("Expected list response content");
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(options.allowedMentions).toEqual({ parse: [] });
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      s.scheduled.list.mock.invocationCallOrder[0]!,
    );
    expect(s.scheduled.list).toHaveBeenCalledWith({
      guildId: "guild-id",
      channelId: "channel-id",
      page: page ?? 1,
    });
    expect(f.reply).not.toHaveBeenCalled();
    return { content, ...f, ...s };
  }

  function expectCompleteRows(content: string, schedules: CombinedScheduleListItem[]) {
    const rows = content.split("\n").filter((line) => line.startsWith("- "));
    expect(rows).toHaveLength(schedules.length);
    for (const [index, schedule] of schedules.entries()) {
      expect(rows[index]).toContain(`\`${schedule.scheduledActionId}\``);
      expect(rows[index]).toContain(`creator \`${schedule.creatorUserId}\``);
      expect(rows[index]).toContain(`<t:${Math.floor(schedule.executeAt.getTime() / 1000)}:F>`);
    }
  }

  it.each(["PENDING", "RETRY_PENDING"] as const)(
    "keeps all ten weekly %s rows within Discord limits (overflow regression)",
    async (currentOccurrenceStatus) => {
      const schedules = Array.from({ length: 10 }, (_, index) => ({
        ...recurring(index),
        currentOccurrenceStatus,
      }));
      const { content } = await render(schedules);
      expectCompleteRows(content, schedules);
      expect(content.match(new RegExp(`\\*\\*${currentOccurrenceStatus}\\*\\*`, "g"))).toHaveLength(
        10,
      );
      expect(content).toContain("/message schedule status id:<schedule-id>");
    },
  );

  it.each([
    ["one-time", 1],
    ["one-time", 10],
    ["daily", 1],
    ["daily", 10],
    ["weekly", 1],
    ["mixed", 10],
  ] as const)(
    "renders %s schedules (%i rows) completely in retrieval order",
    async (kind, count) => {
      const schedules = Array.from({ length: count }, (_, index): CombinedScheduleListItem => {
        const row = oneTime(count - index);
        if (kind === "one-time" || (kind === "mixed" && index % 2 === 0))
          return { ...row, status: index % 2 === 0 ? "ACTIVE" : "EXECUTING" };
        return {
          ...recurring(count - index),
          frequency: kind === "daily" ? "DAILY" : "WEEKLY",
          weekdayMask: kind === "weekly" ? 21 : 127,
        };
      });
      const { content } = await render(schedules);
      expectCompleteRows(content, schedules);
      const rows = content.split("\n").filter((line) => line.startsWith("- "));
      for (const [index, schedule] of schedules.entries()) {
        const row = rows[index]!;
        if (schedule.kind === "ONE_TIME") {
          expect(row).toContain(`one-time — **${schedule.status}** — runs:`);
          expect(row).not.toContain(":R>");
        } else {
          expect(row).toContain(`recurring ${schedule.frequency} — **PENDING** — next:`);
        }
      }
    },
  );

  it.each([
    ["PENDING", "next"],
    ["EXECUTING", "current"],
    ["RETRY_PENDING", "current"],
    [null, "last"],
  ] as const)("labels %s using the authoritative instant as %s", async (status, label) => {
    const schedule = {
      ...recurring(),
      // A recurrence edit can leave current work on the previous definition's instant.
      localTime: "00:00",
      timezone: "Pacific/Auckland",
      currentOccurrenceStatus: status,
    };
    const { content } = await render([schedule]);
    expect(content).toContain(`**${status ?? "ACTIVE"}** — ${label}: <t:1893553445:F>`);
    expect(content.match(/<t:[^>]+>/g)).toEqual(["<t:1893553445:F>"]);
    for (const other of ["next", "current", "last"].filter((meaning) => meaning !== label))
      expect(content).not.toContain(`${other}:`);
  });

  it("omits payload and detailed recurrence fields and directs users to status", async () => {
    const schedules = [
      {
        ...recurring(),
        content: "sensitive scheduled content",
        embed: { title: "sensitive embed title", imageUrl: "https://sensitive.invalid/image.png" },
      },
    ];
    const { content } = await render(schedules);
    for (const omitted of [
      "sensitive",
      "America/Argentina/ComodRivadavia",
      "23:59",
      "mon,tue,wed,thu,fri,sat,sun",
    ])
      expect(content).not.toContain(omitted);
    expect(content.split("\n").at(-1)).toBe("Details: /message schedule status id:<schedule-id>.");
  });

  it.each([null, 2])("renders an empty page with page option %s", async (page) => {
    const { content } = await render([], page);
    expect(content).toBe(
      `No active or executing scheduled messages were found on page ${page ?? 1}.`,
    );
  });

  it("renders page 2 without changing the supplied order", async () => {
    const schedules = [recurring(2), oneTime(1)];
    const { content } = await render(schedules, 2);
    expect(content.startsWith("Scheduled messages — page 2\n")).toBe(true);
    expectCompleteRows(content, schedules);
  });

  it("bounds the full response for the widest Date and valid page representations", async () => {
    const schedules = Array.from({ length: 10 }, (_, index) => ({
      ...recurring(index),
      currentOccurrenceStatus: "RETRY_PENDING" as const,
      executeAt: new Date(-8_640_000_000_000_000),
    }));
    // This page still has a safe integer offset in the application service.
    const { content } = await render(schedules, 900_719_925_474_100);
    expectCompleteRows(content, schedules);
    expect(content.length).toBe(1543);
  });

  it("accepts a complete 2000-code-unit page and rejects 2001 without dropping rows", async () => {
    const schedules = Array.from({ length: 10 }, (_, index) => recurring(index));
    const initial = await render(schedules);
    const row = schedules[9]!;
    row.scheduledActionId += "x".repeat(2000 - initial.content.length);
    const boundary = await render(schedules);
    expect(boundary.content.length).toBe(2000);
    expectCompleteRows(boundary.content, schedules);

    row.scheduledActionId += "x";
    const overflow = await render(schedules);
    expect(overflow.content).toBe(
      "WEFT could not display the complete scheduled-message page safely. No schedules were displayed.",
    );
    for (const schedule of schedules)
      expect(overflow.content).not.toContain(schedule.scheduledActionId);
  });

  it.each(["schedule ID", "creator ID", "UTF-16 creator ID", "invalid date"])(
    "fails safely for an unrepresentable page with %s",
    async (field) => {
      const schedules = Array.from({ length: 10 }, (_, index) => recurring(index));
      const row = schedules[9]!;
      if (field === "schedule ID") row.scheduledActionId = "unexpected-id-" + "x".repeat(2000);
      if (field === "creator ID") row.creatorUserId = "unexpected-creator-" + "x".repeat(2000);
      // Below 2000 code points, but above 2000 UTF-16 code units with the complete page.
      if (field === "UTF-16 creator ID") row.creatorUserId = "😀".repeat(400);
      if (field === "invalid date") row.executeAt = new Date(NaN);
      const { content } = await render(schedules);
      expect(content).toBe(
        "WEFT could not display the complete scheduled-message page safely. No schedules were displayed.",
      );
      expect(content).not.toContain("Scheduled messages — page");
      expect(content).not.toContain("unexpected");
      expect(content).not.toContain("😀");
      for (const schedule of schedules) expect(content).not.toContain(schedule.scheduledActionId);
    },
  );

  it.each([
    ["INVALID_PAGE", 0, "Page must be a positive integer."],
    ["UNAVAILABLE", 1, "WEFT could not load scheduled messages. Please try again later."],
  ] as const)("preserves the %s response", async (outcome, page, expected) => {
    const f = commandInteraction({ subcommand: "list", value: "", page });
    const s = services();
    s.scheduled.list.mockResolvedValue({ outcome });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const options = f.editReply.mock.calls[0]![0];
    expect(options.content).toBe(expected);
    expect(options.content!.length).toBeLessThanOrEqual(2000);
    expect(options.allowedMentions).toEqual({ parse: [] });
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(s.scheduled.list).toHaveBeenCalledWith({
      guildId: "guild-id",
      channelId: "channel-id",
      page,
    });
  });

  it("requires ManageMessages before loading or deferring a list", async () => {
    const f = commandInteraction({ subcommand: "list", value: "", authorized: false });
    const s = services();
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.reply).toHaveBeenCalledWith({
      content: "You need the Manage Messages permission to manage messages.",
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    expect(s.scheduled.list).not.toHaveBeenCalled();
    expect(f.deferReply).not.toHaveBeenCalled();
    expect(f.editReply).not.toHaveBeenCalled();
  });
});

describe("absolute one-time commands and modal transport", () => {
  it.each(["create", "reschedule"] as const)(
    "validates %s selectors by presence before opening or deferring",
    async (subcommand) => {
      for (const options of [
        { after: null, at: null },
        { after: "1m", at: "2030-01-02 03:06" },
        { after: "", at: "" },
        { after: null, at: "" },
        { after: "", at: null },
        { after: null, at: "2030-02-29 12:00" },
      ]) {
        const f = commandInteraction({ subcommand, value: "schedule-id", options });
        const s = services();
        await handleMessageCommand(f.interaction, s.managed, s.scheduled);
        expect(f.reply).toHaveBeenCalledWith(
          expect.objectContaining({
            flags: MessageFlags.Ephemeral,
            allowedMentions: { parse: [] },
          }),
        );
        expect(f.showModal).not.toHaveBeenCalled();
        expect(f.deferReply).not.toHaveBeenCalled();
        expect(s.create).not.toHaveBeenCalled();
        expect(s.scheduled.reschedule).not.toHaveBeenCalled();
      }
    },
  );

  it("carries AT through the existing five-field Modal and renders the authoritative timestamp", async () => {
    const s = services();
    const f = commandInteraction({
      subcommand: "create",
      value: "",
      options: { after: null, at: "2030-01-02 03:06" },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    const modal = ModalBuilder.from(f.showModal.mock.calls[0]![0]).toJSON();
    expect(modal.components).toHaveLength(5);
    expect(modal.custom_id).toBe("scheduled-message:schedule-create:at:2030-01-02 03:06");
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(s.create).not.toHaveBeenCalled();
    const submission = modalInteraction(modal.custom_id);
    await handleManagedMessageModalSubmit(submission.interaction, s.managed, s.scheduled);
    expect(s.create).toHaveBeenCalledWith(
      expect.objectContaining({ schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" } }),
    );
    expect(JSON.stringify(submission.editReply.mock.calls)).toContain(
      "<t:1893553445:F> (<t:1893553445:R>)",
    );
  });

  it("passes the AT selector during reschedule after ephemeral acknowledgement", async () => {
    const s = services();
    const f = commandInteraction({
      subcommand: "reschedule",
      value: "schedule-id",
      options: { after: null, at: "2030-01-02 03:06" },
    });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(s.scheduled.reschedule).toHaveBeenCalledWith({
      scheduledActionId: "schedule-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      schedule: { kind: "AT", localDateTime: "2030-01-02 03:06" },
    });
    expect(f.deferReply.mock.invocationCallOrder[0]).toBeLessThan(
      s.scheduled.reschedule.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    "scheduled-message:schedule-create:at:2030-02-29 12:00",
    "scheduled-message:schedule-create:at:2030-01-02T12:00",
    "scheduled-message:schedule-create:at:2030-01-02 12:00Z",
    "scheduled-message:schedule-create:at:2030-01-02 12:00:UTC",
    "scheduled-message:schedule-create:at:2030-01-02 12:00\n",
    "scheduled-message:schedule-create:60000\n",
    "scheduled-message:schedule-create:060000",
    "scheduled-message:schedule-create:at:" + "0".repeat(101),
  ])(
    "rejects malformed owned modal %# before acknowledgement or service call",
    async (customId) => {
      expect(parseScheduledMessageCreateModalId(customId)).toBeUndefined();
      const s = services();
      const f = modalInteraction(customId);
      await handleManagedMessageModalSubmit(f.interaction, s.managed, s.scheduled);
      expect(f.reply).toHaveBeenCalledTimes(1);
      expect(f.deferReply).not.toHaveBeenCalled();
      expect(s.create).not.toHaveBeenCalled();
    },
  );

  it("round-trips AT without encoding a timezone or canonical instant", () => {
    const selector = { kind: "AT", localDateTime: "9999-12-31 23:59" } as const;
    const id = createScheduledMessageCreateModalId(selector);
    expect(parseScheduledMessageCreateModalId(id)).toEqual(selector);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(() =>
      createScheduledMessageCreateModalId({ kind: "AT", localDateTime: "invalid" }),
    ).toThrow();
  });

  it("uses a timezone changed while the Modal was open and preserves AFTER's full delay", async () => {
    const s = services();
    const initialResult = await s.create({
      guildId: "guild-id",
      channelId: "channel-id",
      actorUserId: "actor-id",
      schedule: { kind: "AFTER", durationMs: 60_000 },
      payload: { content: "test" },
    });
    if (initialResult.outcome !== "SUCCESS") throw new Error("fixture failed");
    let zone = "UTC";
    let clock = new Date("2030-01-02T03:00:00Z");
    const getOrCreate = vi.fn<GuildSettingsStore["getOrCreate"]>(() =>
      Promise.resolve({
        guildId: "guild-id",
        timezone: zone,
        closedPrefix: "[CLOSED]",
        linkPreviewMode: "hybrid",
        auditLogChannelId: null,
        autoCloseInactivitySeconds: 604800,
        autoCloseBotMessagesCountAsActivity: false,
        createdAt: clock,
        updatedAt: clock,
      }),
    );
    const create = vi.fn<ScheduledMessageStore["create"]>((input) =>
      Promise.resolve({
        ...initialResult.definition,
        action: { ...initialResult.definition.action, executeAt: input.executeAt },
      }),
    );
    const application = createScheduledMessageCommandService({
      discord: {
        authorizeCreation: vi.fn(() => Promise.resolve({ outcome: "AUTHORIZED" as const })),
      },
      store: {
        create,
        cancel: vi.fn(),
        findStatus: vi.fn(),
        listNonterminal: vi.fn(),
        findEditable: vi.fn(),
        edit: vi.fn(),
        reschedule: vi.fn(),
        find: vi.fn(),
      },
      delivery: {
        ensureScheduledMessageDelivery: vi.fn(() => Promise.resolve("CURRENT" as const)),
        cancelScheduledMessageDeliveries: vi.fn(),
      },
      guildSettings: { getOrCreate },
      logger: { warn: vi.fn() },
      now: () => clock,
    });
    const atCommand = commandInteraction({
      subcommand: "create",
      value: "",
      options: { after: null, at: "2030-01-02 12:06" },
    });
    await handleMessageCommand(atCommand.interaction, s.managed, application);
    expect(getOrCreate).not.toHaveBeenCalled();
    zone = "Asia/Tokyo";
    clock = new Date("2030-01-02T03:04:30Z");
    await handleManagedMessageModalSubmit(
      modalInteraction(ModalBuilder.from(atCommand.showModal.mock.calls[0]![0]).toJSON().custom_id)
        .interaction,
      s.managed,
      application,
    );
    expect(create.mock.calls[0]![0].executeAt).toEqual(new Date("2030-01-02T03:06:00Z"));
    zone = "UTC";
    expect(create.mock.calls[0]![0].executeAt).toEqual(new Date("2030-01-02T03:06:00Z"));
    getOrCreate.mockClear();
    const afterCommand = commandInteraction({ subcommand: "create", value: "2h" });
    await handleMessageCommand(afterCommand.interaction, s.managed, application);
    clock = new Date("2030-01-02T08:00:00Z");
    await handleManagedMessageModalSubmit(
      modalInteraction(
        ModalBuilder.from(afterCommand.showModal.mock.calls[0]![0]).toJSON().custom_id,
      ).interaction,
      s.managed,
      application,
    );
    expect(create.mock.calls[1]![0].executeAt).toEqual(new Date("2030-01-02T10:00:00Z"));
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each(Object.entries(ONE_TIME_SCHEDULE_ERRORS))(
    "renders bounded %s errors for create and reschedule",
    async (code, message) => {
      const s = services();
      const typedCode = code as keyof typeof ONE_TIME_SCHEDULE_ERRORS;
      s.create.mockResolvedValue({ outcome: "FAILURE", code: typedCode });
      const modal = modalInteraction(
        createScheduledMessageCreateModalId({ kind: "AT", localDateTime: "2030-01-02 03:06" }),
      );
      await handleManagedMessageModalSubmit(modal.interaction, s.managed, s.scheduled);
      expect(modal.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: message, allowedMentions: { parse: [] } }),
      );
      s.scheduled.reschedule.mockResolvedValue({ outcome: typedCode });
      const f = commandInteraction({ subcommand: "reschedule", value: "schedule-id", after: "1m" });
      await handleMessageCommand(f.interaction, s.managed, s.scheduled);
      expect(f.editReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: message, allowedMentions: { parse: [] } }),
      );
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const editableScheduleId = "11111111-1111-4111-8111-111111111111";
function editableSchedule(
  recurring = false,
): Awaited<ReturnType<ScheduledMessageCommandService["findEditable"]>> {
  return {
    outcome: "ACTIVE",
    definition: {
      action: {
        id: editableScheduleId,
        guildId: "guild-id",
        targetId: "channel-id",
        actionType: "SEND_MESSAGE",
        status: "ACTIVE",
        executeAt,
        createdAt: executeAt,
        updatedAt: executeAt,
      },
      creatorUserId: "creator",
      retryCount: 0,
      revision: 4,
      payload: { content: "prefilled scheduled content", embed: null },
      resultMessageId: null,
      ...(recurring
        ? { frequency: "DAILY" as const, weekdayMask: 127, localTime: "09:00", timezone: "UTC" }
        : {}),
    },
  };
}
function pendingSchedule() {
  let resolve!: (
    value: Awaited<ReturnType<ScheduledMessageCommandService["findEditable"]>>,
  ) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Awaited<ReturnType<ScheduledMessageCommandService["findEditable"]>>>(
    (res, rej) => {
      resolve = res;
      reject = rej;
    },
  );
  return { promise, resolve, reject };
}

describe("scheduled edit bounded Modal preparation", () => {
  it.each([false, true])(
    "preserves direct revision-bound editing in archived threads (recurring=%s)",
    async (recurring) => {
      const s = services();
      const f = commandInteraction({
        subcommand: "edit",
        value: editableScheduleId,
        archived: true,
      });
      s.scheduled.findEditable.mockResolvedValueOnce(editableSchedule(recurring));
      await handleMessageCommand(f.interaction, s.managed, s.scheduled);
      expect(s.scheduled.findEditable).toHaveBeenCalledExactlyOnceWith({
        scheduledActionId: editableScheduleId,
        guildId: "guild-id",
        channelId: "channel-id",
      });
      const modal = ModalBuilder.from(f.showModal.mock.calls[0]![0]).toJSON();
      expect(modal.custom_id).toBe(createScheduledMessageEditModalId(editableScheduleId, 4));
      expect(modal.components[0]).toMatchObject({
        component: { value: "prefilled scheduled content" },
      });
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.deferReply).not.toHaveBeenCalled();
    },
  );

  it.each([1_999, 2_000, 2_001])("prevents late schedule edit Modals at %sms", async (age) => {
    vi.useFakeTimers();
    const s = services();
    const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
    const gate = pendingSchedule();
    s.scheduled.findEditable.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, s.managed, s.scheduled);
    await vi.advanceTimersByTimeAsync(age);
    gate.resolve(editableSchedule());
    await operation;
    expect(f.showModal).toHaveBeenCalledTimes(age < 2_000 ? 1 : 0);
    expect(f.reply).toHaveBeenCalledTimes(age < 2_000 ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["resolve", "reject", "response-loss"])(
    "retains timed out reads through %s and sends no late response",
    async (outcome) => {
      vi.useFakeTimers();
      const s = services();
      const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
      const gate = pendingSchedule();
      s.scheduled.findEditable.mockReturnValueOnce(gate.promise);
      const responseError = new Error("reply lost");
      if (outcome === "response-loss") f.reply.mockRejectedValueOnce(responseError);
      let done = false;
      const operation = handleMessageCommand(f.interaction, s.managed, s.scheduled).then(
        () => {
          done = true;
          return undefined;
        },
        (error: unknown) => {
          done = true;
          return error;
        },
      );
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.reply).toHaveBeenCalledOnce();
      expect(done).toBe(false);
      if (outcome === "resolve") gate.resolve(editableSchedule(true));
      else gate.reject(new Error("late DB error"));
      expect(await operation).toBe(outcome === "response-loss" ? responseError : undefined);
      expect(f.showModal).not.toHaveBeenCalled();
      expect(f.reply).toHaveBeenCalledOnce();
      expect(s.scheduled.findEditable).toHaveBeenCalledOnce();
    },
  );

  it.each([2_000, 2_499, 2_500, 2_501])(
    "does not read an interaction already %sms old",
    async (age) => {
      vi.useFakeTimers();
      const s = services();
      const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
      Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - age });
      await handleMessageCommand(f.interaction, s.managed, s.scheduled);
      expect(s.scheduled.findEditable).not.toHaveBeenCalled();
      expect(f.reply).toHaveBeenCalledTimes(age < 2_500 ? 1 : 0);
      expect(f.showModal).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("rejects a late schedule result even before its timeout callback runs", async () => {
    vi.useFakeTimers();
    const s = services();
    const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
    const gate = pendingSchedule();
    s.scheduled.findEditable.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, s.managed, s.scheduled);
    await vi.advanceTimersByTimeAsync(0);
    vi.spyOn(performance, "now").mockReturnValue(2_001);
    gate.resolve(editableSchedule());
    await operation;
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "NOT_FOUND_OR_WRONG_CONTEXT",
    "EXECUTING",
    "COMPLETED",
    "CANCELLED",
    "FAILED",
    "CORRUPT",
    "UNAVAILABLE",
  ] as const)("preserves editable-state rejection %s", async (outcome) => {
    const s = services();
    const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
    s.scheduled.findEditable.mockResolvedValueOnce({ outcome });
    await handleMessageCommand(f.interaction, s.managed, s.scheduled);
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
      }),
    );
  });
});

describe("recurring-create Modal failure classification", () => {
  function fixture(options: Record<string, string | null> = {}) {
    const s = services();
    const f = commandInteraction({
      subcommand: "recurring-create",
      value: "",
      options: {
        frequency: "daily",
        time: "09:30",
        weekdays: null,
        timezone: "UTC",
        ...options,
      },
    });
    return { ...f, ...s };
  }

  it.each([
    { frequency: "invalid" },
    { time: "9:30" },
    { weekdays: "mon" },
    { timezone: "invalid/timezone" },
  ])("reports grounded recurrence validation failure for %j", async (options) => {
    const f = fixture(options);
    await handleMessageCommand(f.interaction, f.managed, f.scheduled);
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        content:
          "Enter daily without weekdays, or weekly with unique comma-separated weekdays, strict HH:MM, and a named IANA timezone.",
      }),
    );
    expect(f.showModal).not.toHaveBeenCalled();
    expect(f.scheduled.createRecurring).not.toHaveBeenCalled();
  });

  it("reports timezone length only for the known encoded identity limit", async () => {
    const f = fixture();
    vi.spyOn(globalThis, "encodeURIComponent").mockReturnValueOnce("x".repeat(101));
    await handleMessageCommand(f.interaction, f.managed, f.scheduled);
    expect(f.reply).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: "The recurring timezone is too long for this form." }),
    );
    expect(f.showModal).not.toHaveBeenCalled();
  });

  it.each(["construction", "serialization"])(
    "reports generic %s failure and propagates it for bounded logging",
    async (stage) => {
      const f = fixture();
      const error = new Error("private failure, not evidence of an invalid timezone");
      const method = stage === "construction" ? "setTitle" : "toJSON";
      vi.spyOn(ModalBuilder.prototype, method).mockImplementationOnce(() => {
        throw error;
      });
      // Even a failed generic reply must not replace the preparation failure.
      f.reply.mockRejectedValueOnce(new Error("reply lost"));
      await expect(handleMessageCommand(f.interaction, f.managed, f.scheduled)).rejects.toBe(error);
      expect(f.reply).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: "WEFT could not prepare the message form. Please try again later.",
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] },
        }),
      );
      expect(f.showModal).not.toHaveBeenCalled();
      expect(f.scheduled.createRecurring).not.toHaveBeenCalled();
    },
  );

  it.each(["rejected", "ambiguous"])(
    "does not reply after %s showModal, regardless of local flags",
    async (outcome) => {
      const f = fixture();
      Object.defineProperties(f.interaction, {
        replied: { value: false },
        deferred: { value: false },
      });
      const error =
        outcome === "rejected"
          ? Object.assign(new Error("rejected"), { code: 10062 })
          : new Error("response lost");
      f.showModal.mockRejectedValueOnce(error);
      await expect(handleMessageCommand(f.interaction, f.managed, f.scheduled)).rejects.toBe(error);
      expect(f.showModal).toHaveBeenCalledOnce();
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.deferReply).not.toHaveBeenCalled();
      expect(f.scheduled.createRecurring).not.toHaveBeenCalled();
    },
  );
});

it.each([499, 500, 501])(
  "subtracts the scheduled interaction's existing age from the lookup budget (%sms)",
  async (delay) => {
    vi.useFakeTimers();
    const s = services();
    const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
    Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - 1_500 });
    const gate = pendingSchedule();
    s.scheduled.findEditable.mockReturnValueOnce(gate.promise);
    const operation = handleMessageCommand(f.interaction, s.managed, s.scheduled);
    await vi.advanceTimersByTimeAsync(delay);
    gate.resolve(editableSchedule());
    await operation;
    expect(f.showModal).toHaveBeenCalledTimes(delay < 500 ? 1 : 0);
    expect(f.reply).toHaveBeenCalledTimes(delay < 500 ? 0 : 1);
    expect(vi.getTimerCount()).toBe(0);
  },
);

it.each(["serialization-deadline", "serialization-failure", "showModal-failure"])(
  "handles scheduled edit %s without a second initial response",
  async (stage) => {
    vi.useFakeTimers();
    const s = services();
    const f = commandInteraction({ subcommand: "edit", value: editableScheduleId });
    s.scheduled.findEditable.mockResolvedValueOnce(editableSchedule());
    const error = new Error("private preparation or transport failure");
    if (stage === "serialization-deadline") {
      const result = createScheduledMessageEditModal(editableScheduleId, 4, {
        content: "prefilled scheduled content",
        embed: null,
      }).toJSON();
      vi.spyOn(ModalBuilder.prototype, "toJSON").mockImplementationOnce(() => {
        vi.spyOn(performance, "now").mockReturnValue(2_000);
        return result;
      });
    } else if (stage === "serialization-failure") {
      vi.spyOn(ModalBuilder.prototype, "toJSON").mockImplementationOnce(() => {
        throw error;
      });
    } else {
      f.showModal.mockRejectedValueOnce(error);
    }
    const operation = handleMessageCommand(f.interaction, s.managed, s.scheduled);
    if (stage === "serialization-deadline") await operation;
    else await expect(operation).rejects.toBe(error);
    expect(f.showModal).toHaveBeenCalledTimes(stage === "showModal-failure" ? 1 : 0);
    expect(f.reply).toHaveBeenCalledTimes(stage === "showModal-failure" ? 0 : 1);
    expect(s.scheduled.findEditable).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("does not start a late scheduled edit authorization response", async () => {
  vi.useFakeTimers();
  const s = services();
  const f = commandInteraction({
    subcommand: "edit",
    value: editableScheduleId,
    authorized: false,
  });
  Object.defineProperty(f.interaction, "createdTimestamp", { value: Date.now() - 2_500 });
  await handleMessageCommand(f.interaction, s.managed, s.scheduled);
  expect(f.reply).not.toHaveBeenCalled();
  expect(f.showModal).not.toHaveBeenCalled();
  expect(s.scheduled.findEditable).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
