import { randomUUID } from "node:crypto";

import {
  validateManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageStore,
} from "./scheduled-message-persistence.js";

export type CreateScheduledMessageInput = {
  guildId: string;
  channelId: string;
  actorId: string;
  executeAt: Date;
  payload: ManagedMessagePayloadInput;
};

export type CreateScheduledMessageResult =
  | { ok: true; definition: ScheduledMessageDefinition }
  | { ok: false; code: ManagedMessagePayloadValidationCode };

export type ScheduledMessageService = {
  create: (input: CreateScheduledMessageInput) => Promise<CreateScheduledMessageResult>;
};

type ScheduledMessageServiceDependencies = {
  store: Pick<ScheduledMessageStore, "create">;
  generateId?: () => string;
  now?: () => Date;
};

export function createScheduledMessageService({
  store,
  generateId = randomUUID,
  now = () => new Date(),
}: ScheduledMessageServiceDependencies): ScheduledMessageService {
  return {
    async create(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return validation;

      const scheduledActionId = generateId();
      const auditId = generateId();
      const occurredAt = now();
      const definition = await store.create({
        scheduledActionId,
        auditId,
        guildId: input.guildId,
        channelId: input.channelId,
        actorId: input.actorId,
        executeAt: input.executeAt,
        payload: validation.payload,
        occurredAt,
      });
      return { ok: true, definition };
    },
  };
}
