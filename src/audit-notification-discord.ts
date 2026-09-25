import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
} from "discord.js";

import type { Client } from "discord.js";

export type AuditNotificationSendResult =
  "SENT" | "INVALID_DESTINATION" | "PREFLIGHT_FAILED" | "REJECTED" | "UNCONFIRMED";

export function createAuditNotificationDiscord(client: Client) {
  return {
    async send(input: {
      guildId: string;
      destinationId: string;
      content: string;
      nonce: string;
    }): Promise<AuditNotificationSendResult> {
      let channel;
      try {
        channel = await client.channels.fetch(input.destinationId, { force: true });
      } catch {
        return "PREFLIGHT_FAILED";
      }
      if (
        channel === null ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement) ||
        channel.guildId !== input.guildId ||
        client.user === null
      ) {
        return "INVALID_DESTINATION";
      }
      try {
        const bot = await channel.guild.members.fetch({ user: client.user.id, force: true });
        if (
          !channel
            .permissionsFor(bot)
            .has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
        ) {
          return "INVALID_DESTINATION";
        }
      } catch {
        return "PREFLIGHT_FAILED";
      }
      try {
        await channel.send({
          content: input.content,
          allowedMentions: { parse: [] },
          nonce: input.nonce,
          enforceNonce: true,
        });
        return "SENT";
      } catch (error) {
        if (
          !(error instanceof RateLimitError) &&
          (error instanceof DiscordAPIError || error instanceof HTTPError) &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408 &&
          error.status !== 425 &&
          error.status !== 429
        ) {
          return "REJECTED";
        }
        return "UNCONFIRMED";
      }
    },
  };
}
