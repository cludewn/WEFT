import pino from "pino";

import { ConfigurationError, loadConfig } from "./config.js";
import { createDatabase } from "./database.js";
import { createShutdown, getErrorName } from "./shutdown.js";

async function main(): Promise<void> {
  let config;

  try {
    config = loadConfig();
  } catch (error) {
    const variables = error instanceof ConfigurationError ? error.variables : [];
    process.stderr.write(`${JSON.stringify({ event: "configuration_failed", variables })}\n`);
    process.exitCode = 1;
    return;
  }

  const logger = pino({ level: config.logLevel });
  const database = createDatabase(config.database);
  const shutdown = createShutdown(() => database.close(), logger);

  const handleSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch(() => {
      process.exitCode = 1;
    });
  };

  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  try {
    logger.info({ event: "application_starting" }, "Application startup started");
    await database.verifyConnection();
    logger.info({ event: "database_connected" }, "PostgreSQL connection verified");
    logger.info({ event: "application_ready" }, "Application startup completed");
  } catch (error) {
    logger.error(
      { event: "startup_failed", errorName: getErrorName(error) },
      "Application startup failed",
    );
    process.exitCode = 1;

    try {
      await shutdown("startup_failure");
    } catch {
      // The shutdown controller already recorded the failure without exposing configuration values.
    }
  }
}

await main();
