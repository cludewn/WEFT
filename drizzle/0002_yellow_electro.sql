CREATE TABLE "scheduled_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"action_type" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduled_actions_action_type_check" CHECK ("scheduled_actions"."action_type" in ('CLOSE_THREAD', 'SEND_MESSAGE')),
	CONSTRAINT "scheduled_actions_status_check" CHECK ("scheduled_actions"."status" in ('ACTIVE', 'CANCELLED', 'COMPLETED', 'FAILED'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_actions_active_close_unique" ON "scheduled_actions" USING btree ("guild_id","target_id") WHERE "scheduled_actions"."action_type" = 'CLOSE_THREAD' and "scheduled_actions"."status" = 'ACTIVE';--> statement-breakpoint
CREATE INDEX "scheduled_actions_active_execute_at_idx" ON "scheduled_actions" USING btree ("execute_at") WHERE "scheduled_actions"."status" = 'ACTIVE';