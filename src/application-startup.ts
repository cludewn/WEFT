import type { Logger } from "pino";

import { DiscordStartupAbortedError } from "./discord.js";
import { getErrorName } from "./shutdown.js";

export type ApplicationStartupDependencies = {
  verifyDatabaseConnection: () => Promise<void>;
  startPgBoss: () => Promise<void>;
  ensureScheduledThreadCloseQueue: () => Promise<void>;
  startDiscord: () => Promise<void>;
  startScheduledThreadCloseWorkers: () => Promise<void>;
  shutdown: (reason: string) => Promise<void>;
};

export async function runApplicationStartup(
  dependencies: ApplicationStartupDependencies,
  logger: Logger,
): Promise<void> {
  try {
    logger.info({ event: "application_starting" }, "Application startup started");
    await dependencies.verifyDatabaseConnection();
    logger.info({ event: "database_connected" }, "PostgreSQL connection verified");
    await dependencies.startPgBoss();
    await dependencies.ensureScheduledThreadCloseQueue();
    await dependencies.startDiscord();
    logger.info({ event: "discord_ready" }, "Discord client is ready");
    await dependencies.startScheduledThreadCloseWorkers();
    logger.info({ event: "application_ready" }, "Application startup completed");
  } catch (error) {
    if (error instanceof DiscordStartupAbortedError) {
      try {
        await dependencies.shutdown("startup_aborted");
      } catch {
        process.exitCode = 1;
      }
      return;
    }

    logger.error(
      { event: "startup_failed", errorName: getErrorName(error) },
      "Application startup failed",
    );
    process.exitCode = 1;

    try {
      await dependencies.shutdown("startup_failure");
    } catch {
      // The shutdown controller already recorded the failure without exposing configuration values.
    }
  }
}
