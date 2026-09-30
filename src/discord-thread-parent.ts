import type { ThreadChannel } from "discord.js";

/** Refresh the cached parent used by discord.js thread permission calculations. */
export async function refreshThreadParent(thread: ThreadChannel): Promise<boolean> {
  if (thread.parentId === null) return false;
  const parent = await thread.guild.channels.fetch(thread.parentId, { force: true });
  return parent !== null && thread.parent === parent;
}
