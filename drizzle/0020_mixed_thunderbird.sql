CREATE TABLE "guild_configuration_audits" (
	"id" text PRIMARY KEY NOT NULL,
	"guild_id" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"action" text NOT NULL,
	"setting_type" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"previous_text" text,
	"new_text" text,
	"previous_integer" integer,
	"new_integer" integer,
	"previous_boolean" boolean,
	"new_boolean" boolean,
	"occurred_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	CONSTRAINT "guild_configuration_audits_identity_check" CHECK ("guild_configuration_audits"."id" <> '' and "guild_configuration_audits"."guild_id" <> '' and "guild_configuration_audits"."actor_user_id" <> '' and "guild_configuration_audits"."target_id" <> ''),
	CONSTRAINT "guild_configuration_audits_outcome_check" CHECK ("guild_configuration_audits"."outcome" = 'SUCCESS'),
	CONSTRAINT "guild_configuration_audits_transition_check" CHECK ((
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
                and char_length("guild_configuration_audits"."previous_text") between 1 and 20
                and char_length("guild_configuration_audits"."new_text") between 1 and 20
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
    ) is true)
);
--> statement-breakpoint
CREATE INDEX "guild_configuration_audits_retention_idx" ON "guild_configuration_audits" USING btree ("occurred_at","id");