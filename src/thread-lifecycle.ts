import { randomUUID } from "node:crypto";

import type { ChannelType } from "discord.js";
import type { Logger } from "pino";

import type { GuildSettingsStore } from "./guild-settings.js";
import { OperationTimeoutError, withTimeout } from "./operation-timeout.js";
import type {
  ManagedThread,
  ManagedThreadStore,
  ThreadAuditAction,
  ThreadAuditStore,
} from "./thread-persistence.js";

export const DISCORD_THREAD_NAME_LIMIT = 100;
export const DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS = 15_000;
export const DEFAULT_DISCORD_MUTATION_WAIT_MS = 5_000;
const DEFAULT_RECONCILIATION_RETRY_BASE_MS = 1_000;
const DEFAULT_RECONCILIATION_RETRY_MAX_MS = 60_000;

export const THREAD_FAILURE_CODES = [
  "UNSUPPORTED_CONTEXT",
  "THREAD_NOT_ACTIVE",
  "THREAD_LOCKED",
  "ACTOR_PERMISSION_MISSING",
  "BOT_PERMISSION_MISSING",
  "INVALID_THREAD_NAME",
  "DISCORD_FETCH_FAILED",
  "DISCORD_RENAME_FAILED",
  "DISCORD_ARCHIVE_FAILED",
  "SETTINGS_READ_FAILED",
  "STATE_READ_FAILED",
  "STATE_WRITE_FAILED",
  "AUDIT_WRITE_FAILED",
  "DISCORD_FETCH_TIMEOUT",
  "ACTOR_PERMISSION_TIMEOUT",
  "BOT_PERMISSION_TIMEOUT",
  "SETTINGS_READ_TIMEOUT",
  "STATE_READ_TIMEOUT",
  "LIFECYCLE_DEADLINE_EXCEEDED",
  "STATE_WRITE_OUTCOME_UNKNOWN",
  "AUDIT_WRITE_OUTCOME_UNKNOWN",
] as const;
export type ThreadFailureCode = (typeof THREAD_FAILURE_CODES)[number];

export type SupportedThreadType =
  ChannelType.AnnouncementThread | ChannelType.PublicThread | ChannelType.PrivateThread;

export type ThreadSnapshot = {
  guildId: string;
  threadId: string;
  type: SupportedThreadType;
  name: string;
  archived: boolean;
  locked: boolean;
};

export type ThreadLifecycleDiscord = {
  fetchThread: (guildId: string, threadId: string) => Promise<ThreadSnapshot | undefined>;
  actorCanManage: (guildId: string, threadId: string, actorId: string) => Promise<boolean>;
  botCanManage: (guildId: string, threadId: string) => Promise<boolean>;
  renameThread: (guildId: string, threadId: string, name: string) => Promise<void>;
  archiveThread: (guildId: string, threadId: string, name: string) => Promise<void>;
};

export type ThreadLifecycleCompletedResult = { ok: true; changed: boolean };
export type ThreadLifecyclePendingResult = { ok: false; pending: true };
export type ThreadLifecycleFailedResult = {
  ok: false;
  pending?: false;
  code: ThreadFailureCode;
};
export type ThreadLifecycleResult =
  ThreadLifecycleCompletedResult | ThreadLifecyclePendingResult | ThreadLifecycleFailedResult;

export class InvalidThreadNameError extends Error {
  constructor() {
    super("The closed prefix leaves no room for a thread title");
    this.name = "InvalidThreadNameError";
  }
}

export function addClosedPrefix(title: string, prefix: string): string {
  const marker = `${prefix} `;
  if (title.startsWith(marker)) {
    return title;
  }

  const markerLength = [...marker].length;
  const remainingLength = DISCORD_THREAD_NAME_LIMIT - markerLength;
  if (remainingLength < 1) {
    throw new InvalidThreadNameError();
  }

  const truncatedTitle = [...title].slice(0, remainingLength).join("");
  if (truncatedTitle.length === 0) {
    throw new InvalidThreadNameError();
  }
  return `${marker}${truncatedTitle}`;
}

export function removeClosedPrefix(title: string, prefix: string): string {
  const marker = `${prefix} `;
  if (!title.startsWith(marker)) {
    return title;
  }

  const openedTitle = title.slice(marker.length);
  if ([...openedTitle].length === 0) {
    throw new InvalidThreadNameError();
  }
  return openedTitle;
}

type LifecycleDependencies = {
  discord: ThreadLifecycleDiscord;
  guildSettings: GuildSettingsStore;
  managedThreads: ManagedThreadStore;
  audits: ThreadAuditStore;
  logger: Pick<Logger, "debug" | "warn">;
  deadlineMs?: number;
  mutationWaitMs?: number;
  reconciliationRetryBaseMs?: number;
  reconciliationRetryMaxMs?: number;
};

type Actor = { type: "USER"; id: string } | { type: "SYSTEM" };
type LifecycleOperation = "CLOSE" | "OPEN" | "AUTO_OPEN";
type DiscordMutationBoundary = "thread_rename" | "thread_archive";
type BoundaryName =
  | "thread_fetch"
  | "actor_permission_check"
  | "bot_permission_check"
  | "guild_settings_read"
  | "managed_state_read"
  | "managed_state_write"
  | "thread_rename"
  | "thread_archive"
  | "audit_write";

type OperationContext = {
  guildId: string;
  threadId: string;
  operation: LifecycleOperation;
  auditId: string;
  startedAt: number;
  deadlineAt: number;
};

type LifecycleTarget = "CLOSED" | "OPEN";
type QueuedOperation = {
  target: LifecycleTarget;
  result: Promise<ThreadLifecycleResult>;
};

type PendingMutation = {
  generation: number;
  promise: Promise<void>;
};

type CloseMutationIntent = {
  operation: "CLOSE";
  actor: { type: "USER"; id: string };
  appliedPrefix: string;
  intendedName: string;
  auditId: string;
};
type OpenIntent =
  | {
      operation: "OPEN";
      actor: { type: "USER"; id: string };
    }
  | {
      operation: "AUTO_OPEN";
      actor: { type: "SYSTEM" };
    };
type OpenMutationIntent = OpenIntent & {
  appliedPrefix: string;
  intendedName: string;
  auditId: string;
};
type DiscordMutationIntent = CloseMutationIntent | OpenMutationIntent;
type SettledDiscordMutation = {
  generation: number;
  boundary: DiscordMutationBoundary;
  outcome: "resolved" | "rejected";
};
type ManagedFinalState =
  { lifecycleState: "CLOSED"; appliedPrefix: string } | { lifecycleState: "OPEN" };
type FinalizationPlan = {
  managedState: ManagedFinalState;
  auditOutcome: "SUCCESS" | "FAILURE";
  failureCode?: "DISCORD_RENAME_FAILED" | "DISCORD_ARCHIVE_FAILED";
};
type FinalizationJob = {
  generation: number;
  promise: Promise<void>;
};

export class PendingDiscordMutationGuard {
  readonly #pending = new Map<string, PendingMutation>();
  #generation = 0;

  isPending(guildId: string, threadId: string): boolean {
    return this.#pending.has(this.key(guildId, threadId));
  }

  track(guildId: string, threadId: string, promise: Promise<void>): number {
    const key = this.key(guildId, threadId);
    const generation = ++this.#generation;
    this.#pending.set(key, { generation, promise });
    return generation;
  }

  isCurrent(guildId: string, threadId: string, generation: number): boolean {
    return this.#pending.get(this.key(guildId, threadId))?.generation === generation;
  }

  release(guildId: string, threadId: string, generation: number): void {
    const key = this.key(guildId, threadId);
    if (this.#pending.get(key)?.generation === generation) {
      this.#pending.delete(key);
    }
  }

  private key(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
  }
}

export type ThreadLifecycleService = {
  close: (guildId: string, threadId: string, actorId: string) => Promise<ThreadLifecycleResult>;
  open: (guildId: string, threadId: string, actorId: string) => Promise<ThreadLifecycleResult>;
  autoOpen: (guildId: string, threadId: string) => Promise<ThreadLifecycleResult>;
};

class LifecycleFailure extends Error {
  constructor(readonly code: ThreadFailureCode) {
    super(code);
    this.name = "LifecycleFailure";
  }
}

class LifecyclePending extends Error {
  constructor() {
    super("Discord mutation is still pending");
    this.name = "LifecyclePending";
  }
}

export function createThreadLifecycleService(
  dependencies: LifecycleDependencies,
): ThreadLifecycleService {
  const { discord, guildSettings, managedThreads, audits, logger } = dependencies;
  const deadlineMs = dependencies.deadlineMs ?? DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS;
  const mutationWaitMs = dependencies.mutationWaitMs ?? DEFAULT_DISCORD_MUTATION_WAIT_MS;
  const reconciliationRetryBaseMs =
    dependencies.reconciliationRetryBaseMs ?? DEFAULT_RECONCILIATION_RETRY_BASE_MS;
  const reconciliationRetryMaxMs =
    dependencies.reconciliationRetryMaxMs ?? DEFAULT_RECONCILIATION_RETRY_MAX_MS;
  const queuedOperations = new Map<string, QueuedOperation>();
  const pendingMutations = new PendingDiscordMutationGuard();
  const finalizationJobs = new Map<string, FinalizationJob>();
  const deferredAutoOpen = new Set<string>();

  function createContext(
    guildId: string,
    threadId: string,
    operation: LifecycleOperation,
    auditId = randomUUID(),
  ): OperationContext {
    const startedAt = Date.now();
    return {
      guildId,
      threadId,
      operation,
      auditId,
      startedAt,
      deadlineAt: startedAt + deadlineMs,
    };
  }

  function serialize(
    guildId: string,
    threadId: string,
    lifecycleOperation: LifecycleOperation,
    target: LifecycleTarget,
    operation: (
      context: OperationContext,
      precedingChangedSameTarget: boolean,
    ) => Promise<ThreadLifecycleResult>,
  ): Promise<ThreadLifecycleResult> {
    const key = `${guildId}:${threadId}`;
    const preceding = queuedOperations.get(key);
    const result = (async () => {
      let precedingChangedSameTarget = false;
      if (preceding !== undefined) {
        const queuedAt = Date.now();
        logger.debug(
          {
            event: "thread_lifecycle_operation_queued",
            guildId,
            threadId,
            operation: lifecycleOperation,
          },
          "Thread lifecycle operation queued",
        );
        try {
          const precedingResult = await preceding.result;
          precedingChangedSameTarget =
            preceding.target === target && precedingResult.ok && precedingResult.changed;
        } catch {
          precedingChangedSameTarget = false;
        }
        logger.debug(
          {
            event: "thread_lifecycle_queue_wait_completed",
            guildId,
            threadId,
            operation: lifecycleOperation,
            queueWaitDurationMs: Date.now() - queuedAt,
          },
          "Thread lifecycle queue wait completed",
        );
      }
      const context = createContext(guildId, threadId, lifecycleOperation);
      return operation(context, precedingChangedSameTarget);
    })();
    const queued = { target, result };
    queuedOperations.set(key, queued);
    // A caller may return PENDING while settlement handling continues. The mutation guard remains
    // independent of this FIFO entry and prevents another same-thread mutation until finalization.
    void result
      .finally(() => {
        if (queuedOperations.get(key) === queued) {
          queuedOperations.delete(key);
        }
      })
      .catch(() => undefined);
    return result;
  }

  async function runBoundary<T>(
    context: OperationContext,
    boundary: BoundaryName,
    failureCode: ThreadFailureCode,
    timeoutCode: ThreadFailureCode,
    operation: () => Promise<T>,
    timeoutOptions?: { timeoutMs: number; pendingOnTimeout?: boolean },
  ): Promise<T> {
    const startedAt = Date.now();
    logger.debug(
      {
        event: "thread_lifecycle_boundary_started",
        guildId: context.guildId,
        threadId: context.threadId,
        operation: context.operation,
        boundary,
      },
      "Thread lifecycle boundary started",
    );

    const remainingMs = context.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      logger.warn(
        {
          event: "thread_lifecycle_boundary_not_started",
          guildId: context.guildId,
          threadId: context.threadId,
          operation: context.operation,
          boundary,
          failureCode: "LIFECYCLE_DEADLINE_EXCEEDED",
          durationMs: Date.now() - context.startedAt,
        },
        "Thread lifecycle deadline was exhausted before boundary start",
      );
      throw new LifecycleFailure("LIFECYCLE_DEADLINE_EXCEEDED");
    }

    try {
      const boundaryTimeoutMs = Math.min(remainingMs, timeoutOptions?.timeoutMs ?? remainingMs);
      const result = await withTimeout(operation(), boundaryTimeoutMs);
      logger.debug(
        {
          event: "thread_lifecycle_boundary_completed",
          guildId: context.guildId,
          threadId: context.threadId,
          operation: context.operation,
          boundary,
          durationMs: Date.now() - startedAt,
        },
        "Thread lifecycle boundary completed",
      );
      return result;
    } catch (error) {
      if (error instanceof LifecyclePending) {
        throw error;
      }
      if (error instanceof OperationTimeoutError && timeoutOptions?.pendingOnTimeout === true) {
        logger.debug(
          {
            event: "thread_lifecycle_boundary_pending",
            guildId: context.guildId,
            threadId: context.threadId,
            operation: context.operation,
            boundary,
            durationMs: Date.now() - startedAt,
          },
          "Thread lifecycle boundary remains pending",
        );
        throw new LifecyclePending();
      }
      const code =
        error instanceof OperationTimeoutError
          ? timeoutCode
          : error instanceof LifecycleFailure
            ? error.code
            : failureCode;
      logger.warn(
        {
          event: "thread_lifecycle_boundary_failed",
          guildId: context.guildId,
          threadId: context.threadId,
          operation: context.operation,
          boundary,
          failureCode: code,
          durationMs: Date.now() - startedAt,
        },
        "Thread lifecycle boundary failed",
      );
      throw new LifecycleFailure(code);
    }
  }

  async function runDiscordMutation(
    context: OperationContext,
    boundary: DiscordMutationBoundary,
    failureCode: "DISCORD_RENAME_FAILED" | "DISCORD_ARCHIVE_FAILED",
    intent: DiscordMutationIntent,
    operation: () => Promise<void>,
  ): Promise<void> {
    let trackedGeneration: number | undefined;
    let settlement: Promise<"resolved" | "rejected"> | undefined;
    let settlementScheduled = false;
    const scheduleSettlement = (outcome: "resolved" | "rejected"): void => {
      if (settlementScheduled || trackedGeneration === undefined) {
        return;
      }
      settlementScheduled = true;
      void startFinalizationJob(context.guildId, context.threadId, intent, {
        generation: trackedGeneration,
        boundary,
        outcome,
      });
    };

    let settlementOutcome: Awaited<typeof settlement>;
    try {
      settlementOutcome = await runBoundary(
        context,
        boundary,
        failureCode,
        failureCode,
        () => {
          if (pendingMutations.isPending(context.guildId, context.threadId)) {
            throw new LifecyclePending();
          }
          const mutation = Promise.resolve().then(operation);
          trackedGeneration = pendingMutations.track(context.guildId, context.threadId, mutation);
          settlement = mutation.then(
            () => "resolved" as const,
            () => "rejected" as const,
          );
          return settlement;
        },
        { timeoutMs: mutationWaitMs, pendingOnTimeout: true },
      );
    } catch (error) {
      if (error instanceof LifecyclePending && settlement !== undefined) {
        void settlement.then(scheduleSettlement);
      }
      throw error;
    }

    if (settlementOutcome === "rejected") {
      scheduleSettlement("rejected");
      throw new LifecyclePending();
    }
    if (trackedGeneration === undefined) {
      throw new LifecyclePending();
    }
    const finalization = startFinalizationJob(context.guildId, context.threadId, intent, {
      generation: trackedGeneration,
      boundary,
      outcome: "resolved",
    });
    const remainingMs = context.deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw new LifecyclePending();
    }
    try {
      await withTimeout(finalization, remainingMs);
    } catch (error) {
      if (error instanceof OperationTimeoutError) {
        throw new LifecyclePending();
      }
      throw new LifecyclePending();
    }
  }

  function requireNoPendingMutation(context: OperationContext): void {
    if (pendingMutations.isPending(context.guildId, context.threadId)) {
      if (context.operation === "AUTO_OPEN") {
        deferredAutoOpen.add(threadKey(context.guildId, context.threadId));
      }
      throw new LifecyclePending();
    }
  }

  function startFinalizationJob(
    guildId: string,
    threadId: string,
    intent: DiscordMutationIntent,
    settlement: SettledDiscordMutation,
  ): Promise<void> {
    const key = threadKey(guildId, threadId);
    const existing = finalizationJobs.get(key);
    if (existing?.generation === settlement.generation) {
      return existing.promise;
    }
    if (!pendingMutations.isCurrent(guildId, threadId, settlement.generation)) {
      return Promise.resolve();
    }

    logger.debug(
      {
        event: "thread_lifecycle_reconciliation_scheduled",
        guildId,
        threadId,
        operation: intent.operation,
        generation: settlement.generation,
        settlementOutcome: settlement.outcome,
      },
      "Thread lifecycle reconciliation scheduled",
    );
    const promise = runFinalizationJob(guildId, threadId, intent, settlement);
    const job = { generation: settlement.generation, promise };
    finalizationJobs.set(key, job);
    void promise.then(
      () => {
        if (finalizationJobs.get(key) === job) {
          finalizationJobs.delete(key);
          pendingMutations.release(guildId, threadId, settlement.generation);
          scheduleDeferredAutoOpen(guildId, threadId);
        }
      },
      (error: unknown) => {
        logger.warn(
          {
            event: "thread_lifecycle_finalization_unexpected_failure",
            guildId,
            threadId,
            operation: intent.operation,
            generation: settlement.generation,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Thread lifecycle finalization stopped unexpectedly",
        );
      },
    );
    return promise;
  }

  async function runFinalizationJob(
    guildId: string,
    threadId: string,
    intent: DiscordMutationIntent,
    settlement: SettledDiscordMutation,
  ): Promise<void> {
    const plan =
      settlement.outcome === "resolved"
        ? resolvedFinalizationPlan(intent)
        : await rejectedFinalizationPlan(guildId, threadId, intent, settlement);
    await retryBackgroundBoundary(
      guildId,
      threadId,
      intent.operation,
      settlement.generation,
      "managed_state_write",
      () => applyManagedFinalState(guildId, threadId, plan.managedState),
    );
    const auditRecord = {
      id: intent.auditId,
      guildId,
      threadId,
      action: intent.operation,
      actorType: intent.actor.type,
      ...(intent.actor.type === "USER" ? { actorId: intent.actor.id } : {}),
      outcome: plan.auditOutcome,
      ...(plan.failureCode === undefined ? {} : { failureCode: plan.failureCode }),
    } as const;
    await retryBackgroundBoundary(
      guildId,
      threadId,
      intent.operation,
      settlement.generation,
      "audit_write",
      () => audits.record(auditRecord),
    );
  }

  function resolvedFinalizationPlan(intent: DiscordMutationIntent): FinalizationPlan {
    return {
      managedState:
        intent.operation === "CLOSE"
          ? { lifecycleState: "CLOSED", appliedPrefix: intent.appliedPrefix }
          : { lifecycleState: "OPEN" },
      auditOutcome: "SUCCESS",
    };
  }

  async function rejectedFinalizationPlan(
    guildId: string,
    threadId: string,
    intent: DiscordMutationIntent,
    settlement: SettledDiscordMutation,
  ): Promise<FinalizationPlan> {
    const thread = await retryBackgroundBoundary(
      guildId,
      threadId,
      intent.operation,
      settlement.generation,
      "thread_fetch",
      () => discord.fetchThread(guildId, threadId),
    );
    if (thread === undefined) {
      logger.warn(
        {
          event: "thread_lifecycle_reconciliation_resource_unavailable",
          guildId,
          threadId,
          operation: intent.operation,
          generation: settlement.generation,
          failureCode: "UNSUPPORTED_CONTEXT",
        },
        "Thread lifecycle reconciliation cannot confirm the Discord resource",
      );
      return new Promise<never>(() => undefined);
    }
    const intendedStateApplied =
      intent.operation === "CLOSE"
        ? thread.archived && !thread.locked && thread.name === intent.intendedName
        : !thread.archived && thread.name === intent.intendedName;
    const failureCode =
      settlement.boundary === "thread_archive" ? "DISCORD_ARCHIVE_FAILED" : "DISCORD_RENAME_FAILED";
    return {
      managedState: thread.archived
        ? { lifecycleState: "CLOSED", appliedPrefix: intent.appliedPrefix }
        : { lifecycleState: "OPEN" },
      auditOutcome: intendedStateApplied ? "SUCCESS" : "FAILURE",
      ...(intendedStateApplied ? {} : { failureCode }),
    };
  }

  function applyManagedFinalState(
    guildId: string,
    threadId: string,
    state: ManagedFinalState,
  ): Promise<ManagedThread> {
    return state.lifecycleState === "CLOSED"
      ? managedThreads.saveClosed(guildId, threadId, state.appliedPrefix)
      : managedThreads.markOpen(guildId, threadId);
  }

  async function retryBackgroundBoundary<T>(
    guildId: string,
    threadId: string,
    operation: LifecycleOperation,
    generation: number,
    boundary: "thread_fetch" | "managed_state_write" | "audit_write",
    rawOperation: () => Promise<T>,
  ): Promise<T> {
    let retryAttempt = 0;
    for (;;) {
      const startedAt = Date.now();
      logger.debug(
        {
          event: "thread_lifecycle_reconciliation_boundary_started",
          guildId,
          threadId,
          operation,
          generation,
          boundary,
          retryAttempt,
        },
        "Thread lifecycle reconciliation boundary started",
      );
      try {
        const result = await Promise.resolve().then(rawOperation);
        logger.debug(
          {
            event: "thread_lifecycle_reconciliation_boundary_completed",
            guildId,
            threadId,
            operation,
            generation,
            boundary,
            retryAttempt,
            durationMs: Date.now() - startedAt,
          },
          "Thread lifecycle reconciliation boundary completed",
        );
        return result;
      } catch (error) {
        logger.warn(
          {
            event: "thread_lifecycle_reconciliation_boundary_rejected",
            guildId,
            threadId,
            operation,
            generation,
            boundary,
            retryAttempt,
            errorName: error instanceof Error ? error.name : "UnknownError",
            durationMs: Date.now() - startedAt,
          },
          "Thread lifecycle reconciliation boundary rejected",
        );
      }
      retryAttempt += 1;
      const exponentialDelay = reconciliationRetryBaseMs * 2 ** Math.min(retryAttempt - 1, 30);
      const retryDelayMs = Math.min(exponentialDelay, reconciliationRetryMaxMs);
      logger.warn(
        {
          event: "thread_lifecycle_reconciliation_retry_scheduled",
          guildId,
          threadId,
          operation,
          generation,
          boundary,
          retryAttempt,
          retryDelayMs,
        },
        "Thread lifecycle reconciliation will be retried",
      );
      await new Promise<void>((resolve) => {
        const retryTimer = setTimeout(resolve, retryDelayMs);
        retryTimer.unref();
      });
    }
  }

  function scheduleDeferredAutoOpen(guildId: string, threadId: string): void {
    const key = threadKey(guildId, threadId);
    if (!deferredAutoOpen.delete(key)) {
      return;
    }
    void serialize(guildId, threadId, "AUTO_OPEN", "OPEN", (context, precedingChangedSameTarget) =>
      reconcileOpen(
        context,
        { operation: "AUTO_OPEN", actor: { type: "SYSTEM" } },
        precedingChangedSameTarget,
        true,
      ),
    );
  }

  function threadKey(guildId: string, threadId: string): string {
    return `${guildId}:${threadId}`;
  }

  async function audit(
    context: OperationContext,
    action: ThreadAuditAction,
    actor: Actor,
    outcome: "SUCCESS" | "FAILURE",
    failureCode?: ThreadFailureCode,
  ): Promise<void> {
    await runBoundary(
      context,
      "audit_write",
      "AUDIT_WRITE_FAILED",
      "AUDIT_WRITE_OUTCOME_UNKNOWN",
      () =>
        audits.record({
          id: context.auditId,
          guildId: context.guildId,
          threadId: context.threadId,
          action,
          actorType: actor.type,
          ...(actor.type === "USER" ? { actorId: actor.id } : {}),
          outcome,
          ...(failureCode === undefined ? {} : { failureCode }),
        }),
    );
  }

  async function fail(
    context: OperationContext,
    action: ThreadAuditAction,
    actor: Actor,
    error: unknown,
    fallback: ThreadFailureCode,
  ): Promise<ThreadLifecycleResult> {
    if (error instanceof LifecyclePending) {
      logger.debug(
        {
          event: "thread_lifecycle_pending",
          guildId: context.guildId,
          threadId: context.threadId,
          operation: context.operation,
          durationMs: Date.now() - context.startedAt,
        },
        "Thread lifecycle operation remains pending",
      );
      return { ok: false, pending: true };
    }
    const code =
      error instanceof LifecycleFailure
        ? error.code
        : error instanceof InvalidThreadNameError
          ? "INVALID_THREAD_NAME"
          : fallback;
    const outcomeUnknown = isOutcomeUnknown(code);
    logger.warn(
      {
        event: outcomeUnknown ? "thread_lifecycle_outcome_unknown" : "thread_lifecycle_failed",
        guildId: context.guildId,
        threadId: context.threadId,
        operation: context.operation,
        failureCode: code,
        durationMs: Date.now() - context.startedAt,
      },
      outcomeUnknown ? "Thread lifecycle outcome is unknown" : "Thread lifecycle failed",
    );
    if (outcomeUnknown) {
      return { ok: false, code };
    }
    if (code === "AUDIT_WRITE_FAILED") {
      return { ok: false, code };
    }
    try {
      await audit(context, action, actor, "FAILURE", code);
    } catch (auditError) {
      const auditCode =
        auditError instanceof LifecycleFailure ? auditError.code : "AUDIT_WRITE_FAILED";
      if (auditCode === "LIFECYCLE_DEADLINE_EXCEEDED") {
        return { ok: false, code };
      }
      return {
        ok: false,
        code: auditCode,
      };
    }
    return { ok: false, code };
  }

  function isOutcomeUnknown(code: ThreadFailureCode): boolean {
    return code === "STATE_WRITE_OUTCOME_UNKNOWN" || code === "AUDIT_WRITE_OUTCOME_UNKNOWN";
  }

  async function fetchSupported(context: OperationContext): Promise<ThreadSnapshot> {
    const thread = await runBoundary(
      context,
      "thread_fetch",
      "DISCORD_FETCH_FAILED",
      "DISCORD_FETCH_TIMEOUT",
      () => discord.fetchThread(context.guildId, context.threadId),
    );
    if (thread === undefined) {
      throw new LifecycleFailure("UNSUPPORTED_CONTEXT");
    }
    return thread;
  }

  async function requirePermissions(context: OperationContext, actorId?: string): Promise<void> {
    if (actorId !== undefined) {
      const actorCanManage = await runBoundary(
        context,
        "actor_permission_check",
        "ACTOR_PERMISSION_MISSING",
        "ACTOR_PERMISSION_TIMEOUT",
        () => discord.actorCanManage(context.guildId, context.threadId, actorId),
      );
      if (!actorCanManage) {
        throw new LifecycleFailure("ACTOR_PERMISSION_MISSING");
      }
    }
    const botCanManage = await runBoundary(
      context,
      "bot_permission_check",
      "BOT_PERMISSION_MISSING",
      "BOT_PERMISSION_TIMEOUT",
      () => discord.botCanManage(context.guildId, context.threadId),
    );
    if (!botCanManage) {
      throw new LifecycleFailure("BOT_PERMISSION_MISSING");
    }
  }

  async function close(
    context: OperationContext,
    actorId: string,
    precedingChangedSameTarget: boolean,
  ): Promise<ThreadLifecycleResult> {
    const { guildId, threadId } = context;
    const actor = { type: "USER" as const, id: actorId };
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      requireNoPendingMutation(context);
      const initial = await fetchSupported(context);
      if (initial.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(context, actorId);

      fallback = "SETTINGS_READ_FAILED";
      const settings = await runBoundary(
        context,
        "guild_settings_read",
        "SETTINGS_READ_FAILED",
        "SETTINGS_READ_TIMEOUT",
        () => guildSettings.getOrCreate(guildId),
      );
      fallback = "STATE_READ_FAILED";
      const existing = await runBoundary(
        context,
        "managed_state_read",
        "STATE_READ_FAILED",
        "STATE_READ_TIMEOUT",
        () => managedThreads.find(guildId, threadId),
      );
      const appliedPrefix =
        existing?.lifecycleState === "CLOSED" ? existing.appliedPrefix : settings.closedPrefix;

      fallback = "DISCORD_FETCH_FAILED";
      const beforeStateWrite = await fetchSupported(context);
      if (beforeStateWrite.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(context, actorId);
      let changed = existing?.lifecycleState !== "CLOSED" || precedingChangedSameTarget;
      void addClosedPrefix(beforeStateWrite.name, appliedPrefix);

      fallback = "STATE_WRITE_FAILED";
      await runBoundary(
        context,
        "managed_state_write",
        "STATE_WRITE_FAILED",
        "STATE_WRITE_OUTCOME_UNKNOWN",
        () => managedThreads.saveClosed(guildId, threadId, appliedPrefix),
      );

      fallback = "DISCORD_FETCH_FAILED";
      const beforeArchive = await fetchSupported(context);
      if (beforeArchive.locked) {
        throw new LifecycleFailure("THREAD_LOCKED");
      }
      await requirePermissions(context, actorId);
      const closedName = addClosedPrefix(beforeArchive.name, appliedPrefix);
      if (!beforeArchive.archived || closedName !== beforeArchive.name) {
        const mutationIntent: CloseMutationIntent = {
          operation: "CLOSE",
          actor,
          appliedPrefix,
          intendedName: closedName,
          auditId: context.auditId,
        };
        fallback = "DISCORD_ARCHIVE_FAILED";
        await runDiscordMutation(
          context,
          "thread_archive",
          "DISCORD_ARCHIVE_FAILED",
          mutationIntent,
          () => discord.archiveThread(guildId, threadId, closedName),
        );
        changed = true;
        return { ok: true, changed };
      }

      fallback = "AUDIT_WRITE_FAILED";
      await audit(context, "CLOSE", actor, "SUCCESS");
      return { ok: true, changed };
    } catch (error) {
      return fail(context, "CLOSE", actor, error, fallback);
    }
  }

  async function reconcileOpen(
    context: OperationContext,
    intent: OpenIntent,
    precedingChangedSameTarget: boolean,
    ignoreArchived = false,
  ): Promise<ThreadLifecycleResult> {
    const { guildId, threadId } = context;
    const { operation: action, actor } = intent;
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      requireNoPendingMutation(context);
      const initial = await fetchSupported(context);
      if (initial.archived) {
        if (ignoreArchived) {
          return { ok: true, changed: false };
        }
        throw new LifecycleFailure("THREAD_NOT_ACTIVE");
      }

      fallback = "STATE_READ_FAILED";
      const managed = await runBoundary(
        context,
        "managed_state_read",
        "STATE_READ_FAILED",
        "STATE_READ_TIMEOUT",
        () => managedThreads.find(guildId, threadId),
      );
      if (managed === undefined) {
        if (action === "OPEN") {
          await requirePermissions(context, actor.type === "USER" ? actor.id : undefined);
          fallback = "AUDIT_WRITE_FAILED";
          await audit(context, action, actor, "SUCCESS");
        }
        return { ok: true, changed: precedingChangedSameTarget };
      }

      await requirePermissions(context, actor.type === "USER" ? actor.id : undefined);
      return await completeOpen(context, managed, intent, precedingChangedSameTarget);
    } catch (error) {
      return fail(context, action, actor, error, fallback);
    }
  }

  async function completeOpen(
    context: OperationContext,
    managed: ManagedThread,
    intent: OpenIntent,
    precedingChangedSameTarget: boolean,
  ): Promise<ThreadLifecycleResult> {
    const { operation: action, actor } = intent;
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      const beforeRename = await fetchSupported(context);
      if (beforeRename.archived) {
        throw new LifecycleFailure("THREAD_NOT_ACTIVE");
      }
      await requirePermissions(context, actor.type === "USER" ? actor.id : undefined);

      let changed = precedingChangedSameTarget;
      const openedName = removeClosedPrefix(beforeRename.name, managed.appliedPrefix);
      if (openedName !== beforeRename.name) {
        const mutationIntent: OpenMutationIntent = {
          ...intent,
          appliedPrefix: managed.appliedPrefix,
          intendedName: openedName,
          auditId: context.auditId,
        };
        fallback = "DISCORD_RENAME_FAILED";
        await runDiscordMutation(
          context,
          "thread_rename",
          "DISCORD_RENAME_FAILED",
          mutationIntent,
          () => discord.renameThread(context.guildId, context.threadId, openedName),
        );
        changed = true;
        return { ok: true, changed };
      }

      if (managed.lifecycleState === "CLOSED") {
        fallback = "STATE_WRITE_FAILED";
        await runBoundary(
          context,
          "managed_state_write",
          "STATE_WRITE_FAILED",
          "STATE_WRITE_OUTCOME_UNKNOWN",
          () => managedThreads.markOpen(context.guildId, context.threadId),
        );
        changed = true;
      }
      if (action === "AUTO_OPEN" && !changed) {
        return { ok: true, changed: false };
      }
      fallback = "AUDIT_WRITE_FAILED";
      await audit(context, action, actor, "SUCCESS");
      return { ok: true, changed };
    } catch (error) {
      return fail(context, action, actor, error, fallback);
    }
  }

  return {
    close: (guildId, threadId, actorId) => {
      return serialize(
        guildId,
        threadId,
        "CLOSE",
        "CLOSED",
        (context, precedingChangedSameTarget) =>
          close(context, actorId, precedingChangedSameTarget),
      );
    },
    open: (guildId, threadId, actorId) => {
      return serialize(guildId, threadId, "OPEN", "OPEN", (context, precedingChangedSameTarget) =>
        reconcileOpen(
          context,
          { operation: "OPEN", actor: { type: "USER", id: actorId } },
          precedingChangedSameTarget,
        ),
      );
    },
    autoOpen: (guildId, threadId) => {
      return serialize(
        guildId,
        threadId,
        "AUTO_OPEN",
        "OPEN",
        (context, precedingChangedSameTarget) =>
          reconcileOpen(
            context,
            { operation: "AUTO_OPEN", actor: { type: "SYSTEM" } },
            precedingChangedSameTarget,
          ),
      );
    },
  };
}
