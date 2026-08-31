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
  type ManagedMessageSendResult,
  type ManagedMessageService,
  validateManagedMessageContent,
} from "./managed-message.js";

export const MANAGED_MESSAGE_SEND_MODAL_ID = "managed-message:send";
export const MANAGED_MESSAGE_CONTENT_INPUT_ID = "managed-message:content";

export const messageCommandDefinition = new SlashCommandBuilder()
  .setName("message")
  .setDescription("Manage messages sent by WEFT")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addSubcommand((subcommand) =>
    subcommand.setName("send").setDescription("Send a managed message in this channel"),
  );

export function createManagedMessageSendModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(MANAGED_MESSAGE_SEND_MODAL_ID)
    .setTitle("Send managed message")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Message content")
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId(MANAGED_MESSAGE_CONTENT_INPUT_ID)
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(2_000),
        ),
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
  if (channel === null || !isSupportedManagedMessageTargetType(channel.type)) {
    return false;
  }
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
): Promise<void> {
  if (interaction.options.getSubcommand() !== "send") {
    throw new Error("Unsupported message subcommand");
  }
  if (!interaction.inGuild() || !isActiveSupportedTarget(interaction.channel)) {
    await interaction.reply(
      ephemeralReply(
        "Managed messages can only be sent in a supported guild text or active thread channel.",
      ),
    );
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply(
      ephemeralReply("You need the Manage Messages permission to send managed messages."),
    );
    return;
  }
  await interaction.showModal(createManagedMessageSendModal());
}

function resultMessage(result: ManagedMessageSendResult): string {
  if (result.outcome === "SUCCESS") {
    return "Managed message sent.";
  }
  if (result.outcome === "PARTIAL_FAILURE") {
    return `WEFT sent message \`${result.messageId}\`, but could not establish it as managed or confirm its removal. The message may still exist; manual cleanup may be required.`;
  }
  switch (result.code) {
    case "EMPTY_CONTENT":
      return "Message content must contain at least one non-whitespace character.";
    case "CONTENT_TOO_LONG":
      return "Message content must be 2000 characters or fewer.";
    case "UNSUPPORTED_TARGET":
      return "Managed messages can only be sent in a supported guild text or active thread channel.";
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

export async function handleManagedMessageModalSubmit(
  interaction: ModalSubmitInteraction,
  service: ManagedMessageService,
): Promise<boolean> {
  if (interaction.customId !== MANAGED_MESSAGE_SEND_MODAL_ID) {
    return false;
  }

  const content = interaction.fields.getTextInputValue(MANAGED_MESSAGE_CONTENT_INPUT_ID);
  const validation = validateManagedMessageContent(content);
  if (!validation.ok) {
    await interaction.reply(
      ephemeralReply(resultMessage({ outcome: "FAILURE", code: validation.code })),
    );
    return true;
  }
  if (!interaction.inGuild() || interaction.channelId === null) {
    await interaction.reply(
      ephemeralReply(
        "Managed messages can only be sent in a supported guild text or active thread channel.",
      ),
    );
    return true;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await service.send({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    actorUserId: interaction.user.id,
    content: validation.content,
  });
  await interaction.editReply(editReply(resultMessage(result)));
  return true;
}
