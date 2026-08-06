import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

import type { ChatInputCommandInteraction, InteractionReplyOptions } from "discord.js";

import {
  InvalidClosedPrefixError,
  InvalidTimezoneError,
  type GuildSettingsStore,
} from "./guild-settings.js";

export const configCommandDefinition = new SlashCommandBuilder()
  .setName("config")
  .setDescription("View or update WEFT settings for this guild")
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand.setName("show").setDescription("Show this guild's WEFT settings"),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("timezone")
      .setDescription("Set this guild's IANA timezone")
      .addStringOption((option) =>
        option.setName("value").setDescription("IANA timezone, such as UTC").setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("closed-prefix")
      .setDescription("Set the prefix used for closed thread titles")
      .addStringOption((option) =>
        option.setName("value").setDescription("Prefix from 1 to 20 characters").setRequired(true),
      ),
  );

const ephemeralReply = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

export async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
  store: GuildSettingsStore,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeralReply("This command can only be used in a guild."));
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(
      ephemeralReply("You need the Manage Server permission to use this command."),
    );
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "show") {
    const settings = await store.getOrCreate(interaction.guildId);
    await interaction.reply(
      ephemeralReply(`Timezone: ${settings.timezone}\nClosed prefix: ${settings.closedPrefix}`),
    );
    return;
  }

  const value = interaction.options.getString("value", true);

  try {
    if (subcommand === "timezone") {
      const settings = await store.setTimezone(interaction.guildId, value);
      await interaction.reply(ephemeralReply(`Timezone set to ${settings.timezone}.`));
      return;
    }

    if (subcommand === "closed-prefix") {
      const settings = await store.setClosedPrefix(interaction.guildId, value);
      await interaction.reply(ephemeralReply(`Closed prefix set to ${settings.closedPrefix}.`));
      return;
    }
  } catch (error) {
    if (error instanceof InvalidTimezoneError || error instanceof InvalidClosedPrefixError) {
      await interaction.reply(ephemeralReply(error.message));
      return;
    }
    throw error;
  }

  throw new Error(`Unsupported config subcommand: ${subcommand}`);
}
