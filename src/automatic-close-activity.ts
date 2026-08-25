import type { Logger } from "pino";

import type { AutomaticClosePersistenceStore } from "./automatic-close-persistence.js";
import { getErrorName } from "./shutdown.js";

/** Automatic-close relevant facts extracted from one Discord message event. */
export type MessageActivityEvent = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  occurredAt: Date;
  authorIsBot: boolean;
};

/** Automatic-close relevant facts extracted from one newly observable Discord thread. */
export type ThreadBaselineEvent = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  baselineAt: Date;
};

export type AutomaticCloseActivityService = {
  /**
   * Records qualifying message activity.
   *
   * Never rejects: a persistence failure is reported through a focused warning so a Discord
   * gateway listener cannot be crashed by it. Successful tracking is intentionally silent.
   */
  recordMessageActivity: (event: MessageActivityEvent) => Promise<void>;
  /**
   * Creates the thread's activity baseline when it has none.
   *
   * Never rejects. Existing activity rows are left untouched by the persistence operation.
   */
  initializeThreadBaseline: (event: ThreadBaselineEvent) => Promise<void>;
};

type Dependencies = {
  persistence: Pick<
    AutomaticClosePersistenceStore,
    "recordQualifyingMessageActivity" | "initializeMissingActivityBaselines"
  >;
  logger: Pick<Logger, "warn">;
};

export function createAutomaticCloseActivityService({
  persistence,
  logger,
}: Dependencies): AutomaticCloseActivityService {
  return {
    async recordMessageActivity(event) {
      try {
        await persistence.recordQualifyingMessageActivity(event);
      } catch (error) {
        logger.warn(
          {
            event: "automatic_close_message_activity_failed",
            guildId: event.guildId,
            threadId: event.threadId,
            parentChannelId: event.parentChannelId,
            errorName: getErrorName(error),
          },
          "Automatic close message activity could not be recorded",
        );
      }
    },
    async initializeThreadBaseline(event) {
      try {
        await persistence.initializeMissingActivityBaselines({
          guildId: event.guildId,
          baselineAt: event.baselineAt,
          candidates: [{ threadId: event.threadId, parentChannelId: event.parentChannelId }],
        });
      } catch (error) {
        logger.warn(
          {
            event: "automatic_close_thread_baseline_failed",
            guildId: event.guildId,
            threadId: event.threadId,
            parentChannelId: event.parentChannelId,
            errorName: getErrorName(error),
          },
          "Automatic close thread baseline could not be initialized",
        );
      }
    },
  };
}
