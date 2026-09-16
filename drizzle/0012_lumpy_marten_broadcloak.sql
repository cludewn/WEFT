CREATE TABLE "scheduled_message_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"scheduled_action_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"execute_at" timestamp with time zone NOT NULL,
	"content" text NOT NULL,
	"embed_title" text,
	"embed_description" text,
	"embed_color" integer,
	"embed_image_url" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "scheduled_message_audits_event_check" CHECK ("scheduled_message_audits"."event" = 'CREATED'),
	CONSTRAINT "scheduled_message_audits_actor_type_check" CHECK ("scheduled_message_audits"."actor_type" = 'USER'),
	CONSTRAINT "scheduled_message_audits_outcome_check" CHECK ("scheduled_message_audits"."outcome" = 'SUCCESS'),
	CONSTRAINT "scheduled_message_audits_payload_check" CHECK (char_length("scheduled_message_audits"."content") between 0 and 2000
        and ("scheduled_message_audits"."embed_title" is null or char_length("scheduled_message_audits"."embed_title") between 1 and 256)
        and ("scheduled_message_audits"."embed_description" is null or char_length("scheduled_message_audits"."embed_description") between 1 and 4000)
        and ("scheduled_message_audits"."embed_color" is null or "scheduled_message_audits"."embed_color" between 0 and 16777215)
        and ("scheduled_message_audits"."embed_image_url" is null or char_length("scheduled_message_audits"."embed_image_url") between 1 and 2048)
        and ("scheduled_message_audits"."embed_color" is null or "scheduled_message_audits"."embed_title" is not null or "scheduled_message_audits"."embed_description" is not null or "scheduled_message_audits"."embed_image_url" is not null)
        and (char_length("scheduled_message_audits"."content") > 0 or "scheduled_message_audits"."embed_title" is not null or "scheduled_message_audits"."embed_description" is not null or "scheduled_message_audits"."embed_image_url" is not null))
);
--> statement-breakpoint
CREATE TABLE "scheduled_message_states" (
	"scheduled_action_id" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"embed_title" text,
	"embed_description" text,
	"embed_color" integer,
	"embed_image_url" text,
	"result_message_id" text,
	CONSTRAINT "scheduled_message_states_payload_check" CHECK (char_length("scheduled_message_states"."content") between 0 and 2000
        and ("scheduled_message_states"."embed_title" is null or char_length("scheduled_message_states"."embed_title") between 1 and 256)
        and ("scheduled_message_states"."embed_description" is null or char_length("scheduled_message_states"."embed_description") between 1 and 4000)
        and ("scheduled_message_states"."embed_color" is null or "scheduled_message_states"."embed_color" between 0 and 16777215)
        and ("scheduled_message_states"."embed_image_url" is null or char_length("scheduled_message_states"."embed_image_url") between 1 and 2048)
        and ("scheduled_message_states"."embed_color" is null or "scheduled_message_states"."embed_title" is not null or "scheduled_message_states"."embed_description" is not null or "scheduled_message_states"."embed_image_url" is not null)
        and (char_length("scheduled_message_states"."content") > 0 or "scheduled_message_states"."embed_title" is not null or "scheduled_message_states"."embed_description" is not null or "scheduled_message_states"."embed_image_url" is not null))
);
--> statement-breakpoint
ALTER TABLE "scheduled_message_states" ADD CONSTRAINT "scheduled_message_states_scheduled_action_id_scheduled_actions_id_fk" FOREIGN KEY ("scheduled_action_id") REFERENCES "public"."scheduled_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scheduled_message_audits_action_id_idx" ON "scheduled_message_audits" USING btree ("scheduled_action_id");