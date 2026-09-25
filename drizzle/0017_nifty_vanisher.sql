CREATE TABLE "audit_log_destination_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"previous_channel_id" text,
	"new_channel_id" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "audit_log_destination_audits_outcome_check" CHECK ("audit_log_destination_audits"."outcome" = 'SUCCESS'),
	CONSTRAINT "audit_log_destination_audits_transition_check" CHECK ("audit_log_destination_audits"."previous_channel_id" is distinct from "audit_log_destination_audits"."new_channel_id"),
	CONSTRAINT "audit_log_destination_audits_previous_nonempty" CHECK ("audit_log_destination_audits"."previous_channel_id" <> ''),
	CONSTRAINT "audit_log_destination_audits_new_nonempty" CHECK ("audit_log_destination_audits"."new_channel_id" <> '')
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "audit_log_channel_id" text;--> statement-breakpoint
CREATE INDEX "audit_log_destination_audits_retention_idx" ON "audit_log_destination_audits" USING btree ("occurred_at","id");--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_audit_log_channel_id_nonempty" CHECK ("guild_settings"."audit_log_channel_id" <> '');