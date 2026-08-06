import type { Logger } from "pino";

export type ShutdownResource = {
  name: string;
  close: () => void | Promise<void>;
};

export function createShutdown(resources: readonly ShutdownResource[], logger: Logger) {
  let shutdownPromise: Promise<void> | undefined;

  return function shutdown(reason: string): Promise<void> {
    shutdownPromise ??= (async () => {
      logger.info({ event: "shutdown_started", reason }, "Application shutdown started");

      const failures: unknown[] = [];

      for (const resource of resources) {
        try {
          await resource.close();
        } catch (error) {
          failures.push(error);
          logger.error(
            {
              event: "shutdown_resource_failed",
              errorName: getErrorName(error),
              reason,
              resource: resource.name,
            },
            "Application resource shutdown failed",
          );
        }
      }

      if (failures.length > 0) {
        const error = new AggregateError(failures, "One or more resources failed to shut down");
        logger.error(
          { event: "shutdown_failed", errorName: getErrorName(error), reason },
          "Application shutdown failed",
        );
        throw error;
      }

      logger.info({ event: "shutdown_completed", reason }, "Application shutdown completed");
    })();

    return shutdownPromise;
  };
}

export function getErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
