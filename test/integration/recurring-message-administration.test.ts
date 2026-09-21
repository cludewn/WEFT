import { randomUUID } from "node:crypto";

import { asc, eq, inArray } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Logger } from "pino";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createPgBossRuntime } from "../../src/pg-boss.js";
import {
  createRecurringMessageExecutor,
  type RecurringDelivery,
} from "../../src/recurring-message-execution.js";
import { createRecurringRuntimeStore } from "../../src/recurring-message-runtime-persistence.js";
import {
  createRecurringMessageWorker,
  RECURRING_MESSAGE_QUEUE,
  type RecurringMessageWorker,
  type RecurringProjection,
} from "../../src/recurring-message-worker.js";
import { createScheduledMessageAdministrationStore } from "../../src/scheduled-message-administration-persistence.js";
import { createScheduledMessageCommandService } from "../../src/scheduled-message-command.js";
import type { ScheduledMessageStore } from "../../src/scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "../../src/scheduled-message-worker.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "../../src/recurring-message-persistence.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/scheduled-message-persistence.js";

const guildId = "recurring-admin-guild";
const channelId = "recurring-admin-channel";
const establishedAt = new Date("2030-01-01T00:00:00.000Z");
const database = createDatabase(loadTestDatabaseConfig());
const administration = createScheduledMessageAdministrationStore(database.client);
const recurring = createRecurringMessageStore(database.client);
const oneTime = createScheduledMessageStore(database.client);

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("combined scheduled-message administration", () => {
  it("routes kinds and reads recurring status without payload", async () => {
    await oneTime.create({
      scheduledActionId: "admin-one",
      auditId: "admin-one-audit",
      guildId,
      channelId,
      actorId: "actor",
      executeAt: new Date("2030-01-02T12:00:00.000Z"),
      payload: { content: "one-time-secret", embed: null },
      occurredAt: establishedAt,
    });
    const created = await recurring.create({
      scheduledActionId: "admin-recurring",
      occurrenceId: "admin-occurrence",
      auditId: "admin-recurring-audit",
      gapAuditIds: [],
      guildId,
      channelId,
      actorId: "actor",
      payload: { content: "recurring-secret", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: 127,
        localTime: "09:00",
        timezone: "Asia/Tokyo",
      },
      effectiveAt: establishedAt,
    });
    expect(created.outcome).toBe("COMMITTED");
    expect(await administration.findKind("admin-one", guildId, channelId)).toBe("ONE_TIME");
    expect(await administration.findKind("admin-recurring", guildId, channelId)).toBe("RECURRING");
    expect(await administration.findKind("admin-recurring", guildId, "wrong-channel")).toBeNull();
    const status = await administration.findRecurringStatus("admin-recurring", guildId, channelId);
    expect(status).toMatchObject({
      kind: "RECURRING",
      status: "ACTIVE",
      frequency: "DAILY",
      timezone: "Asia/Tokyo",
      currentOccurrenceId: "admin-occurrence",
      currentOccurrenceStatus: "PENDING",
      retryCount: 0,
    });
    expect(JSON.stringify(status)).not.toContain("recurring-secret");
    expect(
      await administration.findRecurringStatus("admin-recurring", "wrong-guild", channelId),
    ).toBeNull();
    const list = await administration.listCombined(guildId, channelId, 0);
    expect(list.map((item) => item.kind)).toEqual(["RECURRING", "ONE_TIME"]);
    expect(JSON.stringify(list)).not.toContain("secret");
  });

  it("orders and paginates the combined set before applying the limit", async () => {
    for (let index = 0; index < 12; index += 1) {
      await oneTime.create({
        scheduledActionId: `admin-page-${index.toString().padStart(2, "0")}`,
        auditId: `admin-page-audit-${index}`,
        guildId,
        channelId,
        actorId: "actor",
        executeAt: new Date(establishedAt.getTime() + (index + 1) * 60_000),
        payload: { content: "private", embed: null },
        occurredAt: establishedAt,
      });
    }
    await recurring.create({
      scheduledActionId: "admin-page-recurring",
      occurrenceId: "admin-page-occurrence",
      auditId: "admin-page-recurring-audit",
      gapAuditIds: [],
      guildId,
      channelId,
      actorId: "actor",
      payload: { content: "private", embed: null },
      recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "00:05", timezone: "UTC" },
      effectiveAt: establishedAt,
    });
    const first = await administration.listCombined(guildId, channelId, 0);
    const second = await administration.listCombined(guildId, channelId, 10);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(3);
    expect(first.map((row) => row.scheduledActionId)).toEqual([
      "admin-page-00",
      "admin-page-01",
      "admin-page-02",
      "admin-page-03",
      "admin-page-04",
      "admin-page-recurring",
      "admin-page-05",
      "admin-page-06",
      "admin-page-07",
      "admin-page-08",
    ]);
    expect(second.map((row) => row.scheduledActionId)).toEqual([
      "admin-page-09",
      "admin-page-10",
      "admin-page-11",
    ]);
  });

  it("keeps a projection stale after the eligibility read harmless to PostgreSQL and Discord", async () => {
    const scheduledActionId = randomUUID();
    const initialOccurrenceId = randomUUID();
    const created = await recurring.create({
      scheduledActionId,
      occurrenceId: initialOccurrenceId,
      auditId: randomUUID(),
      gapAuditIds: [],
      guildId,
      channelId,
      actorId: "actor",
      payload: { content: "private", embed: null },
      recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "09:00", timezone: "UTC" },
      effectiveAt: establishedAt,
    });
    expect(created.outcome).toBe("COMMITTED");

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const runtime = createPgBossRuntime(loadTestDatabaseConfig(), logger);
    const discord = { preflight: vi.fn(), createMessage: vi.fn(), deleteMessage: vi.fn() };
    const runtimeStore = createRecurringRuntimeStore(database.client);
    const executor = createRecurringMessageExecutor({
      claims: recurring,
      store: runtimeStore,
      discord,
      now: () => new Date("2030-01-01T10:00:00.000Z"),
    });
    const worker = createRecurringMessageWorker({
      boss: runtime.client,
      executor,
      recurring,
      store: runtimeStore,
      logger,
    });
    await runtime.start();
    try {
      await worker.ensureQueue();
      const projectionReached = deferred<{
        projection: RecurringProjection;
        projected: Awaited<ReturnType<RecurringMessageWorker["project"]>>;
      }>();
      const releaseProjection = deferred();
      let eligibleRead: Awaited<ReturnType<typeof administration.findRecurringStatus>> = null;
      const delayedProject: RecurringMessageWorker["project"] = async (projection) => {
        const projected = await worker.project(projection);
        projectionReached.resolve({ projection, projected });
        await releaseProjection.promise;
        return projected;
      };
      const service = createScheduledMessageCommandService({
        discord: { authorizeCreation: vi.fn() },
        store: {} as ScheduledMessageStore,
        delivery: {} as ScheduledMessageWorkerController,
        administration: {
          ...administration,
          async findRecurringStatus(...args) {
            eligibleRead = await administration.findRecurringStatus(...args);
            return eligibleRead;
          },
        },
        recurring,
        recurringWorker: { project: delayedProject },
        logger,
        now: () => new Date("2030-01-01T00:01:00.000Z"),
      });
      const edit = service.editRecurrence({
        scheduledActionId,
        guildId,
        channelId,
        actorUserId: "actor",
        recurrence: { frequency: "daily", time: "10:00" },
      });
      void edit.then(
        (result) =>
          projectionReached.reject(
            new Error(`Recurrence edit ended before projection: ${result.outcome}`),
          ),
        (error: unknown) => projectionReached.reject(error),
      );
      let projection: RecurringProjection;
      try {
        const projectedResult = await projectionReached.promise;
        projection = projectedResult.projection;
        expect(projectedResult.projected).toBe("CURRENT");
        expect(eligibleRead).toMatchObject({
          status: "ACTIVE",
          currentOccurrenceId: projection.delivery.occurrenceId,
          currentOccurrenceStatus: "PENDING",
        });
        const [projectedJob] = await runtime.client.findJobs(RECURRING_MESSAGE_QUEUE, {
          key: `${projection.delivery.occurrenceId}:0`,
        });
        expect(projectedJob).toMatchObject({ state: "created", data: projection.delivery });
        await expect(
          recurring.cancel({
            scheduledActionId,
            actorId: "actor",
            expectedRevision: 1,
            auditId: randomUUID(),
            occurredAt: new Date("2030-01-01T00:02:00.000Z"),
          }),
        ).resolves.toMatchObject({ outcome: "COMMITTED" });
      } finally {
        releaseProjection.resolve();
      }
      await expect(edit).resolves.toMatchObject({ outcome: "COMMITTED" });

      const [job] = await runtime.client.findJobs(RECURRING_MESSAGE_QUEUE, {
        key: `${projection.delivery.occurrenceId}:0`,
      });
      expect(job).toMatchObject({ state: "created", data: projection.delivery });
      if (job === undefined) throw new Error("Stale projection job was not created");

      const beforeExecution = await recurringDbState(scheduledActionId);
      expect(beforeExecution.action?.status).toBe("CANCELLED");
      expect(
        beforeExecution.occurrences.find((row) => row.id === projection.delivery.occurrenceId)
          ?.status,
      ).toBe("SKIPPED");
      await expect(executor.execute(job.data as RecurringDelivery)).resolves.toEqual({
        outcome: "SKIPPED",
      });
      expect(discord.preflight).not.toHaveBeenCalled();
      expect(discord.createMessage).not.toHaveBeenCalled();
      expect(await recurringDbState(scheduledActionId)).toEqual(beforeExecution);
    } finally {
      await runtime.client.deleteAllJobs(RECURRING_MESSAGE_QUEUE);
      await runtime.client.deleteQueue(RECURRING_MESSAGE_QUEUE);
      await runtime.stop();
    }
  });
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function recurringDbState(scheduledActionId: string) {
  const [action] = await database.client
    .select()
    .from(scheduledActions)
    .where(eq(scheduledActions.id, scheduledActionId));
  const [state] = await database.client
    .select()
    .from(scheduledMessageStates)
    .where(eq(scheduledMessageStates.scheduledActionId, scheduledActionId));
  const [definition] = await database.client
    .select()
    .from(recurringMessageSchedules)
    .where(eq(recurringMessageSchedules.scheduledActionId, scheduledActionId));
  const occurrences = await database.client
    .select()
    .from(recurringMessageOccurrences)
    .where(eq(recurringMessageOccurrences.scheduledActionId, scheduledActionId))
    .orderBy(asc(recurringMessageOccurrences.id));
  const audits = await database.client
    .select()
    .from(recurringMessageAudits)
    .where(eq(recurringMessageAudits.scheduledActionId, scheduledActionId))
    .orderBy(asc(recurringMessageAudits.id));
  return { action, state, definition, occurrences, audits };
}

async function cleanup(): Promise<void> {
  const rows = await database.client
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(eq(scheduledActions.guildId, guildId));
  const ids = rows.map((row) => row.id);
  if (ids.length === 0) return;
  await database.client
    .delete(recurringMessageAudits)
    .where(inArray(recurringMessageAudits.scheduledActionId, ids));
  await database.client
    .delete(recurringMessageOccurrences)
    .where(inArray(recurringMessageOccurrences.scheduledActionId, ids));
  await database.client
    .delete(recurringMessageSchedules)
    .where(inArray(recurringMessageSchedules.scheduledActionId, ids));
  await database.client
    .delete(scheduledMessageAudits)
    .where(inArray(scheduledMessageAudits.scheduledActionId, ids));
  await database.client
    .delete(scheduledMessageStates)
    .where(inArray(scheduledMessageStates.scheduledActionId, ids));
  await database.client.delete(scheduledActions).where(inArray(scheduledActions.id, ids));
}
