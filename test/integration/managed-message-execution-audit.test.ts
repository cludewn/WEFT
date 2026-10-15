import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bindAdministrativePool } from "../../src/administrative-transaction.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import type { ManagedMessageDiscord } from "../../src/messages/managed-message-discord.js";
import {
  createManagedMessageStore,
  managedMessages,
  managedMessageAudits,
  type ManagedMessageSuccessCandidate,
  type ManagedMessageStore,
} from "../../src/messages/managed-message-persistence.js";
import { createManagedMessageService } from "../../src/messages/managed-message.js";
import {
  createManagedMessageExecutionRecorder,
  managedMessageExecutionFailureAudits as audits,
  type ManagedMessageExecutionAudit,
} from "../../src/messages/managed-message-execution-audit.js";
import {
  newManagedMessageExecutionAttempt,
  type ManagedMessageExecutionAttempt,
} from "../../src/messages/managed-message-execution-evidence.js";
import { createAuditNotificationProjection } from "../../src/audit/audit-notification-projection.js";
import { formatAuditNotification } from "../../src/audit/audit-notification-format.js";
import { createAuditRetentionStore } from "../../src/audit/audit-retention-persistence.js";

// Maintainer-only: actual PostgreSQL commands, public API injection, independent observation.
const config = loadTestDatabaseConfig();
const observer = createDatabase(config);
const pool = new Pool({
  host: config.host,
  port: config.port,
  database: config.name,
  user: config.user,
  password: config.password,
  ssl: config.ssl ? { rejectUnauthorized: true } : false,
  max: 5,
  application_name: "weft-managed-execution-audit-test",
});
const schema = `weft_execution_${randomUUID().replaceAll("-", "")}`;
const guilds: string[] = [];
const at = new Date("2030-01-01T00:00:00.123Z");
const oldPayload = {
  content: "old",
  embed: { title: "Before", color: 12, imageUrl: "https://example.invalid/old.png" },
};
const payload = {
  content: "new",
  embed: { title: "After", color: 13, imageUrl: "https://example.invalid/new.png" },
};
type Fault =
  "NONE" | "BEGIN_LOSS" | "AUDIT_REJECTION" | "COMMIT_REJECTION" | "COMMIT_LOSS" | "ROLLBACK_LOSS";
type Kind = "SEND" | "EDIT" | "DELETION";
type CurrentReadStage = "CONFIRMATION" | "COMPENSATION_SAFETY";

beforeAll(async () => {
  await migrate(observer.client, { migrationsFolder: "drizzle" });
  await observer.client.execute(sql`create schema ${sql.identifier(schema)}`);
  await observer.client.execute(
    sql`create table ${sql.identifier(schema)}.parent (id integer primary key)`,
  );
  await observer.client.execute(
    sql`create table ${sql.identifier(schema)}.child (id integer references ${sql.identifier(schema)}.parent(id) deferrable initially deferred)`,
  );
});
afterAll(async () => {
  await observer.client.delete(audits).where(inArray(audits.guildId, guilds));
  await observer.client
    .delete(managedMessageAudits)
    .where(inArray(managedMessageAudits.guildId, guilds));
  await observer.client.delete(managedMessages).where(inArray(managedMessages.guildId, guilds));
  await observer.client.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
  await pool.end();
  await observer.close();
});

async function fixture(
  kind: Kind,
  options: {
    fault?: Fault;
    auditFault?: "LOSS" | "REJECT";
    historyFault?: "READ_FAILED" | "MISMATCH";
    failedCurrentReads?: readonly CurrentReadStage[];
    laterEdit?: boolean;
    zero?: boolean;
    compensation?:
      "CONFIRMED" | "REJECTED" | "UNCONFIRMED" | "GUARD" | "READ_FAILED" | "ALREADY_ABSENT";
    sendLoss?: boolean;
    editReadback?: "NEW" | "OLD" | "UNKNOWN";
    successBetweenGateAndInsert?: boolean;
  } = {},
) {
  const fault = options.fault ?? "NONE";
  const guildId = randomUUID(),
    messageId = randomUUID(),
    operationId = randomUUID();
  guilds.push(guildId);
  const input = {
    guildId,
    channelId: "333333333333333333",
    actorUserId: "222222222222222222",
    payload,
  };
  const trace: string[] = [],
    executed: string[] = [],
    injected: string[] = [];
  const releases: boolean[] = [];
  const base = createManagedMessageStore(observer.client);
  if (kind !== "SEND")
    await base.create({
      auditId: randomUUID(),
      messageId,
      guildId,
      channelId: input.channelId,
      creatorUserId: input.actorUserId,
      payload: oldPayload,
      createdAt: at,
    });
  let remote: "OLD" | "NEW" | "ABSENT" = kind === "SEND" ? "ABSENT" : "OLD";
  let activeAttempt: ManagedMessageExecutionAttempt | undefined;
  let success: ManagedMessageSuccessCandidate | undefined;
  let currentReadStage: CurrentReadStage | undefined;
  const currentReads: {
    stage: CurrentReadStage | undefined;
    command: string;
    executed: boolean;
  }[] = [];
  async function readAt<T>(stage: CurrentReadStage, read: () => Promise<T>): Promise<T> {
    expect(currentReadStage).toBeUndefined();
    currentReadStage = stage;
    try {
      return await read();
    } finally {
      currentReadStage = undefined;
    }
  }
  const commandText = (request: unknown) =>
    typeof request === "string" ? request : (request as { text: string }).text;
  const originalConnect = pool.connect.bind(pool),
    originalQuery = pool.query.bind(pool);
  const controlled = new Proxy(pool, {
    get(target, property) {
      if (property === "connect")
        return async () => {
          const client = await originalConnect(),
            original = client.query.bind(client);
          return new Proxy(client, {
            get(current, key) {
              if (key === "release")
                return (destroy?: boolean) => {
                  releases.push(destroy ?? false);
                  client.release(destroy);
                };
              if (key !== "query") return Reflect.get(current, key) as unknown;
              return async (...args: unknown[]) => {
                const command = commandText(args[0]);
                trace.push(command);
                if (
                  command.startsWith('insert into "managed_message_audits"') &&
                  ["AUDIT_REJECTION", "ROLLBACK_LOSS"].includes(fault)
                ) {
                  expect(
                    executed.some((value) =>
                      /^(insert into|update) "managed_messages"/.test(value),
                    ),
                  ).toBe(true);
                  injected.push("SUCCESS_AUDIT_REJECTION");
                  throw new Error("Injected success INSERT rejection after business mutation");
                }
                if (command === "COMMIT" && fault === "COMMIT_REJECTION") {
                  await original(`insert into "${schema}".child values (1)`);
                  injected.push("DEFERRED_CONSTRAINT");
                }
                let result: QueryResult;
                try {
                  result = (await Reflect.apply(original, client, args)) as QueryResult;
                } catch (error) {
                  if (command === "COMMIT" && fault === "COMMIT_REJECTION") {
                    expect(error).toMatchObject({ code: "23503", severity: "ERROR" });
                    injected.push("COMMIT_REJECTED");
                  }
                  throw error;
                }
                executed.push(command);
                if (command === "COMMIT" && options.laterEdit) {
                  const state = await base.find(messageId);
                  expect(state).toBeDefined();
                  expect(
                    await base.edit({
                      auditId: randomUUID(),
                      messageId,
                      guildId,
                      channelId: input.channelId,
                      actorUserId: input.actorUserId,
                      expectedRevision: state!.revision,
                      previousPayload: state!.payload,
                      payload: { content: "later", embed: null },
                      occurredAt: new Date(at.getTime() + 2000),
                    }),
                  ).toBe("TRANSITIONED");
                  injected.push("LATER_EDIT");
                }
                if (
                  (command === "BEGIN" && fault === "BEGIN_LOSS") ||
                  (command === "COMMIT" && fault === "COMMIT_LOSS") ||
                  (command === "ROLLBACK" && fault === "ROLLBACK_LOSS")
                ) {
                  expect(result.command).toBe(command);
                  injected.push(`${command}_LOSS`);
                  throw new Error("Injected control response loss after actual execution");
                }
                return result;
              };
            },
          });
        };
      if (property === "query")
        return async (...args: unknown[]) => {
          const command = commandText(args[0]);
          trace.push(command);
          const historical =
            command.includes('from "managed_message_audits"') && !command.includes("join");
          // Confirmation and compensation safety share the same SQL helper. Select the
          // application stage explicitly instead of failing every occurrence of that SQL.
          const currentRead = command.includes('left join "managed_message_audits"')
            ? { stage: currentReadStage, command, executed: false }
            : undefined;
          if (currentRead) {
            expect(currentRead.stage).toBeDefined();
            currentReads.push(currentRead);
          }
          if (
            currentRead?.stage !== undefined &&
            options.failedCurrentReads?.includes(currentRead.stage)
          ) {
            expect(injected).toContain("COMMIT_LOSS");
            expect(args[1]).toEqual(expect.arrayContaining([success!.input.auditId, messageId]));
            injected.push(`${currentRead.stage}_READ_FAILED`);
            throw new Error(`Injected ${currentRead.stage} read failure`);
          }
          if (historical && options.historyFault === "READ_FAILED") {
            injected.push("HISTORY_READ_FAILED");
            throw new Error("Injected historical read failure");
          }
          const auditInsert = command.startsWith(
            'insert into "managed_message_execution_failure_audits"',
          );
          if (auditInsert && options.successBetweenGateAndInsert && success?.event === "CREATED") {
            await base.create(success.input);
            injected.push("SUCCESS_AFTER_HISTORY_GATE");
          }
          if (auditInsert && options.auditFault === "REJECT") {
            injected.push("FAILURE_INSERT_REJECTED");
            throw new Error("Injected independent INSERT rejection");
          }
          const result = (await Reflect.apply(originalQuery, pool, args)) as QueryResult<unknown[]>;
          executed.push(command);
          if (currentRead) currentRead.executed = true;
          if (auditInsert && options.auditFault === "LOSS") {
            expect(result.rowCount).toBe(1);
            injected.push("FAILURE_INSERT_LOSS");
            throw new Error("Injected independent INSERT response loss");
          }
          if (historical && options.historyFault === "MISMATCH") {
            expect(result.rows).toHaveLength(1);
            injected.push("HISTORY_MISMATCH");
            return {
              ...result,
              rows: result.rows.map((row) =>
                row.map((value, i) => (i === 6 ? "wrong-actor" : value)),
              ),
            };
          }
          return result;
        };
      return Reflect.get(target, property) as unknown;
    },
  });
  const database = drizzle(controlled) as unknown as DatabaseClient;
  bindAdministrativePool(database, controlled);
  const actual = createManagedMessageStore(database);
  const store: ManagedMessageStore = {
    ...actual,
    confirmCreation: vi.fn<ManagedMessageStore["confirmCreation"]>((input) =>
      readAt("CONFIRMATION", () => actual.confirmCreation(input)),
    ),
    confirmEdit: vi.fn<ManagedMessageStore["confirmEdit"]>((input) =>
      readAt("CONFIRMATION", () => actual.confirmEdit(input)),
    ),
    confirmDeletion: vi.fn<ManagedMessageStore["confirmDeletion"]>((input) =>
      readAt("CONFIRMATION", () => actual.confirmDeletion(input)),
    ),
    create: async (creation, attempt) => {
      success = { event: "CREATED", input: creation };
      return actual.create(creation, attempt);
    },
    edit: async (transition, attempt) => {
      success = { event: "EDITED", input: transition };
      if (options.zero) {
        expect(
          await base.edit({
            ...transition,
            auditId: randomUUID(),
            payload: { content: "concurrent", embed: null },
          }),
        ).toBe("TRANSITIONED");
        injected.push("COMPETING_EDIT");
      }
      return actual.edit(transition, attempt);
    },
    markDeleted: async (transition, attempt) => {
      success = { event: "DELETION_DETECTED", input: transition };
      return actual.markDeleted(transition, attempt);
    },
    readCompensationSafety: vi.fn<ManagedMessageStore["readCompensationSafety"]>((input) =>
      readAt("COMPENSATION_SAFETY", () => {
        if (options.compensation === "READ_FAILED") {
          injected.push("SAFETY_READ_FAILED");
          throw new Error("Safety read unavailable");
        }
        return actual.readCompensationSafety(input);
      }),
    ),
  };
  const discord: ManagedMessageDiscord = {
    sendManagedMessage: vi.fn<ManagedMessageDiscord["sendManagedMessage"]>(
      (_request, observation) => {
        observation!.actorAuthorized();
        activeAttempt = observation!.attempt;
        observation!.attempt.discordEvidence = "UNCONFIRMED";
        remote = "NEW";
        if (options.sendLoss)
          return Promise.resolve({ outcome: "FAILURE", code: "SEND_UNCONFIRMED" });
        return Promise.resolve({
          outcome: "SENT",
          message: { guildId, channelId: input.channelId, messageId, createdAt: at, payload },
        });
      },
    ),
    deleteManagedMessage: vi.fn<ManagedMessageDiscord["deleteManagedMessage"]>(() => {
      if (options.compensation === "REJECTED") return Promise.resolve({ outcome: "REJECTED" });
      remote = "ABSENT";
      return Promise.resolve({
        outcome:
          options.compensation === "UNCONFIRMED"
            ? "UNCONFIRMED"
            : options.compensation === "ALREADY_ABSENT"
              ? "ALREADY_ABSENT"
              : "DELETED",
      });
    }),
    editManagedMessage: vi.fn<ManagedMessageDiscord["editManagedMessage"]>(
      (_request, observation) => {
        observation!.actorAuthorized();
        activeAttempt = observation!.attempt;
        if (kind === "DELETION") {
          remote = "ABSENT";
          return Promise.resolve({ outcome: "DELETED" });
        }
        remote = "NEW";
        if (options.editReadback === "OLD") {
          remote = "OLD";
          observation!.attempt.discordEvidence = "NOT_APPLIED_BY_READBACK";
          observation!.attempt.failure = {
            stage: "DISCORD_MUTATION",
            reasonCode: "EDIT_NOT_APPLIED",
          };
          return Promise.resolve({ outcome: "FAILURE", code: "EDIT_NOT_APPLIED" });
        }
        if (options.editReadback === "UNKNOWN") {
          observation!.attempt.discordEvidence = "UNCONFIRMED";
          return Promise.resolve({ outcome: "FAILURE", code: "EDIT_UNCONFIRMED" });
        }
        return Promise.resolve({ outcome: "EDITED", editedAt: new Date(at.getTime() + 1000) });
      },
    ),
    restoreManagedMessage: vi.fn<ManagedMessageDiscord["restoreManagedMessage"]>(
      (_request, observation) => {
        if (options.compensation === "GUARD") {
          observation!.attempt.compensationEvidence = "SKIPPED_DISCORD_GUARD";
          return Promise.resolve({ outcome: "PRECONDITION_FAILED" });
        }
        if (options.compensation === "REJECTED") {
          observation!.attempt.compensationEvidence = "REJECTED";
          return Promise.resolve({ outcome: "UNCONFIRMED" });
        }
        remote = "OLD";
        if (options.compensation === "UNCONFIRMED") {
          observation!.attempt.compensationEvidence = "UNCONFIRMED";
          return Promise.resolve({ outcome: "UNCONFIRMED" });
        }
        return Promise.resolve({ outcome: "RESTORED" });
      },
    ),
  };
  const publish = vi.fn(),
    logger = { warn: vi.fn() };
  const recorder = createManagedMessageExecutionRecorder(database, logger, { publish });
  const service = createManagedMessageService({
    discord,
    store,
    failures: recorder,
    logger,
    generateAuditId: (() => {
      let count = 0;
      return () => (count++ === 0 ? operationId : randomUUID());
    })(),
    now: () => at,
  });
  const run = () =>
    kind === "SEND"
      ? service.send(input)
      : service.edit({ ...input, messageId, expectedRevision: 1 });
  const state = async () => ({
    messages: await observer.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, messageId)),
    successes: await observer.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, messageId)),
    failures: await observer.client
      .select()
      .from(audits)
      .where(eq(audits.operationId, operationId)),
  });
  return {
    input,
    messageId,
    operationId,
    run,
    state,
    database,
    discord,
    store,
    trace,
    executed,
    injected,
    currentReads,
    releases,
    publish,
    recorder,
    remote: () => remote,
    attempt: () => activeAttempt!,
    success: () => success!,
  };
}

describe("managed execution observed PostgreSQL effects", () => {
  it.each(["SEND", "EDIT", "DELETION"] as const)(
    "rolls back actual %s business writes and commits independent failure history",
    async (kind) => {
      const f = await fixture(kind, { fault: "AUDIT_REJECTION" });
      const before = await f.state();
      await f.run();
      const after = await f.state();
      expect(f.injected).toEqual(["SUCCESS_AUDIT_REJECTION"]);
      expect(f.executed.filter((command) => command === "ROLLBACK")).toHaveLength(1);
      expect(after.messages).toEqual(before.messages);
      expect(after.successes).toEqual(before.successes);
      expect(after.failures).toHaveLength(1);
      expect(after.failures[0]).toMatchObject({
        outcome: "FAILURE",
        transactionEvidence: "ROLLED_BACK",
        databaseEffect: "NOT_APPLIED",
      });
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.remote()).toBe(kind === "SEND" || kind === "DELETION" ? "ABSENT" : "OLD");
    },
  );
  it.each(["SEND", "EDIT"] as const)(
    "confirms actual %s COMMIT response loss through existing exact evidence",
    async (kind) => {
      const f = await fixture(kind, { fault: "COMMIT_LOSS" });
      expect((await f.run()).outcome).toBe("SUCCESS");
      expect(f.injected).toEqual(["COMMIT_LOSS"]);
      const state = await f.state();
      expect(state.messages[0]?.content).toBe(payload.content);
      expect(state.successes.some((row) => row.id === f.operationId)).toBe(true);
      expect(state.failures).toEqual([]);
      expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(f.discord.restoreManagedMessage).not.toHaveBeenCalled();
    },
  );
  it.each([
    { kind: "SEND", failedReads: ["CONFIRMATION"] },
    { kind: "EDIT", failedReads: ["CONFIRMATION"] },
    { kind: "EDIT", failedReads: ["CONFIRMATION", "COMPENSATION_SAFETY"] },
  ] as const)(
    "does not audit $kind when actual commit is followed by failed $failedReads reads",
    async ({ kind, failedReads }) => {
      const f = await fixture(kind, { fault: "COMMIT_LOSS", failedCurrentReads: failedReads });
      const before = await f.state();
      expect(await f.run()).toEqual({
        outcome: kind === "SEND" ? "UNCONFIRMED" : "PARTIAL_FAILURE",
        messageId: f.messageId,
        ...(kind === "EDIT" ? { kind: "EDIT" } : {}),
      });
      const state = await f.state();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0]).toMatchObject({
        messageId: f.messageId,
        guildId: f.input.guildId,
        channelId: f.input.channelId,
        status: "ACTIVE",
        revision: kind === "SEND" ? 1 : 2,
        content: payload.content,
        embedTitle: payload.embed.title,
        embedColor: payload.embed.color,
        embedImageUrl: payload.embed.imageUrl,
      });
      expect(state.successes).toEqual(expect.arrayContaining(before.successes));
      const successes = state.successes.filter((row) => row.id === f.operationId);
      expect(successes).toHaveLength(1);
      expect(successes[0]).toMatchObject({
        messageId: f.messageId,
        guildId: f.input.guildId,
        channelId: f.input.channelId,
        actorType: "USER",
        actorId: f.input.actorUserId,
        event: kind === "SEND" ? "CREATED" : "EDITED",
        afterContent: payload.content,
        afterRevision: kind === "SEND" ? 1 : 2,
        afterStatus: "ACTIVE",
        outcome: "SUCCESS",
      });
      expect(state.failures).toEqual([]);
      expect(f.injected).toEqual([
        "COMMIT_LOSS",
        ...failedReads.map((stage) => `${stage}_READ_FAILED`),
      ]);
      expect(f.executed.filter((command) => command === "COMMIT")).toHaveLength(1);
      expect(
        f.executed.filter((command) => command.startsWith('insert into "managed_message_audits"')),
      ).toHaveLength(1);
      const safetyFailed = failedReads.some((stage) => stage === "COMPENSATION_SAFETY");
      expect(f.currentReads.map(({ stage, executed }) => ({ stage, executed }))).toEqual([
        { stage: "CONFIRMATION", executed: false },
        ...(kind === "EDIT" ? [{ stage: "COMPENSATION_SAFETY", executed: !safetyFailed }] : []),
      ]);
      const [confirmation, safety] = f.currentReads;
      expect(f.trace.filter((command) => command === confirmation!.command)).toHaveLength(
        kind === "SEND" ? 1 : 2,
      );
      expect(f.executed.filter((command) => command === confirmation!.command)).toHaveLength(
        kind === "EDIT" && !safetyFailed ? 1 : 0,
      );
      if (kind === "EDIT") {
        expect(safety!.command).toBe(confirmation!.command);
        expect(f.store.confirmEdit).toHaveBeenCalledOnce();
        expect(f.store.readCompensationSafety).toHaveBeenCalledOnce();
        if (!safetyFailed) expect(f.store.readCompensationSafety).toHaveResolvedWith("UNSAFE");
        expect(f.attempt().compensationEvidence).toBe(
          safetyFailed ? "SKIPPED_READ_FAILURE" : "SKIPPED_DATABASE_GUARD",
        );
      } else {
        expect(f.store.confirmCreation).toHaveBeenCalledOnce();
        expect(f.store.readCompensationSafety).not.toHaveBeenCalled();
      }
      expect(f.attempt().transactionEvidence?.disposition).toBe("UNCONFIRMED");
      expect(f.attempt().historicalSuccess).toBeUndefined();
      expect(
        f.trace.filter(
          (command) =>
            command.includes('from "managed_message_audits"') && !command.includes("join"),
        ),
      ).toEqual([]);
      expect(
        f.trace.filter((command) =>
          command.startsWith('insert into "managed_message_execution_failure_audits"'),
        ),
      ).toEqual([]);
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.remote()).toBe("NEW");
      expect(f.discord.sendManagedMessage).toHaveBeenCalledTimes(kind === "SEND" ? 1 : 0);
      expect(f.discord.editManagedMessage).toHaveBeenCalledTimes(kind === "EDIT" ? 1 : 0);
      expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(f.discord.restoreManagedMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["SEND", "EDIT"] as const)(
    "retains actual historical %s success after a later revision",
    async (kind) => {
      const f = await fixture(kind, { fault: "COMMIT_LOSS", laterEdit: true });
      await f.run();
      const state = await f.state();
      expect(state.messages[0]?.content).toBe("later");
      expect(state.successes.some((row) => row.id === f.operationId)).toBe(true);
      expect(state.failures).toEqual([]);
      expect(f.injected).toEqual(["LATER_EDIT", "COMMIT_LOSS"]);
      // Challenge the new historical gate with a contradictory candidate after business settlement.
      const candidate = {
        ...newManagedMessageExecutionAttempt(
          kind === "SEND" ? "MANAGED_MESSAGE_SEND" : "MANAGED_MESSAGE_EDIT",
          f.messageId,
        ),
        operationId: f.operationId,
        eligible: true,
        failure: {
          stage: "DISCORD_PREFLIGHT" as const,
          reasonCode: "BOT_PERMISSION_MISSING" as const,
        },
      };
      await f.recorder.record(candidate, f.input, f.success());
      expect(candidate.historicalSuccess).toBe("MATCH");
      expect((await f.state()).failures).toEqual([]);
      expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(f.discord.restoreManagedMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["SEND", "EDIT"] as const)(
    "distinguishes actual %s rollback with lost acknowledgement",
    async (kind) => {
      const f = await fixture(kind, { fault: "ROLLBACK_LOSS" });
      const before = await f.state();
      await f.run();
      expect(f.injected).toEqual(["SUCCESS_AUDIT_REJECTION", "ROLLBACK_LOSS"]);
      const after = await f.state();
      expect(after.messages).toEqual(before.messages);
      expect(after.successes).toEqual(before.successes);
      expect(after.failures).toEqual([]);
      expect(f.releases).toContain(true);
      if (kind === "SEND") expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["SEND", "EDIT"] as const)(
    "audits explicit %s COMMIT rejection after a real deferred constraint",
    async (kind) => {
      const f = await fixture(kind, { fault: "COMMIT_REJECTION" });
      const before = await f.state();
      await f.run();
      expect(f.injected).toEqual(["DEFERRED_CONSTRAINT", "COMMIT_REJECTED"]);
      const after = await f.state();
      expect(after.messages).toEqual(before.messages);
      expect(after.successes).toEqual(before.successes);
      expect(after.failures[0]).toMatchObject({
        outcome: "FAILURE",
        transactionEvidence: "COMMIT_REJECTED",
        reasonCode: "COMMIT_REJECTED",
      });
    },
  );
  it.each(["SEND", "EDIT", "DELETION"] as const)(
    "handles actual BEGIN response loss before %s callback",
    async (kind) => {
      const f = await fixture(kind, { fault: "BEGIN_LOSS" });
      await f.run();
      expect(f.injected).toEqual(["BEGIN_LOSS"]);
      expect(
        f.executed.some((command) => /^(insert into|update) "managed_messages"/.test(command)),
      ).toBe(false);
      expect((await f.state()).failures[0]?.transactionEvidence).toBe("START_FAILED");
    },
  );
  it.each(["SEND", "EDIT"] as const)(
    "records confirmed %s partial effects but not unconfirmed compensation",
    async (kind) => {
      for (const compensation of ["REJECTED", "UNCONFIRMED"] as const) {
        const f = await fixture(kind, { fault: "AUDIT_REJECTION", compensation });
        await f.run();
        expect(f.injected).toEqual(["SUCCESS_AUDIT_REJECTION"]);
        const state = await f.state();
        expect(state.failures).toHaveLength(compensation === "REJECTED" ? 1 : 0);
        if (compensation === "REJECTED") expect(state.failures[0]?.outcome).toBe("PARTIAL");
        else expect(f.remote()).toBe(kind === "SEND" ? "ABSENT" : "OLD");
      }
    },
  );
  it.each(["GUARD", "READ_FAILED"] as const)(
    "retains confirmed edit facts after compensation %s before PATCH",
    async (compensation) => {
      const f = await fixture("EDIT", { fault: "AUDIT_REJECTION", compensation });
      await f.run();
      const state = await f.state();
      expect(state.messages[0]?.content).toBe("old");
      expect(state.failures[0]?.outcome).toBe("PARTIAL");
      expect(f.remote()).toBe("NEW");
      expect(f.injected).toEqual(
        compensation === "READ_FAILED"
          ? ["SUCCESS_AUDIT_REJECTION", "SAFETY_READ_FAILED"]
          : ["SUCCESS_AUDIT_REJECTION"],
      );
    },
  );
  it("records ALREADY_ABSENT separately from deletion performed by WEFT", async () => {
    const f = await fixture("SEND", { fault: "AUDIT_REJECTION", compensation: "ALREADY_ABSENT" });
    await f.run();
    expect((await f.state()).failures[0]).toMatchObject({
      outcome: "FAILURE",
      compensationEvidence: "ALREADY_ABSENT",
    });
  });
  it.each(["NONE", "COMMIT_LOSS"] as const)(
    "preserves post-effect conditional zero transition even with %s",
    async (fault) => {
      const f = await fixture("EDIT", { zero: true, fault });
      await f.run();
      expect(f.injected).toEqual(
        fault === "NONE" ? ["COMPETING_EDIT"] : ["COMPETING_EDIT", "COMMIT_LOSS"],
      );
      const state = await f.state();
      expect(state.messages[0]).toMatchObject({ content: "concurrent", revision: 2 });
      expect(state.successes.filter((row) => row.event === "EDITED")).toHaveLength(1);
      expect(state.successes.some((row) => row.id === f.operationId)).toBe(false);
      expect(state.failures[0]).toMatchObject({
        outcome: "PARTIAL",
        databaseEffect: "NOT_TRANSITIONED",
        transactionEvidence: fault === "NONE" ? "COMMITTED" : "UNCONFIRMED",
      });
      expect(f.discord.restoreManagedMessage).not.toHaveBeenCalled();
    },
  );
  it.each(["LOSS", "REJECT"] as const)(
    "independent audit INSERT %s never changes business effects",
    async (auditFault) => {
      const f = await fixture("EDIT", { fault: "AUDIT_REJECTION", auditFault });
      expect((await f.run()).outcome).toBe("FAILURE");
      expect(f.injected).toEqual([
        "SUCCESS_AUDIT_REJECTION",
        auditFault === "LOSS" ? "FAILURE_INSERT_LOSS" : "FAILURE_INSERT_REJECTED",
      ]);
      const state = await f.state();
      expect(state.messages[0]?.content).toBe("old");
      expect(state.failures).toHaveLength(auditFault === "LOSS" ? 1 : 0);
      expect(f.publish).toHaveBeenCalledTimes(auditFault === "LOSS" ? 1 : 0);
      expect(
        f.trace.filter((command) =>
          command.startsWith('insert into "managed_message_execution_failure_audits"'),
        ),
      ).toHaveLength(1);
      expect(f.discord.editManagedMessage).toHaveBeenCalledOnce();
      expect(f.discord.restoreManagedMessage).toHaveBeenCalledOnce();
    },
  );
  it("unavailable historical read loses only the best-effort audit", async () => {
    const f = await fixture("SEND", { fault: "AUDIT_REJECTION", historyFault: "READ_FAILED" });
    expect((await f.run()).outcome).toBe("FAILURE");
    expect(f.injected).toEqual(["SUCCESS_AUDIT_REJECTION", "HISTORY_READ_FAILED"]);
    expect((await f.state()).failures).toEqual([]);
    expect(f.discord.deleteManagedMessage).toHaveBeenCalledOnce();
  });
  it("rejects an actual success-ID collision appearing between the read gate and INSERT", async () => {
    const f = await fixture("SEND", {
      fault: "AUDIT_REJECTION",
      successBetweenGateAndInsert: true,
    });
    expect((await f.run()).outcome).toBe("FAILURE");
    expect(f.injected).toEqual(["SUCCESS_AUDIT_REJECTION", "SUCCESS_AFTER_HISTORY_GATE"]);
    const state = await f.state();
    expect(state.successes.some((row) => row.id === f.operationId)).toBe(true);
    expect(state.failures).toEqual([]);
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      f.trace.filter((command) =>
        command.startsWith('insert into "managed_message_execution_failure_audits"'),
      ),
    ).toHaveLength(1);
  });
  it("does not publish a mismatched exact historical success response", async () => {
    const f = await fixture("SEND", { historyFault: "MISMATCH" });
    await f.run();
    const candidate = {
      ...newManagedMessageExecutionAttempt("MANAGED_MESSAGE_SEND"),
      operationId: f.operationId,
      eligible: true,
      failure: {
        stage: "DISCORD_PREFLIGHT" as const,
        reasonCode: "BOT_PERMISSION_MISSING" as const,
      },
    };
    await f.recorder.record(candidate, f.input, f.success());
    expect(f.injected).toEqual(["HISTORY_MISMATCH"]);
    expect(candidate.historicalSuccess).toBe("MISMATCH");
    expect((await f.state()).failures).toEqual([]);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("actual send response loss creates no DB transition, audit or resend", async () => {
    const f = await fixture("SEND", { sendLoss: true });
    await f.run();
    expect(f.remote()).toBe("NEW");
    expect((await f.state()).messages).toEqual([]);
    expect((await f.state()).failures).toEqual([]);
    expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
  });
  it.each(["NEW", "OLD", "UNKNOWN"] as const)(
    "persists only appropriate edit read-back evidence %s",
    async (editReadback) => {
      const f = await fixture("EDIT", { editReadback });
      await f.run();
      const state = await f.state();
      expect(state.messages[0]?.content).toBe(editReadback === "NEW" ? "new" : "old");
      expect(state.failures).toHaveLength(editReadback === "OLD" ? 1 : 0);
    },
  );
  it("does not duplicate a settled attempt's history or mix guild attribution", async () => {
    const f = await fixture("EDIT", { fault: "AUDIT_REJECTION" });
    await f.run();
    await Promise.all([
      f.recorder.record(f.attempt(), f.input, f.success()),
      f.recorder.record(f.attempt(), f.input, f.success()),
    ]);
    await f.recorder.record({ ...f.attempt() }, f.input, f.success());
    const rows = (await f.state()).failures;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      guildId: f.input.guildId,
      channelId: f.input.channelId,
      actorUserId: f.input.actorUserId,
      operationId: f.operationId,
    });
    expect(f.publish).toHaveBeenCalledOnce();
    expect(
      f.trace.filter((command) =>
        command.startsWith('insert into "managed_message_execution_failure_audits"'),
      ),
    ).toHaveLength(2);
    expect(
      f.executed.filter((command) =>
        command.startsWith('insert into "managed_message_execution_failure_audits"'),
      ),
    ).toHaveLength(1);
  });
  it("does not confirm an audit-ID collision with a different operation", async () => {
    const f = await fixture("EDIT", { fault: "AUDIT_REJECTION" });
    await f.run();
    const first = (await f.state()).failures[0]!;
    const publish = vi.fn();
    const recorder = createManagedMessageExecutionRecorder(
      f.database,
      { warn: vi.fn() },
      { publish },
      { generateId: () => first.id },
    );
    await recorder.record({ ...f.attempt(), operationId: randomUUID() }, f.input, f.success());
    expect((await f.state()).failures).toEqual([first]);
    expect(publish).not.toHaveBeenCalled();
    expect(f.discord.editManagedMessage).toHaveBeenCalledOnce();
    expect(f.discord.restoreManagedMessage).toHaveBeenCalledOnce();
  });
  it("preserves real revision concurrency and scoped predicates", async () => {
    const f = await fixture("EDIT"),
      store = createManagedMessageStore(observer.client);
    const transition = {
      messageId: f.messageId,
      guildId: f.input.guildId,
      channelId: f.input.channelId,
      actorUserId: f.input.actorUserId,
      expectedRevision: 1,
      previousPayload: oldPayload,
      occurredAt: at,
    };
    const results = await Promise.all(
      ["first", "second"].map((content) =>
        store.edit({ ...transition, auditId: randomUUID(), payload: { content, embed: null } }),
      ),
    );
    expect(results.sort()).toEqual(["NOT_TRANSITIONED", "TRANSITIONED"]);
    const state = await f.state();
    expect(state.messages[0]?.revision).toBe(2);
    expect(state.successes.filter((row) => row.event === "EDITED")).toHaveLength(1);
    expect(
      await store.edit({ ...transition, guildId: randomUUID(), auditId: randomUUID(), payload }),
    ).toBe("NOT_TRANSITIONED");
    expect((await f.state()).messages).toEqual(state.messages);
  });
});

function auditRow(
  change: Partial<ManagedMessageExecutionAudit> = {},
): ManagedMessageExecutionAudit {
  const guildId = randomUUID();
  guilds.push(guildId);
  return {
    id: randomUUID(),
    operationId: randomUUID(),
    successAuditId: randomUUID(),
    guildId,
    channelId: "private-channel",
    actorUserId: "actor",
    messageId: null,
    operationCode: "MANAGED_MESSAGE_SEND",
    stage: "DISCORD_PREFLIGHT",
    reasonCode: "BOT_PERMISSION_MISSING",
    outcome: "FAILURE",
    discordEvidence: "NOT_ATTEMPTED",
    payloadEvidence: "NOT_CHECKED",
    transactionEvidence: "NOT_ATTEMPTED",
    databaseEffect: "NOT_ATTEMPTED",
    compensationType: "NONE",
    compensationEvidence: "NOT_REQUIRED",
    discordEffectAt: null,
    occurredAt: at,
    ...change,
  };
}
describe("managed execution durable constraints and projection", () => {
  it.each([
    { operationCode: "UNSUPPORTED" },
    { outcome: "UNCONFIRMED" },
    { reasonCode: "arbitrary error" },
    { operationCode: "MANAGED_MESSAGE_EDIT", messageId: null },
    { outcome: "PARTIAL" },
    { databaseEffect: "NOT_APPLIED", transactionEvidence: "UNCONFIRMED" },
    { compensationEvidence: "UNCONFIRMED" },
    { compensationEvidence: "ALREADY_ABSENT" },
    { discordEvidence: "SEND_CONFIRMED", messageId: null, discordEffectAt: at },
    { discordEvidence: "SEND_CONFIRMED", messageId: "message", discordEffectAt: null },
    { stage: "DATABASE_COMMIT", reasonCode: "COMMIT_REJECTED" },
  ])("rejects invalid fixed/NULL evidence shape: %j", async (invalid) => {
    await expect(
      observer.client
        .insert(audits)
        .values(auditRow(invalid as Partial<ManagedMessageExecutionAudit>)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
  it("enforces operation and audit identity uniqueness without overwriting", async () => {
    const row = auditRow();
    await observer.client.insert(audits).values(row);
    await expect(
      observer.client.insert(audits).values({ ...row, id: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      observer.client.insert(audits).values({ ...row, operationId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    expect(await observer.client.select().from(audits).where(eq(audits.id, row.id))).toEqual([row]);
  });
  it("projects and formats actual rows without target IDs or payload fields", async () => {
    const row = auditRow({ messageId: "private-message" });
    await observer.client.insert(audits).values(row);
    const projected = await createAuditNotificationProjection(observer.client).load({
      source: "MANAGED_MESSAGE_EXECUTION_FAILURE",
      auditId: row.id,
    });
    expect(Object.keys(projected!).sort()).toEqual(
      [
        "source",
        "auditId",
        "guildId",
        "actorUserId",
        "actorType",
        "event",
        "failureStage",
        "failureCode",
        "outcome",
        "discordEvidence",
        "databaseEffect",
        "compensationEvidence",
        "occurredAt",
      ].sort(),
    );
    expect(formatAuditNotification(projected!)?.content).not.toMatch(
      /private|content|embed|https?:/,
    );
  });
  it("deletes at most 500 expired audits in timestamp/ID order while preserving business state", async () => {
    const f = await fixture("EDIT");
    const before = await f.state();
    const oldest = await observer.client
      .select({ at: sql<Date | null>`min(${audits.occurredAt})`.mapWith(audits.occurredAt) })
      .from(audits);
    const cutoff = new Date(
      Math.min(
        Date.parse("2000-01-01T00:00:00Z"),
        (oldest[0]?.at?.getTime() ?? at.getTime()) - 1000,
      ),
    );
    const row = auditRow({ guildId: f.input.guildId });
    const rows = Array.from({ length: 501 }, () => ({
      ...row,
      id: randomUUID(),
      operationId: randomUUID(),
      occurredAt: new Date(cutoff.getTime() - 1),
    }));
    const equal = { ...row, id: randomUUID(), operationId: randomUUID(), occurredAt: cutoff };
    await observer.client.insert(audits).values([...rows, equal]);
    const ordered = rows.map((value) => value.id).sort();
    const retention = createAuditRetentionStore(observer.client);
    expect(
      await retention.deleteExpiredBatch("managed_message_execution_failure_audits", cutoff, 500),
    ).toBe(500);
    const remaining = await observer.client
      .select()
      .from(audits)
      .where(eq(audits.guildId, f.input.guildId));
    expect(remaining.map((value) => value.id).sort()).toEqual([ordered[500], equal.id].sort());
    expect(
      await retention.deleteExpiredBatch("managed_message_execution_failure_audits", cutoff, 500),
    ).toBe(1);
    expect(
      await retention.deleteExpiredBatch("managed_message_execution_failure_audits", cutoff, 500),
    ).toBe(0);
    const after = await f.state();
    expect(after.messages).toEqual(before.messages);
    expect(after.successes).toEqual(before.successes);
  });
});
