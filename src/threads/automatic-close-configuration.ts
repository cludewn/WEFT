import type { AdministrativeAttempt } from "../administrative-transaction.js";
import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
} from "../audit/administrative-operation-failure-audit.js";
import { validateAutoCloseInactivitySeconds } from "../guild/guild-settings.js";
import type { ChannelType } from "discord.js";
import type { Logger } from "pino";

import type { AutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import { createConfigurationAuditContext } from "../guild/guild-configuration-audit.js";
import type { GuildSettingsChangeResult, GuildSettingsStore } from "../guild/guild-settings.js";
import { safeErrorName as getErrorName } from "../application-runtime.js";
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
  failures?: AdministrativeFailureRecorder;
};

export function createAutomaticCloseConfigurationService({
  guildSettings,
  schedules,
  discord,
  logger,
  failures,
}: Dependencies): AutomaticCloseConfigurationService {
  return {
    async show(guildId) {
      const reads = [
        Promise.resolve().then(() => guildSettings.getOrCreate(guildId)),
        Promise.resolve().then(() => schedules.listParentChannels(guildId)),
      ] as const;
      let settings;
      let parentChannelIds;
      try {
        [settings, parentChannelIds] = await Promise.all(reads);
      } finally {
        // Preserve the first rejection while retaining every started read through settlement.
        await Promise.allSettled(reads);
      }
      return {
        inactivitySeconds: settings.autoCloseInactivitySeconds,
        botMessagesCountAsActivity: settings.autoCloseBotMessagesCountAsActivity,
        parentChannelIds,
      };
    },
    async setInactivitySeconds(guildId, seconds, actorUserId) {
      validateAutoCloseInactivitySeconds(seconds);
      const context = createConfigurationAuditContext(actorUserId);
      const attempt: AdministrativeAttempt = { operationId: context.auditId };
      const result = await guildSettings.setAutoCloseInactivitySeconds(guildId, seconds, {
        ...context,
        ...(failures ? { administrativeAttempt: attempt } : {}),
      });
      const failure = confirmedAdministrativeDatabaseFailure(attempt);
      if (result.outcome === "UNCONFIRMED" && failure)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_INACTIVITY_SET",
            targetType: "GUILD",
            targetId: guildId,
            ...failure,
          })
          .catch(() => undefined);
      return result;
    },
    async setBotMessagesCountAsActivity(guildId, value, actorUserId) {
      const context = createConfigurationAuditContext(actorUserId);
      const attempt: AdministrativeAttempt = { operationId: context.auditId };
      const result = await guildSettings.setAutoCloseBotMessagesCountAsActivity(guildId, value, {
        ...context,
        ...(failures ? { administrativeAttempt: attempt } : {}),
      });
      const failure = confirmedAdministrativeDatabaseFailure(attempt);
      if (result.outcome === "UNCONFIRMED" && failure)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_BOT_MESSAGES_SET",
            targetType: "GUILD",
            targetId: guildId,
            ...failure,
          })
          .catch(() => undefined);
      return result;
    },
    async addParentChannel(guildId, parentChannelId, actorUserId) {
      const identity = createConfigurationAuditContext(actorUserId);
      const attempt: AdministrativeAttempt = { operationId: identity.auditId };
      let configured: string[];
      try {
        configured = await schedules.listParentChannels(guildId);
      } catch {
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_PARENT_ADD",
            targetType: "PARENT_CHANNEL",
            targetId: parentChannelId,
            failureStage: "DATABASE_READ",
            failureReasonCode: "REQUIRED_STATE_READ_FAILED",
          })
          .catch(() => undefined);
        return { outcome: "UNCONFIRMED" };
      }
      if (configured.includes(parentChannelId)) {
        // Skip enumeration and leave every existing baseline untouched.
        return { outcome: "ALREADY_ENABLED" };
      }

      let summaries: ActiveThreadSummary[];
      try {
        summaries = await discord.fetchActiveThreadSummaries(guildId);
      } catch (error) {
        try {
          logger.warn(
            {
              event: "automatic_close_parent_enumeration_failed",
              guildId,
              parentChannelId,
              errorName: getErrorName(error),
            },
            "Automatic close parent enable could not enumerate active threads",
          );
        } catch {
          /* Logging cannot change the enumeration result. */
        }
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_PARENT_ADD",
            targetType: "PARENT_CHANNEL",
            targetId: parentChannelId,
            failureStage: "DISCORD_ENUMERATION",
            failureReasonCode: "ACTIVE_THREAD_ENUMERATION_FAILED",
          })
          .catch(() => undefined);
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
        actorUserId,
        occurredAt: enabledAt,
        auditId: attempt.operationId,
        ...(failures ? { administrativeAttempt: attempt } : {}),
      });

      const failure = confirmedAdministrativeDatabaseFailure(attempt);
      if (result.outcome === "UNCONFIRMED" && failure)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_PARENT_ADD",
            targetType: "PARENT_CHANNEL",
            targetId: parentChannelId,
            ...failure,
          })
          .catch(() => undefined);
      return result;
    },
    async removeParentChannel(guildId, parentChannelId, actorUserId) {
      const context = createConfigurationAuditContext(actorUserId);
      const attempt: AdministrativeAttempt = { operationId: context.auditId };
      const result = await schedules.removeParentChannel(guildId, parentChannelId, {
        ...context,
        ...(failures ? { administrativeAttempt: attempt } : {}),
      });
      const failure = confirmedAdministrativeDatabaseFailure(attempt);
      if (result.outcome === "UNCONFIRMED" && failure)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUTO_CLOSE_PARENT_REMOVE",
            targetType: "PARENT_CHANNEL",
            targetId: parentChannelId,
            ...failure,
          })
          .catch(() => undefined);
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
