import { ChannelType, PermissionFlagsBits as P } from "discord.js";
import { z } from "zod";

import { isSnowflake } from "./link-preview.js";

const snowflake = z.string().refine(isSnowflake);
const bits = z
  .string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .max(30)
  .transform(BigInt);
export const previewChannelSchema = z.object({
  id: snowflake,
  guild_id: snowflake,
  type: z.enum(ChannelType),
  name: z.string().min(1),
  nsfw: z.boolean().optional(),
  parent_id: snowflake.nullable().optional(),
  permission_overwrites: z
    .array(
      z.object({
        id: snowflake,
        type: z.union([z.literal(0), z.literal(1)]),
        allow: bits,
        deny: bits,
      }),
    )
    .optional(),
  thread_metadata: z.object({ archived: z.boolean(), locked: z.boolean() }).optional(),
});
export const previewRolesSchema = z.array(z.object({ id: snowflake, permissions: bits }));
export const previewMemberSchema = z.object({
  user: z.object({ id: snowflake }),
  roles: z.array(snowflake),
  communication_disabled_until: z.string().datetime({ offset: true }).nullable().optional(),
});
export type PreviewChannel = z.infer<typeof previewChannelSchema>;
export type PreviewRoles = z.infer<typeof previewRolesSchema>;
export type PreviewMember = z.infer<typeof previewMemberSchema>;
export const READ_BITS = P.ViewChannel | P.ReadMessageHistory;
export const isPreviewThread = (type: ChannelType): boolean =>
  [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(
    type,
  );
export const isPreviewText = (type: ChannelType): boolean =>
  type === ChannelType.GuildText || type === ChannelType.GuildAnnouncement;

export function completeOverwrites(channel: PreviewChannel): boolean {
  const entries = channel.permission_overwrites;
  if (!entries) return false;
  const ids = new Set<string>();
  for (const entry of entries) {
    if (
      ids.has(entry.id) ||
      (entry.id === channel.guild_id && entry.type !== 0) ||
      (entry.allow & entry.deny) !== 0n
    )
      return false;
    ids.add(entry.id);
  }
  return true;
}
export function safePublicPermissions(channel: PreviewChannel, roles: PreviewRoles): boolean {
  if (!completeOverwrites(channel) || new Set(roles.map((role) => role.id)).size !== roles.length)
    return false;
  const everyone = roles.find((role) => role.id === channel.guild_id);
  if (!everyone) return false;
  const overwrite = channel.permission_overwrites!.find((entry) => entry.id === channel.guild_id);
  const permissions = (everyone.permissions & ~(overwrite?.deny ?? 0n)) | (overwrite?.allow ?? 0n);
  return (
    (permissions & READ_BITS) === READ_BITS &&
    channel.permission_overwrites!.every(
      (entry) => entry.id === channel.guild_id || (entry.deny & READ_BITS) === 0n,
    )
  );
}
export function memberPermissions(
  channel: PreviewChannel,
  roles: PreviewRoles,
  member: PreviewMember,
  ownerId: string,
  now: number,
): bigint | undefined {
  if (!completeOverwrites(channel) || new Set(roles.map((role) => role.id)).size !== roles.length)
    return;
  const everyone = roles.find((role) => role.id === channel.guild_id);
  if (!everyone || member.roles.some((id) => !roles.some((role) => role.id === id))) return;
  let permissions = roles
    .filter((role) => role.id === channel.guild_id || member.roles.includes(role.id))
    .reduce((value, role) => value | role.permissions, 0n);
  if (member.user.id === ownerId || (permissions & P.Administrator) !== 0n) return ~0n;
  const entries = channel.permission_overwrites!;
  const base = entries.find((entry) => entry.id === channel.guild_id);
  permissions = (permissions & ~(base?.deny ?? 0n)) | (base?.allow ?? 0n);
  let allow = 0n;
  let deny = 0n;
  for (const entry of entries) {
    if (entry.type === 0 && entry.id !== channel.guild_id && member.roles.includes(entry.id)) {
      allow |= entry.allow;
      deny |= entry.deny;
    }
  }
  permissions = (permissions & ~deny) | allow;
  const personal = entries.find((entry) => entry.type === 1 && entry.id === member.user.id);
  permissions = (permissions & ~(personal?.deny ?? 0n)) | (personal?.allow ?? 0n);
  // Timed-out members retain only their existing view/history permissions.
  if (member.communication_disabled_until && Date.parse(member.communication_disabled_until) > now)
    permissions &= READ_BITS;
  return permissions;
}
