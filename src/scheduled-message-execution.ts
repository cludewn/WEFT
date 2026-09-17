import { createHash, randomUUID } from "node:crypto";

import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
} from "./managed-message-payload.js";
import type {
  ReturnedScheduledMessage,
  ScheduledMessageDiscord,
  ScheduledMessagePreflightResult,
  ScheduledMessageReadyTarget,
} from "./scheduled-message-discord.js";
import type {
  ScheduledMessageDefinition,
  ScheduledMessageFailureCode,
  ScheduledMessageStore,
} from "./scheduled-message-persistence.js";

export const SCHEDULED_MESSAGE_GRACE_MS = 60 * 60 * 1_000;
export const SCHEDULED_MESSAGE_MAX_RETRY_COUNT = 3;

export type ScheduledMessageExecutionResult =
  | { outcome: "SUCCESS" }
  | { outcome: "SKIPPED"; reason: "MISSING" | "NOT_ACTIVE" | "ACTION_TYPE_MISMATCH" }
  | { outcome: "RETRYABLE_FAILURE"; code: "CURRENT_STATE_CHECK_FAILED" }
  | { outcome: "PERMANENT_FAILURE"; code: ScheduledMessageFailureCode }
  | { outcome: "UNCONFIRMED"; code: ScheduledMessageFailureCode | "PERSISTENCE_UNCONFIRMED" };

export type ScheduledMessageExecutor = {
  execute: (scheduledActionId: string) => Promise<ScheduledMessageExecutionResult>;
};

type Dependencies = {
  store: Pick<
    ScheduledMessageStore,
    | "findForExecution"
    | "claimExecution"
    | "retryPreSendFailure"
    | "failExecution"
    | "failMissingState"
    | "finalizeSuccess"
  >;
  discord: ScheduledMessageDiscord;
  now?: () => Date;
  generateId?: () => string;
};

export function deriveScheduledMessageNonce(scheduledActionId: string): string {
  return `sm_${createHash("sha256")
    .update("weft:scheduled-message:v1\0")
    .update(scheduledActionId)
    .digest("base64url")
    .slice(0, 22)}`;
}

export function isWithinScheduledMessageGrace(executeAt: Date, now: Date): boolean {
  return now.getTime() <= executeAt.getTime() + SCHEDULED_MESSAGE_GRACE_MS;
}

export function returnedScheduledMessageMatches(
  message: ReturnedScheduledMessage,
  definition: ScheduledMessageDefinition,
  target: ScheduledMessageReadyTarget,
  nonce: string,
): boolean {
  return (
    message.guildId === definition.action.guildId &&
    message.channelId === definition.action.targetId &&
    message.authorId === target.botUserId &&
    (message.nonce === null || message.nonce === nonce) &&
    message.payload !== undefined &&
    managedMessagePayloadsEqual(message.payload, definition.payload)
  );
}

function hasValidPersistedDefinition(definition: ScheduledMessageDefinition): boolean {
  const validation = validateManagedMessagePayload(definition.payload);
  return (
    definition.creatorUserId.length > 0 &&
    Number.isInteger(definition.retryCount) &&
    definition.retryCount >= 0 &&
    definition.retryCount <= SCHEDULED_MESSAGE_MAX_RETRY_COUNT &&
    definition.resultMessageId === null &&
    validation.ok &&
    managedMessagePayloadsEqual(validation.payload, definition.payload)
  );
}

export function createScheduledMessageExecutor({
  store,
  discord,
  now = () => new Date(),
  generateId = randomUUID,
}: Dependencies): ScheduledMessageExecutor {
  const failTerminal = async (
    definition: ScheduledMessageDefinition,
    code: ScheduledMessageFailureCode,
    resultMessageId: string | null = null,
    committedOutcome: "PERMANENT_FAILURE" | "UNCONFIRMED" = "PERMANENT_FAILURE",
  ): Promise<ScheduledMessageExecutionResult> => {
    try {
      const result = await store.failExecution({
        definition,
        auditId: generateId(),
        occurredAt: now(),
        failureCode: code,
        resultMessageId,
      });
      if (result.outcome !== "COMMITTED") {
        return { outcome: "UNCONFIRMED", code };
      }
      return committedOutcome === "PERMANENT_FAILURE"
        ? { outcome: "PERMANENT_FAILURE", code }
        : { outcome: "UNCONFIRMED", code };
    } catch {
      return { outcome: "UNCONFIRMED", code };
    }
  };

  const processPreflightFailure = async (
    definition: ScheduledMessageDefinition,
    preflight: Extract<ScheduledMessagePreflightResult, { outcome: "FAILURE" }>,
  ): Promise<ScheduledMessageExecutionResult> => {
    if (!preflight.retryable || definition.retryCount >= SCHEDULED_MESSAGE_MAX_RETRY_COUNT) {
      return failTerminal(definition, preflight.code);
    }
    try {
      const result = await store.retryPreSendFailure({
        definition,
        auditId: generateId(),
        occurredAt: now(),
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      });
      return result.outcome === "COMMITTED"
        ? { outcome: "RETRYABLE_FAILURE", code: "CURRENT_STATE_CHECK_FAILED" }
        : { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
    } catch {
      return { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
    }
  };

  const failMissingState = async (
    action: ScheduledMessageDefinition["action"],
  ): Promise<ScheduledMessageExecutionResult> => {
    try {
      const result = await store.failMissingState({
        action,
        auditId: generateId(),
        occurredAt: now(),
      });
      return result.outcome === "COMMITTED"
        ? { outcome: "PERMANENT_FAILURE", code: "PERSISTED_PAYLOAD_INVALID" }
        : { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
    } catch {
      return { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
    }
  };

  const compensateAndFail = async (
    definition: ScheduledMessageDefinition,
    message: ReturnedScheduledMessage,
    confirmedDeletionCode: ScheduledMessageFailureCode,
    unconfirmedDeletionCode: ScheduledMessageFailureCode,
  ): Promise<ScheduledMessageExecutionResult> => {
    let deleted: boolean;
    try {
      deleted = (await discord.deleteMessage(message)).outcome === "DELETED";
    } catch {
      deleted = false;
    }
    return failTerminal(
      definition,
      deleted ? confirmedDeletionCode : unconfirmedDeletionCode,
      deleted ? null : message.messageId,
    );
  };

  return {
    async execute(scheduledActionId) {
      let load;
      try {
        load = await store.findForExecution(scheduledActionId);
      } catch {
        return { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
      }
      if (load.outcome === "MISSING_ACTION") return { outcome: "SKIPPED", reason: "MISSING" };
      if (load.outcome === "ACTION_TYPE_MISMATCH") {
        return { outcome: "SKIPPED", reason: "ACTION_TYPE_MISMATCH" };
      }
      const loadedAction = load.outcome === "FOUND" ? load.definition.action : load.action;
      if (loadedAction.status !== "ACTIVE") return { outcome: "SKIPPED", reason: "NOT_ACTIVE" };

      const loaded = load.outcome === "FOUND" ? load.definition : undefined;
      const persistedDefinitionValid = loaded !== undefined && hasValidPersistedDefinition(loaded);
      const initiallyWithinGrace = isWithinScheduledMessageGrace(loadedAction.executeAt, now());
      let preflight: ScheduledMessagePreflightResult | undefined;
      if (persistedDefinitionValid && initiallyWithinGrace) {
        try {
          preflight = await discord.preflight({
            guildId: loadedAction.guildId,
            channelId: loadedAction.targetId,
            payload: loaded.payload,
          });
        } catch {
          preflight = {
            outcome: "FAILURE",
            code: "CURRENT_STATE_CHECK_FAILED",
            retryable: true,
          };
        }
      }

      const withinGraceAfterPreflight = isWithinScheduledMessageGrace(
        loadedAction.executeAt,
        now(),
      );
      let claim;
      try {
        claim = await store.claimExecution(loadedAction.id);
      } catch {
        // Ownership cannot be proven after response loss. Sending would risk a duplicate.
        return { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
      }
      if (claim.outcome === "NOT_TRANSITIONED") return { outcome: "SKIPPED", reason: "NOT_ACTIVE" };
      if (claim.outcome === "COMMITTED_STATE_MISSING") {
        return failMissingState(claim.action);
      }
      const executing = claim.definition;

      if (!persistedDefinitionValid) return failTerminal(executing, "PERSISTED_PAYLOAD_INVALID");
      if (!initiallyWithinGrace || !withinGraceAfterPreflight) {
        return failTerminal(executing, "OVERDUE_GRACE_EXCEEDED");
      }
      if (preflight === undefined) {
        return failTerminal(executing, "CURRENT_STATE_CHECK_FAILED");
      }
      if (preflight.outcome === "FAILURE") return processPreflightFailure(executing, preflight);

      const nonce = deriveScheduledMessageNonce(executing.action.id);
      const request = { target: preflight.target, payload: executing.payload, nonce };
      let createResult;
      try {
        createResult = await discord.createMessage(request);
      } catch {
        createResult = { outcome: "AMBIGUOUS" as const };
      }
      if (createResult.outcome === "REJECTED") return failTerminal(executing, "SEND_REJECTED");
      if (createResult.outcome === "AMBIGUOUS") {
        try {
          createResult = await discord.createMessage(request);
        } catch {
          createResult = { outcome: "AMBIGUOUS" as const };
        }
        if (createResult.outcome !== "CREATED") {
          return failTerminal(executing, "SEND_UNCONFIRMED", null, "UNCONFIRMED");
        }
      }

      const message = createResult.message;
      if (!returnedScheduledMessageMatches(message, executing, preflight.target, nonce)) {
        return compensateAndFail(
          executing,
          message,
          "RETURNED_MESSAGE_MISMATCH",
          "RETURNED_MESSAGE_MISMATCH",
        );
      }

      let finalization: "COMMITTED" | "PROVEN_UNCOMMITTED";
      try {
        finalization = await store.finalizeSuccess({
          definition: executing,
          messageId: message.messageId,
          messageCreatedAt: message.createdAt,
          managedMessageAuditId: generateId(),
          executionAuditId: generateId(),
          occurredAt: now(),
        });
      } catch {
        // The commit status is unknown. Deleting or resending could destroy a committed result.
        return { outcome: "UNCONFIRMED", code: "PERSISTENCE_UNCONFIRMED" };
      }
      if (finalization === "COMMITTED") return { outcome: "SUCCESS" };
      return compensateAndFail(
        executing,
        message,
        "FINALIZATION_FAILED_COMPENSATED",
        "FINALIZATION_FAILED_UNCOMPENSATED",
      );
    },
  };
}
