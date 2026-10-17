import { randomUUID } from "node:crypto";
import { ChannelType } from "discord.js";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createConfigurationAuditContext,
  guildConfigurationAudits,
} from "../../src/guild/guild-configuration-audit.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild/guild-settings.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createAutomaticCloseExecutor } from "../../src/threads/automatic-close-execution.js";
import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
  autoCloseThreadRetirements,
  createAutomaticClosePersistenceStore,
} from "../../src/threads/automatic-close-persistence.js";
import { createScheduledThreadCloseExecutor } from "../../src/threads/scheduled-thread-close.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
} from "../../src/threads/scheduled-thread-close-persistence.js";
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

const guildId = "prefix-free-execution-guild";
const threadId = "prefix-free-execution-thread";
const parentId = "prefix-free-execution-parent";
const database = createDatabase(loadTestDatabaseConfig());
const settings = createGuildSettingsStore(database.client);
const actions = createScheduledActionStore(database.client);
const schedules = createScheduledThreadCloseStore(database.client);
const policy = createAutomaticClosePersistenceStore(database.client);
const managed = createManagedThreadStore(database.client);
const at = new Date("2035-01-01T00:00:00Z");
const audit = () => createConfigurationAuditContext("actor", at);

async function cleanup() {
  for (const table of [
    threadAudits,
    managedThreads,
    scheduledThreadCloseAudits,
    scheduledActions,
    guildConfigurationAudits,
    autoCloseThreadRetirements,
    autoCloseThreadActivity,
    autoCloseThreadExclusions,
    autoCloseParentChannels,
    guildSettings,
  ])
    await database.client.delete(table).where(eq(table.guildId, guildId));
}
beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await database.close();
});

function fixture() {
  const thread: ThreadSnapshot = {
    guildId,
    threadId,
    type: ChannelType.PublicThread,
    name: "  Topic 😀",
    archived: false,
    locked: false,
  };
  const discord: ThreadLifecycleDiscord = {
    fetchThread: vi.fn(() => Promise.resolve({ ...thread })),
    actorCanManage: vi.fn(() => Promise.resolve(true)),
    botCanManage: vi.fn(() => Promise.resolve(true)),
    archiveThread: vi.fn<ThreadLifecycleDiscord["archiveThread"]>((_guild, _thread, name) => {
      thread.name = name;
      thread.archived = true;
      return Promise.resolve();
    }),
    renameThread: vi.fn<ThreadLifecycleDiscord["renameThread"]>((_guild, _thread, name) => {
      thread.name = name;
      return Promise.resolve();
    }),
    classifyMutationFailure: () => "RETRYABLE",
    classifyReconciliationReadFailure: () => "RETRYABLE",
  };
  const lifecycle = createThreadLifecycleService({
    discord,
    guildSettings: settings,
    managedThreads: managed,
    audits: createThreadAuditStore(database.client),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  return { thread, discord, lifecycle };
}

// The maintainer runs these against PostgreSQL. Only Discord is replaced; executors and lifecycle are real.
describe("prefix-free background execution through the shared lifecycle", () => {
  it("automatically closes an eligible episode, retires it and automatically reopens without renaming", async () => {
    await settings.disableClosedPrefix(guildId, audit());
    await settings.setAutoCloseInactivitySeconds(guildId, 300, audit());
    await policy.enableParentChannelWithBaselines({
      guildId,
      parentChannelId: parentId,
      activeThreadIds: [threadId],
      enabledAt: at,
      ...audit(),
    });
    const f = fixture();
    const executor = createAutomaticCloseExecutor({
      discord: {
        inspectThread: () =>
          Promise.resolve({
            outcome: "AVAILABLE",
            archived: f.thread.archived,
            parentChannelId: parentId,
          }),
      },
      persistence: policy,
      scheduledActions: actions,
      threadLifecycle: f.lifecycle,
      now: () => new Date(at.getTime() + 300_000),
    });
    const candidate = { guildId, threadId, parentChannelId: parentId, lastActivityAt: at };
    try {
      expect(await executor.execute(candidate)).toEqual({ outcome: "SUCCESS", changed: true });
      expect(f.thread).toMatchObject({ name: "  Topic 😀", archived: true, locked: false });
      expect(await managed.find(guildId, threadId)).toMatchObject({
        lifecycleState: "CLOSED",
        appliedPrefix: "",
      });
      expect(
        await policy.isCandidateEpisodeEligible({
          ...candidate,
          revalidatedAt: new Date(at.getTime() + 300_000),
        }),
      ).toBe(false);
      f.thread.archived = false;
      await settings.setClosedPrefix(guildId, "[DONE]", audit());
      expect(await f.lifecycle.autoOpen(guildId, threadId)).toEqual({ ok: true, changed: true });
      expect(await managed.find(guildId, threadId)).toMatchObject({
        lifecycleState: "OPEN",
        appliedPrefix: "",
      });
      expect(f.discord.renameThread).not.toHaveBeenCalled();
      const rows = await database.client
        .select()
        .from(threadAudits)
        .where(eq(threadAudits.guildId, guildId));
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "AUTO_CLOSE",
            actorType: "SYSTEM",
            outcome: "SUCCESS",
          }),
          expect.objectContaining({ action: "AUTO_OPEN", actorType: "SYSTEM", outcome: "SUCCESS" }),
        ]),
      );
    } finally {
      await f.lifecycle.drain();
    }
  });

  it("executes a scheduled prefix-free close with consistent managed and execution audits", async () => {
    await settings.disableClosedPrefix(guildId, audit());
    const created = await schedules.createOrReplace({
      guildId,
      threadId,
      actorId: "actor",
      scheduledActionId: randomUUID(),
      auditId: randomUUID(),
      executeAt: at,
    });
    if (created.outcome !== "CREATED") throw new Error("Schedule was not created");
    const f = fixture();
    const executor = createScheduledThreadCloseExecutor({
      scheduledActions: actions,
      schedules,
      threadLifecycle: f.lifecycle,
    });
    const ids = { attemptAuditId: randomUUID(), executionAuditId: randomUUID() };
    try {
      expect(await executor.execute(created.action, ids)).toMatchObject({
        outcome: "SUCCESS",
        action: { status: "COMPLETED" },
      });
      expect(await actions.findById(created.action.id)).toMatchObject({ status: "COMPLETED" });
      expect(await managed.find(guildId, threadId)).toMatchObject({
        lifecycleState: "CLOSED",
        appliedPrefix: "",
      });
      expect(f.thread).toMatchObject({ name: "  Topic 😀", archived: true, locked: false });
      expect(f.discord.archiveThread).toHaveBeenCalledOnce();
      expect(await schedules.findAuditById(ids.executionAuditId)).toMatchObject({
        event: "EXECUTION_COMPLETED",
        outcome: "SUCCESS",
      });
      expect(
        await database.client.select().from(threadAudits).where(eq(threadAudits.guildId, guildId)),
      ).toEqual([
        expect.objectContaining({
          id: ids.attemptAuditId,
          action: "CLOSE",
          actorType: "SYSTEM",
          outcome: "SUCCESS",
        }),
      ]);
      expect(
        await executor.execute(created.action, {
          attemptAuditId: randomUUID(),
          executionAuditId: randomUUID(),
        }),
      ).toMatchObject({ outcome: "SKIPPED", reason: "NOT_ACTIVE" });
      expect(f.discord.archiveThread).toHaveBeenCalledOnce();
    } finally {
      await f.lifecycle.drain();
    }
  });
});
