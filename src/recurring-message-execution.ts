import { createHash, randomUUID } from "node:crypto";

import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
} from "./managed-message-payload.js";
import type {
  ScheduledMessageDiscord,
  ScheduledMessagePreflightResult,
  ScheduledMessageReadyTarget,
  ReturnedScheduledMessage,
} from "./scheduled-message-discord.js";
import type {
  RecurringMessageStore,
  RecurringOccurrenceFailureCode,
  RecurringMessageOccurrence,
} from "./recurring-message-persistence.js";
import {
  recurringClaimPayload,
  type RecurringRuntimeStore,
  type RecurringTerminalInput,
} from "./recurring-message-runtime-persistence.js";

export type RecurringDelivery = {
  kind: "recurring-message-occurrence";
  scheduledActionId: string;
  occurrenceId: string;
  scheduledFor: string;
  seriesRevision: number;
  retryCount: number;
};

export type RecurringExecutionResult =
  | { outcome: "SKIPPED" }
  | { outcome: "COMPLETED" }
  | { outcome: "FAILED"; code: RecurringOccurrenceFailureCode }
  | { outcome: "RETRY_PENDING"; wakeAt: Date; retryCount: number }
  | { outcome: "UNCONFIRMED" };

export type RecurringMessageExecutor = {
  execute: (delivery: RecurringDelivery) => Promise<RecurringExecutionResult>;
};

type Dependencies = {
  claims: Pick<RecurringMessageStore, "claimInitial">;
  store: RecurringRuntimeStore;
  discord: ScheduledMessageDiscord;
  now?: () => Date;
  generateId?: () => string;
};

export function deriveRecurringOccurrenceNonce(occurrenceId: string): string {
  return `ro_${createHash("sha256").update("weft:recurring-occurrence:v1\0").update(occurrenceId).digest("base64url").slice(0, 22)}`;
}

function validPayload(
  occurrence: RecurringMessageOccurrence,
  fallback?: ReturnType<typeof recurringClaimPayload>,
) {
  const payload = fallback ?? recurringClaimPayload(occurrence);
  if (payload === undefined) return undefined;
  const checked = validateManagedMessagePayload(payload);
  return checked.ok && managedMessagePayloadsEqual(checked.payload, payload) ? payload : undefined;
}

function returnedMatches(
  message: ReturnedScheduledMessage,
  target: ScheduledMessageReadyTarget,
  payload: NonNullable<ReturnType<typeof recurringClaimPayload>>,
  nonce: string,
): boolean {
  return (
    message.guildId === target.guildId &&
    message.channelId === target.channelId &&
    message.authorId === target.botUserId &&
    message.nonce === nonce &&
    message.payload !== undefined &&
    managedMessagePayloadsEqual(message.payload, payload)
  );
}

export function createRecurringMessageExecutor({
  claims,
  store,
  discord,
  now = () => new Date(),
  generateId = randomUUID,
}: Dependencies): RecurringMessageExecutor {
  const terminal = async (
    occurrenceId: string,
    failureCode: RecurringOccurrenceFailureCode,
    resultMessageId?: string,
  ): Promise<RecurringExecutionResult> => {
    const result = await store.terminalize({
      occurrenceId,
      auditId: generateId(),
      nextOccurrenceId: generateId(),
      occurredAt: now(),
      failureCode,
      ...(resultMessageId === undefined ? {} : { resultMessageId }),
    });
    return result === "COMMITTED"
      ? { outcome: "FAILED", code: failureCode }
      : { outcome: "UNCONFIRMED" };
  };

  const retryOrFail = async (occurrenceId: string): Promise<RecurringExecutionResult> => {
    const result = await store.recordPreSendFailure({
      occurrenceId,
      auditId: generateId(),
      nextOccurrenceId: generateId(),
      occurredAt: now(),
    });
    if (result.outcome === "RETRY_PENDING") return result;
    if (result.outcome === "FAILED") return { outcome: "FAILED", code: result.failureCode };
    return { outcome: "UNCONFIRMED" };
  };

  const processPreflightFailure = async (
    occurrenceId: string,
    preflight: Extract<ScheduledMessagePreflightResult, { outcome: "FAILURE" }>,
  ): Promise<RecurringExecutionResult> =>
    preflight.retryable ? retryOrFail(occurrenceId) : terminal(occurrenceId, preflight.code);

  return {
    async execute(delivery) {
      let loaded;
      try {
        loaded = await store.load(delivery.occurrenceId);
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
      if (
        loaded === undefined ||
        loaded.action.id !== delivery.scheduledActionId ||
        loaded.action.status !== "ACTIVE" ||
        loaded.occurrence.scheduledFor.toISOString() !== delivery.scheduledFor ||
        loaded.occurrence.retryCount !== delivery.retryCount ||
        loaded.occurrence.status !== (delivery.retryCount === 0 ? "PENDING" : "RETRY_PENDING")
      )
        return { outcome: "SKIPPED" };
      const at = now();
      if (delivery.retryCount === 0 && loaded.occurrence.scheduledFor.getTime() > at.getTime())
        return { outcome: "SKIPPED" };
      if (
        delivery.retryCount === 0 &&
        at.getTime() > loaded.occurrence.scheduledFor.getTime() + 15 * 60_000
      )
        return { outcome: "SKIPPED" };
      let preflight: ScheduledMessagePreflightResult | undefined;
      let payload;
      let claimed: RecurringMessageOccurrence;
      if (delivery.retryCount === 0) {
        payload = validPayload(loaded.occurrence, {
          content: loaded.state.content,
          embed:
            loaded.state.embedTitle === null &&
            loaded.state.embedDescription === null &&
            loaded.state.embedImageUrl === null
              ? null
              : {
                  ...(loaded.state.embedTitle === null ? {} : { title: loaded.state.embedTitle }),
                  ...(loaded.state.embedDescription === null
                    ? {}
                    : { description: loaded.state.embedDescription }),
                  ...(loaded.state.embedColor === null ? {} : { color: loaded.state.embedColor }),
                  ...(loaded.state.embedImageUrl === null
                    ? {}
                    : { imageUrl: loaded.state.embedImageUrl }),
                },
        });
        if (payload !== undefined) {
          try {
            preflight = await discord.preflight({
              guildId: loaded.action.guildId,
              channelId: loaded.action.targetId,
              payload,
            });
          } catch {
            preflight = { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED", retryable: true };
          }
        }
        let current;
        try {
          current = await store.load(delivery.occurrenceId);
        } catch {
          return { outcome: "UNCONFIRMED" };
        }
        const claimedAt = now();
        if (
          current === undefined ||
          current.occurrence.status !== "PENDING" ||
          current.occurrence.scheduledFor.getTime() !== loaded.occurrence.scheduledFor.getTime() ||
          current.action.id !== loaded.action.id ||
          current.action.status !== "ACTIVE" ||
          claimedAt.getTime() > current.occurrence.scheduledFor.getTime() + 15 * 60_000
        )
          return { outcome: "SKIPPED" };
        let claim;
        try {
          claim = await claims.claimInitial({
            occurrenceId: delivery.occurrenceId,
            expectedSeriesRevision: loaded.state.revision,
            claimedAt,
          });
        } catch {
          return { outcome: "UNCONFIRMED" };
        }
        if (claim.outcome !== "COMMITTED") return { outcome: "SKIPPED" };
        claimed = claim.occurrence;
        payload = validPayload(claimed);
        if (payload === undefined)
          return terminal(delivery.occurrenceId, "PERSISTED_PAYLOAD_INVALID");
      } else {
        if (loaded.occurrence.firstAttemptedAt === null) return { outcome: "UNCONFIRMED" };
        if (at.getTime() > loaded.occurrence.firstAttemptedAt.getTime() + 15 * 60_000) {
          const expired = await store.expireRetry({
            occurrenceId: delivery.occurrenceId,
            expectedRetryCount: delivery.retryCount,
            auditId: generateId(),
            nextOccurrenceId: generateId(),
            occurredAt: at,
          });
          if (expired === "COMMITTED")
            return { outcome: "FAILED", code: "PRE_SEND_RETRY_WINDOW_EXCEEDED" };
          return { outcome: expired === "NOT_COMMITTED" ? "SKIPPED" : "UNCONFIRMED" };
        }
        try {
          claimed = (await store.resumeRetry(delivery.occurrenceId, delivery.retryCount, at))!;
        } catch {
          return { outcome: "UNCONFIRMED" };
        }
        if (claimed === undefined) return { outcome: "SKIPPED" };
        payload = validPayload(claimed);
        if (payload === undefined)
          return terminal(delivery.occurrenceId, "PERSISTED_PAYLOAD_INVALID");
        try {
          preflight = await discord.preflight({
            guildId: loaded.action.guildId,
            channelId: loaded.action.targetId,
            payload,
          });
        } catch {
          preflight = { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED", retryable: true };
        }
      }
      if (preflight === undefined)
        return terminal(delivery.occurrenceId, "PERSISTED_PAYLOAD_INVALID");
      if (preflight.outcome === "FAILURE")
        return processPreflightFailure(delivery.occurrenceId, preflight);
      const nonce = deriveRecurringOccurrenceNonce(delivery.occurrenceId);
      const request = { target: preflight.target, payload, nonce };
      let created;
      try {
        created = await discord.createMessage(request);
      } catch {
        created = { outcome: "AMBIGUOUS" as const };
      }
      if (created.outcome === "REJECTED") return terminal(delivery.occurrenceId, "SEND_REJECTED");
      if (created.outcome === "AMBIGUOUS") {
        try {
          created = await discord.createMessage(request);
        } catch {
          created = { outcome: "AMBIGUOUS" as const };
        }
        if (created.outcome !== "CREATED")
          return terminal(delivery.occurrenceId, "SEND_UNCONFIRMED");
      }
      const message = created.message;
      if (!returnedMatches(message, preflight.target, payload, nonce)) {
        try {
          await discord.deleteMessage(message);
        } catch {
          /* keep known ID as evidence */
        }
        return terminal(delivery.occurrenceId, "RETURNED_MESSAGE_MISMATCH", message.messageId);
      }
      const input: RecurringTerminalInput = {
        occurrenceId: delivery.occurrenceId,
        auditId: generateId(),
        nextOccurrenceId: generateId(),
        occurredAt: now(),
        resultMessageId: message.messageId,
        messageCreatedAt: message.createdAt,
        managedMessageAuditId: generateId(),
      };
      const finalized = await store.terminalize(input);
      if (finalized === "COMMITTED") return { outcome: "COMPLETED" };
      if (finalized === "UNKNOWN") return { outcome: "UNCONFIRMED" };
      let deleted = false;
      try {
        deleted = (await discord.deleteMessage(message)).outcome === "DELETED";
      } catch {
        /* ambiguous deletion is uncompensated */
      }
      return terminal(
        delivery.occurrenceId,
        deleted ? "FINALIZATION_FAILED_COMPENSATED" : "FINALIZATION_FAILED_UNCOMPENSATED",
        deleted ? undefined : message.messageId,
      );
    },
  };
}
