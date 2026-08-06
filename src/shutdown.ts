import type { Logger } from "pino";

export function createShutdown(closeResources: () => Promise<void>, logger: Logger) {
  let shutdownPromise: Promise<void> | undefined;

  return function shutdown(reason: string): Promise<void> {
    shutdownPromise ??= (async () => {
      logger.info({ event: "shutdown_started", reason }, "Application shutdown started");

      try {
        await closeResources();
        logger.info({ event: "shutdown_completed", reason }, "Application shutdown completed");
      } catch (error) {
        logger.error(
          { event: "shutdown_failed", errorName: getErrorName(error), reason },
          "Application shutdown failed",
        );
        throw error;
      }
    })();

    return shutdownPromise;
  };
}

export function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
