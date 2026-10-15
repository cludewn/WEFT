CREATE TABLE "managed_message_execution_failure_audits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"operation_id" uuid NOT NULL,
	"success_audit_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"message_id" text,
	"operation_code" text NOT NULL,
	"stage" text NOT NULL,
	"reason_code" text NOT NULL,
	"outcome" text NOT NULL,
	"discord_evidence" text NOT NULL,
	"payload_evidence" text NOT NULL,
	"transaction_evidence" text NOT NULL,
	"database_effect" text NOT NULL,
	"compensation_type" text NOT NULL,
	"compensation_evidence" text NOT NULL,
	"discord_effect_at" timestamp with time zone,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "managed_message_execution_failure_audits_operation_id_unique" UNIQUE("operation_id"),
	CONSTRAINT "managed_execution_codes_check" CHECK ("managed_message_execution_failure_audits"."operation_code" in ('MANAGED_MESSAGE_SEND','MANAGED_MESSAGE_EDIT')
    and "managed_message_execution_failure_audits"."stage" in ('DISCORD_PREFLIGHT','DISCORD_READ','DISCORD_MUTATION','DISCORD_RESPONSE','DATABASE_START','DATABASE_TRANSACTION','DATABASE_COMMIT','DATABASE_GUARD','DELETION_FINALIZATION')
    and "managed_message_execution_failure_audits"."reason_code" in ('BOT_PERMISSION_MISSING','REQUIRED_RESOURCE_READ_FAILED','MUTATION_REJECTED','EDIT_NOT_APPLIED','RETURNED_PAYLOAD_PROJECTION_FAILED','RETURNED_PAYLOAD_MISMATCH','RETURNED_RESPONSE_READ_FAILED','TRANSACTION_START_FAILED','TRANSACTION_ROLLED_BACK','COMMIT_REJECTED','FINALIZATION_NOT_TRANSITIONED')
    and "managed_message_execution_failure_audits"."outcome" in ('FAILURE','PARTIAL')
    and "managed_message_execution_failure_audits"."discord_evidence" in ('NOT_ATTEMPTED','REJECTED','NOT_APPLIED_BY_READBACK','SEND_CONFIRMED','EDIT_CONFIRMED','DELETION_OBSERVED')
    and "managed_message_execution_failure_audits"."payload_evidence" in ('NOT_CHECKED','MATCH','PROJECTION_UNAVAILABLE','MISMATCH')
    and "managed_message_execution_failure_audits"."transaction_evidence" in ('NOT_ATTEMPTED','START_FAILED','ROLLED_BACK','COMMIT_REJECTED','COMMITTED','UNCONFIRMED')
    and "managed_message_execution_failure_audits"."database_effect" in ('NOT_ATTEMPTED','NOT_APPLIED','NOT_TRANSITIONED')
    and "managed_message_execution_failure_audits"."compensation_type" in ('NONE','DELETE','RESTORE')
    and "managed_message_execution_failure_audits"."compensation_evidence" in ('NOT_REQUIRED','NOT_ATTEMPTED','SKIPPED_DATABASE_GUARD','SKIPPED_DISCORD_GUARD','SKIPPED_READ_FAILURE','CONFIRMED','ALREADY_ABSENT','REJECTED')),
	CONSTRAINT "managed_execution_identity_check" CHECK (("managed_message_execution_failure_audits"."guild_id" <> '' and "managed_message_execution_failure_audits"."channel_id" <> ''
    and "managed_message_execution_failure_audits"."actor_user_id" <> '' and "managed_message_execution_failure_audits"."success_audit_id" <> ''
    and ("managed_message_execution_failure_audits"."message_id" is null or "managed_message_execution_failure_audits"."message_id" <> '')
    and ("managed_message_execution_failure_audits"."operation_code" <> 'MANAGED_MESSAGE_EDIT' or "managed_message_execution_failure_audits"."message_id" is not null)) is true),
	CONSTRAINT "managed_execution_database_check" CHECK ((
    ("managed_message_execution_failure_audits"."database_effect" = 'NOT_ATTEMPTED' and "managed_message_execution_failure_audits"."transaction_evidence" = 'NOT_ATTEMPTED')
    or ("managed_message_execution_failure_audits"."database_effect" = 'NOT_APPLIED' and "managed_message_execution_failure_audits"."transaction_evidence" in ('START_FAILED','ROLLED_BACK','COMMIT_REJECTED'))
    or ("managed_message_execution_failure_audits"."database_effect" = 'NOT_TRANSITIONED' and "managed_message_execution_failure_audits"."operation_code" = 'MANAGED_MESSAGE_EDIT'
      and "managed_message_execution_failure_audits"."transaction_evidence" in ('COMMITTED','COMMIT_REJECTED','UNCONFIRMED'))
  ) is true),
	CONSTRAINT "managed_execution_effect_check" CHECK ((
    ("managed_message_execution_failure_audits"."discord_evidence" in ('NOT_ATTEMPTED','REJECTED','NOT_APPLIED_BY_READBACK','DELETION_OBSERVED')
      and "managed_message_execution_failure_audits"."compensation_type" = 'NONE' and "managed_message_execution_failure_audits"."compensation_evidence" = 'NOT_REQUIRED'
      and "managed_message_execution_failure_audits"."discord_effect_at" is null and "managed_message_execution_failure_audits"."outcome" = 'FAILURE'
      and ("managed_message_execution_failure_audits"."discord_evidence" = 'DELETION_OBSERVED' or "managed_message_execution_failure_audits"."database_effect" = 'NOT_ATTEMPTED'))
    or ("managed_message_execution_failure_audits"."discord_evidence" in ('SEND_CONFIRMED','EDIT_CONFIRMED')
      and "managed_message_execution_failure_audits"."message_id" is not null and "managed_message_execution_failure_audits"."discord_effect_at" is not null
      and (("managed_message_execution_failure_audits"."discord_evidence" = 'SEND_CONFIRMED' and "managed_message_execution_failure_audits"."operation_code" = 'MANAGED_MESSAGE_SEND'
        and "managed_message_execution_failure_audits"."compensation_type" = 'DELETE')
        or ("managed_message_execution_failure_audits"."discord_evidence" = 'EDIT_CONFIRMED' and "managed_message_execution_failure_audits"."operation_code" = 'MANAGED_MESSAGE_EDIT'
          and "managed_message_execution_failure_audits"."compensation_type" = 'RESTORE' and "managed_message_execution_failure_audits"."payload_evidence" = 'MATCH'))
      and (("managed_message_execution_failure_audits"."outcome" = 'FAILURE' and ("managed_message_execution_failure_audits"."compensation_evidence" = 'CONFIRMED'
          or ("managed_message_execution_failure_audits"."compensation_type" = 'DELETE' and "managed_message_execution_failure_audits"."compensation_evidence" = 'ALREADY_ABSENT')))
        or ("managed_message_execution_failure_audits"."outcome" = 'PARTIAL' and ("managed_message_execution_failure_audits"."compensation_evidence" in ('NOT_ATTEMPTED','REJECTED')
          or ("managed_message_execution_failure_audits"."compensation_type" = 'RESTORE' and "managed_message_execution_failure_audits"."compensation_evidence" in
            ('SKIPPED_DATABASE_GUARD','SKIPPED_DISCORD_GUARD','SKIPPED_READ_FAILURE'))))))
  ) is true),
	CONSTRAINT "managed_execution_stage_check" CHECK ((
    ("managed_message_execution_failure_audits"."stage" in ('DISCORD_PREFLIGHT','DISCORD_READ') and "managed_message_execution_failure_audits"."discord_evidence" = 'NOT_ATTEMPTED'
      and "managed_message_execution_failure_audits"."reason_code" in ('BOT_PERMISSION_MISSING','REQUIRED_RESOURCE_READ_FAILED'))
    or ("managed_message_execution_failure_audits"."stage" = 'DISCORD_MUTATION' and "managed_message_execution_failure_audits"."database_effect" = 'NOT_ATTEMPTED' and (
      ("managed_message_execution_failure_audits"."reason_code" = 'MUTATION_REJECTED' and "managed_message_execution_failure_audits"."discord_evidence" = 'REJECTED')
      or ("managed_message_execution_failure_audits"."reason_code" = 'EDIT_NOT_APPLIED' and "managed_message_execution_failure_audits"."discord_evidence" = 'NOT_APPLIED_BY_READBACK'
        and "managed_message_execution_failure_audits"."operation_code" = 'MANAGED_MESSAGE_EDIT')))
    or ("managed_message_execution_failure_audits"."stage" = 'DISCORD_RESPONSE' and "managed_message_execution_failure_audits"."discord_evidence" = 'SEND_CONFIRMED'
      and "managed_message_execution_failure_audits"."database_effect" = 'NOT_ATTEMPTED' and (
        ("managed_message_execution_failure_audits"."reason_code" in ('RETURNED_PAYLOAD_PROJECTION_FAILED','RETURNED_RESPONSE_READ_FAILED')
          and "managed_message_execution_failure_audits"."payload_evidence" = 'PROJECTION_UNAVAILABLE')
        or ("managed_message_execution_failure_audits"."reason_code" = 'RETURNED_PAYLOAD_MISMATCH' and "managed_message_execution_failure_audits"."payload_evidence" = 'MISMATCH')))
    or ("managed_message_execution_failure_audits"."stage" in ('DATABASE_START','DATABASE_TRANSACTION','DATABASE_COMMIT')
      and "managed_message_execution_failure_audits"."discord_evidence" in ('SEND_CONFIRMED','EDIT_CONFIRMED') and "managed_message_execution_failure_audits"."payload_evidence" = 'MATCH'
      and "managed_message_execution_failure_audits"."database_effect" = 'NOT_APPLIED' and (
        ("managed_message_execution_failure_audits"."stage" = 'DATABASE_START' and "managed_message_execution_failure_audits"."reason_code" = 'TRANSACTION_START_FAILED' and "managed_message_execution_failure_audits"."transaction_evidence" = 'START_FAILED')
        or ("managed_message_execution_failure_audits"."stage" = 'DATABASE_TRANSACTION' and "managed_message_execution_failure_audits"."reason_code" = 'TRANSACTION_ROLLED_BACK' and "managed_message_execution_failure_audits"."transaction_evidence" = 'ROLLED_BACK')
        or ("managed_message_execution_failure_audits"."stage" = 'DATABASE_COMMIT' and "managed_message_execution_failure_audits"."reason_code" = 'COMMIT_REJECTED' and "managed_message_execution_failure_audits"."transaction_evidence" = 'COMMIT_REJECTED')))
    or ("managed_message_execution_failure_audits"."stage" = 'DATABASE_GUARD' and "managed_message_execution_failure_audits"."reason_code" = 'FINALIZATION_NOT_TRANSITIONED'
      and "managed_message_execution_failure_audits"."discord_evidence" = 'EDIT_CONFIRMED' and "managed_message_execution_failure_audits"."database_effect" = 'NOT_TRANSITIONED')
    or ("managed_message_execution_failure_audits"."stage" = 'DELETION_FINALIZATION' and "managed_message_execution_failure_audits"."operation_code" = 'MANAGED_MESSAGE_EDIT'
      and "managed_message_execution_failure_audits"."discord_evidence" = 'DELETION_OBSERVED' and "managed_message_execution_failure_audits"."database_effect" = 'NOT_APPLIED' and (
        ("managed_message_execution_failure_audits"."reason_code" = 'TRANSACTION_START_FAILED' and "managed_message_execution_failure_audits"."transaction_evidence" = 'START_FAILED')
        or ("managed_message_execution_failure_audits"."reason_code" = 'TRANSACTION_ROLLED_BACK' and "managed_message_execution_failure_audits"."transaction_evidence" = 'ROLLED_BACK')
        or ("managed_message_execution_failure_audits"."reason_code" = 'COMMIT_REJECTED' and "managed_message_execution_failure_audits"."transaction_evidence" = 'COMMIT_REJECTED')))
  ) is true)
);
--> statement-breakpoint
CREATE INDEX "managed_execution_failure_retention_idx" ON "managed_message_execution_failure_audits" USING btree ("occurred_at","id");