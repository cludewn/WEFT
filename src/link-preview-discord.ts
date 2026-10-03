import {
  ButtonStyle,
  ChannelType,
  ComponentType,
  Events,
  MessageFlags,
  MessageType,
  MessageReferenceType,
  PermissionFlagsBits as P,
  Routes,
} from "discord.js";
import type {
  APIActionRowComponent,
  APIButtonComponent,
  APIMessage,
  APIUser,
  ButtonInteraction,
  Client,
} from "discord.js";
import type { Logger } from "pino";
import { z } from "zod";

import type { ApplicationIngress } from "./application-runtime.js";
import { isSnowflake, originalUrl, parsePreviewCustomId, previewCustomId } from "./link-preview.js";
import type {
  LinkPreviewBoundary,
  LinkPreviewService,
  MessageLink,
  PreviewHelper,
  PreviewObservation,
  PreviewMessage,
} from "./link-preview.js";
import {
  completeOverwrites,
  isPreviewText,
  isPreviewThread,
  memberPermissions,
  previewChannelSchema,
  previewMemberSchema,
  previewRolesSchema,
  READ_BITS,
  safePublicPermissions,
} from "./link-preview-permissions.js";
import type { PreviewChannel } from "./link-preview-permissions.js";

export const PREVIEW_FAILURE = "WEFT could not show this message.";
const guildSchema = z.object({
  id: z.string().refine(isSnowflake),
  owner_id: z.string().refine(isSnowflake),
});
const memberIdentity = z.object({
  nick: z.string().nullable().optional(),
  avatar: z.string().nullable().optional(),
});
const safeCdnUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port
    );
  } catch {
    return false;
  }
};
export function previewComponents(
  items: PreviewHelper[],
  targetCount: number,
): APIActionRowComponent<APIButtonComponent>[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: items.map(({ target, ordinal }) => ({
        type: ComponentType.Button,
        style: ButtonStyle.Secondary,
        label: targetCount === 1 ? "Preview" : `Preview ${ordinal}`,
        custom_id: previewCustomId(target),
      })),
    },
  ];
}
function openOriginalComponents(target: MessageLink): APIActionRowComponent<APIButtonComponent>[] {
  return [
    {
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.Button,
          style: ButtonStyle.Link,
          label: "Open original",
          url: originalUrl(target),
        },
      ],
    },
  ];
}
export function createLinkPreviewDiscord(client: Client): LinkPreviewBoundary {
  const get = (route: `/${string}`): Promise<unknown> => client.rest.get(route);
  async function guildAccess(guildId: string, userIds: string[]) {
    const ids = [...new Set(userIds)];
    const results = await Promise.allSettled([
      get(Routes.guild(guildId)),
      get(Routes.guildRoles(guildId)),
      ...ids.map((id) => get(Routes.guildMember(guildId, id))),
    ]);
    // Wait for every request, including siblings of failures, to keep ingress drain ownership.
    const values = results.map((result) => {
      if (result.status === "rejected") throw new Error("Unconfirmed access");
      return result.value;
    });
    const guild = guildSchema.parse(values[0]);
    if (guild.id !== guildId) throw new Error("Invalid guild");
    const roles = previewRolesSchema.parse(values[1]);
    const members = new Map(
      ids.map((id, index) => {
        const member = previewMemberSchema.parse(values[index + 2]);
        if (member.user.id !== id) throw new Error("Invalid member");
        return [id, member] as const;
      }),
    );
    return { guild, roles, members, memberships: new Map<string, Promise<boolean>>() };
  }
  async function observe(targets: MessageLink[], userIds: string[]) {
    // A new map per observation boundary deduplicates fresh channel/parent reads only.
    const channels = new Map<string, Promise<PreviewChannel>>();
    const readChannel = (id: string) => {
      let pending = channels.get(id);
      if (!pending) {
        pending = get(Routes.channel(id)).then((raw) => previewChannelSchema.parse(raw));
        channels.set(id, pending);
      }
      return pending;
    };
    const [states, access] = await Promise.allSettled([
      Promise.allSettled(
        targets.map(async (target) => {
          const channel = await readChannel(target.channelId);
          if (channel.id !== target.channelId || channel.guild_id !== target.guildId)
            throw new Error("Invalid target");
          if (isPreviewText(channel.type)) return { channel, parent: channel };
          if (!isPreviewThread(channel.type) || !channel.parent_id || !channel.thread_metadata)
            throw new Error("Unsupported target");
          const parent = await readChannel(channel.parent_id);
          const validParent =
            channel.type === ChannelType.AnnouncementThread
              ? parent.type === ChannelType.GuildAnnouncement
              : channel.type === ChannelType.PrivateThread
                ? parent.type === ChannelType.GuildText
                : parent.type === ChannelType.GuildText || parent.type === ChannelType.GuildForum;
          if (parent.id !== channel.parent_id || parent.guild_id !== target.guildId || !validParent)
            throw new Error("Invalid parent");
          return { channel, parent };
        }),
      ),
      guildAccess(targets[0]!.guildId, userIds),
    ]);
    if (states.status === "rejected") throw new Error("Unconfirmed channels");
    return {
      states: states.value,
      access: access.status === "fulfilled" ? access.value : undefined,
    };
  }
  type Access = Awaited<ReturnType<typeof guildAccess>>;
  function threadMembership(channelId: string, access: Access, userId: string): Promise<boolean> {
    const key = `${channelId}:${userId}`;
    let membership = access.memberships.get(key);
    if (!membership) {
      membership = get(Routes.threadMembers(channelId, userId)).then(
        (raw) =>
          z.object({ id: z.literal(channelId), user_id: z.literal(userId) }).safeParse(raw).success,
      );
      access.memberships.set(key, membership);
    }
    return membership;
  }
  async function permissionsFor(
    channel: PreviewChannel,
    parent: PreviewChannel,
    access: Access,
    userId: string,
  ): Promise<bigint | undefined> {
    const member = access.members.get(userId);
    if (!member) return;
    const permissions = memberPermissions(
      parent,
      access.roles,
      member,
      access.guild.owner_id,
      Date.now(),
    );
    if (permissions === undefined || (permissions & READ_BITS) !== READ_BITS) return;
    if (channel.type === ChannelType.PrivateThread && (permissions & P.ManageThreads) === 0n) {
      if (!(await threadMembership(channel.id, access, userId))) return;
    }
    return permissions;
  }
  const location = (channel: PreviewChannel, parent: PreviewChannel) =>
    channel.id === parent.id ? `#${channel.name}` : `#${parent.name} › ${channel.name}`;
  return {
    async sourceSendable(source) {
      try {
        if (!client.user) return false;
        const observed = await observe([source], [client.user.id]);
        const state = observed.states[0];
        if (state?.status !== "fulfilled" || !observed.access) return false;
        const { channel, parent } = state.value;
        if (
          isPreviewThread(channel.type) &&
          (channel.thread_metadata?.archived !== false || channel.thread_metadata.locked !== false)
        )
          return false;
        // Private sources require membership even with ManageThreads/Administrator.
        // Active public sources may gain membership through Discord's normal send behavior.
        // Target read authorization retains its separate private-thread visibility semantics.
        const [permissionCheck, membershipCheck] = await Promise.allSettled([
          permissionsFor(channel, parent, observed.access, client.user.id),
          channel.type === ChannelType.PrivateThread
            ? threadMembership(channel.id, observed.access, client.user.id)
            : Promise.resolve(true),
        ]);
        if (
          permissionCheck.status !== "fulfilled" ||
          membershipCheck.status !== "fulfilled" ||
          !membershipCheck.value
        )
          return false;
        const permissions = permissionCheck.value;
        const required =
          READ_BITS |
          P.EmbedLinks |
          (isPreviewThread(channel.type) ? P.SendMessagesInThreads : P.SendMessages);
        return permissions !== undefined && (permissions & required) === required;
      } catch {
        return false;
      }
    },
    async classify(targets) {
      if (!targets.length) return [];
      if (!client.user || targets.some((target) => target.guildId !== targets[0]!.guildId))
        return targets.map(() => ({ state: "UNCERTAIN" }));
      const botId = client.user.id;
      const observed = await observe(targets, [botId]);
      const results = await Promise.allSettled(
        observed.states.map(async (state): Promise<PreviewObservation> => {
          if (state.status !== "fulfilled") return { state: "UNCERTAIN" };
          const { channel, parent } = state.value;
          if (parent.nsfw === true) return { state: "INELIGIBLE" };
          if (parent.nsfw !== false || !completeOverwrites(parent) || !observed.access)
            return { state: "UNCERTAIN" };
          if ((await permissionsFor(channel, parent, observed.access, botId)) === undefined)
            return { state: "UNCERTAIN" };
          return channel.type !== ChannelType.PrivateThread &&
            safePublicPermissions(parent, observed.access.roles)
            ? { state: "PUBLIC", location: location(channel, parent) }
            : { state: "RESTRICTED" };
        }),
      );
      return results.map((result) =>
        result.status === "fulfilled" ? result.value : { state: "UNCERTAIN" },
      );
    },
    async authorize(target, userId) {
      try {
        if (!client.user) return;
        const ids = [...new Set([userId, client.user.id])];
        const observed = await observe([target], ids);
        const state = observed.states[0];
        if (state?.status !== "fulfilled" || !observed.access) return;
        const { channel, parent } = state.value;
        if (parent.nsfw !== false) return;
        const access = observed.access;
        const permissions = await Promise.allSettled(
          ids.map((id) => permissionsFor(channel, parent, access, id)),
        );
        if (
          permissions.some((result) => result.status === "rejected" || result.value === undefined)
        )
          return;
        return { location: location(channel, parent) };
      } catch {
        return;
      }
    },
    async fetchMessage(target): Promise<PreviewMessage> {
      const message = (await get(
        Routes.channelMessage(target.channelId, target.messageId),
      )) as APIMessage;
      if (
        message.id !== target.messageId ||
        message.channel_id !== target.channelId ||
        !message.author ||
        typeof message.content !== "string" ||
        !Number.isFinite(Date.parse(message.timestamp))
      )
        throw new Error("Invalid message");
      const author: APIUser = message.author;
      let name = author.global_name || author.username;
      const defaultAvatarIndex =
        author.discriminator && author.discriminator !== "0"
          ? BigInt(author.discriminator) % 5n
          : (BigInt(author.id) >> 22n) % 6n;
      let avatar = author.avatar
        ? `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png`
        : `https://cdn.discordapp.com/embed/avatars/${defaultAvatarIndex}.png`;
      if (!message.webhook_id) {
        try {
          const identity = memberIdentity.parse(
            await get(Routes.guildMember(target.guildId, author.id)),
          );
          name = identity.nick || name;
          if (identity.avatar)
            avatar = `https://cdn.discordapp.com/guilds/${target.guildId}/users/${author.id}/avatars/${identity.avatar}.png`;
        } catch {
          /* Departed members keep the freshly fetched message author identity. */
        }
      }
      return {
        author: name,
        avatar,
        content: message.content,
        timestamp: message.timestamp,
        attachments: message.attachments.map((attachment) => ({
          url: attachment.url,
          image:
            /^image\/(?:png|jpeg|gif|webp)$/.test(attachment.content_type ?? "") &&
            safeCdnUrl(attachment.url),
          spoiler: attachment.filename.startsWith("SPOILER_"),
        })),
        forwarded:
          message.message_reference?.type === MessageReferenceType.Forward ||
          !!message.message_snapshots?.length,
      };
    },
    async send(source, output, nonce) {
      // No lookups here: this request immediately follows the final observation batch.
      await client.rest.post(Routes.channelMessages(source.channelId), {
        body: {
          ...(output.overflow ? { content: `+${output.overflow} more` } : {}),
          ...(output.embeds.length ? { embeds: output.embeds } : {}),
          ...(output.helpers.length
            ? { components: previewComponents(output.helpers, output.targetCount) }
            : {}),
          allowed_mentions: { parse: [], replied_user: false },
          message_reference: {
            message_id: source.messageId,
            channel_id: source.channelId,
            guild_id: source.guildId,
            fail_if_not_exists: true,
          },
          nonce,
          enforce_nonce: true,
        },
      });
    },
  };
}

export async function handlePreviewButton(
  interaction: ButtonInteraction,
  service: LinkPreviewService,
  botId: string,
): Promise<void> {
  const target = parsePreviewCustomId(interaction.customId);
  if (
    !target ||
    !interaction.inGuild() ||
    target.guildId !== interaction.guildId ||
    interaction.message.author.id !== botId ||
    interaction.message.webhookId !== null ||
    interaction.applicationId !== interaction.client.application?.id
  )
    return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const embed = await service.preview(target, interaction.user.id);
  await interaction.editReply(
    embed
      ? {
          embeds: [embed],
          components: openOriginalComponents(target),
          allowedMentions: { parse: [], repliedUser: false },
        }
      : { content: PREVIEW_FAILURE, allowedMentions: { parse: [], repliedUser: false } },
  );
}
export function registerLinkPreviewHandlers(
  client: Client,
  service: LinkPreviewService,
  logger: Pick<Logger, "debug">,
  ingress: ApplicationIngress,
): void {
  const failed = () =>
    logger.debug(
      { event: "link_preview_failed", code: "HANDLER_UNCONFIRMED" },
      "Link preview handling unconfirmed",
    );
  client.on(Events.MessageCreate, (message) => {
    if (
      !message.inGuild() ||
      message.author.bot ||
      message.author.id === client.user?.id ||
      message.webhookId ||
      message.system ||
      ![MessageType.Default, MessageType.Reply].includes(message.type) ||
      !(isPreviewText(message.channel.type) || isPreviewThread(message.channel.type)) ||
      !message.content
    )
      return;
    void ingress
      .run(() =>
        service.detect({
          guildId: message.guildId,
          channelId: message.channelId,
          messageId: message.id,
          content: message.content,
        }),
      )
      ?.catch(failed);
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isButton() || !interaction.customId.startsWith("lp:") || !client.user) return;
    const botId = client.user.id;
    void ingress.run(() => handlePreviewButton(interaction, service, botId))?.catch(failed);
  });
}
