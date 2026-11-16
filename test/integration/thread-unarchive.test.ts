import { Client, ChannelType } from "discord.js";
import { and, eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { registerThreadLifecycleEventHandler } from "../../src/discord.js";
import { createGuildSettingsStore } from "../../src/guild/guild-settings.js";
import {
  createThreadLifecycleService,
  type ThreadLifecycleDiscord,
  type ThreadSnapshot,
} from "../../src/threads/thread-lifecycle.js";
import {
  createManagedThreadStore,
  createThreadAuditStore,
  managedThreads,
  threadAudits,
} from "../../src/threads/thread-persistence.js";
import { createThreadGateway, gatewayGuildId, gatewayThreadId } from "../thread-gateway-fixture.js";

const database = createDatabase(loadTestDatabaseConfig());
const managed = createManagedThreadStore(database.client);
const auditStore = createThreadAuditStore(database.client);
const cleanups: Array<() => Promise<void>> = [];
const target = and(
  eq(threadAudits.guildId, gatewayGuildId),
  eq(threadAudits.threadId, gatewayThreadId),
);
async function cleanup() {
  await database.client.delete(threadAudits).where(target);
  await database.client
    .delete(managedThreads)
    .where(
      and(eq(managedThreads.guildId, gatewayGuildId), eq(managedThreads.threadId, gatewayThreadId)),
    );
}
beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
beforeEach(cleanup);
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});
afterAll(async () => {
  await cleanup();
  await database.close();
});

function runtime(prefix: string) {
  const client = new Client({ intents: [] });
  const gateway = createThreadGateway(client);
  cleanups.push(() => gateway.close());
  const thread: ThreadSnapshot = {
    guildId: gatewayGuildId,
    threadId: gatewayThreadId,
    type: ChannelType.PublicThread,
    name: prefix === "" ? "  Edited 😀" : `${prefix} Edited 😀`,
    archived: false,
    locked: false,
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
  const lifecycle = createThreadLifecycleService({
    discord,
    managedThreads: managed,
    audits: auditStore,
    guildSettings: createGuildSettingsStore(database.client),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const autoOpen = vi.spyOn(lifecycle, "autoOpen");
  registerThreadLifecycleEventHandler(client, lifecycle, { error: vi.fn() });
  return { gateway, lifecycle, autoOpen, discord, thread };
}

describe("unarchive recovery with PostgreSQL management and audits", () => {
  it.each([
    [false, "[OLD]"],
    [false, ""],
    [true, "[OLD]"],
    [true, ""],
  ] as const)("recovers saved CLOSED in a new runtime, warm=%s prefix=%j", async (warm, prefix) => {
    // The management record predates this runtime. It is not proof of an archive-success audit.
    await managed.saveClosed(gatewayGuildId, gatewayThreadId, prefix);
    const f = runtime(prefix);
    if (warm) f.gateway.cache(true);
    f.gateway.dispatch();
    await f.lifecycle.drain();
    expect(await managed.find(gatewayGuildId, gatewayThreadId)).toMatchObject({
      lifecycleState: "OPEN",
      appliedPrefix: prefix,
    });
    expect(f.thread.name).toBe(prefix === "" ? "  Edited 😀" : "Edited 😀");
    expect(await database.client.select().from(threadAudits).where(target)).toEqual([
      expect.objectContaining({
        action: "AUTO_OPEN",
        actorType: "SYSTEM",
        actorId: null,
        outcome: "SUCCESS",
      }),
    ]);
    f.gateway.dispatch();
    await f.lifecycle.drain();
    expect(f.autoOpen).toHaveBeenCalledOnce();
    expect(await database.client.select().from(threadAudits).where(target)).toHaveLength(1);
  });

  it.each(["OPEN", "MISSING"])(
    "does not change an unknown candidate with %s management",
    async (state) => {
      if (state === "OPEN") {
        await managed.saveClosed(gatewayGuildId, gatewayThreadId, "[OLD]");
        await managed.markOpen(gatewayGuildId, gatewayThreadId);
      }
      const before = await managed.find(gatewayGuildId, gatewayThreadId);
      const f = runtime("[OLD]");
      f.gateway.dispatch();
      await f.lifecycle.drain();
      expect(await managed.find(gatewayGuildId, gatewayThreadId)).toEqual(before);
      expect(f.discord.renameThread).not.toHaveBeenCalled();
      expect(await database.client.select().from(threadAudits).where(target)).toEqual([]);
    },
  );

  it("retains manual open and exact audit-ID idempotency", async () => {
    await managed.saveClosed(gatewayGuildId, gatewayThreadId, "[OLD]");
    const f = runtime("[OLD]");
    expect(await f.lifecycle.open(gatewayGuildId, gatewayThreadId, "test-actor")).toEqual({
      ok: true,
      changed: true,
    });
    const [row] = await database.client.select().from(threadAudits).where(target);
    expect(row).toMatchObject({ action: "OPEN", actorType: "USER", actorId: "test-actor" });
    if (!row) throw new Error("Expected persisted audit");
    await auditStore.record({
      id: row.id,
      guildId: gatewayGuildId,
      threadId: gatewayThreadId,
      action: "OPEN",
      actorType: "USER",
      actorId: "test-actor",
      outcome: "SUCCESS",
    });
    expect(await database.client.select().from(threadAudits).where(target)).toHaveLength(1);
    expect(await managed.find(gatewayGuildId, gatewayThreadId)).toMatchObject({
      lifecycleState: "OPEN",
      appliedPrefix: "[OLD]",
    });
  });
});
