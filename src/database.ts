import { managedMessageExecutionFailureAudits } from "./managed-message-execution-audit.js";
import { bindAdministrativePool } from "./administrative-transaction.js";
import { administrativeOperationFailureAudits } from "./administrative-operation-failure-audit.js";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import { auditLogDestinationAudits } from "./audit-log-destination-persistence.js";
import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
} from "./automatic-close-persistence.js";
import type { DatabaseConfig } from "./config.js";
import { guildConfigurationAudits } from "./guild-configuration-audit.js";
import { guildSettings } from "./guild-settings.js";
import { managedMessageAudits, managedMessages } from "./managed-message-persistence.js";
import {
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "./recurring-message-persistence.js";
import { scheduledActions } from "./scheduled-action-persistence.js";
import { scheduledMessageAudits, scheduledMessageStates } from "./scheduled-message-persistence.js";
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
      managedMessageExecutionFailureAudits,
      administrativeOperationFailureAudits,
      auditLogDestinationAudits,
      autoCloseParentChannels,
      autoCloseThreadActivity,
      autoCloseThreadExclusions,
      guildSettings,
      guildConfigurationAudits,
      managedMessageAudits,
      managedMessages,
      managedThreads,
      recurringMessageAudits,
      recurringMessageOccurrences,
      recurringMessageSchedules,
      scheduledActions,
      scheduledMessageAudits,
      scheduledMessageStates,
      scheduledThreadCloseAudits,
      threadAudits,
    },
  });

  bindAdministrativePool(client, pool);

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
