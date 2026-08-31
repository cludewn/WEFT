CREATE TABLE "managed_message_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"guild_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"before_content" text,
	"after_content" text NOT NULL,
	"before_revision" integer,
	"after_revision" integer NOT NULL,
	"before_status" text,
	"after_status" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "managed_message_audits_event_check" CHECK ("managed_message_audits"."event" in ('CREATED', 'EDITED', 'DELETION_DETECTED')),
	CONSTRAINT "managed_message_audits_actor_type_check" CHECK ("managed_message_audits"."actor_type" in ('USER', 'SYSTEM')),
	CONSTRAINT "managed_message_audits_outcome_check" CHECK ("managed_message_audits"."outcome" = 'SUCCESS'),
	CONSTRAINT "managed_message_audits_revision_check" CHECK ("managed_message_audits"."after_revision" >= 1 and ("managed_message_audits"."before_revision" is null or "managed_message_audits"."before_revision" >= 1)),
	CONSTRAINT "managed_message_audits_status_check" CHECK ("managed_message_audits"."after_status" in ('ACTIVE', 'DELETED') and ("managed_message_audits"."before_status" is null or "managed_message_audits"."before_status" in ('ACTIVE', 'DELETED'))),
	CONSTRAINT "managed_message_audits_content_length_check" CHECK (char_length("managed_message_audits"."after_content") between 1 and 2000 and ("managed_message_audits"."before_content" is null or char_length("managed_message_audits"."before_content") between 1 and 2000)),
	CONSTRAINT "managed_message_audits_event_shape_check" CHECK ((
        "managed_message_audits"."event" = 'CREATED'
        and "managed_message_audits"."actor_type" = 'USER' and "managed_message_audits"."actor_id" is not null
        and "managed_message_audits"."before_content" is null and "managed_message_audits"."before_revision" is null and "managed_message_audits"."before_status" is null
        and "managed_message_audits"."after_revision" = 1 and "managed_message_audits"."after_status" = 'ACTIVE'
      ) or (
        "managed_message_audits"."event" = 'EDITED'
        and "managed_message_audits"."actor_type" = 'USER' and "managed_message_audits"."actor_id" is not null
        and "managed_message_audits"."before_content" is not null and "managed_message_audits"."before_revision" is not null
        and "managed_message_audits"."before_status" = 'ACTIVE' and "managed_message_audits"."after_status" = 'ACTIVE'
        and "managed_message_audits"."after_revision" = "managed_message_audits"."before_revision" + 1
        and "managed_message_audits"."after_content" <> "managed_message_audits"."before_content"
      ) or (
        "managed_message_audits"."event" = 'DELETION_DETECTED'
        and "managed_message_audits"."actor_type" = 'SYSTEM' and "managed_message_audits"."actor_id" is null
        and "managed_message_audits"."before_content" is not null and "managed_message_audits"."before_revision" is not null
        and "managed_message_audits"."before_status" = 'ACTIVE' and "managed_message_audits"."after_status" = 'DELETED'
        and "managed_message_audits"."after_revision" = "managed_message_audits"."before_revision"
        and "managed_message_audits"."after_content" = "managed_message_audits"."before_content"
      ))
);
--> statement-breakpoint
ALTER TABLE "managed_messages" DROP CONSTRAINT "managed_messages_status_check";--> statement-breakpoint
ALTER TABLE "managed_messages" ADD CONSTRAINT "managed_messages_status_check" CHECK ("managed_messages"."status" in ('ACTIVE', 'DELETED'));