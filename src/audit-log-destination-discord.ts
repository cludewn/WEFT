import { ChannelType, PermissionFlagsBits } from "discord.js";

import type { Client } from "discord.js";

export type AuditLogDestinationDiscord = {
  preflight: (guildId: string, channelId: string) => Promise<boolean>;
};

export function createAuditLogDestinationDiscord(client: Client): AuditLogDestinationDiscord {
  return {
    async preflight(guildId, channelId) {
      try {
        const channel = await client.channels.fetch(channelId, { force: true });
        if (
          channel === null ||
          (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement) ||
          channel.guildId !== guildId ||
          client.user === null
        ) {
          return false;
        }
        const bot = await channel.guild.members.fetch({ user: client.user.id, force: true });
        const permissions = channel.permissionsFor(bot);
        return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
      } catch {
        return false;
      }
    },
  };
}
