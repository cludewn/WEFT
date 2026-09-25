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
): AuditLogDestinationService {
  const change = (guildId: string, actorUserId: string, newChannelId: string | null) =>
    store.change({
      guildId,
      actorUserId,
      newChannelId,
      auditId: randomUUID(),
      occurredAt: new Date(),
    });

  return {
    show: (guildId) => store.read(guildId),
    async set(guildId, actorUserId, channelId) {
      if (!channelId || !(await discord.preflight(guildId, channelId))) {
        return { outcome: "VALIDATION_FAILED" };
      }
      return change(guildId, actorUserId, channelId);
    },
    disable: (guildId, actorUserId) => change(guildId, actorUserId, null),
  };
}
