import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type { ScheduledAction } from "./scheduled-action-persistence.js";
import type {
  CancelScheduledThreadCloseResult,
  CreateOrReplaceScheduledThreadCloseResult,
  ScheduledThreadCloseStore,
} from "./scheduled-thread-close-persistence.js";
import type { ScheduledThreadCloseWorkerController } from "./scheduled-thread-close-worker.js";
import type {
  ThreadLifecycleDiscord,
  ThreadLifecycleResult,
  ThreadLifecycleService,
} from "./thread-lifecycle.js";

const MINIMUM_DURATION_MS = 60_000n;
const MAXIMUM_DURATION_MS = 365n * 24n * 60n * 60n * 1_000n;

const UNIT_MILLISECONDS = {
  m: 60_000n,
  h: 60n * 60n * 1_000n,
  d: 24n * 60n * 60n * 1_000n,
} as const;

export class InvalidScheduledThreadCloseDurationError extends Error {
  constructor() {
    super("Duration must be a single value from 1 minute through 365 days");
    this.name = "InvalidScheduledThreadCloseDurationError";
  }
}

export type ParsedScheduledThreadCloseDuration = {
  durationMs: number;
  executeAt: Date;
};

export function parseScheduledThreadCloseDuration(
  input: string,
  now: Date,
): ParsedScheduledThreadCloseDuration {
  const normalized = input.trim().toLowerCase();
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(normalized);
  const nowMs = now.getTime();
  if (match === null || !Number.isSafeInteger(nowMs)) {
    throw new InvalidScheduledThreadCloseDurationError();
  }

  const unit = match[2] as keyof typeof UNIT_MILLISECONDS;
  let durationMs: bigint;
  try {
    durationMs = BigInt(match[1]!) * UNIT_MILLISECONDS[unit];
  } catch {
    throw new InvalidScheduledThreadCloseDurationError();
  }
  if (durationMs < MINIMUM_DURATION_MS || durationMs > MAXIMUM_DURATION_MS) {
    throw new InvalidScheduledThreadCloseDurationError();
  }

  const executeAtMs = BigInt(nowMs) + durationMs;
  if (
    executeAtMs < BigInt(Number.MIN_SAFE_INTEGER) ||
    executeAtMs > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new InvalidScheduledThreadCloseDurationError();
  }
  const executeAt = new Date(Number(executeAtMs));
  if (Number.isNaN(executeAt.getTime())) {
    throw new InvalidScheduledThreadCloseDurationError();
  }

  return { durationMs: Number(durationMs), executeAt };
}

export type ScheduledThreadCloseCommandResult =
  | { ok: true; outcome: "CREATED" | "REPLACED"; action: ScheduledAction }
  | {
      ok: true;
      outcome: "SAVED_DELIVERY_PENDING";
      savedAs: "CREATED" | "REPLACED";
      action: ScheduledAction;
    }
  | {
      ok: false;
      code:
        | "EXECUTION_IN_PROGRESS"
        | "INVALID_DURATION"
        | "UNSUPPORTED_CONTEXT"
        | "THREAD_NOT_ACTIVE"
        | "THREAD_LOCKED"
        | "USER_MISSING_PERMISSION"
        | "BOT_MISSING_PERMISSION"
        | "CONTEXT_VALIDATION_FAILURE"
        | "PERSISTENCE_FAILURE";
    };

export type ScheduledThreadCloseCancellationCommandResult =
  | { ok: true; outcome: "CANCELLED"; action: ScheduledAction }
  | { ok: true; outcome: "NOT_SCHEDULED" }
  | {
      ok: false;
      code:
        | "EXECUTION_IN_PROGRESS"
        | "UNSUPPORTED_CONTEXT"
        | "USER_MISSING_PERMISSION"
        | "CONTEXT_VALIDATION_FAILURE"
        | "PERSISTENCE_FAILURE";
    };

export type ManualThreadCloseCommandResult =
  | { outcome: "LIFECYCLE"; result: ThreadLifecycleResult }
  | { outcome: "EXECUTION_IN_PROGRESS" }
  | { outcome: "PERSISTENCE_FAILURE" };

export type ScheduledThreadCloseCommandService = {
  schedule: (
    guildId: string,
    threadId: string,
    actorId: string,
    after: string,
  ) => Promise<ScheduledThreadCloseCommandResult>;
  cancel: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<ScheduledThreadCloseCancellationCommandResult>;
  closeManually: (
    guildId: string,
    threadId: string,
    actorId: string,
  ) => Promise<ManualThreadCloseCommandResult>;
};

type Dependencies = {
  discord: Pick<ThreadLifecycleDiscord, "fetchThread" | "actorCanManage" | "botCanManage">;
  schedules: Pick<ScheduledThreadCloseStore, "createOrReplace" | "cancel">;
  delivery: Pick<
    ScheduledThreadCloseWorkerController,
    "enqueueScheduledThreadClose" | "hasCreatedOrRetryDelivery"
  >;
  threadLifecycle: Pick<ThreadLifecycleService, "close">;
  logger: Pick<Logger, "warn">;
  now?: () => Date;
  generateId?: () => string;
};

class ScheduledThreadCloseExecutionInProgress extends Error {
  constructor() {
    super("Scheduled thread close execution is in progress");
    this.name = "ScheduledThreadCloseExecutionInProgress";
  }
}

class ScheduledThreadCloseCancellationPersistenceFailure extends Error {
  constructor() {
    super("Scheduled thread close cancellation could not be confirmed");
    this.name = "ScheduledThreadCloseCancellationPersistenceFailure";
  }
}

export function createScheduledThreadCloseCommandService({
  discord,
  schedules,
  delivery,
  threadLifecycle,
  logger,
  now = () => new Date(),
  generateId = randomUUID,
}: Dependencies): ScheduledThreadCloseCommandService {
  const persistCancellation = async (
    guildId: string,
    threadId: string,
    actorId: string,
  ): Promise<CancelScheduledThreadCloseResult> => {
    const auditId = generateId();
    try {
      return await schedules.cancel({ auditId, guildId, threadId, actorId });
    } catch {
      logger.warn(
        {
          event: "scheduled_thread_close_cancellation_failed",
          guildId,
          threadId,
          auditId,
          failureCode: "PERSISTENCE_FAILURE",
        },
        "Scheduled thread close cancellation failed",
      );
      throw new ScheduledThreadCloseCancellationPersistenceFailure();
    }
  };

  return {
    async schedule(guildId, threadId, actorId, after) {
      let executeAt: Date;
      try {
        executeAt = parseScheduledThreadCloseDuration(after, now()).executeAt;
      } catch (error) {
        if (error instanceof InvalidScheduledThreadCloseDurationError) {
          return { ok: false, code: "INVALID_DURATION" };
        }
        return { ok: false, code: "INVALID_DURATION" };
      }

      try {
        const thread = await discord.fetchThread(guildId, threadId);
        if (thread === undefined) {
          return { ok: false, code: "UNSUPPORTED_CONTEXT" };
        }
        if (thread.archived) {
          return { ok: false, code: "THREAD_NOT_ACTIVE" };
        }
        if (thread.locked) {
          return { ok: false, code: "THREAD_LOCKED" };
        }
        if (!(await discord.actorCanManage(guildId, threadId, actorId))) {
          return { ok: false, code: "USER_MISSING_PERMISSION" };
        }
        if (!(await discord.botCanManage(guildId, threadId))) {
          return { ok: false, code: "BOT_MISSING_PERMISSION" };
        }
      } catch {
        return { ok: false, code: "CONTEXT_VALIDATION_FAILURE" };
      }

      let persisted: CreateOrReplaceScheduledThreadCloseResult;
      const scheduledActionId = generateId();
      const auditId = generateId();
      try {
        persisted = await schedules.createOrReplace({
          scheduledActionId,
          auditId,
          guildId,
          threadId,
          actorId,
          executeAt,
        });
      } catch {
        logger.warn(
          {
            event: "scheduled_thread_close_creation_failed",
            guildId,
            threadId,
            scheduledActionId,
            auditId,
            failureCode: "PERSISTENCE_FAILURE",
          },
          "Scheduled thread close creation failed",
        );
        return { ok: false, code: "PERSISTENCE_FAILURE" };
      }

      if (persisted.outcome === "EXECUTION_IN_PROGRESS") {
        return { ok: false, code: "EXECUTION_IN_PROGRESS" };
      }

      try {
        await delivery.enqueueScheduledThreadClose(persisted.action.id, persisted.action.executeAt);
        return { ok: true, outcome: persisted.outcome, action: persisted.action };
      } catch {
        try {
          if (await delivery.hasCreatedOrRetryDelivery(persisted.action.id)) {
            return { ok: true, outcome: persisted.outcome, action: persisted.action };
          }
        } catch {
          // The persisted action remains authoritative and runtime reconciliation can repair it.
        }
      }

      logger.warn(
        {
          event: "scheduled_thread_close_delivery_unconfirmed",
          guildId,
          threadId,
          scheduledActionId: persisted.action.id,
          auditId,
          savedOutcome: persisted.outcome,
        },
        "Scheduled thread close delivery could not be confirmed",
      );
      return {
        ok: true,
        outcome: "SAVED_DELIVERY_PENDING",
        savedAs: persisted.outcome,
        action: persisted.action,
      };
    },
    async cancel(guildId, threadId, actorId) {
      try {
        const thread = await discord.fetchThread(guildId, threadId);
        if (thread === undefined) {
          return { ok: false, code: "UNSUPPORTED_CONTEXT" };
        }
        if (!(await discord.actorCanManage(guildId, threadId, actorId))) {
          return { ok: false, code: "USER_MISSING_PERMISSION" };
        }
      } catch {
        return { ok: false, code: "CONTEXT_VALIDATION_FAILURE" };
      }

      try {
        const result = await persistCancellation(guildId, threadId, actorId);
        if (result.outcome === "EXECUTION_IN_PROGRESS") {
          return { ok: false, code: "EXECUTION_IN_PROGRESS" };
        }
        return result.outcome === "CANCELLED"
          ? { ok: true, outcome: "CANCELLED", action: result.action }
          : { ok: true, outcome: "NOT_SCHEDULED" };
      } catch {
        return { ok: false, code: "PERSISTENCE_FAILURE" };
      }
    },
    async closeManually(guildId, threadId, actorId) {
      try {
        const result = await threadLifecycle.close(guildId, threadId, actorId, async () => {
          const cancellation = await persistCancellation(guildId, threadId, actorId);
          if (cancellation.outcome === "EXECUTION_IN_PROGRESS") {
            throw new ScheduledThreadCloseExecutionInProgress();
          }
        });
        return { outcome: "LIFECYCLE", result };
      } catch (error) {
        if (error instanceof ScheduledThreadCloseExecutionInProgress) {
          return { outcome: "EXECUTION_IN_PROGRESS" };
        }
        if (error instanceof ScheduledThreadCloseCancellationPersistenceFailure) {
          return { outcome: "PERSISTENCE_FAILURE" };
        }
        throw error;
      }
    },
  };
}
