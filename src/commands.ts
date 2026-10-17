import { InteractionContextType, MessageFlags, SlashCommandBuilder } from "discord.js";

import type { LinkPreviewConfiguration } from "./link-previews/link-preview-configuration.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import { handleBulkCloseCommand } from "./threads/bulk-thread-close-command.js";
import type { BulkCloseService } from "./threads/bulk-thread-close.js";
import type { AuditLogDestinationService } from "./audit/audit-log-destination.js";
import type { AutomaticCloseConfigurationService } from "./threads/automatic-close-configuration.js";
import type { AutomaticCloseThreadMaintenanceService } from "./threads/automatic-close-thread-maintenance.js";
import { configCommandDefinition, handleConfigCommand } from "./guild/config-command.js";
import type { GuildSettingsStore } from "./guild/guild-settings.js";
import { handleMessageCommand, messageCommandDefinition } from "./messages/message-command.js";
import type { ManagedMessageService } from "./messages/managed-message.js";
import type { ScheduledMessageListNavigation } from "./messages/scheduled-message-list.js";
import type { ScheduledMessageCommandService } from "./messages/scheduled-message-command.js";
import type { ScheduledThreadCloseCommandService } from "./threads/scheduled-thread-close-command.js";
import { handleThreadCommand, threadCommandDefinition } from "./threads/thread-command.js";
import type { ThreadLifecycleService } from "./threads/thread-lifecycle.js";

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check whether WEFT is responding")
    .setContexts(InteractionContextType.Guild),
  configCommandDefinition,
  threadCommandDefinition,
  messageCommandDefinition,
].map((command) => command.toJSON());

export type CommandDependencies = {
  bulkClose: BulkCloseService;
  linkPreview: LinkPreviewConfiguration;
  auditLogDestination: AuditLogDestinationService;
  automaticCloseConfiguration: AutomaticCloseConfigurationService;
  automaticCloseMaintenance: AutomaticCloseThreadMaintenanceService;
  guildSettings: GuildSettingsStore;
  managedMessages: ManagedMessageService;
  scheduledMessages: ScheduledMessageCommandService;
  scheduledMessageLists: ScheduledMessageListNavigation;
  scheduledThreadClose: ScheduledThreadCloseCommandService;
  threadLifecycle: ThreadLifecycleService;
  logger: Logger;
};

export async function handleCommand(
  interaction: ChatInputCommandInteraction,
  dependencies: CommandDependencies,
): Promise<boolean> {
  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "Pong!", flags: MessageFlags.Ephemeral });
    return true;
  }

  if (interaction.commandName === "config") {
    await handleConfigCommand(
      interaction,
      dependencies.guildSettings,
      dependencies.automaticCloseConfiguration,
      dependencies.auditLogDestination,
      dependencies.linkPreview,
    );
    return true;
  }

  if (interaction.commandName === "thread") {
    if (interaction.options.getSubcommand() === "bulk-close") {
      await handleBulkCloseCommand(interaction, dependencies.bulkClose);
      return true;
    }
    await handleThreadCommand(
      interaction,
      dependencies.threadLifecycle,
      dependencies.scheduledThreadClose,
      dependencies.automaticCloseMaintenance,
      dependencies.logger,
    );
    return true;
  }

  if (interaction.commandName === "message") {
    await handleMessageCommand(
      interaction,
      dependencies.managedMessages,
      dependencies.scheduledMessages,
      dependencies.scheduledMessageLists,
    );
    return true;
  }

  return false;
}
