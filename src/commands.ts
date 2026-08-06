import { MessageFlags, SlashCommandBuilder } from "discord.js";

import type { ChatInputCommandInteraction } from "discord.js";

export const commandDefinitions = [
  new SlashCommandBuilder().setName("ping").setDescription("Check whether WEFT is responding"),
].map((command) => command.toJSON());

export async function handleCommand(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.commandName === "ping") {
    await interaction.reply({ content: "Pong!", flags: MessageFlags.Ephemeral });
    return true;
  }

  return false;
}
