import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import type { AutomaticCloseConfigurationService } from "./automatic-close-configuration.js";
import type { AutomaticCloseThreadMaintenanceService } from "./automatic-close-thread-maintenance.js";
import { configCommandDefinition, handleConfigCommand } from "./config-command.js";
import type { GuildSettingsStore } from "./guild-settings.js";
import { handleMessageCommand, messageCommandDefinition } from "./message-command.js";
import type { ManagedMessageService } from "./managed-message.js";
import type { ScheduledThreadCloseCommandService } from "./scheduled-thread-close-command.js";
import { handleThreadCommand, threadCommandDefinition } from "./thread-command.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether WEFT is responding"),
  configCommandDefinition,
  threadCommandDefinition,
  messageCommandDefinition,
].map((command) => command.toJSON());

export type CommandDependencies = {
  automaticCloseConfiguration: AutomaticCloseConfigurationService;
  automaticCloseMaintenance: AutomaticCloseThreadMaintenanceService;
  guildSettings: GuildSettingsStore;
  managedMessages: ManagedMessageService;
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
    );
    return true;
  }

  if (interaction.commandName === "thread") {
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
    await handleMessageCommand(interaction, dependencies.managedMessages);
    return true;
  }

  return false;
}
