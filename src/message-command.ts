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

export const MANAGED_MESSAGE_SEND_MODAL_ID = "managed-message:send";
export const MANAGED_MESSAGE_EDIT_MODAL_PREFIX = "managed-message:edit:";
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
const MAX_UNSIGNED_64 = (1n << 64n) - 1n;

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

export async function handleMessageCommand(
  interaction: ChatInputCommandInteraction,
  service: ManagedMessageService,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "send" && subcommand !== "edit")
    throw new Error("Unsupported message subcommand");
  if (!interaction.inGuild() || !isActiveSupportedTarget(interaction.channel)) {
    await interaction.reply(
      ephemeralReply(
        "Managed messages are only supported in a guild text or active thread channel.",
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
): Promise<boolean> {
  const send = interaction.customId === MANAGED_MESSAGE_SEND_MODAL_ID;
  const ownedEdit = interaction.customId.startsWith(MANAGED_MESSAGE_EDIT_MODAL_PREFIX);
  if (!send && !ownedEdit) return false;

  const editTarget = send ? undefined : parseManagedMessageEditModalId(interaction.customId);
  if (!send && editTarget === undefined) {
    await interaction.reply(
      ephemeralReply("This managed-message edit form is invalid or expired."),
    );
    return true;
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
      ephemeralReply(send ? sendResultMessage(result) : editResultMessage(result)),
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
  if (send) {
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
