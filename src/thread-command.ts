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
import type { Logger } from "pino";

import { OperationTimeoutError, withTimeout } from "./operation-timeout.js";
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

export const DEFAULT_INTERACTION_IO_TIMEOUT_MS = 2_500;

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
  if (
    code === "STATE_WRITE_OUTCOME_UNKNOWN" ||
    code === "DISCORD_RENAME_OUTCOME_UNKNOWN" ||
    code === "DISCORD_ARCHIVE_OUTCOME_UNKNOWN" ||
    code === "AUDIT_WRITE_OUTCOME_UNKNOWN"
  ) {
    return "WEFT could not confirm the final outcome. Check the current thread state before retrying.";
  }
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
  if (code === "DISCORD_MUTATION_PENDING") {
    return "A Discord update is still pending for this thread. Please wait before retrying.";
  }
  if (code === "INVALID_THREAD_NAME") {
    return "The configured closed prefix cannot form a valid thread name.";
  }
  return "WEFT could not update this thread. Please try again.";
}

type ThreadCommandOperation = "CLOSE" | "OPEN";
type InteractionBoundary = "initial_response" | "final_response";

async function runInteractionBoundary<T>(
  interaction: ChatInputCommandInteraction,
  logger: Pick<Logger, "debug" | "warn">,
  operation: ThreadCommandOperation,
  boundary: InteractionBoundary,
  timeoutMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  logger.debug(
    {
      event: "thread_interaction_boundary_started",
      guildId: interaction.guildId,
      threadId: interaction.channelId,
      operation,
      boundary,
    },
    "Thread interaction boundary started",
  );

  try {
    const result = await withTimeout(work(), timeoutMs);
    logger.debug(
      {
        event: "thread_interaction_boundary_completed",
        guildId: interaction.guildId,
        threadId: interaction.channelId,
        operation,
        boundary,
        durationMs: Date.now() - startedAt,
      },
      "Thread interaction boundary completed",
    );
    return result;
  } catch (error) {
    const failureCode =
      error instanceof OperationTimeoutError
        ? boundary === "initial_response"
          ? "INTERACTION_INITIAL_RESPONSE_TIMEOUT"
          : "INTERACTION_FINAL_RESPONSE_OUTCOME_UNKNOWN"
        : boundary === "initial_response"
          ? "INTERACTION_INITIAL_RESPONSE_FAILED"
          : "INTERACTION_FINAL_RESPONSE_FAILED";
    logger.warn(
      {
        event: "thread_interaction_boundary_failed",
        guildId: interaction.guildId,
        threadId: interaction.channelId,
        operation,
        boundary,
        failureCode,
        durationMs: Date.now() - startedAt,
      },
      "Thread interaction boundary failed",
    );
    throw error;
  }
}

export async function handleThreadCommand(
  interaction: ChatInputCommandInteraction,
  lifecycle: ThreadLifecycleService,
  logger: Pick<Logger, "debug" | "warn">,
  timeoutMs = DEFAULT_INTERACTION_IO_TIMEOUT_MS,
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

  const subcommand = interaction.options.getSubcommand();
  if (subcommand !== "close" && subcommand !== "open") {
    throw new Error(`Unsupported thread subcommand: ${subcommand}`);
  }
  const operation: ThreadCommandOperation = subcommand === "close" ? "CLOSE" : "OPEN";
  const initialContent = operation === "CLOSE" ? "Closing thread…" : "Opening thread…";
  await runInteractionBoundary(
    interaction,
    logger,
    operation,
    "initial_response",
    timeoutMs,
    async () => {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(editReply(initialContent));
      } else {
        await interaction.reply(ephemeralReply(initialContent));
      }
    },
  );

  let result: ThreadLifecycleResult;
  let finalContent: string;
  if (subcommand === "close") {
    result = await lifecycle.close(interaction.guildId, interaction.channelId, interaction.user.id);
    finalContent = result.ok
      ? result.changed
        ? "Thread closed."
        : "Thread is already closed."
      : failureMessage(result.code);
  } else {
    result = await lifecycle.open(interaction.guildId, interaction.channelId, interaction.user.id);
    finalContent = result.ok
      ? result.changed
        ? "Thread opened."
        : "Thread is already opened."
      : failureMessage(result.code);
  }

  await runInteractionBoundary(interaction, logger, operation, "final_response", timeoutMs, () =>
    interaction.editReply(editReply(finalContent)),
  );
}
