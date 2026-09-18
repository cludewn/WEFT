ALTER TABLE "scheduled_message_audits" DROP CONSTRAINT "scheduled_message_audits_event_check";--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" DROP CONSTRAINT "scheduled_message_audits_shape_check";--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_event_check" CHECK ("scheduled_message_audits"."event" in ('CREATED', 'CANCELLED', 'EXECUTION_COMPLETED', 'EXECUTION_RETRY', 'EXECUTION_FAILED'));--> statement-breakpoint
ALTER TABLE "scheduled_message_audits" ADD CONSTRAINT "scheduled_message_audits_shape_check" CHECK ((
        "scheduled_message_audits"."event" = 'CREATED'
        and "scheduled_message_audits"."actor_type" = 'USER' and "scheduled_message_audits"."actor_id" is not null
        and "scheduled_message_audits"."outcome" = 'SUCCESS' and "scheduled_message_audits"."failure_code" is null
        and "scheduled_message_audits"."result_message_id" is null
      ) or (
        "scheduled_message_audits"."event" = 'CANCELLED'
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
      ));