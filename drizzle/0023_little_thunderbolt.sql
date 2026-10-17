ALTER TABLE "guild_configuration_audits" DROP CONSTRAINT "guild_configuration_audits_transition_check";--> statement-breakpoint
ALTER TABLE "managed_threads" DROP CONSTRAINT "managed_threads_applied_prefix_check";--> statement-breakpoint
ALTER TABLE "guild_configuration_audits" ADD CONSTRAINT "guild_configuration_audits_transition_check" CHECK ((
      (
        "guild_configuration_audits"."action" = 'SET' and "guild_configuration_audits"."target_type" = 'GUILD' and "guild_configuration_audits"."target_id" = "guild_configuration_audits"."guild_id"
        and (
          (
            "guild_configuration_audits"."setting_type" in ('TIMEZONE', 'CLOSED_PREFIX')
            and "guild_configuration_audits"."previous_text" is not null and "guild_configuration_audits"."new_text" is not null
            and "guild_configuration_audits"."previous_text" <> "guild_configuration_audits"."new_text"
            and "guild_configuration_audits"."previous_integer" is null and "guild_configuration_audits"."new_integer" is null
            and "guild_configuration_audits"."previous_boolean" is null and "guild_configuration_audits"."new_boolean" is null
            and (
              ("guild_configuration_audits"."setting_type" = 'TIMEZONE' and "guild_configuration_audits"."previous_text" <> '' and "guild_configuration_audits"."new_text" <> '')
              or ("guild_configuration_audits"."setting_type" = 'CLOSED_PREFIX'
                and char_length("guild_configuration_audits"."previous_text") between 0 and 20
                and char_length("guild_configuration_audits"."new_text") between 0 and 20
                and "guild_configuration_audits"."previous_text" !~ U&'[\0001-\001F\007F-\009F]'
                and "guild_configuration_audits"."new_text" !~ U&'[\0001-\001F\007F-\009F]')
            )
          )
          or (
            "guild_configuration_audits"."setting_type" = 'AUTO_CLOSE_INACTIVITY'
            and "guild_configuration_audits"."previous_integer" between 300 and 31536000
            and "guild_configuration_audits"."new_integer" between 300 and 31536000
            and "guild_configuration_audits"."previous_integer" <> "guild_configuration_audits"."new_integer"
            and "guild_configuration_audits"."previous_text" is null and "guild_configuration_audits"."new_text" is null
            and "guild_configuration_audits"."previous_boolean" is null and "guild_configuration_audits"."new_boolean" is null
          )
          or (
            "guild_configuration_audits"."setting_type" = 'AUTO_CLOSE_BOT_MESSAGES'
            and "guild_configuration_audits"."previous_boolean" is not null and "guild_configuration_audits"."new_boolean" is not null
            and "guild_configuration_audits"."previous_boolean" <> "guild_configuration_audits"."new_boolean"
            and "guild_configuration_audits"."previous_text" is null and "guild_configuration_audits"."new_text" is null
            and "guild_configuration_audits"."previous_integer" is null and "guild_configuration_audits"."new_integer" is null
          )
        )
      )
      or (
        "guild_configuration_audits"."previous_text" is null and "guild_configuration_audits"."new_text" is null
        and "guild_configuration_audits"."previous_integer" is null and "guild_configuration_audits"."new_integer" is null
        and (
          ("guild_configuration_audits"."setting_type" = 'AUTO_CLOSE_PARENT' and "guild_configuration_audits"."target_type" = 'PARENT_CHANNEL'
            and (("guild_configuration_audits"."action" = 'ADD' and "guild_configuration_audits"."previous_boolean" = false and "guild_configuration_audits"."new_boolean" = true)
              or ("guild_configuration_audits"."action" = 'REMOVE' and "guild_configuration_audits"."previous_boolean" = true and "guild_configuration_audits"."new_boolean" = false)))
          or ("guild_configuration_audits"."setting_type" = 'THREAD_EXCLUSION' and "guild_configuration_audits"."target_type" = 'THREAD'
            and (("guild_configuration_audits"."action" = 'TRACK' and "guild_configuration_audits"."previous_boolean" = true and "guild_configuration_audits"."new_boolean" = false)
              or ("guild_configuration_audits"."action" = 'UNTRACK' and "guild_configuration_audits"."previous_boolean" = false and "guild_configuration_audits"."new_boolean" = true)))
        )
      )
    ) is true);