import type { Logger } from "pino";

import { formatAuditNotification, type AuditReference } from "./audit-notification-format.js";
import type { AuditNotificationRecord } from "./audit-notification-format.js";
import type { AuditNotificationSendResult } from "./audit-notification-discord.js";
import { InvalidAuditNotificationMetadataError } from "./audit-notification-projection.js";

export type AuditNotificationPublisher = {
  publish: (reference: AuditReference) => void;
};

export function createAuditNotificationDispatcher(dependencies: {
  projection: { load: (reference: AuditReference) => Promise<AuditNotificationRecord | undefined> };
  readDestination: (guildId: string) => Promise<string | null>;
  discord: {
    send: (input: {
      guildId: string;
      destinationId: string;
      content: string;
      nonce: string;
    }) => Promise<AuditNotificationSendResult>;
  };
  logger: Pick<Logger, "warn">;
}) {
  const tasks = new Set<Promise<void>>();
  const warn = (
    reference: AuditReference,
    outcome: string,
    guildId?: string,
    destinationId?: string,
  ) => {
    try {
      dependencies.logger.warn(
        {
          event: "audit_notification_delivery",
          source: reference.source,
          auditId: reference.auditId,
          ...(guildId === undefined ? {} : { guildId }),
          ...(destinationId === undefined ? {} : { destinationId }),
          outcome,
        },
        "Audit notification was not delivered",
      );
    } catch {
      // Operational logging must not affect the audit-producing operation or task ownership.
    }
  };

  return {
    publish(reference: AuditReference): void {
      try {
        const task = Promise.resolve().then(async () => {
          let record: AuditNotificationRecord | undefined;
          try {
            record = await dependencies.projection.load(reference);
          } catch (error) {
            warn(
              reference,
              error instanceof InvalidAuditNotificationMetadataError
                ? error.classification
                : "PROJECTION_FAILED",
            );
            return;
          }
          if (record === undefined) {
            warn(reference, "PROJECTION_MISSING");
            return;
          }
          const formatted = formatAuditNotification(record);
          if (formatted === undefined) {
            warn(reference, "FORMAT_INVALID");
            return;
          }
          let destinationId: string | null;
          try {
            destinationId = await dependencies.readDestination(record.guildId);
          } catch {
            warn(reference, "DESTINATION_READ_FAILED", record.guildId);
            return;
          }
          if (destinationId === null) return;
          if (!/^[0-9]{1,20}$/.test(destinationId)) {
            warn(reference, "DESTINATION_INVALID", record.guildId);
            return;
          }
          try {
            const outcome = await dependencies.discord.send({
              guildId: record.guildId,
              destinationId,
              ...formatted,
            });
            if (outcome !== "SENT") warn(reference, outcome, record.guildId, destinationId);
          } catch {
            warn(reference, "UNCONFIRMED", record.guildId, destinationId);
          }
        });
        tasks.add(task);
        void task.then(
          () => tasks.delete(task),
          () => {
            tasks.delete(task);
            warn(reference, "INTERNAL_FAILURE");
          },
        );
      } catch {
        warn(reference, "INTERNAL_FAILURE");
      }
    },
    async drain(): Promise<void> {
      while (tasks.size > 0) {
        await Promise.allSettled([...tasks]);
      }
    },
  };
}
