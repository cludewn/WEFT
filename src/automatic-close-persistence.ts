import { and, asc, eq, gt, lte, or, sql } from "drizzle-orm";
import { index, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import { DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS, guildSettings } from "./guild-settings.js";

/**
 * Parent channels whose threads may participate in automatic inactivity closing.
 *
 * The row records only WEFT's configured allowlist intent. Discord resource type and permissions
 * are revalidated by later runtime behavior rather than trusted from stored state.
 */
export const autoCloseParentChannels = pgTable(
  "auto_close_parent_channels",
  {
    guildId: text("guild_id").notNull(),
    parentChannelId: text("parent_channel_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.parentChannelId] })],
);

/**
 * Threads individually excluded from automatic inactivity closing.
 *
 * Row presence means the thread is excluded. Row absence means there is no individual exclusion;
 * it does not by itself make a thread eligible, because allowlisted parent membership is still
 * required.
 */
export const autoCloseThreadExclusions = pgTable(
  "auto_close_thread_exclusions",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.threadId] })],
);

/**
 * Latest qualifying activity observed for a thread.
 *
 * `parent_channel_id` is stored here so that a later database-driven sweep can compare activity
 * rows with parent-channel allowlist membership without fetching Discord state for every stored
 * thread. It is candidate-selection data only.
 */
export const autoCloseThreadActivity = pgTable(
  "auto_close_thread_activity",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    parentChannelId: text("parent_channel_id").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.guildId, table.threadId] }),
    index("auto_close_thread_activity_last_activity_guild_thread_idx").on(
      table.lastActivityAt,
      table.guildId,
      table.threadId,
    ),
  ],
);

/**
 * Latest inactivity episode known to have reached a terminal archived state.
 *
 * A retirement suppresses only the activity episode with the same `last_activity_at`. A newer
 * activity or re-entry baseline therefore starts a distinct episode without deleting this row.
 */
export const autoCloseThreadRetirements = pgTable(
  "auto_close_thread_retirements",
  {
    guildId: text("guild_id").notNull(),
    threadId: text("thread_id").notNull(),
    lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.guildId, table.threadId] })],
);

const AUTOMATIC_CLOSE_CANDIDATE_PAGE_SIZE = 100;

export type AutoCloseParentChannel = typeof autoCloseParentChannels.$inferSelect;
export type AutoCloseThreadExclusion = typeof autoCloseThreadExclusions.$inferSelect;
export type AutoCloseThreadActivity = typeof autoCloseThreadActivity.$inferSelect;
export type AutoCloseThreadRetirement = typeof autoCloseThreadRetirements.$inferSelect;

export type RecordThreadActivity = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  occurredAt: Date;
};

export type EnableAutoCloseParentChannel = {
  guildId: string;
  parentChannelId: string;
  enabledAt: Date;
  activeThreadIds: readonly string[];
};

export type EnableAutoCloseParentChannelResult =
  { outcome: "ENABLED"; baselinesApplied: number } | { outcome: "ALREADY_ENABLED" };

export type RecordQualifyingMessageActivity = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  occurredAt: Date;
  authorIsBot: boolean;
};

export type MissingActivityBaselineCandidate = {
  threadId: string;
  parentChannelId: string;
};

export type InitializeMissingActivityBaselines = {
  guildId: string;
  baselineAt: Date;
  candidates: readonly MissingActivityBaselineCandidate[];
};

export type AutoCloseParentChannelRef = {
  guildId: string;
  parentChannelId: string;
};

export type TrackAutomaticCloseThread = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  trackedAt: Date;
};

export type TrackAutomaticCloseThreadResult = {
  exclusionRemoved: boolean;
  parentEnabled: boolean;
};

export type AutomaticCloseThreadStatus = {
  parentEnabled: boolean;
  excluded: boolean;
  inactivitySeconds: number;
  lastActivityAt: Date | null;
};

export type AutomaticCloseCandidate = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  lastActivityAt: Date;
};

export type AutomaticCloseCandidateCursor = {
  lastActivityAt: Date;
  guildId: string;
  threadId: string;
};

export type FindInactiveAutomaticCloseCandidatesPage = {
  asOf: Date;
  cursor?: AutomaticCloseCandidateCursor;
};

export type AutomaticCloseEpisode = {
  guildId: string;
  threadId: string;
  lastActivityAt: Date;
};

export type RevalidateAutomaticCloseCandidateEpisode = AutomaticCloseEpisode & {
  parentChannelId: string;
  revalidatedAt: Date;
};

export type RecordThreadReentryBaseline = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
  reopenedAt: Date;
};

export type AutomaticClosePersistenceStore = {
  /**
   * Returns one provisional, read-only page of policy-eligible inactivity candidates.
   *
   * The caller supplies the stable sweep timestamp. Results are ordered by activity time, guild,
   * and thread and use the same tuple as a strictly-after keyset cursor.
   */
  findInactiveCandidatesPage: (
    input: FindInactiveAutomaticCloseCandidatesPage,
  ) => Promise<AutomaticCloseCandidate[]>;
  /** Returns whether the exact candidate episode is still eligible at the caller's timestamp. */
  isCandidateEpisodeEligible: (input: RevalidateAutomaticCloseCandidateEpisode) => Promise<boolean>;
  /** Retires an episode without ever replacing a newer retirement with an older one. */
  retireActivityEpisode: (input: AutomaticCloseEpisode) => Promise<void>;
  /** Returns whether the allowlist changed. Adding an existing pair is a successful no-op. */
  addParentChannel: (guildId: string, parentChannelId: string) => Promise<boolean>;
  /** Returns whether the allowlist changed. Removing an absent pair is a successful no-op. */
  removeParentChannel: (guildId: string, parentChannelId: string) => Promise<boolean>;
  /** Returns whether the exclusion state changed. */
  addThreadExclusion: (guildId: string, threadId: string) => Promise<boolean>;
  /**
   * Removes an individual exclusion and returns whether the exclusion state changed.
   *
   * This is a low-level persistence operation. `trackThread` is the complete command operation
   * because it also applies the required activity baseline semantics in the same transaction.
   */
  removeThreadExclusion: (guildId: string, threadId: string) => Promise<boolean>;
  /** Removes an exclusion and applies the approved re-entry baseline semantics atomically. */
  trackThread: (input: TrackAutomaticCloseThread) => Promise<TrackAutomaticCloseThreadResult>;
  /** Reads the current automatic-close status without repairing or creating persisted state. */
  findThreadStatus: (
    guildId: string,
    threadId: string,
    parentChannelId: string,
  ) => Promise<AutomaticCloseThreadStatus>;
  /** Applies `last_activity_at = max(existing, incoming)` atomically in PostgreSQL. */
  recordActivity: (input: RecordThreadActivity) => Promise<void>;
  /** Configured automatic-close parent channels for one guild, ordered by parent channel ID. */
  listParentChannels: (guildId: string) => Promise<string[]>;
  /**
   * Adds a parent channel to the allowlist and applies the enable timestamp as an activity floor
   * for the supplied active threads, in one transaction.
   *
   * The parent row is added only when absent. Baselines are applied only when the parent was
   * newly added, never for individually excluded threads, and never backward.
   */
  enableParentChannelWithBaselines: (
    input: EnableAutoCloseParentChannel,
  ) => Promise<EnableAutoCloseParentChannelResult>;
  /**
   * Evaluates automatic-close eligibility and applies the monotonic activity update in one
   * statement.
   *
   * Eligibility requires a currently allowlisted parent, no individual thread exclusion, and, for
   * bot authors, an enabled guild bot-message activity policy. A guild without a settings row
   * falls back to the approved defaults, so a human message still qualifies while a bot message
   * does not. Returns whether the activity row was inserted or advanced.
   */
  recordQualifyingMessageActivity: (input: RecordQualifyingMessageActivity) => Promise<boolean>;
  /** Applies an eligible archived-to-active re-entry baseline monotonically in one statement. */
  recordThreadReentryBaseline: (input: RecordThreadReentryBaseline) => Promise<boolean>;
  /**
   * Creates activity rows only for candidates that have none, in one statement.
   *
   * Candidates must currently sit under an allowlisted parent and must not be individually
   * excluded. An existing activity row is left completely unchanged: this never advances
   * `last_activity_at`, `parent_channel_id`, or `updated_at`. Returns how many rows were created.
   */
  initializeMissingActivityBaselines: (
    input: InitializeMissingActivityBaselines,
  ) => Promise<number>;
  /** Every configured automatic-close parent channel, ordered by guild then parent channel. */
  listAllParentChannels: () => Promise<AutoCloseParentChannelRef[]>;
};

export function createAutomaticClosePersistenceStore(
  database: DatabaseClient,
): AutomaticClosePersistenceStore {
  return {
    async findInactiveCandidatesPage({ asOf, cursor }) {
      const afterCursor =
        cursor === undefined
          ? undefined
          : or(
              gt(autoCloseThreadActivity.lastActivityAt, cursor.lastActivityAt),
              and(
                eq(autoCloseThreadActivity.lastActivityAt, cursor.lastActivityAt),
                gt(autoCloseThreadActivity.guildId, cursor.guildId),
              ),
              and(
                eq(autoCloseThreadActivity.lastActivityAt, cursor.lastActivityAt),
                eq(autoCloseThreadActivity.guildId, cursor.guildId),
                gt(autoCloseThreadActivity.threadId, cursor.threadId),
              ),
            );

      return database
        .select({
          guildId: autoCloseThreadActivity.guildId,
          threadId: autoCloseThreadActivity.threadId,
          parentChannelId: autoCloseThreadActivity.parentChannelId,
          // Selecting the TIMESTAMPTZ column directly applies Drizzle's runtime Date decoder.
          lastActivityAt: autoCloseThreadActivity.lastActivityAt,
        })
        .from(autoCloseThreadActivity)
        .innerJoin(
          autoCloseParentChannels,
          and(
            eq(autoCloseParentChannels.guildId, autoCloseThreadActivity.guildId),
            eq(autoCloseParentChannels.parentChannelId, autoCloseThreadActivity.parentChannelId),
          ),
        )
        .leftJoin(guildSettings, eq(guildSettings.guildId, autoCloseThreadActivity.guildId))
        .where(
          and(
            sql`not exists (
              select 1
              from ${autoCloseThreadExclusions} as excluded_thread
              where excluded_thread.guild_id = ${autoCloseThreadActivity.guildId}
                and excluded_thread.thread_id = ${autoCloseThreadActivity.threadId}
            )`,
            sql`not exists (
              select 1
              from ${autoCloseThreadRetirements} as retired_episode
              where retired_episode.guild_id = ${autoCloseThreadActivity.guildId}
                and retired_episode.thread_id = ${autoCloseThreadActivity.threadId}
                and retired_episode.last_activity_at = ${autoCloseThreadActivity.lastActivityAt}
            )`,
            lte(
              autoCloseThreadActivity.lastActivityAt,
              sql`${asOf}::timestamptz - coalesce(
                ${guildSettings.autoCloseInactivitySeconds},
                ${DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS}
              ) * interval '1 second'`,
            ),
            afterCursor,
          ),
        )
        .orderBy(
          asc(autoCloseThreadActivity.lastActivityAt),
          asc(autoCloseThreadActivity.guildId),
          asc(autoCloseThreadActivity.threadId),
        )
        .limit(AUTOMATIC_CLOSE_CANDIDATE_PAGE_SIZE);
    },
    async isCandidateEpisodeEligible({
      guildId,
      threadId,
      parentChannelId,
      lastActivityAt,
      revalidatedAt,
    }) {
      const [result] = await database
        .select({
          eligible: sql<boolean>`exists (
            select 1
            from ${autoCloseThreadActivity} as activity
            join ${autoCloseParentChannels} as parent
              on parent.guild_id = activity.guild_id
              and parent.parent_channel_id = activity.parent_channel_id
            left join ${guildSettings} as settings
              on settings.guild_id = activity.guild_id
            where activity.guild_id = ${guildId}
              and activity.thread_id = ${threadId}
              and activity.parent_channel_id = ${parentChannelId}
              and activity.last_activity_at = ${lastActivityAt}
              and activity.last_activity_at <= ${revalidatedAt}::timestamptz - coalesce(
                settings.auto_close_inactivity_seconds,
                ${DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS}
              ) * interval '1 second'
              and not exists (
                select 1
                from ${autoCloseThreadExclusions} as excluded_thread
                where excluded_thread.guild_id = activity.guild_id
                  and excluded_thread.thread_id = activity.thread_id
              )
              and not exists (
                select 1
                from ${autoCloseThreadRetirements} as retired_episode
                where retired_episode.guild_id = activity.guild_id
                  and retired_episode.thread_id = activity.thread_id
                  and retired_episode.last_activity_at = activity.last_activity_at
              )
          )`,
        })
        .from(sql`(select 1) as eligibility_source`)
        .limit(1);
      if (result === undefined) {
        throw new Error("Automatic close candidate eligibility could not be loaded");
      }
      return result.eligible;
    },
    async retireActivityEpisode({ guildId, threadId, lastActivityAt }) {
      await database
        .insert(autoCloseThreadRetirements)
        .values({ guildId, threadId, lastActivityAt })
        .onConflictDoUpdate({
          target: [autoCloseThreadRetirements.guildId, autoCloseThreadRetirements.threadId],
          set: {
            lastActivityAt: sql`excluded.last_activity_at`,
            updatedAt: new Date(),
          },
          setWhere: sql`${autoCloseThreadRetirements.lastActivityAt} < excluded.last_activity_at`,
        });
    },
    async addParentChannel(guildId, parentChannelId) {
      const inserted = await database
        .insert(autoCloseParentChannels)
        .values({ guildId, parentChannelId })
        .onConflictDoNothing({
          target: [autoCloseParentChannels.guildId, autoCloseParentChannels.parentChannelId],
        })
        .returning({ guildId: autoCloseParentChannels.guildId });
      return inserted.length > 0;
    },
    async removeParentChannel(guildId, parentChannelId) {
      const removed = await database
        .delete(autoCloseParentChannels)
        .where(
          and(
            eq(autoCloseParentChannels.guildId, guildId),
            eq(autoCloseParentChannels.parentChannelId, parentChannelId),
          ),
        )
        .returning({ guildId: autoCloseParentChannels.guildId });
      return removed.length > 0;
    },
    async addThreadExclusion(guildId, threadId) {
      const inserted = await database
        .insert(autoCloseThreadExclusions)
        .values({ guildId, threadId })
        .onConflictDoNothing({
          target: [autoCloseThreadExclusions.guildId, autoCloseThreadExclusions.threadId],
        })
        .returning({ guildId: autoCloseThreadExclusions.guildId });
      return inserted.length > 0;
    },
    async removeThreadExclusion(guildId, threadId) {
      const removed = await database
        .delete(autoCloseThreadExclusions)
        .where(
          and(
            eq(autoCloseThreadExclusions.guildId, guildId),
            eq(autoCloseThreadExclusions.threadId, threadId),
          ),
        )
        .returning({ guildId: autoCloseThreadExclusions.guildId });
      return removed.length > 0;
    },
    async trackThread({ guildId, threadId, parentChannelId, trackedAt }) {
      return database.transaction(
        async (dbTransaction): Promise<TrackAutomaticCloseThreadResult> => {
          const removed = await dbTransaction
            .delete(autoCloseThreadExclusions)
            .where(
              and(
                eq(autoCloseThreadExclusions.guildId, guildId),
                eq(autoCloseThreadExclusions.threadId, threadId),
              ),
            )
            .returning({ guildId: autoCloseThreadExclusions.guildId });

          const [parent] = await dbTransaction
            .select({ parentChannelId: autoCloseParentChannels.parentChannelId })
            .from(autoCloseParentChannels)
            .where(
              and(
                eq(autoCloseParentChannels.guildId, guildId),
                eq(autoCloseParentChannels.parentChannelId, parentChannelId),
              ),
            )
            .limit(1);

          const exclusionRemoved = removed.length > 0;
          const parentEnabled = parent !== undefined;
          if (!parentEnabled) {
            return { exclusionRemoved, parentEnabled };
          }

          if (exclusionRemoved) {
            const writtenAt = new Date();
            await dbTransaction.execute(sql`
            insert into ${autoCloseThreadActivity}
              (guild_id, thread_id, parent_channel_id, last_activity_at, updated_at)
            values (${guildId}, ${threadId}, ${parentChannelId}, ${trackedAt}, ${writtenAt})
            on conflict (guild_id, thread_id) do update
            set last_activity_at  = excluded.last_activity_at,
                parent_channel_id = excluded.parent_channel_id,
                updated_at        = excluded.updated_at
            where ${autoCloseThreadActivity}.last_activity_at < excluded.last_activity_at
          `);
          } else {
            await dbTransaction
              .insert(autoCloseThreadActivity)
              .values({ guildId, threadId, parentChannelId, lastActivityAt: trackedAt })
              .onConflictDoNothing({
                target: [autoCloseThreadActivity.guildId, autoCloseThreadActivity.threadId],
              });
          }

          return { exclusionRemoved, parentEnabled };
        },
      );
    },
    async findThreadStatus(guildId, threadId, parentChannelId) {
      const [status] = await database
        .select({
          parentEnabled: sql<boolean>`exists (
            select 1
            from ${autoCloseParentChannels} as parent
            where parent.guild_id = ${guildId}
              and parent.parent_channel_id = ${parentChannelId}
          )`,
          excluded: sql<boolean>`exists (
            select 1
            from ${autoCloseThreadExclusions} as excluded_thread
            where excluded_thread.guild_id = ${guildId}
              and excluded_thread.thread_id = ${threadId}
          )`,
          inactivitySeconds: sql<number>`coalesce(
            (
              select settings.auto_close_inactivity_seconds
              from ${guildSettings} as settings
              where settings.guild_id = ${guildId}
            ),
            ${DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS}
          )`,
          lastActivityAt: sql<Date | null>`(
            select activity.last_activity_at
            from ${autoCloseThreadActivity} as activity
            where activity.guild_id = ${guildId}
              and activity.thread_id = ${threadId}
          )`.mapWith(autoCloseThreadActivity.lastActivityAt),
        })
        .from(sql`(select 1) as status_source`)
        .limit(1);

      if (status === undefined) {
        throw new Error("Automatic close thread status could not be loaded");
      }
      return {
        ...status,
        lastActivityAt: status.lastActivityAt ?? null,
      };
    },
    async listParentChannels(guildId) {
      const rows = await database
        .select({ parentChannelId: autoCloseParentChannels.parentChannelId })
        .from(autoCloseParentChannels)
        .where(eq(autoCloseParentChannels.guildId, guildId))
        .orderBy(asc(autoCloseParentChannels.parentChannelId));
      return rows.map((row) => row.parentChannelId);
    },
    async enableParentChannelWithBaselines({
      guildId,
      parentChannelId,
      enabledAt,
      activeThreadIds,
    }) {
      return database.transaction(
        async (dbTransaction): Promise<EnableAutoCloseParentChannelResult> => {
          const inserted = await dbTransaction
            .insert(autoCloseParentChannels)
            .values({ guildId, parentChannelId })
            .onConflictDoNothing({
              target: [autoCloseParentChannels.guildId, autoCloseParentChannels.parentChannelId],
            })
            .returning({ guildId: autoCloseParentChannels.guildId });

          if (inserted.length === 0) {
            return { outcome: "ALREADY_ENABLED" };
          }

          // A repeated thread ID would make one ON CONFLICT DO UPDATE affect the same row twice.
          const candidates = [...new Set(activeThreadIds)];
          if (candidates.length === 0) {
            return { outcome: "ENABLED", baselinesApplied: 0 };
          }

          // One statement applies `last_activity_at = max(existing, enabled_at)` for every
          // supplied thread. Excluded threads are skipped, and a stale or equal baseline leaves
          // `last_activity_at`, `parent_channel_id`, and `updated_at` untouched.
          const applied = await dbTransaction.execute(sql`
            insert into ${autoCloseThreadActivity}
              (guild_id, thread_id, parent_channel_id, last_activity_at, updated_at)
            select
              ${guildId}, candidate.thread_id, ${parentChannelId}, ${enabledAt}, ${new Date()}
            from unnest(${sql.param(candidates)}::text[]) as candidate(thread_id)
            where not exists (
              select 1
              from ${autoCloseThreadExclusions} as excluded_thread
              where excluded_thread.guild_id = ${guildId}
                and excluded_thread.thread_id = candidate.thread_id
            )
            on conflict (guild_id, thread_id) do update
            set last_activity_at  = excluded.last_activity_at,
                parent_channel_id = excluded.parent_channel_id,
                updated_at        = excluded.updated_at
            where ${autoCloseThreadActivity}.last_activity_at < excluded.last_activity_at
            returning thread_id
          `);

          return { outcome: "ENABLED", baselinesApplied: applied.rows.length };
        },
      );
    },
    async listAllParentChannels() {
      return database
        .select({
          guildId: autoCloseParentChannels.guildId,
          parentChannelId: autoCloseParentChannels.parentChannelId,
        })
        .from(autoCloseParentChannels)
        .orderBy(
          asc(autoCloseParentChannels.guildId),
          asc(autoCloseParentChannels.parentChannelId),
        );
    },
    async recordQualifyingMessageActivity({
      guildId,
      threadId,
      parentChannelId,
      occurredAt,
      authorIsBot,
    }) {
      // One statement evaluates the current allowlist, exclusion, and bot-message policy, then
      // applies `last_activity_at = max(existing, incoming)`. A guild without a settings row falls
      // back to the approved defaults through the left join, so a human message still qualifies
      // while a bot message does not.
      const applied = await database.execute(sql`
        insert into ${autoCloseThreadActivity}
          (guild_id, thread_id, parent_channel_id, last_activity_at, updated_at)
        select ${guildId}, ${threadId}, ${parentChannelId}, ${occurredAt}, ${new Date()}
        from ${autoCloseParentChannels} as parent
        left join ${guildSettings} as settings on settings.guild_id = parent.guild_id
        where parent.guild_id = ${guildId}
          and parent.parent_channel_id = ${parentChannelId}
          and (
            not ${authorIsBot}::boolean
            or coalesce(settings.auto_close_bot_messages_count_as_activity, false)
          )
          and not exists (
            select 1
            from ${autoCloseThreadExclusions} as excluded_thread
            where excluded_thread.guild_id = ${guildId}
              and excluded_thread.thread_id = ${threadId}
          )
        on conflict (guild_id, thread_id) do update
        set last_activity_at  = excluded.last_activity_at,
            parent_channel_id = excluded.parent_channel_id,
            updated_at        = excluded.updated_at
        where ${autoCloseThreadActivity}.last_activity_at < excluded.last_activity_at
        returning thread_id
      `);
      return applied.rows.length > 0;
    },
    async recordThreadReentryBaseline({ guildId, threadId, parentChannelId, reopenedAt }) {
      // Re-entry is not message activity. This one statement applies only the current parent and
      // exclusion policy, then advances the activity episode monotonically.
      const applied = await database.execute(sql`
        insert into ${autoCloseThreadActivity}
          (guild_id, thread_id, parent_channel_id, last_activity_at, updated_at)
        select ${guildId}, ${threadId}, ${parentChannelId}, ${reopenedAt}, ${new Date()}
        from ${autoCloseParentChannels} as parent
        where parent.guild_id = ${guildId}
          and parent.parent_channel_id = ${parentChannelId}
          and not exists (
            select 1
            from ${autoCloseThreadExclusions} as excluded_thread
            where excluded_thread.guild_id = ${guildId}
              and excluded_thread.thread_id = ${threadId}
          )
        on conflict (guild_id, thread_id) do update
        set last_activity_at  = excluded.last_activity_at,
            parent_channel_id = excluded.parent_channel_id,
            updated_at        = excluded.updated_at
        where ${autoCloseThreadActivity}.last_activity_at < excluded.last_activity_at
        returning thread_id
      `);
      return applied.rows.length > 0;
    },
    async initializeMissingActivityBaselines({ guildId, baselineAt, candidates }) {
      // Keep the first parent channel seen for a thread so the inserted row and the returned count
      // stay deterministic when a caller supplies duplicates.
      const unique = new Map<string, string>();
      for (const candidate of candidates) {
        if (!unique.has(candidate.threadId)) {
          unique.set(candidate.threadId, candidate.parentChannelId);
        }
      }
      if (unique.size === 0) {
        return 0;
      }

      const threadIds = [...unique.keys()];
      const parentChannelIds = [...unique.values()];

      // Insert-only. An existing activity row keeps its `last_activity_at`, `parent_channel_id`,
      // and `updated_at`, which is deliberately different from the parent-enable activity floor.
      const inserted = await database.execute(sql`
        insert into ${autoCloseThreadActivity}
          (guild_id, thread_id, parent_channel_id, last_activity_at)
        select ${guildId}, candidate.thread_id, candidate.parent_channel_id, ${baselineAt}
        from unnest(${sql.param(threadIds)}::text[], ${sql.param(parentChannelIds)}::text[])
          as candidate(thread_id, parent_channel_id)
        join ${autoCloseParentChannels} as parent
          on parent.guild_id = ${guildId}
          and parent.parent_channel_id = candidate.parent_channel_id
        where not exists (
          select 1
          from ${autoCloseThreadExclusions} as excluded_thread
          where excluded_thread.guild_id = ${guildId}
            and excluded_thread.thread_id = candidate.thread_id
        )
        on conflict (guild_id, thread_id) do nothing
        returning thread_id
      `);
      return inserted.rows.length;
    },
    async recordActivity({ guildId, threadId, parentChannelId, occurredAt }) {
      await database
        .insert(autoCloseThreadActivity)
        .values({ guildId, threadId, parentChannelId, lastActivityAt: occurredAt })
        .onConflictDoUpdate({
          target: [autoCloseThreadActivity.guildId, autoCloseThreadActivity.threadId],
          set: {
            lastActivityAt: sql`excluded.last_activity_at`,
            parentChannelId: sql`excluded.parent_channel_id`,
            updatedAt: new Date(),
          },
          setWhere: sql`${autoCloseThreadActivity.lastActivityAt} < excluded.last_activity_at`,
        });
    },
  };
}
