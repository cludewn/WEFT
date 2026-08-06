import { eq } from "drizzle-orm";
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";

export const DEFAULT_GUILD_TIMEZONE = "UTC";
export const DEFAULT_CLOSED_PREFIX = "[CLOSED]";

export const guildSettings = pgTable("guild_settings", {
  guildId: text("guild_id").primaryKey(),
  timezone: text("timezone").notNull().default(DEFAULT_GUILD_TIMEZONE),
  closedPrefix: text("closed_prefix").notNull().default(DEFAULT_CLOSED_PREFIX),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type GuildSettings = typeof guildSettings.$inferSelect;

export type GuildSettingsStore = {
  getOrCreate: (guildId: string) => Promise<GuildSettings>;
  setTimezone: (guildId: string, timezone: string) => Promise<GuildSettings>;
  setClosedPrefix: (guildId: string, prefix: string) => Promise<GuildSettings>;
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

export function validateTimezone(value: string): string {
  const timezone = value.trim();

  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
  } catch (error) {
    if (error instanceof RangeError) {
      throw new InvalidTimezoneError();
    }
    throw error;
  }

  if (timezone.length === 0) {
    throw new InvalidTimezoneError();
  }

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

export function createGuildSettingsStore(database: DatabaseClient): GuildSettingsStore {
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

  return {
    getOrCreate,
    async setTimezone(guildId, value) {
      const timezone = validateTimezone(value);
      await getOrCreate(guildId);
      const [settings] = await database
        .update(guildSettings)
        .set({ timezone, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId))
        .returning();

      if (settings === undefined) {
        throw new Error("Guild timezone could not be updated");
      }

      return settings;
    },
    async setClosedPrefix(guildId, value) {
      const closedPrefix = validateClosedPrefix(value);
      await getOrCreate(guildId);
      const [settings] = await database
        .update(guildSettings)
        .set({ closedPrefix, updatedAt: new Date() })
        .where(eq(guildSettings.guildId, guildId))
        .returning();

      if (settings === undefined) {
        throw new Error("Guild closed prefix could not be updated");
      }

      return settings;
    },
  };
}
