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

import { createConfigurationAuditContext } from "./guild-configuration-audit.js";
import type { LinkPreviewConfiguration } from "../link-previews/link-preview-configuration.js";
import { LINK_PREVIEW_MODES } from "../link-previews/link-preview.js";
import type { AuditLogDestinationService } from "../audit/audit-log-destination.js";
import type {
  AutomaticCloseConfigurationService,
  AutomaticCloseConfigurationView,
} from "../threads/automatic-close-configuration.js";
import {
  formatAutoCloseInactivitySeconds,
  InvalidAutoCloseInactivityInputError,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
  parseAutoCloseInactivityInput,
  validateTimezone,
  validateClosedPrefix,
  type GuildSettingsStore,
} from "./guild-settings.js";

const AUDIT_DESTINATION_CHANNEL_TYPES = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
] as const;

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
      .setName("link-preview")
      .setDescription("Configure message link previews")
      .addSubcommand((sub) =>
        sub.setName("show").setDescription("Show the message link preview mode"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("mode")
          .setDescription("Set the message link preview mode")
          .addStringOption((option) =>
            option
              .setName("value")
              .setDescription("Preview mode")
              .setRequired(true)
              .addChoices(...LINK_PREVIEW_MODES.map((value) => ({ name: value, value }))),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("audit-log")
      .setDescription("Configure the optional audit log destination")
      .addSubcommand((subcommand) =>
        subcommand.setName("show").setDescription("Show the audit log destination"),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription("Set the audit log destination")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Text or announcement channel")
              .setRequired(true)
              .addChannelTypes(...AUDIT_DESTINATION_CHANNEL_TYPES),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand.setName("disable").setDescription("Disable the audit log destination"),
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
  auditLogDestination: AuditLogDestinationService,
  linkPreview: LinkPreviewConfiguration,
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
  if (interaction.options.getSubcommandGroup(false) === "link-preview") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let response: string;
    try {
      if (subcommand === "show") {
        response = `Link preview mode: ${await linkPreview.show(interaction.guildId)}`;
      } else {
        const value = interaction.options.getString("value", true);
        const result = await linkPreview.set(interaction.guildId, interaction.user.id, value);
        response =
          result.outcome === "INVALID"
            ? "Choose hybrid, public-only, button-only, or off."
            : result.outcome === "UNCONFIRMED"
              ? "WEFT could not confirm the preview mode change. Check the setting before trying again."
              : `Link preview mode: ${value}${result.outcome === "NO_CHANGE" ? " (unchanged)" : ""}`;
      }
    } catch {
      response = "WEFT could not load the preview configuration.";
    }
    await interaction.editReply(editReply(response));
    return;
  }

  if (interaction.options.getSubcommandGroup(false) === "audit-log") {
    await handleAuditLogSubcommand(interaction, auditLogDestination, subcommand);
    return;
  }

  if (interaction.options.getSubcommandGroup(false) === "auto-close") {
    await handleAutomaticCloseSubcommand(interaction, automaticClose, subcommand);
    return;
  }

  if (subcommand === "show") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const reads = [
      Promise.resolve().then(() => store.getOrCreate(interaction.guildId)),
      Promise.resolve().then(() => automaticClose.show(interaction.guildId)),
    ] as const;
    let settings;
    let view;
    try {
      try {
        [settings, view] = await Promise.all(reads);
      } finally {
        await Promise.allSettled(reads);
      }
    } catch (error) {
      return reportConfigurationReadFailure(
        interaction,
        "WEFT could not load the configuration. Please try again later.",
        error,
      );
    }
    await interaction.editReply(
      editReply(
        `Timezone: ${settings.timezone}\nClosed prefix: ${settings.closedPrefix}\n${formatAuditLogDestination(settings.auditLogChannelId)}\n${formatAutomaticCloseSummary(view)}\nLink preview mode: ${settings.linkPreviewMode}`,
      ),
    );
    return;
  }

  if (subcommand !== "timezone" && subcommand !== "closed-prefix") {
    throw new Error(`Unsupported config subcommand: ${subcommand}`);
  }
  const value = interaction.options.getString("value", true);

  let normalized: string;
  try {
    normalized = subcommand === "timezone" ? validateTimezone(value) : validateClosedPrefix(value);
  } catch (error) {
    if (error instanceof InvalidTimezoneError || error instanceof InvalidClosedPrefixError) {
      await interaction.reply(ephemeralReply(error.message));
      return;
    }
    throw error;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let response: string;
  try {
    const audit = createConfigurationAuditContext(interaction.user.id);
    const result =
      subcommand === "timezone"
        ? await store.setTimezone(interaction.guildId, normalized, audit)
        : await store.setClosedPrefix(interaction.guildId, normalized, audit);
    response =
      result.outcome === "UNCONFIRMED"
        ? CONFIGURATION_UNCONFIRMED
        : `${subcommand === "timezone" ? "Timezone" : "Closed prefix"} set to ${subcommand === "timezone" ? result.settings.timezone : result.settings.closedPrefix}.${result.outcome === "NO_CHANGE" ? " (unchanged)" : ""}`;
  } catch {
    response = CONFIGURATION_UNCONFIRMED;
  }
  // Interaction failure cannot replay or reverse the already completed database operation.
  await interaction.editReply(editReply(response));
}

const CONFIGURATION_UNCONFIRMED =
  "WEFT could not confirm the configuration change. Check the setting before trying again.";

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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let view;
    try {
      view = await automaticClose.show(guildId);
    } catch (error) {
      return reportConfigurationReadFailure(
        interaction,
        "WEFT could not load the automatic close configuration. Please try again later.",
        error,
      );
    }
    await interaction.editReply(editReply(formatAutomaticCloseDetail(view)));
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

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let response: string;
    try {
      const result = await automaticClose.setInactivitySeconds(
        guildId,
        seconds,
        interaction.user.id,
      );
      response =
        result.outcome === "UNCONFIRMED"
          ? CONFIGURATION_UNCONFIRMED
          : `Automatic close inactivity set to ${formatAutoCloseInactivitySeconds(result.settings.autoCloseInactivitySeconds)}.${result.outcome === "NO_CHANGE" ? " (unchanged)" : ""}`;
    } catch {
      response = CONFIGURATION_UNCONFIRMED;
    }
    await interaction.editReply(editReply(response));
    return;
  }

  if (subcommand === "bot-messages") {
    const value = interaction.options.getBoolean("value", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let response: string;
    try {
      const result = await automaticClose.setBotMessagesCountAsActivity(
        guildId,
        value,
        interaction.user.id,
      );
      response =
        result.outcome === "UNCONFIRMED"
          ? CONFIGURATION_UNCONFIRMED
          : `${result.settings.autoCloseBotMessagesCountAsActivity ? "Bot messages now count as thread activity." : "Bot messages no longer count as thread activity."}${result.outcome === "NO_CHANGE" ? " (unchanged)" : ""}`;
    } catch {
      response = CONFIGURATION_UNCONFIRMED;
    }
    await interaction.editReply(editReply(response));
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
    let response: string;
    try {
      const result = await automaticClose.addParentChannel(
        guildId,
        channel.id,
        interaction.user.id,
      );
      response = addParentChannelMessage(result, channel.id);
    } catch {
      response = CONFIGURATION_UNCONFIRMED;
    }
    await interaction.editReply(editReply(response));
    return;
  }

  if (subcommand === "remove-parent") {
    const channel = interaction.options.getChannel("channel", true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let response: string;
    try {
      const result = await automaticClose.removeParentChannel(
        guildId,
        channel.id,
        interaction.user.id,
      );
      response =
        result.outcome === "UNCONFIRMED"
          ? CONFIGURATION_UNCONFIRMED
          : `Automatic close is not enabled for <#${channel.id}>.${result.outcome === "NOT_CONFIGURED" ? " (unchanged)" : ""}`;
    } catch {
      response = CONFIGURATION_UNCONFIRMED;
    }
    await interaction.editReply(editReply(response));
    return;
  }

  throw new Error(`Unsupported config auto-close subcommand: ${subcommand}`);
}

function addParentChannelMessage(
  result: Awaited<ReturnType<AutomaticCloseConfigurationService["addParentChannel"]>>,
  parentChannelId: string,
): string {
  if (result.outcome === "UNCONFIRMED") return CONFIGURATION_UNCONFIRMED;
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

function formatAuditLogDestination(channelId: string | null): string {
  return channelId === null ? "Audit log: disabled" : `Audit log: <#${channelId}>`;
}

async function handleAuditLogSubcommand(
  interaction: ChatInputCommandInteraction,
  service: AuditLogDestinationService,
  subcommand: string,
): Promise<void> {
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.reply(ephemeralReply("This command can only be used in a guild."));
    return;
  }
  if (subcommand === "show") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let channelId: string | null;
    try {
      channelId = await service.show(guildId);
    } catch (error) {
      return reportConfigurationReadFailure(
        interaction,
        "WEFT could not load the audit log configuration. Please try again later.",
        error,
      );
    }
    await interaction.editReply(editReply(formatAuditLogDestination(channelId)));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (subcommand === "set") {
    const requestedId = interaction.options.getChannel("channel", true).id;
    const result = await service.set(guildId, interaction.user.id, requestedId);
    const message =
      result.outcome === "VALIDATION_FAILED"
        ? "WEFT cannot use that channel as an audit log destination. Check its type and WEFT's View Channel and Send Messages permissions."
        : result.outcome === "UNCONFIRMED"
          ? "WEFT could not confirm the audit log configuration result. Check the setting before trying again."
          : result.outcome === "NO_CHANGE"
            ? `Audit log destination is already <#${requestedId}>.`
            : `Audit log destination set to <#${requestedId}>.`;
    await interaction.editReply(editReply(message));
    return;
  }
  if (subcommand === "disable") {
    const result = await service.disable(guildId, interaction.user.id);
    const message =
      result.outcome === "CHANGED"
        ? "Audit log destination disabled."
        : result.outcome === "NO_CHANGE"
          ? "Audit log destination is already disabled."
          : "WEFT could not confirm the audit log configuration result. Check the setting before trying again.";
    await interaction.editReply(editReply(message));
    return;
  }
  throw new Error(`Unsupported config audit-log subcommand: ${subcommand}`);
}

async function reportConfigurationReadFailure(
  interaction: ChatInputCommandInteraction,
  message: string,
  error: unknown,
): Promise<never> {
  try {
    await interaction.editReply(editReply(message));
  } catch {
    // Preserve the read error for the dispatcher's bounded operational logging.
  }
  throw error;
}
