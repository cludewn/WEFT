import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import { managedMessageAudits, managedMessages } from "../../src/managed-message-persistence.js";
import {
  createScheduledActionStore,
  scheduledActions,
} from "../../src/scheduled-action-persistence.js";
import {
  createScheduledMessageStore,
  scheduledMessageAudits,
  scheduledMessageStates,
  type CreateScheduledMessage,
} from "../../src/scheduled-message-persistence.js";
import {
  createScheduledThreadCloseStore,
  scheduledThreadCloseAudits,
} from "../../src/scheduled-thread-close-persistence.js";

const guildId = "scheduled-message-guild";
const channelId = "scheduled-message-channel";
const actorId = "scheduled-message-actor";
const executeAt = new Date("2030-01-02T03:04:05.678Z");
const occurredAt = new Date("2026-09-16T01:02:03.456Z");
const database = createDatabase(loadTestDatabaseConfig());
const store = createScheduledMessageStore(database.client);

type MigrationJournal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

beforeEach(cleanup);

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("scheduled message persistence", () => {
  it("upgrades representative actual 0011 scheduling and managed-message state through 0012", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_sm_${suffix}`;
    const migrationsSchema = `weft_smg_${suffix}`;
    const migrationDirectory = await createMigrationSubsetThrough0011();
    const shadowActionId = `upgrade-new-message-${suffix}`;
    let isolatedPool: Pool | undefined;

    try {
      await database.client.execute(sql`create schema ${sql.identifier(schemaName)}`);
      isolatedPool = new Pool({
        host: testConfig.host,
        port: testConfig.port,
        database: testConfig.name,
        user: testConfig.user,
        password: testConfig.password,
        ssl: testConfig.ssl ? { rejectUnauthorized: true } : false,
        application_name: "weft-scheduled-message-upgrade-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolatedDatabase = drizzle(isolatedPool, {
        schema: {
          managedMessageAudits,
          managedMessages,
          scheduledActions,
          scheduledMessageAudits,
          scheduledMessageStates,
          scheduledThreadCloseAudits,
        },
      });

      await migrate(isolatedDatabase, {
        migrationsFolder: migrationDirectory,
        migrationsSchema,
      });

      const historicalCreatedAt = new Date("2026-09-01T01:02:03.456Z");
      const historicalUpdatedAt = new Date("2026-09-02T04:05:06.789Z");
      await isolatedDatabase.execute(sql`
        insert into scheduled_actions
          (id, guild_id, action_type, target_id, status, execute_at, created_at, updated_at)
        values
          ('upgrade-active-close', 'upgrade-guild', 'CLOSE_THREAD', 'upgrade-thread-active', 'ACTIVE',
           ${new Date("2030-01-01T00:00:00.000Z")}, ${historicalCreatedAt}, ${historicalUpdatedAt}),
          ('upgrade-completed-close', 'upgrade-guild', 'CLOSE_THREAD', 'upgrade-thread-completed', 'COMPLETED',
           ${new Date("2029-01-01T00:00:00.000Z")}, ${historicalCreatedAt}, ${historicalUpdatedAt}),
          ('upgrade-send-envelope', 'upgrade-guild', 'SEND_MESSAGE', 'upgrade-channel', 'ACTIVE',
           ${new Date("2030-02-01T00:00:00.000Z")}, ${historicalCreatedAt}, ${historicalUpdatedAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_thread_close_audits
          (id, scheduled_action_id, guild_id, thread_id, event, actor_type, actor_id,
           execute_at, outcome, failure_code, created_at)
        values
          ('upgrade-close-created', 'upgrade-active-close', 'upgrade-guild', 'upgrade-thread-active',
           'CREATED', 'USER', 'upgrade-actor', ${new Date("2030-01-01T00:00:00.000Z")},
           'SUCCESS', null, ${historicalCreatedAt}),
          ('upgrade-close-completed', 'upgrade-completed-close', 'upgrade-guild', 'upgrade-thread-completed',
           'EXECUTION_COMPLETED', 'SYSTEM', null, ${new Date("2029-01-01T00:00:00.000Z")},
           'SUCCESS', null, ${historicalUpdatedAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, embed_title, embed_color,
           revision, status, created_at, updated_at)
        values
          ('upgrade-managed-message', 'upgrade-guild', 'upgrade-channel', 'upgrade-actor',
           'managed content', 'managed title', 0, 1, 'ACTIVE',
           ${historicalCreatedAt}, ${historicalUpdatedAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into managed_message_audits
          (id, message_id, guild_id, channel_id, event, actor_type, actor_id,
           before_content, after_content, after_embed_title, after_embed_color,
           before_revision, after_revision, before_status, after_status, occurred_at, outcome)
        values
          ('upgrade-managed-created', 'upgrade-managed-message', 'upgrade-guild', 'upgrade-channel',
           'CREATED', 'USER', 'upgrade-actor', null, 'managed content', 'managed title', 0,
           null, 1, null, 'ACTIVE', ${historicalCreatedAt}, 'SUCCESS')
      `);

      const before = await readRepresentativeUpgradeState(isolatedDatabase);
      await migrate(isolatedDatabase, {
        migrationsFolder: "drizzle",
        migrationsSchema,
      });
      const after = await readRepresentativeUpgradeState(isolatedDatabase);
      expect(after).toEqual(before);
      await expect(isolatedDatabase.select().from(scheduledMessageStates)).resolves.toHaveLength(0);
      await expect(isolatedDatabase.select().from(scheduledMessageAudits)).resolves.toHaveLength(0);

      const isolatedClient = isolatedDatabase as unknown as DatabaseClient;
      const isolatedActions = createScheduledActionStore(isolatedClient);
      await expect(isolatedActions.findById("upgrade-active-close")).resolves.toMatchObject({
        actionType: "CLOSE_THREAD",
        status: "ACTIVE",
      });
      const isolatedCloseStore = createScheduledThreadCloseStore(isolatedClient);
      await expect(
        isolatedCloseStore.createOrReplace({
          scheduledActionId: "upgrade-new-close",
          auditId: "upgrade-new-close-audit",
          guildId: "upgrade-guild",
          threadId: "upgrade-new-thread",
          actorId: "upgrade-actor",
          executeAt: new Date("2030-03-01T00:00:00.000Z"),
        }),
      ).resolves.toMatchObject({ outcome: "CREATED" });

      // Migration SQL qualifies this production FK with public, so the schema-isolated upgrade
      // fixture supplies the corresponding public parent while exercising the unchanged SQL.
      await database.client.insert(scheduledActions).values({
        id: shadowActionId,
        guildId: "upgrade-shadow-guild",
        actionType: "SEND_MESSAGE",
        targetId: "upgrade-shadow-channel",
        status: "ACTIVE",
        executeAt,
      });
      const isolatedMessageStore = createScheduledMessageStore(isolatedClient);
      await expect(
        isolatedMessageStore.create({
          scheduledActionId: shadowActionId,
          auditId: `audit-${shadowActionId}`,
          guildId: "upgrade-guild",
          channelId: "upgrade-new-channel",
          actorId: "upgrade-actor",
          executeAt,
          payload: { content: "new scheduled message", embed: null },
          occurredAt,
        }),
      ).resolves.toMatchObject({
        action: { id: shadowActionId, actionType: "SEND_MESSAGE", status: "ACTIVE" },
        payload: { content: "new scheduled message", embed: null },
        resultMessageId: null,
      });
    } finally {
      await isolatedPool?.end();
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
      );
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await database.client.delete(scheduledActions).where(eq(scheduledActions.id, shadowActionId));
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it.each([
    ["text-only", "text-only-action", { content: "text only", embed: null }],
    [
      "embed-only",
      "embed-only-action",
      {
        content: "",
        embed: {
          title: "title",
          description: "description",
          color: 0,
          imageUrl: "https://example.invalid/embed-only.png",
        },
      },
    ],
    [
      "combined with nullable embed fields",
      "combined-action",
      { content: "combined", embed: { description: "description", color: 0 } },
    ],
  ] as const)(
    "atomically creates a %s action, state, and CREATED audit",
    async (_name, id, payload) => {
      const input = creation(id, payload);
      const result = await store.create(input);

      expect(result).toMatchObject({
        action: {
          id,
          guildId,
          actionType: "SEND_MESSAGE",
          targetId: channelId,
          status: "ACTIVE",
          executeAt,
        },
        payload,
        resultMessageId: null,
      });
      await expect(store.find(id)).resolves.toEqual(result);
      const [state] = await database.client
        .select()
        .from(scheduledMessageStates)
        .where(eq(scheduledMessageStates.scheduledActionId, id));
      expect(state).toMatchObject({ resultMessageId: null });
      const [audit] = await database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, input.auditId));
      expect(audit).toMatchObject({
        scheduledActionId: id,
        guildId,
        channelId,
        event: "CREATED",
        actorType: "USER",
        actorId,
        executeAt,
        occurredAt,
        outcome: "SUCCESS",
      });
      expect(audit?.embedColor).toBe(payload.embed?.color ?? null);
      await expect(store.confirmCreation(input)).resolves.toMatchObject({ outcome: "MATCH" });
    },
  );

  it("allows multiple ACTIVE SEND_MESSAGE actions for the same guild and channel", async () => {
    await store.create(creation("same-target-one", { content: "one", embed: null }));
    await store.create(creation("same-target-two", { content: "two", embed: null }));

    const actions = await database.client
      .select()
      .from(scheduledActions)
      .where(
        and(
          eq(scheduledActions.guildId, guildId),
          eq(scheduledActions.targetId, channelId),
          eq(scheduledActions.actionType, "SEND_MESSAGE"),
          eq(scheduledActions.status, "ACTIVE"),
        ),
      );
    expect(actions).toHaveLength(2);
  });

  it.each(["state", "audit"] as const)(
    "enforces every structural payload constraint on the %s table",
    async (target) => {
      const cases = [
        ["empty", "", null, null, null, null],
        ["color-only", "text", null, null, 0, null],
        ["content-long", "x".repeat(2_001), null, null, null, null],
        ["title-empty", "", "", null, null, null],
        ["title-long", "", "x".repeat(257), null, null, null],
        ["description-empty", "", null, "", null, null],
        ["description-long", "", null, "x".repeat(4_001), null, null],
        ["image-empty", "", null, null, null, ""],
        ["image-long", "", null, null, null, "x".repeat(2_049)],
        ["color-low", "", "visible", null, -1, null],
        ["color-high", "", "visible", null, 16_777_216, null],
      ] as const;

      for (const [suffix, content, title, description, color, imageUrl] of cases) {
        const actionId = `${target}-${suffix}`;
        if (target === "state") await insertAction(actionId, "SEND_MESSAGE", actionId);
        await expect(
          insertDirectPayload(target, {
            id: actionId,
            content,
            title,
            description,
            color,
            imageUrl,
          }),
        ).rejects.toThrow();
      }
    },
  );

  it("rolls back action and state when the audit insert fails", async () => {
    const input = creation("audit-failure-action", { content: "will roll back", embed: null });
    await insertDirectAudit({
      id: input.auditId,
      scheduledActionId: "unrelated-action",
      content: "existing audit",
    });

    await expect(store.create(input)).rejects.toThrow();
    await expect(store.find(input.scheduledActionId)).resolves.toBeUndefined();
    await expect(
      database.client
        .select()
        .from(scheduledActions)
        .where(eq(scheduledActions.id, input.scheduledActionId)),
    ).resolves.toHaveLength(0);
  });

  it("does not corrupt existing state when stable IDs are duplicated or stale", async () => {
    const original = creation("stable-action", { content: "original", embed: null });
    await store.create(original);

    await expect(
      store.create({
        ...original,
        auditId: "different-audit-id",
        channelId: "different-channel",
        payload: { content: "replacement", embed: null },
      }),
    ).rejects.toThrow();
    await expect(store.find(original.scheduledActionId)).resolves.toMatchObject({
      action: { targetId: channelId },
      payload: original.payload,
      resultMessageId: null,
    });
    await expect(store.confirmCreation(original)).resolves.toMatchObject({ outcome: "MATCH" });
  });

  it("confirms a committed transaction after response loss without a second write", async () => {
    const responseLoss = new Error("response lost after commit");
    const responseLossDatabase = transactionResponseLossDatabase(responseLoss);
    const responseLossStore = createScheduledMessageStore(responseLossDatabase);
    const input = creation("response-loss-action", {
      content: "",
      embed: { title: "committed", color: 0 },
    });

    await expect(responseLossStore.create(input)).resolves.toMatchObject({
      action: { id: input.scheduledActionId, status: "ACTIVE" },
      payload: input.payload,
      resultMessageId: null,
    });
    await expect(store.confirmCreation(input)).resolves.toMatchObject({ outcome: "MATCH" });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId)),
    ).resolves.toHaveLength(1);
  });

  it("preserves the original transaction error when confirmation cannot be read", async () => {
    const originalError = new Error("original response loss");
    const confirmationError = new Error("confirmation read failed");
    const failingDatabase = transactionResponseLossDatabase(originalError, confirmationError);
    const failingStore = createScheduledMessageStore(failingDatabase);
    const input = creation("confirmation-read-failure", { content: "committed", embed: null });

    let thrown: unknown;
    try {
      await failingStore.create(input);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(originalError);
    await expect(store.confirmCreation(input)).resolves.toMatchObject({ outcome: "MATCH" });
  });

  it("rejects partial and mismatched exact confirmation", async () => {
    const exact = creation("exact-action", {
      content: "exact",
      embed: {
        title: "title",
        description: "description",
        color: 0,
        imageUrl: "https://example.invalid/exact.png",
      },
    });
    await store.create(exact);
    await expect(store.confirmCreation(exact)).resolves.toMatchObject({ outcome: "MATCH" });
    await expect(
      store.confirmCreation({ ...exact, auditId: "wrong-audit-id" }),
    ).resolves.toMatchObject({ outcome: "CONFLICT" });
    await expect(
      store.confirmCreation({
        ...exact,
        payload: { ...exact.payload, embed: { ...exact.payload.embed, color: 1 } },
      }),
    ).resolves.toMatchObject({ outcome: "CONFLICT" });

    const rowOnly = creation("row-only-action", { content: "row only", embed: null });
    await insertAction(rowOnly.scheduledActionId, "SEND_MESSAGE", channelId);
    await expect(store.confirmCreation(rowOnly)).resolves.toMatchObject({ outcome: "CONFLICT" });

    const missingAudit = creation("missing-audit-action", { content: "no audit", embed: null });
    await insertAction(missingAudit.scheduledActionId, "SEND_MESSAGE", channelId);
    await database.client.insert(scheduledMessageStates).values({
      scheduledActionId: missingAudit.scheduledActionId,
      content: missingAudit.payload.content,
    });
    await expect(store.confirmCreation(missingAudit)).resolves.toMatchObject({
      outcome: "CONFLICT",
    });
  });

  it("keeps CLOSE_THREAD uniqueness scoped away from SEND_MESSAGE", async () => {
    await insertAction("unique-close-one", "CLOSE_THREAD", "shared-target");
    await expect(
      insertAction("unique-close-two", "CLOSE_THREAD", "shared-target"),
    ).rejects.toThrow();

    await expect(
      insertAction("unique-send-one", "SEND_MESSAGE", "shared-target"),
    ).resolves.toBeDefined();
    await expect(
      insertAction("unique-send-two", "SEND_MESSAGE", "shared-target"),
    ).resolves.toBeDefined();
  });
});

function creation(
  scheduledActionId: string,
  payload: CreateScheduledMessage["payload"],
): CreateScheduledMessage {
  return {
    scheduledActionId,
    auditId: `audit-${scheduledActionId}`,
    guildId,
    channelId,
    actorId,
    executeAt,
    payload,
    occurredAt,
  };
}

async function insertAction(
  id: string,
  actionType: "CLOSE_THREAD" | "SEND_MESSAGE",
  targetId: string,
) {
  return database.client.insert(scheduledActions).values({
    id,
    guildId,
    actionType,
    targetId,
    status: "ACTIVE",
    executeAt,
  });
}

type DirectPayload = {
  id: string;
  content: string;
  title: string | null;
  description: string | null;
  color: number | null;
  imageUrl: string | null;
};

function insertDirectPayload(target: "state" | "audit", payload: DirectPayload) {
  if (target === "state") {
    return database.client.execute(sql`
      insert into scheduled_message_states
        (scheduled_action_id, content, embed_title, embed_description, embed_color, embed_image_url)
      values
        (${payload.id}, ${payload.content}, ${payload.title}, ${payload.description}, ${payload.color}, ${payload.imageUrl})
    `);
  }
  return database.client.execute(sql`
    insert into scheduled_message_audits
      (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
       execute_at, content, embed_title, embed_description, embed_color, embed_image_url,
       occurred_at, outcome)
    values
      (${`audit-${payload.id}`}, ${payload.id}, ${guildId}, ${channelId}, 'CREATED', 'USER',
       ${actorId}, ${executeAt}, ${payload.content}, ${payload.title}, ${payload.description},
       ${payload.color}, ${payload.imageUrl}, ${occurredAt}, 'SUCCESS')
  `);
}

function insertDirectAudit(input: { id: string; scheduledActionId: string; content: string }) {
  return database.client.insert(scheduledMessageAudits).values({
    id: input.id,
    scheduledActionId: input.scheduledActionId,
    guildId,
    channelId,
    event: "CREATED",
    actorType: "USER",
    actorId,
    executeAt,
    content: input.content,
    occurredAt,
    outcome: "SUCCESS",
  });
}

function transactionResponseLossDatabase(
  transactionError: Error,
  confirmationError?: Error,
): DatabaseClient {
  let transactionCommitted = false;
  const transaction = database.client.transaction.bind(database.client);
  return new Proxy(database.client, {
    get(target, property): unknown {
      if (property === "transaction") {
        return async (callback: never) => {
          await transaction(callback);
          transactionCommitted = true;
          throw transactionError;
        };
      }
      if (property === "select" && transactionCommitted && confirmationError !== undefined) {
        return () => {
          throw confirmationError;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(scheduledMessageAudits)
    .where(eq(scheduledMessageAudits.guildId, guildId));
  const actions = await database.client
    .select({ id: scheduledActions.id })
    .from(scheduledActions)
    .where(eq(scheduledActions.guildId, guildId));
  const actionIds = actions.map((action) => action.id);
  if (actionIds.length > 0) {
    await database.client
      .delete(scheduledMessageStates)
      .where(inArray(scheduledMessageStates.scheduledActionId, actionIds));
    await database.client.delete(scheduledActions).where(inArray(scheduledActions.id, actionIds));
  }
}

async function createMigrationSubsetThrough0011(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-scheduled-message-migrations-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= 11);
  await writeFile(
    join(metaDirectory, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, undefined, 2)}\n`,
    "utf8",
  );
  await Promise.all(
    entries.map((entry) =>
      cp(join("drizzle", `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`)),
    ),
  );
  return directory;
}

async function readRepresentativeUpgradeState(isolatedDatabase: ReturnType<typeof drizzle>) {
  const actions = await isolatedDatabase
    .select()
    .from(scheduledActions)
    .orderBy(asc(scheduledActions.id));
  const closeAudits = await isolatedDatabase
    .select()
    .from(scheduledThreadCloseAudits)
    .orderBy(asc(scheduledThreadCloseAudits.id));
  const messages = await isolatedDatabase
    .select()
    .from(managedMessages)
    .orderBy(asc(managedMessages.messageId));
  const messageAudits = await isolatedDatabase
    .select()
    .from(managedMessageAudits)
    .orderBy(asc(managedMessageAudits.id));
  return { actions, closeAudits, messages, messageAudits };
}
