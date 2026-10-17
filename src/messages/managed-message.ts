import { randomBytes, randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  AdministrativeAttempt,
  AdministrativeTransactionEvidence,
} from "../administrative-transaction.js";

import type {
  ManagedMessageDiscord,
  ManagedMessageDiscordEditFailureCode,
  ManagedMessageDiscordFailureCode,
  ManagedMessageEmbedProjectionFailureReason,
} from "./managed-message-discord.js";
import type {
  CreateManagedMessage,
  DeleteManagedMessage,
  EditManagedMessage,
  ManagedMessageStore,
  ManagedMessageSuccessCandidate,
} from "./managed-message-persistence.js";
import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
  type ManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";

import {
  newManagedMessageExecutionAttempt,
  classifyManagedMessageExecution,
  type ManagedMessageExecutionAttempt,
  type ManagedMessageExecutionObservation,
} from "./managed-message-execution-evidence.js";
import type { ManagedMessageExecutionRecorder } from "./managed-message-execution-audit.js";

type ExecutionContext = {
  attempt: ManagedMessageExecutionAttempt;
  observation: ManagedMessageExecutionObservation;
  success?: ManagedMessageSuccessCandidate;
};

export const MANAGED_MESSAGE_MAX_EDITABLE_REVISION = 2_147_483_646;

export type ManagedMessageNonceGenerator = () => string;
export const generateManagedMessageNonce: ManagedMessageNonceGenerator = () =>
  randomBytes(16).toString("base64url");

export type ManagedMessageSendFailureCode =
  | ManagedMessagePayloadValidationCode
  | ManagedMessageDiscordFailureCode
  | "PERSISTENCE_UNCONFIRMED_COMPENSATED"
  | "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT";
export type ManagedMessageSendResult =
  | { outcome: "SUCCESS"; messageId: string }
  | { outcome: "FAILURE"; code: ManagedMessageSendFailureCode }
  | { outcome: "UNCONFIRMED"; messageId: string }
  | { outcome: "PARTIAL_FAILURE"; messageId: string; deletionOutcome: "REJECTED" | "UNCONFIRMED" };

export type ManagedMessageEditLookupResult =
  | { outcome: "FOUND"; messageId: string; payload: ManagedMessagePayload; revision: number }
  | { outcome: "NOT_FOUND" }
  | { outcome: "DELETED" }
  | { outcome: "FAILURE" };

export type ManagedMessageEditFailureCode =
  | ManagedMessagePayloadValidationCode
  | ManagedMessageDiscordEditFailureCode
  | "TARGET_NOT_FOUND"
  | "CONFLICT"
  | "PERSISTENCE_CHECK_FAILED"
  | "PERSISTENCE_UNCONFIRMED_COMPENSATED";
export type ManagedMessageEditResult =
  | { outcome: "SUCCESS"; messageId: string; revision: number }
  | { outcome: "UNCHANGED"; messageId: string }
  | { outcome: "DELETED" }
  | { outcome: "FAILURE"; code: ManagedMessageEditFailureCode }
  | {
      outcome: "PARTIAL_FAILURE";
      messageId: string;
      kind: "EDIT" | "DELETION_DETECTION";
    };

export type ManagedMessageService = {
  send: (input: {
    guildId: string;
    channelId: string;
    actorUserId: string;
    payload: ManagedMessagePayloadInput;
  }) => Promise<ManagedMessageSendResult>;
  findForEdit: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
  }) => Promise<ManagedMessageEditLookupResult>;
  edit: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    actorUserId: string;
    expectedRevision: number;
    payload: ManagedMessagePayloadInput;
  }) => Promise<ManagedMessageEditResult>;
};

type ManagedMessageServiceDependencies = {
  discord: ManagedMessageDiscord;
  store: ManagedMessageStore;
  logger: Pick<Logger, "warn">;
  failures?: ManagedMessageExecutionRecorder;
  generateNonce?: ManagedMessageNonceGenerator;
  generateAuditId?: () => string;
  now?: () => Date;
};

export function createManagedMessageService({
  discord,
  store,
  logger,
  failures,
  generateNonce = generateManagedMessageNonce,
  generateAuditId = randomUUID,
  now = () => new Date(),
}: ManagedMessageServiceDependencies): ManagedMessageService {
  const editQueues = new Map<string, Promise<void>>();

  function executionContext(
    operationCode: ManagedMessageExecutionAttempt["operationCode"],
    messageId: string | null = null,
  ): ExecutionContext | undefined {
    if (failures === undefined) return;
    const attempt = newManagedMessageExecutionAttempt(operationCode, messageId);
    return {
      attempt,
      observation: {
        attempt,
        actorAuthorized() {
          if (!attempt.eligible) {
            try {
              attempt.operationId = generateAuditId();
              attempt.eligible = true;
            } catch {
              // Audit-only admission must not replace Discord's original preflight result.
            }
          }
        },
      },
    };
  }
  async function recordExecution(
    execution: ExecutionContext | undefined,
    input: {
      guildId: string;
      channelId: string;
      actorUserId: string;
    },
  ): Promise<void> {
    if (execution === undefined || classifyManagedMessageExecution(execution.attempt) === undefined)
      return;
    try {
      await failures?.record(execution.attempt, input, execution.success);
    } catch {
      /* A failed recorder cannot replace the settled business result. */
    }
  }
  function beginPersistence(
    execution: ExecutionContext | undefined,
    success: ManagedMessageSuccessCandidate,
  ): void {
    if (execution === undefined) return;
    execution.success = success;
    execution.attempt.databaseTransition = "ATTEMPTED";
  }
  function confirmedSuccess(execution: ExecutionContext | undefined): void {
    if (execution) {
      execution.attempt.successConfirmed = true;
      execution.attempt.databaseTransition = "CONFIRMED";
    }
  }

  async function serializeEdit<T>(messageId: string, operation: () => Promise<T>): Promise<T> {
    const preceding = editQueues.get(messageId) ?? Promise.resolve();
    let release = (): void => undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = preceding.then(
      () => barrier,
      () => barrier,
    );
    editQueues.set(messageId, tail);
    await preceding.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (editQueues.get(messageId) === tail) {
        editQueues.delete(messageId);
      }
    }
  }

  function warn(
    event: string,
    input: { guildId: string; channelId: string; messageId: string },
    failureCode: string,
    error?: unknown,
    auditId?: string,
    payloadDiagnostics?: {
      payloadFailureReason?: "PROJECTION_FAILED" | "SEMANTIC_MISMATCH";
      transactionEvidence?: AdministrativeTransactionEvidence;
      deletionOutcome?: "DELETED" | "ALREADY_ABSENT" | "REJECTED" | "UNCONFIRMED";
      projectionFailureReason?: ManagedMessageEmbedProjectionFailureReason;
    },
  ): void {
    logger.warn(
      {
        event,
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        failureCode,
        ...payloadDiagnostics,
        ...(auditId === undefined ? {} : { auditId }),
        ...(error === undefined
          ? {}
          : { errorName: error instanceof Error ? error.name : "UnknownError" }),
      },
      "Managed message operation could not be confirmed",
    );
  }

  async function compensateSend(
    message: Parameters<ManagedMessageDiscord["deleteManagedMessage"]>[0],
    execution?: ExecutionContext,
  ) {
    if (execution) {
      execution.attempt.compensationType = "DELETE";
      execution.attempt.compensationEvidence = "UNCONFIRMED";
    }
    try {
      const result = await discord.deleteManagedMessage(message);
      if (execution)
        execution.attempt.compensationEvidence =
          result.outcome === "DELETED" ? "CONFIRMED" : result.outcome;
      return result;
    } catch (error) {
      warn("managed_message_send_compensation_failed", message, "DELETE_UNCONFIRMED", error);
      return { outcome: "UNCONFIRMED" } as const;
    }
  }

  async function persistDeletion(
    input: { guildId: string; channelId: string; messageId: string },
    revision: number,
    payload: ManagedMessagePayload,
    execution?: ExecutionContext,
  ): Promise<ManagedMessageEditResult> {
    const deletion: DeleteManagedMessage = {
      auditId: generateAuditId(),
      guildId: input.guildId,
      channelId: input.channelId,
      messageId: input.messageId,
      expectedRevision: revision,
      payload,
      occurredAt: now(),
    };
    beginPersistence(execution, { event: "DELETION_DETECTED", input: deletion });
    if (execution) {
      execution.attempt.discordEvidence = "DELETION_OBSERVED";
      execution.attempt.discordEffectAt = null;
      execution.attempt.compensationType = "NONE";
      execution.attempt.compensationEvidence = "NOT_REQUIRED";
    }
    try {
      if (
        (await store.markDeleted(
          deletion,
          ...(execution?.attempt.eligible ? [execution.attempt] : []),
        )) === "TRANSITIONED"
      ) {
        confirmedSuccess(execution);
        return { outcome: "DELETED" };
      }
    } catch (error) {
      warn(
        "managed_message_deletion_persistence_failed",
        input,
        "DELETE_UNCONFIRMED",
        error,
        deletion.auditId,
      );
    }
    if (
      execution?.attempt.transactionEvidence?.disposition === "COMMITTED" &&
      execution.attempt.databaseTransition === "ATTEMPTED"
    ) {
      confirmedSuccess(execution);
      return { outcome: "DELETED" };
    }
    try {
      if ((await store.confirmDeletion(deletion)) === "MATCH") {
        confirmedSuccess(execution);
        return { outcome: "DELETED" };
      }
    } catch (error) {
      warn(
        "managed_message_deletion_confirmation_failed",
        input,
        "CONFIRMATION_READ_FAILED",
        error,
        deletion.auditId,
      );
    }
    return {
      outcome: "PARTIAL_FAILURE",
      messageId: input.messageId,
      kind: "DELETION_DETECTION",
    };
  }

  async function compensateEdit(
    transition: EditManagedMessage,
    editedAt: Date,
    execution?: ExecutionContext,
  ): Promise<ManagedMessageEditResult> {
    if (execution) {
      execution.attempt.compensationType = "RESTORE";
      execution.attempt.compensationEvidence = "SKIPPED_DATABASE_GUARD";
    }
    let safe = false;
    try {
      safe = (await store.readCompensationSafety(transition)) === "SAFE";
    } catch (error) {
      if (execution) execution.attempt.compensationEvidence = "SKIPPED_READ_FAILURE";
      warn(
        "managed_message_edit_compensation_check_failed",
        transition,
        "COMPENSATION_CHECK_FAILED",
        error,
        transition.auditId,
      );
    }
    if (!safe) {
      return { outcome: "PARTIAL_FAILURE", messageId: transition.messageId, kind: "EDIT" };
    }
    let restored: Awaited<ReturnType<ManagedMessageDiscord["restoreManagedMessage"]>>;
    try {
      if (execution) execution.attempt.compensationEvidence = "UNCONFIRMED";
      restored = await discord.restoreManagedMessage(
        {
          guildId: transition.guildId,
          channelId: transition.channelId,
          messageId: transition.messageId,
          expectedPayload: transition.payload,
          expectedEditedAt: editedAt,
          restorePayload: transition.previousPayload,
        },
        ...(execution === undefined ? [] : [execution.observation]),
      );
    } catch (error) {
      warn(
        "managed_message_edit_compensation_failed",
        transition,
        "COMPENSATION_UNCONFIRMED",
        error,
        transition.auditId,
      );
      return { outcome: "PARTIAL_FAILURE", messageId: transition.messageId, kind: "EDIT" };
    }
    if (restored.outcome === "RESTORED") {
      if (execution) execution.attempt.compensationEvidence = "CONFIRMED";
      warn(
        "managed_message_edit_persistence_compensated",
        transition,
        "EDIT_FINALIZATION_COMPENSATED",
        undefined,
        transition.auditId,
      );
      return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" };
    }
    return { outcome: "PARTIAL_FAILURE", messageId: transition.messageId, kind: "EDIT" };
  }

  const operations = {
    async send(
      input: Parameters<ManagedMessageService["send"]>[0],
      execution?: ExecutionContext,
    ): Promise<ManagedMessageSendResult> {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

      const nonce = generateNonce();
      const discordResult = await discord.sendManagedMessage(
        {
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          payload: validation.payload,
          nonce,
        },
        ...(execution === undefined ? [] : [execution.observation]),
      );
      if (discordResult.outcome === "FAILURE")
        return { outcome: "FAILURE", code: discordResult.code };
      if (execution) {
        execution.attempt.discordEvidence = "SEND_CONFIRMED";
        execution.attempt.messageId = discordResult.message.messageId;
        execution.attempt.discordEffectAt = discordResult.message.createdAt;
        execution.attempt.payloadEvidence =
          discordResult.message.payload === undefined
            ? "PROJECTION_UNAVAILABLE"
            : managedMessagePayloadsEqual(discordResult.message.payload, validation.payload)
              ? "MATCH"
              : "MISMATCH";
        execution.attempt.failure = {
          stage: "DISCORD_RESPONSE",
          reasonCode:
            discordResult.message.payload === undefined
              ? "RETURNED_PAYLOAD_PROJECTION_FAILED"
              : "RETURNED_PAYLOAD_MISMATCH",
        };
      }

      if (
        discordResult.message.payload === undefined ||
        !managedMessagePayloadsEqual(discordResult.message.payload, validation.payload)
      ) {
        const payloadDiagnostics =
          discordResult.message.payload === undefined
            ? {
                payloadFailureReason: "PROJECTION_FAILED" as const,
                ...(discordResult.message.projectionFailureReason === undefined
                  ? {}
                  : { projectionFailureReason: discordResult.message.projectionFailureReason }),
              }
            : { payloadFailureReason: "SEMANTIC_MISMATCH" as const };
        const deleteResult = await compensateSend(discordResult.message, execution);
        if (deleteResult.outcome === "DELETED" || deleteResult.outcome === "ALREADY_ABSENT") {
          warn(
            "managed_message_send_confirmation_compensated",
            discordResult.message,
            "RETURNED_PAYLOAD_MISMATCH",
            undefined,
            undefined,
            payloadDiagnostics,
          );
          return {
            outcome: "FAILURE",
            code:
              deleteResult.outcome === "DELETED"
                ? "PERSISTENCE_UNCONFIRMED_COMPENSATED"
                : "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT",
          };
        }
        warn(
          "managed_message_send_confirmation_partial_failure",
          discordResult.message,
          "RETURNED_PAYLOAD_MISMATCH",
          undefined,
          undefined,
          payloadDiagnostics,
        );
        return {
          outcome: "PARTIAL_FAILURE",
          messageId: discordResult.message.messageId,
          deletionOutcome: deleteResult.outcome,
        };
      }

      const creation: CreateManagedMessage = {
        messageId: discordResult.message.messageId,
        guildId: discordResult.message.guildId,
        channelId: discordResult.message.channelId,
        createdAt: discordResult.message.createdAt,
        auditId: execution?.attempt.eligible ? execution.attempt.operationId : generateAuditId(),
        creatorUserId: input.actorUserId,
        payload: validation.payload,
      };
      const attempt: AdministrativeAttempt = execution?.attempt.eligible
        ? execution.attempt
        : { operationId: creation.auditId };
      beginPersistence(execution, { event: "CREATED", input: creation });
      try {
        await store.create(creation, attempt);
        confirmedSuccess(execution);
        return { outcome: "SUCCESS", messageId: creation.messageId };
      } catch (error) {
        warn(
          "managed_message_persistence_create_failed",
          creation,
          "CREATE_REJECTED_OR_UNCONFIRMED",
          error,
          creation.auditId,
          attempt.transactionEvidence === undefined
            ? {}
            : { transactionEvidence: attempt.transactionEvidence },
        );
      }

      // A post-commit notification/publication failure cannot undo acknowledged persistence.
      if (attempt.transactionEvidence?.disposition === "COMMITTED") {
        confirmedSuccess(execution);
        return { outcome: "SUCCESS", messageId: creation.messageId };
      }

      let confirmation: "MATCH" | "MISSING" | "CONFLICT" | "READ_FAILED";
      try {
        confirmation = await store.confirmCreation(creation);
      } catch (error) {
        confirmation = "READ_FAILED";
        warn(
          "managed_message_persistence_confirmation_failed",
          creation,
          "CONFIRMATION_READ_FAILED",
          error,
          creation.auditId,
        );
      }
      if (confirmation === "MATCH") {
        confirmedSuccess(execution);
        return { outcome: "SUCCESS", messageId: creation.messageId };
      }

      const disposition = attempt.transactionEvidence?.disposition;
      if (
        disposition !== "START_FAILED" &&
        disposition !== "ROLLED_BACK" &&
        disposition !== "COMMIT_REJECTED"
      ) {
        warn(
          "managed_message_persistence_unconfirmed",
          creation,
          confirmation,
          undefined,
          creation.auditId,
        );
        return { outcome: "UNCONFIRMED", messageId: creation.messageId };
      }

      const deleteResult = await compensateSend(discordResult.message, execution);
      if (deleteResult.outcome === "DELETED" || deleteResult.outcome === "ALREADY_ABSENT") {
        warn(
          "managed_message_persistence_compensated",
          creation,
          confirmation,
          undefined,
          creation.auditId,
          { deletionOutcome: deleteResult.outcome },
        );
        return {
          outcome: "FAILURE",
          code:
            deleteResult.outcome === "DELETED"
              ? "PERSISTENCE_UNCONFIRMED_COMPENSATED"
              : "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT",
        };
      }
      warn("managed_message_partial_failure", creation, confirmation, undefined, creation.auditId, {
        deletionOutcome: deleteResult.outcome,
      });
      return {
        outcome: "PARTIAL_FAILURE",
        messageId: creation.messageId,
        deletionOutcome: deleteResult.outcome,
      };
    },

    async findForEdit(
      input: Parameters<ManagedMessageService["findForEdit"]>[0],
    ): Promise<ManagedMessageEditLookupResult> {
      try {
        const message = await store.find(input.messageId);
        if (
          message === undefined ||
          message.messageId !== input.messageId ||
          message.guildId !== input.guildId ||
          message.channelId !== input.channelId
        ) {
          return { outcome: "NOT_FOUND" };
        }
        if (message.status === "DELETED") return { outcome: "DELETED" };
        if (message.revision > MANAGED_MESSAGE_MAX_EDITABLE_REVISION) return { outcome: "FAILURE" };
        return {
          outcome: "FOUND",
          messageId: message.messageId,
          payload: message.payload,
          revision: message.revision,
        };
      } catch {
        return { outcome: "FAILURE" };
      }
    },

    edit(
      input: Parameters<ManagedMessageService["edit"]>[0],
      execution?: ExecutionContext,
    ): Promise<ManagedMessageEditResult> {
      return serializeEdit(input.messageId, async () => {
        const validation = validateManagedMessagePayload(input.payload);
        if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

        let current;
        try {
          current = await store.find(input.messageId);
        } catch (error) {
          warn("managed_message_edit_state_read_failed", input, "PERSISTENCE_CHECK_FAILED", error);
          return { outcome: "FAILURE", code: "PERSISTENCE_CHECK_FAILED" };
        }
        if (
          current === undefined ||
          current.messageId !== input.messageId ||
          current.guildId !== input.guildId ||
          current.channelId !== input.channelId
        ) {
          return { outcome: "FAILURE", code: "TARGET_NOT_FOUND" };
        }
        if (current.status === "DELETED") return { outcome: "DELETED" };
        if (
          current.revision !== input.expectedRevision ||
          current.revision > MANAGED_MESSAGE_MAX_EDITABLE_REVISION
        ) {
          return { outcome: "FAILURE", code: "CONFLICT" };
        }

        let discordResult: Awaited<ReturnType<ManagedMessageDiscord["editManagedMessage"]>>;
        try {
          discordResult = await discord.editManagedMessage(
            {
              guildId: input.guildId,
              channelId: input.channelId,
              messageId: input.messageId,
              actorUserId: input.actorUserId,
              previousPayload: current.payload,
              payload: validation.payload,
            },
            ...(execution === undefined ? [] : [execution.observation]),
          );
        } catch (error) {
          warn(
            "managed_message_edit_discord_boundary_failed",
            input,
            "CURRENT_STATE_CHECK_FAILED",
            error,
          );
          return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
        }
        if (discordResult.outcome === "DELETED") {
          return persistDeletion(input, current.revision, current.payload, execution);
        }
        if (discordResult.outcome === "FAILURE") {
          return { outcome: "FAILURE", code: discordResult.code };
        }
        if (discordResult.outcome === "UNCHANGED")
          return { outcome: "UNCHANGED", messageId: current.messageId };

        if (execution) {
          execution.attempt.discordEvidence = "EDIT_CONFIRMED";
          execution.attempt.discordEffectAt = discordResult.editedAt;
          execution.attempt.payloadEvidence = "MATCH";
        }
        const transition: EditManagedMessage = {
          auditId: execution?.attempt.eligible ? execution.attempt.operationId : generateAuditId(),
          messageId: input.messageId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          expectedRevision: current.revision,
          previousPayload: current.payload,
          payload: validation.payload,
          occurredAt: discordResult.editedAt,
        };
        beginPersistence(execution, { event: "EDITED", input: transition });
        try {
          if (
            (await store.edit(
              transition,
              ...(execution?.attempt.eligible ? [execution.attempt] : []),
            )) === "TRANSITIONED"
          ) {
            confirmedSuccess(execution);
            return {
              outcome: "SUCCESS",
              messageId: input.messageId,
              revision: current.revision + 1,
            };
          }
        } catch (error) {
          warn(
            "managed_message_edit_persistence_failed",
            input,
            "EDIT_UNCONFIRMED",
            error,
            transition.auditId,
          );
        }
        if (
          execution?.attempt.transactionEvidence?.disposition === "COMMITTED" &&
          execution.attempt.databaseTransition === "ATTEMPTED"
        ) {
          confirmedSuccess(execution);
          return { outcome: "SUCCESS", messageId: input.messageId, revision: current.revision + 1 };
        }
        try {
          if ((await store.confirmEdit(transition)) === "MATCH") {
            confirmedSuccess(execution);
            return {
              outcome: "SUCCESS",
              messageId: input.messageId,
              revision: current.revision + 1,
            };
          }
        } catch (error) {
          warn(
            "managed_message_edit_confirmation_failed",
            input,
            "CONFIRMATION_READ_FAILED",
            error,
            transition.auditId,
          );
        }
        return compensateEdit(transition, discordResult.editedAt, execution);
      });
    },
  };
  return {
    ...operations,
    async send(input) {
      const execution = executionContext("MANAGED_MESSAGE_SEND");
      const result = await operations.send(input, execution);
      await recordExecution(execution, input);
      return result;
    },
    async edit(input) {
      const execution = executionContext("MANAGED_MESSAGE_EDIT", input.messageId);
      // serializeEdit has released the business FIFO before independent audit I/O begins.
      const result = await operations.edit(input, execution);
      await recordExecution(execution, input);
      return result;
    },
  };
}
