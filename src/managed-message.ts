import { randomBytes, randomUUID } from "node:crypto";

import type { Logger } from "pino";

import type {
  ManagedMessageDiscord,
  ManagedMessageDiscordEditFailureCode,
  ManagedMessageDiscordFailureCode,
} from "./managed-message-discord.js";
import type {
  CreateManagedMessage,
  DeleteManagedMessage,
  EditManagedMessage,
  ManagedMessageStore,
} from "./managed-message-persistence.js";
import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
  type ManagedMessagePayload,
  type ManagedMessagePayloadInput,
  type ManagedMessagePayloadValidationCode,
} from "./managed-message-payload.js";

export const MANAGED_MESSAGE_MAX_EDITABLE_REVISION = 2_147_483_646;

export type ManagedMessageNonceGenerator = () => string;
export const generateManagedMessageNonce: ManagedMessageNonceGenerator = () =>
  randomBytes(16).toString("base64url");

export type ManagedMessageSendFailureCode =
  | ManagedMessagePayloadValidationCode
  | ManagedMessageDiscordFailureCode
  | "PERSISTENCE_UNCONFIRMED_COMPENSATED";
export type ManagedMessageSendResult =
  | { outcome: "SUCCESS"; messageId: string }
  | { outcome: "FAILURE"; code: ManagedMessageSendFailureCode }
  | { outcome: "PARTIAL_FAILURE"; messageId: string };

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
  | { outcome: "UNCHANGED" }
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
  generateNonce?: ManagedMessageNonceGenerator;
  generateAuditId?: () => string;
  now?: () => Date;
  modalLookupTimeoutMs?: number;
};

export function createManagedMessageService({
  discord,
  store,
  logger,
  generateNonce = generateManagedMessageNonce,
  generateAuditId = randomUUID,
  now = () => new Date(),
  modalLookupTimeoutMs = 2_000,
}: ManagedMessageServiceDependencies): ManagedMessageService {
  const editQueues = new Map<string, Promise<void>>();

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
  ): void {
    logger.warn(
      {
        event,
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: input.messageId,
        failureCode,
        ...(auditId === undefined ? {} : { auditId }),
        ...(error === undefined
          ? {}
          : { errorName: error instanceof Error ? error.name : "UnknownError" }),
      },
      "Managed message operation could not be confirmed",
    );
  }

  async function persistDeletion(
    input: { guildId: string; channelId: string; messageId: string },
    revision: number,
    payload: ManagedMessagePayload,
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
    try {
      if ((await store.markDeleted(deletion)) === "TRANSITIONED") {
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
    try {
      if ((await store.confirmDeletion(deletion)) === "MATCH") {
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
  ): Promise<ManagedMessageEditResult> {
    let safe = false;
    try {
      safe = (await store.readCompensationSafety(transition)) === "SAFE";
    } catch (error) {
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
      restored = await discord.restoreManagedMessage({
        guildId: transition.guildId,
        channelId: transition.channelId,
        messageId: transition.messageId,
        expectedPayload: transition.payload,
        expectedEditedAt: editedAt,
        restorePayload: transition.previousPayload,
      });
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

  return {
    async send(input) {
      const validation = validateManagedMessagePayload(input.payload);
      if (!validation.ok) return { outcome: "FAILURE", code: validation.code };

      const nonce = generateNonce();
      const discordResult = await discord.sendManagedMessage({
        guildId: input.guildId,
        channelId: input.channelId,
        actorUserId: input.actorUserId,
        payload: validation.payload,
        nonce,
      });
      if (discordResult.outcome === "FAILURE")
        return { outcome: "FAILURE", code: discordResult.code };

      if (
        discordResult.message.payload === undefined ||
        !managedMessagePayloadsEqual(discordResult.message.payload, validation.payload)
      ) {
        const deleteResult = await discord.deleteManagedMessage(discordResult.message);
        if (deleteResult.outcome === "DELETED") {
          warn(
            "managed_message_send_confirmation_compensated",
            discordResult.message,
            "RETURNED_PAYLOAD_MISMATCH",
          );
          return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" };
        }
        warn(
          "managed_message_send_confirmation_partial_failure",
          discordResult.message,
          "RETURNED_PAYLOAD_MISMATCH",
        );
        return { outcome: "PARTIAL_FAILURE", messageId: discordResult.message.messageId };
      }

      const creation: CreateManagedMessage = {
        messageId: discordResult.message.messageId,
        guildId: discordResult.message.guildId,
        channelId: discordResult.message.channelId,
        createdAt: discordResult.message.createdAt,
        auditId: generateAuditId(),
        creatorUserId: input.actorUserId,
        payload: validation.payload,
      };
      try {
        await store.create(creation);
        return { outcome: "SUCCESS", messageId: creation.messageId };
      } catch (error) {
        warn(
          "managed_message_persistence_create_failed",
          creation,
          "CREATE_REJECTED_OR_UNCONFIRMED",
          error,
          creation.auditId,
        );
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
      if (confirmation === "MATCH") return { outcome: "SUCCESS", messageId: creation.messageId };

      const deleteResult = await discord.deleteManagedMessage(discordResult.message);
      if (deleteResult.outcome === "DELETED") {
        warn(
          "managed_message_persistence_compensated",
          creation,
          confirmation,
          undefined,
          creation.auditId,
        );
        return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" };
      }
      warn("managed_message_partial_failure", creation, confirmation, undefined, creation.auditId);
      return { outcome: "PARTIAL_FAILURE", messageId: creation.messageId };
    },

    async findForEdit(input) {
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const message = await Promise.race([
          store.find(input.messageId),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Managed message lookup timed out")),
              modalLookupTimeoutMs,
            );
          }),
        ]).finally(() => {
          if (timeout !== undefined) clearTimeout(timeout);
        });
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

    edit(input) {
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
          discordResult = await discord.editManagedMessage({
            guildId: input.guildId,
            channelId: input.channelId,
            messageId: input.messageId,
            actorUserId: input.actorUserId,
            previousPayload: current.payload,
            payload: validation.payload,
          });
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
          return persistDeletion(input, current.revision, current.payload);
        }
        if (discordResult.outcome === "FAILURE") {
          return { outcome: "FAILURE", code: discordResult.code };
        }
        if (discordResult.outcome === "UNCHANGED") return { outcome: "UNCHANGED" };

        const transition: EditManagedMessage = {
          auditId: generateAuditId(),
          messageId: input.messageId,
          guildId: input.guildId,
          channelId: input.channelId,
          actorUserId: input.actorUserId,
          expectedRevision: current.revision,
          previousPayload: current.payload,
          payload: validation.payload,
          occurredAt: discordResult.editedAt,
        };
        try {
          if ((await store.edit(transition)) === "TRANSITIONED") {
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
        try {
          if ((await store.confirmEdit(transition)) === "MATCH") {
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
        return compensateEdit(transition, discordResult.editedAt);
      });
    },
  };
}
