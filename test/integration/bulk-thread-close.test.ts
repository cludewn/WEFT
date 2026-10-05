import { and, eq } from "drizzle-orm";
import { ChannelType } from "discord.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createBulkCloseService } from "../../src/bulk-thread-close.js";
import type { BulkCloseThread } from "../../src/bulk-thread-close.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild-settings.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
} from "../../src/scheduled-thread-close-persistence.js";
import { createThreadLifecycleService } from "../../src/thread-lifecycle.js";
import type { ThreadLifecycleDiscord } from "../../src/thread-lifecycle.js";
import {
  createManagedThreadStore,
  createThreadAuditStore,
  managedThreads,
  threadAudits,
} from "../../src/thread-persistence.js";

const guildId = "810000000000000001";
const actorId = "810000000000000002";
const parent = {
  id: "810000000000000003",
  guildId,
  name: "Parent",
  type: ChannelType.GuildText,
};
const database = createDatabase(loadTestDatabaseConfig());
const schedules = createScheduledThreadCloseStore(database.client);
const actions = createScheduledActionStore(database.client);
const managed = createManagedThreadStore(database.client);
const audits = createThreadAuditStore(database.client);

async function cleanup() {
  await database.client.delete(threadAudits).where(eq(threadAudits.guildId, guildId));
  await database.client.delete(managedThreads).where(eq(managedThreads.guildId, guildId));
  await database.client
    .delete(scheduledThreadCloseAudits)
    .where(eq(scheduledThreadCloseAudits.guildId, guildId));
  await database.client.delete(scheduledActions).where(eq(scheduledActions.guildId, guildId));
  await database.client.delete(guildSettings).where(eq(guildSettings.guildId, guildId));
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
  const threads: BulkCloseThread[] = ["1", "2"].map((threadId) => ({
    guildId,
    threadId,
    type: ChannelType.PublicThread,
    name: "Topic",
    archived: false,
    locked: false,
    parentId: parent.id,
    ownerId: actorId,
    createdTimestamp: Date.parse("2026-01-01T00:00:00Z"),
  }));
  const discord: ThreadLifecycleDiscord = {
    fetchThread: vi.fn<ThreadLifecycleDiscord["fetchThread"]>((_g, id) =>
      Promise.resolve(threads.find((t) => t.threadId === id)),
    ),
    actorCanManage: vi.fn(() => Promise.resolve(true)),
    botCanManage: vi.fn(() => Promise.resolve(true)),
    archiveThread: vi.fn<ThreadLifecycleDiscord["archiveThread"]>((_g, id, name) => {
      const thread = threads.find((t) => t.threadId === id)!;
      thread.archived = true;
      thread.name = name;
      return Promise.resolve();
    }),
    renameThread: vi.fn(() => Promise.resolve()),
    classifyMutationFailure: () => "RETRYABLE",
    classifyReconciliationReadFailure: () => "RETRYABLE",
  };
  const lifecycle = createThreadLifecycleService({
    discord,
    guildSettings: createGuildSettingsStore(database.client),
    managedThreads: managed,
    audits,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  let cancellationId = 0;
  const manual = createScheduledThreadCloseCommandService({
    discord,
    schedules,
    threadLifecycle: lifecycle,
    delivery: {
      enqueueScheduledThreadClose: () => Promise.resolve("ENQUEUED"),
      hasCreatedOrRetryDelivery: () => Promise.resolve(false),
    },
    logger: { warn: vi.fn() },
    generateId: () => `bulk-cancel-${++cancellationId}`,
  });
  const observe = vi.fn((_g: string, _p: string, _a: string, ids: readonly string[]) =>
    Promise.resolve({
      parent,
      threads: threads.filter((t) => ids.includes(t.threadId)).map((t) => ({ ...t })),
    }),
  );
  const bulk = createBulkCloseService({
    discord: { discover: () => Promise.resolve({ parent, threads }), observe },
    manualClose: manual,
    isReady: () => true,
  });
  async function confirm() {
    const preview = await bulk.preview(guildId, parent.id, actorId, { nameContains: "Topic" });
    if (!preview.ok) throw new Error(preview.reason);
    bulk.bind(preview.session, "preview-message");
    const confirmed = await bulk.confirm(preview.session.id, {
      guildId,
      actorId,
      messageId: "preview-message",
    });
    if (!confirmed) throw new Error("Confirmation failed");
    const result = await confirmed.result;
    await lifecycle.drain();
    return result;
  }
  return { bulk, observe, threads, discord, lifecycle, confirm };
}

// This suite is executed only by the maintainer's dedicated PostgreSQL integration runner.
describe("bulk close through existing PostgreSQL manual lifecycle", () => {
  it("manages previously unmanaged targets and persists distinct user cancellation/close audits with stable IDs", async () => {
    await schedules.createOrReplace({
      scheduledActionId: "bulk-action",
      auditId: "bulk-create",
      guildId,
      threadId: "1",
      actorId,
      executeAt: new Date("2099-01-01T00:00:00Z"),
    });
    const f = fixture();
    expect(await managed.find(guildId, "1")).toBeUndefined();
    expect(await f.confirm()).toMatchObject({ selected: 2, attempted: 2, closed: 2 });
    for (const id of ["1", "2"])
      expect(await managed.find(guildId, id)).toMatchObject({ lifecycleState: "CLOSED" });
    expect(await actions.findById("bulk-action")).toMatchObject({ status: "CANCELLED" });
    const rows = await database.client
      .select()
      .from(threadAudits)
      .where(eq(threadAudits.guildId, guildId));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        action: "CLOSE",
        actorType: "USER",
        actorId,
        outcome: "SUCCESS",
      });
      await audits.record({
        id: row.id,
        guildId,
        threadId: row.threadId,
        action: "CLOSE",
        actorType: "USER",
        actorId,
        outcome: "SUCCESS",
      });
    }
    expect(
      await database.client.select().from(threadAudits).where(eq(threadAudits.guildId, guildId)),
    ).toHaveLength(2);
    const cancellation = await database.client
      .select()
      .from(scheduledThreadCloseAudits)
      .where(
        and(
          eq(scheduledThreadCloseAudits.guildId, guildId),
          eq(scheduledThreadCloseAudits.event, "CANCELLED"),
        ),
      );
    expect(cancellation).toMatchObject([{ actorId, actorType: "USER", outcome: "SUCCESS" }]);
    expect(rows.map((row) => row.id)).not.toContain(cancellation[0]!.id);
    expect(f.discord.archiveThread).toHaveBeenCalledTimes(2);
  });
  it("retains committed cancellation and records attempted failure when selection changes before managed persistence", async () => {
    await schedules.createOrReplace({
      scheduledActionId: "bulk-action",
      auditId: "bulk-create",
      guildId,
      threadId: "1",
      actorId,
      executeAt: new Date("2099-01-01T00:00:00Z"),
    });
    const f = fixture();
    let reads = 0;
    f.observe.mockImplementation((_g, _p, _a, ids) => {
      if (ids.includes("1") && ++reads === 2) f.threads[0]!.name = "Changed";
      return Promise.resolve({
        parent,
        threads: f.threads.filter((t) => ids.includes(t.threadId)).map((t) => ({ ...t })),
      });
    });
    expect(await f.confirm()).toMatchObject({ attempted: 2, closed: 1, failed: 1, skipped: 0 });
    expect(await actions.findById("bulk-action")).toMatchObject({ status: "CANCELLED" });
    expect(await managed.find(guildId, "1")).toBeUndefined();
    expect(
      await database.client
        .select()
        .from(threadAudits)
        .where(and(eq(threadAudits.guildId, guildId), eq(threadAudits.threadId, "1"))),
    ).toMatchObject([
      { actorId, action: "CLOSE", outcome: "FAILURE", failureCode: "BULK_SELECTION_CHANGED" },
    ]);
  });
  it("preserves partial managed state after final selection loss without a second mutation or audit", async () => {
    const f = fixture();
    let reads = 0;
    f.observe.mockImplementation((_g, _p, _a, ids) => {
      if (ids.includes("1") && ++reads === 3) f.threads[0]!.locked = true;
      return Promise.resolve({
        parent,
        threads: f.threads.filter((t) => ids.includes(t.threadId)).map((t) => ({ ...t })),
      });
    });
    expect(await f.confirm()).toMatchObject({ attempted: 2, closed: 1, failed: 1 });
    expect(await managed.find(guildId, "1")).toMatchObject({ lifecycleState: "CLOSED" });
    expect(f.discord.archiveThread).toHaveBeenCalledTimes(1);
    expect(
      await database.client
        .select()
        .from(threadAudits)
        .where(and(eq(threadAudits.guildId, guildId), eq(threadAudits.threadId, "1"))),
    ).toHaveLength(1);
  });
  it("linearizes bulk cancellation against execution claim through existing schedule locks", async () => {
    await schedules.createOrReplace({
      scheduledActionId: "bulk-race",
      auditId: "bulk-race-created",
      guildId,
      threadId: "1",
      actorId,
      executeAt: new Date("2099-01-01T00:00:00Z"),
    });
    const f = fixture();
    const [counts, claim] = await Promise.all([f.confirm(), actions.claimExecution("bulk-race")]);
    if (claim.transitioned) {
      expect(counts).toMatchObject({ attempted: 1, closed: 1, skipped: 1 });
      expect(await actions.findById("bulk-race")).toMatchObject({ status: "EXECUTING" });
      expect(await managed.find(guildId, "1")).toBeUndefined();
    } else {
      expect(counts).toMatchObject({ attempted: 2, closed: 2 });
      expect(await actions.findById("bulk-race")).toMatchObject({ status: "CANCELLED" });
    }
  });
});
