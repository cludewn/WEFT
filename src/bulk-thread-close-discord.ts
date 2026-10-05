import { ChannelType, PermissionFlagsBits as P, Routes } from "discord.js";
import type { Client } from "discord.js";
import { z } from "zod";

import type {
  BulkCloseDiscord,
  BulkCloseObservation,
  BulkCloseParent,
  BulkCloseThread,
  BulkCloseReadContext,
  BulkCloseReadStage,
} from "./bulk-thread-close.js";
import { isBulkCloseChild, isBulkCloseParent } from "./bulk-thread-close.js";
import { isSnowflake } from "./link-preview.js";
import {
  memberPermissions,
  previewChannelSchema,
  previewMemberSchema,
  previewRolesSchema,
} from "./link-preview-permissions.js";

const guildSchema = z.object({
  id: z.string().refine(isSnowflake),
  owner_id: z.string().refine(isSnowflake),
});
const threadSchema = previewChannelSchema.extend({
  owner_id: z.string().refine(isSnowflake).nullable().optional(),
  thread_metadata: z.object({
    archived: z.boolean(),
    locked: z.boolean(),
    create_timestamp: z.unknown().optional(),
  }),
});
const activeSchema = z.object({ threads: z.array(z.unknown()) });
const REQUIRED = P.ViewChannel | P.ManageThreads;

/** Raw REST observations avoid cached guild owner, role definitions and thread timestamp fallbacks. */
export function createBulkCloseDiscord(client: Client): BulkCloseDiscord {
  const get = (
    route: Parameters<Client["rest"]["get"]>[0],
    stage: BulkCloseReadStage,
    context?: BulkCloseReadContext,
  ) => {
    if (context?.signal.aborted)
      return Promise.reject(new Error("Bulk preview observation stopped"));
    return context ? context.read(stage, () => client.rest.get(route)) : client.rest.get(route);
  };
  async function parentAccess(
    guildId: string,
    parentId: string,
    actorId: string,
    context?: BulkCloseReadContext,
  ): Promise<BulkCloseParent | undefined> {
    const botId = client.user?.id;
    if (!botId || ![guildId, parentId, actorId, botId].every(isSnowflake)) return;
    const ids = [...new Set([actorId, botId])];
    const results = await Promise.allSettled([
      get(Routes.channel(parentId), "parent_fetch", context),
      get(Routes.guild(guildId), "guild_fetch", context),
      get(Routes.guildRoles(guildId), "roles_fetch", context),
      ...ids.map((id) =>
        get(
          Routes.guildMember(guildId, id),
          id === actorId ? "actor_member_fetch" : "bot_member_fetch",
          context,
        ),
      ),
    ]);
    if (results.some((result) => result.status === "rejected")) return;
    const raw = results.map((result) => (result.status === "fulfilled" ? result.value : undefined));
    try {
      const parent = previewChannelSchema.parse(raw[0]);
      const guild = guildSchema.parse(raw[1]);
      const roles = previewRolesSchema.parse(raw[2]);
      if (
        parent.id !== parentId ||
        parent.guild_id !== guildId ||
        guild.id !== guildId ||
        !isBulkCloseParent(parent.type)
      )
        return;
      for (let index = 0; index < ids.length; index++) {
        const member = previewMemberSchema.parse(raw[index + 3]);
        if (member.user.id !== ids[index]) return;
        const bits = memberPermissions(parent, roles, member, guild.owner_id, Date.now());
        if (bits === undefined || (bits & REQUIRED) !== REQUIRED) return;
      }
      return { id: parent.id, guildId: parent.guild_id, type: parent.type, name: parent.name };
    } catch {
      return;
    }
  }
  function thread(raw: unknown, parent: BulkCloseParent): BulkCloseThread | undefined {
    const parsed = threadSchema.safeParse(raw);
    if (!parsed.success) return;
    const channel = parsed.data;
    // Private IDs/names never leave this boundary, even if the guild active route returns them.
    if (
      channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.AnnouncementThread
    )
      return;
    const timestamp = channel.thread_metadata.create_timestamp;
    const createdTimestamp =
      typeof timestamp === "string" && z.iso.datetime({ offset: true }).safeParse(timestamp).success
        ? Date.parse(timestamp)
        : null;
    const result: BulkCloseThread = {
      guildId: channel.guild_id,
      threadId: channel.id,
      type: channel.type,
      name: channel.name,
      archived: channel.thread_metadata.archived,
      locked: channel.thread_metadata.locked,
      parentId: channel.parent_id ?? null,
      ownerId: channel.owner_id ?? null,
      createdTimestamp,
    };
    return isBulkCloseChild(parent, result) ? result : undefined;
  }
  // Thread permissions inherit the direct parent's overwrites. Bulk public/announcement targets
  // require ViewChannel + ManageThreads for both members, without a membership or send requirement.
  async function observe(
    guildId: string,
    parentId: string,
    actorId: string,
    ids: readonly string[],
    context?: BulkCloseReadContext,
  ): Promise<BulkCloseObservation | undefined> {
    if (!ids.every(isSnowflake)) return;
    const results = await Promise.allSettled([
      parentAccess(guildId, parentId, actorId, context),
      ...ids.map((id) => get(Routes.channel(id), "candidate_fetch", context)),
    ]);
    const access = results[0];
    if (access?.status !== "fulfilled" || !access.value) return;
    const parent = access.value;
    const threads: BulkCloseThread[] = [];
    for (let index = 0; index < ids.length; index++) {
      const result = results[index + 1];
      if (result?.status !== "fulfilled") continue;
      const value = thread(result.value, parent);
      if (value && value.threadId === ids[index]) threads.push(value);
    }
    return { parent, threads };
  }
  return {
    async discover(guildId, parentId, actorId, context) {
      // Equivalent to GuildChannelManager.fetchActiveThreads, using its raw active-guild REST route.
      // Parse fresh create_timestamp directly so a cached ThreadChannel cannot preserve an old value.
      const parent = await parentAccess(guildId, parentId, actorId, context);
      if (!parent || context?.signal.aborted) return;
      let active: unknown;
      try {
        active = await get(Routes.guildActiveThreads(guildId), "active_enumeration", context);
      } catch {
        return;
      }
      const parsed = activeSchema.safeParse(active);
      if (!parsed.success) return;
      return {
        parent,
        threads: parsed.data.threads.flatMap((raw) => {
          const value = thread(raw, parent);
          return value ? [value] : [];
        }),
      };
    },
    observe,
  };
}
