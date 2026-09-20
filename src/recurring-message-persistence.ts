import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  time,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

import type { DatabaseClient } from "./database.js";
import type { ManagedMessagePayload } from "./managed-message-payload.js";
import {
  findNextOccurrence,
  isStrictRecurringLocalTime,
  validateRecurrence,
  type DstGapCandidate,
  type RecurrenceDefinition,
  type RecurringMessageFrequency,
} from "./recurring-message.js";
import { scheduledActions, type ScheduledAction } from "./scheduled-action-persistence.js";
import {
  scheduledMessagePayloadFromColumns,
  scheduledMessagePayloadToColumns,
  scheduledMessageStates,
} from "./scheduled-message-persistence.js";

function allNull(columns: AnyPgColumn[]) {
  return sql.join(
    columns.map((column) => sql`${column} is null`),
    sql` and `,
  );
}

export const RECURRING_OCCURRENCE_STATUSES = [
  "PENDING",
  "EXECUTING",
  "RETRY_PENDING",
  "COMPLETED",
  "FAILED",
  "SKIPPED",
] as const;
export type RecurringOccurrenceStatus = (typeof RECURRING_OCCURRENCE_STATUSES)[number];

export const RECURRING_OCCURRENCE_FAILURE_CODES = [
  "UNSUPPORTED_TARGET",
  "TARGET_GUILD_MISMATCH",
  "ARCHIVED_THREAD",
  "BOT_PERMISSION_MISSING",
  "CURRENT_STATE_CHECK_REJECTED",
  "CURRENT_STATE_CHECK_FAILED",
  "PERSISTED_PAYLOAD_INVALID",
  "SEND_REJECTED",
  "SEND_UNCONFIRMED",
  "RETURNED_MESSAGE_MISMATCH",
  "FINALIZATION_FAILED_COMPENSATED",
  "FINALIZATION_FAILED_UNCOMPENSATED",
  "EXECUTION_INTERRUPTED_UNCONFIRMED",
  "PRE_SEND_RETRY_WINDOW_EXCEEDED",
] as const;
export type RecurringOccurrenceFailureCode = (typeof RECURRING_OCCURRENCE_FAILURE_CODES)[number];

export const RECURRING_OCCURRENCE_SKIP_REASONS = [
  "RECURRENCE_EDITED",
  "SERIES_CANCELLED",
  "MISSED_GRACE_EXCEEDED",
] as const;
export type RecurringOccurrenceSkipReason = (typeof RECURRING_OCCURRENCE_SKIP_REASONS)[number];

export const RECURRING_MESSAGE_AUDIT_EVENTS = [
  "SERIES_CREATED",
  "PAYLOAD_EDITED",
  "RECURRENCE_EDITED",
  "SERIES_CANCELLED",
  "OCCURRENCE_RETRY",
  "OCCURRENCE_COMPLETED",
  "OCCURRENCE_FAILED",
  "DST_GAP_SKIPPED",
  "MISSED_RANGE_SKIPPED",
] as const;
export type RecurringMessageAuditEvent = (typeof RECURRING_MESSAGE_AUDIT_EVENTS)[number];

export const recurringMessageSchedules = pgTable(
  "recurring_message_schedules",
  {
    scheduledActionId: text("scheduled_action_id")
      .primaryKey()
      .references(() => scheduledActions.id),
    timezone: text("timezone").notNull(),
    frequency: text("frequency").$type<RecurringMessageFrequency>().notNull(),
    weekdayMask: integer("weekday_mask").notNull(),
    localTime: time("local_time").notNull(),
    definitionRevision: integer("definition_revision").notNull(),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "recurring_message_schedules_recurrence_check",
      sql`(${table.frequency} = 'DAILY' and ${table.weekdayMask} = 127)
        or (${table.frequency} = 'WEEKLY' and ${table.weekdayMask} between 1 and 127)`,
    ),
    check(
      "recurring_message_schedules_timezone_check",
      sql`char_length(${table.timezone}) > 0 and left(${table.timezone}, 1) not in ('+', '-')`,
    ),
    check(
      "recurring_message_schedules_definition_revision_check",
      sql`${table.definitionRevision} >= 0`,
    ),
    check(
      "recurring_message_schedules_local_time_check",
      sql`extract(second from ${table.localTime}) = 0`,
    ),
  ],
);

export const recurringMessageOccurrences = pgTable(
  "recurring_message_occurrences",
  {
    id: text("id").primaryKey(),
    scheduledActionId: text("scheduled_action_id").notNull(),
    materializedDefinitionRevision: integer("materialized_definition_revision").notNull(),
    intendedLocalDate: date("intended_local_date").notNull(),
    intendedLocalTime: time("intended_local_time").notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    status: text("status").$type<RecurringOccurrenceStatus>().notNull(),
    retryCount: integer("retry_count").notNull().default(0),
    firstAttemptedAt: timestamp("first_attempted_at", { withTimezone: true }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    claimedSeriesRevision: integer("claimed_series_revision"),
    claimedDefinitionRevision: integer("claimed_definition_revision"),
    claimContent: text("claim_content"),
    claimEmbedTitle: text("claim_embed_title"),
    claimEmbedDescription: text("claim_embed_description"),
    claimEmbedColor: integer("claim_embed_color"),
    claimEmbedImageUrl: text("claim_embed_image_url"),
    resultMessageId: text("result_message_id"),
    failureCode: text("failure_code").$type<RecurringOccurrenceFailureCode>(),
    skipReason: text("skip_reason").$type<RecurringOccurrenceSkipReason>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: "recurring_message_occurrences_series_fk",
      columns: [table.scheduledActionId],
      foreignColumns: [recurringMessageSchedules.scheduledActionId],
    }),
    check(
      "recurring_message_occurrences_status_check",
      sql`${table.status} in ('PENDING', 'EXECUTING', 'RETRY_PENDING', 'COMPLETED', 'FAILED', 'SKIPPED')`,
    ),
    check(
      "recurring_message_occurrences_retry_count_check",
      sql`${table.retryCount} between 0 and 3`,
    ),
    check(
      "recurring_message_occurrences_local_time_check",
      sql`extract(second from ${table.intendedLocalTime}) = 0`,
    ),
    check(
      "recurring_message_occurrences_failure_code_check",
      sql`${table.failureCode} is null or ${table.failureCode} in (
        'UNSUPPORTED_TARGET', 'TARGET_GUILD_MISMATCH', 'ARCHIVED_THREAD',
        'BOT_PERMISSION_MISSING', 'CURRENT_STATE_CHECK_REJECTED', 'CURRENT_STATE_CHECK_FAILED',
        'PERSISTED_PAYLOAD_INVALID', 'SEND_REJECTED', 'SEND_UNCONFIRMED',
        'RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_COMPENSATED',
        'FINALIZATION_FAILED_UNCOMPENSATED', 'EXECUTION_INTERRUPTED_UNCONFIRMED',
        'PRE_SEND_RETRY_WINDOW_EXCEEDED')`,
    ),
    check(
      "recurring_message_occurrences_skip_reason_check",
      sql`${table.skipReason} is null or ${table.skipReason} in
        ('RECURRENCE_EDITED', 'SERIES_CANCELLED', 'MISSED_GRACE_EXCEEDED')`,
    ),
    check(
      "recurring_message_occurrences_claim_payload_check",
      sql`${table.claimContent} is null or (
        char_length(${table.claimContent}) between 0 and 2000
        and (${table.claimEmbedTitle} is null or char_length(${table.claimEmbedTitle}) between 1 and 256)
        and (${table.claimEmbedDescription} is null or char_length(${table.claimEmbedDescription}) between 1 and 4000)
        and (${table.claimEmbedColor} is null or ${table.claimEmbedColor} between 0 and 16777215)
        and (${table.claimEmbedImageUrl} is null or char_length(${table.claimEmbedImageUrl}) between 1 and 2048)
        and (${table.claimEmbedColor} is null or ${table.claimEmbedTitle} is not null
          or ${table.claimEmbedDescription} is not null or ${table.claimEmbedImageUrl} is not null)
        and (char_length(${table.claimContent}) > 0 or ${table.claimEmbedTitle} is not null
          or ${table.claimEmbedDescription} is not null or ${table.claimEmbedImageUrl} is not null))`,
    ),
    check(
      "recurring_message_occurrences_claim_revision_check",
      sql`${table.claimedDefinitionRevision} is null
        or ${table.claimedDefinitionRevision} = ${table.materializedDefinitionRevision}`,
    ),
    check(
      "recurring_message_occurrences_lifecycle_shape_check",
      sql`(
        ${table.status} = 'PENDING' and ${table.retryCount} = 0
        and ${table.firstAttemptedAt} is null and ${table.claimedAt} is null
        and ${table.claimedSeriesRevision} is null and ${table.claimedDefinitionRevision} is null
        and ${table.claimContent} is null and ${table.claimEmbedTitle} is null
        and ${table.claimEmbedDescription} is null and ${table.claimEmbedColor} is null
        and ${table.claimEmbedImageUrl} is null and ${table.resultMessageId} is null
        and ${table.failureCode} is null and ${table.skipReason} is null and ${table.terminalAt} is null
      ) or (
        ${table.status} in ('EXECUTING', 'RETRY_PENDING', 'COMPLETED', 'FAILED')
        and ${table.firstAttemptedAt} is not null and ${table.claimedAt} is not null
        and ${table.claimedSeriesRevision} is not null and ${table.claimedDefinitionRevision} is not null
        and ${table.claimContent} is not null
        and (${table.status} <> 'EXECUTING' or (${table.resultMessageId} is null
          and ${table.failureCode} is null and ${table.skipReason} is null and ${table.terminalAt} is null))
        and (${table.status} <> 'RETRY_PENDING' or (${table.retryCount} between 1 and 3
          and ${table.resultMessageId} is null and ${table.failureCode} is null
          and ${table.skipReason} is null and ${table.terminalAt} is null))
        and (${table.status} <> 'COMPLETED' or (${table.resultMessageId} is not null
          and ${table.failureCode} is null and ${table.skipReason} is null and ${table.terminalAt} is not null))
        and (${table.status} <> 'FAILED' or (${table.failureCode} is not null
          and ${table.skipReason} is null and ${table.terminalAt} is not null
          and (${table.resultMessageId} is null or ${table.failureCode} in
            ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))))
      ) or (
        ${table.status} = 'SKIPPED' and ${table.failureCode} is null
        and ${table.resultMessageId} is null and ${table.skipReason} is not null
        and ${table.terminalAt} is not null
        and ((
          ${table.firstAttemptedAt} is null and ${table.claimedAt} is null
          and ${table.claimedSeriesRevision} is null and ${table.claimedDefinitionRevision} is null
          and ${table.claimContent} is null and ${table.claimEmbedTitle} is null
          and ${table.claimEmbedDescription} is null and ${table.claimEmbedColor} is null
          and ${table.claimEmbedImageUrl} is null and ${table.retryCount} = 0
        ) or (
          ${table.firstAttemptedAt} is not null and ${table.claimedAt} is not null
          and ${table.claimedSeriesRevision} is not null and ${table.claimedDefinitionRevision} is not null
          and ${table.claimContent} is not null and ${table.retryCount} between 1 and 3
          and ${table.skipReason} = 'SERIES_CANCELLED'
        ))
      )`,
    ),
    uniqueIndex("recurring_message_occurrences_nonterminal_unique")
      .on(table.scheduledActionId)
      .where(sql`${table.status} in ('PENDING', 'EXECUTING', 'RETRY_PENDING')`),
    uniqueIndex("recurring_message_occurrences_materialization_unique").on(
      table.scheduledActionId,
      table.materializedDefinitionRevision,
      table.intendedLocalDate,
      table.intendedLocalTime,
    ),
    index("recurring_message_occurrences_series_status_idx").on(
      table.scheduledActionId,
      table.status,
    ),
  ],
);

export const recurringMessageAudits = pgTable(
  "recurring_message_audits",
  {
    id: text("id").primaryKey(),
    scheduledActionId: text("scheduled_action_id").notNull(),
    occurrenceId: text("occurrence_id"),
    guildId: text("guild_id").notNull(),
    channelId: text("channel_id").notNull(),
    event: text("event").$type<RecurringMessageAuditEvent>().notNull(),
    actorType: text("actor_type").$type<"USER" | "SYSTEM">().notNull(),
    actorId: text("actor_id"),
    beforeRevision: integer("before_revision"),
    afterRevision: integer("after_revision"),
    beforeContent: text("before_content"),
    afterContent: text("after_content"),
    beforeEmbedTitle: text("before_embed_title"),
    afterEmbedTitle: text("after_embed_title"),
    beforeEmbedDescription: text("before_embed_description"),
    afterEmbedDescription: text("after_embed_description"),
    beforeEmbedColor: integer("before_embed_color"),
    afterEmbedColor: integer("after_embed_color"),
    beforeEmbedImageUrl: text("before_embed_image_url"),
    afterEmbedImageUrl: text("after_embed_image_url"),
    beforeFrequency: text("before_frequency").$type<RecurringMessageFrequency>(),
    afterFrequency: text("after_frequency").$type<RecurringMessageFrequency>(),
    beforeWeekdayMask: integer("before_weekday_mask"),
    afterWeekdayMask: integer("after_weekday_mask"),
    beforeLocalTime: time("before_local_time"),
    afterLocalTime: time("after_local_time"),
    beforeTimezone: text("before_timezone"),
    afterTimezone: text("after_timezone"),
    beforeDefinitionRevision: integer("before_definition_revision"),
    afterDefinitionRevision: integer("after_definition_revision"),
    beforeEffectiveAt: timestamp("before_effective_at", { withTimezone: true }),
    afterEffectiveAt: timestamp("after_effective_at", { withTimezone: true }),
    currentOccurrenceId: text("current_occurrence_id"),
    deferredMaterialization: boolean("deferred_materialization"),
    selectedNextOccurrenceId: text("selected_next_occurrence_id"),
    selectedNextLocalDate: date("selected_next_local_date"),
    selectedNextLocalTime: time("selected_next_local_time"),
    selectedNextScheduledFor: timestamp("selected_next_scheduled_for", { withTimezone: true }),
    intendedLocalDate: date("intended_local_date"),
    intendedLocalTime: time("intended_local_time"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
    claimedSeriesRevision: integer("claimed_series_revision"),
    claimedDefinitionRevision: integer("claimed_definition_revision"),
    retryCount: integer("retry_count"),
    resultMessageId: text("result_message_id"),
    failureCode: text("failure_code").$type<RecurringOccurrenceFailureCode>(),
    occurrenceSkipReason: text("occurrence_skip_reason").$type<RecurringOccurrenceSkipReason>(),
    nextOccurrenceId: text("next_occurrence_id"),
    nextIntendedLocalDate: date("next_intended_local_date"),
    nextIntendedLocalTime: time("next_intended_local_time"),
    nextScheduledFor: timestamp("next_scheduled_for", { withTimezone: true }),
    postSeriesStatus: text("post_series_status").$type<"ACTIVE" | "CANCELLED">(),
    rangeStartOccurrenceId: text("range_start_occurrence_id"),
    skippedFromLocalDate: date("skipped_from_local_date"),
    skippedFromLocalTime: time("skipped_from_local_time"),
    skippedThroughLocalDate: date("skipped_through_local_date"),
    skippedThroughLocalTime: time("skipped_through_local_time"),
    auditSkipReason: text("audit_skip_reason").$type<"DST_GAP" | "MISSED_GRACE_EXCEEDED">(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").$type<"SUCCESS" | "FAILURE" | "SKIPPED">().notNull(),
  },
  (table) => [
    foreignKey({
      name: "recurring_message_audits_series_fk",
      columns: [table.scheduledActionId],
      foreignColumns: [recurringMessageSchedules.scheduledActionId],
    }),
    foreignKey({
      name: "recurring_message_audits_occurrence_fk",
      columns: [table.occurrenceId],
      foreignColumns: [recurringMessageOccurrences.id],
    }),
    check(
      "recurring_message_audits_event_check",
      sql`${table.event} in ('SERIES_CREATED', 'PAYLOAD_EDITED', 'RECURRENCE_EDITED',
        'SERIES_CANCELLED', 'OCCURRENCE_RETRY', 'OCCURRENCE_COMPLETED', 'OCCURRENCE_FAILED',
        'DST_GAP_SKIPPED', 'MISSED_RANGE_SKIPPED')`,
    ),
    check(
      "recurring_message_audits_common_check",
      sql`${table.actorType} in ('USER', 'SYSTEM')
        and ${table.outcome} in ('SUCCESS', 'FAILURE', 'SKIPPED')
        and ((${table.actorType} = 'USER' and ${table.actorId} is not null)
          or (${table.actorType} = 'SYSTEM' and ${table.actorId} is null))`,
    ),
    check(
      "recurring_message_audits_bounded_values_check",
      sql`(${table.failureCode} is null or ${table.failureCode} in (
          'UNSUPPORTED_TARGET', 'TARGET_GUILD_MISMATCH', 'ARCHIVED_THREAD',
          'BOT_PERMISSION_MISSING', 'CURRENT_STATE_CHECK_REJECTED', 'CURRENT_STATE_CHECK_FAILED',
          'PERSISTED_PAYLOAD_INVALID', 'SEND_REJECTED', 'SEND_UNCONFIRMED',
          'RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_COMPENSATED',
          'FINALIZATION_FAILED_UNCOMPENSATED', 'EXECUTION_INTERRUPTED_UNCONFIRMED',
          'PRE_SEND_RETRY_WINDOW_EXCEEDED'))
        and (${table.occurrenceSkipReason} is null or ${table.occurrenceSkipReason} in
          ('RECURRENCE_EDITED', 'SERIES_CANCELLED', 'MISSED_GRACE_EXCEEDED'))
        and (${table.postSeriesStatus} is null or ${table.postSeriesStatus} in ('ACTIVE', 'CANCELLED'))
        and (${table.auditSkipReason} is null or ${table.auditSkipReason} in
          ('DST_GAP', 'MISSED_GRACE_EXCEEDED'))
        and (${table.retryCount} is null or ${table.retryCount} between 0 and 3)
        and (${table.beforeRevision} is null or ${table.beforeRevision} >= 0)
        and (${table.afterRevision} is null or ${table.afterRevision} >= 0)
        and (${table.beforeDefinitionRevision} is null or ${table.beforeDefinitionRevision} >= 0)
        and (${table.afterDefinitionRevision} is null or ${table.afterDefinitionRevision} >= 0)`,
    ),
    check(
      "recurring_message_audits_local_times_check",
      sql`(${table.beforeLocalTime} is null or extract(second from ${table.beforeLocalTime}) = 0)
        and (${table.afterLocalTime} is null or extract(second from ${table.afterLocalTime}) = 0)
        and (${table.selectedNextLocalTime} is null or extract(second from ${table.selectedNextLocalTime}) = 0)
        and (${table.intendedLocalTime} is null or extract(second from ${table.intendedLocalTime}) = 0)
        and (${table.nextIntendedLocalTime} is null or extract(second from ${table.nextIntendedLocalTime}) = 0)
        and (${table.skippedFromLocalTime} is null or extract(second from ${table.skippedFromLocalTime}) = 0)
        and (${table.skippedThroughLocalTime} is null or extract(second from ${table.skippedThroughLocalTime}) = 0)`,
    ),
    check(
      "recurring_message_audits_event_shape_check",
      sql`(
        ${table.event} = 'SERIES_CREATED' and ${table.actorType} = 'USER'
        and ${table.outcome} = 'SUCCESS' and ${table.afterRevision} is not null
        and ${table.afterFrequency} is not null and ${table.afterWeekdayMask} is not null
        and ${table.afterLocalTime} is not null and ${table.afterTimezone} is not null
        and ${table.afterDefinitionRevision} is not null and ${table.afterEffectiveAt} is not null
        and ${table.afterContent} is not null
        and ${table.selectedNextOccurrenceId} is not null and ${table.selectedNextLocalDate} is not null
        and ${table.selectedNextLocalTime} is not null and ${table.selectedNextScheduledFor} is not null
      ) or (
        ${table.event} = 'PAYLOAD_EDITED' and ${table.actorType} = 'USER'
        and ${table.outcome} = 'SUCCESS' and ${table.beforeRevision} is not null
        and ${table.afterRevision} is not null and ${table.beforeContent} is not null
        and ${table.afterContent} is not null
      ) or (
        ${table.event} = 'RECURRENCE_EDITED' and ${table.actorType} = 'USER'
        and ${table.outcome} = 'SUCCESS' and ${table.beforeRevision} is not null
        and ${table.afterRevision} is not null and ${table.beforeFrequency} is not null
        and ${table.afterFrequency} is not null and ${table.beforeTimezone} is not null
        and ${table.afterTimezone} is not null and ${table.beforeWeekdayMask} is not null
        and ${table.afterWeekdayMask} is not null and ${table.beforeLocalTime} is not null
        and ${table.afterLocalTime} is not null and ${table.beforeDefinitionRevision} is not null
        and ${table.afterDefinitionRevision} is not null and ${table.beforeEffectiveAt} is not null
        and ${table.afterEffectiveAt} is not null and ${table.currentOccurrenceId} is not null
        and ${table.deferredMaterialization} is not null
        and ((${table.deferredMaterialization} and ${table.selectedNextOccurrenceId} is null
          and ${table.selectedNextLocalDate} is null and ${table.selectedNextLocalTime} is null
          and ${table.selectedNextScheduledFor} is null)
          or (not ${table.deferredMaterialization} and ${table.selectedNextOccurrenceId} is not null
          and ${table.selectedNextLocalDate} is not null and ${table.selectedNextLocalTime} is not null
          and ${table.selectedNextScheduledFor} is not null))
      ) or (
        ${table.event} = 'SERIES_CANCELLED' and ${table.actorType} = 'USER'
        and ${table.outcome} = 'SUCCESS' and ${table.beforeRevision} is not null
        and ${table.afterRevision} is not null and ${table.postSeriesStatus} = 'CANCELLED'
      ) or (
        ${table.event} = 'OCCURRENCE_RETRY' and ${table.actorType} = 'SYSTEM'
        and ${table.outcome} = 'FAILURE' and ${table.occurrenceId} is not null
        and ${table.intendedLocalDate} is not null and ${table.intendedLocalTime} is not null
        and ${table.scheduledFor} is not null and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null
        and ${table.failureCode} is not null and ${table.retryCount} between 1 and 3
      ) or (
        ${table.event} = 'OCCURRENCE_COMPLETED' and ${table.actorType} = 'SYSTEM'
        and ${table.outcome} = 'SUCCESS' and ${table.occurrenceId} is not null
        and ${table.intendedLocalDate} is not null and ${table.intendedLocalTime} is not null
        and ${table.scheduledFor} is not null and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null and ${table.retryCount} is not null
        and ${table.resultMessageId} is not null and ${table.failureCode} is null
        and ${table.postSeriesStatus} in ('ACTIVE', 'CANCELLED')
        and ((${table.postSeriesStatus} = 'ACTIVE' and ${table.nextOccurrenceId} is not null
          and ${table.nextIntendedLocalDate} is not null and ${table.nextIntendedLocalTime} is not null
          and ${table.nextScheduledFor} is not null)
          or (${table.postSeriesStatus} = 'CANCELLED' and ${table.nextOccurrenceId} is null
          and ${table.nextIntendedLocalDate} is null and ${table.nextIntendedLocalTime} is null
          and ${table.nextScheduledFor} is null))
      ) or (
        ${table.event} = 'OCCURRENCE_FAILED' and ${table.actorType} = 'SYSTEM'
        and ${table.outcome} = 'FAILURE' and ${table.occurrenceId} is not null
        and ${table.intendedLocalDate} is not null and ${table.intendedLocalTime} is not null
        and ${table.scheduledFor} is not null and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null and ${table.retryCount} is not null
        and ${table.failureCode} is not null
        and (${table.resultMessageId} is null or ${table.failureCode} in
          ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))
        and ${table.postSeriesStatus} in ('ACTIVE', 'CANCELLED')
        and ((${table.postSeriesStatus} = 'ACTIVE' and ${table.nextOccurrenceId} is not null
          and ${table.nextIntendedLocalDate} is not null and ${table.nextIntendedLocalTime} is not null
          and ${table.nextScheduledFor} is not null)
          or (${table.postSeriesStatus} = 'CANCELLED' and ${table.nextOccurrenceId} is null
          and ${table.nextIntendedLocalDate} is null and ${table.nextIntendedLocalTime} is null
          and ${table.nextScheduledFor} is null))
      ) or (
        ${table.event} = 'DST_GAP_SKIPPED' and ${table.outcome} = 'SKIPPED'
        and ${table.intendedLocalDate} is not null and ${table.intendedLocalTime} is not null
        and ${table.afterTimezone} is not null and ${table.afterDefinitionRevision} is not null
        and ${table.auditSkipReason} = 'DST_GAP' and ${table.occurrenceId} is null
      ) or (
        ${table.event} = 'MISSED_RANGE_SKIPPED' and ${table.actorType} = 'SYSTEM'
        and ${table.outcome} = 'SKIPPED' and ${table.afterTimezone} is not null
        and ${table.skippedFromLocalDate} is not null and ${table.skippedFromLocalTime} is not null
        and ${table.skippedThroughLocalDate} is not null and ${table.skippedThroughLocalTime} is not null
        and ${table.selectedNextLocalDate} is not null and ${table.selectedNextLocalTime} is not null
        and ${table.selectedNextScheduledFor} is not null
        and ${table.auditSkipReason} = 'MISSED_GRACE_EXCEEDED'
      )`,
    ),
    check(
      "recurring_message_audits_event_exclusivity_check",
      sql`coalesce((
        ${table.event} = 'SERIES_CREATED'
        and ${table.actorType} = 'USER' and ${table.outcome} = 'SUCCESS'
        and ${table.afterRevision} is not null and ${table.afterContent} is not null
        and ${table.afterFrequency} is not null and ${table.afterWeekdayMask} is not null
        and ${table.afterLocalTime} is not null and ${table.afterTimezone} is not null
        and ${table.afterDefinitionRevision} is not null and ${table.afterEffectiveAt} is not null
        and ${table.selectedNextOccurrenceId} is not null
        and ${table.selectedNextLocalDate} is not null and ${table.selectedNextLocalTime} is not null
        and ${table.selectedNextScheduledFor} is not null and ${table.postSeriesStatus} = 'ACTIVE'
        and ${allNull([
          table.occurrenceId,
          table.beforeRevision,
          table.beforeContent,
          table.beforeEmbedTitle,
          table.beforeEmbedDescription,
          table.beforeEmbedColor,
          table.beforeEmbedImageUrl,
          table.beforeFrequency,
          table.beforeWeekdayMask,
          table.beforeLocalTime,
          table.beforeTimezone,
          table.beforeDefinitionRevision,
          table.beforeEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.intendedLocalDate,
          table.intendedLocalTime,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'PAYLOAD_EDITED'
        and ${table.actorType} = 'USER' and ${table.outcome} = 'SUCCESS'
        and ${table.beforeRevision} is not null and ${table.afterRevision} is not null
        and ${table.beforeContent} is not null and ${table.afterContent} is not null
        and ${table.postSeriesStatus} = 'ACTIVE'
        and ${allNull([
          table.occurrenceId,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.afterTimezone,
          table.beforeDefinitionRevision,
          table.afterDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.intendedLocalDate,
          table.intendedLocalTime,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'RECURRENCE_EDITED'
        and ${table.actorType} = 'USER' and ${table.outcome} = 'SUCCESS'
        and ${table.beforeRevision} is not null and ${table.afterRevision} is not null
        and ${table.beforeFrequency} is not null and ${table.afterFrequency} is not null
        and ${table.beforeWeekdayMask} is not null and ${table.afterWeekdayMask} is not null
        and ${table.beforeLocalTime} is not null and ${table.afterLocalTime} is not null
        and ${table.beforeTimezone} is not null and ${table.afterTimezone} is not null
        and ${table.beforeDefinitionRevision} is not null
        and ${table.afterDefinitionRevision} is not null
        and ${table.beforeEffectiveAt} is not null and ${table.afterEffectiveAt} is not null
        and ${table.currentOccurrenceId} is not null
        and ${table.deferredMaterialization} is not null and ${table.postSeriesStatus} = 'ACTIVE'
        and ((${table.deferredMaterialization} and ${table.selectedNextOccurrenceId} is null
          and ${table.selectedNextLocalDate} is null and ${table.selectedNextLocalTime} is null
          and ${table.selectedNextScheduledFor} is null)
          or (not ${table.deferredMaterialization} and ${table.selectedNextOccurrenceId} is not null
          and ${table.selectedNextLocalDate} is not null and ${table.selectedNextLocalTime} is not null
          and ${table.selectedNextScheduledFor} is not null))
        and ${allNull([
          table.occurrenceId,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.intendedLocalDate,
          table.intendedLocalTime,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'SERIES_CANCELLED'
        and ${table.actorType} = 'USER' and ${table.outcome} = 'SUCCESS'
        and ${table.beforeRevision} is not null and ${table.afterRevision} is not null
        and ${table.postSeriesStatus} = 'CANCELLED'
        and ((${table.occurrenceId} is null and ${table.currentOccurrenceId} is null
          and ${table.occurrenceSkipReason} is null)
          or (${table.occurrenceId} is not null
          and ${table.currentOccurrenceId} = ${table.occurrenceId}
          and (${table.occurrenceSkipReason} is null
            or ${table.occurrenceSkipReason} = 'SERIES_CANCELLED')))
        and ${allNull([
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.afterTimezone,
          table.beforeDefinitionRevision,
          table.afterDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.intendedLocalDate,
          table.intendedLocalTime,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'OCCURRENCE_RETRY'
        and ${table.actorType} = 'SYSTEM' and ${table.outcome} = 'FAILURE'
        and ${table.occurrenceId} is not null and ${table.intendedLocalDate} is not null
        and ${table.intendedLocalTime} is not null and ${table.scheduledFor} is not null
        and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null
        and ${table.retryCount} between 1 and 3 and ${table.failureCode} is not null
        and ${allNull([
          table.beforeRevision,
          table.afterRevision,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.afterTimezone,
          table.beforeDefinitionRevision,
          table.afterDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.resultMessageId,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.postSeriesStatus,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'OCCURRENCE_COMPLETED'
        and ${table.actorType} = 'SYSTEM' and ${table.outcome} = 'SUCCESS'
        and ${table.occurrenceId} is not null and ${table.intendedLocalDate} is not null
        and ${table.intendedLocalTime} is not null and ${table.scheduledFor} is not null
        and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null and ${table.retryCount} is not null
        and ${table.resultMessageId} is not null and ${table.postSeriesStatus} in ('ACTIVE', 'CANCELLED')
        and ((${table.postSeriesStatus} = 'ACTIVE' and ${table.nextOccurrenceId} is not null
          and ${table.nextIntendedLocalDate} is not null and ${table.nextIntendedLocalTime} is not null
          and ${table.nextScheduledFor} is not null)
          or (${table.postSeriesStatus} = 'CANCELLED' and ${table.nextOccurrenceId} is null
          and ${table.nextIntendedLocalDate} is null and ${table.nextIntendedLocalTime} is null
          and ${table.nextScheduledFor} is null))
        and ${allNull([
          table.beforeRevision,
          table.afterRevision,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.afterTimezone,
          table.beforeDefinitionRevision,
          table.afterDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.failureCode,
          table.occurrenceSkipReason,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'OCCURRENCE_FAILED'
        and ${table.actorType} = 'SYSTEM' and ${table.outcome} = 'FAILURE'
        and ${table.occurrenceId} is not null and ${table.intendedLocalDate} is not null
        and ${table.intendedLocalTime} is not null and ${table.scheduledFor} is not null
        and ${table.claimedSeriesRevision} is not null
        and ${table.claimedDefinitionRevision} is not null and ${table.retryCount} is not null
        and ${table.failureCode} is not null
        and (${table.resultMessageId} is null or ${table.failureCode} in
          ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))
        and ${table.postSeriesStatus} in ('ACTIVE', 'CANCELLED')
        and ((${table.postSeriesStatus} = 'ACTIVE' and ${table.nextOccurrenceId} is not null
          and ${table.nextIntendedLocalDate} is not null and ${table.nextIntendedLocalTime} is not null
          and ${table.nextScheduledFor} is not null)
          or (${table.postSeriesStatus} = 'CANCELLED' and ${table.nextOccurrenceId} is null
          and ${table.nextIntendedLocalDate} is null and ${table.nextIntendedLocalTime} is null
          and ${table.nextScheduledFor} is null))
        and ${allNull([
          table.beforeRevision,
          table.afterRevision,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.afterTimezone,
          table.beforeDefinitionRevision,
          table.afterDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.occurrenceSkipReason,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
          table.auditSkipReason,
        ])}
      ) or (
        ${table.event} = 'DST_GAP_SKIPPED' and ${table.outcome} = 'SKIPPED'
        and ${table.occurrenceId} is null and ${table.intendedLocalDate} is not null
        and ${table.intendedLocalTime} is not null and ${table.afterTimezone} is not null
        and ${table.afterDefinitionRevision} is not null and ${table.auditSkipReason} = 'DST_GAP'
        and ${allNull([
          table.beforeRevision,
          table.afterRevision,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.beforeDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.selectedNextLocalDate,
          table.selectedNextLocalTime,
          table.selectedNextScheduledFor,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.postSeriesStatus,
          table.rangeStartOccurrenceId,
          table.skippedFromLocalDate,
          table.skippedFromLocalTime,
          table.skippedThroughLocalDate,
          table.skippedThroughLocalTime,
        ])}
      ) or (
        ${table.event} = 'MISSED_RANGE_SKIPPED'
        and ${table.actorType} = 'SYSTEM' and ${table.outcome} = 'SKIPPED'
        and ${table.afterTimezone} is not null and ${table.afterDefinitionRevision} is not null
        and ${table.skippedFromLocalDate} is not null and ${table.skippedFromLocalTime} is not null
        and ${table.skippedThroughLocalDate} is not null
        and ${table.skippedThroughLocalTime} is not null
        and ${table.selectedNextLocalDate} is not null and ${table.selectedNextLocalTime} is not null
        and ${table.selectedNextScheduledFor} is not null
        and ${table.auditSkipReason} = 'MISSED_GRACE_EXCEEDED'
        and ${allNull([
          table.occurrenceId,
          table.beforeRevision,
          table.afterRevision,
          table.beforeContent,
          table.afterContent,
          table.beforeEmbedTitle,
          table.afterEmbedTitle,
          table.beforeEmbedDescription,
          table.afterEmbedDescription,
          table.beforeEmbedColor,
          table.afterEmbedColor,
          table.beforeEmbedImageUrl,
          table.afterEmbedImageUrl,
          table.beforeFrequency,
          table.afterFrequency,
          table.beforeWeekdayMask,
          table.afterWeekdayMask,
          table.beforeLocalTime,
          table.afterLocalTime,
          table.beforeTimezone,
          table.beforeDefinitionRevision,
          table.beforeEffectiveAt,
          table.afterEffectiveAt,
          table.currentOccurrenceId,
          table.deferredMaterialization,
          table.selectedNextOccurrenceId,
          table.intendedLocalDate,
          table.intendedLocalTime,
          table.scheduledFor,
          table.claimedSeriesRevision,
          table.claimedDefinitionRevision,
          table.retryCount,
          table.resultMessageId,
          table.failureCode,
          table.occurrenceSkipReason,
          table.nextOccurrenceId,
          table.nextIntendedLocalDate,
          table.nextIntendedLocalTime,
          table.nextScheduledFor,
          table.postSeriesStatus,
        ])}
      ), false)`,
    ),
    index("recurring_message_audits_series_id_idx").on(table.scheduledActionId),
    index("recurring_message_audits_occurrence_id_idx").on(table.occurrenceId),
  ],
);

export type RecurringMessageSchedule = typeof recurringMessageSchedules.$inferSelect;
export type RecurringMessageOccurrence = typeof recurringMessageOccurrences.$inferSelect;
export type RecurringMessageAudit = typeof recurringMessageAudits.$inferSelect;

export type RecurringMessageSeries = {
  action: ScheduledAction;
  creatorUserId: string;
  retryCount: number;
  revision: number;
  payload: ManagedMessagePayload;
  resultMessageId: string | null;
  recurrence: RecurringMessageSchedule;
  occurrence: RecurringMessageOccurrence | null;
};

export type CreateRecurringMessageSeries = {
  scheduledActionId: string;
  occurrenceId: string;
  auditId: string;
  gapAuditIds: string[];
  guildId: string;
  channelId: string;
  actorId: string;
  payload: ManagedMessagePayload;
  recurrence: RecurrenceDefinition;
  effectiveAt: Date;
};

export type EditRecurringMessagePayload = {
  scheduledActionId: string;
  actorId: string;
  expectedRevision: number;
  payload: ManagedMessagePayload;
  auditId: string;
  occurredAt: Date;
};

export type EditRecurringMessageRecurrence = {
  scheduledActionId: string;
  actorId: string;
  expectedRevision: number;
  recurrence: RecurrenceDefinition;
  effectiveAt: Date;
  replacementOccurrenceId: string;
  auditId: string;
  gapAuditIds: string[];
};

export type CancelRecurringMessageSeries = {
  scheduledActionId: string;
  actorId: string;
  expectedRevision: number;
  auditId: string;
  occurredAt: Date;
};

export type MaterializeRecurringOccurrence = {
  scheduledActionId: string;
  occurrenceId: string;
  expectedDefinitionRevision: number;
  intendedLocalDate: string;
  intendedLocalTime: string;
  scheduledFor: Date;
};

export type ClaimRecurringOccurrence = {
  occurrenceId: string;
  expectedSeriesRevision: number;
  claimedAt: Date;
};

export type RecurringMutationResult =
  | { outcome: "COMMITTED"; series: RecurringMessageSeries }
  | { outcome: "UNCHANGED"; series: RecurringMessageSeries }
  | {
      outcome: "CONFLICT" | "NOT_FOUND" | "INVALID_RECURRENCE" | "PERSISTENCE_UNCONFIRMED";
    };

export type RecurringClaimResult =
  | { outcome: "COMMITTED"; series: RecurringMessageSeries; occurrence: RecurringMessageOccurrence }
  | { outcome: "NOT_CLAIMED" };

export type RecurringMaterializationResult =
  | { outcome: "COMMITTED"; occurrence: RecurringMessageOccurrence }
  | { outcome: "NOT_MATERIALIZED" | "PERSISTENCE_UNCONFIRMED" };

export type RecurringMessageStore = {
  create: (input: CreateRecurringMessageSeries) => Promise<RecurringMutationResult>;
  find: (scheduledActionId: string) => Promise<RecurringMessageSeries | undefined>;
  editPayload: (input: EditRecurringMessagePayload) => Promise<RecurringMutationResult>;
  editRecurrence: (input: EditRecurringMessageRecurrence) => Promise<RecurringMutationResult>;
  cancel: (input: CancelRecurringMessageSeries) => Promise<RecurringMutationResult>;
  materialize: (input: MaterializeRecurringOccurrence) => Promise<RecurringMaterializationResult>;
  claimInitial: (input: ClaimRecurringOccurrence) => Promise<RecurringClaimResult>;
};

function occurrenceValues(
  scheduledActionId: string,
  occurrenceId: string,
  definitionRevision: number,
  occurrence: ReturnType<typeof findNextOccurrence>["occurrence"],
) {
  return {
    id: occurrenceId,
    scheduledActionId,
    materializedDefinitionRevision: definitionRevision,
    intendedLocalDate: occurrence.intendedLocalDate,
    intendedLocalTime: occurrence.intendedLocalTime,
    scheduledFor: occurrence.scheduledFor,
    status: "PENDING" as const,
    retryCount: 0,
  };
}

function gapAuditValues(
  input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorId: string;
    timezone: string;
    definitionRevision: number;
    occurredAt: Date;
  },
  gap: DstGapCandidate,
  id: string,
) {
  return {
    id,
    scheduledActionId: input.scheduledActionId,
    guildId: input.guildId,
    channelId: input.channelId,
    event: "DST_GAP_SKIPPED" as const,
    actorType: "USER" as const,
    actorId: input.actorId,
    intendedLocalDate: gap.intendedLocalDate,
    intendedLocalTime: gap.intendedLocalTime,
    afterTimezone: input.timezone,
    afterDefinitionRevision: input.definitionRevision,
    auditSkipReason: "DST_GAP" as const,
    occurredAt: input.occurredAt,
    outcome: "SKIPPED" as const,
  };
}

function assertGapAuditIds(gaps: DstGapCandidate[], ids: string[]): void {
  if (gaps.length !== ids.length) {
    throw new Error("A stable audit ID is required for every skipped DST gap");
  }
}

export function createRecurringMessageStore(database: DatabaseClient): RecurringMessageStore {
  const find = async (scheduledActionId: string): Promise<RecurringMessageSeries | undefined> => {
    const [row] = await database
      .select({
        action: scheduledActions,
        state: scheduledMessageStates,
        recurrence: recurringMessageSchedules,
        occurrence: recurringMessageOccurrences,
      })
      .from(scheduledActions)
      .innerJoin(
        scheduledMessageStates,
        eq(scheduledMessageStates.scheduledActionId, scheduledActions.id),
      )
      .innerJoin(
        recurringMessageSchedules,
        eq(recurringMessageSchedules.scheduledActionId, scheduledActions.id),
      )
      .leftJoin(
        recurringMessageOccurrences,
        and(
          eq(recurringMessageOccurrences.scheduledActionId, scheduledActions.id),
          inArray(recurringMessageOccurrences.status, ["PENDING", "EXECUTING", "RETRY_PENDING"]),
        ),
      )
      .where(
        and(
          eq(scheduledActions.id, scheduledActionId),
          eq(scheduledActions.actionType, "SEND_MESSAGE"),
        ),
      )
      .limit(1);
    if (row === undefined) return undefined;
    return {
      action: row.action,
      creatorUserId: row.state.creatorUserId,
      retryCount: row.state.retryCount,
      revision: row.state.revision,
      payload: scheduledMessagePayloadFromColumns(row.state),
      resultMessageId: row.state.resultMessageId,
      recurrence: row.recurrence,
      occurrence: row.occurrence,
    };
  };

  const exactAuditCommitted = async (
    id: string,
    scheduledActionId: string,
    matches: (audit: RecurringMessageAudit) => boolean,
  ): Promise<RecurringMessageSeries | undefined> => {
    const [audit, series] = await Promise.all([
      database
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, id))
        .limit(1)
        .then((rows) => rows[0]),
      find(scheduledActionId),
    ]);
    return audit !== undefined && audit.scheduledActionId === scheduledActionId && matches(audit)
      ? series
      : undefined;
  };

  return {
    async create(input) {
      const validation = validateRecurrence(input.recurrence);
      if (!validation.ok) return { outcome: "INVALID_RECURRENCE" };
      const recurrenceDefinition = validation.definition;
      const selection = findNextOccurrence(recurrenceDefinition, 0, input.effectiveAt);
      assertGapAuditIds(selection.skippedGaps, input.gapAuditIds);
      try {
        const series = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .insert(scheduledActions)
            .values({
              id: input.scheduledActionId,
              guildId: input.guildId,
              actionType: "SEND_MESSAGE",
              targetId: input.channelId,
              status: "ACTIVE",
              executeAt: selection.occurrence.scheduledFor,
            })
            .returning();
          if (action === undefined) throw new Error("Recurring action was not created");
          const [state] = await transaction
            .insert(scheduledMessageStates)
            .values({
              scheduledActionId: input.scheduledActionId,
              creatorUserId: input.actorId,
              retryCount: 0,
              revision: 0,
              ...scheduledMessagePayloadToColumns(input.payload),
              resultMessageId: null,
            })
            .returning();
          if (state === undefined) throw new Error("Recurring message state was not created");
          const [recurrence] = await transaction
            .insert(recurringMessageSchedules)
            .values({
              scheduledActionId: input.scheduledActionId,
              ...recurrenceDefinition,
              definitionRevision: 0,
              effectiveAt: input.effectiveAt,
            })
            .returning();
          if (recurrence === undefined) throw new Error("Recurring definition was not created");
          const [occurrence] = await transaction
            .insert(recurringMessageOccurrences)
            .values(
              occurrenceValues(
                input.scheduledActionId,
                input.occurrenceId,
                0,
                selection.occurrence,
              ),
            )
            .returning();
          if (occurrence === undefined) throw new Error("Initial occurrence was not created");
          const payload = scheduledMessagePayloadToColumns(input.payload);
          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
            event: "SERIES_CREATED",
            actorType: "USER",
            actorId: input.actorId,
            afterRevision: 0,
            afterContent: payload.content,
            afterEmbedTitle: payload.embedTitle,
            afterEmbedDescription: payload.embedDescription,
            afterEmbedColor: payload.embedColor,
            afterEmbedImageUrl: payload.embedImageUrl,
            afterFrequency: recurrenceDefinition.frequency,
            afterWeekdayMask: recurrenceDefinition.weekdayMask,
            afterLocalTime: recurrenceDefinition.localTime,
            afterTimezone: recurrenceDefinition.timezone,
            afterDefinitionRevision: 0,
            afterEffectiveAt: input.effectiveAt,
            selectedNextOccurrenceId: occurrence.id,
            selectedNextLocalDate: occurrence.intendedLocalDate,
            selectedNextLocalTime: occurrence.intendedLocalTime,
            selectedNextScheduledFor: occurrence.scheduledFor,
            postSeriesStatus: "ACTIVE",
            occurredAt: input.effectiveAt,
            outcome: "SUCCESS",
          });
          if (selection.skippedGaps.length > 0) {
            await transaction.insert(recurringMessageAudits).values(
              selection.skippedGaps.map((gap, index) =>
                gapAuditValues(
                  {
                    scheduledActionId: input.scheduledActionId,
                    guildId: input.guildId,
                    channelId: input.channelId,
                    actorId: input.actorId,
                    timezone: recurrenceDefinition.timezone,
                    definitionRevision: 0,
                    occurredAt: input.effectiveAt,
                  },
                  gap,
                  input.gapAuditIds[index]!,
                ),
              ),
            );
          }
          return {
            action,
            creatorUserId: state.creatorUserId,
            retryCount: state.retryCount,
            revision: state.revision,
            payload: input.payload,
            resultMessageId: state.resultMessageId,
            recurrence,
            occurrence,
          } satisfies RecurringMessageSeries;
        });
        return { outcome: "COMMITTED", series };
      } catch {
        const confirmed = await exactAuditCommitted(
          input.auditId,
          input.scheduledActionId,
          (audit) => {
            const payload = scheduledMessagePayloadToColumns(input.payload);
            return (
              audit.event === "SERIES_CREATED" &&
              audit.actorType === "USER" &&
              audit.actorId === input.actorId &&
              audit.guildId === input.guildId &&
              audit.channelId === input.channelId &&
              audit.afterRevision === 0 &&
              audit.afterContent === payload.content &&
              audit.afterEmbedTitle === payload.embedTitle &&
              audit.afterEmbedDescription === payload.embedDescription &&
              audit.afterEmbedColor === payload.embedColor &&
              audit.afterEmbedImageUrl === payload.embedImageUrl &&
              audit.afterFrequency === recurrenceDefinition.frequency &&
              audit.afterWeekdayMask === recurrenceDefinition.weekdayMask &&
              audit.afterLocalTime?.slice(0, 5) === recurrenceDefinition.localTime &&
              audit.afterTimezone === recurrenceDefinition.timezone &&
              audit.afterDefinitionRevision === 0 &&
              audit.afterEffectiveAt?.getTime() === input.effectiveAt.getTime() &&
              audit.selectedNextOccurrenceId === input.occurrenceId &&
              audit.selectedNextLocalDate === selection.occurrence.intendedLocalDate &&
              audit.selectedNextLocalTime?.slice(0, 5) === selection.occurrence.intendedLocalTime &&
              audit.selectedNextScheduledFor?.getTime() ===
                selection.occurrence.scheduledFor.getTime() &&
              audit.occurredAt.getTime() === input.effectiveAt.getTime() &&
              audit.outcome === "SUCCESS"
            );
          },
        ).catch(() => undefined);
        return confirmed === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series: confirmed };
      }
    },
    find,
    async editPayload(input) {
      let nextRevision = input.expectedRevision + 1;
      let expectedBefore: ReturnType<typeof scheduledMessagePayloadToColumns> | undefined;
      try {
        const result = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1)
            .for("update");
          if (action === undefined || action.actionType !== "SEND_MESSAGE")
            return { outcome: "NOT_FOUND" } as const;
          const [recurrence] = await transaction
            .select()
            .from(recurringMessageSchedules)
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .limit(1);
          const [state] = await transaction
            .select()
            .from(scheduledMessageStates)
            .where(eq(scheduledMessageStates.scheduledActionId, action.id))
            .limit(1);
          if (recurrence === undefined || state === undefined)
            return { outcome: "NOT_FOUND" } as const;
          if (action.status !== "ACTIVE" || state.revision !== input.expectedRevision)
            return { outcome: "CONFLICT" } as const;
          const beforePayload = scheduledMessagePayloadFromColumns(state);
          const before = scheduledMessagePayloadToColumns(beforePayload);
          expectedBefore = before;
          const after = scheduledMessagePayloadToColumns(input.payload);
          if (
            before.content === after.content &&
            before.embedTitle === after.embedTitle &&
            before.embedDescription === after.embedDescription &&
            before.embedColor === after.embedColor &&
            before.embedImageUrl === after.embedImageUrl
          ) {
            return { outcome: "UNCHANGED" } as const;
          }
          nextRevision = state.revision + 1;
          await transaction
            .update(scheduledMessageStates)
            .set({ ...after, revision: nextRevision })
            .where(eq(scheduledMessageStates.scheduledActionId, action.id));
          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: action.id,
            guildId: action.guildId,
            channelId: action.targetId,
            event: "PAYLOAD_EDITED",
            actorType: "USER",
            actorId: input.actorId,
            beforeRevision: state.revision,
            afterRevision: nextRevision,
            beforeContent: before.content,
            afterContent: after.content,
            beforeEmbedTitle: before.embedTitle,
            afterEmbedTitle: after.embedTitle,
            beforeEmbedDescription: before.embedDescription,
            afterEmbedDescription: after.embedDescription,
            beforeEmbedColor: before.embedColor,
            afterEmbedColor: after.embedColor,
            beforeEmbedImageUrl: before.embedImageUrl,
            afterEmbedImageUrl: after.embedImageUrl,
            postSeriesStatus: "ACTIVE",
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
          });
          return { outcome: "COMMITTED" } as const;
        });
        if (result.outcome === "NOT_FOUND" || result.outcome === "CONFLICT") return result;
        const series = await find(input.scheduledActionId);
        if (series === undefined) return { outcome: "PERSISTENCE_UNCONFIRMED" };
        return { outcome: result.outcome, series };
      } catch {
        const confirmed = await exactAuditCommitted(
          input.auditId,
          input.scheduledActionId,
          (audit) => {
            if (expectedBefore === undefined) return false;
            const after = scheduledMessagePayloadToColumns(input.payload);
            return (
              audit.event === "PAYLOAD_EDITED" &&
              audit.actorType === "USER" &&
              audit.actorId === input.actorId &&
              audit.beforeRevision === input.expectedRevision &&
              audit.afterRevision === nextRevision &&
              audit.beforeContent === expectedBefore.content &&
              audit.beforeEmbedTitle === expectedBefore.embedTitle &&
              audit.beforeEmbedDescription === expectedBefore.embedDescription &&
              audit.beforeEmbedColor === expectedBefore.embedColor &&
              audit.beforeEmbedImageUrl === expectedBefore.embedImageUrl &&
              audit.afterContent === after.content &&
              audit.afterEmbedTitle === after.embedTitle &&
              audit.afterEmbedDescription === after.embedDescription &&
              audit.afterEmbedColor === after.embedColor &&
              audit.afterEmbedImageUrl === after.embedImageUrl &&
              audit.occurredAt.getTime() === input.occurredAt.getTime() &&
              audit.outcome === "SUCCESS"
            );
          },
        ).catch(() => undefined);
        return confirmed === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series: confirmed };
      }
    },
    async editRecurrence(input) {
      const validation = validateRecurrence(input.recurrence);
      if (!validation.ok) return { outcome: "INVALID_RECURRENCE" };
      const recurrenceDefinition = validation.definition;
      let nextRevision = input.expectedRevision + 1;
      const selected = findNextOccurrence(recurrenceDefinition, nextRevision, input.effectiveAt);
      let expectedAudit:
        | {
            before: RecurringMessageSchedule;
            currentOccurrenceId: string;
            deferred: boolean;
          }
        | undefined;
      try {
        const result = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1)
            .for("update");
          if (action === undefined || action.actionType !== "SEND_MESSAGE")
            return { outcome: "NOT_FOUND" } as const;
          const [recurrence] = await transaction
            .select()
            .from(recurringMessageSchedules)
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .limit(1);
          const [state] = await transaction
            .select()
            .from(scheduledMessageStates)
            .where(eq(scheduledMessageStates.scheduledActionId, action.id))
            .limit(1);
          if (recurrence === undefined || state === undefined)
            return { outcome: "NOT_FOUND" } as const;
          if (action.status !== "ACTIVE" || state.revision !== input.expectedRevision)
            return { outcome: "CONFLICT" } as const;

          const [current] = await transaction
            .select()
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                inArray(recurringMessageOccurrences.status, [
                  "PENDING",
                  "EXECUTING",
                  "RETRY_PENDING",
                ]),
              ),
            )
            .limit(1)
            .for("update");
          if (current === undefined) throw new Error("Recurring series has no current occurrence");
          const deferred = current.status !== "PENDING";
          expectedAudit = {
            before: recurrence,
            currentOccurrenceId: current.id,
            deferred,
          };
          if (deferred) {
            if (input.gapAuditIds.length !== 0)
              throw new Error("Deferred edits cannot persist candidate gap audits");
          } else {
            assertGapAuditIds(selected.skippedGaps, input.gapAuditIds);
          }
          nextRevision = state.revision + 1;
          const [updatedState] = await transaction
            .update(scheduledMessageStates)
            .set({ revision: nextRevision })
            .where(
              and(
                eq(scheduledMessageStates.scheduledActionId, action.id),
                eq(scheduledMessageStates.revision, state.revision),
              ),
            )
            .returning();
          if (updatedState === undefined) throw new Error("Recurring revision edit was lost");
          const [updatedRecurrence] = await transaction
            .update(recurringMessageSchedules)
            .set({
              ...recurrenceDefinition,
              definitionRevision: nextRevision,
              effectiveAt: input.effectiveAt,
              updatedAt: new Date(),
            })
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .returning();
          if (updatedRecurrence === undefined)
            throw new Error("Recurring definition edit was lost");

          let replacement: RecurringMessageOccurrence | undefined;
          if (!deferred) {
            await transaction
              .update(recurringMessageOccurrences)
              .set({
                status: "SKIPPED",
                skipReason: "RECURRENCE_EDITED",
                terminalAt: input.effectiveAt,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(recurringMessageOccurrences.id, current.id),
                  eq(recurringMessageOccurrences.status, "PENDING"),
                ),
              );
            [replacement] = await transaction
              .insert(recurringMessageOccurrences)
              .values(
                occurrenceValues(
                  action.id,
                  input.replacementOccurrenceId,
                  nextRevision,
                  selected.occurrence,
                ),
              )
              .returning();
            if (replacement === undefined)
              throw new Error("Replacement occurrence was not created");
            await transaction
              .update(scheduledActions)
              .set({ executeAt: replacement.scheduledFor, updatedAt: new Date() })
              .where(eq(scheduledActions.id, action.id));
          }

          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: action.id,
            guildId: action.guildId,
            channelId: action.targetId,
            event: "RECURRENCE_EDITED",
            actorType: "USER",
            actorId: input.actorId,
            beforeRevision: state.revision,
            afterRevision: nextRevision,
            beforeFrequency: recurrence.frequency,
            afterFrequency: recurrenceDefinition.frequency,
            beforeWeekdayMask: recurrence.weekdayMask,
            afterWeekdayMask: recurrenceDefinition.weekdayMask,
            beforeLocalTime: recurrence.localTime,
            afterLocalTime: recurrenceDefinition.localTime,
            beforeTimezone: recurrence.timezone,
            afterTimezone: recurrenceDefinition.timezone,
            beforeDefinitionRevision: recurrence.definitionRevision,
            afterDefinitionRevision: nextRevision,
            beforeEffectiveAt: recurrence.effectiveAt,
            afterEffectiveAt: input.effectiveAt,
            currentOccurrenceId: current.id,
            deferredMaterialization: deferred,
            selectedNextOccurrenceId: replacement?.id,
            selectedNextLocalDate: replacement?.intendedLocalDate,
            selectedNextLocalTime: replacement?.intendedLocalTime,
            selectedNextScheduledFor: replacement?.scheduledFor,
            postSeriesStatus: "ACTIVE",
            occurredAt: input.effectiveAt,
            outcome: "SUCCESS",
          });
          if (!deferred && selected.skippedGaps.length > 0) {
            await transaction.insert(recurringMessageAudits).values(
              selected.skippedGaps.map((gap, index) =>
                gapAuditValues(
                  {
                    scheduledActionId: action.id,
                    guildId: action.guildId,
                    channelId: action.targetId,
                    actorId: input.actorId,
                    timezone: recurrenceDefinition.timezone,
                    definitionRevision: nextRevision,
                    occurredAt: input.effectiveAt,
                  },
                  gap,
                  input.gapAuditIds[index]!,
                ),
              ),
            );
          }
          return { outcome: "COMMITTED" } as const;
        });
        if (result.outcome !== "COMMITTED") return result;
        const series = await find(input.scheduledActionId);
        return series === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series };
      } catch {
        const confirmed = await exactAuditCommitted(
          input.auditId,
          input.scheduledActionId,
          (audit) =>
            expectedAudit !== undefined &&
            audit.event === "RECURRENCE_EDITED" &&
            audit.actorType === "USER" &&
            audit.actorId === input.actorId &&
            audit.beforeRevision === input.expectedRevision &&
            audit.afterRevision === nextRevision &&
            audit.beforeFrequency === expectedAudit.before.frequency &&
            audit.afterFrequency === recurrenceDefinition.frequency &&
            audit.beforeWeekdayMask === expectedAudit.before.weekdayMask &&
            audit.afterWeekdayMask === recurrenceDefinition.weekdayMask &&
            audit.beforeLocalTime?.slice(0, 5) === expectedAudit.before.localTime.slice(0, 5) &&
            audit.afterLocalTime?.slice(0, 5) === recurrenceDefinition.localTime &&
            audit.beforeTimezone === expectedAudit.before.timezone &&
            audit.afterTimezone === recurrenceDefinition.timezone &&
            audit.beforeDefinitionRevision === expectedAudit.before.definitionRevision &&
            audit.afterDefinitionRevision === nextRevision &&
            audit.beforeEffectiveAt?.getTime() === expectedAudit.before.effectiveAt.getTime() &&
            audit.afterEffectiveAt?.getTime() === input.effectiveAt.getTime() &&
            audit.currentOccurrenceId === expectedAudit.currentOccurrenceId &&
            audit.deferredMaterialization === expectedAudit.deferred &&
            audit.selectedNextOccurrenceId ===
              (expectedAudit.deferred ? null : input.replacementOccurrenceId) &&
            audit.selectedNextLocalDate ===
              (expectedAudit.deferred ? null : selected.occurrence.intendedLocalDate) &&
            audit.selectedNextLocalTime?.slice(0, 5) ===
              (expectedAudit.deferred ? undefined : selected.occurrence.intendedLocalTime) &&
            (expectedAudit.deferred
              ? audit.selectedNextScheduledFor === null
              : audit.selectedNextScheduledFor?.getTime() ===
                selected.occurrence.scheduledFor.getTime()) &&
            audit.occurredAt.getTime() === input.effectiveAt.getTime() &&
            audit.outcome === "SUCCESS",
        ).catch(() => undefined);
        return confirmed === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series: confirmed };
      }
    },
    async cancel(input) {
      const nextRevision = input.expectedRevision + 1;
      let expectedCurrent: Pick<RecurringMessageOccurrence, "id" | "status"> | null | undefined;
      try {
        const result = await database.transaction(async (transaction) => {
          const [action] = await transaction
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1)
            .for("update");
          if (action === undefined || action.actionType !== "SEND_MESSAGE")
            return { outcome: "NOT_FOUND" } as const;
          const [recurrence] = await transaction
            .select()
            .from(recurringMessageSchedules)
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .limit(1);
          const [state] = await transaction
            .select()
            .from(scheduledMessageStates)
            .where(eq(scheduledMessageStates.scheduledActionId, action.id))
            .limit(1);
          if (recurrence === undefined || state === undefined)
            return { outcome: "NOT_FOUND" } as const;
          if (action.status !== "ACTIVE" || state.revision !== input.expectedRevision)
            return { outcome: "CONFLICT" } as const;
          const [current] = await transaction
            .select()
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                inArray(recurringMessageOccurrences.status, [
                  "PENDING",
                  "EXECUTING",
                  "RETRY_PENDING",
                ]),
              ),
            )
            .limit(1)
            .for("update");
          expectedCurrent = current ?? null;
          const [cancelled] = await transaction
            .update(scheduledActions)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(and(eq(scheduledActions.id, action.id), eq(scheduledActions.status, "ACTIVE")))
            .returning();
          if (cancelled === undefined) throw new Error("Recurring cancellation was lost");
          await transaction
            .update(scheduledMessageStates)
            .set({ revision: nextRevision })
            .where(
              and(
                eq(scheduledMessageStates.scheduledActionId, action.id),
                eq(scheduledMessageStates.revision, state.revision),
              ),
            );
          if (current?.status === "PENDING" || current?.status === "RETRY_PENDING") {
            await transaction
              .update(recurringMessageOccurrences)
              .set({
                status: "SKIPPED",
                skipReason: "SERIES_CANCELLED",
                terminalAt: input.occurredAt,
                updatedAt: new Date(),
              })
              .where(eq(recurringMessageOccurrences.id, current.id));
          }
          await transaction.insert(recurringMessageAudits).values({
            id: input.auditId,
            scheduledActionId: action.id,
            occurrenceId: current?.id,
            guildId: action.guildId,
            channelId: action.targetId,
            event: "SERIES_CANCELLED",
            actorType: "USER",
            actorId: input.actorId,
            beforeRevision: state.revision,
            afterRevision: nextRevision,
            currentOccurrenceId: current?.id,
            occurrenceSkipReason:
              current?.status === "PENDING" || current?.status === "RETRY_PENDING"
                ? "SERIES_CANCELLED"
                : null,
            postSeriesStatus: "CANCELLED",
            occurredAt: input.occurredAt,
            outcome: "SUCCESS",
          });
          return { outcome: "COMMITTED" } as const;
        });
        if (result.outcome !== "COMMITTED") return result;
        const series = await find(input.scheduledActionId);
        return series === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series };
      } catch {
        const confirmed = await exactAuditCommitted(
          input.auditId,
          input.scheduledActionId,
          (audit) => {
            if (expectedCurrent === undefined) return false;
            const skipped =
              expectedCurrent?.status === "PENDING" || expectedCurrent?.status === "RETRY_PENDING";
            return (
              audit.event === "SERIES_CANCELLED" &&
              audit.actorType === "USER" &&
              audit.actorId === input.actorId &&
              audit.beforeRevision === input.expectedRevision &&
              audit.afterRevision === nextRevision &&
              audit.occurrenceId === (expectedCurrent?.id ?? null) &&
              audit.currentOccurrenceId === (expectedCurrent?.id ?? null) &&
              audit.occurrenceSkipReason === (skipped ? "SERIES_CANCELLED" : null) &&
              audit.postSeriesStatus === "CANCELLED" &&
              audit.occurredAt.getTime() === input.occurredAt.getTime() &&
              audit.outcome === "SUCCESS"
            );
          },
        ).catch(() => undefined);
        return confirmed === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", series: confirmed };
      }
    },
    async materialize(input) {
      if (!isStrictRecurringLocalTime(input.intendedLocalTime)) {
        return { outcome: "NOT_MATERIALIZED" };
      }

      const exactCommittedOccurrence = async (): Promise<
        RecurringMessageOccurrence | undefined
      > => {
        const [row] = await database
          .select({ action: scheduledActions, occurrence: recurringMessageOccurrences })
          .from(recurringMessageOccurrences)
          .innerJoin(
            scheduledActions,
            eq(scheduledActions.id, recurringMessageOccurrences.scheduledActionId),
          )
          .where(eq(recurringMessageOccurrences.id, input.occurrenceId))
          .limit(1);
        const occurrence = row?.occurrence;
        if (
          row === undefined ||
          occurrence === undefined ||
          occurrence.scheduledActionId !== input.scheduledActionId ||
          occurrence.materializedDefinitionRevision !== input.expectedDefinitionRevision ||
          occurrence.intendedLocalDate !== input.intendedLocalDate ||
          occurrence.intendedLocalTime.slice(0, 5) !== input.intendedLocalTime ||
          occurrence.scheduledFor.getTime() !== input.scheduledFor.getTime()
        ) {
          return undefined;
        }
        if (occurrence.status === "PENDING") {
          const initialPendingShape =
            occurrence.retryCount === 0 &&
            occurrence.firstAttemptedAt === null &&
            occurrence.claimedAt === null &&
            occurrence.claimedSeriesRevision === null &&
            occurrence.claimedDefinitionRevision === null &&
            occurrence.claimContent === null &&
            occurrence.claimEmbedTitle === null &&
            occurrence.claimEmbedDescription === null &&
            occurrence.claimEmbedColor === null &&
            occurrence.claimEmbedImageUrl === null &&
            occurrence.resultMessageId === null &&
            occurrence.failureCode === null &&
            occurrence.skipReason === null &&
            occurrence.terminalAt === null;
          if (
            !initialPendingShape ||
            row.action.executeAt.getTime() !== input.scheduledFor.getTime()
          ) {
            return undefined;
          }
        }
        // A later claim, edit, cancellation, or terminalization may change the lifecycle
        // and execute_at; the stable row ID and immutable materialization fields remain evidence.
        return occurrence;
      };

      try {
        return await database.transaction(async (transaction) => {
          const [action] = await transaction
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, input.scheduledActionId))
            .limit(1)
            .for("update");
          if (
            action === undefined ||
            action.actionType !== "SEND_MESSAGE" ||
            action.status !== "ACTIVE"
          ) {
            return { outcome: "NOT_MATERIALIZED" } as const;
          }
          const [recurrence] = await transaction
            .select()
            .from(recurringMessageSchedules)
            .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
            .limit(1);
          if (
            recurrence === undefined ||
            recurrence.definitionRevision !== input.expectedDefinitionRevision
          ) {
            return { outcome: "NOT_MATERIALIZED" } as const;
          }
          const [alreadyMaterialized] = await transaction
            .select()
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                eq(
                  recurringMessageOccurrences.materializedDefinitionRevision,
                  input.expectedDefinitionRevision,
                ),
                eq(recurringMessageOccurrences.intendedLocalDate, input.intendedLocalDate),
                eq(recurringMessageOccurrences.intendedLocalTime, input.intendedLocalTime),
              ),
            )
            .limit(1);
          if (alreadyMaterialized !== undefined) {
            return alreadyMaterialized.id === input.occurrenceId &&
              alreadyMaterialized.scheduledFor.getTime() === input.scheduledFor.getTime()
              ? ({ outcome: "COMMITTED", occurrence: alreadyMaterialized } as const)
              : ({ outcome: "NOT_MATERIALIZED" } as const);
          }
          const [nonterminal] = await transaction
            .select({ id: recurringMessageOccurrences.id })
            .from(recurringMessageOccurrences)
            .where(
              and(
                eq(recurringMessageOccurrences.scheduledActionId, action.id),
                inArray(recurringMessageOccurrences.status, [
                  "PENDING",
                  "EXECUTING",
                  "RETRY_PENDING",
                ]),
              ),
            )
            .limit(1)
            .for("update");
          if (nonterminal !== undefined) return { outcome: "NOT_MATERIALIZED" } as const;
          const [created] = await transaction
            .insert(recurringMessageOccurrences)
            .values({
              id: input.occurrenceId,
              scheduledActionId: action.id,
              materializedDefinitionRevision: input.expectedDefinitionRevision,
              intendedLocalDate: input.intendedLocalDate,
              intendedLocalTime: input.intendedLocalTime,
              scheduledFor: input.scheduledFor,
              status: "PENDING",
              retryCount: 0,
            })
            .onConflictDoNothing({
              target: [
                recurringMessageOccurrences.scheduledActionId,
                recurringMessageOccurrences.materializedDefinitionRevision,
                recurringMessageOccurrences.intendedLocalDate,
                recurringMessageOccurrences.intendedLocalTime,
              ],
            })
            .returning();
          if (created === undefined) return { outcome: "NOT_MATERIALIZED" } as const;
          const [updatedAction] = await transaction
            .update(scheduledActions)
            .set({ executeAt: created.scheduledFor, updatedAt: new Date() })
            .where(eq(scheduledActions.id, action.id))
            .returning();
          if (updatedAction === undefined)
            throw new Error("Materialized execution time was not set");
          return { outcome: "COMMITTED", occurrence: created } as const;
        });
      } catch {
        const occurrence = await exactCommittedOccurrence().catch(() => undefined);
        return occurrence === undefined
          ? { outcome: "PERSISTENCE_UNCONFIRMED" }
          : { outcome: "COMMITTED", occurrence };
      }
    },
    async claimInitial(input) {
      return database.transaction(async (transaction) => {
        const [occurrenceIdentity] = await transaction
          .select({ scheduledActionId: recurringMessageOccurrences.scheduledActionId })
          .from(recurringMessageOccurrences)
          .where(eq(recurringMessageOccurrences.id, input.occurrenceId))
          .limit(1);
        if (occurrenceIdentity === undefined) return { outcome: "NOT_CLAIMED" } as const;

        const [action] = await transaction
          .select()
          .from(scheduledActions)
          .where(eq(scheduledActions.id, occurrenceIdentity.scheduledActionId))
          .limit(1)
          .for("update");
        if (
          action === undefined ||
          action.actionType !== "SEND_MESSAGE" ||
          action.status !== "ACTIVE"
        )
          return { outcome: "NOT_CLAIMED" } as const;
        const [recurrence] = await transaction
          .select()
          .from(recurringMessageSchedules)
          .where(eq(recurringMessageSchedules.scheduledActionId, action.id))
          .limit(1);
        const [occurrence] = await transaction
          .select()
          .from(recurringMessageOccurrences)
          .where(eq(recurringMessageOccurrences.id, input.occurrenceId))
          .limit(1)
          .for("update");
        const [state] = await transaction
          .select()
          .from(scheduledMessageStates)
          .where(eq(scheduledMessageStates.scheduledActionId, action.id))
          .limit(1);
        if (
          recurrence === undefined ||
          occurrence === undefined ||
          state === undefined ||
          occurrence.scheduledActionId !== action.id ||
          occurrence.status !== "PENDING" ||
          state.revision !== input.expectedSeriesRevision ||
          occurrence.materializedDefinitionRevision !== recurrence.definitionRevision
        ) {
          return { outcome: "NOT_CLAIMED" } as const;
        }
        const payload = scheduledMessagePayloadToColumns(scheduledMessagePayloadFromColumns(state));
        const [claimed] = await transaction
          .update(recurringMessageOccurrences)
          .set({
            status: "EXECUTING",
            firstAttemptedAt: input.claimedAt,
            claimedAt: input.claimedAt,
            claimedSeriesRevision: state.revision,
            claimedDefinitionRevision: occurrence.materializedDefinitionRevision,
            claimContent: payload.content,
            claimEmbedTitle: payload.embedTitle,
            claimEmbedDescription: payload.embedDescription,
            claimEmbedColor: payload.embedColor,
            claimEmbedImageUrl: payload.embedImageUrl,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(recurringMessageOccurrences.id, occurrence.id),
              eq(recurringMessageOccurrences.status, "PENDING"),
            ),
          )
          .returning();
        if (claimed === undefined) return { outcome: "NOT_CLAIMED" } as const;
        const series: RecurringMessageSeries = {
          action,
          creatorUserId: state.creatorUserId,
          retryCount: state.retryCount,
          revision: state.revision,
          payload: scheduledMessagePayloadFromColumns(state),
          resultMessageId: state.resultMessageId,
          recurrence,
          occurrence: claimed,
        };
        return { outcome: "COMMITTED", series, occurrence: claimed } as const;
      });
    },
  };
}
