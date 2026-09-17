ALTER TABLE "scheduled_message_audits" DROP CONSTRAINT "scheduled_message_audits_event_check";--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" DROP CONSTRAINT "scheduled_message_audits_actor_type_check";--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" DROP CONSTRAINT "scheduled_message_audits_outcome_check";--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD COLUMN "failure_code" text;--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD COLUMN "result_message_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_message_states" ADD COLUMN "creator_user_id" text;--> statement-breakpoint
ALTER TABLE "scheduled_message_states" ADD COLUMN "retry_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "scheduled_message_states" state
    JOIN "scheduled_actions" action ON action."id" = state."scheduled_action_id"
    LEFT JOIN LATERAL (
      SELECT
        count(*) AS candidate_count,
        count(*) FILTER (
          WHERE audit."guild_id" = action."guild_id"
            AND audit."channel_id" = action."target_id"
            AND audit."execute_at" = action."execute_at"
            AND audit."content" = state."content"
            AND audit."embed_title" IS NOT DISTINCT FROM state."embed_title"
            AND audit."embed_description" IS NOT DISTINCT FROM state."embed_description"
            AND audit."embed_color" IS NOT DISTINCT FROM state."embed_color"
            AND audit."embed_image_url" IS NOT DISTINCT FROM state."embed_image_url"
            AND audit."event" = 'CREATED'
            AND audit."actor_type" = 'USER'
            AND audit."actor_id" IS NOT NULL
            AND audit."outcome" = 'SUCCESS'
        ) AS matching_count
      FROM "scheduled_message_audits" audit
      WHERE audit."scheduled_action_id" = state."scheduled_action_id"
    ) source ON true
    WHERE action."action_type" <> 'SEND_MESSAGE'
       OR source.candidate_count <> 1
       OR source.matching_count <> 1
  ) THEN
    RAISE EXCEPTION 'scheduled message creator backfill requires exactly one matching CREATED audit per state';
  END IF;
END $$;--> statement-breakpoint
UPDATE "scheduled_message_states" state
SET "creator_user_id" = audit."actor_id"
FROM "scheduled_message_audits" audit
WHERE audit."scheduled_action_id" = state."scheduled_action_id"
  AND audit."event" = 'CREATED'
  AND audit."actor_type" = 'USER'
  AND audit."actor_id" IS NOT NULL
  AND audit."outcome" = 'SUCCESS';--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "scheduled_message_states" WHERE "creator_user_id" IS NULL) THEN
    RAISE EXCEPTION 'scheduled message creator backfill left a null creator';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "scheduled_message_states" ALTER COLUMN "creator_user_id" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "scheduled_actions_active_send_execute_at_id_idx" ON "scheduled_actions" USING btree ("execute_at","id") WHERE "scheduled_actions"."action_type" = 'SEND_MESSAGE' and "scheduled_actions"."status" = 'ACTIVE';--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_shape_check" CHECK ((
        "scheduled_message_audits"."event" = 'CREATED'
        and "scheduled_message_audits"."actor_type" = 'USER' and "scheduled_message_audits"."actor_id" is not null
        and "scheduled_message_audits"."outcome" = 'SUCCESS' and "scheduled_message_audits"."failure_code" is null
        and "scheduled_message_audits"."result_message_id" is null
      ) or (
        "scheduled_message_audits"."event" = 'EXECUTION_COMPLETED'
        and "scheduled_message_audits"."actor_type" = 'SYSTEM' and "scheduled_message_audits"."actor_id" is null
        and "scheduled_message_audits"."outcome" = 'SUCCESS' and "scheduled_message_audits"."failure_code" is null
        and "scheduled_message_audits"."result_message_id" is not null
      ) or (
        "scheduled_message_audits"."event" = 'EXECUTION_RETRY'
        and "scheduled_message_audits"."actor_type" = 'SYSTEM' and "scheduled_message_audits"."actor_id" is null
        and "scheduled_message_audits"."outcome" = 'FAILURE' and "scheduled_message_audits"."failure_code" is not null
        and "scheduled_message_audits"."result_message_id" is null
      ) or (
        "scheduled_message_audits"."event" = 'EXECUTION_FAILED'
        and "scheduled_message_audits"."actor_type" = 'SYSTEM' and "scheduled_message_audits"."actor_id" is null
        and "scheduled_message_audits"."outcome" = 'FAILURE' and "scheduled_message_audits"."failure_code" is not null
        and (
          "scheduled_message_audits"."result_message_id" is null
          or "scheduled_message_audits"."failure_code" in ('RETURNED_MESSAGE_MISMATCH', 'FINALIZATION_FAILED_UNCOMPENSATED')
        )
      ));--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_event_check" CHECK ("scheduled_message_audits"."event" in ('CREATED', 'EXECUTION_COMPLETED', 'EXECUTION_RETRY', 'EXECUTION_FAILED'));--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_actor_type_check" CHECK ("scheduled_message_audits"."actor_type" in ('USER', 'SYSTEM'));--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_outcome_check" CHECK ("scheduled_message_audits"."outcome" in ('SUCCESS', 'FAILURE'));--> statement-breakpoint
ALTER TABLE "scheduled_message_states" ADD CONSTRAINT "scheduled_message_states_retry_count_check" CHECK ("scheduled_message_states"."retry_count" between 0 and 3);
