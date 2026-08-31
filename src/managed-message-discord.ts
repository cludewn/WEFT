import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
} from "discord.js";

import type { AnyThreadChannel, Channel, Client, GuildTextBasedChannel, Message } from "discord.js";

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

export type ManagedMessageDiscordEditFailureCode =
  | "UNSUPPORTED_TARGET"
  | "ARCHIVED_THREAD"
  | "ACTOR_PERMISSION_MISSING"
  | "BOT_PERMISSION_MISSING"
  | "CURRENT_STATE_CHECK_FAILED"
  | "MESSAGE_INVALID"
  | "STATE_MISMATCH"
  | "EDIT_REJECTED"
  | "EDIT_NOT_APPLIED"
  | "EDIT_UNCONFIRMED";

export type ManagedMessageDiscordEditResult =
  | { outcome: "DELETED" }
  | { outcome: "UNCHANGED" }
  | { outcome: "EDITED"; editedAt: Date }
  | { outcome: "FAILURE"; code: ManagedMessageDiscordEditFailureCode };

export type ManagedMessageDiscordRestoreResult =
  { outcome: "RESTORED" } | { outcome: "PRECONDITION_FAILED" } | { outcome: "UNCONFIRMED" };

export type ManagedMessageDiscord = {
  sendManagedMessage: (input: {
    guildId: string;
    channelId: string;
    actorUserId: string;
    content: string;
    nonce: string;
  }) => Promise<ManagedMessageDiscordSendResult>;
  deleteManagedMessage: (message: SentManagedMessage) => Promise<ManagedMessageDiscordDeleteResult>;
  editManagedMessage: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    actorUserId: string;
    previousContent: string;
    content: string;
  }) => Promise<ManagedMessageDiscordEditResult>;
  restoreManagedMessage: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    expectedContent: string;
    expectedEditedAt: Date;
    restoreContent: string;
  }) => Promise<ManagedMessageDiscordRestoreResult>;
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

function isUnknownMessage(error: unknown): boolean {
  return error instanceof DiscordAPIError && error.code === UNKNOWN_MESSAGE_ERROR_CODE;
}

function isConfirmedEditRejection(error: unknown): boolean {
  return isConfirmedSendRejection(error) || isUnknownMessage(error);
}

function hasExpectedMessageIdentity(
  message: Message,
  input: { guildId: string; channelId: string; messageId: string },
  botUserId: string,
): boolean {
  return (
    message.id === input.messageId &&
    message.guildId === input.guildId &&
    message.channelId === input.channelId &&
    message.author.id === botUserId
  );
}

function editedAt(message: Message): Date | null {
  return message.editedAt;
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

    async editManagedMessage(input) {
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
        if (!channel.permissionsFor(bot).has(PermissionFlagsBits.ViewChannel)) {
          return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
        }
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }

      let message: Message;
      try {
        message = await channel.messages.fetch({
          message: input.messageId,
          force: true,
          cache: false,
        });
      } catch (error) {
        return isUnknownMessage(error)
          ? { outcome: "DELETED" }
          : { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }
      if (!hasExpectedMessageIdentity(message, input, client.user.id)) {
        return { outcome: "FAILURE", code: "MESSAGE_INVALID" };
      }
      if (!message.editable) {
        return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
      }
      if (message.content !== input.previousContent) {
        return { outcome: "FAILURE", code: "STATE_MISMATCH" };
      }
      if (input.content === input.previousContent) {
        return { outcome: "UNCHANGED" };
      }

      const previousEditedAt = editedAt(message);
      try {
        const updated = await message.edit({
          content: input.content,
          allowedMentions: { parse: [] },
        });
        const confirmedEditedAt = editedAt(updated);
        if (
          !hasExpectedMessageIdentity(updated, input, client.user.id) ||
          updated.content !== input.content ||
          confirmedEditedAt === null
        ) {
          return { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
        }
        return { outcome: "EDITED", editedAt: confirmedEditedAt };
      } catch (error) {
        if (isUnknownMessage(error)) {
          return { outcome: "DELETED" };
        }
        if (isConfirmedEditRejection(error)) {
          return { outcome: "FAILURE", code: "EDIT_REJECTED" };
        }
      }

      let reconciled: Message;
      try {
        reconciled = await channel.messages.fetch({
          message: input.messageId,
          force: true,
          cache: false,
        });
      } catch (error) {
        return isUnknownMessage(error)
          ? { outcome: "DELETED" }
          : { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
      }
      if (!hasExpectedMessageIdentity(reconciled, input, client.user.id)) {
        return { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
      }
      const reconciledEditedAt = editedAt(reconciled);
      if (
        reconciled.content === input.content &&
        reconciledEditedAt !== null &&
        (previousEditedAt === null || reconciledEditedAt.getTime() > previousEditedAt.getTime())
      ) {
        return { outcome: "EDITED", editedAt: reconciledEditedAt };
      }
      if (
        reconciled.content === input.previousContent &&
        reconciledEditedAt?.getTime() === previousEditedAt?.getTime()
      ) {
        return { outcome: "FAILURE", code: "EDIT_NOT_APPLIED" };
      }
      return { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
    },

    async restoreManagedMessage(input) {
      let channel: Channel | null;
      try {
        channel = await client.channels.fetch(input.channelId, { force: true });
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
      if (
        !isSupportedTarget(channel) ||
        channel.guildId !== input.guildId ||
        client.user === null ||
        (isThreadTarget(channel) && channel.archived !== false)
      ) {
        return { outcome: "PRECONDITION_FAILED" };
      }
      try {
        const bot = await channel.guild.members.fetch({ user: client.user.id, force: true });
        if (!channel.permissionsFor(bot).has(PermissionFlagsBits.ViewChannel)) {
          return { outcome: "PRECONDITION_FAILED" };
        }
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
      let message: Message;
      try {
        message = await channel.messages.fetch({
          message: input.messageId,
          force: true,
          cache: false,
        });
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
      if (
        !hasExpectedMessageIdentity(message, input, client.user.id) ||
        !message.editable ||
        message.content !== input.expectedContent ||
        editedAt(message)?.getTime() !== input.expectedEditedAt.getTime()
      ) {
        return { outcome: "PRECONDITION_FAILED" };
      }
      try {
        await message.edit({
          content: input.restoreContent,
          allowedMentions: { parse: [] },
        });
        return { outcome: "RESTORED" };
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
    },
  };
}
