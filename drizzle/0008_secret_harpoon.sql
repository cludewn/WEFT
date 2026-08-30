CREATE TABLE "auto_close_thread_retirements" (
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_close_thread_retirements_guild_id_thread_id_pk" PRIMARY KEY("guild_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "thread_audits" DROP CONSTRAINT "thread_audits_action_check";--> statement-breakpoint
ALTER TABLE "thread_audits" ADD CONSTRAINT "thread_audits_action_check" CHECK ("thread_audits"."action" in ('CLOSE', 'OPEN', 'AUTO_OPEN', 'AUTO_CLOSE'));