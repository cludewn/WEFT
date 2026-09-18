import { eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Logger } from "pino";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { managedMessageAudits, managedMessages } from "../../src/managed-message-persistence.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import type {
  ScheduledMessageCreationDiscord,
  ScheduledMessageDiscord,
} from "../../src/scheduled-message-discord.js";
import { createScheduledMessageCommandService } from "../../src/scheduled-message-command.js";
import { createScheduledMessageExecutor } from "../../src/scheduled-message-execution.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
  type ScheduledMessageStore,
} from "../../src/scheduled-message-persistence.js";
import {
  createScheduledMessageRuntimeReconciler,
  createScheduledMessageStartupReconciler,
} from "../../src/scheduled-message-reconciler.js";
import {
  createScheduledMessageWorkerController,
  SCHEDULED_MESSAGE_QUEUE,
  type ScheduledMessageWorkerController,
} from "../../src/scheduled-message-worker.js";

const guildId = "scheduled-message-worker-guild";
const config = loadTestDatabaseConfig();
const database = createDatabase(config);
const pgBoss = createPgBossRuntime(config, createLogger());
const actions = createScheduledActionStore(database.client);
const messages = createScheduledMessageStore(database.client);
const controllers: ScheduledMessageWorkerController[] = [];

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await pgBoss.start();
  if ((await pgBoss.client.getQueue(SCHEDULED_MESSAGE_QUEUE)) !== null) {
    await pgBoss.client.deleteQueue(SCHEDULED_MESSAGE_QUEUE);
  }
  await cleanup();
});

afterEach(async () => {
  for (const controller of controllers.splice(0).toReversed()) await controller.stop();
  if ((await pgBoss.client.getQueue(SCHEDULED_MESSAGE_QUEUE)) !== null) {
    await pgBoss.client.deleteAllJobs(SCHEDULED_MESSAGE_QUEUE);
  }
  await cleanup();
});

afterAll(async () => {
  if ((await pgBoss.client.getQueue(SCHEDULED_MESSAGE_QUEUE)) !== null) {
    await pgBoss.client.deleteQueue(SCHEDULED_MESSAGE_QUEUE);
  }
  await pgBoss.stop();
  await database.close();
});

describe("scheduled message pg-boss delivery", () => {
  it("creates a future command schedule with effective delivery and cleans it after cancellation", async () => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const establishedAt = new Date(Date.now() + 60_000);
    const identifiers = ["command-created-action", "command-created-audit", "command-cancel-audit"];
    const command = createScheduledMessageCommandService({
      discord: {
        authorizeCreation: vi.fn<ScheduledMessageCreationDiscord["authorizeCreation"]>(() =>
          Promise.resolve({ outcome: "AUTHORIZED" }),
        ),
      },
      store: messages,
      delivery: controller,
      logger: createLogger(),
      generateId: () => identifiers.shift()!,
      now: () => establishedAt,
    });

    await expect(
      command.create({
        guildId,
        channelId: "channel-id",
        actorUserId: "creator-id",
        durationMs: 60_000,
        payload: { content: "command-created content", embed: null },
      }),
    ).resolves.toMatchObject({
      outcome: "SUCCESS",
      definition: { action: { id: "command-created-action", status: "ACTIVE" } },
      deliveryPendingReconciliation: false,
    });
    await expect(messages.find("command-created-action")).resolves.toMatchObject({
      action: { status: "ACTIVE", executeAt: new Date(establishedAt.getTime() + 60_000) },
    });
    await expect(findJobsForAction("command-created-action")).resolves.toEqual([
      expect.objectContaining({ state: "created", singletonKey: "command-created-action" }),
    ]);

    await expect(
      command.cancel({
        scheduledActionId: "command-created-action",
        guildId,
        channelId: "channel-id",
        actorUserId: "cancelling-user",
      }),
    ).resolves.toEqual({ outcome: "CANCELLED", deliveryCleanupPending: false });
    await expect(messages.find("command-created-action")).resolves.toMatchObject({
      action: { status: "CANCELLED" },
    });
    await expect(findJobsForAction("command-created-action")).resolves.toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
  });

  it("creates the exact queue, singleton, and future startAfter", async () => {
    const discord = createDiscord();
    const controller = createController(discord);
    await controller.ensureQueue();
    const executeAt = new Date("2999-01-01T00:00:00Z");
    const projection = { scheduledActionId: "duplicate-action", executeAt, revision: 0 };
    await expect(controller.ensureScheduledMessageDelivery(projection)).resolves.toBe("CURRENT");
    await expect(controller.ensureScheduledMessageDelivery(projection)).resolves.toBe("CURRENT");
    await expect(pgBoss.client.getQueue(SCHEDULED_MESSAGE_QUEUE)).resolves.toMatchObject({
      policy: "exclusive",
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 900,
      expireInSeconds: 900,
    });
    await expect(pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE)).resolves.toEqual([]);
    const jobs = await pgBoss.client.findJobs<{
      scheduledActionId: string;
      scheduledExecuteAt: string;
      scheduleRevision: number;
    }>(SCHEDULED_MESSAGE_QUEUE);
    expect(jobs).toEqual([
      expect.objectContaining({
        singletonKey: "duplicate-action",
        startAfter: executeAt,
        data: {
          scheduledActionId: "duplicate-action",
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 0,
        },
      }),
    ]);
  });

  it.each([
    ["later", 120_000],
    ["earlier", 30_000],
  ] as const)("reschedules a created delivery %s in place", async (_label, offsetMs) => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const initialAt = new Date(Date.now() + 60_000);
    const definition = await createScheduledMessage(`created-${_label}`, initialAt);
    await controller.ensureScheduledMessageDelivery({
      scheduledActionId: definition.action.id,
      executeAt: definition.action.executeAt,
      revision: definition.revision,
    });
    const before = await findJob(definition.action.id);
    const nextAt = new Date(Date.now() + offsetMs);

    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: definition.action.id,
        executeAt: nextAt,
        revision: definition.revision + 1,
      }),
    ).resolves.toBe("CURRENT");

    const after = await findJob(definition.action.id);
    expect(after).toMatchObject({
      id: before?.id,
      state: "created",
      retryCount: before?.retryCount,
      startAfter: nextAt,
      data: {
        scheduledActionId: definition.action.id,
        scheduledExecuteAt: nextAt.toISOString(),
        scheduleRevision: definition.revision + 1,
      },
    });
  });

  it("reschedules retry delivery in place while preserving retry metadata", async () => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const definition = await createScheduledMessage(
      "retry-reschedule",
      new Date(Date.now() - 1_000),
    );
    await controller.ensureScheduledMessageDelivery({
      scheduledActionId: definition.action.id,
      executeAt: definition.action.executeAt,
      revision: 0,
    });
    const [active] = await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, { includeMetadata: true });
    await pgBoss.client.fail(SCHEDULED_MESSAGE_QUEUE, active!.id);
    const retry = await findJob(definition.action.id);
    expect(retry?.state).toBe("retry");
    const nextAt = new Date(Date.now() + 120_000);

    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: definition.action.id,
        executeAt: nextAt,
        revision: 1,
      }),
    ).resolves.toBe("CURRENT");

    await expect(findJob(definition.action.id)).resolves.toMatchObject({
      id: retry?.id,
      state: "retry",
      retryCount: retry?.retryCount,
      startAfter: nextAt,
      data: {
        scheduledActionId: definition.action.id,
        scheduledExecuteAt: nextAt.toISOString(),
        scheduleRevision: 1,
      },
    });
  });

  it("adopts legacy created and retry deliveries conservatively", async () => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const createdAt = new Date(Date.now() + 60_000);
    const createdId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: "legacy-created" },
      { singletonKey: "legacy-created", startAfter: createdAt },
    );
    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: "legacy-created",
        executeAt: createdAt,
        revision: 4,
      }),
    ).resolves.toBe("CURRENT");
    await expect(findJob("legacy-created")).resolves.toMatchObject({
      id: createdId,
      state: "created",
      startAfter: createdAt,
      data: {
        scheduledActionId: "legacy-created",
        scheduledExecuteAt: createdAt.toISOString(),
        scheduleRevision: 4,
      },
    });

    const retryExecuteAt = new Date(Date.now() - 1_000);
    const retryId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: "legacy-retry" },
      { singletonKey: "legacy-retry", startAfter: retryExecuteAt },
    );
    const [active] = await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, { includeMetadata: true });
    expect(active?.id).toBe(retryId);
    await pgBoss.client.fail(SCHEDULED_MESSAGE_QUEUE, active!.id);
    const legacyRetry = await findJob("legacy-retry");
    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: "legacy-retry",
        executeAt: retryExecuteAt,
        revision: 2,
      }),
    ).resolves.toBe("CURRENT");
    await expect(findJob("legacy-retry")).resolves.toMatchObject({
      id: legacyRetry?.id,
      state: "retry",
      retryCount: legacyRetry?.retryCount,
      startAfter: legacyRetry?.startAfter,
      data: {
        scheduledActionId: "legacy-retry",
        scheduledExecuteAt: retryExecuteAt.toISOString(),
        scheduleRevision: 2,
      },
    });
  });

  it("cancels a stale legacy active delivery before inserting the current projection", async () => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const oldAt = new Date(Date.now() - 1_000);
    const currentAt = new Date(Date.now() + 60_000);
    const oldId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: "legacy-active" },
      { singletonKey: "legacy-active", startAfter: oldAt },
    );
    const [active] = await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, { includeMetadata: true });
    expect(active?.id).toBe(oldId);

    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: "legacy-active",
        executeAt: currentAt,
        revision: 1,
      }),
    ).resolves.toBe("CURRENT");

    const jobs = await findJobsForAction("legacy-active");
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: oldId, state: "cancelled" }),
        expect.objectContaining({
          state: "created",
          startAfter: currentAt,
          data: {
            scheduledActionId: "legacy-active",
            scheduledExecuteAt: currentAt.toISOString(),
            scheduleRevision: 1,
          },
        }),
      ]),
    );
  });

  it("read-confirms an ambiguous upsert without issuing a second mutation", async () => {
    const calls = { upsert: 0 };
    const boss = proxyBoss(async (original, args) => {
      calls.upsert += 1;
      await Reflect.apply(original, pgBoss.client, args);
      throw new Error("injected response loss after commit");
    });
    const controller = createControllerWithBoss(boss, createDiscord());
    await controller.ensureQueue();
    const executeAt = new Date(Date.now() + 60_000);

    await expect(
      controller.ensureScheduledMessageDelivery({
        scheduledActionId: "ambiguous-upsert",
        executeAt,
        revision: 3,
      }),
    ).resolves.toBe("CURRENT");
    expect(calls.upsert).toBe(1);
    await expect(findJobsForAction("ambiguous-upsert")).resolves.toEqual([
      expect.objectContaining({
        state: "created",
        startAfter: executeAt,
        data: {
          scheduledActionId: "ambiguous-upsert",
          scheduledExecuteAt: executeAt.toISOString(),
          scheduleRevision: 3,
        },
      }),
    ]);
  });

  it("keeps a committed reschedule authoritative when pg-boss repair is unconfirmed", async () => {
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const originalAt = new Date(Date.now() + 60_000);
    const definition = await createScheduledMessage("repair-failure-authority", originalAt);
    await controller.ensureScheduledMessageDelivery({
      scheduledActionId: definition.action.id,
      executeAt: originalAt,
      revision: definition.revision,
    });
    const newExecuteAt = new Date(originalAt.getTime() + 60_000);
    const changed = await messages.reschedule({
      scheduledActionId: definition.action.id,
      guildId,
      channelId: definition.action.targetId,
      actorId: "administrator-id",
      expectedRevision: definition.revision,
      executeAt: newExecuteAt,
      auditId: "repair-failure-authority-audit",
      occurredAt: new Date(),
    });
    expect(changed).toMatchObject({ outcome: "RESCHEDULED", definition: { revision: 1 } });
    const failingController = createControllerWithBoss(
      proxyBoss(() => Promise.reject(new Error("injected pg-boss mutation failure"))),
      createDiscord(),
    );

    await expect(
      failingController.ensureScheduledMessageDelivery({
        scheduledActionId: definition.action.id,
        executeAt: newExecuteAt,
        revision: 1,
      }),
    ).resolves.toBe("PENDING_RECONCILIATION");
    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      revision: 1,
      action: { executeAt: newExecuteAt, status: "ACTIVE" },
    });
    await expect(findJob(definition.action.id)).resolves.toMatchObject({
      state: "created",
      startAfter: originalAt,
    });
  });

  it("advances the authoritative retry count and succeeds on the pg-boss retry", async () => {
    const scheduledActionId = "retry-then-success";
    const dueAt = new Date(Date.now() - 1_000);
    const definition = await messages.create({
      scheduledActionId,
      auditId: "retry-created-audit",
      guildId,
      channelId: "channel-id",
      actorId: "creator-id",
      executeAt: dueAt,
      payload: { content: "content", embed: null },
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    const discord = createDiscord();
    discord.preflight.mockResolvedValueOnce({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(scheduledActionId);
      return (
        current?.action.status === "ACTIVE" &&
        current.retryCount === 1 &&
        (await findJob(scheduledActionId))?.state === "retry"
      );
    });
    const retryJob = await findJob(scheduledActionId);
    await pgBoss.client.update(SCHEDULED_MESSAGE_QUEUE, undefined, {
      id: retryJob!.id,
      startAfter: new Date(0),
    });
    notifyWorkers();

    await waitFor(async () => {
      const current = await messages.find(scheduledActionId);
      const job = await findJob(scheduledActionId);
      return current?.action.status === "COMPLETED" && job?.state === "completed";
    });
    await expect(messages.find(scheduledActionId)).resolves.toMatchObject({
      retryCount: 1,
      resultMessageId: "message-id-retry-then-success",
    });
    await expect(findJob(scheduledActionId)).resolves.toMatchObject({
      state: "completed",
      retryCount: 1,
    });
    const audits = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, scheduledActionId));
    expect(audits.map((audit) => audit.event).sort()).toEqual([
      "CREATED",
      "EXECUTION_COMPLETED",
      "EXECUTION_RETRY",
    ]);
  });

  it("completes a permanent pre-send failure without application or pg-boss retry", async () => {
    const definition = await createScheduledMessage("permanent-preflight-failure");
    const discord = createDiscord();
    discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "ARCHIVED_THREAD",
      retryable: false,
    });
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const job = await findJob(definition.action.id);
      return current?.action.status === "FAILED" && job?.state === "completed";
    });

    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "FAILED" },
      retryCount: 0,
      resultMessageId: null,
    });
    await expect(findJobsForAction(definition.action.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed", retryCount: 0 }),
    ]);
    const audits = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, definition.action.id));
    expect(audits.filter((audit) => audit.event === "EXECUTION_RETRY")).toHaveLength(0);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "EXECUTION_FAILED", failureCode: "ARCHIVED_THREAD" }),
      ]),
    );
    expect(discord.preflight).toHaveBeenCalledOnce();
    expect(discord.createMessage).not.toHaveBeenCalled();
  });

  it("safely completes a stale delivery for a cancelled application action", async () => {
    const definition = await createScheduledMessage("cancelled-stale-delivery");
    const discord = createDiscord();
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await expect(actions.cancel(definition.action.id)).resolves.toMatchObject({
      status: "CANCELLED",
    });
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const job = await findJob(definition.action.id);
      return current?.action.status === "CANCELLED" && job?.state === "completed";
    });

    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "CANCELLED" },
      retryCount: 0,
      resultMessageId: null,
    });
    await expect(findJobsForAction(definition.action.id)).resolves.toEqual([
      expect.objectContaining({ state: "completed", retryCount: 0 }),
    ]);
    const audits = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, definition.action.id));
    expect(audits.map((audit) => audit.event)).toEqual(["CREATED"]);
    expect(discord.preflight).not.toHaveBeenCalled();
    expect(discord.createMessage).not.toHaveBeenCalled();
  });

  it("allows at most one execution claim when legacy and projected deliveries both arrive", async () => {
    const definition = await createScheduledMessage("legacy-current-duplicate-arrival");
    const discord = createDiscord();
    const realExecutor = createScheduledMessageExecutor({ store: messages, discord });
    const execute = vi.fn(realExecutor.execute.bind(realExecutor));
    const controller = createScheduledMessageWorkerController({
      boss: pgBoss.client,
      scheduledActions: actions,
      executor: { execute },
      logger: createLogger(),
    });
    controllers.push(controller);
    await controller.ensureQueue();
    const legacyId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: definition.action.id },
      {
        singletonKey: `${definition.action.id}-legacy`,
        startAfter: definition.action.executeAt,
      },
    );
    const projectedId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      {
        scheduledActionId: definition.action.id,
        scheduledExecuteAt: definition.action.executeAt.toISOString(),
        scheduleRevision: definition.revision,
      },
      {
        singletonKey: `${definition.action.id}-projected`,
        startAfter: definition.action.executeAt,
      },
    );
    expect(legacyId).not.toBeNull();
    expect(projectedId).not.toBeNull();
    await controller.start();

    await waitFor(async () => {
      const jobs = await pgBoss.client.findJobs(SCHEDULED_MESSAGE_QUEUE);
      return [legacyId, projectedId].every((id) =>
        jobs.some((job) => job.id === id && job.state === "completed"),
      );
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(discord.createMessage).toHaveBeenCalledOnce();
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, definition.action.id)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "CREATED" }),
        expect.objectContaining({ event: "EXECUTION_COMPLETED" }),
      ]),
    );
    const audits = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, definition.action.id));
    expect(audits.filter((audit) => audit.event === "EXECUTION_COMPLETED")).toHaveLength(1);
  });

  it("skips a retained real delivery after authoritative cancellation when cleanup is unconfirmed", async () => {
    const scheduledActionId = "cancelled-unconfirmed-cleanup";
    const definition = await createScheduledMessage(scheduledActionId);
    const discord = createDiscord();
    const realExecutor = createScheduledMessageExecutor({ store: messages, discord });
    const execute = vi.fn(realExecutor.execute.bind(realExecutor));
    const deliveryController = createScheduledMessageWorkerController({
      boss: pgBoss.client,
      scheduledActions: actions,
      executor: { execute },
      logger: createLogger(),
    });
    controllers.push(deliveryController);
    await deliveryController.ensureQueue();
    await expect(ensureDelivery(deliveryController, definition)).resolves.toBe("CURRENT");
    await expect(findJob(scheduledActionId)).resolves.toMatchObject({ state: "created" });

    const cancellationAt = new Date("2026-09-17T03:04:05.678Z");
    const cancel = vi.fn(() => Promise.reject(new Error("injected pg-boss cancel failure")));
    const cleanupFailureBoss = new Proxy(pgBoss.client, {
      get(target, property): unknown {
        if (property === "cancel") return cancel;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const cleanupController = createScheduledMessageWorkerController({
      boss: cleanupFailureBoss,
      scheduledActions: actions,
      executor: { execute },
      logger: createLogger(),
    });
    controllers.push(cleanupController);
    const command = createScheduledMessageCommandService({
      discord: {
        authorizeCreation: vi.fn<ScheduledMessageCreationDiscord["authorizeCreation"]>(() =>
          Promise.resolve({ outcome: "AUTHORIZED" }),
        ),
      },
      store: messages,
      delivery: cleanupController,
      logger: createLogger(),
      generateId: () => "cancelled-unconfirmed-cleanup-audit",
      now: () => cancellationAt,
    });
    await expect(
      command.cancel({
        scheduledActionId,
        guildId,
        channelId: "channel-id",
        actorUserId: "cancelling-user",
      }),
    ).resolves.toEqual({ outcome: "CANCELLED", deliveryCleanupPending: true });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(findJob(scheduledActionId)).resolves.toMatchObject({ state: "created" });
    const cancelledDefinition = await messages.find(scheduledActionId);
    expect(cancelledDefinition).toMatchObject({
      action: { status: "CANCELLED" },
      retryCount: 0,
      payload: definition.payload,
      resultMessageId: null,
    });
    const auditsAfterCancellation = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, scheduledActionId))
      .orderBy(scheduledMessageAudits.id);
    expect(auditsAfterCancellation.map((audit) => audit.event).sort()).toEqual([
      "CANCELLED",
      "CREATED",
    ]);
    expect(auditsAfterCancellation.filter((audit) => audit.event === "CANCELLED")).toEqual([
      expect.objectContaining({
        id: "cancelled-unconfirmed-cleanup-audit",
        scheduledActionId,
        guildId,
        channelId: "channel-id",
        actorType: "USER",
        actorId: "cancelling-user",
        executeAt: definition.action.executeAt,
        content: definition.payload.content,
        embedTitle: null,
        embedDescription: null,
        embedColor: null,
        embedImageUrl: null,
        occurredAt: cancellationAt,
        outcome: "SUCCESS",
        failureCode: null,
        resultMessageId: null,
      }),
    ]);

    const workerController = createScheduledMessageWorkerController({
      boss: pgBoss.client,
      scheduledActions: actions,
      executor: { execute },
      logger: createLogger(),
    });
    controllers.push(workerController);
    await workerController.start();
    await waitFor(async () => (await findJob(scheduledActionId))?.state === "completed");

    await expect(messages.find(scheduledActionId)).resolves.toEqual(cancelledDefinition);
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, scheduledActionId))
        .orderBy(scheduledMessageAudits.id),
    ).resolves.toEqual(auditsAfterCancellation);
    await expect(findJob(scheduledActionId)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(discord.preflight).not.toHaveBeenCalled();
    expect(discord.createMessage).not.toHaveBeenCalled();
  });

  it("completes pg-boss delivery for terminal post-create compensation", async () => {
    const scheduledActionId = "compensated-finalization";
    const dueAt = new Date(Date.now() - 1_000);
    const definition = await messages.create({
      scheduledActionId,
      auditId: "compensated-created-audit",
      guildId,
      channelId: "channel-id",
      actorId: "creator-id",
      executeAt: dueAt,
      payload: { content: "content", embed: null },
      occurredAt: new Date("2026-01-01T00:00:00Z"),
    });
    const discord = createDiscord();
    const executor = createScheduledMessageExecutor({
      store: {
        ...messages,
        finalizeSuccess: vi.fn<ScheduledMessageStore["finalizeSuccess"]>(() =>
          Promise.resolve("PROVEN_UNCOMMITTED"),
        ),
      },
      discord,
    });
    const controller = createScheduledMessageWorkerController({
      boss: pgBoss.client,
      scheduledActions: actions,
      executor,
      logger: createLogger(),
    });
    controllers.push(controller);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(scheduledActionId);
      const job = await findJob(scheduledActionId);
      return current?.action.status === "FAILED" && job?.state === "completed";
    });
    await expect(messages.find(scheduledActionId)).resolves.toMatchObject({
      retryCount: 0,
      resultMessageId: null,
    });
    await expect(findJob(scheduledActionId)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, scheduledActionId)),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "EXECUTION_FAILED",
          failureCode: "FINALIZATION_FAILED_COMPENSATED",
          resultMessageId: null,
        }),
      ]),
    );
  });

  it("completes delivery without retry after a confirmed Create Message rejection", async () => {
    const definition = await createScheduledMessage("confirmed-create-rejection");
    const discord = createDiscord();
    discord.createMessage.mockResolvedValue({ outcome: "REJECTED" });
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const job = await findJob(definition.action.id);
      return current?.action.status === "FAILED" && job?.state === "completed";
    });
    await expect(findJob(definition.action.id)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
    expect(discord.createMessage).toHaveBeenCalledOnce();
    await expectFailureAudit(definition.action.id, "SEND_REJECTED");
  });

  it("uses one immediate replay but no pg-boss retry after ambiguous Create Message", async () => {
    const definition = await createScheduledMessage("ambiguous-create");
    const discord = createDiscord();
    discord.createMessage.mockResolvedValue({ outcome: "AMBIGUOUS" });
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const job = await findJob(definition.action.id);
      return current?.action.status === "FAILED" && job?.state === "completed";
    });
    await expect(findJob(definition.action.id)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
    expect(discord.createMessage).toHaveBeenCalledTimes(2);
    expect(discord.createMessage.mock.calls[1]?.[0]).toEqual(
      discord.createMessage.mock.calls[0]?.[0],
    );
    await expectFailureAudit(definition.action.id, "SEND_UNCONFIRMED");
  });

  it("completes delivery terminally after returned-message mismatch compensation", async () => {
    const definition = await createScheduledMessage("returned-message-mismatch");
    const discord = createDiscord();
    discord.createMessage.mockImplementation((input) =>
      Promise.resolve({
        outcome: "CREATED",
        message: {
          guildId,
          channelId: "different-channel",
          messageId: "mismatched-message-id",
          authorId: "bot-id",
          nonce: input.nonce,
          createdAt: new Date(),
          payload: input.payload,
        },
      }),
    );
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const job = await findJob(definition.action.id);
      return current?.action.status === "FAILED" && job?.state === "completed";
    });
    await expect(findJob(definition.action.id)).resolves.toMatchObject({
      state: "completed",
      retryCount: 0,
    });
    expect(discord.deleteMessage).toHaveBeenCalledOnce();
    await expectFailureAudit(definition.action.id, "RETURNED_MESSAGE_MISMATCH");
  });

  it("keeps the application retry budget bounded across a recreated delivery cycle", async () => {
    let definition = await createScheduledMessage("retry-budget-recreated-cycle");
    for (let expectedRetryCount = 1; expectedRetryCount <= 3; expectedRetryCount += 1) {
      const claim = await messages.claimExecution(definition.action.id, definition.revision);
      if (claim.outcome !== "COMMITTED") throw new Error("retry budget preparation claim failed");
      const retried = await messages.retryPreSendFailure({
        definition: claim.definition,
        auditId: `retry-budget-preparation-${expectedRetryCount}`,
        occurredAt: new Date(),
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      });
      if (retried.outcome !== "COMMITTED") {
        throw new Error("retry budget preparation transition failed");
      }
      definition = retried.definition;
    }
    expect(definition).toMatchObject({ action: { status: "ACTIVE" }, retryCount: 3 });

    const discord = createDiscord();
    discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
    const controller = createController(discord);
    await controller.ensureQueue();
    const historicalJobId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: definition.action.id },
      {
        singletonKey: definition.action.id,
        startAfter: definition.action.executeAt,
        retryLimit: 0,
      },
    );
    expect(historicalJobId).not.toBeNull();
    const [historicalJob] = await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, {
      includeMetadata: true,
    });
    expect(historicalJob?.id).toBe(historicalJobId);
    await pgBoss.client.fail(SCHEDULED_MESSAGE_QUEUE, historicalJob!.id);

    await expect(ensureDelivery(controller, definition)).resolves.toBe("CURRENT");
    await controller.start();

    await waitFor(async () => {
      const current = await messages.find(definition.action.id);
      const jobs = await findJobsForAction(definition.action.id);
      return (
        current?.action.status === "FAILED" &&
        jobs.some((job) => job.id !== historicalJobId && job.state === "completed")
      );
    });

    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "FAILED" },
      retryCount: 3,
      resultMessageId: null,
    });
    const jobs = await findJobsForAction(definition.action.id);
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: historicalJobId, state: "failed" }),
        expect.objectContaining({ state: "completed", retryCount: 0 }),
      ]),
    );
    const audits = await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, definition.action.id));
    expect(audits.filter((audit) => audit.event === "EXECUTION_RETRY")).toHaveLength(3);
    expect(audits).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "EXECUTION_FAILED",
          failureCode: "CURRENT_STATE_CHECK_FAILED",
        }),
      ]),
    );
    expect(discord.preflight).toHaveBeenCalledOnce();
    expect(discord.createMessage).not.toHaveBeenCalled();
  });

  it("terminally recovers interrupted EXECUTING before ACTIVE reconciliation", async () => {
    const definition = await createScheduledMessage("startup-interrupted");
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    const claim = await messages.claimExecution(definition.action.id, definition.revision);
    expect(claim.outcome).toBe("COMMITTED");
    await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, { includeMetadata: true });
    const execute = vi.fn(() => Promise.reject(new Error("startup recovery must not execute")));
    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: actions,
      store: messages,
      executor: { execute },
      delivery: controller,
      logger: createLogger(),
    });

    await reconciler.recoverAtStartup();

    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "FAILED" },
      retryCount: 0,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(
      (await findJobsForAction(definition.action.id)).some((job) => job.state === "active"),
    ).toBe(false);
    await expectFailureAudit(definition.action.id, "EXECUTION_INTERRUPTED_UNCONFIRMED");
  });

  it("repairs missing ACTIVE delivery and preserves an existing created delivery", async () => {
    const definition = await createScheduledMessage(
      "startup-active-repair",
      new Date(Date.now() + 60_000),
    );
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: actions,
      store: messages,
      executor: { execute: vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const })) },
      delivery: controller,
      logger: createLogger(),
    });

    await reconciler.recoverAtStartup();
    const [created] = await findJobsForAction(definition.action.id);
    expect(created).toMatchObject({
      state: "created",
      singletonKey: definition.action.id,
      startAfter: definition.action.executeAt,
    });

    await reconciler.recoverAtStartup();
    await expect(findJobsForAction(definition.action.id)).resolves.toEqual([
      expect.objectContaining({ id: created!.id, state: "created" }),
    ]);
  });

  it("preserves an existing retry delivery during ACTIVE startup reconciliation", async () => {
    const definition = await createScheduledMessage("startup-retry-preserved");
    const discord = createDiscord();
    discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
    const controller = createController(discord);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();
    await waitFor(async () => (await findJob(definition.action.id))?.state === "retry");
    const retryJob = await findJob(definition.action.id);
    await controller.stop();

    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: actions,
      store: messages,
      executor: createScheduledMessageExecutor({ store: messages, discord }),
      delivery: controller,
      logger: createLogger(),
    });
    await reconciler.recoverAtStartup();

    await expect(findJobsForAction(definition.action.id)).resolves.toEqual([
      expect.objectContaining({ id: retryJob!.id, state: "retry" }),
    ]);
    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "ACTIVE" },
      retryCount: 1,
    });
  });

  it("repairs ACTIVE delivery despite terminal pg-boss history", async () => {
    const definition = await createScheduledMessage("terminal-history-not-authority");
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const oldJobId = await pgBoss.client.send(
      SCHEDULED_MESSAGE_QUEUE,
      { scheduledActionId: definition.action.id },
      {
        singletonKey: definition.action.id,
        startAfter: definition.action.executeAt,
        retryLimit: 0,
      },
    );
    expect(oldJobId).not.toBeNull();
    const [fetched] = await pgBoss.client.fetch(SCHEDULED_MESSAGE_QUEUE, {
      includeMetadata: true,
    });
    await pgBoss.client.fail(SCHEDULED_MESSAGE_QUEUE, fetched!.id);
    const reconciler = createScheduledMessageStartupReconciler({
      scheduledActions: actions,
      store: messages,
      executor: { execute: vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const })) },
      delivery: controller,
      logger: createLogger(),
    });

    await reconciler.recoverAtStartup();

    const jobs = await findJobsForAction(definition.action.id);
    expect(jobs.filter((job) => job.state === "failed")).toHaveLength(1);
    expect(jobs.filter((job) => job.state === "created" || job.state === "retry")).toHaveLength(1);
    await expect(messages.find(definition.action.id)).resolves.toMatchObject({
      action: { status: "ACTIVE" },
    });
  });

  it("runtime reconciliation excludes EXECUTING and compensated FAILED actions", async () => {
    const executing = await createScheduledMessage("runtime-executing");
    const executingClaim = await messages.claimExecution(executing.action.id, executing.revision);
    expect(executingClaim.outcome).toBe("COMMITTED");
    const failed = await createScheduledMessage("runtime-failed-compensated");
    const failedClaim = await messages.claimExecution(failed.action.id, failed.revision);
    if (failedClaim.outcome !== "COMMITTED") throw new Error("failed action claim failed");
    await messages.failExecution({
      definition: failedClaim.definition,
      auditId: "runtime-failed-compensated-audit",
      occurredAt: new Date(),
      failureCode: "FINALIZATION_FAILED_COMPENSATED",
      resultMessageId: null,
    });
    const active = await createScheduledMessage(
      "runtime-active-control",
      new Date(Date.now() + 60_000),
    );
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const execute = vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const }));
    const reconciler = createScheduledMessageRuntimeReconciler({
      scheduledActions: actions,
      store: messages,
      executor: { execute },
      delivery: controller,
      logger: createLogger(),
    });

    await reconciler.reconcileOnce();

    await expect(findJobsForAction(executing.action.id)).resolves.toEqual([]);
    await expect(findJobsForAction(failed.action.id)).resolves.toEqual([]);
    await expect(findJobsForAction(active.action.id)).resolves.toEqual([
      expect.objectContaining({ state: "created", singletonKey: active.action.id }),
    ]);
    expect(execute).not.toHaveBeenCalled();
    await reconciler.stop();
  });

  it("drains an in-flight worker before shutdown completes", async () => {
    const definition = await createScheduledMessage("worker-shutdown-drain");
    const gate = createDeferred<void>();
    const execute = vi.fn(async () => {
      await gate.promise;
      return { outcome: "UNCONFIRMED" as const, code: "SEND_UNCONFIRMED" as const };
    });
    const controller = createScheduledMessageWorkerController({
      boss: pgBoss.client,
      scheduledActions: actions,
      executor: { execute },
      logger: createLogger(),
    });
    controllers.push(controller);
    await controller.ensureQueue();
    await ensureDelivery(controller, definition);
    await controller.start();
    await waitFor(() => execute.mock.calls.length === 1);

    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    await waitFor(async () => (await findJob(definition.action.id))?.state === "completed");
  });

  it("drains an in-flight runtime reconciliation before shutdown completes", async () => {
    const definition = await createScheduledMessage(
      "reconciler-shutdown-drain",
      new Date(Date.now() + 60_000),
    );
    const controller = createController(createDiscord());
    await controller.ensureQueue();
    const gate = createDeferred<void>();
    const entered = createDeferred<void>();
    const reconciler = createScheduledMessageRuntimeReconciler({
      scheduledActions: actions,
      store: messages,
      executor: { execute: vi.fn(() => Promise.resolve({ outcome: "SUCCESS" as const })) },
      delivery: {
        ensureScheduledMessageDelivery: async (projection) => {
          entered.resolve();
          await gate.promise;
          return controller.ensureScheduledMessageDelivery(projection);
        },
      },
      logger: createLogger(),
    });
    const sweep = reconciler.reconcileOnce();
    await entered.promise;

    let stopped = false;
    const stopping = reconciler.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await Promise.all([sweep, stopping]);
    expect(stopped).toBe(true);
    await expect(findJobsForAction(definition.action.id)).resolves.toEqual([
      expect.objectContaining({ state: "created", singletonKey: definition.action.id }),
    ]);
  });
});

function createDiscord() {
  const target = { guildId, channelId: "channel-id", botUserId: "bot-id", token: {} };
  return {
    preflight: vi.fn<ScheduledMessageDiscord["preflight"]>(() =>
      Promise.resolve({ outcome: "READY", target }),
    ),
    createMessage: vi.fn<ScheduledMessageDiscord["createMessage"]>((input) =>
      Promise.resolve({
        outcome: "CREATED",
        message: {
          guildId,
          channelId: "channel-id",
          messageId: `message-id-${input.target.token === target.token ? "retry-then-success" : "other"}`,
          authorId: "bot-id",
          nonce: input.nonce,
          createdAt: new Date("2030-01-01T00:00:00Z"),
          payload: input.payload,
        },
      }),
    ),
    deleteMessage: vi.fn<ScheduledMessageDiscord["deleteMessage"]>(() =>
      Promise.resolve({ outcome: "DELETED" }),
    ),
  } satisfies ScheduledMessageDiscord;
}

function createController(discord: ScheduledMessageDiscord): ScheduledMessageWorkerController {
  return createControllerWithBoss(pgBoss.client, discord);
}

function createControllerWithBoss(
  boss: Parameters<typeof createScheduledMessageWorkerController>[0]["boss"],
  discord: ScheduledMessageDiscord,
): ScheduledMessageWorkerController {
  const executor = createScheduledMessageExecutor({ store: messages, discord });
  const controller = createScheduledMessageWorkerController({
    boss,
    scheduledActions: actions,
    executor,
    logger: createLogger(),
  });
  controllers.push(controller);
  return controller;
}

function proxyBoss(
  upsert: (original: typeof pgBoss.client.upsert, args: unknown[]) => Promise<unknown>,
): typeof pgBoss.client {
  const originalUpsert = pgBoss.client.upsert.bind(pgBoss.client);
  return new Proxy(pgBoss.client, {
    get(target, property): unknown {
      if (property === "upsert") {
        return (...args: unknown[]) => upsert(originalUpsert, args);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function createScheduledMessage(
  scheduledActionId: string,
  executeAt = new Date(Date.now() - 1_000),
) {
  return messages.create({
    scheduledActionId,
    auditId: `${scheduledActionId}-created-audit`,
    guildId,
    channelId: "channel-id",
    actorId: "creator-id",
    executeAt,
    payload: { content: `content-${scheduledActionId}`, embed: null },
    occurredAt: new Date(),
  });
}

function ensureDelivery(
  controller: ScheduledMessageWorkerController,
  definition: Awaited<ReturnType<typeof createScheduledMessage>>,
) {
  return controller.ensureScheduledMessageDelivery({
    scheduledActionId: definition.action.id,
    executeAt: definition.action.executeAt,
    revision: definition.revision,
  });
}

function findJobsForAction(scheduledActionId: string) {
  return pgBoss.client
    .findJobs<{ scheduledActionId: string }>(SCHEDULED_MESSAGE_QUEUE)
    .then((jobs) => jobs.filter((job) => job.singletonKey === scheduledActionId));
}

async function findJob(scheduledActionId: string) {
  return (await findJobsForAction(scheduledActionId))[0];
}

async function expectFailureAudit(scheduledActionId: string, failureCode: string): Promise<void> {
  await expect(
    database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.scheduledActionId, scheduledActionId)),
  ).resolves.toEqual(
    expect.arrayContaining([expect.objectContaining({ event: "EXECUTION_FAILED", failureCode })]),
  );
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function notifyWorkers(): void {
  for (const worker of pgBoss.client
    .getWipData()
    .filter((candidate) => candidate.name === SCHEDULED_MESSAGE_QUEUE)) {
    pgBoss.client.notifyWorker(worker.id);
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error("Timed out waiting for pg-boss integration state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(managedMessageAudits)
    .where(eq(managedMessageAudits.guildId, guildId));
  await database.client.delete(managedMessages).where(eq(managedMessages.guildId, guildId));
  await database.client
    .delete(scheduledMessageAudits)
    .where(eq(scheduledMessageAudits.guildId, guildId));
  const rows = await database.client
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(eq(scheduledActions.guildId, guildId));
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await database.client
      .delete(scheduledMessageStates)
      .where(inArray(scheduledMessageStates.scheduledActionId, ids));
    await database.client.delete(scheduledActions).where(inArray(scheduledActions.id, ids));
  }
}

function createLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}
