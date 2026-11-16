import { ChannelType, Client, Events } from "discord.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerAutomaticCloseActivityHandlers,
  registerThreadLifecycleEventHandler,
} from "../../src/discord.js";
import {
  createThreadLifecycleService,
  type ThreadLifecycleDiscord,
  type ThreadSnapshot,
} from "../../src/threads/thread-lifecycle.js";
import { createThreadLifecycleDiscord } from "../../src/threads/thread-discord.js";
import type {
  ManagedThread,
  ManagedThreadStore,
  ThreadAuditRecord,
} from "../../src/threads/thread-persistence.js";
import { createThreadGateway, gatewayGuildId, gatewayThreadId } from "../thread-gateway-fixture.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function fixture(state: "CLOSED" | "OPEN" | "MISSING" = "CLOSED") {
  const client = new Client({ intents: [] });
  const gateway = createThreadGateway(client);
  cleanups.push(() => gateway.close());
  const thread: ThreadSnapshot = {
    guildId: gatewayGuildId,
    threadId: gatewayThreadId,
    type: ChannelType.PublicThread,
    name: "[CLOSED] Topic",
    archived: false,
    locked: false,
  };
  let managed: ManagedThread | undefined =
    state === "MISSING"
      ? undefined
      : {
          guildId: gatewayGuildId,
          threadId: gatewayThreadId,
          appliedPrefix: "[CLOSED]",
          lifecycleState: state,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
  const audits: ThreadAuditRecord[] = [];
  const managedThreads: ManagedThreadStore = {
    find: vi.fn(() => Promise.resolve(managed)),
    saveClosed: vi.fn(() => Promise.reject(new Error("Unexpected close"))),
    markOpen: vi.fn(() => {
      if (!managed) throw new Error("Missing state");
      managed = { ...managed, lifecycleState: "OPEN" };
      return Promise.resolve(managed);
    }),
  };
  const discord: ThreadLifecycleDiscord = {
    fetchThread: vi.fn(() => Promise.resolve({ ...thread })),
    botCanManage: vi.fn(() => Promise.resolve(true)),
    actorCanManage: vi.fn(() => Promise.resolve(true)),
    renameThread: vi.fn<ThreadLifecycleDiscord["renameThread"]>((_guild, _thread, name) => {
      thread.name = name;
      return Promise.resolve();
    }),
    archiveThread: vi.fn(() => Promise.reject(new Error("Unexpected archive"))),
    classifyMutationFailure: () => "RETRYABLE",
    classifyReconciliationReadFailure: () => "RETRYABLE",
  };
  const logger = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const lifecycle = createThreadLifecycleService({
    discord,
    managedThreads,
    audits: {
      record: (audit) => {
        audits.push(audit);
        return Promise.resolve();
      },
    },
    guildSettings: { getOrCreate: vi.fn() } as never,
    logger,
  });
  const autoOpen = vi.spyOn(lifecycle, "autoOpen");
  registerThreadLifecycleEventHandler(client, lifecycle, logger);
  return {
    client,
    gateway,
    lifecycle,
    autoOpen,
    thread,
    discord,
    managedThreads,
    audits,
    logger,
    get state() {
      return managed;
    },
  };
}

describe("thread unarchive through installed discord.js", () => {
  it.each([false, true])(
    "reconciles CLOSED with warm cache %s through one lifecycle invocation",
    async (warm) => {
      const f = fixture();
      if (warm) f.gateway.cache(true);
      const observations: Array<boolean | undefined | null> = [];
      f.client.on(Events.Raw, () => {
        const cached = f.client.channels.cache.get(gatewayThreadId);
        observations.push(cached?.isThread() ? cached.archived : undefined);
      });
      const highLevel = vi.fn();
      f.client.on(Events.ThreadUpdate, highLevel);
      f.gateway.dispatch();
      expect(observations).toEqual([warm ? true : undefined]);
      expect(f.client.channels.cache.get(gatewayThreadId)).toMatchObject({ archived: false });
      expect(highLevel).toHaveBeenCalledTimes(warm ? 1 : 0);
      await f.lifecycle.drain();
      expect(f.autoOpen).toHaveBeenCalledOnce();
      expect(f.thread.name).toBe("Topic");
      expect(f.state?.lifecycleState).toBe("OPEN");
      expect(f.audits).toEqual([
        expect.objectContaining({ action: "AUTO_OPEN", actorType: "SYSTEM", outcome: "SUCCESS" }),
      ]);
      // A repeated active dispatch must not enter lifecycle or add another audit.
      f.gateway.dispatch();
      await f.lifecycle.drain();
      expect(f.autoOpen).toHaveBeenCalledOnce();
      expect(f.discord.renameThread).toHaveBeenCalledOnce();
      expect(f.audits).toHaveLength(1);
    },
  );

  it.each([
    ChannelType.PublicThread,
    ChannelType.PrivateThread,
    ChannelType.AnnouncementThread,
  ] as const)(
    "supports raw thread type %s, including forum posts represented as public threads",
    async (type) => {
      const f = fixture();
      f.gateway.data.type = type;
      f.thread.type = type;
      f.gateway.dispatch();
      await f.lifecycle.drain();
      expect(f.state?.lifecycleState).toBe("OPEN");
    },
  );

  it.each([
    "locked",
    "archived",
    "unsupported",
    "guild mismatch",
    "cached non-thread",
    "missing metadata",
    "missing locked",
    "bad identity",
    "non-dispatch",
  ])("rejects %s raw input before lifecycle admission", async (reason) => {
    const f = fixture();
    const data = { ...f.gateway.data, thread_metadata: { ...f.gateway.data.thread_metadata } };
    const packet: { t: string; d: Record<string, unknown> } = { t: "THREAD_UPDATE", d: data };
    if (reason === "locked") data.thread_metadata.locked = true;
    if (reason === "archived") data.thread_metadata.archived = true;
    if (reason === "unsupported") data.type = ChannelType.GuildText;
    if (reason === "guild mismatch") {
      f.gateway.cache(true);
      data.guild_id = "900000000000000001";
    }
    if (reason === "cached non-thread")
      f.client.channels.cache.set(gatewayThreadId, { isThread: () => false } as never);
    if (reason === "missing metadata") delete packet.d.thread_metadata;
    if (reason === "missing locked") packet.d.thread_metadata = { archived: false };
    if (reason === "bad identity") packet.d.guild_id = 123;
    if (reason === "non-dispatch") packet.t = "MESSAGE_CREATE";
    // Malformed packets test the listener without asking discord.js to construct invalid objects.
    f.client.emit(Events.Raw, packet);
    await f.lifecycle.drain();
    expect(f.autoOpen).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  });

  it("records a locked re-entry independently of automatic opening", async () => {
    const f = fixture();
    f.gateway.cache(true);
    const reentry = vi.fn(() => Promise.resolve());
    registerAutomaticCloseActivityHandlers(f.client, {
      activity: {
        recordMessageActivity: vi.fn(),
        initializeThreadBaseline: vi.fn(),
        recordThreadReentryBaseline: reentry,
      },
      logger: f.logger,
    });
    f.gateway.data.thread_metadata.locked = true;
    f.gateway.dispatch();
    await f.lifecycle.drain();
    expect(f.autoOpen).not.toHaveBeenCalled();
    expect(reentry).toHaveBeenCalledOnce();
  });

  it("keeps manual open available for an active thread without an observed unarchive", async () => {
    const f = fixture();
    await expect(f.lifecycle.open(gatewayGuildId, gatewayThreadId, "actor")).resolves.toEqual({
      ok: true,
      changed: true,
    });
    expect(f.thread.name).toBe("Topic");
    expect(f.audits).toEqual([expect.objectContaining({ action: "OPEN", actorType: "USER" })]);
  });

  it("ignores a cached active-to-active update", async () => {
    const f = fixture();
    f.gateway.cache(false);
    f.gateway.dispatch();
    await f.lifecycle.drain();
    expect(f.autoOpen).not.toHaveBeenCalled();
    expect(f.audits).toEqual([]);
  });

  it.each(["OPEN", "MISSING"] as const)(
    "does not recover unknown previous state with managed state %s",
    async (state) => {
      const f = fixture(state);
      f.gateway.dispatch();
      await f.lifecycle.drain();
      expect(f.discord.renameThread).not.toHaveBeenCalled();
      expect(f.managedThreads.markOpen).not.toHaveBeenCalled();
      expect(f.audits).toEqual([]);
    },
  );

  it("preserves confirmed unarchive reconciliation of an OPEN record", async () => {
    const f = fixture("OPEN");
    f.gateway.cache(true);
    f.gateway.dispatch();
    await f.lifecycle.drain();
    expect(f.thread.name).toBe("Topic");
    expect(f.audits).toHaveLength(1);
  });

  it("rejects a fresh REST response belonging to another guild through the real manager", async () => {
    const f = fixture();
    vi.spyOn(f.client.rest, "get").mockResolvedValue({
      ...f.gateway.data,
      guild_id: "900000000000000001",
    });
    await expect(
      createThreadLifecycleDiscord(f.client).fetchThread(gatewayGuildId, gatewayThreadId),
    ).rejects.toThrow("Thread Discord read rejected");
    expect(f.discord.renameThread).not.toHaveBeenCalled();
  });

  it("rejects a freshly fetched unsupported channel through the existing Discord boundary", async () => {
    const f = fixture();
    vi.spyOn(f.client.rest, "get").mockResolvedValue({
      ...f.gateway.data,
      type: ChannelType.GuildText,
      permission_overwrites: [],
    });
    await expect(
      createThreadLifecycleDiscord(f.client).fetchThread(gatewayGuildId, gatewayThreadId),
    ).resolves.toBeUndefined();
  });

  it.each(["activity", "lifecycle"])(
    "isolates %s rejection from the other raw listener",
    async (failure) => {
      const f = fixture();
      const reentry = vi.fn(() =>
        failure === "activity"
          ? Promise.reject(new Error("Private activity detail"))
          : Promise.resolve(),
      );
      registerAutomaticCloseActivityHandlers(f.client, {
        activity: {
          recordMessageActivity: vi.fn(),
          initializeThreadBaseline: vi.fn(),
          recordThreadReentryBaseline: reentry,
        },
        logger: f.logger,
      });
      if (failure === "lifecycle")
        f.autoOpen.mockRejectedValue(new Error("Private lifecycle detail"));
      f.gateway.dispatch();
      await f.lifecycle.drain();
      await vi.waitFor(() =>
        expect(f.logger[failure === "activity" ? "debug" : "error"]).toHaveBeenCalled(),
      );
      expect(reentry).toHaveBeenCalledOnce();
      expect(f.autoOpen).toHaveBeenCalledOnce();
      if (failure === "activity") expect(f.state?.lifecycleState).toBe("OPEN");
    },
  );
});
