import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import type {
  ChatInputCommandInteraction,
  InteractionEditReplyOptions,
  InteractionReplyOptions,
} from "discord.js";

import type {
  ThreadFailureCode,
  ThreadLifecycleResult,
  ThreadLifecycleService,
} from "./thread-lifecycle.js";

export const threadCommandDefinition = new SlashCommandBuilder()
  .setName("thread")
  .setDescription("Manage the current Discord thread")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addSubcommand((subcommand) =>
    subcommand.setName("close").setDescription("Soft-close the current thread"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("open").setDescription("Reconcile the current thread as open"),
  );

const ephemeralReply = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

const editReply = (content: string): InteractionEditReplyOptions => ({
  content,
  allowedMentions: { parse: [] },
});

function failureMessage(code: ThreadFailureCode): string {
  if (code === "ACTOR_PERMISSION_MISSING") {
    return "You need the Manage Threads permission to use this command.";
  }
  if (code === "BOT_PERMISSION_MISSING") {
    return "WEFT cannot manage this thread with its current permissions.";
  }
  if (code === "UNSUPPORTED_CONTEXT" || code === "THREAD_NOT_ACTIVE") {
    return "This command can only be used in a supported active thread.";
  }
  if (code === "THREAD_LOCKED") {
    return "A locked thread cannot be soft-closed. Unlock it manually before retrying.";
  }
  if (code === "INVALID_THREAD_NAME") {
    return "The configured closed prefix cannot form a valid thread name.";
  }
  return "WEFT could not update this thread. Please try again.";
}

async function replyWithResult(
  interaction: ChatInputCommandInteraction,
  result: ThreadLifecycleResult,
  operation: "closed" | "opened",
): Promise<void> {
  await interaction.editReply(
    editReply(
      result.ok
        ? result.changed
          ? `Thread ${operation}.`
          : `Thread is already ${operation}.`
        : failureMessage(result.code),
    ),
  );
}

export async function handleThreadCommand(
  interaction: ChatInputCommandInteraction,
  lifecycle: ThreadLifecycleService,
): Promise<void> {
  if (!interaction.inGuild() || interaction.channelId === null) {
    const response = "This command can only be used in a supported active thread.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(editReply(response));
    } else {
      await interaction.reply(ephemeralReply(response));
    }
    return;
  }

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const subcommand = interaction.options.getSubcommand();
  if (subcommand === "close") {
    await replyWithResult(
      interaction,
      await lifecycle.close(interaction.guildId, interaction.channelId, interaction.user.id),
      "closed",
    );
    return;
  }
  if (subcommand === "open") {
    await replyWithResult(
      interaction,
      await lifecycle.open(interaction.guildId, interaction.channelId, interaction.user.id),
      "opened",
    );
    return;
  }

  throw new Error(`Unsupported thread subcommand: ${subcommand}`);
}
