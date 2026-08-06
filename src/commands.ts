import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { ChatInputCommandInteraction } from "discord.js";

import { configCommandDefinition, handleConfigCommand } from "./config-command.js";
import type { GuildSettingsStore } from "./guild-settings.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether WEFT is responding"),
  configCommandDefinition,
].map((command) => command.toJSON());

export type CommandDependencies = {
  guildSettings: GuildSettingsStore;
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

  return false;
}
