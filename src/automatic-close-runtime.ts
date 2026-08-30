import type { Logger } from "pino";

import type { AutomaticCloseExecutor } from "./automatic-close-execution.js";
import type {
  AutomaticCloseCandidate,
  AutomaticCloseCandidateCursor,
  AutomaticClosePersistenceStore,
} from "./automatic-close-persistence.js";
import { getErrorName } from "./shutdown.js";

export const AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS = 300_000;

export type AutomaticCloseRuntime = {
  start: () => Promise<void>;
  sweepOnce: () => Promise<void>;
  stop: () => Promise<void>;
};

type Dependencies = {
  persistence: Pick<AutomaticClosePersistenceStore, "findInactiveCandidatesPage">;
  executor: AutomaticCloseExecutor;
  logger: Pick<Logger, "info" | "warn">;
  now?: () => Date;
};

type SweepStats = {
  pageCount: number;
  candidateCount: number;
  successCount: number;
  changedCount: number;
  skippedCount: number;
  retryableFailureCount: number;
  attemptFailureCount: number;
  unexpectedFailureCount: number;
};

export function createAutomaticCloseRuntime({
  persistence,
  executor,
  logger,
  now = () => new Date(),
}: Dependencies): AutomaticCloseRuntime {
  let started = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;

  const clearPendingTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const runSweep = async (): Promise<void> => {
    const startedAt = Date.now();
    const asOf = now();
    const stats = createSweepStats();
    let cursor: AutomaticCloseCandidateCursor | undefined;

    for (;;) {
      if (stopping) {
        return;
      }

      let page: AutomaticCloseCandidate[];
      try {
        page = await persistence.findInactiveCandidatesPage(
          cursor === undefined ? { asOf } : { asOf, cursor },
        );
      } catch (error) {
        if (stopping) {
          return;
        }
        logger.warn(
          {
            event: "automatic_close_sweep_scan_failed",
            mode: "periodic",
            asOf,
            ...stats,
            durationMs: Date.now() - startedAt,
            errorName: getErrorName(error),
          },
          "Automatic close sweep could not read a candidate page",
        );
        return;
      }

      if (stopping) {
        return;
      }
      if (page.length === 0) {
        if (stats.candidateCount > 0) {
          logger.info(
            {
              event: "automatic_close_sweep_completed",
              mode: "periodic",
              asOf,
              ...stats,
              durationMs: Date.now() - startedAt,
            },
            "Automatic close sweep completed",
          );
        }
        return;
      }

      stats.pageCount += 1;
      for (const candidate of page) {
        if (stopping) {
          return;
        }

        stats.candidateCount += 1;
        try {
          const result = await executor.execute(candidate);
          switch (result.outcome) {
            case "SUCCESS":
              stats.successCount += 1;
              if (result.changed) {
                stats.changedCount += 1;
              }
              break;
            case "SKIPPED":
              stats.skippedCount += 1;
              break;
            case "RETRYABLE_FAILURE":
              stats.retryableFailureCount += 1;
              logger.warn(
                {
                  event: "automatic_close_candidate_execution_failed",
                  guildId: candidate.guildId,
                  threadId: candidate.threadId,
                  parentChannelId: candidate.parentChannelId,
                  outcome: result.outcome,
                  failureCode: result.code,
                },
                "Automatic close candidate execution failed",
              );
              break;
            case "ATTEMPT_FAILURE":
              stats.attemptFailureCount += 1;
              logger.warn(
                {
                  event: "automatic_close_candidate_execution_failed",
                  guildId: candidate.guildId,
                  threadId: candidate.threadId,
                  parentChannelId: candidate.parentChannelId,
                  outcome: result.outcome,
                  failureCode: result.code,
                },
                "Automatic close candidate execution failed",
              );
              break;
          }
        } catch (error) {
          stats.unexpectedFailureCount += 1;
          logger.warn(
            {
              event: "automatic_close_candidate_execution_rejected",
              guildId: candidate.guildId,
              threadId: candidate.threadId,
              parentChannelId: candidate.parentChannelId,
              errorName: getErrorName(error),
            },
            "Automatic close candidate execution rejected unexpectedly",
          );
        }

        if (stopping) {
          return;
        }
      }

      const last = page.at(-1)!;
      cursor = {
        lastActivityAt: last.lastActivityAt,
        guildId: last.guildId,
        threadId: last.threadId,
      };
    }
  };

  const scheduleNext = (): void => {
    if (!started || stopping || inFlight !== undefined || timer !== undefined) {
      return;
    }

    const scheduledTimer = setTimeout(() => {
      if (timer !== scheduledTimer) {
        return;
      }
      timer = undefined;
      void sweepOnce();
    }, AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS);
    timer = scheduledTimer;
  };

  const sweepOnce = (): Promise<void> => {
    if (inFlight !== undefined) {
      return inFlight;
    }
    if (stopping) {
      return Promise.resolve();
    }

    if (started) {
      clearPendingTimer();
    }

    const invocation = runSweep();
    inFlight = invocation;
    const releaseInvocation = (): void => {
      if (inFlight === invocation) {
        inFlight = undefined;
        scheduleNext();
      }
    };
    void invocation.then(releaseInvocation, releaseInvocation);
    return invocation;
  };

  return {
    start(): Promise<void> {
      if (stopping) {
        return Promise.reject(new Error("Automatic close runtime has stopped"));
      }
      if (started) {
        return Promise.resolve();
      }

      started = true;
      scheduleNext();
      logger.info(
        {
          event: "automatic_close_runtime_started",
          mode: "periodic",
          intervalMs: AUTOMATIC_CLOSE_SWEEP_INTERVAL_MS,
        },
        "Automatic close runtime started",
      );
      return Promise.resolve();
    },

    sweepOnce,

    stop(): Promise<void> {
      stopping = true;
      clearPendingTimer();
      stopPromise ??= (async () => {
        const startedAt = Date.now();
        await inFlight;
        started = false;
        logger.info(
          {
            event: "automatic_close_runtime_stopped",
            mode: "periodic",
            durationMs: Date.now() - startedAt,
          },
          "Automatic close runtime stopped",
        );
      })();
      return stopPromise;
    },
  };
}

function createSweepStats(): SweepStats {
  return {
    pageCount: 0,
    candidateCount: 0,
    successCount: 0,
    changedCount: 0,
    skippedCount: 0,
    retryableFailureCount: 0,
    attemptFailureCount: 0,
    unexpectedFailureCount: 0,
  };
}
