import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";
import { ChannelType, type Client, type Guild } from "discord.js";

const require = createRequire(import.meta.url);
const discordRequire = createRequire(require.resolve("discord.js"));
const { WebSocketShardEvents } = discordRequire("@discordjs/ws") as {
  WebSocketShardEvents: { Dispatch: string };
};
const Status = require(
  path.join(path.dirname(require.resolve("discord.js")), "util/Status.js"),
) as { Ready: number };

export const gatewayGuildId = "100000000000000001";
export const gatewayThreadId = "200000000000000001";
export const gatewayParentId = "300000000000000001";

/** Exercises installed discord.js dispatch/cache/event code without opening a socket. */
export function createThreadGateway(client: Client) {
  const guilds = client.guilds as unknown as { _add: (data: unknown) => Guild };
  guilds._add({
    id: gatewayGuildId,
    name: "Test guild",
    unavailable: false,
    roles: [],
    channels: [],
    threads: [],
    members: [],
  });
  const channels = client.channels as unknown as { _add: (data: unknown) => unknown };
  const manager = client.ws as unknown as {
    _ws: EventEmitter | null;
    status: number;
    shards: Map<number, { status: number }>;
    attachEvents: () => void;
  };
  const socket = new EventEmitter();
  manager._ws = socket;
  manager.status = Status.Ready;
  manager.shards.set(0, { status: Status.Ready });
  manager.attachEvents();
  const data = {
    id: gatewayThreadId,
    guild_id: gatewayGuildId,
    parent_id: gatewayParentId,
    type: ChannelType.PublicThread,
    name: "[CLOSED] Topic",
    owner_id: "400000000000000001",
    message_count: 0,
    member_count: 1,
    thread_metadata: {
      archived: false,
      locked: false,
      auto_archive_duration: 1_440,
      archive_timestamp: "2030-01-01T00:00:00.000Z",
    },
  };
  let sequence = 0;
  return {
    data,
    cache(archived: boolean) {
      channels._add({ ...data, thread_metadata: { ...data.thread_metadata, archived } });
    },
    dispatch(update = data) {
      socket.emit(WebSocketShardEvents.Dispatch, {
        data: { op: 0, t: "THREAD_UPDATE", s: ++sequence, d: update },
        shardId: 0,
      });
    },
    async close() {
      manager._ws = null;
      manager.shards.clear();
      await client.destroy();
    },
  };
}
