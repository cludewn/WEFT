import type { GuildSettingsStore } from "./guild-settings.js";
import { validateClosedPrefix, validateTimezone } from "./guild-settings.js";
import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
} from "./administrative-operation-failure-audit.js";
import type { AdministrativeAttempt } from "./administrative-transaction.js";

/** The config handler has established ManageGuild; this owner awaits independent failure history. */
export function createGuildConfigurationService(
  store: GuildSettingsStore,
  failures: AdministrativeFailureRecorder,
): GuildSettingsStore {
  const change = async (
    key: "setTimezone" | "setClosedPrefix",
    guildId: string,
    value: string,
    context: Parameters<GuildSettingsStore["setTimezone"]>[2],
  ) => {
    const normalized =
      key === "setTimezone" ? validateTimezone(value) : validateClosedPrefix(value);
    const attempt: AdministrativeAttempt = { operationId: context.auditId };
    const result = await store[key](guildId, normalized, {
      ...context,
      administrativeAttempt: attempt,
    });
    const failure = confirmedAdministrativeDatabaseFailure(attempt);
    if (result.outcome === "UNCONFIRMED" && failure !== undefined)
      await failures
        .record(attempt, guildId, context.actorUserId, {
          operationCode: key === "setTimezone" ? "GUILD_TIMEZONE_SET" : "GUILD_CLOSED_PREFIX_SET",
          targetType: "GUILD",
          targetId: guildId,
          ...failure,
        })
        .catch(() => undefined);
    return result;
  };
  return {
    ...store,
    setTimezone: (guildId, value, context) => change("setTimezone", guildId, value, context),
    setClosedPrefix: (guildId, value, context) =>
      change("setClosedPrefix", guildId, value, context),
  };
}
