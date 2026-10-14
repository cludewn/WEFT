import { ChannelType, DiscordAPIError, PermissionFlagsBits, RESTJSONErrorCodes } from "discord.js";

import type { Client } from "discord.js";
import type { AdministrativeDiscordFailure } from "./administrative-operation-failure-audit.js";

export type AuditDestinationPreflight =
  | { ok: true; targetId: string }
  | { ok: false; targetId: string | null; failure?: AdministrativeDiscordFailure };

export type AuditLogDestinationDiscord = {
  preflight: (guildId: string, channelId: string) => Promise<boolean | AuditDestinationPreflight>;
};

export function createAuditLogDestinationDiscord(client: Client): AuditLogDestinationDiscord {
  return {
    async preflight(guildId, channelId) {
      let targetId: string | null = null;
      try {
        const channel = await client.channels.fetch(channelId, { force: true });
        if (channel === null)
          return {
            ok: false,
            targetId,
            failure: {
              failureStage: "DISCORD_READ",
              failureReasonCode: "REQUIRED_RESOURCE_UNAVAILABLE",
            },
          };
        if (
          (channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement) ||
          channel.guildId !== guildId
        ) {
          return { ok: false, targetId };
        }
        targetId = channel.id;
        if (client.user === null)
          return {
            ok: false,
            targetId,
            failure: {
              failureStage: "DISCORD_PREFLIGHT",
              failureReasonCode: "BOT_CONTEXT_UNAVAILABLE",
            },
          };
        const bot = await channel.guild.members.fetch({ user: client.user.id, force: true });
        const permissions = channel.permissionsFor(bot);
        return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
          ? { ok: true, targetId }
          : {
              ok: false,
              targetId,
              failure: {
                failureStage: "DISCORD_PREFLIGHT",
                failureReasonCode: "BOT_PERMISSION_MISSING",
              },
            };
      } catch (error) {
        const confirmedClientError =
          error instanceof DiscordAPIError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 425, 429].includes(error.status);
        const unavailable =
          confirmedClientError &&
          [
            RESTJSONErrorCodes.UnknownChannel,
            RESTJSONErrorCodes.UnknownGuild,
            RESTJSONErrorCodes.UnknownMember,
          ].includes(error.code as number);
        const permission =
          targetId !== null &&
          confirmedClientError &&
          [RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions].includes(
            error.code as number,
          );
        return {
          ok: false,
          targetId,
          failure: permission
            ? { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_PERMISSION_MISSING" }
            : {
                failureStage: "DISCORD_READ",
                failureReasonCode: unavailable
                  ? "REQUIRED_RESOURCE_UNAVAILABLE"
                  : "REQUIRED_RESOURCE_READ_FAILED",
              },
        };
      }
    },
  };
}
