import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionFlagsBits,
  RateLimitError,
  Routes,
} from "discord.js";

import type { Client, Guild, ThreadChannel } from "discord.js";

import type { AutoCloseDiscord } from "./automatic-close-configuration.js";
import type { AutomaticCloseThreadMaintenanceDiscord } from "./automatic-close-thread-maintenance.js";
import type {
  SupportedThreadType,
  ThreadFailureDisposition,
  ThreadLifecycleDiscord,
  ThreadSnapshot,
} from "./thread-lifecycle.js";

const supportedTypes = new Set<ChannelType>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

export function classifyThreadDiscordMutationFailure(error: unknown): ThreadFailureDisposition {
  if (error instanceof RateLimitError) {
    return "RETRYABLE";
  }
  if (error instanceof DiscordAPIError || error instanceof HTTPError) {
    if (
      error.status === 408 ||
      error.status === 425 ||
      error.status === 429 ||
      error.status >= 500
    ) {
      return "RETRYABLE";
    }
    if (error.status >= 400 && error.status < 500) {
      return "PERMANENT";
    }
  }
  return "RETRYABLE";
}

export function isSupportedThreadType(type: ChannelType): type is SupportedThreadType {
  return supportedTypes.has(type);
}

/**
 * Reads the guild's currently active threads for automatic-close parent enrollment.
 *
 * `GuildManager#fetch` resolves from the client cache when the guild is already known, and the
 * guild-level active-thread route returns every visible thread in one request, so this performs no
 * per-thread REST call.
 */
export function createAutoCloseDiscord(client: Client): AutoCloseDiscord {
  return {
    async fetchActiveThreadSummaries(guildId) {
      const guild = await client.guilds.fetch(guildId);
      const { threads } = await guild.channels.fetchActiveThreads();
      return [...threads.values()].map((thread) => ({
        threadId: thread.id,
        parentId: thread.parentId,
        type: thread.type,
      }));
    },
  };
}

/** Inspects one current thread and the invoking member for automatic-close maintenance. */
export function createAutomaticCloseThreadMaintenanceDiscord(
  client: Client,
): AutomaticCloseThreadMaintenanceDiscord {
  return {
    async inspectThread(guildId, threadId, actorId) {
      const channel = await client.channels.fetch(threadId, { force: true });
      if (
        channel === null ||
        !channel.isThread() ||
        !isSupportedThreadType(channel.type) ||
        channel.guildId !== guildId ||
        channel.parentId === null
      ) {
        return undefined;
      }

      const member = await channel.guild.members.fetch({ user: actorId, force: true });
      return {
        parentChannelId: channel.parentId,
        actorCanManage: channel.permissionsFor(member).has(PermissionFlagsBits.ManageThreads),
      };
    },
  };
}

export function createThreadLifecycleDiscord(client: Client): ThreadLifecycleDiscord {
  async function fetchGuild(guildId: string): Promise<Guild> {
    return client.guilds.fetch(guildId);
  }

  async function fetchChannel(
    guildId: string,
    threadId: string,
  ): Promise<ThreadChannel | undefined> {
    const guild = await fetchGuild(guildId);
    const channel = await guild.channels.fetch(threadId, { force: true });
    if (channel === null || !channel.isThread() || !isSupportedThreadType(channel.type)) {
      return undefined;
    }
    return channel;
  }

  async function fetchRequiredThread(guildId: string, threadId: string): Promise<ThreadChannel> {
    const thread = await fetchChannel(guildId, threadId);
    if (thread === undefined) {
      throw new Error("Supported thread could not be fetched");
    }
    return thread;
  }

  async function hasRequiredPermissions(
    guildId: string,
    threadId: string,
    memberId: string,
  ): Promise<boolean> {
    const thread = await fetchRequiredThread(guildId, threadId);
    return memberHasRequiredPermissions(thread, memberId);
  }

  async function memberHasRequiredPermissions(
    thread: ThreadChannel,
    memberId: string,
  ): Promise<boolean> {
    const member = await thread.guild.members.fetch(memberId);
    const permissions = thread.permissionsFor(member);
    return permissions.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageThreads]);
  }

  return {
    async fetchThread(guildId, threadId): Promise<ThreadSnapshot | undefined> {
      const thread = await fetchChannel(guildId, threadId);
      if (thread === undefined) {
        return undefined;
      }
      return {
        guildId: thread.guildId,
        threadId: thread.id,
        type: thread.type,
        name: thread.name,
        archived: thread.archived ?? false,
        locked: thread.locked ?? false,
      };
    },
    actorCanManage: hasRequiredPermissions,
    async botCanManage(guildId, threadId) {
      if (client.user === null) {
        return false;
      }
      return hasRequiredPermissions(guildId, threadId, client.user.id);
    },
    async renameThread(_guildId, threadId, name) {
      await client.rest.patch(Routes.channel(threadId), {
        body: { name },
        reason: "WEFT thread lifecycle update",
      });
    },
    async archiveThread(_guildId, threadId, name) {
      await client.rest.patch(Routes.channel(threadId), {
        body: { name, archived: true },
        reason: "WEFT soft close",
      });
    },
    classifyMutationFailure: classifyThreadDiscordMutationFailure,
  };
}
