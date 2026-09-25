import { and, eq, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import { guildSettings } from "./guild-settings.js";

export const auditLogDestinationAudits = pgTable(
  "audit_log_destination_audits",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    previousChannelId: text("previous_channel_id"),
    newChannelId: text("new_channel_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
  },
  (table) => [
    check("audit_log_destination_audits_outcome_check", sql`${table.outcome} = 'SUCCESS'`),
    check(
      "audit_log_destination_audits_transition_check",
      sql`${table.previousChannelId} is distinct from ${table.newChannelId}`,
    ),
    check("audit_log_destination_audits_previous_nonempty", sql`${table.previousChannelId} <> ''`),
    check("audit_log_destination_audits_new_nonempty", sql`${table.newChannelId} <> ''`),
    index("audit_log_destination_audits_retention_idx").on(table.occurredAt, table.id),
  ],
);

export type DestinationChangeInput = {
  guildId: string;
  actorUserId: string;
  newChannelId: string | null;
  auditId: string;
  occurredAt: Date;
};

export type DestinationChangeResult =
  | { outcome: "CHANGED"; previousChannelId: string | null }
  | { outcome: "NO_CHANGE" }
  | { outcome: "UNCONFIRMED" };

export type AuditLogDestinationStore = {
  read: (guildId: string) => Promise<string | null>;
  change: (input: DestinationChangeInput) => Promise<DestinationChangeResult>;
};

export function createAuditLogDestinationStore(database: DatabaseClient): AuditLogDestinationStore {
  return {
    async read(guildId) {
      const [settings] = await database
        .select({ auditLogChannelId: guildSettings.auditLogChannelId })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, guildId))
        .limit(1);
      return settings?.auditLogChannelId ?? null;
    },
    async change(input) {
      let lockedPrevious: string | null | undefined;
      try {
        return await database.transaction(async (transaction) => {
          if (input.newChannelId !== null) {
            await transaction
              .insert(guildSettings)
              .values({ guildId: input.guildId })
              .onConflictDoNothing({ target: guildSettings.guildId });
          }
          const [settings] = await transaction
            .select({ auditLogChannelId: guildSettings.auditLogChannelId })
            .from(guildSettings)
            .where(eq(guildSettings.guildId, input.guildId))
            .limit(1)
            .for("update");
          if (settings === undefined) {
            if (input.newChannelId === null) return { outcome: "NO_CHANGE" };
            throw new Error("Audit destination settings row was not established");
          }
          lockedPrevious = settings.auditLogChannelId;
          if (lockedPrevious === input.newChannelId) return { outcome: "NO_CHANGE" };
          await transaction
            .update(guildSettings)
            .set({ auditLogChannelId: input.newChannelId, updatedAt: input.occurredAt })
            .where(eq(guildSettings.guildId, input.guildId));
          await transaction.insert(auditLogDestinationAudits).values({
            id: input.auditId,
            guildId: input.guildId,
            actorUserId: input.actorUserId,
            previousChannelId: lockedPrevious,
            newChannelId: input.newChannelId,
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
          });
          return { outcome: "CHANGED", previousChannelId: lockedPrevious };
        });
      } catch {
        if (lockedPrevious === undefined) return { outcome: "UNCONFIRMED" };
        try {
          const [audit] = await database
            .select()
            .from(auditLogDestinationAudits)
            .where(
              and(
                eq(auditLogDestinationAudits.id, input.auditId),
                eq(auditLogDestinationAudits.guildId, input.guildId),
              ),
            )
            .limit(1);
          if (
            audit?.actorUserId === input.actorUserId &&
            audit.previousChannelId === lockedPrevious &&
            audit.newChannelId === input.newChannelId &&
            audit.occurredAt.getTime() === input.occurredAt.getTime() &&
            audit.outcome === "SUCCESS"
          ) {
            return { outcome: "CHANGED", previousChannelId: lockedPrevious };
          }
        } catch {
          // An unreadable audit cannot prove the operation committed.
        }
        return { outcome: "UNCONFIRMED" };
      }
    },
  };
}
