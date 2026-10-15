import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bindAdministrativePool,
  type AdministrativeAttempt,
} from "../../src/administrative-transaction.js";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import type { ManagedMessageDiscord } from "../../src/messages/managed-message-discord.js";
import {
  createManagedMessageStore,
  managedMessages,
  managedMessageAudits,
} from "../../src/messages/managed-message-persistence.js";
import { createManagedMessageService } from "../../src/messages/managed-message.js";

// Maintainer-only external PostgreSQL suite. The observer is never fault-decorated.
const config = loadTestDatabaseConfig();
const observer = createDatabase(config);
const pool = new Pool({
  host: config.host,
  port: config.port,
  database: config.name,
  user: config.user,
  password: config.password,
  ssl: config.ssl ? { rejectUnauthorized: true } : false,
  max: 4,
  application_name: "weft-managed-send-evidence-test",
});
const schema = `weft_send_${randomUUID().replaceAll("-", "")}`;
const guilds: string[] = [];
const at = new Date("2030-01-01T00:00:00.123Z");
const payload = {
  content: "original",
  embed: {
    title: "Title",
    description: "Description",
    color: 12,
    imageUrl: "https://example.invalid/image.png",
  },
};
type Fault =
  "NONE" | "BEGIN_LOSS" | "AUDIT_REJECTION" | "COMMIT_REJECTION" | "COMMIT_LOSS" | "ROLLBACK_LOSS";
type Confirmation = "NORMAL" | "MISSING" | "MISMATCH" | "READ_FAILED" | "STATE_CHANGED";

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
  await observer.client
    .delete(managedMessageAudits)
    .where(inArray(managedMessageAudits.guildId, guilds));
  await observer.client.delete(managedMessages).where(inArray(managedMessages.guildId, guilds));
  await observer.client.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
  await pool.end();
  await observer.close();
});

function fixture(fault: Fault, confirmation: Confirmation = "NORMAL") {
  const guildId = randomUUID();
  guilds.push(guildId);
  const messageId = randomUUID();
  const auditId = randomUUID();
  const input = {
    guildId,
    channelId: "333333333333333333",
    actorUserId: "222222222222222222",
    payload,
  };
  const trace: string[] = [];
  const executed: string[] = [];
  const injected: string[] = [];
  const releases: boolean[] = [];
  const originalConnect = pool.connect.bind(pool);
  const originalQuery = pool.query.bind(pool);
  const commandText = (request: unknown) =>
    typeof request === "string" ? request : (request as { text: string }).text;
  const controlled = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await originalConnect();
          const query = client.query.bind(client);
          return new Proxy(client, {
            get(c, property) {
              if (property === "release")
                return (destroy: boolean) => {
                  releases.push(destroy);
                  client.release(destroy);
                };
              if (property !== "query") return Reflect.get(c, property) as unknown;
              return async (...args: unknown[]) => {
                const command = commandText(args[0]);
                trace.push(command);
                if (
                  command.startsWith('insert into "managed_message_audits"') &&
                  ["AUDIT_REJECTION", "ROLLBACK_LOSS"].includes(fault)
                ) {
                  injected.push("AUDIT_REJECTION");
                  throw new Error("Injected audit rejection after business write");
                }
                if (command === "COMMIT" && fault === "COMMIT_REJECTION") {
                  await client.query(`insert into "${schema}".child values (1)`);
                  injected.push("DEFERRED_FK");
                }
                let result: QueryResult<unknown[]>;
                try {
                  result = (await Reflect.apply(query, client, args)) as QueryResult<unknown[]>;
                } catch (error) {
                  if (command === "COMMIT" && fault === "COMMIT_REJECTION") {
                    expect(error).toMatchObject({
                      code: "23503",
                      severity: "ERROR",
                      routine: expect.any(String) as unknown,
                    });
                    injected.push("COMMIT_REJECTION");
                  }
                  throw error;
                }
                executed.push(command);
                if (command === "COMMIT" && confirmation === "STATE_CHANGED") {
                  const store = createManagedMessageStore(observer.client);
                  expect(
                    await store.edit({
                      auditId: randomUUID(),
                      messageId,
                      guildId,
                      channelId: input.channelId,
                      actorUserId: input.actorUserId,
                      expectedRevision: 1,
                      previousPayload: payload,
                      payload: { content: "later edit", embed: null },
                      occurredAt: new Date(at.getTime() + 1000),
                    }),
                  ).toBe("TRANSITIONED");
                  injected.push("STATE_CHANGED");
                }
                if (
                  (command === "BEGIN" && fault === "BEGIN_LOSS") ||
                  (command === "COMMIT" && fault === "COMMIT_LOSS") ||
                  (command === "ROLLBACK" && fault === "ROLLBACK_LOSS")
                ) {
                  expect(result.command).toBe(command);
                  injected.push(`${command}_LOSS`);
                  throw new Error("Injected response loss after actual control command");
                }
                return result;
              };
            },
          });
        };
      if (key === "query")
        return async (...args: unknown[]) => {
          const command = commandText(args[0]);
          const isConfirmation = command.includes('left join "managed_message_audits"');
          if (isConfirmation) {
            injected.push("CONFIRM_READ");
            if (confirmation === "READ_FAILED") {
              injected.push("READ_FAILED");
              throw new Error("Injected confirmation read failure");
            }
          }
          const result = (await Reflect.apply(originalQuery, pool, args)) as QueryResult<unknown[]>;
          if (isConfirmation && confirmation === "MISSING") {
            expect(result.rows).toHaveLength(1);
            injected.push("MISSING");
            return { ...result, rows: [] };
          }
          if (isConfirmation && confirmation === "MISMATCH") {
            expect(result.rows).toHaveLength(1);
            expect(result.rows[0]?.[4]).toBe(payload.content);
            injected.push("MISMATCH");
            return {
              ...result,
              rows: result.rows.map((row: unknown[]) =>
                row.map((value, index) => (index === 4 ? "mismatched content" : value)),
              ),
            };
          }
          return result;
        };
      return Reflect.get(target, key) as unknown;
    },
  });
  const database = drizzle(controlled) as unknown as DatabaseClient;
  bindAdministrativePool(database, controlled);
  const actual = createManagedMessageStore(database);
  let attempt: AdministrativeAttempt | undefined;
  const store = {
    ...actual,
    create: vi.fn<typeof actual.create>((creation, evidence) => {
      attempt = evidence;
      return actual.create(creation, evidence);
    }),
    confirmCreation: vi.fn(actual.confirmCreation),
  };
  const discord = {
    sendManagedMessage: vi.fn<ManagedMessageDiscord["sendManagedMessage"]>().mockResolvedValue({
      outcome: "SENT",
      message: { guildId, channelId: input.channelId, messageId, createdAt: at, payload },
    }),
    deleteManagedMessage: vi
      .fn<ManagedMessageDiscord["deleteManagedMessage"]>()
      .mockResolvedValue({ outcome: "DELETED" }),
    editManagedMessage: vi.fn<ManagedMessageDiscord["editManagedMessage"]>(),
    restoreManagedMessage: vi.fn<ManagedMessageDiscord["restoreManagedMessage"]>(),
  };
  const service = createManagedMessageService({
    discord,
    store,
    logger: { warn: vi.fn() },
    generateNonce: () => "stable-nonce",
    generateAuditId: () => auditId,
  });
  return {
    input,
    messageId,
    auditId,
    trace,
    executed,
    injected,
    releases,
    discord,
    service,
    store,
    attempt: () => attempt,
  };
}

async function state(f: ReturnType<typeof fixture>) {
  const messages = await observer.client
    .select()
    .from(managedMessages)
    .where(eq(managedMessages.messageId, f.messageId));
  const audits = await observer.client
    .select()
    .from(managedMessageAudits)
    .where(eq(managedMessageAudits.id, f.auditId));
  return { messages, audits };
}

describe("managed send PostgreSQL evidence and compensation", () => {
  it.each([
    ["NONE", "COMMITTED", true, true, true, 0, "SUCCESS", []],
    [
      "BEGIN_LOSS",
      "START_FAILED",
      false,
      false,
      false,
      1,
      "FAILURE",
      ["BEGIN_LOSS", "CONFIRM_READ"],
    ],
    [
      "AUDIT_REJECTION",
      "ROLLED_BACK",
      true,
      false,
      false,
      1,
      "FAILURE",
      ["AUDIT_REJECTION", "CONFIRM_READ"],
    ],
    [
      "COMMIT_REJECTION",
      "COMMIT_REJECTED",
      true,
      true,
      false,
      1,
      "FAILURE",
      ["DEFERRED_FK", "COMMIT_REJECTION", "CONFIRM_READ"],
    ],
    ["COMMIT_LOSS", "UNCONFIRMED", true, true, true, 0, "SUCCESS", ["COMMIT_LOSS", "CONFIRM_READ"]],
    [
      "ROLLBACK_LOSS",
      "UNCONFIRMED",
      true,
      false,
      false,
      0,
      "UNCONFIRMED",
      ["AUDIT_REJECTION", "ROLLBACK_LOSS", "CONFIRM_READ"],
    ],
  ] as const)(
    "actual %s proves %s",
    async (
      fault,
      disposition,
      callbackEntered,
      commitAttempted,
      committed,
      deletes,
      outcome,
      injections,
    ) => {
      const f = fixture(fault);
      expect(await f.service.send(f.input)).toMatchObject({ outcome });
      expect(f.attempt()?.transactionEvidence).toEqual({
        disposition,
        callbackEntered,
        commitAttempted,
      });
      expect(f.injected).toEqual(injections);
      expect(f.trace.filter((command) => command === "BEGIN")).toHaveLength(1);
      expect(f.trace.filter((command) => command === "COMMIT")).toHaveLength(
        commitAttempted ? 1 : 0,
      );
      expect(f.executed.filter((command) => command === "COMMIT")).toHaveLength(committed ? 1 : 0);
      expect(f.executed.filter((command) => command === "ROLLBACK")).toHaveLength(
        fault === "NONE" ? 0 : 1,
      );
      expect(
        f.executed.filter((command) => command.startsWith('insert into "managed_messages"')),
      ).toHaveLength(callbackEntered ? 1 : 0);
      expect(f.discord.deleteManagedMessage).toHaveBeenCalledTimes(deletes);
      expect(f.discord.sendManagedMessage).toHaveBeenCalledExactlyOnceWith({
        ...f.input,
        nonce: "stable-nonce",
      });
      expect(f.store.create).toHaveBeenCalledOnce();
      expect(f.releases).toEqual([disposition === "UNCONFIRMED"]);
      const observed = await state(f);
      expect(observed.messages).toHaveLength(committed ? 1 : 0);
      expect(observed.audits).toHaveLength(committed ? 1 : 0);
      if (committed) {
        expect(observed.audits[0]).toMatchObject({
          event: "CREATED",
          outcome: "SUCCESS",
          afterContent: payload.content,
          afterEmbedImageUrl: payload.embed.imageUrl,
          actorId: f.input.actorUserId,
          occurredAt: at,
        });
        expect(
          await createManagedMessageStore(observer.client).confirmCreation(
            f.store.create.mock.calls[0]![0],
          ),
        ).toBe("MATCH");
      }
    },
  );

  it.each(["MISSING", "MISMATCH", "READ_FAILED", "STATE_CHANGED"] as const)(
    "committed row and audit survive lost COMMIT response plus %s",
    async (confirmation) => {
      const f = fixture("COMMIT_LOSS", confirmation);
      expect(await f.service.send(f.input)).toEqual({
        outcome: "UNCONFIRMED",
        messageId: f.messageId,
      });
      expect(f.attempt()?.transactionEvidence).toEqual({
        disposition: "UNCONFIRMED",
        callbackEntered: true,
        commitAttempted: true,
      });
      expect(f.injected).toEqual(
        confirmation === "STATE_CHANGED"
          ? ["STATE_CHANGED", "COMMIT_LOSS", "CONFIRM_READ"]
          : ["COMMIT_LOSS", "CONFIRM_READ", confirmation],
      );
      expect(f.executed.filter((command) => command === "COMMIT")).toHaveLength(1);
      expect(f.store.create).toHaveBeenCalledOnce();
      expect(f.store.confirmCreation).toHaveBeenCalledOnce();
      expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
      const observed = await state(f);
      expect(observed.messages).toHaveLength(1);
      expect(observed.audits).toHaveLength(1);
      expect(observed.audits[0]).toMatchObject({
        event: "CREATED",
        outcome: "SUCCESS",
        afterRevision: 1,
        afterContent: payload.content,
      });
      expect(observed.messages[0]).toMatchObject({
        revision: confirmation === "STATE_CHANGED" ? 2 : 1,
        content: confirmation === "STATE_CHANGED" ? "later edit" : payload.content,
      });
      expect(
        await createManagedMessageStore(observer.client).confirmCreation(
          f.store.create.mock.calls[0]![0],
        ),
      ).toBe(confirmation === "STATE_CHANGED" ? "CONFLICT" : "MATCH");
    },
  );

  it.each(["ALREADY_ABSENT", "REJECTED", "UNCONFIRMED"] as const)(
    "confirmed rollback plus %s has no business row or success audit",
    async (deletionOutcome) => {
      const f = fixture("AUDIT_REJECTION");
      f.discord.deleteManagedMessage.mockResolvedValueOnce({ outcome: deletionOutcome });
      expect(await f.service.send(f.input)).toEqual(
        deletionOutcome === "ALREADY_ABSENT"
          ? { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT" }
          : { outcome: "PARTIAL_FAILURE", messageId: f.messageId, deletionOutcome },
      );
      expect(f.attempt()?.transactionEvidence?.disposition).toBe("ROLLED_BACK");
      expect(f.injected).toEqual(["AUDIT_REJECTION", "CONFIRM_READ"]);
      expect(
        f.executed.filter((command) => command.startsWith('insert into "managed_messages"')),
      ).toHaveLength(1);
      expect(f.executed.filter((command) => command === "ROLLBACK")).toHaveLength(1);
      expect(f.discord.deleteManagedMessage).toHaveBeenCalledOnce();
      expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(f.store.create).toHaveBeenCalledOnce();
      expect(await state(f)).toEqual({ messages: [], audits: [] });
    },
  );
});
