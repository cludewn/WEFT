import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { ChatInputCommandInteraction } from "discord.js";

import { configCommandDefinition, handleConfigCommand } from "./config-command.js";
import type { GuildSettingsStore } from "./guild-settings.js";
import { handleThreadCommand, threadCommandDefinition } from "./thread-command.js";
import type { ThreadLifecycleService } from "./thread-lifecycle.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether WEFT is responding"),
  configCommandDefinition,
  threadCommandDefinition,
].map((command) => command.toJSON());

export type CommandDependencies = {
  guildSettings: GuildSettingsStore;
  threadLifecycle: ThreadLifecycleService;
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
    await handleThreadCommand(interaction, dependencies.threadLifecycle);
    return true;
  }

  return false;
}
