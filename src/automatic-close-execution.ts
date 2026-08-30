import { randomUUID } from "node:crypto";

import type {
  AutomaticCloseCandidate,
  AutomaticClosePersistenceStore,
} from "./automatic-close-persistence.js";
import type { ScheduledActionStore } from "./scheduled-action-persistence.js";
import type { AutomaticCloseExecutionDiscord } from "./thread-discord.js";
import type { ThreadFailureCode, ThreadLifecycleService } from "./thread-lifecycle.js";

export type AutomaticCloseSkipReason =
  | "NOT_CURRENTLY_ELIGIBLE"
  | "EXPLICIT_SCHEDULED_CLOSE"
  | "ALREADY_ARCHIVED"
  | "RESOURCE_UNAVAILABLE"
  | "PARENT_MISMATCH";

export type AutomaticCloseExecutionFailureCode =
  | ThreadFailureCode
  | "DISCORD_INSPECTION_FAILED"
  | "CANDIDATE_REVALIDATION_FAILED"
  | "SCHEDULED_CLOSE_READ_FAILED"
  | "RETIREMENT_WRITE_FAILED"
  | "THREAD_LIFECYCLE_UNEXPECTED_FAILURE";

export type AutomaticCloseExecutionResult =
  | { outcome: "SUCCESS"; changed: boolean }
  | { outcome: "SKIPPED"; reason: AutomaticCloseSkipReason }
  | { outcome: "RETRYABLE_FAILURE"; code: AutomaticCloseExecutionFailureCode }
  | { outcome: "ATTEMPT_FAILURE"; code: ThreadFailureCode };

export type AutomaticCloseExecutor = {
  execute: (candidate: AutomaticCloseCandidate) => Promise<AutomaticCloseExecutionResult>;
};

type Dependencies = {
  discord: AutomaticCloseExecutionDiscord;
  persistence: Pick<
    AutomaticClosePersistenceStore,
    "isCandidateEpisodeEligible" | "retireActivityEpisode"
  >;
  scheduledActions: Pick<ScheduledActionStore, "findCurrentThreadClose">;
  threadLifecycle: Pick<ThreadLifecycleService, "autoCloseAsSystem">;
  now?: () => Date;
  createAuditId?: () => string;
};

/**
 * Executes one provisional automatic-close candidate without owning sweep orchestration.
 *
 * PostgreSQL revalidation and the following Discord lifecycle call cannot be atomic. This keeps
 * that accepted race window small while leaving all Discord mutation and audit behavior inside
 * the existing thread lifecycle service.
 */
export function createAutomaticCloseExecutor({
  discord,
  persistence,
  scheduledActions,
  threadLifecycle,
  now = () => new Date(),
  createAuditId = randomUUID,
}: Dependencies): AutomaticCloseExecutor {
  const retire = async (
    candidate: AutomaticCloseCandidate,
  ): Promise<AutomaticCloseExecutionResult | undefined> => {
    try {
      await persistence.retireActivityEpisode({
        guildId: candidate.guildId,
        threadId: candidate.threadId,
        lastActivityAt: candidate.lastActivityAt,
      });
      return undefined;
    } catch {
      return { outcome: "RETRYABLE_FAILURE", code: "RETIREMENT_WRITE_FAILED" };
    }
  };

  const retireAndSkip = async (
    candidate: AutomaticCloseCandidate,
    reason: Extract<
      AutomaticCloseSkipReason,
      "ALREADY_ARCHIVED" | "RESOURCE_UNAVAILABLE" | "PARENT_MISMATCH"
    >,
  ): Promise<AutomaticCloseExecutionResult> => {
    return (await retire(candidate)) ?? { outcome: "SKIPPED", reason };
  };

  return {
    async execute(candidate) {
      let inspection;
      try {
        inspection = await discord.inspectThread(candidate.guildId, candidate.threadId);
      } catch {
        return { outcome: "RETRYABLE_FAILURE", code: "DISCORD_INSPECTION_FAILED" };
      }

      if (inspection.outcome === "UNAVAILABLE") {
        return retireAndSkip(candidate, "RESOURCE_UNAVAILABLE");
      }
      if (inspection.archived) {
        return retireAndSkip(candidate, "ALREADY_ARCHIVED");
      }
      if (inspection.parentChannelId !== candidate.parentChannelId) {
        return retireAndSkip(candidate, "PARENT_MISMATCH");
      }

      const revalidatedAt = now();
      let eligible: boolean;
      try {
        eligible = await persistence.isCandidateEpisodeEligible({
          guildId: candidate.guildId,
          threadId: candidate.threadId,
          parentChannelId: inspection.parentChannelId,
          lastActivityAt: candidate.lastActivityAt,
          revalidatedAt,
        });
      } catch {
        return { outcome: "RETRYABLE_FAILURE", code: "CANDIDATE_REVALIDATION_FAILED" };
      }
      if (!eligible) {
        return { outcome: "SKIPPED", reason: "NOT_CURRENTLY_ELIGIBLE" };
      }

      try {
        if (
          (await scheduledActions.findCurrentThreadClose(candidate.guildId, candidate.threadId)) !==
          undefined
        ) {
          return { outcome: "SKIPPED", reason: "EXPLICIT_SCHEDULED_CLOSE" };
        }
      } catch {
        return { outcome: "RETRYABLE_FAILURE", code: "SCHEDULED_CLOSE_READ_FAILED" };
      }

      let lifecycleResult;
      try {
        lifecycleResult = await threadLifecycle.autoCloseAsSystem(
          candidate.guildId,
          candidate.threadId,
          createAuditId(),
        );
      } catch {
        return {
          outcome: "RETRYABLE_FAILURE",
          code: "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
        };
      }

      if (lifecycleResult.outcome === "SUCCESS") {
        const retirementFailure = await retire(candidate);
        return retirementFailure ?? { outcome: "SUCCESS", changed: lifecycleResult.changed };
      }
      return lifecycleResult.outcome === "RETRYABLE_FAILURE"
        ? { outcome: "RETRYABLE_FAILURE", code: lifecycleResult.code }
        : { outcome: "ATTEMPT_FAILURE", code: lifecycleResult.code };
    },
  };
}
