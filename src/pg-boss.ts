import { PgBoss } from "pg-boss";

import type { Logger } from "pino";

import type { DatabaseConfig } from "./config.js";
import { getErrorName } from "./shutdown.js";

export type PgBossRuntime = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export function createPgBossRuntime(config: DatabaseConfig, logger: Logger): PgBossRuntime {
  const boss = new PgBoss({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    application_name: "weft-pg-boss",
    migrate: true,
  });

  boss.on("error", (error) => {
    logger.error(
      { event: "pg_boss_runtime_error", errorName: getErrorName(error) },
      "pg-boss runtime error",
    );
  });

  return {
    async start(): Promise<void> {
      const startedAt = Date.now();
      logger.info({ event: "pg_boss_starting" }, "pg-boss startup started");

      try {
        await boss.start();
        logger.info(
          { event: "pg_boss_started", durationMs: Date.now() - startedAt },
          "pg-boss startup completed",
        );
      } catch (error) {
        logger.error(
          {
            event: "pg_boss_start_failed",
            errorName: getErrorName(error),
            durationMs: Date.now() - startedAt,
          },
          "pg-boss startup failed",
        );
        throw error;
      }
    },

    async stop(): Promise<void> {
      const startedAt = Date.now();
      logger.info({ event: "pg_boss_stopping" }, "pg-boss shutdown started");

      try {
        await boss.stop({ close: true });
        logger.info(
          { event: "pg_boss_stopped", durationMs: Date.now() - startedAt },
          "pg-boss shutdown completed",
        );
      } catch (error) {
        logger.error(
          {
            event: "pg_boss_stop_failed",
            errorName: getErrorName(error),
            durationMs: Date.now() - startedAt,
          },
          "pg-boss shutdown failed",
        );
        throw error;
      }
    },
  };
}
