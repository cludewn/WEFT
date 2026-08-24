import {
  ChannelType,
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

import type {
  AutomaticCloseConfigurationService,
  AutomaticCloseConfigurationView,
} from "./automatic-close-configuration.js";
import {
  formatAutoCloseInactivitySeconds,
  InvalidAutoCloseInactivityInputError,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
  parseAutoCloseInactivityInput,
  type GuildSettingsStore,
} from "./guild-settings.js";

const SUPPORTED_PARENT_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildForum,
] as const;

export const AUTO_CLOSE_PARENT_DISPLAY_LIMIT = 25;

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
  )
  .addSubcommandGroup((group) =>
    group
      .setName("auto-close")
      .setDescription("Configure automatic closing of inactive threads")
      .addSubcommand((subcommand) =>
        subcommand.setName("show").setDescription("Show this guild's automatic close settings"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("inactivity")
          .setDescription("Set how long a thread may stay inactive before it is closed")
          .addStringOption((option) =>
            option
              .setName("value")
              .setDescription("One duration such as 30m, 12h, or 7d")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("bot-messages")
          .setDescription("Set whether bot messages count as thread activity")
          .addBooleanOption((option) =>
            option
              .setName("value")
              .setDescription("Count bot messages as activity")
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add-parent")
          .setDescription("Enable automatic closing for threads under a parent channel")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Text, announcement, or forum channel")
              .setRequired(true)
              .addChannelTypes(...SUPPORTED_PARENT_CHANNEL_TYPES),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove-parent")
          .setDescription("Disable automatic closing for threads under a parent channel")
          .addChannelOption((option) =>
            option.setName("channel").setDescription("Configured parent channel").setRequired(true),
          ),
      ),
  );

const ephemeralReply = (content: string): InteractionReplyOptions => ({
  content,
  flags: MessageFlags.Ephemeral,
  allowedMentions: { parse: [] },
});

const editReply = (content: string): InteractionEditReplyOptions => ({
  content,
  allowedMentions: { parse: [] },
});

function isSupportedParentChannelType(type: ChannelType): boolean {
  return (SUPPORTED_PARENT_CHANNEL_TYPES as readonly ChannelType[]).includes(type);
}

export function formatAutomaticCloseSummary(view: AutomaticCloseConfigurationView): string {
  if (view.parentChannelIds.length === 0) {
    return "Automatic close: disabled (no parent channels)";
  }

  const inactivity = formatAutoCloseInactivitySeconds(view.inactivitySeconds);
  const channelCount = view.parentChannelIds.length;
  const channelLabel = channelCount === 1 ? "parent channel" : "parent channels";
  const botMessages = view.botMessagesCountAsActivity
    ? "bot messages counted"
    : "bot messages ignored";
  return `Automatic close: ${inactivity} inactivity, ${channelCount} ${channelLabel}, ${botMessages}`;
}

export function formatAutomaticCloseDetail(view: AutomaticCloseConfigurationView): string {
  const lines = [
    `Inactivity: ${formatAutoCloseInactivitySeconds(view.inactivitySeconds)}`,
    `Bot messages count as activity: ${view.botMessagesCountAsActivity ? "yes" : "no"}`,
  ];

  if (view.parentChannelIds.length === 0) {
    lines.push("Parent channels: none (automatic close disabled)");
    return lines.join("\n");
  }

  const shown = view.parentChannelIds.slice(0, AUTO_CLOSE_PARENT_DISPLAY_LIMIT);
  const remaining = view.parentChannelIds.length - shown.length;
  const mentions = shown.map((channelId) => `<#${channelId}>`).join(" ");
  lines.push(
    `Parent channels (${view.parentChannelIds.length}): ${mentions}${
      remaining > 0 ? ` ... and ${remaining} more` : ""
    }`,
  );
  return lines.join("\n");
}

export async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
  store: GuildSettingsStore,
  automaticClose: AutomaticCloseConfigurationService,
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

  if (interaction.options.getSubcommandGroup(false) === "auto-close") {
    await handleAutomaticCloseSubcommand(interaction, automaticClose, subcommand);
    return;
  }

  if (subcommand === "show") {
    const [settings, view] = await Promise.all([
      store.getOrCreate(interaction.guildId),
      automaticClose.show(interaction.guildId),
    ]);
    await interaction.reply(
      ephemeralReply(
        `Timezone: ${settings.timezone}\nClosed prefix: ${settings.closedPrefix}\n${formatAutomaticCloseSummary(view)}`,
      ),
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

async function handleAutomaticCloseSubcommand(
  interaction: ChatInputCommandInteraction,
  automaticClose: AutomaticCloseConfigurationService,
  subcommand: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.reply(ephemeralReply("This command can only be used in a guild."));
    return;
  }

  if (subcommand === "show") {
    const view = await automaticClose.show(guildId);
    await interaction.reply(ephemeralReply(formatAutomaticCloseDetail(view)));
    return;
  }

  if (subcommand === "inactivity") {
    let seconds: number;
    try {
      seconds = parseAutoCloseInactivityInput(interaction.options.getString("value", true));
    } catch (error) {
      if (error instanceof InvalidAutoCloseInactivityInputError) {
        await interaction.reply(
          ephemeralReply(
            "Use one duration from 5 minutes through 365 days, such as 30m, 12h, or 7d.",
          ),
        );
        return;
      }
      throw error;
    }

    const settings = await automaticClose.setInactivitySeconds(guildId, seconds);
    await interaction.reply(
      ephemeralReply(
        `Automatic close inactivity set to ${formatAutoCloseInactivitySeconds(settings.autoCloseInactivitySeconds)}.`,
      ),
    );
    return;
  }

  if (subcommand === "bot-messages") {
    const value = interaction.options.getBoolean("value", true);
    const settings = await automaticClose.setBotMessagesCountAsActivity(guildId, value);
    await interaction.reply(
      ephemeralReply(
        settings.autoCloseBotMessagesCountAsActivity
          ? "Bot messages now count as thread activity."
          : "Bot messages no longer count as thread activity.",
      ),
    );
    return;
  }

  if (subcommand === "add-parent") {
    const channel = interaction.options.getChannel("channel", true);
    if (!isSupportedParentChannelType(channel.type)) {
      await interaction.reply(
        ephemeralReply(
          "Automatic close supports text, announcement, and forum channels as parents only.",
        ),
      );
      return;
    }

    await interaction.reply(ephemeralReply("Enabling automatic close for this channel..."));
    const result = await automaticClose.addParentChannel(guildId, channel.id);
    await interaction.editReply(editReply(addParentChannelMessage(result, channel.id)));
    return;
  }

  if (subcommand === "remove-parent") {
    const channel = interaction.options.getChannel("channel", true);
    await automaticClose.removeParentChannel(guildId, channel.id);
    await interaction.reply(ephemeralReply(`Automatic close is not enabled for <#${channel.id}>.`));
    return;
  }

  throw new Error(`Unsupported config auto-close subcommand: ${subcommand}`);
}

function addParentChannelMessage(
  result: Awaited<ReturnType<AutomaticCloseConfigurationService["addParentChannel"]>>,
  parentChannelId: string,
): string {
  if (result.outcome === "ALREADY_ENABLED") {
    return `Automatic close is already enabled for <#${parentChannelId}>.`;
  }
  if (result.outcome === "ENUMERATION_FAILED") {
    return "WEFT could not read this server's active threads, so the channel was not enabled. Please try again later.";
  }
  return result.baselinesApplied === 0
    ? `Automatic close enabled for <#${parentChannelId}>. No active threads needed a new inactivity baseline.`
    : `Automatic close enabled for <#${parentChannelId}>. ${result.baselinesApplied} active ${
        result.baselinesApplied === 1 ? "thread" : "threads"
      } received a new inactivity baseline.`;
}
