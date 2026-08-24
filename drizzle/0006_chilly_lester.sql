CREATE TABLE "auto_close_parent_channels" (
	"guild_id" text NOT NULL,
	"parent_channel_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_close_parent_channels_guild_id_parent_channel_id_pk" PRIMARY KEY("guild_id","parent_channel_id")
);
--> statement-breakpoint
CREATE TABLE "auto_close_thread_activity" (
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"parent_channel_id" text NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_close_thread_activity_guild_id_thread_id_pk" PRIMARY KEY("guild_id","thread_id")
);
--> statement-breakpoint
CREATE TABLE "auto_close_thread_exclusions" (
	"guild_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_close_thread_exclusions_guild_id_thread_id_pk" PRIMARY KEY("guild_id","thread_id")
);
--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "auto_close_inactivity_seconds" integer DEFAULT 604800 NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD COLUMN "auto_close_bot_messages_count_as_activity" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "guild_settings" ADD CONSTRAINT "guild_settings_auto_close_inactivity_seconds_check" CHECK ("guild_settings"."auto_close_inactivity_seconds" between 300 and 31536000);