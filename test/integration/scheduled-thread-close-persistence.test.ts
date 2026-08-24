import { and, eq, inArray, or, sql } from "drizzle-orm";
import { ChannelType } from "discord.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import type { DatabaseClient } from "../../src/database.js";
import { createGuildSettingsStore } from "../../src/guild-settings.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import { createScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
  scheduledThreadCloseAdvisoryLockKeys,
} from "../../src/scheduled-thread-close-persistence.js";
import {
  createThreadLifecycleService,
  type ThreadLifecycleDiscord,
  type ThreadSnapshot,
} from "../../src/thread-lifecycle.js";
import {
  createManagedThreadStore,
  createThreadAuditStore,
  managedThreads,
  threadAudits,
} from "../../src/thread-persistence.js";

const guildIds = ["scheduled-command-guild-one", "scheduled-command-guild-two"] as const;
const threadIds = [
  "scheduled-command-thread-one",
  "scheduled-command-thread-two",
  "scheduled-command-thread-three",
] as const;
const database = createDatabase(loadTestDatabaseConfig());
const store = createScheduledThreadCloseStore(database.client);
const actionStore = createScheduledActionStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("scheduled thread close creation persistence", () => {
  it("creates one ACTIVE action and matching USER audit atomically", async () => {
    const executeAt = new Date("2030-01-02T03:04:05.678Z");

    const result = await store.createOrReplace({
      scheduledActionId: "created-action",
      auditId: "created-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt,
    });

    expect(result).toMatchObject({
      outcome: "CREATED",
      action: {
        id: "created-action",
        guildId: guildIds[0],
        actionType: "CLOSE_THREAD",
        targetId: threadIds[0],
        status: "ACTIVE",
        executeAt,
      },
    });
    await expect(store.findAuditById("created-audit")).resolves.toMatchObject({
      scheduledActionId: "created-action",
      guildId: guildIds[0],
      threadId: threadIds[0],
      event: "CREATED",
      actorType: "USER",
      actorId: "actor-id",
      previousScheduledActionId: null,
      previousExecuteAt: null,
      executeAt,
      outcome: "SUCCESS",
      failureCode: null,
    });
  });

  it("cancels the prior ACTIVE action and records replacement lineage", async () => {
    const previousExecuteAt = new Date("2030-02-01T00:00:00Z");
    const executeAt = new Date("2030-02-02T00:00:00Z");
    await store.createOrReplace({
      scheduledActionId: "previous-action",
      auditId: "previous-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: previousExecuteAt,
    });

    const result = await store.createOrReplace({
      scheduledActionId: "replacement-action",
      auditId: "replacement-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "replacement-actor",
      executeAt,
    });

    expect(result).toMatchObject({
      outcome: "REPLACED",
      action: { id: "replacement-action", status: "ACTIVE" },
      previousAction: { id: "previous-action", status: "CANCELLED" },
    });
    await expect(actionStore.findById("previous-action")).resolves.toMatchObject({
      status: "CANCELLED",
    });
    await expect(store.findAuditById("replacement-audit")).resolves.toMatchObject({
      event: "REPLACED",
      scheduledActionId: "replacement-action",
      actorType: "USER",
      actorId: "replacement-actor",
      previousScheduledActionId: "previous-action",
      previousExecuteAt,
      executeAt,
      outcome: "SUCCESS",
    });
  });

  it("serializes concurrent replacements for the same guild and thread", async () => {
    const results = await Promise.all([
      store.createOrReplace({
        scheduledActionId: "concurrent-action-one",
        auditId: "concurrent-audit-one",
        guildId: guildIds[0],
        threadId: threadIds[1],
        actorId: "actor-one",
        executeAt: new Date("2030-03-01T00:00:00Z"),
      }),
      store.createOrReplace({
        scheduledActionId: "concurrent-action-two",
        auditId: "concurrent-audit-two",
        guildId: guildIds[0],
        threadId: threadIds[1],
        actorId: "actor-two",
        executeAt: new Date("2030-03-02T00:00:00Z"),
      }),
    ]);

    expect(results.map((result) => result.outcome).sort()).toEqual(["CREATED", "REPLACED"]);
    const rows = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(eq(scheduledActions.guildId, guildIds[0]), eq(scheduledActions.targetId, threadIds[1])),
      );
    expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(1);
    const audits = await database.client
      .select()
      .from(scheduledThreadCloseAudits)
      .where(
        inArray(scheduledThreadCloseAudits.id, ["concurrent-audit-one", "concurrent-audit-two"]),
      );
    expect(audits).toHaveLength(2);
  });

  it("serializes concurrent replacements of an existing ACTIVE close", async () => {
    await store.createOrReplace({
      scheduledActionId: "replacement-race-original",
      auditId: "replacement-race-original-audit",
      guildId: guildIds[0],
      threadId: threadIds[2],
      actorId: "original-actor",
      executeAt: new Date("2030-03-10T00:00:00Z"),
    });

    const results = await Promise.all([
      store.createOrReplace({
        scheduledActionId: "replacement-race-one",
        auditId: "replacement-race-one-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-one",
        executeAt: new Date("2030-03-11T00:00:00Z"),
      }),
      store.createOrReplace({
        scheduledActionId: "replacement-race-two",
        auditId: "replacement-race-two-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-two",
        executeAt: new Date("2030-03-12T00:00:00Z"),
      }),
    ]);

    expect(results.every((result) => result.outcome === "REPLACED")).toBe(true);
    const rows = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(eq(scheduledActions.guildId, guildIds[0]), eq(scheduledActions.targetId, threadIds[2])),
      );
    expect(rows.filter((row) => row.status === "ACTIVE")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "CANCELLED")).toHaveLength(2);
  });

  it("does not replace or audit while the scheduled close is EXECUTING", async () => {
    await store.createOrReplace({
      scheduledActionId: "executing-action",
      auditId: "executing-created-audit",
      guildId: guildIds[0],
      threadId: threadIds[2],
      actorId: "actor-id",
      executeAt: new Date("2030-04-01T00:00:00Z"),
    });
    await actionStore.claimExecution("executing-action");

    await expect(
      store.createOrReplace({
        scheduledActionId: "blocked-action",
        auditId: "blocked-audit",
        guildId: guildIds[0],
        threadId: threadIds[2],
        actorId: "actor-id",
        executeAt: new Date("2030-04-02T00:00:00Z"),
      }),
    ).resolves.toMatchObject({
      outcome: "EXECUTION_IN_PROGRESS",
      current: { id: "executing-action", status: "EXECUTING" },
    });

    await expect(actionStore.findById("blocked-action")).resolves.toBeUndefined();
    await expect(store.findAuditById("blocked-audit")).resolves.toBeUndefined();
  });

  it("keeps worker-claim-first and replacement-first orderings safe", async () => {
    await store.createOrReplace({
      scheduledActionId: "worker-wins-action",
      auditId: "worker-wins-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-04-10T00:00:00Z"),
    });
    await expect(actionStore.claimExecution("worker-wins-action")).resolves.toMatchObject({
      transitioned: true,
    });
    await expect(
      store.createOrReplace({
        scheduledActionId: "worker-wins-blocked-action",
        auditId: "worker-wins-blocked-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-04-11T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "EXECUTION_IN_PROGRESS" });

    await store.createOrReplace({
      scheduledActionId: "replacement-wins-original",
      auditId: "replacement-wins-original-audit",
      guildId: guildIds[1],
      threadId: threadIds[1],
      actorId: "actor-id",
      executeAt: new Date("2030-04-12T00:00:00Z"),
    });
    await expect(
      store.createOrReplace({
        scheduledActionId: "replacement-wins-new",
        auditId: "replacement-wins-new-audit",
        guildId: guildIds[1],
        threadId: threadIds[1],
        actorId: "actor-id",
        executeAt: new Date("2030-04-13T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "REPLACED" });
    await expect(actionStore.claimExecution("replacement-wins-original")).resolves.toMatchObject({
      transitioned: false,
      current: { status: "CANCELLED" },
    });
  });

  it("rolls back cancellation and insertion when the audit write fails", async () => {
    await store.createOrReplace({
      scheduledActionId: "rollback-previous-action",
      auditId: "duplicate-audit-id",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-05-01T00:00:00Z"),
    });

    await expect(
      store.createOrReplace({
        scheduledActionId: "rollback-new-action",
        auditId: "duplicate-audit-id",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-05-02T00:00:00Z"),
      }),
    ).rejects.toThrow();

    await expect(actionStore.findById("rollback-previous-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(actionStore.findById("rollback-new-action")).resolves.toBeUndefined();
  });

  it("confirms a committed transaction after simulated response loss without rerunning it", async () => {
    let transactionCalls = 0;
    const responseLossDatabase = {
      select: database.client.select.bind(database.client),
      transaction: async (work: Parameters<DatabaseClient["transaction"]>[0]) => {
        transactionCalls += 1;
        await database.client.transaction(work);
        throw new Error("simulated response loss after commit");
      },
    } as unknown as DatabaseClient;
    const responseLossStore = createScheduledThreadCloseStore(responseLossDatabase);

    await expect(
      responseLossStore.createOrReplace({
        scheduledActionId: "response-loss-action",
        auditId: "response-loss-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
        executeAt: new Date("2030-06-01T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "CREATED", action: { id: "response-loss-action" } });

    expect(transactionCalls).toBe(1);
    await expect(actionStore.findById("response-loss-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(store.findAuditById("response-loss-audit")).resolves.toMatchObject({
      event: "CREATED",
      outcome: "SUCCESS",
    });
  });

  it("confirms a committed replacement after simulated response loss without rerunning it", async () => {
    const previousExecuteAt = new Date("2030-06-02T00:00:00Z");
    const replacementExecuteAt = new Date("2030-06-03T00:00:00Z");
    await store.createOrReplace({
      scheduledActionId: "response-loss-previous-action",
      auditId: "response-loss-previous-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "previous-actor",
      executeAt: previousExecuteAt,
    });

    let transactionCalls = 0;
    const responseLossDatabase = {
      select: database.client.select.bind(database.client),
      transaction: async (work: Parameters<DatabaseClient["transaction"]>[0]) => {
        transactionCalls += 1;
        await database.client.transaction(work);
        throw new Error("simulated response loss after replacement commit");
      },
    } as unknown as DatabaseClient;
    const responseLossStore = createScheduledThreadCloseStore(responseLossDatabase);

    await expect(
      responseLossStore.createOrReplace({
        scheduledActionId: "response-loss-replacement-action",
        auditId: "response-loss-replacement-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "replacement-actor",
        executeAt: replacementExecuteAt,
      }),
    ).resolves.toMatchObject({
      outcome: "REPLACED",
      action: {
        id: "response-loss-replacement-action",
        status: "ACTIVE",
        executeAt: replacementExecuteAt,
      },
      previousAction: {
        id: "response-loss-previous-action",
        status: "CANCELLED",
        executeAt: previousExecuteAt,
      },
    });

    expect(transactionCalls).toBe(1);
    const actions = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.guildId, guildIds[0]),
          eq(scheduledActions.actionType, "CLOSE_THREAD"),
          eq(scheduledActions.targetId, threadIds[0]),
        ),
      );
    expect(actions).toHaveLength(2);
    expect(actions.filter((action) => action.status === "ACTIVE")).toEqual([
      expect.objectContaining({
        id: "response-loss-replacement-action",
        executeAt: replacementExecuteAt,
      }),
    ]);
    expect(actions.filter((action) => action.status === "CANCELLED")).toEqual([
      expect.objectContaining({
        id: "response-loss-previous-action",
        executeAt: previousExecuteAt,
      }),
    ]);

    const replacementAudits = await database.client
      .select()
      .from(scheduledThreadCloseAudits)
      .where(eq(scheduledThreadCloseAudits.id, "response-loss-replacement-audit"));
    expect(replacementAudits).toEqual([
      expect.objectContaining({
        id: "response-loss-replacement-audit",
        scheduledActionId: "response-loss-replacement-action",
        guildId: guildIds[0],
        threadId: threadIds[0],
        event: "REPLACED",
        actorType: "USER",
        actorId: "replacement-actor",
        previousScheduledActionId: "response-loss-previous-action",
        previousExecuteAt,
        executeAt: replacementExecuteAt,
        outcome: "SUCCESS",
        failureCode: null,
      }),
    ]);
  });

  it("cancels one ACTIVE close and records the exact USER cancellation audit atomically", async () => {
    const executeAt = new Date("2030-06-10T12:34:56.789Z");
    await store.createOrReplace({
      scheduledActionId: "cancelled-action",
      auditId: "cancelled-created-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "creator-id",
      executeAt,
    });

    await expect(
      store.cancel({
        auditId: "cancelled-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "cancelling-actor-id",
      }),
    ).resolves.toMatchObject({
      outcome: "CANCELLED",
      action: { id: "cancelled-action", status: "CANCELLED", executeAt },
    });

    await expect(store.findAuditById("cancelled-audit")).resolves.toMatchObject({
      scheduledActionId: "cancelled-action",
      guildId: guildIds[0],
      threadId: threadIds[0],
      event: "CANCELLED",
      actorType: "USER",
      actorId: "cancelling-actor-id",
      previousScheduledActionId: null,
      previousExecuteAt: null,
      executeAt,
      outcome: "SUCCESS",
      failureCode: null,
    });
  });

  it("keeps repeated cancellation idempotent without another audit", async () => {
    await store.createOrReplace({
      scheduledActionId: "repeat-cancel-action",
      auditId: "repeat-create-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-11T00:00:00Z"),
    });
    await store.cancel({
      auditId: "repeat-cancel-audit-one",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });

    await expect(
      store.cancel({
        auditId: "repeat-cancel-audit-two",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
      }),
    ).resolves.toEqual({ outcome: "NOT_SCHEDULED" });
    await expect(store.findAuditById("repeat-cancel-audit-two")).resolves.toBeUndefined();
  });

  it("leaves EXECUTING and terminal history unchanged without cancellation audits", async () => {
    const statuses = ["EXECUTING", "CANCELLED", "COMPLETED", "FAILED"] as const;
    const targets = [
      [guildIds[0], threadIds[0]],
      [guildIds[0], threadIds[1]],
      [guildIds[0], threadIds[2]],
      [guildIds[1], threadIds[0]],
    ] as const;
    for (const [index, status] of statuses.entries()) {
      const actionId = `unchanged-${status.toLowerCase()}`;
      const [guildId, threadId] = targets[index]!;
      await actionStore.create({
        id: actionId,
        guildId,
        actionType: "CLOSE_THREAD",
        targetId: threadId,
        executeAt: new Date(`2030-06-${12 + index}T00:00:00Z`),
      });
      if (status === "EXECUTING") {
        await actionStore.claimExecution(actionId);
      } else if (status === "CANCELLED") {
        await actionStore.cancel(actionId);
      } else {
        await actionStore.claimExecution(actionId);
        await (status === "COMPLETED"
          ? actionStore.completeExecution(actionId)
          : actionStore.failExecution(actionId));
      }

      const result = await store.cancel({
        auditId: `unchanged-${status.toLowerCase()}-audit`,
        guildId,
        threadId,
        actorId: "actor-id",
      });
      expect(result.outcome).toBe(
        status === "EXECUTING" ? "EXECUTION_IN_PROGRESS" : "NOT_SCHEDULED",
      );
      await expect(actionStore.findById(actionId)).resolves.toMatchObject({ status });
      await expect(
        store.findAuditById(`unchanged-${status.toLowerCase()}-audit`),
      ).resolves.toBeUndefined();
    }
  });

  it("does not treat an ACTIVE SEND_MESSAGE as a scheduled thread close", async () => {
    await actionStore.create({
      id: "send-message-action",
      guildId: guildIds[0],
      actionType: "SEND_MESSAGE",
      targetId: threadIds[0],
      executeAt: new Date("2030-06-19T00:00:00Z"),
    });

    await expect(
      store.cancel({
        auditId: "send-message-cancel-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
      }),
    ).resolves.toEqual({ outcome: "NOT_SCHEDULED" });
    await expect(actionStore.findById("send-message-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
    await expect(store.findAuditById("send-message-cancel-audit")).resolves.toBeUndefined();
  });

  it("rolls back cancellation state when audit insertion fails", async () => {
    await store.createOrReplace({
      scheduledActionId: "rollback-cancel-action",
      auditId: "rollback-cancel-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-20T00:00:00Z"),
    });

    await expect(
      store.cancel({
        auditId: "rollback-cancel-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "actor-id",
      }),
    ).rejects.toThrow();
    await expect(actionStore.findById("rollback-cancel-action")).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("confirms a committed cancellation after response loss without rerunning it", async () => {
    await store.createOrReplace({
      scheduledActionId: "response-loss-cancel-action",
      auditId: "response-loss-cancel-create-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "creator-id",
      executeAt: new Date("2030-06-21T00:00:00Z"),
    });
    let transactionCalls = 0;
    const responseLossDatabase = {
      select: database.client.select.bind(database.client),
      transaction: async (work: Parameters<DatabaseClient["transaction"]>[0]) => {
        transactionCalls += 1;
        await database.client.transaction(work);
        throw new Error("simulated response loss after cancellation commit");
      },
    } as unknown as DatabaseClient;
    const responseLossStore = createScheduledThreadCloseStore(responseLossDatabase);

    await expect(
      responseLossStore.cancel({
        auditId: "response-loss-cancel-audit",
        guildId: guildIds[0],
        threadId: threadIds[0],
        actorId: "cancelling-actor-id",
      }),
    ).resolves.toMatchObject({
      outcome: "CANCELLED",
      action: { id: "response-loss-cancel-action", status: "CANCELLED" },
    });
    expect(transactionCalls).toBe(1);
    await expect(store.findAuditById("response-loss-cancel-audit")).resolves.toMatchObject({
      event: "CANCELLED",
      actorId: "cancelling-actor-id",
      outcome: "SUCCESS",
    });
  });

  it("linearizes cancellation before a concurrent worker claim", async () => {
    await store.createOrReplace({
      scheduledActionId: "cancel-wins-action",
      auditId: "cancel-wins-create-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-22T00:00:00Z"),
    });
    const transactionReady = deferred<void>();
    const releaseCommit = deferred<void>();
    const pausedDatabase = {
      select: database.client.select.bind(database.client),
      transaction: (work: Parameters<DatabaseClient["transaction"]>[0]) =>
        database.client.transaction(async (transaction) => {
          const result = await work(transaction);
          transactionReady.resolve(undefined);
          await releaseCommit.promise;
          return result;
        }),
    } as unknown as DatabaseClient;
    const pausedCancelStore = createScheduledThreadCloseStore(pausedDatabase);

    const cancellation = pausedCancelStore.cancel({
      auditId: "cancel-wins-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    await transactionReady.promise;
    const claim = actionStore.claimExecution("cancel-wins-action");
    releaseCommit.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(claim).resolves.toMatchObject({
      transitioned: false,
      current: { status: "CANCELLED" },
    });
  });

  it("serializes concurrent cancellations so only the first writes an audit", async () => {
    await store.createOrReplace({
      scheduledActionId: "concurrent-cancel-action",
      auditId: "concurrent-cancel-create-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-22T12:00:00Z"),
    });
    const transactionReady = deferred<void>();
    const releaseCommit = deferred<void>();
    const pausedDatabase = {
      select: database.client.select.bind(database.client),
      transaction: (work: Parameters<DatabaseClient["transaction"]>[0]) =>
        database.client.transaction(async (transaction) => {
          const result = await work(transaction);
          transactionReady.resolve(undefined);
          await releaseCommit.promise;
          return result;
        }),
    } as unknown as DatabaseClient;
    const firstStore = createScheduledThreadCloseStore(pausedDatabase);
    const first = firstStore.cancel({
      auditId: "concurrent-cancel-audit-one",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    await transactionReady.promise;
    const second = store.cancel({
      auditId: "concurrent-cancel-audit-two",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    releaseCommit.resolve(undefined);

    await expect(first).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(second).resolves.toEqual({ outcome: "NOT_SCHEDULED" });
    await expect(store.findAuditById("concurrent-cancel-audit-one")).resolves.toBeDefined();
    await expect(store.findAuditById("concurrent-cancel-audit-two")).resolves.toBeUndefined();
  });

  it("leaves a worker-owned EXECUTING action unchanged when the claim wins", async () => {
    await store.createOrReplace({
      scheduledActionId: "worker-wins-action",
      auditId: "worker-wins-create-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-23T00:00:00Z"),
    });
    const claimReady = deferred<void>();
    const releaseClaim = deferred<void>();
    const heldClaim = database.client.transaction(async (transaction) => {
      const transactionStore = createScheduledActionStore(transaction as unknown as DatabaseClient);
      const result = await transactionStore.claimExecution("worker-wins-action");
      claimReady.resolve(undefined);
      await releaseClaim.promise;
      return result;
    });
    await claimReady.promise;
    const cancellation = store.cancel({
      auditId: "worker-wins-cancel-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    releaseClaim.resolve(undefined);

    await expect(heldClaim).resolves.toMatchObject({ transitioned: true });
    await expect(cancellation).resolves.toMatchObject({
      outcome: "EXECUTION_IN_PROGRESS",
      current: { status: "EXECUTING" },
    });
    await expect(store.findAuditById("worker-wins-cancel-audit")).resolves.toBeUndefined();
  });

  it("serializes same-target cancel then create while unrelated targets remain independent", async () => {
    await store.createOrReplace({
      scheduledActionId: "serialized-old-action",
      auditId: "serialized-old-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-24T00:00:00Z"),
    });
    const transactionReady = deferred<void>();
    const releaseCommit = deferred<void>();
    const pausedDatabase = {
      select: database.client.select.bind(database.client),
      transaction: (work: Parameters<DatabaseClient["transaction"]>[0]) =>
        database.client.transaction(async (transaction) => {
          const result = await work(transaction);
          transactionReady.resolve(undefined);
          await releaseCommit.promise;
          return result;
        }),
    } as unknown as DatabaseClient;
    const pausedCancelStore = createScheduledThreadCloseStore(pausedDatabase);
    const cancellation = pausedCancelStore.cancel({
      auditId: "serialized-cancel-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    await transactionReady.promise;
    await expect(
      store.createOrReplace({
        scheduledActionId: "unrelated-action",
        auditId: "unrelated-audit",
        guildId: guildIds[1],
        threadId: threadIds[1],
        actorId: "actor-id",
        executeAt: new Date("2030-06-25T00:00:00Z"),
      }),
    ).resolves.toMatchObject({ outcome: "CREATED" });
    const laterCreate = store.createOrReplace({
      scheduledActionId: "serialized-new-action",
      auditId: "serialized-new-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-26T00:00:00Z"),
    });
    releaseCommit.resolve(undefined);

    await expect(cancellation).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(laterCreate).resolves.toMatchObject({
      outcome: "CREATED",
      action: { id: "serialized-new-action", status: "ACTIVE" },
    });
  });

  it("serializes same-target create then cancel so the later cancellation wins", async () => {
    const transactionReady = deferred<void>();
    const releaseCommit = deferred<void>();
    const pausedDatabase = {
      select: database.client.select.bind(database.client),
      transaction: (work: Parameters<DatabaseClient["transaction"]>[0]) =>
        database.client.transaction(async (transaction) => {
          const result = await work(transaction);
          transactionReady.resolve(undefined);
          await releaseCommit.promise;
          return result;
        }),
    } as unknown as DatabaseClient;
    const pausedCreateStore = createScheduledThreadCloseStore(pausedDatabase);
    const creation = pausedCreateStore.createOrReplace({
      scheduledActionId: "create-first-action",
      auditId: "create-first-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
      executeAt: new Date("2030-06-27T00:00:00Z"),
    });
    await transactionReady.promise;
    const cancellation = store.cancel({
      auditId: "create-first-cancel-audit",
      guildId: guildIds[0],
      threadId: threadIds[0],
      actorId: "actor-id",
    });
    releaseCommit.resolve(undefined);

    await expect(creation).resolves.toMatchObject({ outcome: "CREATED" });
    await expect(cancellation).resolves.toMatchObject({
      outcome: "CANCELLED",
      action: { id: "create-first-action", status: "CANCELLED" },
    });
  });

  it("commits the action and audit before invoking the enqueue boundary", async () => {
    const observer = createDatabase(loadTestDatabaseConfig());
    const now = new Date("2030-06-04T00:00:00Z");
    const executeAt = new Date("2030-06-04T00:30:00Z");
    let observedAtEnqueue:
      | {
          action: typeof scheduledActions.$inferSelect | undefined;
          audit: typeof scheduledThreadCloseAudits.$inferSelect | undefined;
        }
      | undefined;
    const enqueueScheduledThreadClose = vi.fn(async (scheduledActionId: string) => {
      const [[action], [audit]] = await Promise.all([
        observer.client
          .select()
          .from(scheduledActions)
          .where(eq(scheduledActions.id, scheduledActionId))
          .limit(1),
        observer.client
          .select()
          .from(scheduledThreadCloseAudits)
          .where(eq(scheduledThreadCloseAudits.id, "commit-order-audit"))
          .limit(1),
      ]);
      observedAtEnqueue = { action, audit };
      return "ENQUEUED" as const;
    });
    const ids = ["commit-order-action", "commit-order-audit"];
    const service = createScheduledThreadCloseCommandService({
      discord: {
        fetchThread: () =>
          Promise.resolve({
            guildId: guildIds[1],
            threadId: threadIds[2],
            type: ChannelType.PublicThread,
            name: "Topic",
            archived: false,
            locked: false,
          }),
        actorCanManage: () => Promise.resolve(true),
        botCanManage: () => Promise.resolve(true),
      },
      schedules: store,
      delivery: {
        enqueueScheduledThreadClose,
        hasCreatedOrRetryDelivery: () => Promise.resolve(false),
      },
      threadLifecycle: {
        close: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
      },
      logger: { warn: vi.fn() },
      now: () => now,
      generateId: () => ids.shift()!,
    });

    try {
      await expect(
        service.schedule(guildIds[1], threadIds[2], "actor-id", "30m"),
      ).resolves.toMatchObject({
        ok: true,
        outcome: "CREATED",
        action: { id: "commit-order-action", executeAt },
      });
    } finally {
      await observer.close();
    }

    expect(enqueueScheduledThreadClose).toHaveBeenCalledOnce();
    expect(observedAtEnqueue).toMatchObject({
      action: {
        id: "commit-order-action",
        guildId: guildIds[1],
        actionType: "CLOSE_THREAD",
        targetId: threadIds[2],
        status: "ACTIVE",
        executeAt,
      },
      audit: {
        id: "commit-order-audit",
        scheduledActionId: "commit-order-action",
        guildId: guildIds[1],
        threadId: threadIds[2],
        event: "CREATED",
        actorType: "USER",
        actorId: "actor-id",
        executeAt,
        outcome: "SUCCESS",
      },
    });
  });

  it("commits manual-close cancellation before the lifecycle mutation boundary", async () => {
    const observer = createDatabase(loadTestDatabaseConfig());
    const executeAt = new Date("2030-06-05T00:30:00Z");
    await store.createOrReplace({
      scheduledActionId: "manual-close-action",
      auditId: "manual-close-created-audit",
      guildId: guildIds[1],
      threadId: threadIds[2],
      actorId: "creator-id",
      executeAt,
    });
    let observedAtMutation:
      | {
          action: typeof scheduledActions.$inferSelect | undefined;
          audit: typeof scheduledThreadCloseAudits.$inferSelect | undefined;
        }
      | undefined;
    const lifecycleClose = vi.fn(
      async (
        _guildId: string,
        _threadId: string,
        _actorId: string,
        prepareManualClose?: () => Promise<void>,
      ) => {
        await prepareManualClose?.();
        const [[action], [audit]] = await Promise.all([
          observer.client
            .select()
            .from(scheduledActions)
            .where(eq(scheduledActions.id, "manual-close-action"))
            .limit(1),
          observer.client
            .select()
            .from(scheduledThreadCloseAudits)
            .where(eq(scheduledThreadCloseAudits.id, "manual-close-cancel-audit"))
            .limit(1),
        ]);
        observedAtMutation = { action, audit };
        return { ok: true, changed: true } as const;
      },
    );
    const service = createScheduledThreadCloseCommandService({
      discord: {
        fetchThread: () => Promise.resolve(undefined),
        actorCanManage: () => Promise.resolve(false),
        botCanManage: () => Promise.resolve(false),
      },
      schedules: store,
      delivery: {
        enqueueScheduledThreadClose: () => Promise.resolve("ENQUEUED"),
        hasCreatedOrRetryDelivery: () => Promise.resolve(false),
      },
      threadLifecycle: { close: lifecycleClose },
      logger: { warn: vi.fn() },
      generateId: () => "manual-close-cancel-audit",
    });

    try {
      await expect(
        service.closeManually(guildIds[1], threadIds[2], "manual-actor-id"),
      ).resolves.toEqual({ outcome: "LIFECYCLE", result: { ok: true, changed: true } });
    } finally {
      await observer.close();
    }

    expect(observedAtMutation).toMatchObject({
      action: { id: "manual-close-action", status: "CANCELLED", executeAt },
      audit: {
        id: "manual-close-cancel-audit",
        scheduledActionId: "manual-close-action",
        event: "CANCELLED",
        actorType: "USER",
        actorId: "manual-actor-id",
        executeAt,
        outcome: "SUCCESS",
      },
    });
    await expect(actionStore.findById("manual-close-action")).resolves.toMatchObject({
      status: "CANCELLED",
    });
  });

  it("records distinct scheduled-close cancellation and lifecycle close audits for manual close", async () => {
    const executeAt = new Date("2030-06-06T00:30:00Z");
    await store.createOrReplace({
      scheduledActionId: "manual-close-audit-separation-action",
      auditId: "manual-close-audit-separation-created-audit",
      guildId: guildIds[1],
      threadId: threadIds[2],
      actorId: "creator-id",
      executeAt,
    });
    const thread: ThreadSnapshot = {
      guildId: guildIds[1],
      threadId: threadIds[2],
      type: ChannelType.PublicThread,
      name: "Topic",
      archived: false,
      locked: false,
    };
    const discord: ThreadLifecycleDiscord = {
      fetchThread: vi.fn(() => Promise.resolve({ ...thread })),
      actorCanManage: vi.fn(() => Promise.resolve(true)),
      botCanManage: vi.fn(() => Promise.resolve(true)),
      renameThread: vi.fn(() => Promise.resolve()),
      archiveThread: vi.fn<ThreadLifecycleDiscord["archiveThread"]>((_guildId, _threadId, name) => {
        thread.name = name;
        thread.archived = true;
        return Promise.resolve();
      }),
      classifyMutationFailure: vi.fn<ThreadLifecycleDiscord["classifyMutationFailure"]>(
        () => "RETRYABLE",
      ),
    };
    const lifecycle = createThreadLifecycleService({
      discord,
      guildSettings: createGuildSettingsStore(database.client),
      managedThreads: createManagedThreadStore(database.client),
      audits: createThreadAuditStore(database.client),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const service = createScheduledThreadCloseCommandService({
      discord,
      schedules: store,
      delivery: {
        enqueueScheduledThreadClose: () => Promise.resolve("ENQUEUED"),
        hasCreatedOrRetryDelivery: () => Promise.resolve(false),
      },
      threadLifecycle: lifecycle,
      logger: { warn: vi.fn() },
      generateId: () => "manual-close-audit-separation-cancel-audit",
    });

    await expect(
      service.closeManually(guildIds[1], threadIds[2], "manual-actor-id"),
    ).resolves.toEqual({ outcome: "LIFECYCLE", result: { ok: true, changed: true } });

    const [scheduledCloseAudits, lifecycleAudits] = await Promise.all([
      database.client
        .select()
        .from(scheduledThreadCloseAudits)
        .where(eq(scheduledThreadCloseAudits.id, "manual-close-audit-separation-cancel-audit")),
      database.client
        .select()
        .from(threadAudits)
        .where(
          and(
            eq(threadAudits.guildId, guildIds[1]),
            eq(threadAudits.threadId, threadIds[2]),
            eq(threadAudits.action, "CLOSE"),
          ),
        ),
    ]);

    expect(scheduledCloseAudits).toEqual([
      expect.objectContaining({
        id: "manual-close-audit-separation-cancel-audit",
        scheduledActionId: "manual-close-audit-separation-action",
        guildId: guildIds[1],
        threadId: threadIds[2],
        event: "CANCELLED",
        actorType: "USER",
        actorId: "manual-actor-id",
        executeAt,
        outcome: "SUCCESS",
      }),
    ]);
    expect(lifecycleAudits).toEqual([
      expect.objectContaining({
        guildId: guildIds[1],
        threadId: threadIds[2],
        action: "CLOSE",
        actorType: "USER",
        actorId: "manual-actor-id",
        outcome: "SUCCESS",
      }),
    ]);
    expect(lifecycleAudits[0]?.id).not.toBe(scheduledCloseAudits[0]?.id);
    await expect(
      actionStore.findById("manual-close-audit-separation-action"),
    ).resolves.toMatchObject({
      status: "CANCELLED",
    });
    expect(discord.archiveThread).toHaveBeenCalledOnce();
  });

  it("enforces audit actor, outcome, and replacement checks in PostgreSQL", async () => {
    const insertInvalidAudit = (id: string, actorId: string | null, failureCode: string | null) =>
      database.client.execute(sql`
        insert into scheduled_thread_close_audits
          (id, scheduled_action_id, guild_id, thread_id, event, actor_type, actor_id,
           execute_at, outcome, failure_code)
        values (
          ${id}, ${"constraint-action"}, ${guildIds[0]}, ${threadIds[0]}, ${"CREATED"},
          ${"USER"}, ${actorId}, ${new Date("2030-07-01T00:00:00Z")}, ${"SUCCESS"},
          ${failureCode}
        )
      `);

    await expect(insertInvalidAudit("missing-user-actor", null, null)).rejects.toThrow();
    await expect(
      insertInvalidAudit("success-with-failure", "actor-id", "FAILURE"),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into scheduled_thread_close_audits
          (id, scheduled_action_id, guild_id, thread_id, event, actor_type, actor_id,
           execute_at, outcome)
        values (
          ${"replacement-without-lineage"}, ${"constraint-action"}, ${guildIds[0]},
          ${threadIds[0]}, ${"REPLACED"}, ${"USER"}, ${"actor-id"},
          ${new Date("2030-07-01T00:00:00Z")}, ${"SUCCESS"}
        )
      `),
    ).rejects.toThrow();
  });

  it("uses separate advisory lock namespaces for distinct guild/thread pairs", () => {
    const first = scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]);

    expect(first).toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]));
    expect(first).not.toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[1], threadIds[0]));
    expect(first).not.toEqual(scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[1]));
    expect(first.every(Number.isInteger)).toBe(true);
  });

  it("does not serialize administration for a different guild/thread lock key", async () => {
    const [key1, key2] = scheduledThreadCloseAdvisoryLockKeys(guildIds[0], threadIds[0]);
    let releaseLock: (() => void) | undefined;
    let notifyLockHeld: (() => void) | undefined;
    const lockHeld = new Promise<void>((resolve) => {
      notifyLockHeld = resolve;
    });
    const holdTransaction = database.client.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(${key1}::integer, ${key2}::integer)`,
      );
      notifyLockHeld?.();
      await new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    });
    await lockHeld;

    try {
      await expect(
        store.createOrReplace({
          scheduledActionId: "different-lock-action",
          auditId: "different-lock-audit",
          guildId: guildIds[1],
          threadId: threadIds[1],
          actorId: "actor-id",
          executeAt: new Date("2030-06-15T00:00:00Z"),
        }),
      ).resolves.toMatchObject({ outcome: "CREATED" });
    } finally {
      releaseLock?.();
      await holdTransaction;
    }
  });

  it("installs only the intended audit table fields, checks, and indexes", async () => {
    const columns = await database.client.execute<{ columnName: string; dataType: string }>(sql`
      select column_name as "columnName", data_type as "dataType"
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'scheduled_thread_close_audits'
      order by ordinal_position
    `);
    expect(columns.rows.map((row) => row.columnName)).toEqual([
      "id",
      "scheduled_action_id",
      "guild_id",
      "thread_id",
      "event",
      "actor_type",
      "actor_id",
      "previous_scheduled_action_id",
      "previous_execute_at",
      "execute_at",
      "outcome",
      "failure_code",
      "created_at",
    ]);
    expect(columns.rows.find((row) => row.columnName === "execute_at")?.dataType).toBe(
      "timestamp with time zone",
    );

    const indexes = await database.client.execute<{ indexName: string }>(sql`
      select indexname as "indexName"
      from pg_indexes
      where schemaname = 'public'
        and tablename = 'scheduled_thread_close_audits'
      order by indexname
    `);
    expect(indexes.rows.map((row) => row.indexName)).toEqual([
      "scheduled_thread_close_audits_action_id_idx",
      "scheduled_thread_close_audits_guild_thread_created_at_idx",
      "scheduled_thread_close_audits_pkey",
    ]);

    const foreignKeys = await database.client.execute<{ count: string }>(sql`
      select count(*)::text as count
      from information_schema.table_constraints
      where table_schema = 'public'
        and table_name = 'scheduled_thread_close_audits'
        and constraint_type = 'FOREIGN KEY'
    `);
    expect(foreignKeys.rows[0]?.count).toBe("0");
  });
});

async function cleanup(): Promise<void> {
  await database.client.delete(threadAudits).where(inArray(threadAudits.guildId, guildIds));
  await database.client.delete(managedThreads).where(inArray(managedThreads.guildId, guildIds));
  await database.client
    .delete(scheduledThreadCloseAudits)
    .where(inArray(scheduledThreadCloseAudits.guildId, guildIds));
  await database.client
    .delete(scheduledActions)
    .where(
      or(
        inArray(scheduledActions.guildId, guildIds),
        and(
          eq(scheduledActions.actionType, "CLOSE_THREAD"),
          inArray(scheduledActions.targetId, threadIds),
        ),
      ),
    );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}
