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
export const DEFAULT_DISCORD_MUTATION_TIMEOUT_MS = 5_000;

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
  "DISCORD_RENAME_OUTCOME_UNKNOWN",
  "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
  "AUDIT_WRITE_OUTCOME_UNKNOWN",
  "DISCORD_MUTATION_PENDING",
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
  renameThread: (
    guildId: string,
    threadId: string,
    name: string,
    signal: AbortSignal,
  ) => Promise<void>;
  archiveThread: (
    guildId: string,
    threadId: string,
    name: string,
    signal: AbortSignal,
  ) => Promise<void>;
};

export type ThreadLifecycleResult =
  { ok: true; changed: boolean } | { ok: false; code: ThreadFailureCode };

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
  mutationTimeoutMs?: number;
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

type CloseReconciliationIntent = {
  operation: "CLOSE";
  actor: { type: "USER"; id: string };
  appliedPrefix?: string;
};
type OpenReconciliationIntent =
  | {
      operation: "OPEN";
      actor: { type: "USER"; id: string };
    }
  | {
      operation: "AUTO_OPEN";
      actor: { type: "SYSTEM" };
    };
type ReconciliationIntent = CloseReconciliationIntent | OpenReconciliationIntent;

type ReconciliationAttempt = {
  generation: number;
  settledBoundary: DiscordMutationBoundary;
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

  update(guildId: string, threadId: string, generation: number, promise: Promise<void>): boolean {
    const key = this.key(guildId, threadId);
    if (this.#pending.get(key)?.generation !== generation) {
      return false;
    }
    this.#pending.set(key, { generation, promise });
    return true;
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

export function createThreadLifecycleService(
  dependencies: LifecycleDependencies,
): ThreadLifecycleService {
  const { discord, guildSettings, managedThreads, audits, logger } = dependencies;
  const deadlineMs = dependencies.deadlineMs ?? DEFAULT_THREAD_LIFECYCLE_DEADLINE_MS;
  const mutationTimeoutMs = dependencies.mutationTimeoutMs ?? DEFAULT_DISCORD_MUTATION_TIMEOUT_MS;
  const queuedOperations = new Map<string, QueuedOperation>();
  const pendingMutations = new PendingDiscordMutationGuard();

  function createContext(
    guildId: string,
    threadId: string,
    operation: LifecycleOperation,
  ): OperationContext {
    const startedAt = Date.now();
    return {
      guildId,
      threadId,
      operation,
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
    // The FIFO queue may be released after an unknown mutation outcome. The pending mutation
    // guard remains until the raw Discord promise settles, preventing a retry from overlapping it.
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
    timeoutOptions?: { timeoutMs: number; onTimeout: () => void },
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
      if (error instanceof OperationTimeoutError) {
        timeoutOptions?.onTimeout();
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
    timeoutCode: "DISCORD_RENAME_OUTCOME_UNKNOWN" | "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
    intent: ReconciliationIntent,
    operation: (signal: AbortSignal) => Promise<void>,
    reconciliation?: ReconciliationAttempt,
  ): Promise<void> {
    if (reconciliation?.settledBoundary === boundary) {
      throw new LifecycleFailure(failureCode);
    }
    const controller = new AbortController();
    let timedOut = false;
    let generation = reconciliation?.generation;
    await runBoundary(
      context,
      boundary,
      failureCode,
      timeoutCode,
      () => {
        if (
          generation === undefined &&
          pendingMutations.isPending(context.guildId, context.threadId)
        ) {
          throw new LifecycleFailure("DISCORD_MUTATION_PENDING");
        }
        const mutation = Promise.resolve().then(() => operation(controller.signal));
        if (generation === undefined) {
          generation = pendingMutations.track(context.guildId, context.threadId, mutation);
        } else if (
          !pendingMutations.update(context.guildId, context.threadId, generation, mutation)
        ) {
          throw new LifecycleFailure("DISCORD_MUTATION_PENDING");
        }
        const trackedGeneration = generation;
        void mutation.then(
          () =>
            handleMutationSettlement(
              context,
              intent,
              boundary,
              trackedGeneration,
              timedOut,
              reconciliation !== undefined,
            ),
          () =>
            handleMutationSettlement(
              context,
              intent,
              boundary,
              trackedGeneration,
              timedOut,
              reconciliation !== undefined,
            ),
        );
        return mutation;
      },
      {
        timeoutMs: mutationTimeoutMs,
        onTimeout: () => {
          timedOut = true;
          controller.abort();
        },
      },
    );
  }

  function requireNoPendingMutation(
    context: OperationContext,
    reconciliation?: ReconciliationAttempt,
  ): void {
    if (
      pendingMutations.isPending(context.guildId, context.threadId) &&
      (reconciliation === undefined ||
        !pendingMutations.isCurrent(context.guildId, context.threadId, reconciliation.generation))
    ) {
      throw new LifecycleFailure("DISCORD_MUTATION_PENDING");
    }
  }

  function handleMutationSettlement(
    context: OperationContext,
    intent: ReconciliationIntent,
    boundary: DiscordMutationBoundary,
    generation: number,
    timedOut: boolean,
    reconciling: boolean,
  ): void {
    if (timedOut) {
      scheduleReconciliation(context.guildId, context.threadId, intent, {
        generation,
        settledBoundary: boundary,
      });
    } else if (!reconciling) {
      pendingMutations.release(context.guildId, context.threadId, generation);
    }
  }

  function scheduleReconciliation(
    guildId: string,
    threadId: string,
    intent: ReconciliationIntent,
    reconciliation: ReconciliationAttempt,
  ): void {
    logger.debug(
      {
        event: "thread_lifecycle_reconciliation_scheduled",
        guildId,
        threadId,
        operation: intent.operation,
        generation: reconciliation.generation,
      },
      "Thread lifecycle reconciliation scheduled",
    );
    const target: LifecycleTarget = intent.operation === "CLOSE" ? "CLOSED" : "OPEN";
    const result = serialize(
      guildId,
      threadId,
      intent.operation,
      target,
      (context, precedingChangedSameTarget) => {
        if (intent.operation === "CLOSE") {
          return close(
            context,
            intent.actor.id,
            precedingChangedSameTarget,
            reconciliation,
            intent,
          );
        }
        return reconcileOpen(context, intent, precedingChangedSameTarget, reconciliation);
      },
    );
    void result.then(
      (reconciliationResult) => {
        if (
          reconciliationResult.ok ||
          (reconciliationResult.code !== "DISCORD_RENAME_OUTCOME_UNKNOWN" &&
            reconciliationResult.code !== "DISCORD_ARCHIVE_OUTCOME_UNKNOWN")
        ) {
          pendingMutations.release(guildId, threadId, reconciliation.generation);
        }
      },
      () => pendingMutations.release(guildId, threadId, reconciliation.generation),
    );
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
    return (
      code === "STATE_WRITE_OUTCOME_UNKNOWN" ||
      code === "DISCORD_RENAME_OUTCOME_UNKNOWN" ||
      code === "DISCORD_ARCHIVE_OUTCOME_UNKNOWN" ||
      code === "AUDIT_WRITE_OUTCOME_UNKNOWN"
    );
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
    reconciliation?: ReconciliationAttempt,
    reconciliationIntent?: CloseReconciliationIntent,
  ): Promise<ThreadLifecycleResult> {
    const { guildId, threadId } = context;
    const actor = { type: "USER" as const, id: actorId };
    let intent: CloseReconciliationIntent = reconciliationIntent ?? { operation: "CLOSE", actor };
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      requireNoPendingMutation(context, reconciliation);
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
        intent.appliedPrefix ??
        (existing?.lifecycleState === "CLOSED" ? existing.appliedPrefix : settings.closedPrefix);
      intent = { ...intent, appliedPrefix };

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
        fallback = "DISCORD_ARCHIVE_FAILED";
        await runDiscordMutation(
          context,
          "thread_archive",
          "DISCORD_ARCHIVE_FAILED",
          "DISCORD_ARCHIVE_OUTCOME_UNKNOWN",
          intent,
          (signal) => discord.archiveThread(guildId, threadId, closedName, signal),
          reconciliation,
        );
        changed = true;
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
    intent: OpenReconciliationIntent,
    precedingChangedSameTarget: boolean,
    reconciliation?: ReconciliationAttempt,
  ): Promise<ThreadLifecycleResult> {
    const { guildId, threadId } = context;
    const { operation: action, actor } = intent;
    let fallback: ThreadFailureCode = "DISCORD_FETCH_FAILED";
    try {
      requireNoPendingMutation(context, reconciliation);
      const initial = await fetchSupported(context);
      if (initial.archived) {
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
      return await completeOpen(
        context,
        managed,
        intent,
        precedingChangedSameTarget,
        reconciliation,
      );
    } catch (error) {
      return fail(context, action, actor, error, fallback);
    }
  }

  async function completeOpen(
    context: OperationContext,
    managed: ManagedThread,
    intent: OpenReconciliationIntent,
    precedingChangedSameTarget: boolean,
    reconciliation?: ReconciliationAttempt,
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
        fallback = "DISCORD_RENAME_FAILED";
        await runDiscordMutation(
          context,
          "thread_rename",
          "DISCORD_RENAME_FAILED",
          "DISCORD_RENAME_OUTCOME_UNKNOWN",
          intent,
          (signal) => discord.renameThread(context.guildId, context.threadId, openedName, signal),
          reconciliation,
        );
        changed = true;
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
