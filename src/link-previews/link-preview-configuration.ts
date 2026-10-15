import {
  confirmedAdministrativeDatabaseFailure,
  type AdministrativeFailureRecorder,
} from "../audit/administrative-operation-failure-audit.js";
import type { AdministrativeAttempt } from "../administrative-transaction.js";
import { randomUUID } from "node:crypto";
import type { LinkPreviewStore } from "./link-preview-persistence.js";
import { isLinkPreviewMode } from "./link-preview.js";

export function createLinkPreviewConfiguration(
  store: LinkPreviewStore,
  failures?: AdministrativeFailureRecorder,
) {
  return {
    show: (guildId: string) => store.read(guildId),
    async set(guildId: string, actorUserId: string, value: string) {
      if (!isLinkPreviewMode(value)) return { outcome: "INVALID" as const };
      const attempt: AdministrativeAttempt = { operationId: randomUUID() };
      const result = await store.change({
        ...(failures ? { administrativeAttempt: attempt } : {}),
        guildId,
        actorUserId,
        newMode: value,
        auditId: attempt.operationId,
        occurredAt: new Date(),
      });
      const failure = confirmedAdministrativeDatabaseFailure(attempt);
      if (result.outcome === "UNCONFIRMED" && failure)
        await failures
          ?.record(attempt, guildId, actorUserId, {
            operationCode: "LINK_PREVIEW_MODE_SET",
            targetType: "GUILD",
            targetId: guildId,
            ...failure,
          })
          .catch(() => undefined);
      return result;
    },
  };
}
export type LinkPreviewConfiguration = ReturnType<typeof createLinkPreviewConfiguration>;
