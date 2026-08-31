import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
} from "discord.js";

import type { AnyThreadChannel, Channel, Client, GuildTextBasedChannel } from "discord.js";

const UNKNOWN_MESSAGE_ERROR_CODE = 10_008;

const supportedTargetTypes = new Set<ChannelType>([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const supportedThreadTypes = new Set<ChannelType>([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

export function isSupportedManagedMessageTargetType(type: ChannelType): boolean {
  return supportedTargetTypes.has(type);
}

function isSupportedTarget(channel: Channel | null): channel is GuildTextBasedChannel {
  return channel !== null && isSupportedManagedMessageTargetType(channel.type);
}

export type SentManagedMessage = {
  guildId: string;
  channelId: string;
  messageId: string;
  createdAt: Date;
};

export type ManagedMessageDiscordFailureCode =
  | "UNSUPPORTED_TARGET"
  | "ARCHIVED_THREAD"
  | "ACTOR_PERMISSION_MISSING"
  | "BOT_PERMISSION_MISSING"
  | "CURRENT_STATE_CHECK_FAILED"
  | "SEND_REJECTED"
  | "SEND_UNCONFIRMED";

export type ManagedMessageDiscordSendResult =
  | { outcome: "SENT"; message: SentManagedMessage }
  | { outcome: "FAILURE"; code: ManagedMessageDiscordFailureCode };

export type ManagedMessageDiscordDeleteResult = { outcome: "DELETED" } | { outcome: "UNCONFIRMED" };

export type ManagedMessageDiscord = {
  sendManagedMessage: (input: {
    guildId: string;
    channelId: string;
    actorUserId: string;
    content: string;
    nonce: string;
  }) => Promise<ManagedMessageDiscordSendResult>;
  deleteManagedMessage: (message: SentManagedMessage) => Promise<ManagedMessageDiscordDeleteResult>;
};

function isThreadTarget(channel: GuildTextBasedChannel): channel is AnyThreadChannel {
  return channel.isThread() && supportedThreadTypes.has(channel.type);
}

function isConfirmedSendRejection(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return false;
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    return (
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 425 &&
      error.status !== 429
    );
  }
  return false;
}

export function createManagedMessageDiscord(client: Client): ManagedMessageDiscord {
  return {
    async sendManagedMessage(input) {
      let channel: Channel | null;
      try {
        channel = await client.channels.fetch(input.channelId, { force: true });
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }

      if (!isSupportedTarget(channel) || channel.guildId !== input.guildId) {
        return { outcome: "FAILURE", code: "UNSUPPORTED_TARGET" };
      }

      if (isThreadTarget(channel) && channel.archived !== false) {
        return { outcome: "FAILURE", code: "ARCHIVED_THREAD" };
      }

      if (client.user === null) {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }

      try {
        const [actor, bot] = await Promise.all([
          channel.guild.members.fetch({ user: input.actorUserId, force: true }),
          channel.guild.members.fetch({ user: client.user.id, force: true }),
        ]);
        if (!channel.permissionsFor(actor).has(PermissionFlagsBits.ManageMessages)) {
          return { outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" };
        }

        const botPermissions = channel.permissionsFor(bot);
        const canSend = isThreadTarget(channel)
          ? botPermissions.has([
              PermissionFlagsBits.ViewChannel,
              PermissionFlagsBits.SendMessagesInThreads,
            ]) && channel.sendable
          : botPermissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
        if (!canSend) {
          return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
        }
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }

      try {
        const message = await channel.send({
          content: input.content,
          allowedMentions: { parse: [] },
          nonce: input.nonce,
          enforceNonce: true,
        });
        return {
          outcome: "SENT",
          message: {
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            createdAt: message.createdAt,
          },
        };
      } catch (error) {
        return {
          outcome: "FAILURE",
          code: isConfirmedSendRejection(error) ? "SEND_REJECTED" : "SEND_UNCONFIRMED",
        };
      }
    },

    async deleteManagedMessage(message) {
      try {
        await client.rest.delete(Routes.channelMessage(message.channelId, message.messageId));
        return { outcome: "DELETED" };
      } catch (error) {
        if (error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE_ERROR_CODE) {
          return { outcome: "DELETED" };
        }
        return { outcome: "UNCONFIRMED" };
      }
    },
  };
}
