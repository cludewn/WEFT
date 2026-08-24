import type { ChannelType } from "discord.js";
import type { Logger } from "pino";

import type { AutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import type { GuildSettings, GuildSettingsStore } from "./guild-settings.js";
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
  | { outcome: "ENUMERATION_FAILED" };

export type RemoveParentChannelResult = { outcome: "REMOVED" } | { outcome: "NOT_CONFIGURED" };

export type AutomaticCloseConfigurationService = {
  show: (guildId: string) => Promise<AutomaticCloseConfigurationView>;
  setInactivitySeconds: (guildId: string, seconds: number) => Promise<GuildSettings>;
  setBotMessagesCountAsActivity: (guildId: string, value: boolean) => Promise<GuildSettings>;
  addParentChannel: (guildId: string, parentChannelId: string) => Promise<AddParentChannelResult>;
  removeParentChannel: (
    guildId: string,
    parentChannelId: string,
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
    setInactivitySeconds: (guildId, seconds) =>
      guildSettings.setAutoCloseInactivitySeconds(guildId, seconds),
    setBotMessagesCountAsActivity: (guildId, value) =>
      guildSettings.setAutoCloseBotMessagesCountAsActivity(guildId, value),
    async addParentChannel(guildId, parentChannelId) {
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

      await guildSettings.getOrCreate(guildId);

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
      });

      return result.outcome === "ALREADY_ENABLED"
        ? { outcome: "ALREADY_ENABLED" }
        : { outcome: "ENABLED", baselinesApplied: result.baselinesApplied };
    },
    async removeParentChannel(guildId, parentChannelId) {
      const removed = await schedules.removeParentChannel(guildId, parentChannelId);
      return removed ? { outcome: "REMOVED" } : { outcome: "NOT_CONFIGURED" };
    },
  };
}
