import { randomBytes } from "node:crypto";

import type { Logger } from "pino";

import type {
  ManagedMessageDiscord,
  ManagedMessageDiscordFailureCode,
} from "./managed-message-discord.js";
import type {
  CreateManagedMessage,
  ManagedMessageCreationConfirmation,
  ManagedMessageStore,
} from "./managed-message-persistence.js";

export const MANAGED_MESSAGE_CONTENT_MAX_LENGTH = 2_000;

export type ManagedMessageContentValidationResult =
  { ok: true; content: string } | { ok: false; code: "EMPTY_CONTENT" | "CONTENT_TOO_LONG" };

export function validateManagedMessageContent(
  content: unknown,
): ManagedMessageContentValidationResult {
  if (typeof content !== "string" || content.trim().length === 0) {
    return { ok: false, code: "EMPTY_CONTENT" };
  }
  if ([...content].length > MANAGED_MESSAGE_CONTENT_MAX_LENGTH) {
    return { ok: false, code: "CONTENT_TOO_LONG" };
  }
  return { ok: true, content };
}

export type ManagedMessageNonceGenerator = () => string;

export const generateManagedMessageNonce: ManagedMessageNonceGenerator = () =>
  randomBytes(16).toString("base64url");

export type ManagedMessageSendFailureCode =
  | "EMPTY_CONTENT"
  | "CONTENT_TOO_LONG"
  | ManagedMessageDiscordFailureCode
  | "PERSISTENCE_UNCONFIRMED_COMPENSATED";

export type ManagedMessageSendResult =
  | { outcome: "SUCCESS"; messageId: string }
  | { outcome: "FAILURE"; code: ManagedMessageSendFailureCode }
  | { outcome: "PARTIAL_FAILURE"; messageId: string };

export type ManagedMessageService = {
  send: (input: {
    guildId: string;
    channelId: string;
    actorUserId: string;
    content: string;
  }) => Promise<ManagedMessageSendResult>;
};

type ManagedMessageServiceDependencies = {
  discord: ManagedMessageDiscord;
  store: ManagedMessageStore;
  logger: Pick<Logger, "warn">;
  generateNonce?: ManagedMessageNonceGenerator;
};

export function createManagedMessageService({
  discord,
  store,
  logger,
  generateNonce = generateManagedMessageNonce,
}: ManagedMessageServiceDependencies): ManagedMessageService {
  return {
    async send(input) {
      const validation = validateManagedMessageContent(input.content);
      if (!validation.ok) {
        return { outcome: "FAILURE", code: validation.code };
      }

      const nonce = generateNonce();
      const discordResult = await discord.sendManagedMessage({ ...input, nonce });
      if (discordResult.outcome === "FAILURE") {
        return { outcome: "FAILURE", code: discordResult.code };
      }

      const creation: CreateManagedMessage = {
        ...discordResult.message,
        creatorUserId: input.actorUserId,
        content: validation.content,
      };

      try {
        await store.create(creation);
        return { outcome: "SUCCESS", messageId: creation.messageId };
      } catch (error) {
        logger.warn(
          {
            event: "managed_message_persistence_create_failed",
            guildId: creation.guildId,
            channelId: creation.channelId,
            messageId: creation.messageId,
            failureCode: "CREATE_REJECTED_OR_UNCONFIRMED",
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Managed message persistence creation was not confirmed",
        );
      }

      let confirmation: ManagedMessageCreationConfirmation | "READ_FAILED";
      try {
        confirmation = await store.confirmCreation(creation);
      } catch (error) {
        confirmation = "READ_FAILED";
        logger.warn(
          {
            event: "managed_message_persistence_confirmation_failed",
            guildId: creation.guildId,
            channelId: creation.channelId,
            messageId: creation.messageId,
            failureCode: "CONFIRMATION_READ_FAILED",
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Managed message persistence confirmation failed",
        );
      }

      if (confirmation === "MATCH") {
        return { outcome: "SUCCESS", messageId: creation.messageId };
      }

      const deleteResult = await discord.deleteManagedMessage(discordResult.message);
      if (deleteResult.outcome === "DELETED") {
        logger.warn(
          {
            event: "managed_message_persistence_compensated",
            guildId: creation.guildId,
            channelId: creation.channelId,
            messageId: creation.messageId,
            failureCode: confirmation,
            outcome: "DELETED",
          },
          "Unconfirmed managed message persistence was compensated",
        );
        return { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" };
      }

      logger.warn(
        {
          event: "managed_message_partial_failure",
          guildId: creation.guildId,
          channelId: creation.channelId,
          messageId: creation.messageId,
          failureCode: confirmation,
          outcome: "DELETE_UNCONFIRMED",
        },
        "Managed message persistence and compensation remain unconfirmed",
      );
      return { outcome: "PARTIAL_FAILURE", messageId: creation.messageId };
    },
  };
}
