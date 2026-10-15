import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
} from "./administrative-operation-failure-audit.js";
import type { AdministrativeAttempt } from "../administrative-transaction.js";
import { randomUUID } from "node:crypto";

import type { AuditLogDestinationDiscord } from "./audit-log-destination-discord.js";
import type {
  AuditLogDestinationStore,
  DestinationChangeResult,
} from "./audit-log-destination-persistence.js";

export type AuditLogDestinationService = {
  show: (guildId: string) => Promise<string | null>;
  set: (
    guildId: string,
    actorUserId: string,
    channelId: string,
  ) => Promise<DestinationChangeResult | { outcome: "VALIDATION_FAILED" }>;
  disable: (guildId: string, actorUserId: string) => Promise<DestinationChangeResult>;
};

export function createAuditLogDestinationService(
  store: AuditLogDestinationStore,
  discord: AuditLogDestinationDiscord,
  failures?: AdministrativeFailureRecorder,
): AuditLogDestinationService {
  const change = async (
    guildId: string,
    actorUserId: string,
    newChannelId: string | null,
    attempt: AdministrativeAttempt,
  ) => {
    const result = await store.change({
      guildId,
      actorUserId,
      newChannelId,
      auditId: attempt.operationId,
      occurredAt: new Date(),
      ...(failures ? { administrativeAttempt: attempt } : {}),
    });
    const failure = confirmedAdministrativeDatabaseFailure(attempt);
    if (result.outcome === "UNCONFIRMED" && failure) {
      if (newChannelId === null)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUDIT_DESTINATION_DISABLE",
            targetType: "GUILD",
            targetId: guildId,
            ...failure,
          })
          .catch(() => undefined);
      else
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "AUDIT_DESTINATION_SET",
            targetType: "CHANNEL",
            targetId: newChannelId,
            ...failure,
          })
          .catch(() => undefined);
    }
    return result;
  };

  return {
    show: (guildId) => store.read(guildId),
    async set(guildId, actorUserId, channelId) {
      if (!channelId) return { outcome: "VALIDATION_FAILED" };
      // The caller established ManageGuild and a resolved guild channel selector.
      const attempt: AdministrativeAttempt = { operationId: randomUUID() };
      const preflight = await discord.preflight(guildId, channelId);
      if (preflight === false || (typeof preflight === "object" && !preflight.ok)) {
        if (typeof preflight === "object" && preflight.failure && preflight.targetId !== null)
          await failures
            ?.record(attempt, guildId, actorUserId, {
              operationCode: "AUDIT_DESTINATION_SET",
              targetType: "CHANNEL",
              targetId: preflight.targetId,
              ...preflight.failure,
            })
            .catch(() => undefined);
        if (
          typeof preflight === "object" &&
          preflight.targetId === null &&
          preflight.failure?.failureStage === "DISCORD_READ"
        )
          await failures
            ?.record(attempt, guildId, actorUserId, {
              operationCode: "AUDIT_DESTINATION_SET",
              targetType: "CHANNEL",
              targetId: null,
              ...preflight.failure,
            })
            .catch(() => undefined);
        return { outcome: "VALIDATION_FAILED" };
      }
      return change(guildId, actorUserId, channelId, attempt);
    },
    disable: (guildId, actorUserId) =>
      change(guildId, actorUserId, null, { operationId: randomUUID() }),
  };
}
