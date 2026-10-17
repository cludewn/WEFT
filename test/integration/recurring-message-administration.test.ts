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
} from "../../src/messages/recurring-message-execution.js";
import { createRecurringRuntimeStore } from "../../src/messages/recurring-message-runtime-persistence.js";
import {
  createRecurringMessageWorker,
  RECURRING_MESSAGE_QUEUE,
  type RecurringMessageWorker,
  type RecurringProjection,
} from "../../src/messages/recurring-message-worker.js";
import { createScheduledMessageAdministrationStore } from "../../src/messages/scheduled-message-administration-persistence.js";
import { createScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import type { ScheduledMessageStore } from "../../src/messages/scheduled-message-persistence.js";
import type { ScheduledMessageWorkerController } from "../../src/messages/scheduled-message-worker.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "../../src/messages/recurring-message-persistence.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/messages/scheduled-message-persistence.js";

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
    expect(list.schedules.map((item) => item.kind)).toEqual(["RECURRING", "ONE_TIME"]);
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
    expect(first.hasNext).toBe(true);
    expect(second.hasNext).toBe(false);
    expect(first.schedules).toHaveLength(10);
    expect(second.schedules).toHaveLength(3);
    expect(first.schedules.map((row) => row.scheduledActionId)).toEqual([
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
    expect(second.schedules.map((row) => row.scheduledActionId)).toEqual([
      "admin-page-09",
      "admin-page-10",
      "admin-page-11",
    ]);
  });

  it.each([0, 1, 10, 11, 20, 21])(
    "looks ahead across %i combined rows with stable equal-time ID ordering",
    async (count) => {
      const expected = Array.from(
        { length: count },
        (_, i) => `admin-boundary-${i.toString().padStart(2, "0")}`,
      );
      for (let index = count - 1; index >= 0; index--) {
        const id = expected[index]!;
        if (index % 2 === 0) {
          await oneTime.create({
            scheduledActionId: id,
            auditId: `${id}-audit`,
            guildId,
            channelId,
            actorId: "actor",
            executeAt: new Date("2030-01-01T09:00:00Z"),
            occurredAt: establishedAt,
            payload: { content: "private", embed: null },
          });
        } else {
          await recurring.create({
            scheduledActionId: id,
            occurrenceId: `${id}-occurrence`,
            auditId: `${id}-audit`,
            gapAuditIds: [],
            guildId,
            channelId,
            actorId: "actor",
            payload: { content: "private", embed: null },
            recurrence: {
              frequency: "DAILY",
              weekdayMask: 127,
              localTime: "09:00",
              timezone: "UTC",
            },
            effectiveAt: establishedAt,
          });
        }
      }
      const before = await administrationSnapshot();
      for (let page = 1; page <= 4; page++) {
        const result = await administration.listCombined(guildId, channelId, (page - 1) * 10);
        expect(result.hasNext).toBe(count > page * 10);
        expect(result.schedules.map((row) => row.scheduledActionId)).toEqual(
          expected.slice((page - 1) * 10, page * 10),
        );
        expect(result.schedules.every((row) => !("payload" in row) && !("content" in row))).toBe(
          true,
        );
      }
      expect(await administration.listCombined("wrong-guild", channelId, 0)).toEqual({
        outcome: "FOUND",
        schedules: [],
        hasNext: false,
      });
      expect(await administration.listCombined(guildId, "wrong-channel", 0)).toEqual({
        outcome: "FOUND",
        schedules: [],
        hasNext: false,
      });
      expect(await administrationSnapshot()).toEqual(before);
    },
  );

  it("keeps one row per active series with terminal history and with no current occurrence", async () => {
    for (const id of ["admin-history-current", "admin-history-none"]) {
      await recurring.create({
        scheduledActionId: id,
        occurrenceId: `${id}-current`,
        auditId: `${id}-audit`,
        gapAuditIds: [],
        guildId,
        channelId,
        actorId: "actor",
        payload: { content: "private", embed: null },
        recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "09:00", timezone: "UTC" },
        effectiveAt: establishedAt,
      });
      for (const day of [28, 29, 30]) {
        await database.client.insert(recurringMessageOccurrences).values({
          id: `${id}-history-${day}`,
          scheduledActionId: id,
          materializedDefinitionRevision: 0,
          intendedLocalDate: `2029-12-${day}`,
          intendedLocalTime: "09:00",
          scheduledFor: new Date(`2029-12-${day}T09:00:00Z`),
          status: "SKIPPED",
          skipReason: "MISSED_GRACE_EXCEEDED",
          terminalAt: establishedAt,
        });
      }
    }
    await database.client
      .update(recurringMessageOccurrences)
      .set({ status: "SKIPPED", skipReason: "MISSED_GRACE_EXCEEDED", terminalAt: establishedAt })
      .where(eq(recurringMessageOccurrences.id, "admin-history-none-current"));
    const before = await administrationSnapshot();
    const result = await administration.listCombined(guildId, channelId, 0);
    expect(result.hasNext).toBe(false);
    expect(result.schedules).toHaveLength(2);
    expect(result.schedules).toMatchObject([
      { scheduledActionId: "admin-history-current", currentOccurrenceStatus: "PENDING" },
      { scheduledActionId: "admin-history-none", currentOccurrenceStatus: null },
    ]);
    expect(await administrationSnapshot()).toEqual(before);
  });

  it("preserves one-time and recurring eligibility filters", async () => {
    for (const status of ["ACTIVE", "EXECUTING", "CANCELLED", "COMPLETED", "FAILED"] as const) {
      const one = `admin-filter-one-${status}`;
      await oneTime.create({
        scheduledActionId: one,
        auditId: `${one}-audit`,
        guildId,
        channelId,
        actorId: "actor",
        executeAt: establishedAt,
        occurredAt: establishedAt,
        payload: { content: "private", embed: null },
      });
      await database.client
        .update(scheduledActions)
        .set({ status })
        .where(eq(scheduledActions.id, one));
      const series = `admin-filter-recurring-${status}`;
      await recurring.create({
        scheduledActionId: series,
        occurrenceId: `${series}-current`,
        auditId: `${series}-audit`,
        gapAuditIds: [],
        guildId,
        channelId,
        actorId: "actor",
        payload: { content: "private", embed: null },
        recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "09:00", timezone: "UTC" },
        effectiveAt: establishedAt,
      });
      await database.client
        .update(scheduledActions)
        .set({ status })
        .where(eq(scheduledActions.id, series));
    }
    await database.client.insert(scheduledActions).values({
      id: "admin-filter-thread",
      guildId,
      targetId: channelId,
      actionType: "CLOSE_THREAD",
      status: "ACTIVE",
      executeAt: establishedAt,
    });
    const result = await administration.listCombined(guildId, channelId, 0);
    expect(result.schedules.map((row) => row.scheduledActionId)).toEqual([
      "admin-filter-one-ACTIVE",
      "admin-filter-one-EXECUTING",
      "admin-filter-recurring-ACTIVE",
    ]);
    const fallback = await oneTime.listNonterminal(guildId, channelId, 0);
    if (fallback.outcome !== "FOUND") throw new Error("Expected fallback list");
    expect(fallback.hasNext).toBe(false);
    expect(fallback.schedules.map((row) => row.scheduledActionId)).toEqual([
      "admin-filter-one-ACTIVE",
      "admin-filter-one-EXECUTING",
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

async function administrationSnapshot() {
  return {
    actions: await database.client
      .select()
      .from(scheduledActions)
      .where(eq(scheduledActions.guildId, guildId))
      .orderBy(asc(scheduledActions.id)),
    messageAudits: await database.client
      .select()
      .from(scheduledMessageAudits)
      .where(eq(scheduledMessageAudits.guildId, guildId))
      .orderBy(asc(scheduledMessageAudits.id)),
    recurringAudits: await database.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.guildId, guildId))
      .orderBy(asc(recurringMessageAudits.id)),
  };
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
