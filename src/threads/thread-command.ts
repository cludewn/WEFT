import { resolveLocale, translate, type AppLocale } from "../i18n/translate.js";
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

import type {
  AutomaticCloseThreadMaintenanceFailureCode,
  AutomaticCloseThreadMaintenanceService,
  AutomaticCloseThreadStatusView,
  TrackAutomaticCloseThreadCommandResult,
} from "./automatic-close-thread-maintenance.js";
import { formatAutoCloseInactivitySeconds } from "../guild/guild-settings.js";
import { OperationTimeoutError, withTimeout } from "../operation-timeout.js";
import type {
  ScheduledThreadCloseCommandResult,
  ScheduledThreadCloseCommandService,
} from "./scheduled-thread-close-command.js";
import type { ThreadFailureCode, ThreadLifecycleService } from "./thread-lifecycle.js";

export const threadCommandDefinition = new SlashCommandBuilder()
  .setName("thread")
  .setDescription(translate("en-US", "command.thread.description"))
  .setDescriptionLocalization("ja", translate("ja", "command.thread.description"))
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageThreads)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("bulk-close")
      .setDescription(translate("en-US", "command.thread.bulk-close.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.bulk-close.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("close")
      .setDescription(translate("en-US", "command.thread.close.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.close.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("open")
      .setDescription(translate("en-US", "command.thread.open.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.open.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("close-after")
      .setDescription(translate("en-US", "command.thread.close-after.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.close-after.description"))
      .addStringOption((option) =>
        option
          .setName("after")
          .setDescription(translate("en-US", "command.thread.close-after.after.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.thread.close-after.after.description"),
          )
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("cancel-close")
      .setDescription(translate("en-US", "command.thread.cancel-close.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.cancel-close.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("track")
      .setDescription(translate("en-US", "command.thread.track.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.track.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("untrack")
      .setDescription(translate("en-US", "command.thread.untrack.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.untrack.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status")
      .setDescription(translate("en-US", "command.thread.status.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.thread.status.description")),
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

function failureMessage(code: ThreadFailureCode, locale: AppLocale = "en-US"): string {
  if (
    code === "STATE_WRITE_OUTCOME_UNKNOWN" ||
    code === "AUDIT_WRITE_OUTCOME_UNKNOWN" ||
    code === "DISCORD_RECONCILIATION_UNCONFIRMED"
  ) {
    return translate(locale, "thread.unconfirmed");
  }
  if (code === "ACTOR_PERMISSION_MISSING") {
    return translate(locale, "thread.actorPermission");
  }
  if (code === "BOT_PERMISSION_MISSING") {
    return translate(locale, "thread.botPermission");
  }
  if (code === "UNSUPPORTED_CONTEXT" || code === "THREAD_NOT_ACTIVE") {
    return translate(locale, "thread.activeContext");
  }
  if (code === "THREAD_LOCKED") {
    return translate(locale, "thread.locked");
  }
  if (code === "INVALID_THREAD_NAME") {
    return translate(locale, "thread.invalidName");
  }
  return translate(locale, "thread.failed");
}

type ThreadCommandOperation =
  "CLOSE" | "OPEN" | "CLOSE_AFTER" | "CANCEL_CLOSE" | "TRACK" | "UNTRACK" | "STATUS";
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
  automaticCloseMaintenance: AutomaticCloseThreadMaintenanceService,
  logger: Pick<Logger, "debug" | "warn">,
  timeoutMs = DEFAULT_INTERACTION_IO_TIMEOUT_MS,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  if (!interaction.inGuild() || interaction.channelId === null) {
    const subcommand = interaction.options.getSubcommand();
    const response =
      subcommand === "track" || subcommand === "untrack" || subcommand === "status"
        ? translate(locale, "thread.context")
        : translate(locale, "thread.activeContext");
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
    subcommand !== "cancel-close" &&
    subcommand !== "track" &&
    subcommand !== "untrack" &&
    subcommand !== "status"
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
          : subcommand === "cancel-close"
            ? "CANCEL_CLOSE"
            : subcommand === "track"
              ? "TRACK"
              : subcommand === "untrack"
                ? "UNTRACK"
                : "STATUS";
  const initialContent =
    operation === "CLOSE"
      ? translate(locale, "thread.closing")
      : operation === "OPEN"
        ? translate(locale, "thread.opening")
        : operation === "CLOSE_AFTER"
          ? translate(locale, "thread.scheduling")
          : operation === "CANCEL_CLOSE"
            ? translate(locale, "thread.cancelling")
            : operation === "TRACK"
              ? translate(locale, "thread.tracking")
              : operation === "UNTRACK"
                ? translate(locale, "thread.untracking")
                : translate(locale, "thread.loadingStatus");
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
      finalContent = translate(locale, "thread.manualExecuting");
    } else if (manualClose.outcome === "PERSISTENCE_FAILURE") {
      finalContent = translate(locale, "thread.manualCancellationUnknown");
    } else {
      const result = manualClose.result;
      finalContent = result.ok
        ? result.changed
          ? translate(locale, "thread.closed")
          : translate(locale, "thread.alreadyClosed")
        : result.pending
          ? translate(locale, "thread.pending")
          : failureMessage(result.code, locale);
    }
  } else if (subcommand === "open") {
    const result = await lifecycle.open(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = result.ok
      ? result.changed
        ? translate(locale, "thread.opened")
        : translate(locale, "thread.alreadyOpen")
      : result.pending
        ? translate(locale, "thread.pending")
        : failureMessage(result.code, locale);
  } else if (subcommand === "close-after") {
    const scheduleResult = await scheduledThreadClose.schedule(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
      interaction.options.getString("after", true),
    );
    finalContent = scheduledThreadCloseMessage(scheduleResult, locale);
  } else if (subcommand === "cancel-close") {
    const cancellationResult = await scheduledThreadClose.cancel(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = scheduledThreadCloseCancellationMessage(cancellationResult, locale);
  } else if (subcommand === "track") {
    const result = await automaticCloseMaintenance.track(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = trackAutomaticCloseMessage(result, locale);
  } else if (subcommand === "untrack") {
    const result = await automaticCloseMaintenance.untrack(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = result.ok
      ? result.outcome === "EXCLUDED"
        ? translate(locale, "thread.excluded")
        : translate(locale, "thread.alreadyExcluded")
      : automaticCloseMaintenanceFailureMessage(result.code, "UNTRACK", locale);
  } else {
    const result = await automaticCloseMaintenance.status(
      interaction.guildId,
      interaction.channelId,
      interaction.user.id,
    );
    finalContent = result.ok
      ? formatAutomaticCloseThreadStatus(result.status, locale)
      : automaticCloseMaintenanceFailureMessage(result.code, "STATUS", locale);
  }

  await runInteractionBoundary(interaction, logger, operation, "final_response", timeoutMs, () =>
    interaction.editReply(editReply(finalContent)),
  );
}

function trackAutomaticCloseMessage(
  result: TrackAutomaticCloseThreadCommandResult,
  locale: AppLocale = "en-US",
): string {
  if (!result.ok) {
    return automaticCloseMaintenanceFailureMessage(result.code, "TRACK", locale);
  }
  if (result.outcome === "TRACKED") {
    return result.parentEnabled
      ? translate(locale, "thread.trackedEnabled")
      : translate(locale, "thread.trackedDisabled");
  }
  return result.parentEnabled
    ? translate(locale, "thread.alreadyTrackedEnabled")
    : translate(locale, "thread.alreadyTrackedDisabled");
}

function automaticCloseMaintenanceFailureMessage(
  code: AutomaticCloseThreadMaintenanceFailureCode,
  operation: Extract<ThreadCommandOperation, "TRACK" | "UNTRACK" | "STATUS">,
  locale: AppLocale = "en-US",
): string {
  switch (code) {
    case "UNSUPPORTED_CONTEXT":
      return translate(locale, "thread.context");
    case "USER_MISSING_PERMISSION":
      return translate(locale, "thread.actorPermission");
    case "CONTEXT_VALIDATION_FAILURE":
      return translate(locale, "thread.verifyFailed");
    case "UNCONFIRMED":
      return translate(locale, "thread.trackingUnknown");
    case "PERSISTENCE_FAILURE":
      return operation === "STATUS"
        ? translate(locale, "thread.statusFailed")
        : translate(locale, "thread.trackingFailed");
  }
}

export function formatAutomaticCloseThreadStatus(
  status: AutomaticCloseThreadStatusView,
  locale: AppLocale = "en-US",
): string {
  const lastActivity =
    status.lastActivityAt === null
      ? translate(locale, "thread.notRecorded")
      : discordTimestamp(status.lastActivityAt);
  const scheduledClose =
    status.scheduledClose === undefined
      ? translate(locale, "thread.none")
      : status.scheduledClose.status === "EXECUTING"
        ? translate(locale, "thread.executing")
        : discordTimestamp(status.scheduledClose.executeAt);

  return [
    translate(locale, "thread.status.effective", { enabled: status.effectiveEnabled }),
    translate(locale, "thread.status.parentPolicy", { enabled: status.parentEnabled }),
    translate(locale, "thread.status.exclusion", { enabled: status.excluded }),
    translate(locale, "thread.status.inactivity", {
      inactivity: formatAutoCloseInactivitySeconds(status.inactivitySeconds),
    }),
    translate(locale, "thread.status.activity", { when: lastActivity }),
    translate(locale, "thread.status.scheduledClose", { when: scheduledClose }),
    translate(locale, "thread.baselineWarning"),
  ].join("\n");
}

function scheduledThreadCloseCancellationMessage(
  result: Awaited<ReturnType<ScheduledThreadCloseCommandService["cancel"]>>,
  locale: AppLocale = "en-US",
): string {
  if (result.ok) {
    return result.outcome === "CANCELLED"
      ? translate(locale, "thread.schedule.cancelled", { id: result.action.id })
      : translate(locale, "thread.noSchedule");
  }

  switch (result.code) {
    case "EXECUTION_IN_PROGRESS":
      return translate(locale, "thread.cannotCancel");
    case "UNSUPPORTED_CONTEXT":
      return translate(locale, "thread.context");
    case "USER_MISSING_PERMISSION":
      return translate(locale, "thread.actorPermission");
    case "CONTEXT_VALIDATION_FAILURE":
      return translate(locale, "thread.verifyFailed");
    case "PERSISTENCE_FAILURE":
      return translate(locale, "thread.cancelUnknown");
  }
}

function scheduledThreadCloseMessage(
  result: ScheduledThreadCloseCommandResult,
  locale: AppLocale = "en-US",
): string {
  if (result.ok) {
    const timestamp = discordTimestamp(result.action.executeAt);
    if (result.outcome === "CREATED") {
      return translate(locale, "thread.schedule.created", {
        id: result.action.id,
        when: timestamp,
      });
    }
    if (result.outcome === "REPLACED") {
      return translate(locale, "thread.schedule.replaced", {
        id: result.action.id,
        when: timestamp,
      });
    }
    return translate(locale, "thread.schedule.savedPending", {
      id: result.action.id,
      when: timestamp,
    });
  }

  switch (result.code) {
    case "INVALID_DURATION":
      return translate(locale, "thread.invalidDuration");
    case "UNSUPPORTED_CONTEXT":
      return translate(locale, "thread.activeContext");
    case "THREAD_NOT_ACTIVE":
      return translate(locale, "thread.scheduleActiveOnly");
    case "THREAD_LOCKED":
      return translate(locale, "thread.scheduleLocked");
    case "USER_MISSING_PERMISSION":
      return translate(locale, "thread.actorPermission");
    case "BOT_MISSING_PERMISSION":
      return translate(locale, "thread.botPermission");
    case "EXECUTION_IN_PROGRESS":
      return translate(locale, "thread.scheduleExecuting");
    case "CONTEXT_VALIDATION_FAILURE":
      return translate(locale, "thread.scheduleVerifyFailed");
    case "PERSISTENCE_FAILURE":
      return translate(locale, "thread.scheduleUnknown");
  }
}

function discordTimestamp(value: Date): string {
  const seconds = Math.floor(value.getTime() / 1_000);
  return `<t:${seconds}:F> (<t:${seconds}:R>)`;
}
