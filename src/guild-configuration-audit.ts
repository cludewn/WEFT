import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";

export type GuildConfigurationAuditContext = {
  auditId: string;
  actorUserId: string;
  occurredAt: Date;
};

export function createConfigurationAuditContext(
  actorUserId: string,
  occurredAt = new Date(),
): GuildConfigurationAuditContext {
  return { actorUserId, auditId: randomUUID(), occurredAt };
}

export const guildConfigurationAudits = pgTable(
  "guild_configuration_audits",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").$type<"SET" | "ADD" | "REMOVE" | "TRACK" | "UNTRACK">().notNull(),
    settingType: text("setting_type")
      .$type<
        | "TIMEZONE"
        | "CLOSED_PREFIX"
        | "AUTO_CLOSE_INACTIVITY"
        | "AUTO_CLOSE_BOT_MESSAGES"
        | "AUTO_CLOSE_PARENT"
        | "THREAD_EXCLUSION"
      >()
      .notNull(),
    targetType: text("target_type").$type<"GUILD" | "PARENT_CHANNEL" | "THREAD">().notNull(),
    targetId: text("target_id").notNull(),
    previousText: text("previous_text"),
    newText: text("new_text"),
    previousInteger: integer("previous_integer"),
    newInteger: integer("new_integer"),
    previousBoolean: boolean("previous_boolean"),
    newBoolean: boolean("new_boolean"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<"SUCCESS">().notNull(),
  },
  (t) => [
    check(
      "guild_configuration_audits_identity_check",
      sql`${t.id} <> '' and ${t.guildId} <> '' and ${t.actorUserId} <> '' and ${t.targetId} <> ''`,
    ),
    check("guild_configuration_audits_outcome_check", sql`${t.outcome} = 'SUCCESS'`),
    // IS TRUE rejects PostgreSQL CHECK's UNKNOWN result as well as FALSE.
    check(
      "guild_configuration_audits_transition_check",
      sql`(
      (
        ${t.action} = 'SET' and ${t.targetType} = 'GUILD' and ${t.targetId} = ${t.guildId}
        and (
          (
            ${t.settingType} in ('TIMEZONE', 'CLOSED_PREFIX')
            and ${t.previousText} is not null and ${t.newText} is not null
            and ${t.previousText} <> ${t.newText}
            and ${t.previousInteger} is null and ${t.newInteger} is null
            and ${t.previousBoolean} is null and ${t.newBoolean} is null
            and (
              (${t.settingType} = 'TIMEZONE' and ${t.previousText} <> '' and ${t.newText} <> '')
              or (${t.settingType} = 'CLOSED_PREFIX'
                and char_length(${t.previousText}) between 1 and 20
                and char_length(${t.newText}) between 1 and 20
                and ${t.previousText} !~ U&'[\\0001-\\001F\\007F-\\009F]'
                and ${t.newText} !~ U&'[\\0001-\\001F\\007F-\\009F]')
            )
          )
          or (
            ${t.settingType} = 'AUTO_CLOSE_INACTIVITY'
            and ${t.previousInteger} between 300 and 31536000
            and ${t.newInteger} between 300 and 31536000
            and ${t.previousInteger} <> ${t.newInteger}
            and ${t.previousText} is null and ${t.newText} is null
            and ${t.previousBoolean} is null and ${t.newBoolean} is null
          )
          or (
            ${t.settingType} = 'AUTO_CLOSE_BOT_MESSAGES'
            and ${t.previousBoolean} is not null and ${t.newBoolean} is not null
            and ${t.previousBoolean} <> ${t.newBoolean}
            and ${t.previousText} is null and ${t.newText} is null
            and ${t.previousInteger} is null and ${t.newInteger} is null
          )
        )
      )
      or (
        ${t.previousText} is null and ${t.newText} is null
        and ${t.previousInteger} is null and ${t.newInteger} is null
        and (
          (${t.settingType} = 'AUTO_CLOSE_PARENT' and ${t.targetType} = 'PARENT_CHANNEL'
            and ((${t.action} = 'ADD' and ${t.previousBoolean} = false and ${t.newBoolean} = true)
              or (${t.action} = 'REMOVE' and ${t.previousBoolean} = true and ${t.newBoolean} = false)))
          or (${t.settingType} = 'THREAD_EXCLUSION' and ${t.targetType} = 'THREAD'
            and ((${t.action} = 'TRACK' and ${t.previousBoolean} = true and ${t.newBoolean} = false)
              or (${t.action} = 'UNTRACK' and ${t.previousBoolean} = false and ${t.newBoolean} = true)))
        )
      )
    ) is true`,
    ),
    index("guild_configuration_audits_retention_idx").on(t.occurredAt, t.id),
  ],
);

export type GuildConfigurationAudit = typeof guildConfigurationAudits.$inferSelect;

/** All unused value columns are explicit NULLs, including in confirmation evidence. */
export function configurationAudit(
  context: GuildConfigurationAuditContext,
  guildId: string,
  transition: Pick<GuildConfigurationAudit, "action" | "settingType" | "targetType" | "targetId"> &
    Partial<
      Pick<
        GuildConfigurationAudit,
        | "previousText"
        | "newText"
        | "previousInteger"
        | "newInteger"
        | "previousBoolean"
        | "newBoolean"
      >
    >,
): GuildConfigurationAudit {
  return {
    id: context.auditId,
    guildId,
    actorUserId: context.actorUserId,
    occurredAt: context.occurredAt,
    outcome: "SUCCESS",
    previousText: null,
    newText: null,
    previousInteger: null,
    newInteger: null,
    previousBoolean: null,
    newBoolean: null,
    ...transition,
  };
}

export function exactConfigurationAudit(
  actual: GuildConfigurationAudit | undefined,
  expected: GuildConfigurationAudit,
): boolean {
  return (
    actual !== undefined &&
    (Object.keys(expected) as (keyof GuildConfigurationAudit)[]).every((key) =>
      key === "occurredAt"
        ? actual.occurredAt.getTime() === expected.occurredAt.getTime()
        : actual[key] === expected[key],
    )
  );
}

export async function confirmConfigurationAudit(
  database: DatabaseClient,
  expected: GuildConfigurationAudit | undefined,
): Promise<boolean> {
  if (expected === undefined) return false;
  try {
    const [actual] = await database
      .select()
      .from(guildConfigurationAudits)
      .where(eq(guildConfigurationAudits.id, expected.id))
      .limit(1);
    return exactConfigurationAudit(actual, expected);
  } catch {
    return false;
  }
}

/** Signed int64 passed as decimal text; Discord IDs never pass through Number. */
export function automaticClosePolicyLockKey(guildId: string): string {
  const bytes = createHash("sha256")
    .update("weft:automatic-close-policy:v1\0")
    .update(guildId)
    .digest();
  return bytes.readBigInt64BE(0).toString();
}
