import { administrativeGuard, administrativeTransaction } from "../administrative-transaction.js";
import { eq, sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { AuditNotificationPublisher } from "../audit/audit-notification-dispatcher.js";
import { publishCommittedAudit } from "../audit/audit-notification-publication.js";
import {
  configurationAudit,
  confirmConfigurationAudit,
  guildConfigurationAudits,
  type GuildConfigurationAudit,
  type GuildConfigurationAuditContext,
} from "./guild-configuration-audit.js";
import type { DatabaseClient } from "../database.js";
import { normalizeRecurringTimezone } from "../messages/recurring-message.js";

export const DEFAULT_GUILD_TIMEZONE = "UTC";
export const DEFAULT_CLOSED_PREFIX = "[CLOSED]";

/** Seven days. */
export const DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS = 604_800;
/** Five minutes. */
export const MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS = 300;
/** 365 days. */
export const MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS = 31_536_000;

export const guildSettings = pgTable(
  "guild_settings",
  {
    guildId: text("guild_id").primaryKey(),
    timezone: text("timezone").notNull().default(DEFAULT_GUILD_TIMEZONE),
    closedPrefix: text("closed_prefix").notNull().default(DEFAULT_CLOSED_PREFIX),
    linkPreviewMode: text("link_preview_mode").notNull().default("hybrid"),
    auditLogChannelId: text("audit_log_channel_id"),
    autoCloseInactivitySeconds: integer("auto_close_inactivity_seconds")
      .notNull()
      .default(DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS),
    autoCloseBotMessagesCountAsActivity: boolean("auto_close_bot_messages_count_as_activity")
      .notNull()
      .default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "guild_settings_link_preview_mode_check",
      sql`${table.linkPreviewMode} in ('hybrid', 'public-only', 'button-only', 'off')`,
    ),
    check(
      "guild_settings_auto_close_inactivity_seconds_check",
      sql`${table.autoCloseInactivitySeconds} between ${sql.raw(String(MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS))} and ${sql.raw(String(MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS))}`,
    ),
    check("guild_settings_audit_log_channel_id_nonempty", sql`${table.auditLogChannelId} <> ''`),
  ],
);

export type GuildSettings = typeof guildSettings.$inferSelect;

export type GuildSettingsChangeResult =
  { outcome: "CHANGED" | "NO_CHANGE"; settings: GuildSettings } | { outcome: "UNCONFIRMED" };

export type GuildSettingsStore = {
  getOrCreate: (guildId: string) => Promise<GuildSettings>;
  readTimezone?: (guildId: string) => Promise<string>;
  setTimezone: (
    guildId: string,
    timezone: string,
    audit: GuildConfigurationAuditContext,
  ) => Promise<GuildSettingsChangeResult>;
  setClosedPrefix: (
    guildId: string,
    prefix: string,
    audit: GuildConfigurationAuditContext,
  ) => Promise<GuildSettingsChangeResult>;
  setAutoCloseInactivitySeconds: (
    guildId: string,
    seconds: number,
    audit: GuildConfigurationAuditContext,
  ) => Promise<GuildSettingsChangeResult>;
  setAutoCloseBotMessagesCountAsActivity: (
    guildId: string,
    countsAsActivity: boolean,
    audit: GuildConfigurationAuditContext,
  ) => Promise<GuildSettingsChangeResult>;
};

export class InvalidTimezoneError extends Error {
  constructor() {
    super("Timezone must be a valid IANA timezone");
    this.name = "InvalidTimezoneError";
  }
}

export class InvalidClosedPrefixError extends Error {
  constructor() {
    super("Closed prefix must be 1 to 20 characters and contain no control characters");
    this.name = "InvalidClosedPrefixError";
  }
}

export class InvalidAutoCloseInactivityError extends Error {
  constructor() {
    super(
      "Automatic close inactivity must be a whole number of seconds from 5 minutes to 365 days",
    );
    this.name = "InvalidAutoCloseInactivityError";
  }
}

export class InvalidAutoCloseInactivityInputError extends Error {
  constructor() {
    super("Automatic close inactivity must be one duration from 5 minutes through 365 days");
    this.name = "InvalidAutoCloseInactivityInputError";
  }
}

export function validateTimezone(value: string): string {
  const timezone = normalizeRecurringTimezone(value.trim());
  if (timezone === undefined) throw new InvalidTimezoneError();
  return timezone;
}

export function validateClosedPrefix(value: string): string {
  if (/\p{Cc}/u.test(value)) {
    throw new InvalidClosedPrefixError();
  }

  const prefix = value.trim();
  const length = [...prefix].length;

  if (length < 1 || length > 20) {
    throw new InvalidClosedPrefixError();
  }

  return prefix;
}

export function validateAutoCloseInactivitySeconds(value: number): number {
  if (!Number.isInteger(value)) {
    throw new InvalidAutoCloseInactivityError();
  }
  if (
    value < MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS ||
    value > MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS
  ) {
    throw new InvalidAutoCloseInactivityError();
  }
  return value;
}

const AUTO_CLOSE_INACTIVITY_UNIT_SECONDS = {
  m: 60n,
  h: 3_600n,
  d: 86_400n,
} as const;

/**
 * Parses one automatic-close inactivity duration such as `30m`, `12h`, or `7d`.
 *
 * This is intentionally separate from the scheduled thread-close duration input, which has a
 * different minimum and produces an absolute execution time.
 */
export function parseAutoCloseInactivityInput(value: string): number {
  const match = /^([1-9][0-9]*)(m|h|d)$/.exec(value.trim().toLowerCase());
  if (match === null) {
    throw new InvalidAutoCloseInactivityInputError();
  }

  const unit = match[2] as keyof typeof AUTO_CLOSE_INACTIVITY_UNIT_SECONDS;
  let seconds: bigint;
  try {
    seconds = BigInt(match[1]!) * AUTO_CLOSE_INACTIVITY_UNIT_SECONDS[unit];
  } catch {
    throw new InvalidAutoCloseInactivityInputError();
  }

  if (
    seconds < BigInt(MINIMUM_AUTO_CLOSE_INACTIVITY_SECONDS) ||
    seconds > BigInt(MAXIMUM_AUTO_CLOSE_INACTIVITY_SECONDS)
  ) {
    throw new InvalidAutoCloseInactivityInputError();
  }

  return validateAutoCloseInactivitySeconds(Number(seconds));
}

/** Formats persisted inactivity seconds with the largest unit that divides them exactly. */
export function formatAutoCloseInactivitySeconds(seconds: number): string {
  if (seconds % 86_400 === 0) {
    return `${seconds / 86_400}d`;
  }
  if (seconds % 3_600 === 0) {
    return `${seconds / 3_600}h`;
  }
  return `${Math.trunc(seconds / 60)}m`;
}

export function createGuildSettingsStore(
  database: DatabaseClient,
  publisher?: AuditNotificationPublisher,
): GuildSettingsStore {
  const getOrCreate = async (guildId: string): Promise<GuildSettings> => {
    await database
      .insert(guildSettings)
      .values({ guildId })
      .onConflictDoNothing({ target: guildSettings.guildId });

    const [settings] = await database
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, guildId))
      .limit(1);

    if (settings === undefined) {
      throw new Error("Guild settings could not be loaded after initialization");
    }

    return settings;
  };

  type ScalarKey =
    | "timezone"
    | "closedPrefix"
    | "autoCloseInactivitySeconds"
    | "autoCloseBotMessagesCountAsActivity";
  const change = async (
    guildId: string,
    key: ScalarKey,
    value: string | number | boolean,
    settingType: GuildConfigurationAudit["settingType"],
    context: GuildConfigurationAuditContext,
  ): Promise<GuildSettingsChangeResult> => {
    let expected: GuildConfigurationAudit | undefined;
    let changedSettings: GuildSettings | undefined;
    let result: GuildSettingsChangeResult;
    try {
      result = await administrativeTransaction(
        database,
        context.administrativeAttempt,
        async (transaction): Promise<GuildSettingsChangeResult> => {
          await transaction
            .insert(guildSettings)
            .values({ guildId })
            .onConflictDoNothing({ target: guildSettings.guildId });
          const [current] = await transaction
            .select()
            .from(guildSettings)
            .where(eq(guildSettings.guildId, guildId))
            .limit(1)
            .for("update");
          if (current === undefined) throw new Error("Guild settings row was not established");
          const previous = current[key];
          if (previous === value)
            return administrativeGuard(context.administrativeAttempt, {
              outcome: "NO_CHANGE",
              settings: current,
            });
          expected = configurationAudit(context, guildId, {
            action: "SET",
            settingType,
            targetType: "GUILD",
            targetId: guildId,
            ...(typeof value === "string"
              ? { previousText: previous as string, newText: value }
              : typeof value === "number"
                ? { previousInteger: previous as number, newInteger: value }
                : { previousBoolean: previous as boolean, newBoolean: value }),
          });
          const [updated] = await transaction
            .update(guildSettings)
            .set({ [key]: value, updatedAt: context.occurredAt })
            .where(eq(guildSettings.guildId, guildId))
            .returning();
          if (updated === undefined) throw new Error("Guild settings update was not confirmed");
          changedSettings = updated;
          await transaction.insert(guildConfigurationAudits).values(expected);
          return { outcome: "CHANGED", settings: updated };
        },
      );
    } catch {
      if (changedSettings === undefined || !(await confirmConfigurationAudit(database, expected)))
        return { outcome: "UNCONFIRMED" };
      result = { outcome: "CHANGED", settings: changedSettings };
    }
    if (result.outcome === "CHANGED")
      publishCommittedAudit(publisher, { source: "GUILD_CONFIGURATION", auditId: context.auditId });
    return result;
  };

  return {
    getOrCreate,
    async readTimezone(guildId) {
      const [settings] = await database
        .select({ timezone: guildSettings.timezone })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, guildId))
        .limit(1);
      return settings?.timezone ?? DEFAULT_GUILD_TIMEZONE;
    },
    setTimezone: async (guildId, value, audit) =>
      change(guildId, "timezone", validateTimezone(value), "TIMEZONE", audit),
    setClosedPrefix: async (guildId, value, audit) =>
      change(guildId, "closedPrefix", validateClosedPrefix(value), "CLOSED_PREFIX", audit),
    setAutoCloseInactivitySeconds: async (guildId, value, audit) =>
      change(
        guildId,
        "autoCloseInactivitySeconds",
        validateAutoCloseInactivitySeconds(value),
        "AUTO_CLOSE_INACTIVITY",
        audit,
      ),
    setAutoCloseBotMessagesCountAsActivity: async (guildId, value, audit) =>
      change(
        guildId,
        "autoCloseBotMessagesCountAsActivity",
        value,
        "AUTO_CLOSE_BOT_MESSAGES",
        audit,
      ),
  };
}
