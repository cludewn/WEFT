import type { GuildSettingsStore } from "./guild-settings.js";
import { validateClosedPrefix, validateTimezone } from "./guild-settings.js";
import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
} from "../audit/administrative-operation-failure-audit.js";
import type { AdministrativeAttempt } from "../administrative-transaction.js";

/** The config handler has established ManageGuild; this owner awaits independent failure history. */
export function createGuildConfigurationService(
  store: GuildSettingsStore,
  failures: AdministrativeFailureRecorder,
): GuildSettingsStore {
  const change = async (
    key: "setTimezone" | "setClosedPrefix" | "disableClosedPrefix",
    guildId: string,
    value: string,
    context: Parameters<GuildSettingsStore["setTimezone"]>[2],
  ) => {
    const normalized =
      key === "setTimezone"
        ? validateTimezone(value)
        : key === "setClosedPrefix"
          ? validateClosedPrefix(value)
          : "";
    const attempt: AdministrativeAttempt = { operationId: context.auditId };
    const audit = { ...context, administrativeAttempt: attempt };
    const result =
      key === "disableClosedPrefix"
        ? await store.disableClosedPrefix(guildId, audit)
        : await store[key](guildId, normalized, audit);
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
    disableClosedPrefix: (guildId, context) => change("disableClosedPrefix", guildId, "", context),
    setTimezone: (guildId, value, context) => change("setTimezone", guildId, value, context),
    setClosedPrefix: (guildId, value, context) =>
      change("setClosedPrefix", guildId, value, context),
  };
}
