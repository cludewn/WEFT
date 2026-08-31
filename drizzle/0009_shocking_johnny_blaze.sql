CREATE TABLE "managed_messages" (
	"message_id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"creator_user_id" text NOT NULL,
	"content" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_messages_revision_check" CHECK ("managed_messages"."revision" >= 1),
	CONSTRAINT "managed_messages_status_check" CHECK ("managed_messages"."status" = 'ACTIVE'),
	CONSTRAINT "managed_messages_content_length_check" CHECK (char_length("managed_messages"."content") between 1 and 2000)
);
