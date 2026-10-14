import type { ChannelType } from "discord.js";
import type { Logger } from "pino";

import type { AutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import { createConfigurationAuditContext } from "./guild-configuration-audit.js";
import type { GuildSettingsChangeResult, GuildSettingsStore } from "./guild-settings.js";
import { getErrorName } from "./shutdown.js";
import { isSupportedThreadType } from "./thread-discord.js";

/** The minimum thread facts the configuration boundary needs from Discord. */
export type ActiveThreadSummary = {
  threadId: string;
  parentId: string | null;
  type: ChannelType;
};

export type AutoCloseDiscord = {
  fetchActiveThreadSummaries: (guildId: string) => Promise<ActiveThreadSummary[]>;
};

export type AutomaticCloseConfigurationView = {
  inactivitySeconds: number;
  botMessagesCountAsActivity: boolean;
  parentChannelIds: string[];
};

export type AddParentChannelResult =
  | { outcome: "ENABLED"; baselinesApplied: number }
  | { outcome: "ALREADY_ENABLED" }
  | { outcome: "ENUMERATION_FAILED" }
  | { outcome: "UNCONFIRMED" };

export type RemoveParentChannelResult = { outcome: "REMOVED" | "NOT_CONFIGURED" | "UNCONFIRMED" };

export type AutomaticCloseConfigurationService = {
  show: (guildId: string) => Promise<AutomaticCloseConfigurationView>;
  setInactivitySeconds: (
    guildId: string,
    seconds: number,
    actorUserId: string,
  ) => Promise<GuildSettingsChangeResult>;
  setBotMessagesCountAsActivity: (
    guildId: string,
    value: boolean,
    actorUserId: string,
  ) => Promise<GuildSettingsChangeResult>;
  addParentChannel: (
    guildId: string,
    parentChannelId: string,
    actorUserId: string,
  ) => Promise<AddParentChannelResult>;
  removeParentChannel: (
    guildId: string,
    parentChannelId: string,
    actorUserId: string,
  ) => Promise<RemoveParentChannelResult>;
};

type Dependencies = {
  guildSettings: Pick<
    GuildSettingsStore,
    "getOrCreate" | "setAutoCloseInactivitySeconds" | "setAutoCloseBotMessagesCountAsActivity"
  >;
  schedules: Pick<
    AutomaticClosePersistenceStore,
    "listParentChannels" | "enableParentChannelWithBaselines" | "removeParentChannel"
  >;
  discord: AutoCloseDiscord;
  logger: Pick<Logger, "warn">;
};

export function createAutomaticCloseConfigurationService({
  guildSettings,
  schedules,
  discord,
  logger,
}: Dependencies): AutomaticCloseConfigurationService {
  return {
    async show(guildId) {
      const [settings, parentChannelIds] = await Promise.all([
        guildSettings.getOrCreate(guildId),
        schedules.listParentChannels(guildId),
      ]);
      return {
        inactivitySeconds: settings.autoCloseInactivitySeconds,
        botMessagesCountAsActivity: settings.autoCloseBotMessagesCountAsActivity,
        parentChannelIds,
      };
    },
    setInactivitySeconds: (guildId, seconds, actorUserId) =>
      guildSettings.setAutoCloseInactivitySeconds(
        guildId,
        seconds,
        createConfigurationAuditContext(actorUserId),
      ),
    setBotMessagesCountAsActivity: (guildId, value, actorUserId) =>
      guildSettings.setAutoCloseBotMessagesCountAsActivity(
        guildId,
        value,
        createConfigurationAuditContext(actorUserId),
      ),
    async addParentChannel(guildId, parentChannelId, actorUserId) {
      const configured = await schedules.listParentChannels(guildId);
      if (configured.includes(parentChannelId)) {
        // Skip enumeration and leave every existing baseline untouched.
        return { outcome: "ALREADY_ENABLED" };
      }

      let summaries: ActiveThreadSummary[];
      try {
        summaries = await discord.fetchActiveThreadSummaries(guildId);
      } catch (error) {
        logger.warn(
          {
            event: "automatic_close_parent_enumeration_failed",
            guildId,
            parentChannelId,
            errorName: getErrorName(error),
          },
          "Automatic close parent enable could not enumerate active threads",
        );
        return { outcome: "ENUMERATION_FAILED" };
      }

      // Captured after enumeration so a slow Discord response cannot shorten the grace period.
      const enabledAt = new Date();
      const activeThreadIds = summaries
        .filter(
          (summary) => summary.parentId === parentChannelId && isSupportedThreadType(summary.type),
        )
        .map((summary) => summary.threadId);

      const result = await schedules.enableParentChannelWithBaselines({
        guildId,
        parentChannelId,
        enabledAt,
        activeThreadIds,
        ...createConfigurationAuditContext(actorUserId, enabledAt),
      });

      return result;
    },
    async removeParentChannel(guildId, parentChannelId, actorUserId) {
      const result = await schedules.removeParentChannel(
        guildId,
        parentChannelId,
        createConfigurationAuditContext(actorUserId),
      );
      return {
        outcome:
          result.outcome === "UNCONFIRMED"
            ? "UNCONFIRMED"
            : result.outcome === "CHANGED"
              ? "REMOVED"
              : "NOT_CONFIGURED",
      };
    },
  };
}
