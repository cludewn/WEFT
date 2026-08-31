import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
} from "./automatic-close-persistence.js";
import type { DatabaseConfig } from "./config.js";
import { guildSettings } from "./guild-settings.js";
import { managedMessages } from "./managed-message-persistence.js";
import { scheduledActions } from "./scheduled-action-persistence.js";
import { scheduledThreadCloseAudits } from "./scheduled-thread-close-persistence.js";
import { managedThreads, threadAudits } from "./thread-persistence.js";

export function createDatabase(config: DatabaseConfig) {
  const pool = new Pool({
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    application_name: "weft",
  });

  const client = drizzle(pool, {
    schema: {
      autoCloseParentChannels,
      autoCloseThreadActivity,
      autoCloseThreadExclusions,
      guildSettings,
      managedMessages,
      managedThreads,
      scheduledActions,
      scheduledThreadCloseAudits,
      threadAudits,
    },
  });

  return {
    client,
    async verifyConnection(): Promise<void> {
      await pool.query("select 1");
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

export type DatabaseClient = ReturnType<typeof createDatabase>["client"];
