import { ChannelType, PermissionFlagsBits } from "discord.js";

import type { Client, Guild, ThreadChannel } from "discord.js";

import type {
  SupportedThreadType,
  ThreadLifecycleDiscord,
  ThreadSnapshot,
} from "./thread-lifecycle.js";
import { BotThreadPermissionError } from "./thread-lifecycle.js";

const supportedTypes = new Set<ChannelType>([
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
]);

export function isSupportedThreadType(type: ChannelType): type is SupportedThreadType {
  return supportedTypes.has(type);
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
    async renameThread(guildId, threadId, name) {
      const thread = await fetchRequiredThread(guildId, threadId);
      if (client.user === null || !(await memberHasRequiredPermissions(thread, client.user.id))) {
        throw new BotThreadPermissionError();
      }
      await thread.setName(name, "WEFT thread lifecycle update");
    },
    async archiveThread(guildId, threadId) {
      const thread = await fetchRequiredThread(guildId, threadId);
      if (client.user === null || !(await memberHasRequiredPermissions(thread, client.user.id))) {
        throw new BotThreadPermissionError();
      }
      await thread.setArchived(true, "WEFT soft close");
    },
  };
}
