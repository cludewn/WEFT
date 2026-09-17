import {
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  RESTJSONErrorCodes,
  Routes,
} from "discord.js";

import type { AnyThreadChannel, Channel, Client, GuildTextBasedChannel, Message } from "discord.js";

import {
  buildManagedMessageEmbed,
  isSupportedManagedMessageTargetType,
  projectManagedMessagePayload,
} from "./managed-message-discord.js";
import type { ManagedMessagePayload } from "./managed-message-payload.js";

const UNKNOWN_MESSAGE_ERROR_CODE = 10_008;

export type ScheduledMessagePreflightFailureCode =
  | "UNSUPPORTED_TARGET"
  | "TARGET_GUILD_MISMATCH"
  | "ARCHIVED_THREAD"
  | "BOT_PERMISSION_MISSING"
  | "CURRENT_STATE_CHECK_REJECTED"
  | "CURRENT_STATE_CHECK_FAILED";

export type ScheduledMessageReadyTarget = {
  guildId: string;
  channelId: string;
  botUserId: string;
  token: unknown;
};

export type ScheduledMessagePreflightResult =
  | { outcome: "READY"; target: ScheduledMessageReadyTarget }
  | {
      outcome: "FAILURE";
      code: "CURRENT_STATE_CHECK_FAILED";
      retryable: true;
    }
  | {
      outcome: "FAILURE";
      code: Exclude<ScheduledMessagePreflightFailureCode, "CURRENT_STATE_CHECK_FAILED">;
      retryable: false;
    };

export type ReturnedScheduledMessage = {
  guildId: string | null;
  channelId: string;
  messageId: string;
  authorId: string;
  nonce: string | null;
  createdAt: Date;
  payload: ManagedMessagePayload | undefined;
};

export type ScheduledMessageCreateResult =
  | { outcome: "CREATED"; message: ReturnedScheduledMessage }
  | { outcome: "REJECTED" }
  | { outcome: "AMBIGUOUS" };

export type ScheduledMessageDeleteResult = { outcome: "DELETED" } | { outcome: "UNCONFIRMED" };

export type ScheduledMessageDiscord = {
  preflight: (input: {
    guildId: string;
    channelId: string;
    payload: ManagedMessagePayload;
  }) => Promise<ScheduledMessagePreflightResult>;
  createMessage: (input: {
    target: ScheduledMessageReadyTarget;
    payload: ManagedMessagePayload;
    nonce: string;
  }) => Promise<ScheduledMessageCreateResult>;
  deleteMessage: (message: ReturnedScheduledMessage) => Promise<ScheduledMessageDeleteResult>;
};

function isSupportedTarget(channel: Channel | null): channel is GuildTextBasedChannel {
  return channel !== null && isSupportedManagedMessageTargetType(channel.type);
}

function isThreadTarget(channel: GuildTextBasedChannel): channel is AnyThreadChannel {
  return channel.isThread();
}

function isConfirmedCreateRejection(error: unknown): boolean {
  if (error instanceof RateLimitError) return false;
  return (
    (error instanceof DiscordAPIError || error instanceof HTTPError) &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 425 &&
    error.status !== 429
  );
}

function transientPreflightFailure(): ScheduledMessagePreflightResult {
  return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED", retryable: true };
}

function permanentPreflightFailure(
  code: Exclude<ScheduledMessagePreflightFailureCode, "CURRENT_STATE_CHECK_FAILED">,
): ScheduledMessagePreflightResult {
  return { outcome: "FAILURE", code, retryable: false };
}

function classifyOtherHttpFailure(error: DiscordAPIError | HTTPError) {
  if (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status >= 500 && error.status < 600)
  ) {
    return transientPreflightFailure();
  }
  if (error.status >= 400 && error.status < 500) {
    return permanentPreflightFailure("CURRENT_STATE_CHECK_REJECTED");
  }
  return transientPreflightFailure();
}

function classifyChannelFetchFailure(error: unknown): ScheduledMessagePreflightResult {
  if (error instanceof RateLimitError) return transientPreflightFailure();
  if (error instanceof DiscordAPIError) {
    if (
      error.code === RESTJSONErrorCodes.UnknownChannel ||
      error.code === RESTJSONErrorCodes.UnknownGuild
    ) {
      return permanentPreflightFailure("UNSUPPORTED_TARGET");
    }
    if (
      error.code === RESTJSONErrorCodes.MissingAccess ||
      error.code === RESTJSONErrorCodes.MissingPermissions
    ) {
      return permanentPreflightFailure("BOT_PERMISSION_MISSING");
    }
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    if (error.status === 404) return permanentPreflightFailure("UNSUPPORTED_TARGET");
    if (error.status === 401 || error.status === 403)
      return permanentPreflightFailure("BOT_PERMISSION_MISSING");
    return classifyOtherHttpFailure(error);
  }
  return transientPreflightFailure();
}

function classifyBotMemberFetchFailure(error: unknown): ScheduledMessagePreflightResult {
  if (error instanceof RateLimitError) return transientPreflightFailure();
  if (error instanceof DiscordAPIError) {
    if (
      error.code === RESTJSONErrorCodes.UnknownChannel ||
      error.code === RESTJSONErrorCodes.UnknownGuild
    ) {
      return permanentPreflightFailure("UNSUPPORTED_TARGET");
    }
    if (
      error.code === RESTJSONErrorCodes.UnknownMember ||
      error.code === RESTJSONErrorCodes.MissingAccess ||
      error.code === RESTJSONErrorCodes.MissingPermissions
    ) {
      return permanentPreflightFailure("BOT_PERMISSION_MISSING");
    }
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    if (error.status === 401 || error.status === 403 || error.status === 404)
      return permanentPreflightFailure("BOT_PERMISSION_MISSING");
    return classifyOtherHttpFailure(error);
  }
  return transientPreflightFailure();
}

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE_ERROR_CODE;
}

function toReturnedMessage(message: Message): ReturnedScheduledMessage {
  return {
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    authorId: message.author.id,
    nonce: message.nonce === null ? null : String(message.nonce),
    createdAt: message.createdAt,
    payload: projectManagedMessagePayload(message),
  };
}

export function createScheduledMessageDiscord(client: Client): ScheduledMessageDiscord {
  return {
    async preflight(input) {
      let channel: Channel | null;
      try {
        channel = await client.channels.fetch(input.channelId, { force: true });
      } catch (error) {
        return classifyChannelFetchFailure(error);
      }
      if (!isSupportedTarget(channel)) {
        return { outcome: "FAILURE", code: "UNSUPPORTED_TARGET", retryable: false };
      }
      if (channel.guildId !== input.guildId) {
        return { outcome: "FAILURE", code: "TARGET_GUILD_MISMATCH", retryable: false };
      }
      if (isThreadTarget(channel) && channel.archived !== false) {
        return { outcome: "FAILURE", code: "ARCHIVED_THREAD", retryable: false };
      }
      if (client.user === null) {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED", retryable: true };
      }

      try {
        const bot = await channel.guild.members.fetch({ user: client.user.id, force: true });
        const permissions = channel.permissionsFor(bot);
        const canSend = isThreadTarget(channel)
          ? permissions.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessagesInThreads,
            ]) && channel.sendable
          : permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (
          !canSend ||
          (input.payload.embed !== null && !permissions.has(PermissionFlagsBits.EmbedLinks))
        ) {
          return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING", retryable: false };
        }
      } catch (error) {
        return classifyBotMemberFetchFailure(error);
      }

      return {
        outcome: "READY",
        target: {
          guildId: input.guildId,
          channelId: input.channelId,
          botUserId: client.user.id,
          token: channel,
        },
      };
    },

    async createMessage(input) {
      const channel = input.target.token;
      if (!isSupportedTarget(channel as Channel)) return { outcome: "REJECTED" };
      try {
        const message = await (channel as GuildTextBasedChannel).send({
          ...(input.payload.content === "" ? {} : { content: input.payload.content }),
          ...(input.payload.embed === null
            ? {}
            : { embeds: [buildManagedMessageEmbed(input.payload.embed)] }),
          allowedMentions: { parse: [] },
          nonce: input.nonce,
          enforceNonce: true,
        });
        return { outcome: "CREATED", message: toReturnedMessage(message) };
      } catch (error) {
        return { outcome: isConfirmedCreateRejection(error) ? "REJECTED" : "AMBIGUOUS" };
      }
    },

    async deleteMessage(message) {
      try {
        await client.rest.delete(Routes.channelMessage(message.channelId, message.messageId));
        return { outcome: "DELETED" };
      } catch (error) {
        return isUnknownMessage(error) ? { outcome: "DELETED" } : { outcome: "UNCONFIRMED" };
      }
    },
  };
}
