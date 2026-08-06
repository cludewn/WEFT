CREATE TABLE "managed_threads" (
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"applied_prefix" text NOT NULL,
	"lifecycle_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_threads_guild_id_thread_id_pk" PRIMARY KEY("guild_id","thread_id"),
	CONSTRAINT "managed_threads_lifecycle_state_check" CHECK ("managed_threads"."lifecycle_state" in ('OPEN', 'CLOSED')),
	CONSTRAINT "managed_threads_applied_prefix_check" CHECK (length("managed_threads"."applied_prefix") > 0)
);
--> statement-breakpoint
CREATE TABLE "thread_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"outcome" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "thread_audits_action_check" CHECK ("thread_audits"."action" in ('CLOSE', 'OPEN', 'AUTO_OPEN')),
	CONSTRAINT "thread_audits_actor_type_check" CHECK ("thread_audits"."actor_type" in ('USER', 'SYSTEM')),
	CONSTRAINT "thread_audits_outcome_check" CHECK ("thread_audits"."outcome" in ('SUCCESS', 'FAILURE')),
	CONSTRAINT "thread_audits_actor_check" CHECK (("thread_audits"."actor_type" = 'USER' and "thread_audits"."actor_id" is not null) or ("thread_audits"."actor_type" = 'SYSTEM' and "thread_audits"."actor_id" is null)),
	CONSTRAINT "thread_audits_failure_check" CHECK (("thread_audits"."outcome" = 'SUCCESS' and "thread_audits"."failure_code" is null) or ("thread_audits"."outcome" = 'FAILURE' and "thread_audits"."failure_code" is not null))
);
