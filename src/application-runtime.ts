import type { Logger } from "pino";

import { getErrorName } from "./shutdown.js";

export const SHUTDOWN_TIMEOUT_MS = 30_000;

export type ApplicationLifecycleState = "STARTING" | "READY" | "SHUTTING_DOWN" | "STOPPED";

export type ApplicationIngress = {
  run: <T>(operation: () => T | Promise<T>) => Promise<T> | undefined;
};

export type ProcessControl = {
  setExitCode: (code: number) => void;
  forceExit: (code: number) => void;
  writeStderr: (message: string) => void;
};

type StartupDependencies = {
  startHealthListener: () => Promise<void>;
  verifyDatabaseConnection: () => Promise<void>;
  startPgBoss: () => Promise<void>;
  ensureScheduledThreadCloseQueue: () => Promise<void>;
  ensureScheduledMessageQueue: () => Promise<void>;
  ensureRecurringMessageQueue: () => Promise<void>;
  recoverScheduledThreadCloseDeliveries: () => Promise<void>;
  recoverScheduledMessageDeliveries: () => Promise<void>;
  recoverRecurringMessageDeliveries: () => Promise<void>;
  startDiscord: () => Promise<void>;
  startScheduledThreadCloseWorkers: () => Promise<void>;
  startScheduledMessageWorker: () => Promise<void>;
  startRecurringMessageWorker: () => Promise<void>;
  startScheduledThreadCloseRuntimeReconciliation: () => Promise<void>;
  startScheduledMessageRuntimeReconciliation: () => Promise<void>;
  startRecurringMessageRuntimeReconciliation: () => Promise<void>;
  reconcileAutomaticCloseBaselines: () => Promise<void>;
  startAutomaticCloseRuntime: () => Promise<void>;
};

export type ApplicationRuntimeDependencies = StartupDependencies & {
  quiesceHealth: () => void;
  drainHealth: () => Promise<void>;
  quiesce: readonly { name: string; stop: () => void | Promise<void> }[];
  drainThreadLifecycle: () => Promise<void>;
  stopPgBoss: (remainingMs: number) => Promise<void>;
  destroyDiscord: () => void | Promise<void>;
  closeDatabase: () => Promise<void>;
  logger: Pick<Logger, "info" | "warn" | "error">;
  processControl?: ProcessControl;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export type ApplicationRuntime = {
  readonly ingress: ApplicationIngress;
  getState: () => ApplicationLifecycleState;
  start: () => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
  handleFatal: (
    origin: "unhandledRejection" | "uncaughtException",
    error: unknown,
  ) => Promise<void>;
  setProcessHandlerDisposer: (dispose: () => void) => void;
};

class StartupInterruptedError extends Error {
  constructor() {
    super("Application startup was interrupted by shutdown");
    this.name = "StartupInterruptedError";
  }
}

export class ShutdownTimeoutError extends Error {
  constructor() {
    super("Application shutdown deadline expired");
    this.name = "ShutdownTimeoutError";
  }
}

type CleanupFailure = { error: unknown };

const defaultProcessControl: ProcessControl = {
  setExitCode(code) {
    process.exitCode = code;
  },
  forceExit(code) {
    process.exit(code);
  },
  writeStderr(message) {
    process.stderr.write(message);
  },
};

export function createApplicationRuntime(
  dependencies: ApplicationRuntimeDependencies,
): ApplicationRuntime {
  const {
    logger,
    processControl = defaultProcessControl,
    now = Date.now,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = dependencies;
  let state: ApplicationLifecycleState = "STARTING";
  let startupPromise: Promise<void> | undefined;
  let activeStartupStep: Promise<void> | undefined;
  let currentStartupStep = "unknown";
  let shutdownPromise: Promise<void> | undefined;
  let shutdownReason: string | undefined;
  let shutdownDeadlineAt: number | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let fatalLatched = false;
  let processHandlerDisposer: (() => void) | undefined;
  const admittedOperations = new Set<Promise<unknown>>();

  const ingress: ApplicationIngress = {
    run<T>(operation: () => T | Promise<T>): Promise<T> | undefined {
      if (state !== "READY") return undefined;
      let releaseTracked!: () => void;
      const tracked = new Promise<void>((resolve) => {
        releaseTracked = resolve;
      });
      admittedOperations.add(tracked);
      let invocation: Promise<T>;
      try {
        invocation = Promise.resolve(operation());
      } catch (error) {
        invocation = Promise.reject(asError(error));
      }
      void invocation.then(
        () => releaseTracked(),
        () => releaseTracked(),
      );
      void tracked.then(
        () => admittedOperations.delete(tracked),
        () => admittedOperations.delete(tracked),
      );
      return invocation;
    },
  };

  const checkpoint = (): void => {
    if (state !== "STARTING") throw new StartupInterruptedError();
  };

  const runStartupStep = async (
    startupStep: string,
    operation: () => Promise<void>,
  ): Promise<void> => {
    checkpoint();
    currentStartupStep = startupStep;
    let resolveStep!: () => void;
    let rejectStep!: (error: Error) => void;
    const invocation = new Promise<void>((resolve, reject) => {
      resolveStep = resolve;
      rejectStep = reject;
    });
    activeStartupStep = invocation;
    try {
      void operation().then(resolveStep, (error: unknown) => rejectStep(asError(error)));
    } catch (error) {
      rejectStep(asError(error));
    }
    try {
      await invocation;
    } finally {
      if (activeStartupStep === invocation) activeStartupStep = undefined;
    }
    checkpoint();
  };

  const remainingMs = (): number => Math.max(0, (shutdownDeadlineAt ?? now()) - now());

  const logCleanupFailure = (resource: string, error: unknown): void => {
    logger.error(
      {
        event: "resource_cleanup_failed",
        resource,
        errorName: safeErrorName(error),
        shutdownReason,
      },
      "Application resource cleanup failed",
    );
  };

  const settleCleanup = async (
    resource: string,
    operation: void | Promise<void>,
  ): Promise<CleanupFailure | undefined> => {
    try {
      await operation;
      return undefined;
    } catch (error) {
      logCleanupFailure(resource, error);
      return { error };
    }
  };

  const invokeCleanup = (
    resource: string,
    operation: () => void | Promise<void>,
  ): Promise<CleanupFailure | undefined> => {
    try {
      return settleCleanup(resource, operation());
    } catch (error) {
      logCleanupFailure(resource, error);
      return Promise.resolve({ error });
    }
  };

  const drainAdmittedOperations = async (): Promise<void> => {
    while (admittedOperations.size > 0) {
      await Promise.allSettled([...admittedOperations]);
    }
  };

  const prepareShutdown = (reason: string): void => {
    if (shutdownDeadlineAt !== undefined) return;
    if (reason === "SIGINT" || reason === "SIGTERM") processControl.setExitCode(0);
    shutdownReason = reason;
    shutdownDeadlineAt = now() + SHUTDOWN_TIMEOUT_MS;
    state = "SHUTTING_DOWN";
    dependencies.quiesceHealth();
  };

  const runCleanup = async (): Promise<void> => {
    logger.info({ event: "shutdown_requested", shutdownReason }, "Application shutdown requested");
    logger.info({ event: "shutdown_started", shutdownReason }, "Application shutdown started");

    // Calling every stop method before awaiting any of them closes all producer gates promptly.
    const quiesce = dependencies.quiesce.map((resource) =>
      invokeCleanup(resource.name, resource.stop),
    );
    const activeStep = activeStartupStep;
    const sourceDrains = [
      ...quiesce,
      settleCleanup("startup-step", activeStep?.then(() => undefined) ?? Promise.resolve()),
      settleCleanup("discord-ingress", drainAdmittedOperations()),
    ];
    const failures: unknown[] = (await Promise.all(sourceDrains)).flatMap((failure) =>
      failure === undefined ? [] : [failure.error],
    );

    // Admitted handlers, reconcilers, and worker callbacks can create retained thread-lifecycle
    // work after shutdown begins. Establish their source-side barrier before observing the
    // feature-owned logical-operation set, so a late ownership handoff cannot escape the drain.
    const threadLifecycleFailure = await settleCleanup(
      "thread-lifecycle",
      dependencies.drainThreadLifecycle(),
    );
    if (threadLifecycleFailure !== undefined) failures.push(threadLifecycleFailure.error);

    const healthFailure = await invokeCleanup("health", dependencies.drainHealth);
    if (healthFailure !== undefined) failures.push(healthFailure.error);

    const pgBossFailure = await invokeCleanup("pg-boss", () =>
      dependencies.stopPgBoss(remainingMs()),
    );
    if (pgBossFailure !== undefined) failures.push(pgBossFailure.error);
    const discordFailure = await invokeCleanup("discord", dependencies.destroyDiscord);
    if (discordFailure !== undefined) failures.push(discordFailure.error);
    const databaseFailure = await invokeCleanup("database", dependencies.closeDatabase);
    if (databaseFailure !== undefined) failures.push(databaseFailure.error);

    try {
      processHandlerDisposer?.();
    } catch (error) {
      logCleanupFailure("process-handlers", error);
      failures.push(error);
    }

    state = "STOPPED";
    if (failures.length > 0) {
      processControl.setExitCode(1);
      throw new AggregateError(failures, "Application shutdown failed");
    }
    logger.info({ event: "shutdown_completed", shutdownReason }, "Application shutdown completed");
  };

  const launchShutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    const timeout = new Promise<never>((_, reject) => {
      deadlineTimer = setTimer(() => reject(new ShutdownTimeoutError()), remainingMs());
      deadlineTimer.unref?.();
    });
    const cleanup = runCleanup();
    // If the deadline wins, cleanup promises may still reject in a test fake after forceExit.
    void cleanup.catch(() => undefined);
    shutdownPromise = Promise.race([cleanup, timeout])
      .catch((error: unknown) => {
        if (error instanceof ShutdownTimeoutError) {
          processControl.setExitCode(1);
          try {
            logger.error(
              { event: "shutdown_timed_out", shutdownReason },
              "Application shutdown deadline expired",
            );
          } catch {
            try {
              processControl.writeStderr('{"event":"shutdown_timed_out"}\n');
            } catch {
              // Force termination remains authoritative if every logging channel fails.
            }
          }
          processControl.forceExit(1);
        } else {
          processControl.setExitCode(1);
        }
        throw error;
      })
      .finally(() => {
        if (deadlineTimer !== undefined) clearTimer(deadlineTimer);
      });
    return shutdownPromise;
  };

  const shutdown = (reason: string): Promise<void> => {
    prepareShutdown(reason);
    return launchShutdown();
  };

  const start = (): Promise<void> => {
    startupPromise ??= (async () => {
      logger.info({ event: "startup_started" }, "Application startup started");
      try {
        await runStartupStep("health_listener_start", dependencies.startHealthListener);
        await runStartupStep("database_verify", dependencies.verifyDatabaseConnection);
        await runStartupStep("pg_boss_start", dependencies.startPgBoss);
        await runStartupStep("queue_validation", dependencies.ensureScheduledThreadCloseQueue);
        await runStartupStep("queue_validation", dependencies.ensureScheduledMessageQueue);
        await runStartupStep("queue_validation", dependencies.ensureRecurringMessageQueue);
        await runStartupStep(
          "startup_recovery",
          dependencies.recoverScheduledThreadCloseDeliveries,
        );
        await runStartupStep("startup_recovery", dependencies.recoverScheduledMessageDeliveries);
        await runStartupStep("startup_recovery", dependencies.recoverRecurringMessageDeliveries);
        await runStartupStep("discord_login", dependencies.startDiscord);
        await runStartupStep("worker_start", dependencies.startScheduledThreadCloseWorkers);
        await runStartupStep("worker_start", dependencies.startScheduledMessageWorker);
        await runStartupStep("worker_start", dependencies.startRecurringMessageWorker);
        await runStartupStep(
          "reconciler_start",
          dependencies.startScheduledThreadCloseRuntimeReconciliation,
        );
        await runStartupStep(
          "reconciler_start",
          dependencies.startScheduledMessageRuntimeReconciliation,
        );
        await runStartupStep(
          "reconciler_start",
          dependencies.startRecurringMessageRuntimeReconciliation,
        );
        checkpoint();
        try {
          await runStartupStep(
            "automatic_close_baseline",
            dependencies.reconcileAutomaticCloseBaselines,
          );
        } catch (error) {
          if (error instanceof StartupInterruptedError) throw error;
          logger.warn(
            {
              event: "automatic_close_baseline_reconciliation_failed",
              errorName: safeErrorName(error),
            },
            "Automatic close baseline reconciliation failed",
          );
          checkpoint();
        }
        await runStartupStep("automatic_close_start", dependencies.startAutomaticCloseRuntime);
        checkpoint();
        state = "READY";
        logger.info({ event: "application_ready" }, "Application startup completed");
      } catch (error) {
        if (error instanceof StartupInterruptedError) {
          await shutdownPromise;
          return;
        }
        logger.error(
          {
            event: "startup_step_failed",
            startupStep: currentStartupStep,
            errorName: safeErrorName(error),
          },
          "Application startup failed",
        );
        processControl.setExitCode(1);
        try {
          await shutdown("startup_failure");
        } catch {
          // The primary startup error remains the rejection from start().
        }
        throw error;
      }
    })();
    return startupPromise;
  };

  return {
    ingress,
    getState: () => state,
    start,
    shutdown,
    handleFatal(origin, error) {
      processControl.setExitCode(1);
      if (fatalLatched) {
        processControl.forceExit(1);
        return Promise.resolve();
      }
      fatalLatched = true;
      prepareShutdown(`fatal_${origin}`);
      try {
        logger.error(
          { event: "fatal_runtime_failure", origin, errorName: safeErrorName(error) },
          "Fatal runtime failure",
        );
      } catch {
        try {
          processControl.writeStderr('{"event":"fatal_runtime_failure","logging":"failed"}\n');
        } catch {
          // There is no safer reporting channel. Continue forced non-zero shutdown.
        }
      }
      return launchShutdown();
    },
    setProcessHandlerDisposer(dispose) {
      processHandlerDisposer = dispose;
    },
  };
}

export function safeErrorName(error: unknown): string {
  try {
    const name = getErrorName(error);
    return /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Operation rejected");
}
