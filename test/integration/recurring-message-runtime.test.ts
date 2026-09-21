import { and, eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import { managedMessageAudits, managedMessages } from "../../src/managed-message-persistence.js";
import {
  createRecurringMessageStore,
  recurringMessageAudits,
  recurringMessageOccurrences,
  recurringMessageSchedules,
} from "../../src/recurring-message-persistence.js";
import { createRecurringRuntimeStore } from "../../src/recurring-message-runtime-persistence.js";
import { ALL_WEEKDAYS_MASK } from "../../src/recurring-message.js";
import { scheduledActions } from "../../src/scheduled-action-persistence.js";
import {
  scheduledMessageAudits,
  scheduledMessageStates,
} from "../../src/scheduled-message-persistence.js";

const config = loadTestDatabaseConfig();
const first = createDatabase(config);
const second = createDatabase(config);
const recurring = createRecurringMessageStore(first.client);
const runtime = createRecurringRuntimeStore(first.client);
const otherRuntime = createRecurringRuntimeStore(second.client);

function responseLossDatabase(): DatabaseClient {
  const transaction = first.client.transaction.bind(first.client);
  return new Proxy(first.client, {
    get(target, property): unknown {
      if (property === "transaction")
        return async (callback: never) => {
          await transaction(callback);
          throw new Error("injected transaction response loss");
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function pauseTransactionBeforeCommitDatabase(
  database: DatabaseClient,
  ready: ReturnType<typeof deferred<number>>,
  release: ReturnType<typeof deferred<void>>,
): DatabaseClient {
  const transaction = database.transaction.bind(database);
  return new Proxy(database, {
    get(target, property): unknown {
      if (property === "transaction")
        return async (callback: never) =>
          transaction(async (client) => {
            const result = await (
              callback as unknown as (transactionClient: typeof client) => Promise<unknown>
            )(client);
            const pid = await client.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            ready.resolve(pid.rows[0]!.pid);
            await release.promise;
            return result;
          });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function observeTransactionStartDatabase(
  database: DatabaseClient,
  started: ReturnType<typeof deferred<number>>,
): DatabaseClient {
  const transaction = database.transaction.bind(database);
  return new Proxy(database, {
    get(target, property): unknown {
      if (property === "transaction")
        return async (callback: never) =>
          transaction(async (client) => {
            const pid = await client.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
            started.resolve(pid.rows[0]!.pid);
            return (callback as unknown as (transactionClient: typeof client) => Promise<unknown>)(
              client,
            );
          });
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function expectTransactionBlockedBy(
  blockedPid: number,
  blockerPid: number,
  promise: Promise<unknown>,
): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const deadline = Date.now() + 3_000;
  for (;;) {
    const result = await first.client.execute<{ blocked: boolean }>(sql`
      select ${blockerPid}::integer = any(pg_blocking_pids(${blockedPid}::integer)) as blocked
    `);
    if (result.rows[0]?.blocked) {
      expect(settled).toBe(false);
      return;
    }
    if (settled || Date.now() > deadline) {
      throw new Error("Competing transaction did not wait on the held PostgreSQL lock");
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

beforeAll(async () => {
  await migrate(first.client, { migrationsFolder: "drizzle" });
});
beforeEach(async () => {
  await first.client.delete(managedMessageAudits);
  await first.client.delete(managedMessages);
  await first.client.delete(recurringMessageAudits);
  await first.client.delete(recurringMessageOccurrences);
  await first.client.delete(recurringMessageSchedules);
  await first.client.delete(scheduledMessageAudits);
  await first.client.delete(scheduledMessageStates);
  await first.client.delete(scheduledActions);
});
afterAll(async () => {
  await first.close();
  await second.close();
});

async function claimed(suffix: string) {
  const created = await recurring.create({
    scheduledActionId: `runtime-series-${suffix}`,
    occurrenceId: `runtime-occurrence-${suffix}`,
    auditId: `runtime-create-${suffix}`,
    gapAuditIds: [],
    guildId: "runtime-guild",
    channelId: "runtime-channel",
    actorId: "runtime-user",
    payload: { content: "hello", embed: null },
    recurrence: {
      frequency: "DAILY",
      weekdayMask: ALL_WEEKDAYS_MASK,
      localTime: "09:00",
      timezone: "UTC",
    },
    effectiveAt: new Date("2026-01-01T08:00:00.000Z"),
  });
  if (created.outcome !== "COMMITTED" || created.series.occurrence === null)
    throw new Error("Fixture creation failed");
  const occurrence = created.series.occurrence;
  const claim = await recurring.claimInitial({
    occurrenceId: occurrence.id,
    expectedSeriesRevision: 0,
    claimedAt: occurrence.scheduledFor,
  });
  expect(claim.outcome).toBe("COMMITTED");
  return { occurrence, firstAt: occurrence.scheduledFor };
}

async function threeRetries(id: string, firstAt: Date) {
  for (let generation = 1; generation <= 3; generation += 1) {
    const at = new Date(firstAt.getTime() + (generation - 1) * 30_000);
    expect(
      await runtime.recordPreSendFailure({
        occurrenceId: id,
        auditId: `retry-${id}-${generation}`,
        nextOccurrenceId: `next-${id}-${generation}`,
        occurredAt: at,
      }),
    ).toMatchObject({ outcome: "RETRY_PENDING", retryCount: generation });
    expect(
      await runtime.resumeRetry(id, generation, new Date(at.getTime() + 30_000)),
    ).toMatchObject({ status: "EXECUTING", retryCount: generation });
  }
}

describe("recurring retry persistence", () => {
  it("atomically completes an occurrence, managed message, audits, and next occurrence", async () => {
    const { occurrence, firstAt } = await claimed("complete");
    expect(
      await runtime.terminalize({
        occurrenceId: occurrence.id,
        auditId: "complete-audit",
        nextOccurrenceId: "complete-next",
        occurredAt: firstAt,
        resultMessageId: "discord-complete",
        messageCreatedAt: firstAt,
        managedMessageAuditId: "managed-complete",
      }),
    ).toBe("COMMITTED");
    const [completed] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    const [next] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "complete-next"));
    const [managed] = await first.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, "discord-complete"));
    const [managedAudit] = await first.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, "managed-complete"));
    const [audit] = await first.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, "complete-audit"));
    expect(completed).toMatchObject({ status: "COMPLETED", resultMessageId: "discord-complete" });
    expect(next?.status).toBe("PENDING");
    expect(managed).toMatchObject({ messageId: "discord-complete", content: "hello" });
    expect(managedAudit).toMatchObject({ event: "CREATED", messageId: "discord-complete" });
    expect(audit).toMatchObject({
      event: "OCCURRENCE_COMPLETED",
      nextOccurrenceId: "complete-next",
      resultMessageId: "discord-complete",
    });
  });

  it("confirms completion after PostgreSQL transaction response loss", async () => {
    const { occurrence, firstAt } = await claimed("complete-response-loss");
    const lossy = createRecurringRuntimeStore(responseLossDatabase());
    expect(
      await lossy.terminalize({
        occurrenceId: occurrence.id,
        auditId: "complete-response-loss-audit",
        nextOccurrenceId: "complete-response-loss-next",
        occurredAt: firstAt,
        resultMessageId: "discord-response-loss",
        messageCreatedAt: firstAt,
        managedMessageAuditId: "managed-response-loss",
      }),
    ).toBe("COMMITTED");
  });

  it("allows a wake exactly at the deadline and increments once with one audit", async () => {
    const { occurrence, firstAt } = await claimed("wake-equal");
    const at = new Date(firstAt.getTime() + 15 * 60_000 - 30_000);
    const result = await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "retry-wake-equal",
      nextOccurrenceId: "next-wake-equal",
      occurredAt: at,
    });
    expect(result).toEqual({
      outcome: "RETRY_PENDING",
      retryCount: 1,
      wakeAt: new Date(firstAt.getTime() + 15 * 60_000),
    });
    const [row] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(row).toMatchObject({ status: "RETRY_PENDING", retryCount: 1 });
    const audits = await first.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, "retry-wake-equal"));
    expect(audits).toHaveLength(1);
    expect(await runtime.retryWake(occurrence.id, 1)).toEqual(
      new Date(firstAt.getTime() + 15 * 60_000),
    );
    expect(
      await runtime.expireRetry({
        occurrenceId: occurrence.id,
        expectedRetryCount: 1,
        auditId: "not-expired-at-deadline",
        nextOccurrenceId: "not-expired-next",
        occurredAt: new Date(firstAt.getTime() + 15 * 60_000),
      }),
    ).toBe("NOT_COMMITTED");
    expect(
      await runtime.resumeRetry(occurrence.id, 1, new Date(firstAt.getTime() + 15 * 60_000)),
    ).toMatchObject({ status: "EXECUTING", retryCount: 1 });
  });

  it("confirms a committed retry transition after transaction response loss", async () => {
    const { occurrence, firstAt } = await claimed("retry-response-loss");
    const lossy = createRecurringRuntimeStore(responseLossDatabase());
    expect(
      await lossy.recordPreSendFailure({
        occurrenceId: occurrence.id,
        auditId: "retry-response-loss",
        nextOccurrenceId: "next-response-loss",
        occurredAt: firstAt,
      }),
    ).toMatchObject({ outcome: "RETRY_PENDING", retryCount: 1 });
    const [row] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(row?.retryCount).toBe(1);
    expect(
      await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, "retry-response-loss")),
    ).toHaveLength(1);
  });

  it("confirms a committed retry expiry after transaction response loss", async () => {
    const { occurrence, firstAt } = await claimed("expiry-response-loss");
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "retry-before-expiry-response-loss",
      nextOccurrenceId: "unused-before-expiry-response-loss",
      occurredAt: firstAt,
    });
    const lossy = createRecurringRuntimeStore(responseLossDatabase());
    expect(
      await lossy.expireRetry({
        occurrenceId: occurrence.id,
        expectedRetryCount: 1,
        auditId: "expiry-response-loss-audit",
        nextOccurrenceId: "expiry-response-loss-next",
        occurredAt: new Date(firstAt.getTime() + 15 * 60_000 + 1),
      }),
    ).toBe("COMMITTED");
    const [current] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(current).toMatchObject({
      status: "FAILED",
      failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
      retryCount: 1,
    });
  });

  it("fails without increment or retry audit when candidate wake exceeds deadline by 1ms", async () => {
    const { occurrence, firstAt } = await claimed("wake-late");
    const at = new Date(firstAt.getTime() + 15 * 60_000 - 30_000 + 1);
    expect(
      await runtime.recordPreSendFailure({
        occurrenceId: occurrence.id,
        auditId: "failure-wake-late",
        nextOccurrenceId: "next-wake-late",
        occurredAt: at,
      }),
    ).toEqual({ outcome: "FAILED", failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED" });
    const [row] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(row).toMatchObject({
      status: "FAILED",
      retryCount: 0,
      failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
    });
    expect(
      await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.event, "OCCURRENCE_RETRY")),
    ).toHaveLength(0);
  });

  it("uses exhausted-budget failure before wake-time expiry but observation expiry first", async () => {
    const { occurrence, firstAt } = await claimed("budget");
    await threeRetries(occurrence.id, firstAt);
    const deadline = firstAt.getTime() + 15 * 60_000;
    expect(
      await runtime.recordPreSendFailure({
        occurrenceId: occurrence.id,
        auditId: "failure-budget",
        nextOccurrenceId: "next-budget",
        occurredAt: new Date(deadline),
      }),
    ).toEqual({ outcome: "FAILED", failureCode: "CURRENT_STATE_CHECK_FAILED" });
    const [row] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(row).toMatchObject({ status: "FAILED", retryCount: 3 });
    expect(
      await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.event, "OCCURRENCE_RETRY")),
    ).toHaveLength(3);

    const other = await claimed("expired-budget");
    await threeRetries(other.occurrence.id, other.firstAt);
    expect(
      await runtime.recordPreSendFailure({
        occurrenceId: other.occurrence.id,
        auditId: "failure-expired-budget",
        nextOccurrenceId: "next-expired-budget",
        occurredAt: new Date(other.firstAt.getTime() + 15 * 60_000 + 1),
      }),
    ).toEqual({ outcome: "FAILED", failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED" });
  });

  it("permits only one concurrent retry resume across PostgreSQL connections", async () => {
    const { occurrence, firstAt } = await claimed("concurrent-resume");
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "retry-concurrent-resume",
      nextOccurrenceId: "next-concurrent-resume",
      occurredAt: firstAt,
    });
    const wake = new Date(firstAt.getTime() + 30_000);
    const ready = deferred<number>();
    const release = deferred();
    const paused = createRecurringRuntimeStore(
      pauseTransactionBeforeCommitDatabase(first.client, ready, release),
    );
    const firstResume = paused.resumeRetry(occurrence.id, 1, wake);
    const blockerPid = await ready.promise;
    const started = deferred<number>();
    const rival = createRecurringRuntimeStore(
      observeTransactionStartDatabase(second.client, started),
    );
    const secondResume = rival.resumeRetry(occurrence.id, 1, wake);
    const blockedPid = await started.promise;
    try {
      await expectTransactionBlockedBy(blockedPid, blockerPid, secondResume);
    } finally {
      release.resolve();
    }
    expect(await firstResume).toMatchObject({ status: "EXECUTING", retryCount: 1 });
    expect(await secondResume).toBeUndefined();
  });

  for (const winner of ["resume", "expiry"] as const) {
    it(`lets ${winner} win the retry resume versus expiry race`, async () => {
      const { occurrence, firstAt } = await claimed(`resume-expiry-${winner}`);
      const deadline = new Date(firstAt.getTime() + 15 * 60_000);
      expect(
        await runtime.recordPreSendFailure({
          occurrenceId: occurrence.id,
          auditId: `retry-resume-expiry-${winner}`,
          nextOccurrenceId: `unused-resume-expiry-${winner}`,
          occurredAt: new Date(deadline.getTime() - 30_000),
        }),
      ).toMatchObject({ outcome: "RETRY_PENDING", retryCount: 1, wakeAt: deadline });
      const expiryInput = {
        occurrenceId: occurrence.id,
        expectedRetryCount: 1,
        auditId: `expiry-resume-expiry-${winner}`,
        nextOccurrenceId: `next-resume-expiry-${winner}`,
        occurredAt: new Date(deadline.getTime() + 1),
      };
      const ready = deferred<number>();
      const release = deferred();
      const paused = createRecurringRuntimeStore(
        pauseTransactionBeforeCommitDatabase(first.client, ready, release),
      );
      const firstOperation =
        winner === "resume"
          ? paused.resumeRetry(occurrence.id, 1, deadline)
          : paused.expireRetry(expiryInput);
      const blockerPid = await ready.promise;
      const started = deferred<number>();
      const rival = createRecurringRuntimeStore(
        observeTransactionStartDatabase(second.client, started),
      );
      const secondOperation =
        winner === "resume"
          ? rival.expireRetry(expiryInput)
          : rival.resumeRetry(occurrence.id, 1, deadline);
      const blockedPid = await started.promise;
      try {
        await expectTransactionBlockedBy(blockedPid, blockerPid, secondOperation);
      } finally {
        release.resolve();
      }
      const firstResult = await firstOperation;
      const secondResult = await secondOperation;
      const [current] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, occurrence.id));
      const [next] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, expiryInput.nextOccurrenceId));
      const terminalAudits = await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, expiryInput.auditId));
      if (winner === "resume") {
        expect(firstResult).toMatchObject({ status: "EXECUTING", retryCount: 1 });
        expect(secondResult).toBe("NOT_COMMITTED");
        expect(current).toMatchObject({ status: "EXECUTING", retryCount: 1 });
        expect(next).toBeUndefined();
        expect(terminalAudits).toHaveLength(0);
      } else {
        expect(firstResult).toBe("COMMITTED");
        expect(secondResult).toBeUndefined();
        expect(current).toMatchObject({
          status: "FAILED",
          failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
          retryCount: 1,
        });
        expect(next?.status).toBe("PENDING");
        expect(terminalAudits).toHaveLength(1);
        expect(terminalAudits[0]).toMatchObject({
          event: "OCCURRENCE_FAILED",
          failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
          nextOccurrenceId: expiryInput.nextOccurrenceId,
        });
        expect(
          await otherRuntime.expireRetry({
            ...expiryInput,
            auditId: `duplicate-${expiryInput.auditId}`,
            nextOccurrenceId: `duplicate-${expiryInput.nextOccurrenceId}`,
          }),
        ).toBe("NOT_COMMITTED");
        expect(
          await first.client
            .select()
            .from(recurringMessageAudits)
            .where(
              and(
                eq(recurringMessageAudits.occurrenceId, occurrence.id),
                eq(recurringMessageAudits.event, "OCCURRENCE_FAILED"),
              ),
            ),
        ).toHaveLength(1);
      }
    });
  }

  it("rejects a stale retry expiry generation without changing the live occurrence", async () => {
    const { occurrence, firstAt } = await claimed("stale-expiry-generation");
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "stale-expiry-retry-1",
      nextOccurrenceId: "unused-stale-expiry-1",
      occurredAt: firstAt,
    });
    await runtime.resumeRetry(occurrence.id, 1, new Date(firstAt.getTime() + 30_000));
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "stale-expiry-retry-2",
      nextOccurrenceId: "unused-stale-expiry-2",
      occurredAt: new Date(firstAt.getTime() + 30_000),
    });
    expect(
      await runtime.expireRetry({
        occurrenceId: occurrence.id,
        expectedRetryCount: 1,
        auditId: "stale-expiry-terminal",
        nextOccurrenceId: "stale-expiry-next",
        occurredAt: new Date(firstAt.getTime() + 15 * 60_000 + 1),
      }),
    ).toBe("NOT_COMMITTED");
    const [current] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(current).toMatchObject({ status: "RETRY_PENDING", retryCount: 2 });
  });

  it("does not resume a persisted retry after the inclusive lifetime", async () => {
    const { occurrence, firstAt } = await claimed("resume-expired");
    const at = new Date(firstAt.getTime() + 15 * 60_000 - 30_000);
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "retry-resume-expired",
      nextOccurrenceId: "next-resume-expired",
      occurredAt: at,
    });
    expect(
      await runtime.resumeRetry(occurrence.id, 1, new Date(firstAt.getTime() + 15 * 60_000 + 1)),
    ).toBeUndefined();
    const [row] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, occurrence.id));
    expect(row?.status).toBe("RETRY_PENDING");
  });

  it("preserves the initial claim snapshot when payload changes before retry resume", async () => {
    const { occurrence, firstAt } = await claimed("retry-snapshot");
    await runtime.recordPreSendFailure({
      occurrenceId: occurrence.id,
      auditId: "retry-snapshot-audit",
      nextOccurrenceId: "retry-snapshot-next",
      occurredAt: firstAt,
    });
    expect(
      (
        await recurring.editPayload({
          scheduledActionId: occurrence.scheduledActionId,
          actorId: "runtime-user",
          expectedRevision: 0,
          payload: { content: "edited", embed: null },
          auditId: "retry-snapshot-edit",
          occurredAt: new Date(firstAt.getTime() + 1),
        })
      ).outcome,
    ).toBe("COMMITTED");
    const resumed = await runtime.resumeRetry(
      occurrence.id,
      1,
      new Date(firstAt.getTime() + 30_000),
    );
    expect(resumed).toMatchObject({
      status: "EXECUTING",
      claimContent: "hello",
      retryCount: 1,
      claimedSeriesRevision: 0,
      firstAttemptedAt: firstAt,
    });
    const series = await recurring.find(occurrence.scheduledActionId);
    expect(series?.payload.content).toBe("edited");
  });
});

describe("recurring runtime races", () => {
  it("permits only one initial claim across PostgreSQL connections", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-duplicate-claim",
      occurrenceId: "runtime-duplicate-occurrence",
      auditId: "runtime-duplicate-created",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2026-01-01T08:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");
    const at = new Date("2026-01-01T09:00:00.000Z");
    const claimInput = {
      occurrenceId: "runtime-duplicate-occurrence",
      expectedSeriesRevision: 0,
      claimedAt: at,
    };
    const ready = deferred<number>();
    const release = deferred();
    const paused = createRecurringMessageStore(
      pauseTransactionBeforeCommitDatabase(first.client, ready, release),
    );
    const firstClaim = paused.claimInitial(claimInput);
    const blockerPid = await ready.promise;
    const started = deferred<number>();
    const rival = createRecurringMessageStore(
      observeTransactionStartDatabase(second.client, started),
    );
    const secondClaim = rival.claimInitial(claimInput);
    const blockedPid = await started.promise;
    try {
      await expectTransactionBlockedBy(blockedPid, blockerPid, secondClaim);
    } finally {
      release.resolve();
    }
    expect(await firstClaim).toMatchObject({ outcome: "COMMITTED" });
    expect(await secondClaim).toEqual({ outcome: "NOT_CLAIMED" });
  });

  it("accepts pre-generated gap IDs when a concurrent claim wins the series lock", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-gap-claim-series",
      occurrenceId: "runtime-gap-claim-occurrence",
      auditId: "runtime-gap-claim-created",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2024-03-10T05:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");

    const effectiveAt = new Date("2024-03-10T06:00:00.000Z");
    const ready = deferred<number>();
    const release = deferred();
    const claiming = createRecurringMessageStore(
      pauseTransactionBeforeCommitDatabase(first.client, ready, release),
    ).claimInitial({
      occurrenceId: "runtime-gap-claim-occurrence",
      expectedSeriesRevision: 0,
      claimedAt: effectiveAt,
    });
    const blockerPid = await ready.promise;
    const started = deferred<number>();
    const editing = createRecurringMessageStore(
      observeTransactionStartDatabase(second.client, started),
    ).editRecurrence({
      scheduledActionId: "runtime-gap-claim-series",
      actorId: "runtime-user",
      expectedRevision: 0,
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "02:30",
        timezone: "America/New_York",
      },
      effectiveAt,
      replacementOccurrenceId: "unused-runtime-gap-replacement",
      auditId: "runtime-gap-recurrence-edited",
      gapAuditIds: ["unused-runtime-gap-audit"],
    });
    const blockedPid = await started.promise;
    try {
      await expectTransactionBlockedBy(blockedPid, blockerPid, editing);
    } finally {
      release.resolve();
    }

    expect(await claiming).toMatchObject({ outcome: "COMMITTED" });
    expect(await editing).toMatchObject({
      outcome: "COMMITTED",
      effect: {
        committedRevision: 1,
        deferredMaterialization: true,
        replacementOccurrenceId: null,
        replacementScheduledFor: null,
      },
    });
    const [current] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "runtime-gap-claim-occurrence"));
    expect(current?.status).toBe("EXECUTING");
    const [unusedGapAudit] = await first.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, "unused-runtime-gap-audit"));
    expect(unusedGapAudit).toBeUndefined();
    const [unusedReplacement] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "unused-runtime-gap-replacement"));
    expect(unusedReplacement).toBeUndefined();
  });

  for (const winner of ["cancel", "resume"] as const) {
    it(`serializes retry resume when ${winner} holds the series lock first`, async () => {
      const { occurrence, firstAt } = await claimed(`resume-cancel-${winner}`);
      await runtime.recordPreSendFailure({
        occurrenceId: occurrence.id,
        auditId: `retry-resume-cancel-${winner}`,
        nextOccurrenceId: `next-resume-cancel-${winner}`,
        occurredAt: firstAt,
      });
      const wake = new Date(firstAt.getTime() + 30_000);
      const ready = deferred<number>();
      const release = deferred();
      const pausedDatabase = pauseTransactionBeforeCommitDatabase(first.client, ready, release);
      const cancelInput = {
        scheduledActionId: occurrence.scheduledActionId,
        actorId: "runtime-user",
        expectedRevision: 0,
        auditId: `cancel-resume-cancel-${winner}`,
        occurredAt: wake,
      };
      const firstOperation =
        winner === "cancel"
          ? createRecurringMessageStore(pausedDatabase).cancel(cancelInput)
          : createRecurringRuntimeStore(pausedDatabase).resumeRetry(occurrence.id, 1, wake);
      const blockerPid = await ready.promise;
      const started = deferred<number>();
      const rivalDatabase = observeTransactionStartDatabase(second.client, started);
      const secondOperation =
        winner === "cancel"
          ? createRecurringRuntimeStore(rivalDatabase).resumeRetry(occurrence.id, 1, wake)
          : createRecurringMessageStore(rivalDatabase).cancel(cancelInput);
      const blockedPid = await started.promise;
      try {
        await expectTransactionBlockedBy(blockedPid, blockerPid, secondOperation);
      } finally {
        release.resolve();
      }
      const firstResult = await firstOperation;
      const secondResult = await secondOperation;
      const [current] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, occurrence.id));
      if (winner === "cancel") {
        expect(firstResult).toMatchObject({ outcome: "COMMITTED" });
        expect(secondResult).toBeUndefined();
        expect(current).toMatchObject({ status: "SKIPPED", skipReason: "SERIES_CANCELLED" });
      } else {
        expect(firstResult).toMatchObject({ status: "EXECUTING" });
        expect(secondResult).toMatchObject({ outcome: "COMMITTED" });
        expect(current?.status).toBe("EXECUTING");
        expect(
          await otherRuntime.terminalize({
            occurrenceId: occurrence.id,
            auditId: "terminal-after-resume-cancel",
            nextOccurrenceId: "no-next-after-resume-cancel",
            occurredAt: wake,
            failureCode: "SEND_REJECTED",
          }),
        ).toBe("COMMITTED");
        const [next] = await first.client
          .select()
          .from(recurringMessageOccurrences)
          .where(eq(recurringMessageOccurrences.id, "no-next-after-resume-cancel"));
        expect(next).toBeUndefined();
      }
    });
  }

  for (const winner of ["terminal", "cancel"] as const) {
    it(`serializes terminal advancement when ${winner} holds the series lock first`, async () => {
      const { occurrence, firstAt } = await claimed(`terminal-cancel-${winner}`);
      const ready = deferred<number>();
      const release = deferred();
      const pausedDatabase = pauseTransactionBeforeCommitDatabase(first.client, ready, release);
      const terminalInput = {
        occurrenceId: occurrence.id,
        auditId: `failure-terminal-cancel-${winner}`,
        nextOccurrenceId: `next-terminal-cancel-${winner}`,
        occurredAt: firstAt,
        failureCode: "SEND_REJECTED" as const,
      };
      const cancelInput = {
        scheduledActionId: occurrence.scheduledActionId,
        actorId: "runtime-user",
        expectedRevision: 0,
        auditId: `cancel-terminal-cancel-${winner}`,
        occurredAt: firstAt,
      };
      const firstOperation =
        winner === "terminal"
          ? createRecurringRuntimeStore(pausedDatabase).terminalize(terminalInput)
          : createRecurringMessageStore(pausedDatabase).cancel(cancelInput);
      const blockerPid = await ready.promise;
      const started = deferred<number>();
      const rivalDatabase = observeTransactionStartDatabase(second.client, started);
      const secondOperation =
        winner === "terminal"
          ? createRecurringMessageStore(rivalDatabase).cancel(cancelInput)
          : createRecurringRuntimeStore(rivalDatabase).terminalize(terminalInput);
      const blockedPid = await started.promise;
      try {
        await expectTransactionBlockedBy(blockedPid, blockerPid, secondOperation);
      } finally {
        release.resolve();
      }
      const firstResult = await firstOperation;
      const secondResult = await secondOperation;
      if (winner === "terminal") {
        expect(firstResult).toBe("COMMITTED");
        expect(secondResult).toMatchObject({ outcome: "COMMITTED" });
      } else {
        expect(firstResult).toMatchObject({ outcome: "COMMITTED" });
        expect(secondResult).toBe("COMMITTED");
      }
      const [audit] = await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, terminalInput.auditId));
      const [next] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, terminalInput.nextOccurrenceId));
      if (winner === "terminal") {
        expect(audit?.postSeriesStatus).toBe("ACTIVE");
        expect(next?.status).toBe("SKIPPED");
        expect(next?.skipReason).toBe("SERIES_CANCELLED");
      } else {
        expect(audit?.postSeriesStatus).toBe("CANCELLED");
        expect(next).toBeUndefined();
      }
    });
  }

  it("uses the latest definition when recurrence editing wins before terminalization", async () => {
    const { occurrence, firstAt } = await claimed("terminal-edit");
    const edit = await recurring.editRecurrence({
      scheduledActionId: occurrence.scheduledActionId,
      actorId: "runtime-user",
      expectedRevision: 0,
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "10:00",
        timezone: "UTC",
      },
      effectiveAt: new Date(firstAt.getTime() + 1),
      replacementOccurrenceId: "replacement-terminal-edit",
      auditId: "edit-terminal-edit",
      gapAuditIds: [],
    });
    expect(edit.outcome).toBe("COMMITTED");
    expect(
      await otherRuntime.terminalize({
        occurrenceId: occurrence.id,
        auditId: "failure-terminal-edit",
        nextOccurrenceId: "next-terminal-edit",
        occurredAt: new Date(firstAt.getTime() + 1),
        failureCode: "SEND_REJECTED",
      }),
    ).toBe("COMMITTED");
    const [next] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "next-terminal-edit"));
    expect(next?.intendedLocalTime.slice(0, 5)).toBe("10:00");
    expect(next?.materializedDefinitionRevision).toBe(1);
  });

  for (const winner of ["terminal", "edit"] as const) {
    it(`serializes terminalization when ${winner} holds the series lock before recurrence edit`, async () => {
      const { occurrence, firstAt } = await claimed(`concurrent-terminal-edit-${winner}`);
      const ready = deferred<number>();
      const release = deferred();
      const pausedDatabase = pauseTransactionBeforeCommitDatabase(first.client, ready, release);
      const terminalInput = {
        occurrenceId: occurrence.id,
        auditId: `failure-concurrent-terminal-edit-${winner}`,
        nextOccurrenceId: `next-concurrent-terminal-edit-${winner}`,
        occurredAt: new Date(firstAt.getTime() + 1),
        failureCode: "SEND_REJECTED" as const,
      };
      const editInput = {
        scheduledActionId: occurrence.scheduledActionId,
        actorId: "runtime-user",
        expectedRevision: 0,
        recurrence: {
          frequency: "DAILY" as const,
          weekdayMask: ALL_WEEKDAYS_MASK,
          localTime: "10:00",
          timezone: "UTC",
        },
        effectiveAt: new Date(firstAt.getTime() + 1),
        replacementOccurrenceId: `replacement-concurrent-terminal-edit-${winner}`,
        auditId: `edit-concurrent-terminal-edit-${winner}`,
        gapAuditIds: [],
      };
      const firstOperation =
        winner === "terminal"
          ? createRecurringRuntimeStore(pausedDatabase).terminalize(terminalInput)
          : createRecurringMessageStore(pausedDatabase).editRecurrence(editInput);
      const blockerPid = await ready.promise;
      const started = deferred<number>();
      const rivalDatabase = observeTransactionStartDatabase(second.client, started);
      const secondOperation =
        winner === "terminal"
          ? createRecurringMessageStore(rivalDatabase).editRecurrence(editInput)
          : createRecurringRuntimeStore(rivalDatabase).terminalize(terminalInput);
      const blockedPid = await started.promise;
      try {
        await expectTransactionBlockedBy(blockedPid, blockerPid, secondOperation);
      } finally {
        release.resolve();
      }
      const firstResult = await firstOperation;
      const secondResult = await secondOperation;
      if (winner === "terminal") {
        expect(firstResult).toBe("COMMITTED");
        expect(secondResult).toMatchObject({ outcome: "COMMITTED" });
      } else {
        expect(firstResult).toMatchObject({ outcome: "COMMITTED" });
        expect(secondResult).toBe("COMMITTED");
      }
      const [historical] = await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, terminalInput.auditId));
      const [next] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, terminalInput.nextOccurrenceId));
      const [replacement] = await first.client
        .select()
        .from(recurringMessageOccurrences)
        .where(eq(recurringMessageOccurrences.id, editInput.replacementOccurrenceId));
      const [editAudit] = await first.client
        .select()
        .from(recurringMessageAudits)
        .where(eq(recurringMessageAudits.id, editInput.auditId));
      if (winner === "terminal") {
        expect(historical?.nextIntendedLocalTime?.slice(0, 5)).toBe("09:00");
        expect(next?.status).toBe("SKIPPED");
        expect(replacement).toMatchObject({ status: "PENDING", materializedDefinitionRevision: 1 });
        expect(replacement?.intendedLocalTime.slice(0, 5)).toBe("10:00");
      } else {
        expect(editAudit?.deferredMaterialization).toBe(true);
        expect(replacement).toBeUndefined();
        expect(historical?.nextIntendedLocalTime?.slice(0, 5)).toBe("10:00");
        expect(next).toMatchObject({ status: "PENDING", materializedDefinitionRevision: 1 });
      }
    });
  }
});

describe("recurring missed occurrence recovery", () => {
  it("records a DST gap as audit-only during missed recovery", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-dst-gap",
      occurrenceId: "runtime-dst-first",
      auditId: "runtime-dst-create",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "02:30",
        timezone: "America/New_York",
      },
      effectiveAt: new Date("2026-03-07T06:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");
    expect(
      await runtime.recoverMissed({
        occurrenceId: "runtime-dst-first",
        auditId: "runtime-dst-range",
        nextOccurrenceId: "runtime-dst-next",
        at: new Date("2026-03-09T06:40:00.000Z"),
      }),
    ).toBe("COMMITTED");
    const gaps = await first.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.event, "DST_GAP_SKIPPED"));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      intendedLocalDate: "2026-03-08",
      intendedLocalTime: "02:30:00",
    });
    const rows = await first.client.select().from(recurringMessageOccurrences);
    expect(rows).toHaveLength(2);
  });

  it("confirms missed recovery after transaction response loss", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-missed-response-loss",
      occurrenceId: "runtime-first-response-loss",
      auditId: "runtime-create-response-loss",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2026-01-01T08:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");
    const lossy = createRecurringRuntimeStore(responseLossDatabase());
    expect(
      await lossy.recoverMissed({
        occurrenceId: "runtime-first-response-loss",
        auditId: "runtime-range-response-loss",
        nextOccurrenceId: "runtime-next-response-loss",
        at: new Date("2026-01-05T09:10:00.000Z"),
      }),
    ).toBe("COMMITTED");
  });

  it("recovers a missing current row from the last terminal occurrence and current definition", async () => {
    const { occurrence, firstAt } = await claimed("missing-row");
    expect(
      await runtime.terminalize({
        occurrenceId: occurrence.id,
        auditId: "missing-row-terminal",
        nextOccurrenceId: "missing-row-removed",
        occurredAt: firstAt,
        failureCode: "SEND_REJECTED",
      }),
    ).toBe("COMMITTED");
    await first.client
      .delete(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "missing-row-removed"));
    expect(await runtime.pageMissing()).toContain(occurrence.scheduledActionId);
    expect(
      await runtime.recoverMissing({
        scheduledActionId: occurrence.scheduledActionId,
        auditId: "missing-row-range",
        nextOccurrenceId: "missing-row-recovered",
        at: new Date("2026-01-03T09:10:00.000Z"),
      }),
    ).toBe("COMMITTED");
    const [recovered] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "missing-row-recovered"));
    expect(recovered).toMatchObject({
      status: "PENDING",
      scheduledFor: new Date("2026-01-03T09:00:00.000Z"),
    });
  });

  it("uses the edited definition boundary when an old-definition skipped row remains", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-missing-edit",
      occurrenceId: "runtime-old-edit",
      auditId: "runtime-create-edit",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "20:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2026-01-01T08:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");
    const edit = await recurring.editRecurrence({
      scheduledActionId: "runtime-missing-edit",
      actorId: "runtime-user",
      expectedRevision: 0,
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "12:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2026-01-01T10:00:00.000Z"),
      replacementOccurrenceId: "runtime-edit-replacement",
      auditId: "runtime-edit-audit",
      gapAuditIds: [],
    });
    expect(edit.outcome).toBe("COMMITTED");
    await first.client
      .delete(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "runtime-edit-replacement"));
    expect(
      await runtime.recoverMissing({
        scheduledActionId: "runtime-missing-edit",
        auditId: "runtime-edit-range",
        nextOccurrenceId: "runtime-edit-recovered",
        at: new Date("2026-01-01T12:10:00.000Z"),
      }),
    ).toBe("COMMITTED");
    const [recovered] = await first.client
      .select()
      .from(recurringMessageOccurrences)
      .where(eq(recurringMessageOccurrences.id, "runtime-edit-recovered"));
    expect(recovered).toMatchObject({
      status: "PENDING",
      materializedDefinitionRevision: 1,
      scheduledFor: new Date("2026-01-01T12:00:00.000Z"),
    });
  });

  it("converges long downtime to the latest missed occurrence without replaying each date", async () => {
    const created = await recurring.create({
      scheduledActionId: "runtime-missed",
      occurrenceId: "runtime-first-missed",
      auditId: "runtime-create-missed",
      gapAuditIds: [],
      guildId: "runtime-guild",
      channelId: "runtime-channel",
      actorId: "runtime-user",
      payload: { content: "hello", embed: null },
      recurrence: {
        frequency: "DAILY",
        weekdayMask: ALL_WEEKDAYS_MASK,
        localTime: "09:00",
        timezone: "UTC",
      },
      effectiveAt: new Date("2026-01-01T08:00:00.000Z"),
    });
    expect(created.outcome).toBe("COMMITTED");
    const at = new Date("2026-01-05T09:10:00.000Z");
    expect(
      await runtime.recoverMissed({
        occurrenceId: "runtime-first-missed",
        auditId: "runtime-range-missed",
        nextOccurrenceId: "runtime-latest-missed",
        at,
      }),
    ).toBe("COMMITTED");
    const rows = await first.client.select().from(recurringMessageOccurrences);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === "runtime-first-missed")).toMatchObject({
      status: "SKIPPED",
      skipReason: "MISSED_GRACE_EXCEEDED",
    });
    expect(rows.find((row) => row.id === "runtime-latest-missed")).toMatchObject({
      status: "PENDING",
      scheduledFor: new Date("2026-01-05T09:00:00.000Z"),
    });
    const [audit] = await first.client
      .select()
      .from(recurringMessageAudits)
      .where(eq(recurringMessageAudits.id, "runtime-range-missed"));
    expect(audit).toMatchObject({
      event: "MISSED_RANGE_SKIPPED",
      selectedNextScheduledFor: new Date("2026-01-05T09:00:00.000Z"),
    });
  });
});
