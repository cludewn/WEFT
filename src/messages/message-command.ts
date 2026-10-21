import { resolveLocale, translate, type AppLocale } from "../i18n/translate.js";
import {
  ChannelType,
  escapeMarkdown,
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
} from "../relative-duration.js";
import {
  ONE_TIME_SCHEDULE_ERRORS,
  parseOneTimeLocalDateTime,
  parseOneTimeScheduleOptions,
  type OneTimeScheduleInput,
} from "./one-time-message-schedule.js";
import type {
  CreateScheduledMessageCommandResult,
  ScheduledMessageCommandService,
} from "./scheduled-message-command.js";
import {
  parseRecurringCommandInput,
  validateRecurringCommandInput,
  type RecurringCommandInput,
  type RecurringInputField,
} from "./recurring-message.js";

import {
  scheduleStateLabel,
  recurringTimeLabel,
  type ScheduledMessageListNavigation,
} from "./scheduled-message-list.js";

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

export function createScheduledMessageCreateModalId(schedule: OneTimeScheduleInput): string {
  if (schedule.kind === "AFTER") {
    if (!isValidRelativeDurationMilliseconds(schedule.durationMs))
      throw new InvalidRelativeDurationError();
    return `${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}${schedule.durationMs}`;
  }
  if (!parseOneTimeLocalDateTime(schedule.localDateTime).ok)
    throw new Error("Invalid absolute local datetime");
  return `${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}at:${schedule.localDateTime}`;
}

export function parseScheduledMessageCreateModalId(
  customId: string,
): OneTimeScheduleInput | undefined {
  if (customId.length > 100) return undefined;
  const atPrefix = `${SCHEDULED_MESSAGE_CREATE_MODAL_PREFIX}at:`;
  if (customId.startsWith(atPrefix)) {
    const localDateTime = customId.slice(atPrefix.length);
    return parseOneTimeLocalDateTime(localDateTime).ok ? { kind: "AT", localDateTime } : undefined;
  }
  const match = scheduledCreateModalRegex.exec(customId);
  if (match?.[1] === undefined || match[0] !== customId) return undefined;
  const durationMs = Number(match[1]);
  return isValidRelativeDurationMilliseconds(durationMs)
    ? { kind: "AFTER", durationMs }
    : undefined;
}

class RecurringModalTimezoneTooLongError extends Error {}

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

export function createRecurringMessageCreateModalId(input: RecurringCommandInput): string {
  const parsed = parseRecurringCommandInput(input);
  if (parsed === undefined) throw new Error("Invalid recurring command input");
  const timezone =
    parsed.explicitTimezone === undefined ? "-" : encodeURIComponent(parsed.explicitTimezone);
  const customId = `${RECURRING_MESSAGE_CREATE_MODAL_PREFIX}${parsed.frequency === "DAILY" ? "d" : "w"}:${parsed.localTime.replace(":", "")}:${parsed.weekdayMask}:${timezone}`;
  if (customId.length > 100)
    throw new RecurringModalTimezoneTooLongError("Recurring modal identity exceeds Discord limit");
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
  .setDescription(translate("en-US", "command.message.description"))
  .setDescriptionLocalization("ja", translate("ja", "command.message.description"))
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("send")
      .setDescription(translate("en-US", "command.message.send.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.message.send.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("edit")
      .setDescription(translate("en-US", "command.message.edit.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.message.edit.description"))
      .addStringOption((option) =>
        option
          .setName("message")
          .setDescription(translate("en-US", "command.message.edit.message.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.edit.message.description"),
          )
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("schedule")
      .setDescription(translate("en-US", "command.message.schedule.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.message.schedule.description"))
      .addSubcommand((subcommand) =>
        subcommand
          .setName("create")
          .setDescription(translate("en-US", "command.message.schedule.create.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.create.description"),
          )
          .addStringOption((option) =>
            option
              .setName("after")
              .setDescription(
                translate("en-US", "command.message.schedule.create.after.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.create.after.description"),
              ),
          )
          .addStringOption((option) =>
            option
              .setName("at")
              .setDescription(translate("en-US", "command.message.schedule.create.at.description"))
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.create.at.description"),
              )
              .setMinLength(16)
              .setMaxLength(16),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("recurring-create")
          .setDescription(
            translate("en-US", "command.message.schedule.recurring-create.description"),
          )
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.recurring-create.description"),
          )
          .addStringOption((option) =>
            option
              .setName("frequency")
              .setDescription(
                translate(
                  "en-US",
                  "command.message.schedule.recurring-create.frequency.description",
                ),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurring-create.frequency.description"),
              )
              .setRequired(true)
              .addChoices(
                {
                  name: translate("en-US", "command.choice.daily"),
                  value: "daily",
                  name_localizations: { ja: translate("ja", "command.choice.daily") },
                },
                {
                  name: translate("en-US", "command.choice.weekly"),
                  value: "weekly",
                  name_localizations: { ja: translate("ja", "command.choice.weekly") },
                },
              ),
          )
          .addStringOption((option) =>
            option
              .setName("time")
              .setDescription(
                translate("en-US", "command.message.schedule.recurring-create.time.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurring-create.time.description"),
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("weekdays")
              .setDescription(
                translate(
                  "en-US",
                  "command.message.schedule.recurring-create.weekdays.description",
                ),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurring-create.weekdays.description"),
              ),
          )
          .addStringOption((option) =>
            option
              .setName("timezone")
              .setDescription(
                translate(
                  "en-US",
                  "command.message.schedule.recurring-create.timezone.description",
                ),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurring-create.timezone.description"),
              ),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("cancel")
          .setDescription(translate("en-US", "command.message.schedule.cancel.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.cancel.description"),
          )
          .addStringOption((option) =>
            option
              .setName("id")
              .setDescription(translate("en-US", "command.message.schedule.cancel.id.description"))
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.cancel.id.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("status")
          .setDescription(translate("en-US", "command.message.schedule.status.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.status.description"),
          )
          .addStringOption((option) =>
            option
              .setName("id")
              .setDescription(translate("en-US", "command.message.schedule.status.id.description"))
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.status.id.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("list")
          .setDescription(translate("en-US", "command.message.schedule.list.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.list.description"),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("edit")
          .setDescription(translate("en-US", "command.message.schedule.edit.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.edit.description"),
          )
          .addStringOption((option) =>
            option
              .setName("id")
              .setDescription(translate("en-US", "command.message.schedule.edit.id.description"))
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.edit.id.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("reschedule")
          .setDescription(translate("en-US", "command.message.schedule.reschedule.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.reschedule.description"),
          )
          .addStringOption((option) =>
            option
              .setName("id")
              .setDescription(
                translate("en-US", "command.message.schedule.reschedule.id.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.reschedule.id.description"),
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("after")
              .setDescription(
                translate("en-US", "command.message.schedule.reschedule.after.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.reschedule.after.description"),
              ),
          )
          .addStringOption((option) =>
            option
              .setName("at")
              .setDescription(
                translate("en-US", "command.message.schedule.reschedule.at.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.reschedule.at.description"),
              )
              .setMinLength(16)
              .setMaxLength(16),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("recurrence-edit")
          .setDescription(
            translate("en-US", "command.message.schedule.recurrence-edit.description"),
          )
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.message.schedule.recurrence-edit.description"),
          )
          .addStringOption((option) =>
            option
              .setName("id")
              .setDescription(
                translate("en-US", "command.message.schedule.recurrence-edit.id.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurrence-edit.id.description"),
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("frequency")
              .setDescription(
                translate(
                  "en-US",
                  "command.message.schedule.recurrence-edit.frequency.description",
                ),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurrence-edit.frequency.description"),
              )
              .setRequired(true)
              .addChoices(
                {
                  name: translate("en-US", "command.choice.daily"),
                  value: "daily",
                  name_localizations: { ja: translate("ja", "command.choice.daily") },
                },
                {
                  name: translate("en-US", "command.choice.weekly"),
                  value: "weekly",
                  name_localizations: { ja: translate("ja", "command.choice.weekly") },
                },
              ),
          )
          .addStringOption((option) =>
            option
              .setName("time")
              .setDescription(
                translate("en-US", "command.message.schedule.recurrence-edit.time.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurrence-edit.time.description"),
              )
              .setRequired(true),
          )
          .addStringOption((option) =>
            option
              .setName("weekdays")
              .setDescription(
                translate("en-US", "command.message.schedule.recurrence-edit.weekdays.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurrence-edit.weekdays.description"),
              ),
          )
          .addStringOption((option) =>
            option
              .setName("timezone")
              .setDescription(
                translate("en-US", "command.message.schedule.recurrence-edit.timezone.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.message.schedule.recurrence-edit.timezone.description"),
              ),
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
  locale: AppLocale = "en-US",
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(translate(locale, "message.contentLabel"))
        .setDescription(translate(locale, "message.contentDescription"))
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_CONTENT_INPUT_ID,
            TextInputStyle.Paragraph,
            2_000,
            payload?.content,
          ),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "message.embedTitleLabel"))
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_TITLE_INPUT_ID,
            TextInputStyle.Short,
            256,
            payload?.embed?.title,
          ),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "message.embedDescriptionLabel"))
        .setTextInputComponent(
          createInput(
            MANAGED_MESSAGE_EMBED_DESCRIPTION_INPUT_ID,
            TextInputStyle.Paragraph,
            4_000,
            payload?.embed?.description,
          ),
        ),
      new LabelBuilder()
        .setLabel(translate(locale, "message.embedColorLabel"))
        .setDescription(translate(locale, "message.embedColorDescription"))
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
        .setLabel(translate(locale, "message.embedImageLabel"))
        .setDescription(translate(locale, "message.embedImageDescription"))
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

export function createManagedMessageSendModal(locale: AppLocale = "en-US"): ModalBuilder {
  return createPayloadModal(
    MANAGED_MESSAGE_SEND_MODAL_ID,
    translate(locale, "message.sendModalTitle"),
    undefined,
    locale,
  );
}

export function createManagedMessageEditModal(
  messageId: string,
  revision: number,
  payload: ManagedMessagePayload,
  locale: AppLocale = "en-US",
): ModalBuilder {
  return createPayloadModal(
    `${MANAGED_MESSAGE_EDIT_MODAL_PREFIX}${messageId}:${revision}`,
    translate(locale, "message.editModalTitle"),
    payload,
    locale,
  );
}

export function createScheduledMessageCreateModal(
  schedule: OneTimeScheduleInput,
  locale: AppLocale = "en-US",
): ModalBuilder {
  return createPayloadModal(
    createScheduledMessageCreateModalId(schedule),
    translate(locale, "message.scheduleModalTitle"),
    undefined,
    locale,
  );
}

export function createRecurringMessageCreateModal(
  input: RecurringCommandInput,
  locale: AppLocale = "en-US",
): ModalBuilder {
  return createPayloadModal(
    createRecurringMessageCreateModalId(input),
    translate(locale, "message.recurringModalTitle"),
    undefined,
    locale,
  );
}

export function createScheduledMessageEditModal(
  scheduledActionId: string,
  revision: number,
  payload: ManagedMessagePayload,
  locale: AppLocale = "en-US",
): ModalBuilder {
  return createPayloadModal(
    createScheduledMessageEditModalId(scheduledActionId, revision),
    translate(locale, "message.scheduleEditModalTitle"),
    payload,
    locale,
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

const EDIT_MODAL_PREPARATION_MS = 2_000;
const MODAL_ERROR_RESPONSE_MS = 2_500;

async function replyBeforeModalDeadline(
  interaction: ChatInputCommandInteraction,
  elapsed: () => number,
  message: string,
): Promise<void> {
  if (elapsed() < MODAL_ERROR_RESPONSE_MS) await interaction.reply(ephemeralReply(message));
}

async function showEditableMessageModal<T>(
  interaction: ChatInputCommandInteraction,
  elapsed: () => number,
  read: () => Promise<T>,
  prepare: (target: T) => ModalBuilder | string,
  unavailable: string,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  if (elapsed() >= EDIT_MODAL_PREPARATION_MS) {
    await replyBeforeModalDeadline(interaction, elapsed, unavailable);
    return;
  }

  // Observe a bounded result, but keep the admitted handler alive until the raw read settles.
  const raw = (async () => read())();
  const settled = raw.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let prepared;
    try {
      const result = await Promise.race([
        settled,
        new Promise<{ status: "timeout" }>((resolve) => {
          timer = setTimeout(
            () => resolve({ status: "timeout" }),
            Math.max(0, EDIT_MODAL_PREPARATION_MS - elapsed()),
          );
        }),
      ]);
      clearTimeout(timer);
      // Check the clock even if the read's microtask beat the timeout callback.
      if (result.status === "timeout" || elapsed() >= EDIT_MODAL_PREPARATION_MS) {
        prepared = unavailable;
      } else {
        if (result.status === "rejected") throw result.error;
        const modal = prepare(result.value);
        // Pass serialized data so showModal cannot perform deferred builder validation.
        prepared = typeof modal === "string" ? modal : modal.toJSON();
      }
    } catch (error) {
      try {
        await replyBeforeModalDeadline(
          interaction,
          elapsed,
          translate(locale, "message.formFailed"),
        );
      } catch {
        // Preparation remains the primary error for bounded dispatcher logging.
      }
      throw error;
    }

    if (elapsed() >= EDIT_MODAL_PREPARATION_MS) {
      await replyBeforeModalDeadline(interaction, elapsed, unavailable);
    } else if (typeof prepared === "string") {
      await replyBeforeModalDeadline(interaction, elapsed, prepared);
    } else {
      // Once attempted, an ambiguous Modal acknowledgement must never cause another reply.
      await interaction.showModal(prepared);
    }
  } finally {
    clearTimeout(timer);
    await settled;
  }
}

export async function handleMessageCommand(
  interaction: ChatInputCommandInteraction,
  service: ManagedMessageService,
  scheduledMessages?: ScheduledMessageCommandService,
  scheduledMessageLists?: ScheduledMessageListNavigation,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  const startedAt = performance.now();
  const initialAge = Math.max(0, Date.now() - interaction.createdTimestamp);
  const elapsed = () => initialAge + performance.now() - startedAt;
  const subcommand = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  const scheduled = group === "schedule";
  const replyContextError = (message: string) =>
    subcommand === "edit"
      ? replyBeforeModalDeadline(interaction, elapsed, message)
      : interaction.reply(ephemeralReply(message));
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
    await replyContextError(
      scheduled && subcommand !== "create" && subcommand !== "recurring-create"
        ? translate(locale, "message.scheduleContext")
        : translate(locale, "message.context"),
    );
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await replyContextError(translate(locale, "message.managePermission"));
    return;
  }
  if (scheduled) {
    if (scheduledMessages === undefined)
      throw new Error("Scheduled message command service is unavailable");
    if (subcommand === "create") {
      const selector = parseOneTimeScheduleOptions(
        interaction.options.getString("after"),
        interaction.options.getString("at"),
      );
      if (!selector.ok) {
        await interaction.reply(
          ephemeralReply(translate(locale, `schedule.error.${selector.code}`)),
        );
        return;
      }
      await interaction.showModal(createScheduledMessageCreateModal(selector.schedule, locale));
      return;
    }

    if (subcommand === "recurring-create") {
      const recurrence = recurrenceOptions(interaction);
      const recurrenceValidation = validateRecurringCommandInput(recurrence);
      if (!recurrenceValidation.ok) {
        await interaction.reply(
          ephemeralReply(recurrenceInputGuidance(recurrenceValidation.field, locale)),
        );
        return;
      }
      let modal;
      try {
        modal = createRecurringMessageCreateModal(recurrence, locale).toJSON();
      } catch (error) {
        if (error instanceof RecurringModalTimezoneTooLongError) {
          await replyBeforeModalDeadline(
            interaction,
            elapsed,
            translate(locale, "message.timezoneTooLong"),
          );
          return;
        }
        try {
          await replyBeforeModalDeadline(
            interaction,
            elapsed,
            translate(locale, "message.formFailed"),
          );
        } catch {
          // Preserve the construction/serialization error for bounded dispatcher logging.
        }
        throw error;
      }
      await interaction.showModal(modal);
      return;
    }

    const scheduledActionId =
      subcommand === "list" ? undefined : interaction.options.getString("id", true);
    if (subcommand === "edit") {
      await showEditableMessageModal(
        interaction,
        elapsed,
        () =>
          scheduledMessages.findEditable({
            scheduledActionId: scheduledActionId!,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
          }),
        (target) =>
          target.outcome === "ACTIVE"
            ? createScheduledMessageEditModal(
                target.definition.action.id,
                target.definition.revision,
                target.definition.payload,
                locale,
              )
            : scheduledMessageEditableLoadMessage(target, locale),
        translate(locale, "message.scheduleReadFailed"),
      );
      return;
    }

    let rescheduleInput: OneTimeScheduleInput | undefined;
    if (subcommand === "reschedule") {
      const selector = parseOneTimeScheduleOptions(
        interaction.options.getString("after"),
        interaction.options.getString("at"),
      );
      if (!selector.ok) {
        await interaction.reply(
          ephemeralReply(translate(locale, `schedule.error.${selector.code}`)),
        );
        return;
      }
      rescheduleInput = selector.schedule;
    }

    if (subcommand === "list") {
      if (scheduledMessageLists === undefined)
        throw new Error("Scheduled message list navigation is unavailable");
      await scheduledMessageLists.start(interaction);
      return;
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
      await interaction.editReply(
        editReply(recurrenceEditResultMessage(result, scheduledActionId!, locale)),
      );
      return;
    }
    if (subcommand === "cancel") {
      const result = await scheduledMessages.cancel({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorUserId: interaction.user.id,
      });
      await interaction.editReply(
        editReply(cancelScheduledMessageResultMessage(result, scheduledActionId!, locale)),
      );
      return;
    }
    if (subcommand === "reschedule") {
      if (rescheduleInput === undefined)
        throw new Error("Validated reschedule selector is missing");
      const result = await scheduledMessages.reschedule({
        scheduledActionId: scheduledActionId!,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        actorUserId: interaction.user.id,
        schedule: rescheduleInput,
      });
      await interaction.editReply(
        editReply(scheduledMessageRescheduleResultMessage(result, locale)),
      );
      return;
    }
    const result = await scheduledMessages.status({
      scheduledActionId: scheduledActionId!,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    await interaction.editReply(editReply(scheduledMessageStatusMessage(result, locale)));
    return;
  }
  if (subcommand === "send") {
    await interaction.showModal(createManagedMessageSendModal(locale));
    return;
  }

  const reference = parseManagedMessageReference(
    interaction.options.getString("message", true),
    interaction.guildId,
    interaction.channelId,
  );
  if (!reference.ok) {
    await replyBeforeModalDeadline(
      interaction,
      elapsed,
      reference.code === "CURRENT_CHANNEL_MISMATCH"
        ? translate(locale, "message.referenceScope")
        : translate(locale, "message.invalidReference"),
    );
    return;
  }
  await showEditableMessageModal(
    interaction,
    elapsed,
    () =>
      service.findForEdit({
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: reference.messageId,
      }),
    (target) =>
      target.outcome === "FOUND"
        ? createManagedMessageEditModal(target.messageId, target.revision, target.payload, locale)
        : target.outcome === "DELETED"
          ? translate(locale, "message.deletedTarget")
          : target.outcome === "FAILURE"
            ? translate(locale, "message.readFailed")
            : translate(locale, "message.notFound"),
    translate(locale, "message.readFailed"),
  );
}

function safeScheduleMetadata(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]/g, " "), {
    maskedLink: true,
    heading: true,
    bulletedList: true,
    numberedList: true,
  })
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>");
}

function recurrenceInputGuidance(field?: RecurringInputField, locale: AppLocale = "en-US"): string {
  switch (field) {
    case "frequency":
      return translate(locale, "message.invalidFrequency");
    case "time":
      return translate(locale, "message.invalidTime");
    case "weekdays":
      return translate(locale, "message.invalidWeekdays");
    case "timezone":
      return translate(locale, "message.invalidTimezone");
    default:
      return translate(locale, "message.invalidRecurrence");
  }
}

function createScheduledMessageResultMessage(
  result: CreateScheduledMessageCommandResult,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "SUCCESS") {
    const when = Math.floor(result.definition.action.executeAt.getTime() / 1_000);
    return translate(locale, "message.scheduleCreated", {
      id: result.definition.action.id,
      channelId: result.definition.action.targetId,
      when,
      pending: result.deliveryPendingReconciliation,
    });
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return translate(locale, "message.emptyContent");
    case "CONTENT_TOO_LONG":
      return translate(locale, "message.contentTooLong");
    case "EMBED_TITLE_TOO_LONG":
      return translate(locale, "message.embedTitleTooLong");
    case "EMBED_DESCRIPTION_TOO_LONG":
      return translate(locale, "message.embedDescriptionTooLong");
    case "EMBED_COLOR_INVALID":
      return translate(locale, "message.invalidEmbedColor");
    case "EMBED_COLOR_ONLY":
      return translate(locale, "message.embedColorOnly");
    case "EMBED_IMAGE_URL_TOO_LONG":
      return translate(locale, "message.embedImageTooLong");
    case "EMBED_IMAGE_URL_INVALID":
      return translate(locale, "message.invalidEmbedImage");
    case "MISSING_SELECTOR":
    case "CONFLICTING_SELECTORS":
    case "INVALID_AT_FORMAT":
    case "INVALID_AT_DATE":
    case "INVALID_GUILD_TIMEZONE":
    case "TIMEZONE_UNAVAILABLE":
    case "DST_GAP":
    case "DST_OVERLAP":
    case "TOO_SOON":
    case "TOO_FAR":
    case "INVALID_DURATION":
      return translate(locale, `schedule.error.${result.code}`);
    case "UNSUPPORTED_TARGET":
    case "TARGET_GUILD_MISMATCH":
      return translate(locale, "message.scheduleTarget");
    case "ARCHIVED_THREAD":
      return translate(locale, "message.scheduleArchived");
    case "ACTOR_PERMISSION_MISSING":
      return translate(locale, "message.schedulePermissionLost");
    case "BOT_PERMISSION_MISSING":
      return translate(locale, "message.sendBotPermission");
    case "CURRENT_STATE_CHECK_REJECTED":
    case "CURRENT_STATE_CHECK_FAILED":
      return translate(locale, "message.channelCheckFailed");
    case "PERSISTENCE_UNCONFIRMED":
      return translate(locale, "message.scheduleSaveUnconfirmed");
  }
}

function cancelScheduledMessageResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["cancel"]>>,
  scheduledActionId: string,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "CANCELLED" || result.outcome === "ALREADY_CANCELLED") {
    return translate(locale, "message.scheduleCancelled", {
      id: scheduledActionId,
      recurring: result.kind === "RECURRING",
      already: result.outcome === "ALREADY_CANCELLED",
      cleanupPending: result.deliveryCleanupPending,
    });
  }
  switch (result.outcome) {
    case "EXECUTING":
      return translate(locale, "message.cancelExecuting");
    case "COMPLETED":
      return translate(locale, "message.scheduleCompleted");
    case "FAILED":
      return translate(locale, "message.scheduleFailed");
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return translate(locale, "message.scheduleNotFound");
    case "PERSISTENCE_UNCONFIRMED":
      return translate(locale, "message.cancelUnconfirmed");
    case "CONFLICT":
      return translate(locale, "message.scheduleConflict");
  }
}

function createRecurringMessageResultMessage(
  result: Awaited<ReturnType<NonNullable<ScheduledMessageCommandService["createRecurring"]>>>,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "SUCCESS") {
    const when = Math.floor(result.scheduledFor.getTime() / 1_000);
    return translate(locale, "message.recurringCreated", {
      id: result.scheduledActionId,
      when,
      pending: result.deliveryPendingReconciliation,
    });
  }
  if (result.outcome === "FAILURE") return createScheduledMessageResultMessage(result, locale);
  if (result.outcome === "INVALID_GUILD_TIMEZONE")
    return translate(locale, "message.guildTimezoneInvalid");
  if (result.outcome === "INVALID_RECURRENCE") return recurrenceInputGuidance(result.field, locale);
  if (result.outcome === "PERSISTENCE_UNCONFIRMED")
    return translate(locale, "message.recurringSaveUnconfirmed");
  return translate(locale, "message.recurringUnavailable");
}

function recurrenceEditResultMessage(
  result: Awaited<ReturnType<NonNullable<ScheduledMessageCommandService["editRecurrence"]>>>,
  scheduledActionId: string,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "COMMITTED")
    return translate(locale, "message.recurrenceEdited", {
      id: scheduledActionId,
      deferred: result.effect.deferredMaterialization,
      pending: result.deliveryPendingReconciliation,
    });
  if (result.outcome === "UNCHANGED")
    return translate(locale, "message.recurrenceUnchanged", { id: scheduledActionId });
  if (result.outcome === "WRONG_KIND") return translate(locale, "message.oneTimeUseReschedule");
  if (result.outcome === "INVALID_RECURRENCE") return recurrenceInputGuidance(result.field, locale);
  if (result.outcome === "CONFLICT") return translate(locale, "message.recurringConflict");
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT")
    return translate(locale, "message.recurringNotFound");
  if (result.outcome === "PERSISTENCE_UNCONFIRMED")
    return translate(locale, "message.recurrenceUnconfirmed");
  return translate(locale, "message.recurringReadFailed");
}

function scheduledMessageStatusMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["status"]>>,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "FOUND") {
    const schedule = result.schedule;
    const when = Math.floor(schedule.executeAt.getTime() / 1_000);
    const creator = translate(locale, "message.status.creator", { id: schedule.creatorUserId });
    if ("kind" in schedule) {
      const days =
        schedule.frequency === "WEEKLY"
          ? translate(locale, "message.status.weekdays", {
              days: weekdays
                .filter((_, index) => (schedule.weekdayMask & (1 << index)) !== 0)
                .join(", "),
            })
          : "";
      const timeMeaning = recurringTimeLabel(
        schedule.status,
        schedule.currentOccurrenceStatus,
        false,
        locale,
      );
      return [
        translate(locale, "message.status.recurring", { id: schedule.scheduledActionId }),
        translate(locale, "message.status.series", { state: scheduleStateLabel(schedule.status) }),
        translate(locale, "message.status.target", { id: schedule.channelId }),
        creator,
        translate(locale, "message.status.revision", { revision: schedule.revision }),
        "",
        translate(locale, "message.status.recurrence", { daily: schedule.frequency === "DAILY" }),
        translate(locale, "message.status.localTime", {
          days,
          time: safeScheduleMetadata(schedule.localTime.slice(0, 5)),
        }),
        translate(locale, "message.status.timezone", {
          timezone: safeScheduleMetadata(schedule.timezone),
        }),
        `${timeMeaning}: <t:${when}:F>`,
        translate(locale, "message.timestampNote"),
        "",
        translate(locale, "message.status.occurrence", { id: schedule.currentOccurrenceId }),
        translate(locale, "message.status.occurrenceState", {
          state:
            schedule.currentOccurrenceStatus === null
              ? translate(locale, "message.none")
              : scheduleStateLabel(schedule.currentOccurrenceStatus),
        }),
        translate(locale, "message.status.occurrenceRetries", {
          count: schedule.currentOccurrenceId === null ? null : (schedule.retryCount ?? null),
        }),
      ].join("\n");
    }
    const timeMeaning =
      schedule.status === "ACTIVE"
        ? translate(locale, "message.scheduledFor")
        : schedule.status === "EXECUTING"
          ? translate(locale, "message.executingScheduledFor")
          : translate(locale, "message.originalScheduledFor");
    const lines = [
      translate(locale, "message.status.oneTime", { id: schedule.scheduledActionId }),
      translate(locale, "message.status.state", { state: scheduleStateLabel(schedule.status) }),
      translate(locale, "message.status.target", { id: schedule.channelId }),
      `${timeMeaning}: <t:${when}:F> (<t:${when}:R>)`,
      creator,
      translate(locale, "message.status.retries", { count: schedule.retryCount }),
    ];
    if (schedule.status === "COMPLETED" && schedule.resultMessageId !== null)
      lines.push(
        translate(locale, "message.status.link", {
          guildId: schedule.guildId,
          channelId: schedule.channelId,
          messageId: schedule.resultMessageId,
        }),
      );
    return lines.join("\n");
  }
  switch (result.outcome) {
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return translate(locale, "message.scheduleNotFound");
    case "CORRUPT":
      return translate(locale, "message.scheduleCorrupt");
    case "UNAVAILABLE":
      return translate(locale, "message.scheduleStatusFailed");
  }
}

function scheduledMessageEditableLoadMessage(
  result: Exclude<
    Awaited<ReturnType<ScheduledMessageCommandService["findEditable"]>>,
    { outcome: "ACTIVE" }
  >,
  locale: AppLocale = "en-US",
): string {
  switch (result.outcome) {
    case "EXECUTING":
      return translate(locale, "message.editExecuting");
    case "CANCELLED":
      return translate(locale, "message.scheduleAlreadyCancelled");
    case "COMPLETED":
      return translate(locale, "message.scheduleCompleted");
    case "FAILED":
      return translate(locale, "message.scheduleFailed");
    case "NOT_FOUND_OR_WRONG_CONTEXT":
      return translate(locale, "message.scheduleNotFound");
    case "CORRUPT":
      return translate(locale, "message.scheduleCorrupt");
    case "UNAVAILABLE":
      return translate(locale, "message.scheduleReadFailed");
  }
}

function scheduledMessageEditResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["edit"]>>,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "EDITED" || result.outcome === "UNCHANGED") {
    return translate(locale, "message.schedulePayloadEdited", {
      id: result.definition.action.id,
      recurring: result.kind === "RECURRING",
      unchanged: result.outcome === "UNCHANGED",
    });
  }
  if (result.outcome === "INVALID_PAYLOAD") {
    return createScheduledMessageResultMessage({ outcome: "FAILURE", code: result.code }, locale);
  }
  if (result.outcome === "CONFLICT") {
    return translate(locale, "message.scheduleEditConflict");
  }
  if (result.outcome === "PERSISTENCE_UNCONFIRMED") {
    return translate(locale, "message.scheduleEditUnconfirmed");
  }
  if (result.outcome === "CORRUPT") {
    return translate(locale, "message.scheduleCorrupt");
  }
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT") {
    return translate(locale, "message.scheduleNotFound");
  }
  if (result.outcome === "EXECUTING") {
    return translate(locale, "message.editExecuting");
  }
  if (result.outcome === "CANCELLED") return translate(locale, "message.scheduleAlreadyCancelled");
  if (result.outcome === "COMPLETED") return translate(locale, "message.scheduleCompleted");
  if (result.outcome === "FAILED") return translate(locale, "message.scheduleFailed");
  return translate(locale, "message.unexpectedScheduleEdit");
}

function scheduledMessageRescheduleResultMessage(
  result: Awaited<ReturnType<ScheduledMessageCommandService["reschedule"]>>,
  locale: AppLocale = "en-US",
): string {
  if (result.outcome === "RESCHEDULED") {
    const when = Math.floor(result.definition.action.executeAt.getTime() / 1_000);
    return translate(locale, "message.rescheduled", {
      id: result.definition.action.id,
      when,
      pending: result.deliveryPendingReconciliation,
    });
  }
  if (result.outcome in ONE_TIME_SCHEDULE_ERRORS) {
    return translate(
      locale,
      `schedule.error.${result.outcome as keyof typeof ONE_TIME_SCHEDULE_ERRORS}`,
    );
  }
  if (result.outcome === "WRONG_KIND")
    return translate(locale, "message.recurringUseRecurrenceEdit");
  if (result.outcome === "CONFLICT") {
    return translate(locale, "message.rescheduleConflict");
  }
  if (result.outcome === "PERSISTENCE_UNCONFIRMED") {
    return translate(locale, "message.rescheduleUnconfirmed");
  }
  if (result.outcome === "UNAVAILABLE") {
    return translate(locale, "message.scheduleReadFailed");
  }
  if (result.outcome === "CORRUPT") {
    return translate(locale, "message.scheduleCorrupt");
  }
  if (result.outcome === "NOT_FOUND_OR_WRONG_CONTEXT") {
    return translate(locale, "message.scheduleNotFound");
  }
  if (result.outcome === "EXECUTING") {
    return translate(locale, "message.rescheduleExecuting");
  }
  if (result.outcome === "CANCELLED") return translate(locale, "message.scheduleAlreadyCancelled");
  if (result.outcome === "COMPLETED") return translate(locale, "message.scheduleCompleted");
  if (result.outcome === "FAILED") return translate(locale, "message.scheduleFailed");
  return translate(locale, "message.unexpectedReschedule");
}

function sendResultMessage(result: ManagedMessageSendResult, locale: AppLocale = "en-US"): string {
  if (result.outcome === "SUCCESS")
    return translate(locale, "message.sent", { id: result.messageId });
  if (result.outcome === "UNCONFIRMED") {
    return translate(locale, "message.managementUnconfirmed", { id: result.messageId });
  }
  if (result.outcome === "PARTIAL_FAILURE") {
    if (result.deletionOutcome === "REJECTED")
      return translate(locale, "message.removalRejected", { id: result.messageId });
    return translate(locale, "message.removalUnconfirmed", { id: result.messageId });
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return translate(locale, "message.emptyContent");
    case "CONTENT_TOO_LONG":
      return translate(locale, "message.contentTooLong");
    case "EMBED_TITLE_TOO_LONG":
      return translate(locale, "message.embedTitleTooLong");
    case "EMBED_DESCRIPTION_TOO_LONG":
      return translate(locale, "message.embedDescriptionTooLong");
    case "EMBED_COLOR_INVALID":
      return translate(locale, "message.invalidEmbedColor");
    case "EMBED_COLOR_ONLY":
      return translate(locale, "message.embedColorOnly");
    case "EMBED_IMAGE_URL_TOO_LONG":
      return translate(locale, "message.embedImageTooLong");
    case "EMBED_IMAGE_URL_INVALID":
      return translate(locale, "message.invalidEmbedImage");
    case "UNSUPPORTED_TARGET":
      return translate(locale, "message.context");
    case "ARCHIVED_THREAD":
      return translate(locale, "message.sendArchived");
    case "ACTOR_PERMISSION_MISSING":
      return translate(locale, "message.sendPermission");
    case "BOT_PERMISSION_MISSING":
      return translate(locale, "message.sendBotPermission");
    case "CURRENT_STATE_CHECK_FAILED":
      return translate(locale, "message.channelCheckFailed");
    case "SEND_REJECTED":
      return translate(locale, "message.sendRejected");
    case "SEND_UNCONFIRMED":
      return translate(locale, "message.sendUnconfirmed");
    case "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT":
      return translate(locale, "message.alreadyAbsent");
    case "PERSISTENCE_UNCONFIRMED_COMPENSATED":
      return translate(locale, "message.sendCompensated");
  }
}

function editResultMessage(result: ManagedMessageEditResult, locale: AppLocale = "en-US"): string {
  if (result.outcome === "SUCCESS")
    return translate(locale, "message.edited", { id: result.messageId });
  if (result.outcome === "UNCHANGED")
    return translate(locale, "message.unchanged", { id: result.messageId });
  if (result.outcome === "DELETED") return translate(locale, "message.deletionDetected");
  if (result.outcome === "PARTIAL_FAILURE") {
    return result.kind === "DELETION_DETECTION"
      ? translate(locale, "message.deletionUnconfirmed", { id: result.messageId })
      : translate(locale, "message.editPartial", { id: result.messageId });
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return translate(locale, "message.emptyContent");
    case "CONTENT_TOO_LONG":
      return translate(locale, "message.contentTooLong");
    case "EMBED_TITLE_TOO_LONG":
      return translate(locale, "message.embedTitleTooLong");
    case "EMBED_DESCRIPTION_TOO_LONG":
      return translate(locale, "message.embedDescriptionTooLong");
    case "EMBED_COLOR_INVALID":
      return translate(locale, "message.invalidEmbedColor");
    case "EMBED_COLOR_ONLY":
      return translate(locale, "message.embedColorOnly");
    case "EMBED_IMAGE_URL_TOO_LONG":
      return translate(locale, "message.embedImageTooLong");
    case "EMBED_IMAGE_URL_INVALID":
      return translate(locale, "message.invalidEmbedImage");
    case "TARGET_NOT_FOUND":
      return translate(locale, "message.notFound");
    case "CONFLICT":
      return translate(locale, "message.editConflict");
    case "ACTOR_PERMISSION_MISSING":
      return translate(locale, "message.editPermissionLost");
    case "STATE_MISMATCH":
      return translate(locale, "message.stateMismatch");
    case "ARCHIVED_THREAD":
      return translate(locale, "message.editArchived");
    case "UNSUPPORTED_TARGET":
    case "MESSAGE_INVALID":
      return translate(locale, "message.invalidEditableTarget");
    case "BOT_PERMISSION_MISSING":
      return translate(locale, "message.editBotPermission");
    case "CURRENT_STATE_CHECK_FAILED":
      return translate(locale, "message.messageCheckFailed");
    case "EDIT_REJECTED":
      return translate(locale, "message.editRejected");
    case "EDIT_NOT_APPLIED":
      return translate(locale, "message.editNotApplied");
    case "EDIT_UNCONFIRMED":
      return translate(locale, "message.editUnconfirmed");
    case "PERSISTENCE_CHECK_FAILED":
      return translate(locale, "message.stateCheckFailed");
    case "PERSISTENCE_UNCONFIRMED_COMPENSATED":
      return translate(locale, "message.editCompensated");
  }
}

export async function handleManagedMessageModalSubmit(
  interaction: ModalSubmitInteraction,
  service: ManagedMessageService,
  scheduledMessages?: ScheduledMessageCommandService,
): Promise<boolean> {
  const locale = resolveLocale(interaction.locale);
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
  const scheduledInput = ownedScheduledCreate
    ? parseScheduledMessageCreateModalId(interaction.customId)
    : undefined;
  const recurringInput = ownedRecurringCreate
    ? parseRecurringMessageCreateModalId(interaction.customId)
    : undefined;
  const scheduledEditTarget = ownedScheduledEdit
    ? parseScheduledMessageEditModalId(interaction.customId)
    : undefined;
  if (ownedEdit && editTarget === undefined) {
    await interaction.reply(ephemeralReply(translate(locale, "message.editFormExpired")));
    return true;
  }
  if (ownedScheduledCreate && scheduledInput === undefined) {
    await interaction.reply(ephemeralReply(translate(locale, "message.scheduleFormExpired")));
    return true;
  }
  if (ownedRecurringCreate && recurringInput === undefined) {
    await interaction.reply(ephemeralReply(translate(locale, "message.recurringFormExpired")));
    return true;
  }
  if (ownedScheduledEdit && scheduledEditTarget === undefined) {
    await interaction.reply(ephemeralReply(translate(locale, "message.scheduleEditFormExpired")));
    return true;
  }
  if (ownedScheduledEdit) {
    if (!interaction.inGuild() || interaction.channelId === null) {
      await interaction.reply(ephemeralReply(translate(locale, "message.scheduleContext")));
      return true;
    }
    if (!isSupportedTarget(interaction.channel)) {
      await interaction.reply(ephemeralReply(translate(locale, "message.scheduleContext")));
      return true;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
      await interaction.reply(ephemeralReply(translate(locale, "message.managePermission")));
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
          ? createScheduledMessageResultMessage(result, locale)
          : send
            ? sendResultMessage(result, locale)
            : editResultMessage(result, locale),
      ),
    );
    return true;
  }
  if (!interaction.inGuild() || interaction.channelId === null) {
    await interaction.reply(ephemeralReply(translate(locale, "message.context")));
    return true;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (ownedScheduledCreate) {
    if (scheduledInput === undefined) throw new Error("Validated schedule selector is missing");
    if (scheduledMessages === undefined)
      throw new Error("Scheduled message command service is unavailable");
    const result = await scheduledMessages.create({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      schedule: scheduledInput,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(createScheduledMessageResultMessage(result, locale)));
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
    await interaction.editReply(editReply(createRecurringMessageResultMessage(result, locale)));
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
    await interaction.editReply(editReply(scheduledMessageEditResultMessage(result, locale)));
  } else if (send) {
    const result = await service.send({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      actorUserId: interaction.user.id,
      payload: validation.payload,
    });
    await interaction.editReply(editReply(sendResultMessage(result, locale)));
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
    await interaction.editReply(editReply(editResultMessage(result, locale)));
  }
  return true;
}
