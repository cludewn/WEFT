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
  ScheduledThreadCloseCommandResult,
  ScheduledThreadCloseCommandService,
} from "./scheduled-thread-close-command.js";
import type { ThreadFailureCode, ThreadLifecycleService } from "./thread-lifecycle.js";

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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("close-after")
      .setDescription("Schedule a soft-close for the current thread")
      .addStringOption((option) =>
        option
          .setName("after")
          .setDescription("Relative duration such as 30m, 2h, or 7d")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("cancel-close").setDescription("Cancel the scheduled thread close"),
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
  if (code === "STATE_WRITE_OUTCOME_UNKNOWN" || code === "AUDIT_WRITE_OUTCOME_UNKNOWN") {
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
  if (code === "INVALID_THREAD_NAME") {
    return "The configured closed prefix cannot form a valid thread name.";
  }
  return "WEFT could not update this thread. Please try again.";
}

type ThreadCommandOperation = "CLOSE" | "OPEN" | "CLOSE_AFTER" | "CANCEL_CLOSE";
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
  scheduledThreadClose: ScheduledThreadCloseCommandService,
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
  if (
    subcommand !== "close" &&
    subcommand !== "open" &&
    subcommand !== "close-after" &&
    subcommand !== "cancel-close"
  ) {
    throw new Error(`Unsupported thread subcommand: ${subcommand}`);
  }
  const operation: ThreadCommandOperation =
    subcommand === "close"
      ? "CLOSE"
      : subcommand === "open"
        ? "OPEN"
        : subcommand === "close-after"
          ? "CLOSE_AFTER"
          : "CANCEL_CLOSE";
  const initialContent =
    operation === "CLOSE"
      ? "Closing thread…"
      : operation === "OPEN"
        ? "Opening thread…"
        : operation === "CLOSE_AFTER"
          ? "Scheduling thread close…"
          : "Cancelling scheduled thread close…";
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

  let finalContent: string;
  if (subcommand === "close") {
    const manualClose = await scheduledThreadClose.closeManually(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    if (manualClose.outcome === "EXECUTION_IN_PROGRESS") {
      finalContent =
        "A scheduled close is already executing for this thread. The manual close was not started.";
    } else if (manualClose.outcome === "PERSISTENCE_FAILURE") {
      finalContent =
        "WEFT could not confirm cancellation of the scheduled close, so the thread was not changed.";
    } else {
      const result = manualClose.result;
      finalContent = result.ok
        ? result.changed
          ? "Thread closed."
          : "Thread is already closed."
        : result.pending
          ? "Discord is still processing this thread update. This can happen when Discord rate-limits thread name changes, and completion may take several minutes."
          : failureMessage(result.code);
    }
  } else if (subcommand === "open") {
    const result = await lifecycle.open(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = result.ok
      ? result.changed
        ? "Thread opened."
        : "Thread is already opened."
      : result.pending
        ? "Discord is still processing this thread update. This can happen when Discord rate-limits thread name changes, and completion may take several minutes."
        : failureMessage(result.code);
  } else if (subcommand === "close-after") {
    const scheduleResult = await scheduledThreadClose.schedule(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      interaction.options.getString("after", true),
    );
    finalContent = scheduledThreadCloseMessage(scheduleResult);
  } else {
    const cancellationResult = await scheduledThreadClose.cancel(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = scheduledThreadCloseCancellationMessage(cancellationResult);
  }

  await runInteractionBoundary(interaction, logger, operation, "final_response", timeoutMs, () =>
    interaction.editReply(editReply(finalContent)),
  );
}

function scheduledThreadCloseCancellationMessage(
  result: Awaited<ReturnType<ScheduledThreadCloseCommandService["cancel"]>>,
): string {
  if (result.ok) {
    return result.outcome === "CANCELLED"
      ? "Scheduled thread close cancelled."
      : "No scheduled close is active for this thread.";
  }

  switch (result.code) {
    case "EXECUTION_IN_PROGRESS":
      return "The scheduled close is already executing and can no longer be cancelled.";
    case "UNSUPPORTED_CONTEXT":
      return "This command can only be used in a supported thread.";
    case "USER_MISSING_PERMISSION":
      return "You need the Manage Threads permission to use this command.";
    case "CONTEXT_VALIDATION_FAILURE":
      return "WEFT could not verify the current thread or your permissions. Please try again later.";
    case "PERSISTENCE_FAILURE":
      return "WEFT could not cancel the scheduled close. Please try again later.";
  }
}

function scheduledThreadCloseMessage(result: ScheduledThreadCloseCommandResult): string {
  if (result.ok) {
    const timestamp = discordTimestamp(result.action.executeAt);
    if (result.outcome === "CREATED") {
      return `Thread close scheduled for ${timestamp}.`;
    }
    if (result.outcome === "REPLACED") {
      return `Scheduled thread close replaced. New close time: ${timestamp}.`;
    }
    return `The scheduled close for ${timestamp} was saved, but WEFT could not confirm its delivery yet. WEFT will reconcile it automatically.`;
  }

  switch (result.code) {
    case "INVALID_DURATION":
      return "Use one duration from 1 minute through 365 days, such as 30m, 2h, or 7d.";
    case "UNSUPPORTED_CONTEXT":
      return "This command can only be used in a supported active thread.";
    case "THREAD_NOT_ACTIVE":
      return "A close can only be scheduled for an active thread.";
    case "THREAD_LOCKED":
      return "A close cannot be scheduled while this thread is locked.";
    case "USER_MISSING_PERMISSION":
      return "You need the Manage Threads permission to use this command.";
    case "BOT_MISSING_PERMISSION":
      return "WEFT cannot manage this thread with its current permissions.";
    case "EXECUTION_IN_PROGRESS":
      return "A scheduled close is already executing for this thread. Try again after it finishes.";
    case "CONTEXT_VALIDATION_FAILURE":
      return "WEFT could not verify the current thread state. Please try again later.";
    case "PERSISTENCE_FAILURE":
      return "WEFT could not save the scheduled close. Please try again later.";
  }
}

function discordTimestamp(value: Date): string {
  const seconds = Math.floor(value.getTime() / 1_000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}
