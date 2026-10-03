import { and, eq, sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

import { isLinkPreviewMode, type LinkPreviewMode } from "./link-preview.js";
import type { DatabaseClient } from "./database.js";
import { guildSettings } from "./guild-settings.js";

export const linkPreviewAudits = pgTable(
  "link_preview_audits",
  {
    id: text("id").primaryKey(),
    guildId: text("guild_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    previousMode: text("previous_mode").notNull(),
    newMode: text("new_mode").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
  },
  (table) => [
    check("link_preview_audits_outcome_check", sql`${table.outcome} = 'SUCCESS'`),
    check(
      "link_preview_audits_transition_check",
      sql`${table.previousMode} is distinct from ${table.newMode}`,
    ),
    check(
      "link_preview_audits_previous_nonempty",
      sql`${table.previousMode} in ('hybrid', 'public-only', 'button-only', 'off')`,
    ),
    check(
      "link_preview_audits_new_nonempty",
      sql`${table.newMode} in ('hybrid', 'public-only', 'button-only', 'off')`,
    ),
    index("link_preview_audits_retention_idx").on(table.occurredAt, table.id),
  ],
);

export type PreviewModeChangeInput = {
  guildId: string;
  actorUserId: string;
  newMode: LinkPreviewMode;
  auditId: string;
  occurredAt: Date;
};

export type PreviewModeChangeResult =
  | { outcome: "CHANGED"; previousMode: LinkPreviewMode }
  | { outcome: "NO_CHANGE" }
  | { outcome: "UNCONFIRMED" };

export type LinkPreviewStore = {
  read: (guildId: string) => Promise<LinkPreviewMode>;
  change: (input: PreviewModeChangeInput) => Promise<PreviewModeChangeResult>;
};

export function createLinkPreviewStore(database: DatabaseClient): LinkPreviewStore {
  return {
    async read(guildId) {
      const [settings] = await database
        .select({ linkPreviewMode: guildSettings.linkPreviewMode })
        .from(guildSettings)
        .where(eq(guildSettings.guildId, guildId))
        .limit(1);
      const mode = settings?.linkPreviewMode ?? "hybrid";
      if (!isLinkPreviewMode(mode)) throw new Error("Invalid preview mode");
      return mode;
    },
    async change(input) {
      if (!isLinkPreviewMode(input.newMode)) throw new Error("Invalid preview mode");
      let lockedPrevious: LinkPreviewMode | undefined;
      try {
        return await database.transaction(async (transaction) => {
          await transaction
            .insert(guildSettings)
            .values({ guildId: input.guildId })
            .onConflictDoNothing({ target: guildSettings.guildId });
          const [settings] = await transaction
            .select({ linkPreviewMode: guildSettings.linkPreviewMode })
            .from(guildSettings)
            .where(eq(guildSettings.guildId, input.guildId))
            .limit(1)
            .for("update");
          if (settings === undefined) {
            throw new Error("Preview settings row was not established");
          }
          if (!isLinkPreviewMode(settings.linkPreviewMode)) throw new Error("Invalid preview mode");
          lockedPrevious = settings.linkPreviewMode;
          if (lockedPrevious === input.newMode) return { outcome: "NO_CHANGE" };
          await transaction
            .update(guildSettings)
            .set({ linkPreviewMode: input.newMode, updatedAt: input.occurredAt })
            .where(eq(guildSettings.guildId, input.guildId));
          await transaction.insert(linkPreviewAudits).values({
            id: input.auditId,
            guildId: input.guildId,
            actorUserId: input.actorUserId,
            previousMode: lockedPrevious,
            newMode: input.newMode,
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
          });
          return { outcome: "CHANGED", previousMode: lockedPrevious };
        });
      } catch {
        if (lockedPrevious === undefined) return { outcome: "UNCONFIRMED" };
        try {
          const [audit] = await database
            .select()
            .from(linkPreviewAudits)
            .where(
              and(
                eq(linkPreviewAudits.id, input.auditId),
                eq(linkPreviewAudits.guildId, input.guildId),
              ),
            )
            .limit(1);
          if (
            audit?.actorUserId === input.actorUserId &&
            audit.previousMode === lockedPrevious &&
            audit.newMode === input.newMode &&
            audit.occurredAt.getTime() === input.occurredAt.getTime() &&
            audit.outcome === "SUCCESS"
          ) {
            return { outcome: "CHANGED", previousMode: lockedPrevious };
          }
        } catch {
          // An unreadable audit cannot prove the operation committed.
        }
        return { outcome: "UNCONFIRMED" };
      }
    },
  };
}
