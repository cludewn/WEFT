CREATE TABLE "link_preview_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"previous_mode" text NOT NULL,
	"new_mode" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "link_preview_audits_outcome_check" CHECK ("link_preview_audits"."outcome" = 'SUCCESS'),
	CONSTRAINT "link_preview_audits_transition_check" CHECK ("link_preview_audits"."previous_mode" is distinct from "link_preview_audits"."new_mode"),
	CONSTRAINT "link_preview_audits_previous_nonempty" CHECK ("link_preview_audits"."previous_mode" in ('hybrid', 'public-only', 'button-only', 'off')),
	CONSTRAINT "link_preview_audits_new_nonempty" CHECK ("link_preview_audits"."new_mode" in ('hybrid', 'public-only', 'button-only', 'off'))
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "link_preview_mode" text DEFAULT 'hybrid' NOT NULL;--> statement-breakpoint
CREATE INDEX "link_preview_audits_retention_idx" ON "link_preview_audits" USING btree ("occurred_at","id");--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_link_preview_mode_check" CHECK ("guild_settings"."link_preview_mode" in ('hybrid', 'public-only', 'button-only', 'off'));