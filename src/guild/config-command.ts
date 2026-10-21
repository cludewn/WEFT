import {
  ChannelType,
  escapeMarkdown,
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
import { resolveLocale, translate, type AppLocale } from "../i18n/translate.js";
import type { LinkPreviewConfiguration } from "../link-previews/link-preview-configuration.js";
import {
  LINK_PREVIEW_MODES,
  isLinkPreviewMode,
  type LinkPreviewMode,
} from "../link-previews/link-preview.js";
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

const LINK_PREVIEW_LABELS: Record<LinkPreviewMode, string> = {
  hybrid: translate("en-US", "linkPreview.mode.hybrid"),
  "public-only": translate("en-US", "linkPreview.mode.public-only"),
  "button-only": translate("en-US", "linkPreview.mode.button-only"),
  off: translate("en-US", "linkPreview.mode.off"),
};

export const configCommandDefinition = new SlashCommandBuilder()
  .setName("config")
  .setDescription(translate("en-US", "command.config.description"))
  .setDescriptionLocalization("ja", translate("ja", "command.config.description"))
  .setContexts(InteractionContextType.Guild)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("show")
      .setDescription(translate("en-US", "command.config.show.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.config.show.description")),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("timezone")
      .setDescription(translate("en-US", "command.config.timezone.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.config.timezone.description"))
      .addStringOption((option) =>
        option
          .setName("value")
          .setDescription(translate("en-US", "command.config.timezone.value.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.timezone.value.description"),
          )
          .setRequired(true),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("closed-prefix")
      .setDescription(translate("en-US", "command.config.closed-prefix.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.config.closed-prefix.description"))
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription(translate("en-US", "command.config.closed-prefix.set.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.closed-prefix.set.description"),
          )
          .addStringOption((option) =>
            option
              .setName("value")
              .setDescription(
                translate("en-US", "command.config.closed-prefix.set.value.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.closed-prefix.set.value.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription(translate("en-US", "command.config.closed-prefix.disable.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.closed-prefix.disable.description"),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("link-preview")
      .setDescription(translate("en-US", "command.linkPreview.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.linkPreview.description"))
      .addSubcommand((sub) =>
        sub
          .setName("show")
          .setDescription(translate("en-US", "command.linkPreview.show.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.linkPreview.show.description"),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("mode")
          .setDescription(translate("en-US", "command.linkPreview.mode.description"))
          .setDescriptionLocalization("ja", translate("ja", "command.linkPreview.mode.description"))
          .addStringOption((option) =>
            option
              .setName("value")
              .setDescription(translate("en-US", "command.linkPreview.value.description"))
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.linkPreview.value.description"),
              )
              .setRequired(true)
              .addChoices(
                ...LINK_PREVIEW_MODES.map((value) => ({
                  name: LINK_PREVIEW_LABELS[value],
                  value,
                  name_localizations: { ja: translate("ja", `linkPreview.mode.${value}`) },
                })),
              ),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("audit-log")
      .setDescription(translate("en-US", "command.config.audit-log.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.config.audit-log.description"))
      .addSubcommand((subcommand) =>
        subcommand
          .setName("show")
          .setDescription(translate("en-US", "command.config.audit-log.show.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.audit-log.show.description"),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("set")
          .setDescription(translate("en-US", "command.config.audit-log.set.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.audit-log.set.description"),
          )
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription(
                translate("en-US", "command.config.audit-log.set.channel.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.audit-log.set.channel.description"),
              )
              .setRequired(true)
              .addChannelTypes(...AUDIT_DESTINATION_CHANNEL_TYPES),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("disable")
          .setDescription(translate("en-US", "command.config.audit-log.disable.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.audit-log.disable.description"),
          ),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("auto-close")
      .setDescription(translate("en-US", "command.config.auto-close.description"))
      .setDescriptionLocalization("ja", translate("ja", "command.config.auto-close.description"))
      .addSubcommand((subcommand) =>
        subcommand
          .setName("show")
          .setDescription(translate("en-US", "command.config.auto-close.show.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.auto-close.show.description"),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("inactivity")
          .setDescription(translate("en-US", "command.config.auto-close.inactivity.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.auto-close.inactivity.description"),
          )
          .addStringOption((option) =>
            option
              .setName("value")
              .setDescription(
                translate("en-US", "command.config.auto-close.inactivity.value.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.auto-close.inactivity.value.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("bot-messages")
          .setDescription(translate("en-US", "command.config.auto-close.bot-messages.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.auto-close.bot-messages.description"),
          )
          .addBooleanOption((option) =>
            option
              .setName("value")
              .setDescription(
                translate("en-US", "command.config.auto-close.bot-messages.value.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.auto-close.bot-messages.value.description"),
              )
              .setRequired(true),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("add-parent")
          .setDescription(translate("en-US", "command.config.auto-close.add-parent.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.auto-close.add-parent.description"),
          )
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription(
                translate("en-US", "command.config.auto-close.add-parent.channel.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.auto-close.add-parent.channel.description"),
              )
              .setRequired(true)
              .addChannelTypes(...SUPPORTED_PARENT_CHANNEL_TYPES),
          ),
      )
      .addSubcommand((subcommand) =>
        subcommand
          .setName("remove-parent")
          .setDescription(translate("en-US", "command.config.auto-close.remove-parent.description"))
          .setDescriptionLocalization(
            "ja",
            translate("ja", "command.config.auto-close.remove-parent.description"),
          )
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription(
                translate("en-US", "command.config.auto-close.remove-parent.channel.description"),
              )
              .setDescriptionLocalization(
                "ja",
                translate("ja", "command.config.auto-close.remove-parent.channel.description"),
              )
              .setRequired(true),
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

export function formatAutomaticCloseSummary(
  view: AutomaticCloseConfigurationView,
  locale: AppLocale = "en-US",
): string {
  if (view.parentChannelIds.length === 0) {
    return translate(locale, "config.autoDisabled", {
      inactivity: formatAutoCloseInactivitySeconds(view.inactivitySeconds),
    });
  }

  const inactivity = formatAutoCloseInactivitySeconds(view.inactivitySeconds);
  const channelCount = view.parentChannelIds.length;
  return translate(locale, "config.autoSummary", {
    inactivity,
    count: channelCount,
    botMessages: view.botMessagesCountAsActivity,
  });
}

export function formatAutomaticCloseDetail(
  view: AutomaticCloseConfigurationView,
  locale: AppLocale = "en-US",
): string {
  const lines = [
    translate(locale, "config.autoThreshold", {
      inactivity: formatAutoCloseInactivitySeconds(view.inactivitySeconds),
    }),
    translate(locale, "config.botActivity", { enabled: view.botMessagesCountAsActivity }),
  ];

  if (view.parentChannelIds.length === 0) {
    lines.push(translate(locale, "config.noParents"));
    return lines.join("\n");
  }

  const shown = view.parentChannelIds.slice(0, AUTO_CLOSE_PARENT_DISPLAY_LIMIT);
  const remaining = view.parentChannelIds.length - shown.length;
  const mentions = shown.map((channelId) => `<#${channelId}>`).join(" ");
  lines.push(
    translate(locale, "config.parents", {
      count: view.parentChannelIds.length,
      mentions,
      remaining,
    }),
  );
  lines.push(translate(locale, "config.exclusionsApply"));
  return lines.join("\n");
}

function configurationText(value: string): string {
  return escapeMarkdown(value.replace(/[\r\n]/g, " "), {
    maskedLink: true,
    heading: true,
    bulletedList: true,
    numberedList: true,
  })
    .replaceAll("<", "\\<")
    .replaceAll(">", "\\>");
}

export async function handleConfigCommand(
  interaction: ChatInputCommandInteraction,
  store: GuildSettingsStore,
  automaticClose: AutomaticCloseConfigurationService,
  auditLogDestination: AuditLogDestinationService,
  linkPreview: LinkPreviewConfiguration,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  if (!interaction.inGuild()) {
    await interaction.reply(ephemeralReply(translate(locale, "context.guild")));
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply(ephemeralReply(translate(locale, "permission.manageGuild")));
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);
  if (group === "link-preview") {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let response: string;
    try {
      if (subcommand === "show") {
        const mode = await linkPreview.show(interaction.guildId);
        response = translate(locale, "linkPreview.show", {
          mode: translate(locale, `linkPreview.mode.${mode}`),
        });
      } else {
        const value = interaction.options.getString("value", true);
        const result = await linkPreview.set(interaction.guildId, interaction.user.id, value);
        response =
          result.outcome === "INVALID"
            ? translate(locale, "config.previewInvalid")
            : result.outcome === "UNCONFIRMED"
              ? translate(locale, "config.previewUnconfirmed")
              : translate(locale, "config.previewChanged", {
                  mode: translate(locale, `linkPreview.mode.${value as LinkPreviewMode}`),
                  unchanged: result.outcome === "NO_CHANGE",
                });
      }
    } catch {
      response = translate(
        locale,
        subcommand === "show" ? "linkPreview.loadFailed" : "config.previewUnconfirmed",
      );
    }
    await interaction.editReply(editReply(response));
    return;
  }

  if (group === "audit-log") {
    await handleAuditLogSubcommand(interaction, auditLogDestination, subcommand);
    return;
  }

  if (group === "auto-close") {
    await handleAutomaticCloseSubcommand(interaction, automaticClose, subcommand);
    return;
  }

  if (group !== null && group !== "closed-prefix") {
    throw new Error(`Unsupported config subcommand group: ${group}`);
  }
  if (group === "closed-prefix" && subcommand !== "set" && subcommand !== "disable") {
    throw new Error(`Unsupported config closed-prefix subcommand: ${subcommand}`);
  }

  if (group === null && subcommand === "show") {
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
        translate(locale, "config.readFailed"),
        error,
      );
    }
    await interaction.editReply(
      editReply(
        translate(locale, "config.show", {
          timezone: configurationText(settings.timezone),
          prefix:
            settings.closedPrefix === ""
              ? translate(locale, "config.disabled")
              : configurationText(settings.closedPrefix),
          audit: formatAuditLogDestination(settings.auditLogChannelId, locale),
          automaticClose: formatAutomaticCloseSummary(view, locale),
          mode: isLinkPreviewMode(settings.linkPreviewMode)
            ? translate(locale, `linkPreview.mode.${settings.linkPreviewMode}`)
            : translate(locale, "config.unknown"),
        }),
      ),
    );
    return;
  }

  if (group === null && subcommand !== "timezone") {
    throw new Error(`Unsupported config subcommand: ${subcommand}`);
  }
  const disabling = group === "closed-prefix" && subcommand === "disable";

  let normalized: string;
  try {
    normalized = disabling
      ? ""
      : subcommand === "timezone"
        ? validateTimezone(interaction.options.getString("value", true))
        : validateClosedPrefix(interaction.options.getString("value", true));
  } catch (error) {
    if (error instanceof InvalidTimezoneError || error instanceof InvalidClosedPrefixError) {
      await interaction.reply(
        ephemeralReply(
          translate(
            locale,
            error instanceof InvalidTimezoneError
              ? "config.invalidTimezone"
              : "config.invalidPrefix",
          ),
        ),
      );
      return;
    }
    throw error;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let response: string;
  try {
    const audit = createConfigurationAuditContext(interaction.user.id);
    const result = disabling
      ? await store.disableClosedPrefix(interaction.guildId, audit)
      : subcommand === "timezone"
        ? await store.setTimezone(interaction.guildId, normalized, audit)
        : await store.setClosedPrefix(interaction.guildId, normalized, audit);
    response =
      result.outcome === "UNCONFIRMED"
        ? translate(locale, "config.changeUnconfirmed")
        : disabling
          ? result.outcome === "NO_CHANGE"
            ? translate(locale, "config.prefixDisabledAlready")
            : translate(locale, "config.prefixDisabled")
          : translate(locale, "config.valueChanged", {
              timezone: subcommand === "timezone",
              value:
                subcommand === "timezone"
                  ? configurationText(result.settings.timezone)
                  : configurationText(result.settings.closedPrefix),
              unchanged: result.outcome === "NO_CHANGE",
            });
  } catch {
    response = translate(locale, "config.changeUnconfirmed");
  }
  // Interaction failure cannot replay or reverse the already completed database operation.
  await interaction.editReply(editReply(response));
}

async function handleAutomaticCloseSubcommand(
  interaction: ChatInputCommandInteraction,
  automaticClose: AutomaticCloseConfigurationService,
  subcommand: string,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.reply(ephemeralReply(translate(locale, "context.guild")));
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
        translate(locale, "config.autoReadFailed"),
        error,
      );
    }
    await interaction.editReply(editReply(formatAutomaticCloseDetail(view, locale)));
    return;
  }

  if (subcommand === "inactivity") {
    let seconds: number;
    try {
      seconds = parseAutoCloseInactivityInput(interaction.options.getString("value", true));
    } catch (error) {
      if (error instanceof InvalidAutoCloseInactivityInputError) {
        await interaction.reply(ephemeralReply(translate(locale, "config.invalidInactivity")));
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
          ? translate(locale, "config.changeUnconfirmed")
          : translate(locale, "config.inactivityChanged", {
              inactivity: formatAutoCloseInactivitySeconds(
                result.settings.autoCloseInactivitySeconds,
              ),
              unchanged: result.outcome === "NO_CHANGE",
            });
    } catch {
      response = translate(locale, "config.changeUnconfirmed");
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
          ? translate(locale, "config.changeUnconfirmed")
          : translate(locale, "config.botActivityChanged", {
              enabled: result.settings.autoCloseBotMessagesCountAsActivity,
              unchanged: result.outcome === "NO_CHANGE",
            });
    } catch {
      response = translate(locale, "config.changeUnconfirmed");
    }
    await interaction.editReply(editReply(response));
    return;
  }

  if (subcommand === "add-parent") {
    const channel = interaction.options.getChannel("channel", true);
    if (!isSupportedParentChannelType(channel.type)) {
      await interaction.reply(ephemeralReply(translate(locale, "config.invalidParent")));
      return;
    }

    await interaction.reply(ephemeralReply(translate(locale, "config.enablingParent")));
    let response: string;
    try {
      const result = await automaticClose.addParentChannel(
        guildId,
        channel.id,
        interaction.user.id,
      );
      response = addParentChannelMessage(result, channel.id, locale);
    } catch {
      response = translate(locale, "config.changeUnconfirmed");
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
          ? translate(locale, "config.changeUnconfirmed")
          : translate(locale, "config.parentRemoved", {
              channelId: channel.id,
              unchanged: result.outcome === "NOT_CONFIGURED",
            });
    } catch {
      response = translate(locale, "config.changeUnconfirmed");
    }
    await interaction.editReply(editReply(response));
    return;
  }

  throw new Error(`Unsupported config auto-close subcommand: ${subcommand}`);
}

function addParentChannelMessage(
  result: Awaited<ReturnType<AutomaticCloseConfigurationService["addParentChannel"]>>,
  parentChannelId: string,
  locale: AppLocale,
): string {
  if (result.outcome === "UNCONFIRMED") return translate(locale, "config.changeUnconfirmed");
  if (result.outcome === "ALREADY_ENABLED") {
    return translate(locale, "config.parentAlreadyEnabled", { channelId: parentChannelId });
  }
  if (result.outcome === "ENUMERATION_FAILED") {
    return translate(locale, "config.enumerationFailed");
  }
  return translate(locale, "config.parentEnabled", {
    channelId: parentChannelId,
    count: result.baselinesApplied,
  });
}

function formatAuditLogDestination(channelId: string | null, locale: AppLocale): string {
  return translate(locale, "config.auditDestination", { channelId });
}

async function handleAuditLogSubcommand(
  interaction: ChatInputCommandInteraction,
  service: AuditLogDestinationService,
  subcommand: string,
): Promise<void> {
  const locale = resolveLocale(interaction.locale);
  const guildId = interaction.guildId;
  if (guildId === null) {
    await interaction.reply(ephemeralReply(translate(locale, "context.guild")));
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
        translate(locale, "config.auditReadFailed"),
        error,
      );
    }
    await interaction.editReply(editReply(formatAuditLogDestination(channelId, locale)));
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (subcommand === "set") {
    const requestedId = interaction.options.getChannel("channel", true).id;
    const result = await service.set(guildId, interaction.user.id, requestedId);
    const message =
      result.outcome === "VALIDATION_FAILED"
        ? translate(locale, "config.auditInvalid")
        : result.outcome === "UNCONFIRMED"
          ? translate(locale, "config.auditUnconfirmed")
          : result.outcome === "NO_CHANGE"
            ? translate(locale, "config.auditChanged", { channelId: requestedId, unchanged: true })
            : translate(locale, "config.auditChanged", {
                channelId: requestedId,
                unchanged: false,
              });
    await interaction.editReply(editReply(message));
    return;
  }
  if (subcommand === "disable") {
    const result = await service.disable(guildId, interaction.user.id);
    const message =
      result.outcome === "CHANGED"
        ? translate(locale, "config.auditDisabled")
        : result.outcome === "NO_CHANGE"
          ? translate(locale, "config.auditAlreadyDisabled")
          : translate(locale, "config.auditUnconfirmed");
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
