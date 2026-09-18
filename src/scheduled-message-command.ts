import { randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  ScheduledMessageCreationAuthorizationFailureCode,
  ScheduledMessageCreationDiscord,
} from "./scheduled-message-discord.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageStatusResult,
  ScheduledMessageStore,
} from "./scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "./scheduled-message-worker.js";
import {
  validateManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";
import { addRelativeDuration, InvalidRelativeDurationError } from "./relative-duration.js";

export type CreateScheduledMessageCommandInput = {
  guildId: string;
  channelId: string;
  actorUserId: string;
  durationMs: number;
  payload: ManagedMessagePayloadInput;
};

export type CreateScheduledMessageCommandResult =
  | {
      outcome: "SUCCESS";
      definition: ScheduledMessageDefinition;
      deliveryPendingReconciliation: boolean;
    }
  | {
      outcome: "FAILURE";
      code:
        | ManagedMessagePayloadValidationCode
        | ScheduledMessageCreationAuthorizationFailureCode
        | "INVALID_DURATION"
        | "PERSISTENCE_UNCONFIRMED";
    };

export type CancelScheduledMessageCommandResult =
  | { outcome: "CANCELLED" | "ALREADY_CANCELLED"; deliveryCleanupPending: boolean }
  | {
      outcome:
        | "EXECUTING"
        | "COMPLETED"
        | "FAILED"
        | "NOT_FOUND_OR_WRONG_CONTEXT"
        | "PERSISTENCE_UNCONFIRMED";
    };

export type ScheduledMessageCommandService = {
  create: (
    input: CreateScheduledMessageCommandInput,
  ) => Promise<CreateScheduledMessageCommandResult>;
  cancel: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
    actorUserId: string;
  }) => Promise<CancelScheduledMessageCommandResult>;
  status: (input: {
    scheduledActionId: string;
    guildId: string;
    channelId: string;
  }) => Promise<ScheduledMessageStatusResult>;
};

type Dependencies = {
  discord: ScheduledMessageCreationDiscord;
  store: Pick<ScheduledMessageStore, "create" | "cancel" | "findStatus">;
  delivery: Pick<
    ScheduledMessageWorkerController,
    "enqueueScheduledMessage" | "hasCreatedOrRetryDelivery" | "cancelScheduledMessageDeliveries"
  >;
  logger: Pick<Logger, "warn">;
  generateId?: () => string;
  now?: () => Date;
};

export function createScheduledMessageCommandService({
  discord,
  store,
  delivery,
  logger,
  generateId = randomUUID,
  now = () => new Date(),
}: Dependencies): ScheduledMessageCommandService {
  return {
    async create(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

      let authorization;
      try {
        authorization = await discord.authorizeCreation({
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: validation.payload,
        });
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }
      if (authorization.outcome === "FAILURE") return authorization;

      const scheduledActionId = generateId();
      const auditId = generateId();
      const establishedAt = now();
      let executeAt: Date;
      try {
        executeAt = addRelativeDuration(establishedAt, input.durationMs);
      } catch (error) {
        if (!(error instanceof InvalidRelativeDurationError)) throw error;
        return { outcome: "FAILURE", code: "INVALID_DURATION" };
      }

      let definition: ScheduledMessageDefinition;
      try {
        definition = await store.create({
          scheduledActionId,
          auditId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          executeAt,
          payload: validation.payload,
          occurredAt: establishedAt,
        });
      } catch {
        logger.warn(
          {
            event: "scheduled_message_command_creation_unconfirmed",
            scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
            auditId,
          },
          "Scheduled message command creation could not be confirmed",
        );
        return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED" };
      }

      let deliveryPendingReconciliation = false;
      try {
        await delivery.enqueueScheduledMessage(definition.action.id, definition.action.executeAt);
      } catch {
        try {
          deliveryPendingReconciliation = !(await delivery.hasCreatedOrRetryDelivery(
            definition.action.id,
          ));
        } catch {
          deliveryPendingReconciliation = true;
        }
      }
      if (deliveryPendingReconciliation) {
        logger.warn(
          {
            event: "scheduled_message_command_delivery_pending",
            scheduledActionId: definition.action.id,
            guildId: definition.action.guildId,
            channelId: definition.action.targetId,
          },
          "Scheduled message delivery is pending reconciliation",
        );
      }
      return { outcome: "SUCCESS", definition, deliveryPendingReconciliation };
    },

    async cancel(input) {
      const auditId = generateId();
      const occurredAt = now();
      let result: Awaited<ReturnType<ScheduledMessageStore["cancel"]>>;
      try {
        result = await store.cancel({
          scheduledActionId: input.scheduledActionId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorId: input.actorUserId,
          auditId,
          occurredAt,
        });
      } catch {
        result = { outcome: "PERSISTENCE_UNCONFIRMED" } as const;
      }
      if (result.outcome !== "CANCELLED" && result.outcome !== "ALREADY_CANCELLED") {
        return { outcome: result.outcome };
      }

      let cleanup;
      try {
        cleanup = await delivery.cancelScheduledMessageDeliveries(input.scheduledActionId);
      } catch {
        cleanup = { outcome: "UNCONFIRMED" } as const;
      }
      const deliveryCleanupPending = cleanup.outcome === "UNCONFIRMED";
      if (deliveryCleanupPending) {
        logger.warn(
          {
            event: "scheduled_message_command_delivery_cleanup_pending",
            scheduledActionId: input.scheduledActionId,
            guildId: input.guildId,
            channelId: input.channelId,
          },
          "Cancelled scheduled message delivery cleanup could not be confirmed",
        );
      }
      return { outcome: result.outcome, deliveryCleanupPending };
    },

    async status(input) {
      try {
        return await store.findStatus(input.scheduledActionId, input.guildId, input.channelId);
      } catch {
        return { outcome: "UNAVAILABLE" };
      }
    },
  };
}
