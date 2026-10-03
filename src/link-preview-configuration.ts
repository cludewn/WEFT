import { randomUUID } from "node:crypto";
import type { LinkPreviewStore } from "./link-preview-persistence.js";
import { isLinkPreviewMode } from "./link-preview.js";

export function createLinkPreviewConfiguration(store: LinkPreviewStore) {
  return {
    show: (guildId: string) => store.read(guildId),
    async set(guildId: string, actorUserId: string, value: string) {
      if (!isLinkPreviewMode(value)) return { outcome: "INVALID" as const };
      return store.change({
        guildId,
        actorUserId,
        newMode: value,
        auditId: randomUUID(),
        occurredAt: new Date(),
      });
    },
  };
}
export type LinkPreviewConfiguration = ReturnType<typeof createLinkPreviewConfiguration>;
