import { ChannelType as C, PermissionFlagsBits as P } from "discord.js";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createBulkCloseDiscord } from "../../src/bulk-thread-close-discord.js";

const allowed = (P.ViewChannel | P.ManageThreads).toString();
function fixture() {
  const target = {
    id: "10",
    guild_id: "1",
    parent_id: "2",
    type: C.PublicThread,
    name: "Protected thread",
    owner_id: "9",
    thread_metadata: { archived: false, locked: false, create_timestamp: "2026-10-01T00:00:00Z" },
  };
  const parent = {
    id: "2",
    guild_id: "1",
    type: C.GuildText,
    name: "Protected parent",
    permission_overwrites: [],
  };
  const data = new Map<string, unknown>([
    ["/channels/2", parent],
    ["/channels/10", target],
    ["/guilds/1", { id: "1", owner_id: "7" }],
    ["/guilds/1/roles", [{ id: "1", permissions: allowed }]],
    ["/guilds/1/members/9", { user: { id: "9" }, roles: [] }],
    ["/guilds/1/members/8", { user: { id: "8" }, roles: [] }],
    ["/guilds/1/threads/active", { threads: [target] }],
  ]);
  const get = vi.fn((route: string) => Promise.resolve(data.get(route)));
  const mutation = vi.fn();
  const client = {
    user: { id: "8" },
    rest: { get, patch: mutation, post: mutation, put: mutation, delete: mutation },
    guilds: { cache: new Map() },
    channels: { cache: new Map() },
  } as unknown as Client;
  return { data, target, parent, get, mutation, discord: createBulkCloseDiscord(client) };
}

describe("fresh bulk Discord evidence", () => {
  it.each([C.GuildText, C.GuildAnnouncement, C.GuildForum])(
    "uses current active guild REST enumeration for parent %s without discovery mutations",
    async (type) => {
      const f = fixture();
      f.parent.type = type;
      f.target.type = type === C.GuildAnnouncement ? C.AnnouncementThread : C.PublicThread;
      const result = await f.discord.discover("1", "2", "9");
      expect(result?.threads).toMatchObject([
        { threadId: "10", ownerId: "9", createdTimestamp: Date.parse("2026-10-01T00:00:00Z") },
      ]);
      expect(f.get).toHaveBeenCalledWith("/guilds/1/threads/active");
      expect(f.mutation).not.toHaveBeenCalled();
      expect(
        f.get.mock.calls.map(([route]) => route).some((route) => route.includes("thread-members")),
      ).toBe(false);
    },
  );
  it.each([undefined, null, "invalid", "2026-99-99T00:00:00Z"])(
    "creation timestamp %s has no snowflake/archive/DB fallback",
    async (timestamp) => {
      const f = fixture();
      f.data.set("/channels/10", {
        ...f.target,
        thread_metadata: {
          archived: false,
          locked: false,
          create_timestamp: timestamp,
          archive_timestamp: "2026-01-01T00:00:00Z",
        },
      });
      const result = await f.discord.observe("1", "2", "9", ["10"]);
      expect(result?.threads[0]?.createdTimestamp).toBeNull();
    },
  );
  it("excludes private identities before returning any observation", async () => {
    const f = fixture();
    f.target.type = C.PrivateThread;
    expect((await f.discord.discover("1", "2", "9"))?.threads).toEqual([]);
    expect((await f.discord.observe("1", "2", "9", ["10"]))?.threads).toEqual([]);
  });
  it("fresh role changes revoke actor management even though caches and bot access remain", async () => {
    const f = fixture();
    f.data.set("/guilds/1/roles", [
      { id: "1", permissions: P.ViewChannel.toString() },
      { id: "6", permissions: P.ManageThreads.toString() },
    ]);
    f.data.set("/guilds/1/members/9", { user: { id: "9" }, roles: ["6"] });
    f.data.set("/guilds/1/members/8", { user: { id: "8" }, roles: ["6"] });
    expect(await f.discord.observe("1", "2", "9", ["10"])).toBeDefined();
    f.data.set("/guilds/1/roles", [
      { id: "1", permissions: P.ViewChannel.toString() },
      { id: "6", permissions: "0" },
      { id: "5", permissions: allowed },
    ]);
    f.data.set("/guilds/1/members/8", { user: { id: "8" }, roles: ["5"] });
    expect(await f.discord.observe("1", "2", "9", ["10"])).toBeUndefined();
    expect(f.get.mock.calls.filter(([route]) => route === "/guilds/1/roles")).toHaveLength(2);
  });
  it("fresh guild owner change revokes an owner-only actor grant", async () => {
    const f = fixture();
    f.data.set("/guilds/1/roles", [
      { id: "1", permissions: "0" },
      { id: "5", permissions: allowed },
    ]);
    f.data.set("/guilds/1/members/8", { user: { id: "8" }, roles: ["5"] });
    f.data.set("/guilds/1", { id: "1", owner_id: "9" });
    expect(await f.discord.observe("1", "2", "9", [])).toBeDefined();
    f.data.set("/guilds/1", { id: "1", owner_id: "7" });
    expect(await f.discord.observe("1", "2", "9", [])).toBeUndefined();
  });
  it.each([
    "/guilds/1",
    "/guilds/1/roles",
    "/guilds/1/members/9",
    "/guilds/1/members/8",
    "/channels/2",
  ])("missing or malformed %s evidence fails closed", async (route) => {
    const f = fixture();
    f.data.delete(route);
    expect(await f.discord.discover("1", "2", "9")).toBeUndefined();
  });
  it.each([C.GuildMedia, C.GuildVoice, C.GuildCategory])(
    "rejects unsupported parent %s",
    async (type) => {
      const f = fixture();
      f.parent.type = type;
      expect(await f.discord.discover("1", "2", "9")).toBeUndefined();
    },
  );
  it("member overwrite and timeouts fail closed despite bot permission", async () => {
    const f = fixture();
    f.data.set("/channels/2", {
      ...f.parent,
      permission_overwrites: [{ id: "9", type: 1, deny: P.ViewChannel.toString(), allow: "0" }],
    });
    expect(await f.discord.observe("1", "2", "9", ["10"])).toBeUndefined();
    f.data.set("/channels/2", f.parent);
    f.data.set("/guilds/1/members/9", {
      user: { id: "9" },
      roles: [],
      communication_disabled_until: "2099-01-01T00:00:00Z",
    });
    expect(await f.discord.observe("1", "2", "9", ["10"])).toBeUndefined();
  });
  it("waits for failed-request siblings so raw REST work stays owned", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.get.mockImplementation((route) =>
      route === "/guilds/1"
        ? Promise.reject(new Error("Failure"))
        : route === "/guilds/1/roles"
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.resolve(f.data.get(route)),
    );
    let done = false;
    const pending = f.discord.observe("1", "2", "9", ["10"]).then((value) => {
      done = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    release([]);
    expect(await pending).toBeUndefined();
  });
});

describe("authorization before active enumeration", () => {
  it("does not start enumeration when actor or Bot management fails", async () => {
    for (const id of ["9", "8"]) {
      const f = fixture();
      f.data.set("/channels/2", {
        ...f.parent,
        permission_overwrites: [{ id, type: 1, deny: P.ManageThreads.toString(), allow: "0" }],
      });
      expect(await f.discord.discover("1", "2", "9")).toBeUndefined();
      expect(f.get).not.toHaveBeenCalledWith("/guilds/1/threads/active");
      expect(f.mutation).not.toHaveBeenCalled();
    }
  });
  it("waits for every authorization response before starting enumeration", async () => {
    const f = fixture();
    let release!: (value: unknown) => void;
    f.get.mockImplementation((route) =>
      route === "/guilds/1/members/9"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(f.data.get(route)),
    );
    const discovery = f.discord.discover("1", "2", "9");
    await Promise.resolve();
    await Promise.resolve();
    expect(f.get).not.toHaveBeenCalledWith("/guilds/1/threads/active");
    release({ user: { id: "9" }, roles: [] });
    expect((await discovery)?.threads).toHaveLength(1);
    expect(f.get.mock.calls.at(-1)).toEqual(["/guilds/1/threads/active"]);
  });
  it("rejects malformed snowflakes before making REST requests", async () => {
    const f = fixture();
    expect(await f.discord.discover("1", "bad", "9")).toBeUndefined();
    expect(f.get).not.toHaveBeenCalled();
  });
  it("rejects cross-guild parent without starting enumeration", async () => {
    const f = fixture();
    f.parent.guild_id = "3";
    expect(await f.discord.discover("1", "2", "9")).toBeUndefined();
    expect(f.get).not.toHaveBeenCalledWith("/guilds/1/threads/active");
  });
});
