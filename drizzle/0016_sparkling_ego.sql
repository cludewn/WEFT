CREATE TABLE "recurring_message_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_action_id" text NOT NULL,
	"occurrence_id" text,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"before_revision" integer,
	"after_revision" integer,
	"before_content" text,
	"after_content" text,
	"before_embed_title" text,
	"after_embed_title" text,
	"before_embed_description" text,
	"after_embed_description" text,
	"before_embed_color" integer,
	"after_embed_color" integer,
	"before_embed_image_url" text,
	"after_embed_image_url" text,
	"before_frequency" text,
	"after_frequency" text,
	"before_weekday_mask" integer,
	"after_weekday_mask" integer,
	"before_local_time" time,
	"after_local_time" time,
	"before_timezone" text,
	"after_timezone" text,
	"before_definition_revision" integer,
	"after_definition_revision" integer,
	"before_effective_at" timestamp with time zone,
	"after_effective_at" timestamp with time zone,
	"current_occurrence_id" text,
	"deferred_materialization" boolean,
	"selected_next_occurrence_id" text,
	"selected_next_local_date" date,
	"selected_next_local_time" time,
	"selected_next_scheduled_for" timestamp with time zone,
	"intended_local_date" date,
	"intended_local_time" time,
	"scheduled_for" timestamp with time zone,
	"claimed_series_revision" integer,
	"claimed_definition_revision" integer,
	"retry_count" integer,
	"result_message_id" text,
	"failure_code" text,
	"occurrence_skip_reason" text,
	"next_occurrence_id" text,
	"next_intended_local_date" date,
	"next_intended_local_time" time,
	"next_scheduled_for" timestamp with time zone,
	"post_series_status" text,
	"range_start_occurrence_id" text,
	"skipped_from_local_date" date,
	"skipped_from_local_time" time,
	"skipped_through_local_date" date,
	"skipped_through_local_time" time,
	"audit_skip_reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "recurring_message_audits_event_check" CHECK ("recurring_message_audits"."event" in ('SERIES_CREATED', 'PAYLOAD_EDITED', 'RECURRENCE_EDITED',
        'SERIES_CANCELLED', 'OCCURRENCE_RETRY', 'OCCURRENCE_COMPLETED', 'OCCURRENCE_FAILED',
        'DST_GAP_SKIPPED', 'MISSED_RANGE_SKIPPED')),
	CONSTRAINT "recurring_message_audits_common_check" CHECK ("recurring_message_audits"."actor_type" in ('USER', 'SYSTEM')
        and "recurring_message_audits"."outcome" in ('SUCCESS', 'FAILURE', 'SKIPPED')
        and (("recurring_message_audits"."actor_type" = 'USER' and "recurring_message_audits"."actor_id" is not null)
          or ("recurring_message_audits"."actor_type" = 'SYSTEM' and "recurring_message_audits"."actor_id" is null))),
	CONSTRAINT "recurring_message_audits_bounded_values_check" CHECK (("recurring_message_audits"."failure_code" is null or "recurring_message_audits"."failure_code" in (
          'UNSUPPORTED_TARGET', 'TARGET_GUILD_MISMATCH', 'ARCHIVED_THREAD',
          'BOT_PERMISSION_MISSING', 'CURRENT_STATE_CHECK_REJECTED', 'CURRENT_STATE_CHECK_FAILED',
          'PERSISTED_PAYLOAD_INVALID', 'SEND_REJECTED', 'SEND_UNCONFIRMED',
          'RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_COMPENSATED',
          'FINALIZATION_FAILED_UNCOMPENSATED', 'EXECUTION_INTERRUPTED_UNCONFIRMED',
          'PRE_SEND_RETRY_WINDOW_EXCEEDED'))
        and ("recurring_message_audits"."occurrence_skip_reason" is null or "recurring_message_audits"."occurrence_skip_reason" in
          ('RECURRENCE_EDITED', 'SERIES_CANCELLED', 'MISSED_GRACE_EXCEEDED'))
        and ("recurring_message_audits"."post_series_status" is null or "recurring_message_audits"."post_series_status" in ('ACTIVE', 'CANCELLED'))
        and ("recurring_message_audits"."audit_skip_reason" is null or "recurring_message_audits"."audit_skip_reason" in
          ('DST_GAP', 'MISSED_GRACE_EXCEEDED'))
        and ("recurring_message_audits"."retry_count" is null or "recurring_message_audits"."retry_count" between 0 and 3)
        and ("recurring_message_audits"."before_revision" is null or "recurring_message_audits"."before_revision" >= 0)
        and ("recurring_message_audits"."after_revision" is null or "recurring_message_audits"."after_revision" >= 0)
        and ("recurring_message_audits"."before_definition_revision" is null or "recurring_message_audits"."before_definition_revision" >= 0)
        and ("recurring_message_audits"."after_definition_revision" is null or "recurring_message_audits"."after_definition_revision" >= 0)),
	CONSTRAINT "recurring_message_audits_local_times_check" CHECK (("recurring_message_audits"."before_local_time" is null or extract(second from "recurring_message_audits"."before_local_time") = 0)
        and ("recurring_message_audits"."after_local_time" is null or extract(second from "recurring_message_audits"."after_local_time") = 0)
        and ("recurring_message_audits"."selected_next_local_time" is null or extract(second from "recurring_message_audits"."selected_next_local_time") = 0)
        and ("recurring_message_audits"."intended_local_time" is null or extract(second from "recurring_message_audits"."intended_local_time") = 0)
        and ("recurring_message_audits"."next_intended_local_time" is null or extract(second from "recurring_message_audits"."next_intended_local_time") = 0)
        and ("recurring_message_audits"."skipped_from_local_time" is null or extract(second from "recurring_message_audits"."skipped_from_local_time") = 0)
        and ("recurring_message_audits"."skipped_through_local_time" is null or extract(second from "recurring_message_audits"."skipped_through_local_time") = 0)),
	CONSTRAINT "recurring_message_audits_event_shape_check" CHECK ((
        "recurring_message_audits"."event" = 'SERIES_CREATED' and "recurring_message_audits"."actor_type" = 'USER'
        and "recurring_message_audits"."outcome" = 'SUCCESS' and "recurring_message_audits"."after_revision" is not null
        and "recurring_message_audits"."after_frequency" is not null and "recurring_message_audits"."after_weekday_mask" is not null
        and "recurring_message_audits"."after_local_time" is not null and "recurring_message_audits"."after_timezone" is not null
        and "recurring_message_audits"."after_definition_revision" is not null and "recurring_message_audits"."after_effective_at" is not null
        and "recurring_message_audits"."after_content" is not null
        and "recurring_message_audits"."selected_next_occurrence_id" is not null and "recurring_message_audits"."selected_next_local_date" is not null
        and "recurring_message_audits"."selected_next_local_time" is not null and "recurring_message_audits"."selected_next_scheduled_for" is not null
      ) or (
        "recurring_message_audits"."event" = 'PAYLOAD_EDITED' and "recurring_message_audits"."actor_type" = 'USER'
        and "recurring_message_audits"."outcome" = 'SUCCESS' and "recurring_message_audits"."before_revision" is not null
        and "recurring_message_audits"."after_revision" is not null and "recurring_message_audits"."before_content" is not null
        and "recurring_message_audits"."after_content" is not null
      ) or (
        "recurring_message_audits"."event" = 'RECURRENCE_EDITED' and "recurring_message_audits"."actor_type" = 'USER'
        and "recurring_message_audits"."outcome" = 'SUCCESS' and "recurring_message_audits"."before_revision" is not null
        and "recurring_message_audits"."after_revision" is not null and "recurring_message_audits"."before_frequency" is not null
        and "recurring_message_audits"."after_frequency" is not null and "recurring_message_audits"."before_timezone" is not null
        and "recurring_message_audits"."after_timezone" is not null and "recurring_message_audits"."before_weekday_mask" is not null
        and "recurring_message_audits"."after_weekday_mask" is not null and "recurring_message_audits"."before_local_time" is not null
        and "recurring_message_audits"."after_local_time" is not null and "recurring_message_audits"."before_definition_revision" is not null
        and "recurring_message_audits"."after_definition_revision" is not null and "recurring_message_audits"."before_effective_at" is not null
        and "recurring_message_audits"."after_effective_at" is not null and "recurring_message_audits"."current_occurrence_id" is not null
        and "recurring_message_audits"."deferred_materialization" is not null
        and (("recurring_message_audits"."deferred_materialization" and "recurring_message_audits"."selected_next_occurrence_id" is null
          and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null
          and "recurring_message_audits"."selected_next_scheduled_for" is null)
          or (not "recurring_message_audits"."deferred_materialization" and "recurring_message_audits"."selected_next_occurrence_id" is not null
          and "recurring_message_audits"."selected_next_local_date" is not null and "recurring_message_audits"."selected_next_local_time" is not null
          and "recurring_message_audits"."selected_next_scheduled_for" is not null))
      ) or (
        "recurring_message_audits"."event" = 'SERIES_CANCELLED' and "recurring_message_audits"."actor_type" = 'USER'
        and "recurring_message_audits"."outcome" = 'SUCCESS' and "recurring_message_audits"."before_revision" is not null
        and "recurring_message_audits"."after_revision" is not null and "recurring_message_audits"."post_series_status" = 'CANCELLED'
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_RETRY' and "recurring_message_audits"."actor_type" = 'SYSTEM'
        and "recurring_message_audits"."outcome" = 'FAILURE' and "recurring_message_audits"."occurrence_id" is not null
        and "recurring_message_audits"."intended_local_date" is not null and "recurring_message_audits"."intended_local_time" is not null
        and "recurring_message_audits"."scheduled_for" is not null and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null
        and "recurring_message_audits"."failure_code" is not null and "recurring_message_audits"."retry_count" between 1 and 3
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_COMPLETED' and "recurring_message_audits"."actor_type" = 'SYSTEM'
        and "recurring_message_audits"."outcome" = 'SUCCESS' and "recurring_message_audits"."occurrence_id" is not null
        and "recurring_message_audits"."intended_local_date" is not null and "recurring_message_audits"."intended_local_time" is not null
        and "recurring_message_audits"."scheduled_for" is not null and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null and "recurring_message_audits"."retry_count" is not null
        and "recurring_message_audits"."result_message_id" is not null and "recurring_message_audits"."failure_code" is null
        and "recurring_message_audits"."post_series_status" in ('ACTIVE', 'CANCELLED')
        and (("recurring_message_audits"."post_series_status" = 'ACTIVE' and "recurring_message_audits"."next_occurrence_id" is not null
          and "recurring_message_audits"."next_intended_local_date" is not null and "recurring_message_audits"."next_intended_local_time" is not null
          and "recurring_message_audits"."next_scheduled_for" is not null)
          or ("recurring_message_audits"."post_series_status" = 'CANCELLED' and "recurring_message_audits"."next_occurrence_id" is null
          and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null
          and "recurring_message_audits"."next_scheduled_for" is null))
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_FAILED' and "recurring_message_audits"."actor_type" = 'SYSTEM'
        and "recurring_message_audits"."outcome" = 'FAILURE' and "recurring_message_audits"."occurrence_id" is not null
        and "recurring_message_audits"."intended_local_date" is not null and "recurring_message_audits"."intended_local_time" is not null
        and "recurring_message_audits"."scheduled_for" is not null and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null and "recurring_message_audits"."retry_count" is not null
        and "recurring_message_audits"."failure_code" is not null
        and ("recurring_message_audits"."result_message_id" is null or "recurring_message_audits"."failure_code" in
          ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))
        and "recurring_message_audits"."post_series_status" in ('ACTIVE', 'CANCELLED')
        and (("recurring_message_audits"."post_series_status" = 'ACTIVE' and "recurring_message_audits"."next_occurrence_id" is not null
          and "recurring_message_audits"."next_intended_local_date" is not null and "recurring_message_audits"."next_intended_local_time" is not null
          and "recurring_message_audits"."next_scheduled_for" is not null)
          or ("recurring_message_audits"."post_series_status" = 'CANCELLED' and "recurring_message_audits"."next_occurrence_id" is null
          and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null
          and "recurring_message_audits"."next_scheduled_for" is null))
      ) or (
        "recurring_message_audits"."event" = 'DST_GAP_SKIPPED' and "recurring_message_audits"."outcome" = 'SKIPPED'
        and "recurring_message_audits"."intended_local_date" is not null and "recurring_message_audits"."intended_local_time" is not null
        and "recurring_message_audits"."after_timezone" is not null and "recurring_message_audits"."after_definition_revision" is not null
        and "recurring_message_audits"."audit_skip_reason" = 'DST_GAP' and "recurring_message_audits"."occurrence_id" is null
      ) or (
        "recurring_message_audits"."event" = 'MISSED_RANGE_SKIPPED' and "recurring_message_audits"."actor_type" = 'SYSTEM'
        and "recurring_message_audits"."outcome" = 'SKIPPED' and "recurring_message_audits"."after_timezone" is not null
        and "recurring_message_audits"."skipped_from_local_date" is not null and "recurring_message_audits"."skipped_from_local_time" is not null
        and "recurring_message_audits"."skipped_through_local_date" is not null and "recurring_message_audits"."skipped_through_local_time" is not null
        and "recurring_message_audits"."selected_next_local_date" is not null and "recurring_message_audits"."selected_next_local_time" is not null
        and "recurring_message_audits"."selected_next_scheduled_for" is not null
        and "recurring_message_audits"."audit_skip_reason" = 'MISSED_GRACE_EXCEEDED'
      )),
	CONSTRAINT "recurring_message_audits_event_exclusivity_check" CHECK (coalesce((
        "recurring_message_audits"."event" = 'SERIES_CREATED'
        and "recurring_message_audits"."actor_type" = 'USER' and "recurring_message_audits"."outcome" = 'SUCCESS'
        and "recurring_message_audits"."after_revision" is not null and "recurring_message_audits"."after_content" is not null
        and "recurring_message_audits"."after_frequency" is not null and "recurring_message_audits"."after_weekday_mask" is not null
        and "recurring_message_audits"."after_local_time" is not null and "recurring_message_audits"."after_timezone" is not null
        and "recurring_message_audits"."after_definition_revision" is not null and "recurring_message_audits"."after_effective_at" is not null
        and "recurring_message_audits"."selected_next_occurrence_id" is not null
        and "recurring_message_audits"."selected_next_local_date" is not null and "recurring_message_audits"."selected_next_local_time" is not null
        and "recurring_message_audits"."selected_next_scheduled_for" is not null and "recurring_message_audits"."post_series_status" = 'ACTIVE'
        and "recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."intended_local_date" is null and "recurring_message_audits"."intended_local_time" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'PAYLOAD_EDITED'
        and "recurring_message_audits"."actor_type" = 'USER' and "recurring_message_audits"."outcome" = 'SUCCESS'
        and "recurring_message_audits"."before_revision" is not null and "recurring_message_audits"."after_revision" is not null
        and "recurring_message_audits"."before_content" is not null and "recurring_message_audits"."after_content" is not null
        and "recurring_message_audits"."post_series_status" = 'ACTIVE'
        and "recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."after_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."after_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."intended_local_date" is null and "recurring_message_audits"."intended_local_time" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'RECURRENCE_EDITED'
        and "recurring_message_audits"."actor_type" = 'USER' and "recurring_message_audits"."outcome" = 'SUCCESS'
        and "recurring_message_audits"."before_revision" is not null and "recurring_message_audits"."after_revision" is not null
        and "recurring_message_audits"."before_frequency" is not null and "recurring_message_audits"."after_frequency" is not null
        and "recurring_message_audits"."before_weekday_mask" is not null and "recurring_message_audits"."after_weekday_mask" is not null
        and "recurring_message_audits"."before_local_time" is not null and "recurring_message_audits"."after_local_time" is not null
        and "recurring_message_audits"."before_timezone" is not null and "recurring_message_audits"."after_timezone" is not null
        and "recurring_message_audits"."before_definition_revision" is not null
        and "recurring_message_audits"."after_definition_revision" is not null
        and "recurring_message_audits"."before_effective_at" is not null and "recurring_message_audits"."after_effective_at" is not null
        and "recurring_message_audits"."current_occurrence_id" is not null
        and "recurring_message_audits"."deferred_materialization" is not null and "recurring_message_audits"."post_series_status" = 'ACTIVE'
        and (("recurring_message_audits"."deferred_materialization" and "recurring_message_audits"."selected_next_occurrence_id" is null
          and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null
          and "recurring_message_audits"."selected_next_scheduled_for" is null)
          or (not "recurring_message_audits"."deferred_materialization" and "recurring_message_audits"."selected_next_occurrence_id" is not null
          and "recurring_message_audits"."selected_next_local_date" is not null and "recurring_message_audits"."selected_next_local_time" is not null
          and "recurring_message_audits"."selected_next_scheduled_for" is not null))
        and "recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."intended_local_date" is null and "recurring_message_audits"."intended_local_time" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'SERIES_CANCELLED'
        and "recurring_message_audits"."actor_type" = 'USER' and "recurring_message_audits"."outcome" = 'SUCCESS'
        and "recurring_message_audits"."before_revision" is not null and "recurring_message_audits"."after_revision" is not null
        and "recurring_message_audits"."post_series_status" = 'CANCELLED'
        and (("recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."current_occurrence_id" is null
          and "recurring_message_audits"."occurrence_skip_reason" is null)
          or ("recurring_message_audits"."occurrence_id" is not null
          and "recurring_message_audits"."current_occurrence_id" = "recurring_message_audits"."occurrence_id"
          and ("recurring_message_audits"."occurrence_skip_reason" is null
            or "recurring_message_audits"."occurrence_skip_reason" = 'SERIES_CANCELLED')))
        and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."after_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."after_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."intended_local_date" is null and "recurring_message_audits"."intended_local_time" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_RETRY'
        and "recurring_message_audits"."actor_type" = 'SYSTEM' and "recurring_message_audits"."outcome" = 'FAILURE'
        and "recurring_message_audits"."occurrence_id" is not null and "recurring_message_audits"."intended_local_date" is not null
        and "recurring_message_audits"."intended_local_time" is not null and "recurring_message_audits"."scheduled_for" is not null
        and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null
        and "recurring_message_audits"."retry_count" between 1 and 3 and "recurring_message_audits"."failure_code" is not null
        and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."after_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."after_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."after_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."post_series_status" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_COMPLETED'
        and "recurring_message_audits"."actor_type" = 'SYSTEM' and "recurring_message_audits"."outcome" = 'SUCCESS'
        and "recurring_message_audits"."occurrence_id" is not null and "recurring_message_audits"."intended_local_date" is not null
        and "recurring_message_audits"."intended_local_time" is not null and "recurring_message_audits"."scheduled_for" is not null
        and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null and "recurring_message_audits"."retry_count" is not null
        and "recurring_message_audits"."result_message_id" is not null and "recurring_message_audits"."post_series_status" in ('ACTIVE', 'CANCELLED')
        and (("recurring_message_audits"."post_series_status" = 'ACTIVE' and "recurring_message_audits"."next_occurrence_id" is not null
          and "recurring_message_audits"."next_intended_local_date" is not null and "recurring_message_audits"."next_intended_local_time" is not null
          and "recurring_message_audits"."next_scheduled_for" is not null)
          or ("recurring_message_audits"."post_series_status" = 'CANCELLED' and "recurring_message_audits"."next_occurrence_id" is null
          and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null
          and "recurring_message_audits"."next_scheduled_for" is null))
        and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."after_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."after_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."after_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'OCCURRENCE_FAILED'
        and "recurring_message_audits"."actor_type" = 'SYSTEM' and "recurring_message_audits"."outcome" = 'FAILURE'
        and "recurring_message_audits"."occurrence_id" is not null and "recurring_message_audits"."intended_local_date" is not null
        and "recurring_message_audits"."intended_local_time" is not null and "recurring_message_audits"."scheduled_for" is not null
        and "recurring_message_audits"."claimed_series_revision" is not null
        and "recurring_message_audits"."claimed_definition_revision" is not null and "recurring_message_audits"."retry_count" is not null
        and "recurring_message_audits"."failure_code" is not null
        and ("recurring_message_audits"."result_message_id" is null or "recurring_message_audits"."failure_code" in
          ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))
        and "recurring_message_audits"."post_series_status" in ('ACTIVE', 'CANCELLED')
        and (("recurring_message_audits"."post_series_status" = 'ACTIVE' and "recurring_message_audits"."next_occurrence_id" is not null
          and "recurring_message_audits"."next_intended_local_date" is not null and "recurring_message_audits"."next_intended_local_time" is not null
          and "recurring_message_audits"."next_scheduled_for" is not null)
          or ("recurring_message_audits"."post_series_status" = 'CANCELLED' and "recurring_message_audits"."next_occurrence_id" is null
          and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null
          and "recurring_message_audits"."next_scheduled_for" is null))
        and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."after_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."after_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."after_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null and "recurring_message_audits"."audit_skip_reason" is null
      ) or (
        "recurring_message_audits"."event" = 'DST_GAP_SKIPPED' and "recurring_message_audits"."outcome" = 'SKIPPED'
        and "recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."intended_local_date" is not null
        and "recurring_message_audits"."intended_local_time" is not null and "recurring_message_audits"."after_timezone" is not null
        and "recurring_message_audits"."after_definition_revision" is not null and "recurring_message_audits"."audit_skip_reason" = 'DST_GAP'
        and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."after_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."selected_next_local_date" is null and "recurring_message_audits"."selected_next_local_time" is null and "recurring_message_audits"."selected_next_scheduled_for" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."post_series_status" is null and "recurring_message_audits"."range_start_occurrence_id" is null and "recurring_message_audits"."skipped_from_local_date" is null and "recurring_message_audits"."skipped_from_local_time" is null and "recurring_message_audits"."skipped_through_local_date" is null and "recurring_message_audits"."skipped_through_local_time" is null
      ) or (
        "recurring_message_audits"."event" = 'MISSED_RANGE_SKIPPED'
        and "recurring_message_audits"."actor_type" = 'SYSTEM' and "recurring_message_audits"."outcome" = 'SKIPPED'
        and "recurring_message_audits"."after_timezone" is not null and "recurring_message_audits"."after_definition_revision" is not null
        and "recurring_message_audits"."skipped_from_local_date" is not null and "recurring_message_audits"."skipped_from_local_time" is not null
        and "recurring_message_audits"."skipped_through_local_date" is not null
        and "recurring_message_audits"."skipped_through_local_time" is not null
        and "recurring_message_audits"."selected_next_local_date" is not null and "recurring_message_audits"."selected_next_local_time" is not null
        and "recurring_message_audits"."selected_next_scheduled_for" is not null
        and "recurring_message_audits"."audit_skip_reason" = 'MISSED_GRACE_EXCEEDED'
        and "recurring_message_audits"."occurrence_id" is null and "recurring_message_audits"."before_revision" is null and "recurring_message_audits"."after_revision" is null and "recurring_message_audits"."before_content" is null and "recurring_message_audits"."after_content" is null and "recurring_message_audits"."before_embed_title" is null and "recurring_message_audits"."after_embed_title" is null and "recurring_message_audits"."before_embed_description" is null and "recurring_message_audits"."after_embed_description" is null and "recurring_message_audits"."before_embed_color" is null and "recurring_message_audits"."after_embed_color" is null and "recurring_message_audits"."before_embed_image_url" is null and "recurring_message_audits"."after_embed_image_url" is null and "recurring_message_audits"."before_frequency" is null and "recurring_message_audits"."after_frequency" is null and "recurring_message_audits"."before_weekday_mask" is null and "recurring_message_audits"."after_weekday_mask" is null and "recurring_message_audits"."before_local_time" is null and "recurring_message_audits"."after_local_time" is null and "recurring_message_audits"."before_timezone" is null and "recurring_message_audits"."before_definition_revision" is null and "recurring_message_audits"."before_effective_at" is null and "recurring_message_audits"."after_effective_at" is null and "recurring_message_audits"."current_occurrence_id" is null and "recurring_message_audits"."deferred_materialization" is null and "recurring_message_audits"."selected_next_occurrence_id" is null and "recurring_message_audits"."intended_local_date" is null and "recurring_message_audits"."intended_local_time" is null and "recurring_message_audits"."scheduled_for" is null and "recurring_message_audits"."claimed_series_revision" is null and "recurring_message_audits"."claimed_definition_revision" is null and "recurring_message_audits"."retry_count" is null and "recurring_message_audits"."result_message_id" is null and "recurring_message_audits"."failure_code" is null and "recurring_message_audits"."occurrence_skip_reason" is null and "recurring_message_audits"."next_occurrence_id" is null and "recurring_message_audits"."next_intended_local_date" is null and "recurring_message_audits"."next_intended_local_time" is null and "recurring_message_audits"."next_scheduled_for" is null and "recurring_message_audits"."post_series_status" is null
      ), false))
);
--> statement-breakpoint
CREATE TABLE "recurring_message_occurrences" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_action_id" text NOT NULL,
	"materialized_definition_revision" integer NOT NULL,
	"intended_local_date" date NOT NULL,
	"intended_local_time" time NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"first_attempted_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"claimed_series_revision" integer,
	"claimed_definition_revision" integer,
	"claim_content" text,
	"claim_embed_title" text,
	"claim_embed_description" text,
	"claim_embed_color" integer,
	"claim_embed_image_url" text,
	"result_message_id" text,
	"failure_code" text,
	"skip_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "recurring_message_occurrences_status_check" CHECK ("recurring_message_occurrences"."status" in ('PENDING', 'EXECUTING', 'RETRY_PENDING', 'COMPLETED', 'FAILED', 'SKIPPED')),
	CONSTRAINT "recurring_message_occurrences_retry_count_check" CHECK ("recurring_message_occurrences"."retry_count" between 0 and 3),
	CONSTRAINT "recurring_message_occurrences_local_time_check" CHECK (extract(second from "recurring_message_occurrences"."intended_local_time") = 0),
	CONSTRAINT "recurring_message_occurrences_failure_code_check" CHECK ("recurring_message_occurrences"."failure_code" is null or "recurring_message_occurrences"."failure_code" in (
        'UNSUPPORTED_TARGET', 'TARGET_GUILD_MISMATCH', 'ARCHIVED_THREAD',
        'BOT_PERMISSION_MISSING', 'CURRENT_STATE_CHECK_REJECTED', 'CURRENT_STATE_CHECK_FAILED',
        'PERSISTED_PAYLOAD_INVALID', 'SEND_REJECTED', 'SEND_UNCONFIRMED',
        'RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_COMPENSATED',
        'FINALIZATION_FAILED_UNCOMPENSATED', 'EXECUTION_INTERRUPTED_UNCONFIRMED',
        'PRE_SEND_RETRY_WINDOW_EXCEEDED')),
	CONSTRAINT "recurring_message_occurrences_skip_reason_check" CHECK ("recurring_message_occurrences"."skip_reason" is null or "recurring_message_occurrences"."skip_reason" in
        ('RECURRENCE_EDITED', 'SERIES_CANCELLED', 'MISSED_GRACE_EXCEEDED')),
	CONSTRAINT "recurring_message_occurrences_claim_payload_check" CHECK ("recurring_message_occurrences"."claim_content" is null or (
        char_length("recurring_message_occurrences"."claim_content") between 0 and 2000
        and ("recurring_message_occurrences"."claim_embed_title" is null or char_length("recurring_message_occurrences"."claim_embed_title") between 1 and 256)
        and ("recurring_message_occurrences"."claim_embed_description" is null or char_length("recurring_message_occurrences"."claim_embed_description") between 1 and 4000)
        and ("recurring_message_occurrences"."claim_embed_color" is null or "recurring_message_occurrences"."claim_embed_color" between 0 and 16777215)
        and ("recurring_message_occurrences"."claim_embed_image_url" is null or char_length("recurring_message_occurrences"."claim_embed_image_url") between 1 and 2048)
        and ("recurring_message_occurrences"."claim_embed_color" is null or "recurring_message_occurrences"."claim_embed_title" is not null
          or "recurring_message_occurrences"."claim_embed_description" is not null or "recurring_message_occurrences"."claim_embed_image_url" is not null)
        and (char_length("recurring_message_occurrences"."claim_content") > 0 or "recurring_message_occurrences"."claim_embed_title" is not null
          or "recurring_message_occurrences"."claim_embed_description" is not null or "recurring_message_occurrences"."claim_embed_image_url" is not null))),
	CONSTRAINT "recurring_message_occurrences_claim_revision_check" CHECK ("recurring_message_occurrences"."claimed_definition_revision" is null
        or "recurring_message_occurrences"."claimed_definition_revision" = "recurring_message_occurrences"."materialized_definition_revision"),
	CONSTRAINT "recurring_message_occurrences_lifecycle_shape_check" CHECK ((
        "recurring_message_occurrences"."status" = 'PENDING' and "recurring_message_occurrences"."retry_count" = 0
        and "recurring_message_occurrences"."first_attempted_at" is null and "recurring_message_occurrences"."claimed_at" is null
        and "recurring_message_occurrences"."claimed_series_revision" is null and "recurring_message_occurrences"."claimed_definition_revision" is null
        and "recurring_message_occurrences"."claim_content" is null and "recurring_message_occurrences"."claim_embed_title" is null
        and "recurring_message_occurrences"."claim_embed_description" is null and "recurring_message_occurrences"."claim_embed_color" is null
        and "recurring_message_occurrences"."claim_embed_image_url" is null and "recurring_message_occurrences"."result_message_id" is null
        and "recurring_message_occurrences"."failure_code" is null and "recurring_message_occurrences"."skip_reason" is null and "recurring_message_occurrences"."terminal_at" is null
      ) or (
        "recurring_message_occurrences"."status" in ('EXECUTING', 'RETRY_PENDING', 'COMPLETED', 'FAILED')
        and "recurring_message_occurrences"."first_attempted_at" is not null and "recurring_message_occurrences"."claimed_at" is not null
        and "recurring_message_occurrences"."claimed_series_revision" is not null and "recurring_message_occurrences"."claimed_definition_revision" is not null
        and "recurring_message_occurrences"."claim_content" is not null
        and ("recurring_message_occurrences"."status" <> 'EXECUTING' or ("recurring_message_occurrences"."result_message_id" is null
          and "recurring_message_occurrences"."failure_code" is null and "recurring_message_occurrences"."skip_reason" is null and "recurring_message_occurrences"."terminal_at" is null))
        and ("recurring_message_occurrences"."status" <> 'RETRY_PENDING' or ("recurring_message_occurrences"."retry_count" between 1 and 3
          and "recurring_message_occurrences"."result_message_id" is null and "recurring_message_occurrences"."failure_code" is null
          and "recurring_message_occurrences"."skip_reason" is null and "recurring_message_occurrences"."terminal_at" is null))
        and ("recurring_message_occurrences"."status" <> 'COMPLETED' or ("recurring_message_occurrences"."result_message_id" is not null
          and "recurring_message_occurrences"."failure_code" is null and "recurring_message_occurrences"."skip_reason" is null and "recurring_message_occurrences"."terminal_at" is not null))
        and ("recurring_message_occurrences"."status" <> 'FAILED' or ("recurring_message_occurrences"."failure_code" is not null
          and "recurring_message_occurrences"."skip_reason" is null and "recurring_message_occurrences"."terminal_at" is not null
          and ("recurring_message_occurrences"."result_message_id" is null or "recurring_message_occurrences"."failure_code" in
            ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED'))))
      ) or (
        "recurring_message_occurrences"."status" = 'SKIPPED' and "recurring_message_occurrences"."failure_code" is null
        and "recurring_message_occurrences"."result_message_id" is null and "recurring_message_occurrences"."skip_reason" is not null
        and "recurring_message_occurrences"."terminal_at" is not null
        and ((
          "recurring_message_occurrences"."first_attempted_at" is null and "recurring_message_occurrences"."claimed_at" is null
          and "recurring_message_occurrences"."claimed_series_revision" is null and "recurring_message_occurrences"."claimed_definition_revision" is null
          and "recurring_message_occurrences"."claim_content" is null and "recurring_message_occurrences"."claim_embed_title" is null
          and "recurring_message_occurrences"."claim_embed_description" is null and "recurring_message_occurrences"."claim_embed_color" is null
          and "recurring_message_occurrences"."claim_embed_image_url" is null and "recurring_message_occurrences"."retry_count" = 0
        ) or (
          "recurring_message_occurrences"."first_attempted_at" is not null and "recurring_message_occurrences"."claimed_at" is not null
          and "recurring_message_occurrences"."claimed_series_revision" is not null and "recurring_message_occurrences"."claimed_definition_revision" is not null
          and "recurring_message_occurrences"."claim_content" is not null and "recurring_message_occurrences"."retry_count" between 1 and 3
          and "recurring_message_occurrences"."skip_reason" = 'SERIES_CANCELLED'
        ))
      ))
);
--> statement-breakpoint
CREATE TABLE "recurring_message_schedules" (
	"scheduled_action_id" text PRIMARY KEY NOT NULL,
	"timezone" text NOT NULL,
	"frequency" text NOT NULL,
	"weekday_mask" integer NOT NULL,
	"local_time" time NOT NULL,
	"definition_revision" integer NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_message_schedules_recurrence_check" CHECK (("recurring_message_schedules"."frequency" = 'DAILY' and "recurring_message_schedules"."weekday_mask" = 127)
        or ("recurring_message_schedules"."frequency" = 'WEEKLY' and "recurring_message_schedules"."weekday_mask" between 1 and 127)),
	CONSTRAINT "recurring_message_schedules_timezone_check" CHECK (char_length("recurring_message_schedules"."timezone") > 0 and left("recurring_message_schedules"."timezone", 1) not in ('+', '-')),
	CONSTRAINT "recurring_message_schedules_definition_revision_check" CHECK ("recurring_message_schedules"."definition_revision" >= 0),
	CONSTRAINT "recurring_message_schedules_local_time_check" CHECK (extract(second from "recurring_message_schedules"."local_time") = 0)
);
--> statement-breakpoint
ALTER TABLE "recurring_message_audits" ADD CONSTRAINT "recurring_message_audits_series_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."recurring_message_schedules"("scheduled_action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_message_audits" ADD CONSTRAINT "recurring_message_audits_occurrence_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."recurring_message_occurrences"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_message_occurrences" ADD CONSTRAINT "recurring_message_occurrences_series_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."recurring_message_schedules"("scheduled_action_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_message_schedules" ADD CONSTRAINT "recurring_message_schedules_scheduled_action_id_scheduled_actions_id_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."scheduled_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "recurring_message_audits_series_id_idx" ON "recurring_message_audits" USING btree ("scheduled_action_id");--> statement-breakpoint
CREATE INDEX "recurring_message_audits_occurrence_id_idx" ON "recurring_message_audits" USING btree ("occurrence_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_message_occurrences_nonterminal_unique" ON "recurring_message_occurrences" USING btree ("scheduled_action_id") WHERE "recurring_message_occurrences"."status" in ('PENDING', 'EXECUTING', 'RETRY_PENDING');--> statement-breakpoint
CREATE UNIQUE INDEX "recurring_message_occurrences_materialization_unique" ON "recurring_message_occurrences" USING btree ("scheduled_action_id","materialized_definition_revision","intended_local_date","intended_local_time");--> statement-breakpoint
CREATE INDEX "recurring_message_occurrences_series_status_idx" ON "recurring_message_occurrences" USING btree ("scheduled_action_id","status");