import {
  ChannelType,
  InteractionContextType,
  LabelBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
  ModalSubmitInteraction,
} from "discord.js";

import { isSupportedManagedMessageTargetType } from "./managed-message-discord.js";
import {
  MANAGED_MESSAGE_MAX_EDITABLE_REVISION,
  type ManagedMessageEditResult,
  type ManagedMessageSendResult,
  type ManagedMessageService,
} from "./managed-message.js";
import {
  formatManagedMessageEmbedColor,
  validateManagedMessagePayload,
  type ManagedMessagePayload,
} from "./managed-message-payload.js";
import {
  isValidRelativeDurationMilliseconds,
  InvalidRelativeDurationError,
  parseRelativeDuration,
} from "./relative-duration.js";
import type {
  CreateScheduledMessageCommandResult,
  ScheduledMessageCommandService,
} from "./scheduled-message-command.js";
import { parseRecurringCommandInput, type RecurringCommandInput } from "./recurring-message.js";

export const MANAGED_MESSAGE_SEND_MODAL_ID = "managed-message:send";
export const MANAGED_MESSAGE_EDIT_MODAL_PREFIX = "managed-message:edit:";
export const SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX = "scheduled-message:schedule-create:";
export const SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX = "scheduled-message:schedule-edit:";
export const RECURRING_MESSAGE_CREATE_MODAL_PREFIX = "recurring-message:create:";
export const MANAGED_MESSAGE_CONTENT_INPUT_ID = "managed-message:content";
export const MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID = "managed-message:embed-title";
export const MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID = "managed-message:embed-description";
export const MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID = "managed-message:embed-color";
export const MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID = "managed-message:embed-image-url";

const SNOWFLAKE_PATTERN = "[1-9][0-9]{16,19}";
const snowflakeRegex = new RegExp(`^${SNOWFLAKE_PATTERN}$`);
const messageLinkRegex = new RegExp(
  `^https://discord\\.com/channels/(${SNOWFLAKE_PATTERN})/(${SNOWFLAKE_PATTERN})/(${SNOWFLAKE_PATTERN})$`,
);
const editModalRegex = new RegExp(`^managed-message:edit:(${SNOWFLAKE_PATTERN}):([1-9][0-9]*)$`);
const scheduledCreateModalRegex = /^scheduled-message:schedule-create:([1-9][0-9]*)$/;
const scheduledEditModalRegex =
  /^scheduled-message:schedule-edit:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(0|[1-9][0-9]*)$/i;
const recurringCreateModalRegex = /^recurring-message:create:([dw]):([0-9]{4}):([0-9]{1,3}):(.+)$/;
const MAX_UNSIGNED_64 = (1n << 64n) - 1n;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

export type ManagedMessageReferenceResult =
  { ok: true; messageId: string } | { ok: false; code: "INVALID" | "CURRENT_CHANNEL_MISMATCH" };

function isSnowflake(value: string): boolean {
  return snowflakeRegex.test(value) && BigInt(value) <= MAX_UNSIGNED_64;
}

export function parseManagedMessageReference(
  value: string,
  currentGuildId: string,
  currentChannelId: string,
): ManagedMessageReferenceResult {
  if (isSnowflake(value)) return { ok: true, messageId: value };
  const link = messageLinkRegex.exec(value);
  if (link === null || link[1] === undefined || link[2] === undefined || link[3] === undefined) {
    return { ok: false, code: "INVALID" };
  }
  if (!isSnowflake(link[1]) || !isSnowflake(link[2]) || !isSnowflake(link[3])) {
    return { ok: false, code: "INVALID" };
  }
  if (link[1] !== currentGuildId || link[2] !== currentChannelId) {
    return { ok: false, code: "CURRENT_CHANNEL_MISMATCH" };
  }
  return { ok: true, messageId: link[3] };
}

export type ManagedMessageEditModalTarget = { messageId: string; expectedRevision: number };
export function parseManagedMessageEditModalId(
  customId: string,
): ManagedMessageEditModalTarget | undefined {
  const match = editModalRegex.exec(customId);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    !isSnowflake(match[1])
  ) {
    return undefined;
  }
  const revision = Number(match[2]);
  if (
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    revision > MANAGED_MESSAGE_MAX_EDITABLE_REVISION
  ) {
    return undefined;
  }
  return { messageId: match[1], expectedRevision: revision };
}

export function createScheduledMessageCreateModalId(durationMs: number): string {
  if (!isValidRelativeDurationMilliseconds(durationMs)) throw new InvalidRelativeDurationError();
  return `${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}${durationMs}`;
}

export function parseScheduledMessageCreateModalId(customId: string): number | undefined {
  const match = scheduledCreateModalRegex.exec(customId);
  if (match?.[1] === undefined) return undefined;
  const durationMs = Number(match[1]);
  return isValidRelativeDurationMilliseconds(durationMs) ? durationMs : undefined;
}

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function createRecurringMessageCreateModalId(input: RecurringCommandInput): string {
  const parsed = parseRecurringCommandInput(input);
  if (parsed === undefined) throw new Error("Invalid recurring command input");
  const timezone =
    parsed.explicitTimezone === undefined ? "-" : encodeURIComponent(parsed.explicitTimezone);
  const customId = `${RECURRING_MESSAGE_CREATE_MODAL_PREFIX}${parsed.frequency === "DAILY" ? "d" : "w"}:${parsed.localTime.replace(":", "")}:${parsed.weekdayMask}:${timezone}`;
  if (customId.length > 100) throw new Error("Recurring modal identity exceeds Discord limit");
  return customId;
}

export function parseRecurringMessageCreateModalId(
  customId: string,
): RecurringCommandInput | undefined {
  if (customId.length > 100) return undefined;
  const match = recurringCreateModalRegex.exec(customId);
  if (
    match === null ||
    match[1] === undefined ||
    match[2] === undefined ||
    match[3] === undefined ||
    match[4] === undefined
  )
    return undefined;
  const mask = Number(match[3]);
  if (!Number.isInteger(mask) || mask < 1 || mask > 127 || String(mask) !== match[3])
    return undefined;
  let timezone: string | undefined;
  try {
    timezone = match[4] === "-" ? undefined : decodeURIComponent(match[4]);
  } catch {
    return undefined;
  }
  const frequency = match[1] === "d" ? "daily" : "weekly";
  const input: RecurringCommandInput = {
    frequency,
    time: `${match[2].slice(0, 2)}:${match[2].slice(2)}`,
    ...(frequency === "weekly"
      ? { weekdays: weekdays.filter((_, index) => (mask & (1 << index)) !== 0).join(",") }
      : {}),
    ...(timezone === undefined ? {} : { timezone }),
  };
  const parsed = parseRecurringCommandInput(input);
  return parsed !== undefined && parsed.weekdayMask === mask ? input : undefined;
}

export type ScheduledMessageEditModalTarget = {
  scheduledActionId: string;
  expectedRevision: number;
};

export function createScheduledMessageEditModalId(
  scheduledActionId: string,
  expectedRevision: number,
): string {
  const customId = `${SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX}${scheduledActionId}:${expectedRevision}`;
  if (
    scheduledEditModalRegex.exec(customId) === null ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > MAX_POSTGRES_INTEGER ||
    customId.length > 100
  ) {
    throw new Error("Scheduled message edit modal identity is invalid");
  }
  return customId;
}

export function parseScheduledMessageEditModalId(
  customId: string,
): ScheduledMessageEditModalTarget | undefined {
  const match = scheduledEditModalRegex.exec(customId);
  if (match?.[1] === undefined || match[2] === undefined || customId.length > 100) return undefined;
  const expectedRevision = Number(match[2]);
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    expectedRevision > MAX_POSTGRES_INTEGER
  ) {
    return undefined;
  }
  return { scheduledActionId: match[1].toLowerCase(), expectedRevision };
}

export const messageCommandDefinition = new SlashCommandBuilder()
  .setName("message")
  .setDescription("Manage messages sent by WEFT")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((subcommand) =>
    subcommand.setName("send").setDescription("Send a managed message in this channel"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription("Edit a managed message in this channel")
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription("Discord message ID or canonical message link")
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("schedule")
      .setDescription("Manage scheduled messages")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("create")
          .setDescription("Schedule a managed message in this channel")
          .addStringOption((option) =>
            option
              .setName("after")
              .setDescription("Delay such as 30m, 2h, or 7d")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("recurring-create")
          .setDescription("Schedule a recurring managed message in this channel")
          .addStringOption((option) =>
            option
              .setName("frequency")
              .setDescription("Daily or weekly")
              .setRequired(true)
              .addChoices({ name: "daily", value: "daily" }, { name: "weekly", value: "weekly" }),
          )
          .addStringOption((option) =>
            option.setName("time").setDescription("Local time HH:MM").setRequired(true),
          )
          .addStringOption((option) =>
            option.setName("weekdays").setDescription("Weekly days, e.g. mon,wed,fri"),
          )
          .addStringOption((option) =>
            option.setName("timezone").setDescription("Named IANA timezone"),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cancel")
          .setDescription("Cancel a scheduled message in this channel")
          .addStringOption((option) =>
            option.setName("id").setDescription("Schedule ID").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("status")
          .setDescription("Show a scheduled message status in this channel")
          .addStringOption((option) =>
            option.setName("id").setDescription("Schedule ID").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription("List active scheduled messages in this channel")
          .addIntegerOption((option) =>
            option.setName("page").setDescription("Page number").setMinValue(1),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("edit")
          .setDescription("Edit a scheduled message in this channel")
          .addStringOption((option) =>
            option.setName("id").setDescription("Schedule ID").setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reschedule")
          .setDescription("Reschedule a message in this channel")
          .addStringOption((option) =>
            option.setName("id").setDescription("Schedule ID").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("after")
              .setDescription("Delay such as 30m, 2h, or 7d")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("recurrence-edit")
          .setDescription("Edit a recurring message schedule in this channel")
          .addStringOption((option) =>
            option.setName("id").setDescription("Schedule ID").setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("frequency")
              .setDescription("Daily or weekly")
              .setRequired(true)
              .addChoices({ name: "daily", value: "daily" }, { name: "weekly", value: "weekly" }),
          )
          .addStringOption((option) =>
            option.setName("time").setDescription("Local time HH:MM").setRequired(true),
          )
          .addStringOption((option) =>
            option.setName("weekdays").setDescription("Weekly days, e.g. mon,wed,fri"),
          )
          .addStringOption((option) =>
            option.setName("timezone").setDescription("Named IANA timezone"),
          ),
      ),
  );

function createInput(
  customId: string,
  style: TextInputStyle,
  maxLength: number,
  value?: string,
): TextInputBuilder {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setStyle(style)
    .setRequired(false)
    .setMaxLength(maxLength);
  return value === undefined || value === "" ? input : input.setValue(value);
}

function recurrenceOptions(interaction: ChatInputCommandInteraction): RecurringCommandInput {
  const weekdays = interaction.options.getString("weekdays");
  const timezone = interaction.options.getString("timezone");
  return {
    frequency: interaction.options.getString("frequency", true),
    time: interaction.options.getString("time", true),
    ...(weekdays === null ? {} : { weekdays }),
    ...(timezone === null ? {} : { timezone }),
  };
}

function createPayloadModal(
  customId: string,
  title: string,
  payload?: ManagedMessagePayload,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Message content")
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_CONTENT_INPUT_ID,
            TextInputStyle.Paragraph,
            2_000,
            payload?.content,
          ),
        ),
      new LabelBuilder()
        .setLabel("Embed title")
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
            TextInputStyle.Short,
            256,
            payload?.embed?.title,
          ),
        ),
      new LabelBuilder()
        .setLabel("Embed description")
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
            TextInputStyle.Paragraph,
            4_000,
            payload?.embed?.description,
          ),
        ),
      new LabelBuilder()
        .setLabel("Embed color")
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID,
            TextInputStyle.Short,
            7,
            payload?.embed?.color === undefined
              ? undefined
              : formatManagedMessageEmbedColor(payload.embed.color),
          ),
        ),
      new LabelBuilder()
        .setLabel("Embed image URL")
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID,
            TextInputStyle.Short,
            2_048,
            payload?.embed?.imageUrl,
          ),
        ),
    );
}

export function createManagedMessageSendModal(): ModalBuilder {
  return createPayloadModal(MANAGED_MESSAGE_SEND_MODAL_ID, "Send managed message");
}

export function createManagedMessageEditModal(
  messageId: string,
  revision: number,
  payload: ManagedMessagePayload,
): ModalBuilder {
  return createPayloadModal(
    `${MANAGED_MESSAGE_EDIT_MODAL_PREFIX}${messageId}:${revision}`,
    "Edit managed message",
    payload,
  );
}

export function createScheduledMessageCreateModal(durationMs: number): ModalBuilder {
  return createPayloadModal(
    createScheduledMessageCreateModalId(durationMs),
    "Schedule managed message",
  );
}

export function createRecurringMessageCreateModal(input: RecurringCommandInput): ModalBuilder {
  return createPayloadModal(
    createRecurringMessageCreateModalId(input),
    "Schedule recurring message",
  );
}

export function createScheduledMessageEditModal(
  scheduledActionId: string,
  revision: number,
  payload: ManagedMessagePayload,
): ModalBuilder {
  return createPayloadModal(
    createScheduledMessageEditModalId(scheduledActionId, revision),
    "Edit scheduled message",
    payload,
  );
}

const ephemeralReply = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});
const editReply = (content: string): InteractionEditReplyOptions => ({
  content,
  allowedMentions: { parse: [] },
});

function isActiveSupportedTarget(channel: ChatInputCommandInteraction["channel"]): boolean {
  if (channel === null || !isSupportedManagedMessageTargetType(channel.type)) return false;
  if (
    channel.type === ChannelType.PublicThread ||
    channel.type === ChannelType.PrivateThread ||
    channel.type === ChannelType.AnnouncementThread
  ) {
    return channel.isThread() && channel.archived === false;
  }
  return true;
}

function isSupportedTarget(channel: ChatInputCommandInteraction["channel"]): boolean {
  return channel !== null && isSupportedManagedMessageTargetType(channel.type);
}

export async function handleMessageCommand(
  interaction: ChatInputCommandInteraction,
  service: ManagedMessageService,
  scheduledMessages?: ScheduledMessageCommandService,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  const scheduled = group === "schedule";
  if (
    (!scheduled && subcommand !== "send" && subcommand !== "edit") ||
    (scheduled &&
      subcommand !== "create" &&
      subcommand !== "recurring-create" &&
      subcommand !== "cancel" &&
      subcommand !== "status" &&
      subcommand !== "list" &&
      subcommand !== "edit" &&
      subcommand !== "recurrence-edit" &&
      subcommand !== "reschedule")
  ) {
    throw new Error("Unsupported message subcommand");
  }
  const supportedContext =
    interaction.inGuild() &&
    (scheduled && subcommand !== "create" && subcommand !== "recurring-create"
      ? isSupportedTarget(interaction.channel)
      : isActiveSupportedTarget(interaction.channel));
  if (!supportedContext) {
    await interaction.reply(
      ephemeralReply(
        scheduled && subcommand !== "create" && subcommand !== "recurring-create"
          ? "Scheduled-message administration is only supported in a guild text or thread channel."
          : "Managed messages are only supported in a guild text or active thread channel.",
      ),
    );
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply(
      ephemeralReply("You need the Manage Messages permission to manage messages."),
    );
    return;
  }
  if (scheduled) {
    if (scheduledMessages === undefined)
      throw new Error("Scheduled message command service is unavailable");
    if (subcommand === "create") {
      let durationMs: number;
      try {
        durationMs = parseRelativeDuration(interaction.options.getString("after", true));
      } catch (error) {
        if (!(error instanceof InvalidRelativeDurationError)) throw error;
        await interaction.reply(
          ephemeralReply("Enter one duration from 1m through 365d using m, h, or d."),
        );
        return;
      }
      await interaction.showModal(createScheduledMessageCreateModal(durationMs));
      return;
    }

    if (subcommand === "recurring-create") {
      const recurrence = recurrenceOptions(interaction);
      if (parseRecurringCommandInput(recurrence) === undefined) {
        await interaction.reply(
          ephemeralReply(
            "Enter daily without weekdays, or weekly with unique comma-separated weekdays, strict HH:MM, and a named IANA timezone.",
          ),
        );
        return;
      }
      try {
        await interaction.showModal(createRecurringMessageCreateModal(recurrence));
      } catch {
        await interaction.reply(
          ephemeralReply("The recurring timezone is too long for this form."),
        );
      }
      return;
    }

    const scheduledActionId =
      subcommand === "list" ? undefined : interaction.options.getString("id", true);
    if (subcommand === "edit") {
      const target = await scheduledMessages.findEditable({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      if (target.outcome !== "ACTIVE") {
        await interaction.reply(ephemeralReply(scheduledMessageEditableLoadMessage(target)));
        return;
      }
      await interaction.showModal(
        createScheduledMessageEditModal(
          target.definition.action.id,
          target.definition.revision,
          target.definition.payload,
        ),
      );
      return;
    }

    let rescheduleDurationMs: number | undefined;
    if (subcommand === "reschedule") {
      try {
        rescheduleDurationMs = parseRelativeDuration(interaction.options.getString("after", true));
      } catch (error) {
        if (!(error instanceof InvalidRelativeDurationError)) throw error;
        await interaction.reply(
          ephemeralReply("Enter one duration from 1m through 365d using m, h, or d."),
        );
        return;
      }
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (subcommand === "recurrence-edit") {
      if (scheduledMessages.editRecurrence === undefined)
        throw new Error("Recurring administration is unavailable");
      const result = await scheduledMessages.editRecurrence({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorUserId: interaction.user.id,
        recurrence: recurrenceOptions(interaction),
      });
      await interaction.editReply(editReply(recurrenceEditResultMessage(result)));
      return;
    }
    if (subcommand === "cancel") {
      const result = await scheduledMessages.cancel({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorUserId: interaction.user.id,
      });
      await interaction.editReply(editReply(cancelScheduledMessageResultMessage(result)));
      return;
    }
    if (subcommand === "list") {
      const page = interaction.options.getInteger("page") ?? 1;
      const result = await scheduledMessages.list({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        page,
      });
      await interaction.editReply(editReply(scheduledMessageListMessage(result, page)));
      return;
    }
    if (subcommand === "reschedule") {
      if (rescheduleDurationMs === undefined)
        throw new Error("Validated reschedule duration is missing");
      const result = await scheduledMessages.reschedule({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorUserId: interaction.user.id,
        durationMs: rescheduleDurationMs,
      });
      await interaction.editReply(editReply(scheduledMessageRescheduleResultMessage(result)));
      return;
    }
    const result = await scheduledMessages.status({
      scheduledActionId: scheduledActionId!,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    await interaction.editReply(editReply(scheduledMessageStatusMessage(result)));
    return;
  }
  if (subcommand === "send") {
    await interaction.showModal(createManagedMessageSendModal());
    return;
  }

  const reference = parseManagedMessageReference(
    interaction.options.getString("message", true),
    interaction.guildId,
    interaction.channelId,
  );
  if (!reference.ok) {
    await interaction.reply(
      ephemeralReply(
        reference.code === "CURRENT_CHANNEL_MISMATCH"
          ? "The managed message must be in the current guild and channel."
          : "Enter a valid Discord message ID or canonical discord.com message link.",
      ),
    );
    return;
  }
  const target = await service.findForEdit({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: reference.messageId,
  });
  if (target.outcome !== "FOUND") {
    const message =
      target.outcome === "DELETED"
        ? "That managed message has been deleted."
        : target.outcome === "FAILURE"
          ? "WEFT could not load the managed message. Please try again later."
          : "No active managed message was found in this channel for that target.";
    await interaction.reply(ephemeralReply(message));
    return;
  }
  await interaction.showModal(
    createManagedMessageEditModal(target.messageId, target.revision, target.payload),
  );
}

function createScheduledMessageResultMessage(result: CreateScheduledMessageCommandResult): string {
  if (result.outcome === "SUCCESS") {
    const when = Math.floor(result.definition.action.executeAt.getTime() / 1_000);
    const base = `Scheduled message \`${result.definition.action.id}\` created. Target: <#${result.definition.action.targetId}>. Runs: <t:${when}:F> (<t:${when}:R>).`;
    return result.deliveryPendingReconciliation
      ? `${base} Delivery is pending reconciliation.`
      : base;
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return "Enter message content or a visible embed; non-empty content cannot be whitespace-only.";
    case "CONTENT_TOO_LONG":
      return "Message content must be 2000 characters or fewer.";
    case "EMBED_TITLE_TOO_LONG":
      return "The embed title must be 256 characters or fewer.";
    case "EMBED_DESCRIPTION_TOO_LONG":
      return "The embed description must be 4000 characters or fewer.";
    case "EMBED_COLOR_INVALID":
      return "Enter the embed color as RRGGBB or #RRGGBB.";
    case "EMBED_COLOR_ONLY":
      return "An embed color requires a title, description, or image URL.";
    case "EMBED_IMAGE_URL_TOO_LONG":
      return "The embed image URL must be 2048 characters or fewer.";
    case "EMBED_IMAGE_URL_INVALID":
      return "Enter an absolute HTTP or HTTPS embed image URL.";
    case "INVALID_DURATION":
      return "This scheduled-message form has an invalid or expired duration.";
    case "UNSUPPORTED_TARGET":
    case "TARGET_GUILD_MISMATCH":
      return "Scheduled messages are only supported in the current guild text or active thread channel.";
    case "ARCHIVED_THREAD":
      return "Messages cannot be scheduled from an archived thread.";
    case "ACTOR_PERMISSION_MISSING":
      return "You no longer have the Manage Messages permission required to schedule messages.";
    case "BOT_PERMISSION_MISSING":
      return "WEFT cannot send messages in this channel with its current permissions.";
    case "CURRENT_STATE_CHECK_REJECTED":
    case "CURRENT_STATE_CHECK_FAILED":
      return "WEFT could not verify the current channel or permissions. Please try again later.";
    case "PERSISTENCE_UNCONFIRMED":
      return "WEFT could not confirm that the schedule was saved. No delivery was enqueued.";
  }
}

function cancelScheduledMessageResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["cancel"]>>,
): string {
  if (result.outcome === "CANCELLED" || result.outcome === "ALREADY_CANCELLED") {
    const base =
      result.outcome === "CANCELLED"
        ? "Scheduled message cancelled."
        : "That scheduled message was already cancelled.";
    return result.deliveryCleanupPending
      ? `${base} Delivery cleanup could not be confirmed, but the schedule remains cancelled.`
      : base;
  }
  switch (result.outcome) {
    case "EXECUTING":
      return "That scheduled message is already executing and cannot be cancelled.";
    case "COMPLETED":
      return "That scheduled message has already completed.";
    case "FAILED":
      return "That scheduled message has already failed.";
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return "No scheduled message was found in this channel for that ID.";
    case "PERSISTENCE_UNCONFIRMED":
      return "WEFT could not confirm the cancellation. Please try again later.";
    case "CONFLICT":
      return "The scheduled message changed concurrently. Review it before retrying.";
  }
}

function createRecurringMessageResultMessage(
  result: Awaited<ReturnType<NonNullable<ScheduledMessageCommandService["createRecurring"]>>>,
): string {
  if (result.outcome === "SUCCESS") {
    const when = Math.floor(result.scheduledFor.getTime() / 1_000);
    return `Recurring message scheduled as \`${result.scheduledActionId}\`. First occurrence: <t:${when}:F>.${result.deliveryPendingReconciliation ? " Delivery is pending reconciliation." : ""}`;
  }
  if (result.outcome === "FAILURE") return createScheduledMessageResultMessage(result);
  if (result.outcome === "INVALID_GUILD_TIMEZONE")
    return "Configure a valid named IANA guild timezone or supply an explicit valid timezone.";
  if (result.outcome === "INVALID_RECURRENCE") return "The recurrence is invalid.";
  if (result.outcome === "PERSISTENCE_UNCONFIRMED")
    return "WEFT could not confirm that the recurring schedule was saved. No delivery was enqueued.";
  return "Recurring scheduling is temporarily unavailable.";
}

function recurrenceEditResultMessage(
  result: Awaited<ReturnType<NonNullable<ScheduledMessageCommandService["editRecurrence"]>>>,
): string {
  if (result.outcome === "COMMITTED")
    return `Recurrence updated.${result.effect.deferredMaterialization ? " The current in-flight occurrence remains unchanged; future materialization is deferred." : ""}${result.deliveryPendingReconciliation ? " Delivery is pending reconciliation." : ""}`;
  if (result.outcome === "UNCHANGED") return "The recurrence is already unchanged.";
  if (result.outcome === "WRONG_KIND")
    return "This is a one-time schedule; use /message schedule reschedule.";
  if (result.outcome === "INVALID_RECURRENCE") return "The recurrence is invalid.";
  if (result.outcome === "CONFLICT")
    return "The recurring schedule changed concurrently. Review it before retrying.";
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT")
    return "No recurring schedule was found in this channel for that ID.";
  if (result.outcome === "PERSISTENCE_UNCONFIRMED")
    return "WEFT could not confirm the recurrence edit. Inspect the schedule before retrying.";
  return "WEFT could not load the recurring schedule. Please try again later.";
}

function scheduledMessageStatusMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["status"]>>,
): string {
  if (result.outcome === "FOUND") {
    const schedule = result.schedule;
    const when = Math.floor(schedule.executeAt.getTime() / 1_000);
    if ("kind" in schedule) {
      const days =
        schedule.frequency === "WEEKLY"
          ? ` weekdays: ${weekdays.filter((_, index) => (schedule.weekdayMask & (1 << index)) !== 0).join(",")};`
          : "";
      const timeMeaning =
        schedule.status === "CANCELLED"
          ? "Historical scheduled time"
          : schedule.currentOccurrenceStatus === "PENDING"
            ? "Next scheduled occurrence"
            : schedule.currentOccurrenceStatus === null
              ? "Last materialized scheduled time"
              : "Current occurrence scheduled time";
      return `Schedule \`${schedule.scheduledActionId}\` is **${schedule.status}** (recurring). Creator ID: \`${schedule.creatorUserId}\`. Revision: ${schedule.revision}. ${schedule.frequency.toLowerCase()};${days} local time: ${schedule.localTime.slice(0, 5)}; timezone: ${schedule.timezone}. ${timeMeaning}: <t:${when}:F>. Current occurrence: \`${schedule.currentOccurrenceId ?? "none"}\` (${schedule.currentOccurrenceStatus ?? "none"}); retry count: ${schedule.currentOccurrenceId === null ? "none" : (schedule.retryCount ?? "none")}.`;
    }
    const messageLink =
      schedule.status === "COMPLETED" && schedule.resultMessageId !== null
        ? ` Message: https://discord.com/channels/${schedule.guildId}/${schedule.channelId}/${schedule.resultMessageId}.`
        : "";
    return `Schedule \`${schedule.scheduledActionId}\` is **${schedule.status}**. Target: <#${schedule.channelId}>. Runs: <t:${when}:F> (<t:${when}:R>). Creator ID: \`${schedule.creatorUserId}\`. Retry count: ${schedule.retryCount}.${messageLink}`;
  }
  switch (result.outcome) {
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return "No scheduled message was found in this channel for that ID.";
    case "CORRUPT":
      return "WEFT found inconsistent scheduled-message state. Administrator inspection is required.";
    case "UNAVAILABLE":
      return "WEFT could not load the scheduled-message status. Please try again later.";
  }
}

function scheduledMessageEditableLoadMessage(
  result: Exclude<
    Awaited<ReturnType<ScheduledMessageCommandService["findEditable"]>>,
    { outcome: "ACTIVE" }
  >,
): string {
  switch (result.outcome) {
    case "EXECUTING":
      return "That scheduled message is already executing and cannot be edited.";
    case "CANCELLED":
      return "That scheduled message has been cancelled.";
    case "COMPLETED":
      return "That scheduled message has already completed.";
    case "FAILED":
      return "That scheduled message has already failed.";
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return "No scheduled message was found in this channel for that ID.";
    case "CORRUPT":
      return "WEFT found inconsistent scheduled-message state. Administrator inspection is required.";
    case "UNAVAILABLE":
      return "WEFT could not load the scheduled message. Please try again later.";
  }
}

function scheduledMessageListMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["list"]>>,
  page: number,
): string {
  if (result.outcome === "INVALID_PAGE") return "Page must be a positive integer.";
  if (result.outcome === "UNAVAILABLE") {
    return "WEFT could not load scheduled messages. Please try again later.";
  }
  if (result.schedules.length === 0) {
    return `No active or executing scheduled messages were found on page ${page}.`;
  }
  const rows = result.schedules.map((schedule) => {
    const when = Math.floor(schedule.executeAt.getTime() / 1_000);
    if ("kind" in schedule && schedule.kind === "RECURRING") {
      const label =
        schedule.currentOccurrenceStatus === "PENDING"
          ? "next scheduled occurrence"
          : schedule.currentOccurrenceStatus === null
            ? "last materialized scheduled time"
            : "current occurrence scheduled time";
      const selectedDays =
        schedule.frequency === "WEEKLY"
          ? ` ${weekdays.filter((_, index) => (schedule.weekdayMask & (1 << index)) !== 0).join(",")}`
          : "";
      return `- \`${schedule.scheduledActionId}\` — recurring ${schedule.frequency.toLowerCase()}${selectedDays} ${schedule.localTime.slice(0, 5)} ${schedule.timezone} — **${schedule.currentOccurrenceStatus ?? schedule.status}** — ${label}: <t:${when}:F> — creator \`${schedule.creatorUserId}\``;
    }
    const kind = "kind" in schedule ? "one-time " : "";
    return `- \`${schedule.scheduledActionId}\` — ${kind}**${schedule.status}** — <t:${when}:F> (<t:${when}:R>) — creator \`${schedule.creatorUserId}\``;
  });
  return [`Scheduled messages — page ${page}`, ...rows].join("\n");
}

function scheduledMessageEditResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["edit"]>>,
): string {
  if (result.outcome === "EDITED") return "Scheduled message edited.";
  if (result.outcome === "UNCHANGED") return "The scheduled message is already unchanged.";
  if (result.outcome === "INVALID_PAYLOAD") {
    return createScheduledMessageResultMessage({ outcome: "FAILURE", code: result.code });
  }
  if (result.outcome === "CONFLICT") {
    return "This scheduled message changed after the edit form opened. Open a new edit form and try again.";
  }
  if (result.outcome === "PERSISTENCE_UNCONFIRMED") {
    return "WEFT could not confirm the scheduled-message edit. Inspect the current schedule before retrying.";
  }
  if (result.outcome === "CORRUPT") {
    return "WEFT found inconsistent scheduled-message state. Administrator inspection is required.";
  }
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT") {
    return "No scheduled message was found in this channel for that ID.";
  }
  if (result.outcome === "EXECUTING") {
    return "That scheduled message is already executing and cannot be edited.";
  }
  if (result.outcome === "CANCELLED") return "That scheduled message has been cancelled.";
  if (result.outcome === "COMPLETED") return "That scheduled message has already completed.";
  if (result.outcome === "FAILED") return "That scheduled message has already failed.";
  return "WEFT received an unexpected scheduled-message edit result.";
}

function scheduledMessageRescheduleResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["reschedule"]>>,
): string {
  if (result.outcome === "RESCHEDULED") {
    const when = Math.floor(result.definition.action.executeAt.getTime() / 1_000);
    const base = `Scheduled message rescheduled for <t:${when}:F> (<t:${when}:R>).`;
    return result.deliveryPendingReconciliation
      ? `${base} Delivery is pending reconciliation.`
      : base;
  }
  if (result.outcome === "INVALID_DURATION") {
    return "Enter one duration from 1m through 365d using m, h, or d.";
  }
  if (result.outcome === "WRONG_KIND")
    return "This is a recurring schedule; use /message schedule recurrence-edit.";
  if (result.outcome === "CONFLICT") {
    return "The scheduled message changed concurrently. Review it and retry the reschedule.";
  }
  if (result.outcome === "PERSISTENCE_UNCONFIRMED") {
    return "WEFT could not confirm the reschedule. Inspect the current schedule before retrying.";
  }
  if (result.outcome === "UNAVAILABLE") {
    return "WEFT could not load the scheduled message. Please try again later.";
  }
  if (result.outcome === "CORRUPT") {
    return "WEFT found inconsistent scheduled-message state. Administrator inspection is required.";
  }
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT") {
    return "No scheduled message was found in this channel for that ID.";
  }
  if (result.outcome === "EXECUTING") {
    return "That scheduled message is already executing and cannot be rescheduled.";
  }
  if (result.outcome === "CANCELLED") return "That scheduled message has been cancelled.";
  if (result.outcome === "COMPLETED") return "That scheduled message has already completed.";
  if (result.outcome === "FAILED") return "That scheduled message has already failed.";
  return "WEFT received an unexpected scheduled-message reschedule result.";
}

function sendResultMessage(result: ManagedMessageSendResult): string {
  if (result.outcome === "SUCCESS") return "Managed message sent.";
  if (result.outcome === "PARTIAL_FAILURE") {
    return `WEFT sent message \`${result.messageId}\`, but could not establish it as managed or confirm its removal. The message may still exist; manual cleanup may be required.`;
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return "Enter message content or a visible embed; non-empty content cannot be whitespace-only.";
    case "CONTENT_TOO_LONG":
      return "Message content must be 2000 characters or fewer.";
    case "EMBED_TITLE_TOO_LONG":
      return "The embed title must be 256 characters or fewer.";
    case "EMBED_DESCRIPTION_TOO_LONG":
      return "The embed description must be 4000 characters or fewer.";
    case "EMBED_COLOR_INVALID":
      return "Enter the embed color as RRGGBB or #RRGGBB.";
    case "EMBED_COLOR_ONLY":
      return "An embed color requires a title, description, or image URL.";
    case "EMBED_IMAGE_URL_TOO_LONG":
      return "The embed image URL must be 2048 characters or fewer.";
    case "EMBED_IMAGE_URL_INVALID":
      return "Enter an absolute HTTP or HTTPS embed image URL.";
    case "UNSUPPORTED_TARGET":
      return "Managed messages are only supported in a guild text or active thread channel.";
    case "ARCHIVED_THREAD":
      return "Managed messages cannot be sent in an archived thread.";
    case "ACTOR_PERMISSION_MISSING":
      return "You need the Manage Messages permission to send managed messages.";
    case "BOT_PERMISSION_MISSING":
      return "WEFT cannot send messages in this channel with its current permissions.";
    case "CURRENT_STATE_CHECK_FAILED":
      return "WEFT could not verify the current channel or permissions. Please try again later.";
    case "SEND_REJECTED":
      return "Discord rejected the managed message. The message was not sent.";
    case "SEND_UNCONFIRMED":
      return "WEFT could not confirm whether Discord sent the message. Check the channel before retrying.";
    case "PERSISTENCE_UNCONFIRMED_COMPENSATED":
      return "WEFT sent the message but could not establish it as managed, so the sent message was removed.";
  }
}

function editResultMessage(result: ManagedMessageEditResult): string {
  if (result.outcome === "SUCCESS") return "Managed message edited.";
  if (result.outcome === "UNCHANGED") return "The managed message is already unchanged.";
  if (result.outcome === "DELETED")
    return "The Discord message no longer exists and is now marked as deleted in WEFT.";
  if (result.outcome === "PARTIAL_FAILURE") {
    return result.kind === "DELETION_DETECTION"
      ? `Discord message \`${result.messageId}\` is missing, but WEFT could not confirm the managed deletion state. Administrator inspection is required.`
      : `WEFT edited message \`${result.messageId}\`, but could not confirm managed-state finalization or a safe restoration. Administrator inspection is required.`;
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return "Enter message content or a visible embed; non-empty content cannot be whitespace-only.";
    case "CONTENT_TOO_LONG":
      return "Message content must be 2000 characters or fewer.";
    case "EMBED_TITLE_TOO_LONG":
      return "The embed title must be 256 characters or fewer.";
    case "EMBED_DESCRIPTION_TOO_LONG":
      return "The embed description must be 4000 characters or fewer.";
    case "EMBED_COLOR_INVALID":
      return "Enter the embed color as RRGGBB or #RRGGBB.";
    case "EMBED_COLOR_ONLY":
      return "An embed color requires a title, description, or image URL.";
    case "EMBED_IMAGE_URL_TOO_LONG":
      return "The embed image URL must be 2048 characters or fewer.";
    case "EMBED_IMAGE_URL_INVALID":
      return "Enter an absolute HTTP or HTTPS embed image URL.";
    case "TARGET_NOT_FOUND":
      return "No active managed message was found in this channel for that target.";
    case "CONFLICT":
      return "This managed message changed after the edit form opened. Open a new edit form and try again.";
    case "ACTOR_PERMISSION_MISSING":
      return "You no longer have the Manage Messages permission required to edit this message.";
    case "STATE_MISMATCH":
      return "Discord and WEFT disagree about this managed message. An administrator must inspect it before editing.";
    case "ARCHIVED_THREAD":
      return "Managed messages cannot be edited in an archived thread.";
    case "UNSUPPORTED_TARGET":
    case "MESSAGE_INVALID":
      return "WEFT could not verify that target as an editable managed message in this channel.";
    case "BOT_PERMISSION_MISSING":
      return "WEFT cannot edit this message with its current access and permissions.";
    case "CURRENT_STATE_CHECK_FAILED":
      return "WEFT could not verify the current message or permissions. Please try again later.";
    case "EDIT_REJECTED":
      return "Discord rejected the managed-message edit.";
    case "EDIT_NOT_APPLIED":
      return "Discord did not apply the managed-message edit. No managed state was changed.";
    case "EDIT_UNCONFIRMED":
      return "WEFT could not confirm whether Discord applied the edit. Administrator inspection is required.";
    case "PERSISTENCE_CHECK_FAILED":
      return "WEFT could not verify the current managed state. Please try again later.";
    case "PERSISTENCE_UNCONFIRMED_COMPENSATED":
      return "WEFT could not finalize the managed edit, so it safely restored the previous Discord message.";
  }
}

export async function handleManagedMessageModalSubmit(
  interaction: ModalSubmitInteraction,
  service: ManagedMessageService,
  scheduledMessages?: ScheduledMessageCommandService,
): Promise<boolean> {
  const send = interaction.customId === MANAGED_MESSAGE_SEND_MODAL_ID;
  const ownedEdit = interaction.customId.startsWith(MANAGED_MESSAGE_EDIT_MODAL_PREFIX);
  const ownedScheduledCreate = interaction.customId.startsWith(
    SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX,
  );
  const ownedRecurringCreate = interaction.customId.startsWith(
    RECURRING_MESSAGE_CREATE_MODAL_PREFIX,
  );
  const ownedScheduledEdit = interaction.customId.startsWith(SCHEDULED_MESSAGE_EDIT_MODAL_PREFIX);
  if (!send && !ownedEdit && !ownedScheduledCreate && !ownedRecurringCreate && !ownedScheduledEdit)
    return false;

  const editTarget = ownedEdit ? parseManagedMessageEditModalId(interaction.customId) : undefined;
  const scheduledDurationMs = ownedScheduledCreate
    ? parseScheduledMessageCreateModalId(interaction.customId)
    : undefined;
  const recurringInput = ownedRecurringCreate
    ? parseRecurringMessageCreateModalId(interaction.customId)
    : undefined;
  const scheduledEditTarget = ownedScheduledEdit
    ? parseScheduledMessageEditModalId(interaction.customId)
    : undefined;
  if (ownedEdit && editTarget === undefined) {
    await interaction.reply(
      ephemeralReply("This managed-message edit form is invalid or expired."),
    );
    return true;
  }
  if (ownedScheduledCreate && scheduledDurationMs === undefined) {
    await interaction.reply(
      ephemeralReply("This scheduled-message form has an invalid or expired duration."),
    );
    return true;
  }
  if (ownedRecurringCreate && recurringInput === undefined) {
    await interaction.reply(ephemeralReply("This recurring-message form is invalid or expired."));
    return true;
  }
  if (ownedScheduledEdit && scheduledEditTarget === undefined) {
    await interaction.reply(
      ephemeralReply("This scheduled-message edit form is invalid or expired."),
    );
    return true;
  }
  if (ownedScheduledEdit) {
    if (!interaction.inGuild() || interaction.channelId === null) {
      await interaction.reply(
        ephemeralReply(
          "Scheduled-message administration is only supported in a guild text or thread channel.",
        ),
      );
      return true;
    }
    if (!isSupportedTarget(interaction.channel)) {
      await interaction.reply(
        ephemeralReply(
          "Scheduled-message administration is only supported in a guild text or thread channel.",
        ),
      );
      return true;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply(
        ephemeralReply("You need the Manage Messages permission to manage messages."),
      );
      return true;
    }
  }
  const validation = validateManagedMessagePayload({
    content: interaction.fields.getTextInputValue(MANAGED_MESSAGE_CONTENT_INPUT_ID),
    embed: {
      title: interaction.fields.getTextInputValue(MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID),
      description: interaction.fields.getTextInputValue(MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID),
      color: interaction.fields.getTextInputValue(MANAGED_MESSAGE_EMBED_COLOR_INPUT_ID),
      imageUrl: interaction.fields.getTextInputValue(MANAGED_MESSAGE_EMBED_IMAGE_URL_INPUT_ID),
    },
  });
  if (!validation.ok) {
    const result = { outcome: "FAILURE", code: validation.code } as const;
    await interaction.reply(
      ephemeralReply(
        ownedScheduledCreate || ownedRecurringCreate
          ? createScheduledMessageResultMessage(result)
          : send
            ? sendResultMessage(result)
            : editResultMessage(result),
      ),
    );
    return true;
  }
  if (!interaction.inGuild() || interaction.channelId === null) {
    await interaction.reply(
      ephemeralReply(
        "Managed messages are only supported in a guild text or active thread channel.",
      ),
    );
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (ownedScheduledCreate) {
    if (scheduledDurationMs === undefined)
      throw new Error("Validated schedule duration is missing");
    if (scheduledMessages === undefined)
      throw new Error("Scheduled message command service is unavailable");
    const result = await scheduledMessages.create({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      durationMs: scheduledDurationMs,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(createScheduledMessageResultMessage(result)));
  } else if (ownedRecurringCreate) {
    if (recurringInput === undefined || scheduledMessages?.createRecurring === undefined)
      throw new Error("Recurring creation is unavailable");
    const result = await scheduledMessages.createRecurring({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      recurrence: recurringInput,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(createRecurringMessageResultMessage(result)));
  } else if (ownedScheduledEdit) {
    if (scheduledEditTarget === undefined)
      throw new Error("Validated scheduled edit target is missing");
    if (scheduledMessages === undefined)
      throw new Error("Scheduled message command service is unavailable");
    const result = await scheduledMessages.edit({
      scheduledActionId: scheduledEditTarget.scheduledActionId,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      expectedRevision: scheduledEditTarget.expectedRevision,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(scheduledMessageEditResultMessage(result)));
  } else if (send) {
    const result = await service.send({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(sendResultMessage(result)));
  } else {
    if (editTarget === undefined) throw new Error("Validated edit target is missing");
    const result = await service.edit({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      messageId: editTarget.messageId,
      actorUserId: interaction.user.id,
      expectedRevision: editTarget.expectedRevision,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(editResultMessage(result)));
  }
  return true;
}
