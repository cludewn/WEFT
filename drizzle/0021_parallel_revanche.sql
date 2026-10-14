CREATE TABLE "administrative_operation_failure_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"operation_code" text NOT NULL,
	"failure_stage" text NOT NULL,
	"failure_reason_code" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "administrative_operation_failure_audits_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "administrative_failure_identity_check" CHECK ("administrative_operation_failure_audits"."guild_id" <> '' and "administrative_operation_failure_audits"."actor_user_id" <> '' and ("administrative_operation_failure_audits"."target_id" is null or "administrative_operation_failure_audits"."target_id" <> '')),
	CONSTRAINT "administrative_failure_outcome_check" CHECK ("administrative_operation_failure_audits"."outcome" = 'FAILURE'),
	CONSTRAINT "administrative_failure_target_check" CHECK ((
    ("administrative_operation_failure_audits"."operation_code" in ('GUILD_TIMEZONE_SET','GUILD_CLOSED_PREFIX_SET','AUTO_CLOSE_INACTIVITY_SET','AUTO_CLOSE_BOT_MESSAGES_SET','AUDIT_DESTINATION_DISABLE','LINK_PREVIEW_MODE_SET') and "administrative_operation_failure_audits"."target_type" = 'GUILD' and "administrative_operation_failure_audits"."target_id" = "administrative_operation_failure_audits"."guild_id")
    or ("administrative_operation_failure_audits"."operation_code" in ('AUTO_CLOSE_PARENT_ADD','AUTO_CLOSE_PARENT_REMOVE') and "administrative_operation_failure_audits"."target_type" = 'PARENT_CHANNEL' and "administrative_operation_failure_audits"."target_id" is not null)
    or ("administrative_operation_failure_audits"."operation_code" in ('THREAD_TRACK','THREAD_UNTRACK','THREAD_CLOSE_AFTER_SET','THREAD_CANCEL_CLOSE','MANUAL_CLOSE_PREPARATION','BULK_CLOSE_PREPARATION') and "administrative_operation_failure_audits"."target_type" = 'THREAD' and "administrative_operation_failure_audits"."target_id" is not null)
    or ("administrative_operation_failure_audits"."operation_code" in ('ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CREATE') and "administrative_operation_failure_audits"."target_type" = 'CHANNEL' and "administrative_operation_failure_audits"."target_id" is not null)
    or ("administrative_operation_failure_audits"."operation_code" = 'AUDIT_DESTINATION_SET' and "administrative_operation_failure_audits"."target_type" = 'CHANNEL' and ("administrative_operation_failure_audits"."target_id" is not null or "administrative_operation_failure_audits"."failure_stage" = 'DISCORD_READ'))
    or ("administrative_operation_failure_audits"."operation_code" in ('ONE_TIME_MESSAGE_CANCEL','ONE_TIME_MESSAGE_EDIT','ONE_TIME_MESSAGE_RESCHEDULE','RECURRING_MESSAGE_CANCEL','RECURRING_MESSAGE_PAYLOAD_EDIT','RECURRING_MESSAGE_RECURRENCE_EDIT') and "administrative_operation_failure_audits"."target_type" = 'SCHEDULE' and "administrative_operation_failure_audits"."target_id" is not null and "administrative_operation_failure_audits"."target_id" ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  ) is true),
	CONSTRAINT "administrative_failure_stage_check" CHECK ((
    ("administrative_operation_failure_audits"."failure_stage" = 'DATABASE_START' and "administrative_operation_failure_audits"."failure_reason_code" = 'TRANSACTION_START_FAILED')
    or ("administrative_operation_failure_audits"."failure_stage" = 'DATABASE_TRANSACTION' and "administrative_operation_failure_audits"."failure_reason_code" = 'TRANSACTION_ROLLED_BACK')
    or ("administrative_operation_failure_audits"."failure_stage" = 'DATABASE_COMMIT' and "administrative_operation_failure_audits"."failure_reason_code" = 'COMMIT_REJECTED')
    or ("administrative_operation_failure_audits"."operation_code" in ('AUTO_CLOSE_PARENT_ADD','ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CANCEL','RECURRING_MESSAGE_PAYLOAD_EDIT') and "administrative_operation_failure_audits"."failure_stage" = 'DATABASE_READ' and "administrative_operation_failure_audits"."failure_reason_code" = 'REQUIRED_STATE_READ_FAILED')
    or ("administrative_operation_failure_audits"."operation_code" = 'AUTO_CLOSE_PARENT_ADD' and "administrative_operation_failure_audits"."failure_stage" = 'DISCORD_ENUMERATION' and "administrative_operation_failure_audits"."failure_reason_code" = 'ACTIVE_THREAD_ENUMERATION_FAILED')
    or ("administrative_operation_failure_audits"."operation_code" in ('AUDIT_DESTINATION_SET','THREAD_CLOSE_AFTER_SET','ONE_TIME_MESSAGE_CREATE','RECURRING_MESSAGE_CREATE') and (
      ("administrative_operation_failure_audits"."failure_stage" = 'DISCORD_PREFLIGHT' and "administrative_operation_failure_audits"."failure_reason_code" in ('BOT_PERMISSION_MISSING','BOT_CONTEXT_UNAVAILABLE'))
      or ("administrative_operation_failure_audits"."failure_stage" = 'DISCORD_READ' and "administrative_operation_failure_audits"."failure_reason_code" in ('REQUIRED_RESOURCE_READ_FAILED','REQUIRED_RESOURCE_UNAVAILABLE'))
    ))
  ) is true)
);
--> statement-breakpoint
CREATE INDEX "administrative_failure_retention_idx" ON "administrative_operation_failure_audits" USING btree ("occurred_at","id");