import type { Logger } from "pino";

import type { AutoCloseDiscord } from "./automatic-close-configuration.js";
import type {
  AutomaticClosePersistenceStore,
  MissingActivityBaselineCandidate,
} from "./automatic-close-persistence.js";
import { getErrorName } from "./shutdown.js";
import { isSupportedThreadType } from "./thread-discord.js";

export type AutomaticCloseBaselineReconciler = {
  /**
   * Creates missing automatic-close activity baselines for currently active threads.
   *
   * Existing activity rows are never reset or advanced. A guild whose enumeration or batch fails
   * is skipped so the remaining guilds are still reconciled. Guilds without a configured parent
   * channel are never fetched from Discord.
   */
  reconcileMissingBaselines: () => Promise<void>;
};

type Dependencies = {
  persistence: Pick<
    AutomaticClosePersistenceStore,
    "listAllParentChannels" | "initializeMissingActivityBaselines"
  >;
  discord: AutoCloseDiscord;
  logger: Pick<Logger, "info" | "warn">;
};

export function createAutomaticCloseBaselineReconciler({
  persistence,
  discord,
  logger,
}: Dependencies): AutomaticCloseBaselineReconciler {
  return {
    async reconcileMissingBaselines() {
      const configured = await persistence.listAllParentChannels();
      if (configured.length === 0) {
        return;
      }

      const parentsByGuild = new Map<string, Set<string>>();
      for (const { guildId, parentChannelId } of configured) {
        const parents = parentsByGuild.get(guildId) ?? new Set<string>();
        parents.add(parentChannelId);
        parentsByGuild.set(guildId, parents);
      }

      let guildsReconciled = 0;
      let guildsFailed = 0;
      let baselinesInitialized = 0;

      for (const [guildId, parents] of parentsByGuild) {
        let candidates: MissingActivityBaselineCandidate[];
        try {
          const summaries = await discord.fetchActiveThreadSummaries(guildId);
          candidates = summaries.flatMap((summary) => {
            const parentChannelId = summary.parentId;
            if (parentChannelId === null || !parents.has(parentChannelId)) {
              return [];
            }
            if (!isSupportedThreadType(summary.type)) {
              return [];
            }
            return [{ threadId: summary.threadId, parentChannelId }];
          });
        } catch (error) {
          guildsFailed += 1;
          logger.warn(
            {
              event: "automatic_close_baseline_enumeration_failed",
              guildId,
              errorName: getErrorName(error),
            },
            "Automatic close baseline reconciliation could not enumerate active threads",
          );
          continue;
        }

        if (candidates.length === 0) {
          guildsReconciled += 1;
          continue;
        }

        try {
          // Captured after this guild's enumeration so a slow Discord response cannot shorten the
          // grace period given to its threads.
          baselinesInitialized += await persistence.initializeMissingActivityBaselines({
            guildId,
            baselineAt: new Date(),
            candidates,
          });
          guildsReconciled += 1;
        } catch (error) {
          guildsFailed += 1;
          logger.warn(
            {
              event: "automatic_close_baseline_initialization_failed",
              guildId,
              errorName: getErrorName(error),
            },
            "Automatic close baseline reconciliation could not initialize baselines",
          );
        }
      }

      logger.info(
        {
          event: "automatic_close_baseline_reconciliation_completed",
          guildsConfigured: parentsByGuild.size,
          guildsReconciled,
          guildsFailed,
          baselinesInitialized,
        },
        "Automatic close baseline reconciliation completed",
      );
    },
  };
}
