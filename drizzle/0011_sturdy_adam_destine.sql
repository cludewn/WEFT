ALTER TABLE "managed_message_audits" DROP CONSTRAINT "managed_message_audits_content_length_check";--> statement-breakpoint
ALTER TABLE "managed_message_audits" DROP CONSTRAINT "managed_message_audits_event_shape_check";--> statement-breakpoint
ALTER TABLE "managed_messages" DROP CONSTRAINT "managed_messages_content_length_check";--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "before_embed_title" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "after_embed_title" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "before_embed_description" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "after_embed_description" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "before_embed_color" integer;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "after_embed_color" integer;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "before_embed_image_url" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD COLUMN "after_embed_image_url" text;--> statement-breakpoint
ALTER TABLE "managed_messages" ADD COLUMN "embed_title" text;--> statement-breakpoint
ALTER TABLE "managed_messages" ADD COLUMN "embed_description" text;--> statement-breakpoint
ALTER TABLE "managed_messages" ADD COLUMN "embed_color" integer;--> statement-breakpoint
ALTER TABLE "managed_messages" ADD COLUMN "embed_image_url" text;--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD CONSTRAINT "managed_message_audits_payload_check" CHECK (char_length("managed_message_audits"."after_content") between 0 and 2000
        and ("managed_message_audits"."before_content" is null or char_length("managed_message_audits"."before_content") between 0 and 2000)
        and ("managed_message_audits"."after_embed_title" is null or char_length("managed_message_audits"."after_embed_title") between 1 and 256)
        and ("managed_message_audits"."before_embed_title" is null or char_length("managed_message_audits"."before_embed_title") between 1 and 256)
        and ("managed_message_audits"."after_embed_description" is null or char_length("managed_message_audits"."after_embed_description") between 1 and 4000)
        and ("managed_message_audits"."before_embed_description" is null or char_length("managed_message_audits"."before_embed_description") between 1 and 4000)
        and ("managed_message_audits"."after_embed_color" is null or "managed_message_audits"."after_embed_color" between 0 and 16777215)
        and ("managed_message_audits"."before_embed_color" is null or "managed_message_audits"."before_embed_color" between 0 and 16777215)
        and ("managed_message_audits"."after_embed_image_url" is null or char_length("managed_message_audits"."after_embed_image_url") between 1 and 2048)
        and ("managed_message_audits"."before_embed_image_url" is null or char_length("managed_message_audits"."before_embed_image_url") between 1 and 2048)
        and ("managed_message_audits"."after_embed_color" is null or "managed_message_audits"."after_embed_title" is not null or "managed_message_audits"."after_embed_description" is not null or "managed_message_audits"."after_embed_image_url" is not null)
        and (char_length("managed_message_audits"."after_content") > 0 or "managed_message_audits"."after_embed_title" is not null or "managed_message_audits"."after_embed_description" is not null or "managed_message_audits"."after_embed_image_url" is not null)
        and ("managed_message_audits"."before_content" is null or (
          ("managed_message_audits"."before_embed_color" is null or "managed_message_audits"."before_embed_title" is not null or "managed_message_audits"."before_embed_description" is not null or "managed_message_audits"."before_embed_image_url" is not null)
          and (char_length("managed_message_audits"."before_content") > 0 or "managed_message_audits"."before_embed_title" is not null or "managed_message_audits"."before_embed_description" is not null or "managed_message_audits"."before_embed_image_url" is not null)
        )));--> statement-breakpoint
ALTER TABLE "managed_message_audits" ADD CONSTRAINT "managed_message_audits_event_shape_check" CHECK ((
        "managed_message_audits"."event" = 'CREATED'
        and "managed_message_audits"."actor_type" = 'USER' and "managed_message_audits"."actor_id" is not null
        and "managed_message_audits"."before_content" is null and "managed_message_audits"."before_embed_title" is null
        and "managed_message_audits"."before_embed_description" is null and "managed_message_audits"."before_embed_color" is null
        and "managed_message_audits"."before_embed_image_url" is null and "managed_message_audits"."before_revision" is null
        and "managed_message_audits"."before_status" is null
        and "managed_message_audits"."after_revision" = 1 and "managed_message_audits"."after_status" = 'ACTIVE'
      ) or (
        "managed_message_audits"."event" = 'EDITED'
        and "managed_message_audits"."actor_type" = 'USER' and "managed_message_audits"."actor_id" is not null
        and "managed_message_audits"."before_content" is not null and "managed_message_audits"."before_revision" is not null
        and "managed_message_audits"."before_status" = 'ACTIVE' and "managed_message_audits"."after_status" = 'ACTIVE'
        and "managed_message_audits"."after_revision" = "managed_message_audits"."before_revision" + 1
        and (
          "managed_message_audits"."after_content" is distinct from "managed_message_audits"."before_content"
          or "managed_message_audits"."after_embed_title" is distinct from "managed_message_audits"."before_embed_title"
          or "managed_message_audits"."after_embed_description" is distinct from "managed_message_audits"."before_embed_description"
          or "managed_message_audits"."after_embed_color" is distinct from "managed_message_audits"."before_embed_color"
          or "managed_message_audits"."after_embed_image_url" is distinct from "managed_message_audits"."before_embed_image_url"
        )
      ) or (
        "managed_message_audits"."event" = 'DELETION_DETECTED'
        and "managed_message_audits"."actor_type" = 'SYSTEM' and "managed_message_audits"."actor_id" is null
        and "managed_message_audits"."before_content" is not null and "managed_message_audits"."before_revision" is not null
        and "managed_message_audits"."before_status" = 'ACTIVE' and "managed_message_audits"."after_status" = 'DELETED'
        and "managed_message_audits"."after_revision" = "managed_message_audits"."before_revision"
        and "managed_message_audits"."after_content" is not distinct from "managed_message_audits"."before_content"
        and "managed_message_audits"."after_embed_title" is not distinct from "managed_message_audits"."before_embed_title"
        and "managed_message_audits"."after_embed_description" is not distinct from "managed_message_audits"."before_embed_description"
        and "managed_message_audits"."after_embed_color" is not distinct from "managed_message_audits"."before_embed_color"
        and "managed_message_audits"."after_embed_image_url" is not distinct from "managed_message_audits"."before_embed_image_url"
      ));--> statement-breakpoint
ALTER TABLE "managed_messages" ADD CONSTRAINT "managed_messages_payload_check" CHECK (char_length("managed_messages"."content") between 0 and 2000
        and ("managed_messages"."embed_title" is null or char_length("managed_messages"."embed_title") between 1 and 256)
        and ("managed_messages"."embed_description" is null or char_length("managed_messages"."embed_description") between 1 and 4000)
        and ("managed_messages"."embed_color" is null or "managed_messages"."embed_color" between 0 and 16777215)
        and ("managed_messages"."embed_image_url" is null or char_length("managed_messages"."embed_image_url") between 1 and 2048)
        and ("managed_messages"."embed_color" is null or "managed_messages"."embed_title" is not null or "managed_messages"."embed_description" is not null or "managed_messages"."embed_image_url" is not null)
        and (char_length("managed_messages"."content") > 0 or "managed_messages"."embed_title" is not null or "managed_messages"."embed_description" is not null or "managed_messages"."embed_image_url" is not null));