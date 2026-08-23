CREATE TABLE "scheduled_thread_close_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_action_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"previous_scheduled_action_id" text,
	"previous_execute_at" timestamp with time zone,
	"execute_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_thread_close_audits_event_check" CHECK ("scheduled_thread_close_audits"."event" in ('CREATED', 'REPLACED', 'CANCELLED', 'EXECUTION_COMPLETED', 'EXECUTION_RETRY', 'EXECUTION_FAILED')),
	CONSTRAINT "scheduled_thread_close_audits_actor_type_check" CHECK ("scheduled_thread_close_audits"."actor_type" in ('USER', 'SYSTEM')),
	CONSTRAINT "scheduled_thread_close_audits_outcome_check" CHECK ("scheduled_thread_close_audits"."outcome" in ('SUCCESS', 'FAILURE')),
	CONSTRAINT "scheduled_thread_close_audits_actor_check" CHECK (("scheduled_thread_close_audits"."actor_type" = 'USER' and "scheduled_thread_close_audits"."actor_id" is not null) or ("scheduled_thread_close_audits"."actor_type" = 'SYSTEM' and "scheduled_thread_close_audits"."actor_id" is null)),
	CONSTRAINT "scheduled_thread_close_audits_failure_check" CHECK (("scheduled_thread_close_audits"."outcome" = 'SUCCESS' and "scheduled_thread_close_audits"."failure_code" is null) or ("scheduled_thread_close_audits"."outcome" = 'FAILURE' and "scheduled_thread_close_audits"."failure_code" is not null)),
	CONSTRAINT "scheduled_thread_close_audits_replacement_check" CHECK (("scheduled_thread_close_audits"."event" = 'REPLACED' and "scheduled_thread_close_audits"."previous_scheduled_action_id" is not null and "scheduled_thread_close_audits"."previous_execute_at" is not null) or ("scheduled_thread_close_audits"."event" <> 'REPLACED' and "scheduled_thread_close_audits"."previous_scheduled_action_id" is null and "scheduled_thread_close_audits"."previous_execute_at" is null))
);
--> statement-breakpoint
CREATE INDEX "scheduled_thread_close_audits_action_id_idx" ON "scheduled_thread_close_audits" USING btree ("scheduled_action_id");--> statement-breakpoint
CREATE INDEX "scheduled_thread_close_audits_guild_thread_created_at_idx" ON "scheduled_thread_close_audits" USING btree ("guild_id","thread_id","created_at");