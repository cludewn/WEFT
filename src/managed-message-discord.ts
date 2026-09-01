import {
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  EmbedType,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
} from "discord.js";

import type {
  AnyThreadChannel,
  APIEmbed,
  Channel,
  Client,
  Embed,
  GuildMember,
  GuildTextBasedChannel,
  Message,
} from "discord.js";

import {
  managedMessagePayloadsEqual,
  validateManagedMessagePayload,
  type ManagedMessageEmbed,
  type ManagedMessagePayload,
} from "./managed-message-payload.js";

const UNKNOWN_MESSAGE_ERROR_CODE = 10_008;
const ignoredPreviewEmbedTypes = new Set<EmbedType>([
  EmbedType.Link,
  EmbedType.Article,
  EmbedType.Video,
  EmbedType.GIFV,
  EmbedType.Image,
]);
const supportedRichEmbedImageKeys = new Set([
  "url",
  "proxy_url",
  "height",
  "width",
  "content_type",
  "placeholder",
  "placeholder_version",
]);

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
  payload: ManagedMessagePayload | undefined;
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
    payload: ManagedMessagePayload;
    nonce: string;
  }) => Promise<ManagedMessageDiscordSendResult>;
  deleteManagedMessage: (message: SentManagedMessage) => Promise<ManagedMessageDiscordDeleteResult>;
  editManagedMessage: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    actorUserId: string;
    previousPayload: ManagedMessagePayload;
    payload: ManagedMessagePayload;
  }) => Promise<ManagedMessageDiscordEditResult>;
  restoreManagedMessage: (input: {
    guildId: string;
    channelId: string;
    messageId: string;
    expectedPayload: ManagedMessagePayload;
    expectedEditedAt: Date;
    restorePayload: ManagedMessagePayload;
  }) => Promise<ManagedMessageDiscordRestoreResult>;
};

function isThreadTarget(channel: GuildTextBasedChannel): channel is AnyThreadChannel {
  return channel.isThread() && supportedThreadTypes.has(channel.type);
}

function isConfirmedSendRejection(error: unknown): boolean {
  if (error instanceof RateLimitError) return false;
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

export function buildManagedMessageEmbed(embed: ManagedMessageEmbed): EmbedBuilder {
  const builder = new EmbedBuilder();
  if (embed.title !== undefined) builder.setTitle(embed.title);
  if (embed.description !== undefined) builder.setDescription(embed.description);
  if (embed.color !== undefined) builder.setColor(embed.color);
  if (embed.imageUrl !== undefined) builder.setImage(embed.imageUrl);
  return builder;
}

function hasUnsupportedRichState(data: APIEmbed): boolean {
  return (
    data.url !== undefined ||
    data.timestamp !== undefined ||
    data.footer !== undefined ||
    data.thumbnail !== undefined ||
    data.author !== undefined ||
    (data.fields?.length ?? 0) > 0 ||
    data.provider !== undefined ||
    data.video !== undefined ||
    data.flags !== undefined
  );
}

export type ManagedMessageEmbedProjection =
  { ok: true; embed: ManagedMessageEmbed | null } | { ok: false };

export function projectManagedMessageEmbed(
  embeds: readonly Embed[],
): ManagedMessageEmbedProjection {
  let candidate: APIEmbed | undefined;
  for (const embed of embeds) {
    const data = embed.data;
    if (data.type === EmbedType.Rich) {
      if (candidate !== undefined) return { ok: false };
      candidate = data;
      continue;
    }
    if (data.type === undefined || !ignoredPreviewEmbedTypes.has(data.type)) return { ok: false };
  }
  if (candidate === undefined) return { ok: true, embed: null };
  if (hasUnsupportedRichState(candidate)) return { ok: false };
  let imageUrl: string | undefined;
  if (candidate.image !== undefined) {
    const image: unknown = candidate.image;
    if (
      typeof image !== "object" ||
      image === null ||
      Object.keys(image).some((key) => !supportedRichEmbedImageKeys.has(key))
    ) {
      return { ok: false };
    }
    const imageRecord = image as Record<string, unknown>;
    if (typeof imageRecord.url !== "string") return { ok: false };
    imageUrl = imageRecord.url;
  }
  const validation = validateManagedMessagePayload({
    content: "",
    embed: {
      title: candidate.title,
      description: candidate.description,
      color: candidate.color,
      imageUrl,
    },
  });
  if (!validation.ok || validation.payload.embed === null) return { ok: false };
  const projected = validation.payload.embed;
  if (
    projected.title !== candidate.title ||
    projected.description !== candidate.description ||
    projected.color !== candidate.color ||
    projected.imageUrl !== imageUrl
  ) {
    return { ok: false };
  }
  return { ok: true, embed: projected };
}

function projectManagedMessagePayload(message: Message): ManagedMessagePayload | undefined {
  const projection = projectManagedMessageEmbed(message.embeds);
  return projection.ok ? { content: message.content, embed: projection.embed } : undefined;
}

function editPayload(payload: ManagedMessagePayload) {
  return {
    content: payload.content === "" ? null : payload.content,
    embeds: payload.embed === null ? [] : [buildManagedMessageEmbed(payload.embed)],
    allowedMentions: { parse: [] as never[] },
  };
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
      if (client.user === null) return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };

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
        if (
          !canSend ||
          (input.payload.embed !== null && !botPermissions.has(PermissionFlagsBits.EmbedLinks))
        ) {
          return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
        }
      } catch {
        return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };
      }

      try {
        const message = await channel.send({
          ...(input.payload.content === "" ? {} : { content: input.payload.content }),
          ...(input.payload.embed === null
            ? {}
            : { embeds: [buildManagedMessageEmbed(input.payload.embed)] }),
          allowedMentions: { parse: [] },
          nonce: input.nonce,
          enforceNonce: true,
        });
        if (
          message.guildId !== input.guildId ||
          message.channelId !== input.channelId ||
          message.author.id !== client.user.id
        ) {
          return { outcome: "FAILURE", code: "SEND_UNCONFIRMED" };
        }
        return {
          outcome: "SENT",
          message: {
            guildId: message.guildId,
            channelId: message.channelId,
            messageId: message.id,
            createdAt: message.createdAt,
            payload: projectManagedMessagePayload(message),
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
        return isUnknownMessage(error) ? { outcome: "DELETED" } : { outcome: "UNCONFIRMED" };
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
      if (client.user === null) return { outcome: "FAILURE", code: "CURRENT_STATE_CHECK_FAILED" };

      let bot: GuildMember;
      try {
        const [actor, fetchedBot] = await Promise.all([
          channel.guild.members.fetch({ user: input.actorUserId, force: true }),
          channel.guild.members.fetch({ user: client.user.id, force: true }),
        ]);
        bot = fetchedBot;
        if (!channel.permissionsFor(actor).has(PermissionFlagsBits.ManageMessages)) {
          return { outcome: "FAILURE", code: "ACTOR_PERMISSION_MISSING" };
        }
        if (!channel.permissionsFor(fetchedBot).has(PermissionFlagsBits.ViewChannel)) {
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
      if (!message.editable) return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
      const currentPayload = projectManagedMessagePayload(message);
      if (
        currentPayload === undefined ||
        !managedMessagePayloadsEqual(currentPayload, input.previousPayload)
      ) {
        return { outcome: "FAILURE", code: "STATE_MISMATCH" };
      }
      if (managedMessagePayloadsEqual(input.payload, input.previousPayload)) {
        return { outcome: "UNCHANGED" };
      }
      if (
        input.payload.embed !== null &&
        !channel.permissionsFor(bot).has(PermissionFlagsBits.EmbedLinks)
      ) {
        return { outcome: "FAILURE", code: "BOT_PERMISSION_MISSING" };
      }

      const previousEditedAt = editedAt(message);
      try {
        const updated = await message.edit(editPayload(input.payload));
        const confirmedPayload = projectManagedMessagePayload(updated);
        const confirmedEditedAt = editedAt(updated);
        if (
          !hasExpectedMessageIdentity(updated, input, client.user.id) ||
          confirmedPayload === undefined ||
          !managedMessagePayloadsEqual(confirmedPayload, input.payload) ||
          confirmedEditedAt === null
        ) {
          return { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
        }
        return { outcome: "EDITED", editedAt: confirmedEditedAt };
      } catch (error) {
        if (isUnknownMessage(error)) return { outcome: "DELETED" };
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
      const reconciledPayload = projectManagedMessagePayload(reconciled);
      if (reconciledPayload === undefined) {
        return { outcome: "FAILURE", code: "EDIT_UNCONFIRMED" };
      }
      const reconciledEditedAt = editedAt(reconciled);
      if (
        managedMessagePayloadsEqual(reconciledPayload, input.payload) &&
        reconciledEditedAt !== null &&
        (previousEditedAt === null || reconciledEditedAt.getTime() > previousEditedAt.getTime())
      ) {
        return { outcome: "EDITED", editedAt: reconciledEditedAt };
      }
      if (
        managedMessagePayloadsEqual(reconciledPayload, input.previousPayload) &&
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
        const permissions = channel.permissionsFor(bot);
        if (
          !permissions.has(PermissionFlagsBits.ViewChannel) ||
          (input.restorePayload.embed !== null && !permissions.has(PermissionFlagsBits.EmbedLinks))
        ) {
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
      const currentPayload = projectManagedMessagePayload(message);
      if (
        !hasExpectedMessageIdentity(message, input, client.user.id) ||
        !message.editable ||
        currentPayload === undefined ||
        !managedMessagePayloadsEqual(currentPayload, input.expectedPayload) ||
        editedAt(message)?.getTime() !== input.expectedEditedAt.getTime()
      ) {
        return { outcome: "PRECONDITION_FAILED" };
      }
      try {
        const restored = await message.edit(editPayload(input.restorePayload));
        const restoredPayload = projectManagedMessagePayload(restored);
        return hasExpectedMessageIdentity(restored, input, client.user.id) &&
          restoredPayload !== undefined &&
          managedMessagePayloadsEqual(restoredPayload, input.restorePayload)
          ? { outcome: "RESTORED" }
          : { outcome: "UNCONFIRMED" };
      } catch {
        return { outcome: "UNCONFIRMED" };
      }
    },
  };
}
