import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";

import { configCommandDefinition, handleConfigCommand } from "./config-command.js";
import type { GuildSettingsStore } from "./guild-settings.js";
import type { ScheduledThreadCloseCommandService } from "./scheduled-thread-close-command.js";
import { handleThreadCommand, threadCommandDefinition } from "./thread-command.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether WEFT is responding"),
  configCommandDefinition,
  threadCommandDefinition,
].map((command) => command.toJSON());

export type CommandDependencies = {
  guildSettings: GuildSettingsStore;
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
    await handleConfigCommand(interaction, dependencies.guildSettings);
    return true;
  }

  if (interaction.commandName === "thread") {
    await handleThreadCommand(
      interaction,
      dependencies.threadLifecycle,
      dependencies.scheduledThreadClose,
      dependencies.logger,
    );
    return true;
  }

  return false;
}
