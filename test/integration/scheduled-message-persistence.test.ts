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
  it("upgrades representative actual 0012 state through 0013", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_sm_${suffix}`;
    const migrationsSchema = `weft_smg_${suffix}`;
    const migrationDirectory = await createMigrationSubsetThrough0012();
    const shadowActionId = `upgrade-new-message-${suffix}`;
    const historicalShadowActionId = `upgrade-send-envelope-${suffix}`;
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
          (${historicalShadowActionId}, 'upgrade-guild', 'SEND_MESSAGE', 'upgrade-channel', 'ACTIVE',
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
      await database.client.insert(scheduledActions).values({
        id: historicalShadowActionId,
        guildId: "upgrade-shadow-guild",
        actionType: "SEND_MESSAGE",
        targetId: "upgrade-shadow-channel",
        status: "ACTIVE",
        executeAt,
      });
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_states
          (scheduled_action_id, content, embed_title, embed_color, result_message_id)
        values
          (${historicalShadowActionId}, 'scheduled content', 'scheduled title', 0, null)
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_audits
          (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
           execute_at, content, embed_title, embed_color, occurred_at, outcome)
        values
          ('upgrade-scheduled-created', ${historicalShadowActionId}, 'upgrade-guild', 'upgrade-channel',
           'CREATED', 'USER', 'upgrade-creator', ${new Date("2030-02-01T00:00:00.000Z")},
           'scheduled content', 'scheduled title', 0, ${historicalCreatedAt}, 'SUCCESS')
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
      await expect(isolatedDatabase.select().from(scheduledMessageStates)).resolves.toEqual([
        expect.objectContaining({
          scheduledActionId: historicalShadowActionId,
          creatorUserId: "upgrade-creator",
          retryCount: 0,
          resultMessageId: null,
        }),
      ]);
      await expect(isolatedDatabase.select().from(scheduledMessageAudits)).resolves.toEqual([
        expect.objectContaining({
          id: "upgrade-scheduled-created",
          event: "CREATED",
          actorId: "upgrade-creator",
          failureCode: null,
          resultMessageId: null,
        }),
      ]);

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
      await database.client
        .delete(scheduledActions)
        .where(eq(scheduledActions.id, historicalShadowActionId));
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("upgrades representative actual 0013 state through 0014 without changing history", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_sm_14_${suffix}`;
    const migrationsSchema = `weft_smg_14_${suffix}`;
    const actionId = `upgrade-0014-${suffix}`;
    const migrationDirectory = await createMigrationSubset(13);
    const upgradeMigrationDirectory = await createMigrationSubset(14);
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
        application_name: "weft-scheduled-message-0014-upgrade-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolatedDatabase = drizzle(isolatedPool);
      await migrate(isolatedDatabase, { migrationsFolder: migrationDirectory, migrationsSchema });

      // The unchanged 0012 SQL schema-qualifies this FK with public.
      await database.client.insert(scheduledActions).values({
        id: actionId,
        guildId: "upgrade-shadow-guild",
        actionType: "SEND_MESSAGE",
        targetId: "upgrade-shadow-channel",
        status: "ACTIVE",
        executeAt,
      });
      await isolatedDatabase.execute(sql`
        insert into scheduled_actions
          (id, guild_id, action_type, target_id, status, execute_at, created_at, updated_at)
        values
          (${actionId}, 'upgrade-guild', 'SEND_MESSAGE', 'upgrade-channel', 'COMPLETED',
           ${executeAt}, ${occurredAt}, ${occurredAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_states
          (scheduled_action_id, creator_user_id, retry_count, content, embed_title,
           embed_description, embed_color, embed_image_url, result_message_id)
        values
          (${actionId}, 'upgrade-creator', 1, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/historical.png',
           'historical-message')
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_audits
          (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
           execute_at, content, embed_title, embed_description, embed_color, embed_image_url,
           occurred_at, outcome, failure_code, result_message_id)
        values
          ('history-created', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CREATED',
           'USER', 'upgrade-creator', ${executeAt}, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/historical.png', ${occurredAt},
           'SUCCESS', null, null),
          ('history-completed', ${actionId}, 'upgrade-guild', 'upgrade-channel',
           'EXECUTION_COMPLETED', 'SYSTEM', null, ${executeAt}, 'historical content',
           'historical title', 'historical description', 0,
           'https://example.invalid/historical.png', ${occurredAt}, 'SUCCESS', null,
           'historical-message'),
          ('history-retry', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'EXECUTION_RETRY',
           'SYSTEM', null, ${executeAt}, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/historical.png', ${occurredAt},
           'FAILURE', 'CURRENT_STATE_CHECK_FAILED', null),
          ('history-failed', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'EXECUTION_FAILED',
           'SYSTEM', null, ${executeAt}, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/historical.png', ${occurredAt},
           'FAILURE', 'SEND_REJECTED', null)
      `);

      const readHistoricalRows = () =>
        Promise.all([
          isolatedDatabase.execute(sql`select * from scheduled_actions order by id`),
          isolatedDatabase.execute(
            sql`select * from scheduled_message_states order by scheduled_action_id`,
          ),
          isolatedDatabase.execute(sql`
            select id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
                   execute_at, content, embed_title, embed_description, embed_color, embed_image_url,
                   occurred_at, outcome, failure_code, result_message_id
            from scheduled_message_audits order by id
          `),
        ]).then((results) => results.map((result) => result.rows));
      const before = await readHistoricalRows();
      await migrate(isolatedDatabase, {
        migrationsFolder: upgradeMigrationDirectory,
        migrationsSchema,
      });
      const after = await readHistoricalRows();
      expect(after).toEqual(before);

      await expect(
        isolatedDatabase.execute(sql`
          insert into scheduled_message_audits
            (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
             execute_at, content, embed_title, embed_description, embed_color, embed_image_url,
             occurred_at, outcome, failure_code, result_message_id)
          values
            ('valid-cancelled', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CANCELLED',
             'USER', 'cancelling-user', ${executeAt}, 'historical content', 'historical title',
             'historical description', 0, 'https://example.invalid/historical.png',
             ${occurredAt}, 'SUCCESS', null, null)
        `),
      ).resolves.toBeDefined();

      const invalidShapes = [
        ["invalid-system", "SYSTEM", "system-actor", "SUCCESS", null, null],
        ["invalid-null-actor", "USER", null, "SUCCESS", null, null],
        [
          "invalid-failure-outcome",
          "USER",
          "cancelling-user",
          "FAILURE",
          "CURRENT_STATE_CHECK_FAILED",
          null,
        ],
        [
          "invalid-failure-code",
          "USER",
          "cancelling-user",
          "SUCCESS",
          "CURRENT_STATE_CHECK_FAILED",
          null,
        ],
        ["invalid-result-message", "USER", "cancelling-user", "SUCCESS", null, "message-id"],
      ] as const;
      for (const [id, actorType, actorId, outcome, failureCode, resultMessageId] of invalidShapes) {
        await expect(
          isolatedDatabase.execute(sql`
            insert into scheduled_message_audits
              (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
               execute_at, content, occurred_at, outcome, failure_code, result_message_id)
            values
              (${id}, ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CANCELLED',
               ${actorType}, ${actorId}, ${executeAt}, 'historical content', ${occurredAt},
               ${outcome}, ${failureCode}, ${resultMessageId})
          `),
        ).rejects.toThrow();
      }
    } finally {
      await isolatedPool?.end();
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
      );
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await database.client.delete(scheduledActions).where(eq(scheduledActions.id, actionId));
      await rm(migrationDirectory, { recursive: true, force: true });
      await rm(upgradeMigrationDirectory, { recursive: true, force: true });
    }
  });

  it.each(["missing", "duplicate", "mismatched"] as const)(
    "rejects a %s Phase 8A creator source while applying actual 0013",
    async (mode) => {
      await expectPhase8BCreatorBackfillFailure(mode);
    },
  );

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
      expect(state).toMatchObject({
        creatorUserId: actorId,
        retryCount: 0,
        resultMessageId: null,
      });
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

  it("enforces retry-count bounds and exposes the exact ACTIVE SEND_MESSAGE index", async () => {
    const input = creation("retry-constraint-action", { content: "bounded", embed: null });
    await store.create(input);
    await expect(
      database.client
        .update(scheduledMessageStates)
        .set({ retryCount: 4 })
        .where(eq(scheduledMessageStates.scheduledActionId, input.scheduledActionId)),
    ).rejects.toThrow();
    const index = await database.client.execute<{ indexDefinition: string }>(sql`
      select indexdef as "indexDefinition"
      from pg_indexes
      where schemaname = current_schema()
        and indexname = 'scheduled_actions_active_send_execute_at_id_idx'
    `);
    expect(index.rows).toHaveLength(1);
    expect(index.rows[0]?.indexDefinition).toContain("(execute_at, id)");
    expect(index.rows[0]?.indexDefinition).toContain("action_type = 'SEND_MESSAGE'");
    expect(index.rows[0]?.indexDefinition).toContain("status = 'ACTIVE'");
  });

  it("pages ACTIVE SEND_MESSAGE actions by stable executeAt and ID without terminal rows", async () => {
    const actions = createScheduledActionStore(database.client);
    await Promise.all([
      store.create({ ...creation("page-b", { content: "b", embed: null }), executeAt }),
      store.create({ ...creation("page-a", { content: "a", embed: null }), executeAt }),
      store.create({
        ...creation("page-c", { content: "c", embed: null }),
        executeAt: new Date(executeAt.getTime() + 1),
      }),
    ]);
    await database.client
      .update(scheduledActions)
      .set({ status: "FAILED" })
      .where(eq(scheduledActions.id, "page-b"));

    await expect(actions.findActiveScheduledMessagesPage()).resolves.toEqual([
      expect.objectContaining({ id: "page-a" }),
      expect.objectContaining({ id: "page-c" }),
    ]);
  });

  it("distinguishes a missing action from a SEND_MESSAGE action with missing required state", async () => {
    const input = creation("missing-required-state", {
      content: "historical payload",
      embed: null,
    });
    await store.create(input);
    await database.client
      .delete(scheduledMessageStates)
      .where(eq(scheduledMessageStates.scheduledActionId, input.scheduledActionId));

    await expect(store.findForExecution("genuinely-missing-action")).resolves.toEqual({
      outcome: "MISSING_ACTION",
    });
    await expect(store.findForExecution(input.scheduledActionId)).resolves.toMatchObject({
      outcome: "STATE_MISSING",
      action: { id: input.scheduledActionId, status: "ACTIVE" },
    });

    const claim = await store.claimExecution(input.scheduledActionId, undefined);
    expect(claim).toMatchObject({
      outcome: "COMMITTED_STATE_MISSING",
      action: { id: input.scheduledActionId, status: "EXECUTING" },
    });
    if (claim.outcome !== "COMMITTED_STATE_MISSING") throw new Error("missing state claim failed");
    await expect(
      store.failMissingState({
        action: claim.action,
        auditId: "missing-state-failure-audit",
        occurredAt,
      }),
    ).resolves.toEqual({ outcome: "COMMITTED" });

    const actions = createScheduledActionStore(database.client);
    await expect(actions.findById(input.scheduledActionId)).resolves.toMatchObject({
      status: "FAILED",
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, "missing-state-failure-audit")),
    ).resolves.toEqual([
      expect.objectContaining({
        event: "EXECUTION_FAILED",
        actorType: "SYSTEM",
        actorId: null,
        content: "historical payload",
        failureCode: "PERSISTED_PAYLOAD_INVALID",
        resultMessageId: null,
      }),
    ]);
    await expect(actions.findActiveScheduledMessagesPage()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: input.scheduledActionId })]),
    );
  });

  it("persists the three safe pre-send retries and then fails terminally", async () => {
    const input = creation("retry-budget-action", { content: "retry me", embed: null });
    let definition = await store.create(input);
    for (let retryCount = 1; retryCount <= 3; retryCount += 1) {
      const claim = await store.claimExecution(input.scheduledActionId, 0);
      expect(claim.outcome).toBe("COMMITTED");
      if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
      const retried = await store.retryPreSendFailure({
        definition: claim.definition,
        auditId: `retry-audit-${retryCount}`,
        occurredAt: new Date(occurredAt.getTime() + retryCount),
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      });
      expect(retried).toMatchObject({ outcome: "COMMITTED", definition: { retryCount } });
      if (retried.outcome !== "COMMITTED") throw new Error("retry failed");
      definition = retried.definition;
    }
    expect(definition.retryCount).toBe(3);

    const finalClaim = await store.claimExecution(input.scheduledActionId, 0);
    if (finalClaim.outcome !== "COMMITTED") throw new Error("final claim failed");
    const failed = await store.failExecution({
      definition: finalClaim.definition,
      auditId: "retry-exhausted-audit",
      occurredAt: new Date(occurredAt.getTime() + 4),
      failureCode: "CURRENT_STATE_CHECK_FAILED",
      resultMessageId: null,
    });
    expect(failed).toMatchObject({
      outcome: "COMMITTED",
      definition: { retryCount: 3, action: { status: "FAILED" } },
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId)),
    ).resolves.toHaveLength(5);
  });

  it("rolls back a safe retry when its execution audit cannot be inserted", async () => {
    const input = creation("retry-audit-rollback", { content: "retry rollback", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    await insertDirectAudit({
      id: "conflicting-retry-audit",
      scheduledActionId: "unrelated-action",
      content: "existing audit",
    });

    await expect(
      store.retryPreSendFailure({
        definition: claim.definition,
        auditId: "conflicting-retry-audit",
        occurredAt,
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      }),
    ).rejects.toThrow();
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "EXECUTING" },
      retryCount: 0,
      resultMessageId: null,
    });
  });

  it("exactly confirms a safe retry after database response loss", async () => {
    const input = creation("retry-response-loss", { content: "retry response loss", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    const responseLossStore = createScheduledMessageStore(
      transactionResponseLossDatabase(new Error("response lost")),
    );

    await expect(
      responseLossStore.retryPreSendFailure({
        definition: claim.definition,
        auditId: "confirmed-retry-audit",
        occurredAt,
        failureCode: "CURRENT_STATE_CHECK_FAILED",
      }),
    ).resolves.toMatchObject({ outcome: "COMMITTED", definition: { retryCount: 1 } });
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "ACTIVE" },
      retryCount: 1,
    });
  });

  it("allows only one concurrent ACTIVE to EXECUTING claim", async () => {
    const input = creation("concurrent-claim", { content: "claim once", embed: null });
    await store.create(input);

    const results = await Promise.all([
      store.claimExecution(input.scheduledActionId, 0),
      store.claimExecution(input.scheduledActionId, 0),
    ]);
    expect(results.filter((result) => result.outcome === "COMMITTED")).toHaveLength(1);
    expect(results.filter((result) => result.outcome === "NOT_TRANSITIONED")).toHaveLength(1);
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId)),
    ).resolves.toHaveLength(1);
  });

  it("persists an uncompensated terminal failure without changing retry or state result ID", async () => {
    const input = creation("uncompensated-failure", { content: "terminal", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");

    await expect(
      store.failExecution({
        definition: claim.definition,
        auditId: "uncompensated-failure-audit",
        occurredAt,
        failureCode: "FINALIZATION_FAILED_UNCOMPENSATED",
        resultMessageId: "possible-stray-message",
      }),
    ).resolves.toMatchObject({
      outcome: "COMMITTED",
      definition: { action: { status: "FAILED" }, retryCount: 0, resultMessageId: null },
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, "uncompensated-failure-audit")),
    ).resolves.toEqual([
      expect.objectContaining({
        event: "EXECUTION_FAILED",
        actorType: "SYSTEM",
        actorId: null,
        failureCode: "FINALIZATION_FAILED_UNCOMPENSATED",
        resultMessageId: "possible-stray-message",
      }),
    ]);
  });

  it("atomically finalizes all five successful scheduled-message effects", async () => {
    const input = creation("successful-finalization-action", {
      content: "final content",
      embed: { title: "final title", color: 0 },
    });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    const messageCreatedAt = new Date("2030-01-02T03:04:06.000Z");
    await expect(
      store.finalizeSuccess({
        definition: claim.definition,
        messageId: "successful-message-id",
        messageCreatedAt,
        managedMessageAuditId: "successful-managed-audit",
        executionAuditId: "successful-execution-audit",
        occurredAt: messageCreatedAt,
      }),
    ).resolves.toBe("COMMITTED");

    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "COMPLETED" },
      creatorUserId: actorId,
      retryCount: 0,
      resultMessageId: "successful-message-id",
      payload: input.payload,
    });
    await expect(
      database.client
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, "successful-message-id")),
    ).resolves.toEqual([
      expect.objectContaining({
        creatorUserId: actorId,
        revision: 1,
        status: "ACTIVE",
        createdAt: messageCreatedAt,
      }),
    ]);
    await expect(
      database.client
        .select()
        .from(managedMessageAudits)
        .where(eq(managedMessageAudits.id, "successful-managed-audit")),
    ).resolves.toEqual([
      expect.objectContaining({
        event: "CREATED",
        actorType: "USER",
        actorId,
        occurredAt: messageCreatedAt,
      }),
    ]);
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, "successful-execution-audit")),
    ).resolves.toEqual([
      expect.objectContaining({
        event: "EXECUTION_COMPLETED",
        actorType: "SYSTEM",
        actorId: null,
        resultMessageId: "successful-message-id",
      }),
    ]);
  });

  it("confirms all five exact finalization effects after database response loss", async () => {
    const input = creation("finalization-response-loss", { content: "confirmed", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    const responseLossStore = createScheduledMessageStore(
      finalizationResponseLossDatabase(new Error("response lost")),
    );
    await expect(
      responseLossStore.finalizeSuccess({
        definition: claim.definition,
        messageId: "response-loss-message-id",
        messageCreatedAt: occurredAt,
        managedMessageAuditId: "response-loss-managed-audit",
        executionAuditId: "response-loss-execution-audit",
        occurredAt,
      }),
    ).resolves.toBe("COMMITTED");
  });

  it("rejects response-loss confirmation when a matcher field is changed", async () => {
    const input = creation("finalization-mismatch", { content: "confirmed", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    const originalError = new Error("response lost with corrupted confirmation");
    const responseLossStore = createScheduledMessageStore(
      finalizationResponseLossDatabase(originalError, async () => {
        await database.client
          .update(managedMessages)
          .set({ creatorUserId: "wrong-creator" })
          .where(eq(managedMessages.messageId, "mismatched-response-message-id"));
      }),
    );

    let thrown: unknown;
    try {
      await responseLossStore.finalizeSuccess({
        definition: claim.definition,
        messageId: "mismatched-response-message-id",
        messageCreatedAt: occurredAt,
        managedMessageAuditId: "mismatched-response-managed-audit",
        executionAuditId: "mismatched-response-execution-audit",
        occurredAt,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(originalError);
  });

  it("rolls back successful finalization completely on a managed-message conflict", async () => {
    const input = creation("finalization-conflict-action", { content: "scheduled", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    await database.client.insert(managedMessages).values({
      messageId: "conflicting-message-id",
      guildId,
      channelId,
      creatorUserId: actorId,
      content: "different",
      createdAt: occurredAt,
    });

    await expect(
      store.finalizeSuccess({
        definition: claim.definition,
        messageId: "conflicting-message-id",
        messageCreatedAt: occurredAt,
        managedMessageAuditId: "conflicting-managed-audit",
        executionAuditId: "conflicting-execution-audit",
        occurredAt,
      }),
    ).rejects.toThrow();
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "EXECUTING" },
      resultMessageId: null,
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, "conflicting-execution-audit")),
    ).resolves.toHaveLength(0);
  });

  it("rolls back all successful finalization state when the execution audit insert fails", async () => {
    const input = creation("finalization-audit-conflict", { content: "scheduled", embed: null });
    await store.create(input);
    const claim = await store.claimExecution(input.scheduledActionId, 0);
    if (claim.outcome !== "COMMITTED") throw new Error("claim failed");
    await insertDirectAudit({
      id: "conflicting-execution-audit",
      scheduledActionId: "unrelated-action",
      content: "existing audit",
    });

    await expect(
      store.finalizeSuccess({
        definition: claim.definition,
        messageId: "audit-conflict-message",
        messageCreatedAt: occurredAt,
        managedMessageAuditId: "audit-conflict-managed-audit",
        executionAuditId: "conflicting-execution-audit",
        occurredAt,
      }),
    ).rejects.toThrow();
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "EXECUTING" },
      resultMessageId: null,
    });
    await expect(
      database.client
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, "audit-conflict-message")),
    ).resolves.toHaveLength(0);
    await expect(
      database.client
        .select()
        .from(managedMessageAudits)
        .where(eq(managedMessageAudits.id, "audit-conflict-managed-audit")),
    ).resolves.toHaveLength(0);
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

  it("constrains execution-audit result IDs to terminal failures with a known stray message", async () => {
    const base = {
      scheduledActionId: "audit-shape-action",
      guildId,
      channelId,
      actorType: "SYSTEM" as const,
      actorId: null,
      executeAt,
      content: "audit shape",
      occurredAt,
      outcome: "FAILURE" as const,
    };

    await expect(
      database.client.insert(scheduledMessageAudits).values({
        ...base,
        id: "invalid-retry-result-id",
        event: "EXECUTION_RETRY",
        failureCode: "CURRENT_STATE_CHECK_FAILED",
        resultMessageId: "not-allowed",
      }),
    ).rejects.toThrow();
    await expect(
      database.client.insert(scheduledMessageAudits).values({
        ...base,
        id: "invalid-overdue-result-id",
        event: "EXECUTION_FAILED",
        failureCode: "OVERDUE_GRACE_EXCEEDED",
        resultMessageId: "not-allowed",
      }),
    ).rejects.toThrow();
    await expect(
      database.client.insert(scheduledMessageAudits).values({
        ...base,
        id: "valid-uncompensated-result-id",
        event: "EXECUTION_FAILED",
        failureCode: "FINALIZATION_FAILED_UNCOMPENSATED",
        resultMessageId: "known-message-id",
      }),
    ).resolves.toBeDefined();
  });

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
      creatorUserId: missingAudit.actorId,
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

  it("reads status only in the exact SEND_MESSAGE guild and channel context", async () => {
    const input = creation("scoped-status", { content: "private payload", embed: null });
    await store.create(input);
    await expect(
      store.findStatus(input.scheduledActionId, guildId, channelId),
    ).resolves.toMatchObject({
      outcome: "FOUND",
      schedule: {
        scheduledActionId: input.scheduledActionId,
        status: "ACTIVE",
        guildId,
        channelId,
        creatorUserId: actorId,
        retryCount: 0,
        resultMessageId: null,
      },
    });
    await expect(
      store.findStatus(input.scheduledActionId, "wrong-guild", channelId),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });
    await expect(
      store.findStatus(input.scheduledActionId, guildId, "wrong-channel"),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });

    await insertAction("wrong-type-status", "CLOSE_THREAD", channelId);
    await expect(store.findStatus("wrong-type-status", guildId, channelId)).resolves.toEqual({
      outcome: "NOT_FOUND_OR_WRONG_CONTEXT",
    });
    await insertAction("missing-state-status", "SEND_MESSAGE", channelId);
    await expect(store.findStatus("missing-state-status", guildId, channelId)).resolves.toEqual({
      outcome: "CORRUPT",
    });
  });

  it("atomically cancels ACTIVE state with an exact user audit and is idempotent", async () => {
    const input = creation("cancel-active", {
      content: "cancel payload",
      embed: { title: "cancel title", color: 0 },
    });
    await store.create(input);
    const cancellation = {
      scheduledActionId: input.scheduledActionId,
      guildId,
      channelId,
      actorId: "cancelling-actor",
      auditId: "cancel-audit",
      occurredAt: new Date("2026-09-17T01:02:03.456Z"),
    };
    await expect(store.cancel(cancellation)).resolves.toMatchObject({ outcome: "CANCELLED" });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(eq(scheduledMessageAudits.id, cancellation.auditId)),
    ).resolves.toEqual([
      expect.objectContaining({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        event: "CANCELLED",
        actorType: "USER",
        actorId: "cancelling-actor",
        executeAt,
        content: "cancel payload",
        embedTitle: "cancel title",
        embedColor: 0,
        occurredAt: cancellation.occurredAt,
        outcome: "SUCCESS",
        failureCode: null,
        resultMessageId: null,
      }),
    ]);
    await expect(
      store.cancel({
        ...cancellation,
        auditId: "second-cancel-audit",
        occurredAt: new Date("2026-09-17T01:03:03.456Z"),
      }),
    ).resolves.toMatchObject({ outcome: "ALREADY_CANCELLED" });
  });

  it.each([
    ["guild", "wrong-guild", channelId],
    ["channel", guildId, "wrong-channel"],
  ] as const)(
    "does not reveal or mutate a scheduled message when the cancellation %s is wrong",
    async (scope, requestedGuildId, requestedChannelId) => {
      const input = creation(`cancel-wrong-${scope}`, {
        content: `private ${scope} payload`,
        embed: null,
      });
      const before = await store.create(input);

      await expect(
        store.cancel({
          scheduledActionId: input.scheduledActionId,
          guildId: requestedGuildId,
          channelId: requestedChannelId,
          actorId: "unauthorized-canceller",
          auditId: `cancel-wrong-${scope}-audit`,
          occurredAt,
        }),
      ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });

      await expect(store.find(input.scheduledActionId)).resolves.toEqual(before);
      await expect(
        database.client
          .select()
          .from(scheduledMessageAudits)
          .where(
            and(
              eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId),
              eq(scheduledMessageAudits.event, "CANCELLED"),
            ),
          ),
      ).resolves.toHaveLength(0);
    },
  );

  it("does not reveal or mutate a non-SEND_MESSAGE action during cancellation", async () => {
    const scheduledActionId = "cancel-wrong-action-type";
    await insertAction(scheduledActionId, "CLOSE_THREAD", channelId);
    const actions = createScheduledActionStore(database.client);
    const before = await actions.findById(scheduledActionId);

    await expect(
      store.cancel({
        scheduledActionId,
        guildId,
        channelId,
        actorId: "cancelling-actor",
        auditId: "cancel-wrong-action-type-audit",
        occurredAt,
      }),
    ).resolves.toEqual({ outcome: "NOT_FOUND_OR_WRONG_CONTEXT" });

    await expect(actions.findById(scheduledActionId)).resolves.toEqual(before);
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(
          and(
            eq(scheduledMessageAudits.scheduledActionId, scheduledActionId),
            eq(scheduledMessageAudits.event, "CANCELLED"),
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  it("rolls back cancellation when its audit insert fails", async () => {
    const input = creation("cancel-audit-rollback", { content: "rollback", embed: null });
    await store.create(input);
    await expect(
      store.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId,
        auditId: input.auditId,
        occurredAt,
      }),
    ).resolves.toEqual({ outcome: "PERSISTENCE_UNCONFIRMED" });
    await expect(
      store.findStatus(input.scheduledActionId, guildId, channelId),
    ).resolves.toMatchObject({ outcome: "FOUND", schedule: { status: "ACTIVE" } });
  });

  it("confirms an exact committed cancellation after transaction response loss", async () => {
    const input = creation("cancel-response-loss", { content: "response loss", embed: null });
    await store.create(input);
    const responseLossStore = createScheduledMessageStore(
      transactionResponseLossDatabase(new Error("transaction response lost")),
    );
    await expect(
      responseLossStore.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId,
        auditId: "cancel-response-loss-audit",
        occurredAt,
      }),
    ).resolves.toMatchObject({ outcome: "CANCELLED" });
  });

  it("rejects cancellation confirmation when an exact payload field does not match", async () => {
    const input = creation("cancel-response-mismatch", {
      content: "expected payload",
      embed: null,
    });
    await store.create(input);
    const auditId = "cancel-response-mismatch-audit";
    const responseLossStore = createScheduledMessageStore(
      finalizationResponseLossDatabase(new Error("transaction response lost"), async () => {
        await database.client
          .update(scheduledMessageAudits)
          .set({ content: "different payload" })
          .where(eq(scheduledMessageAudits.id, auditId));
      }),
    );
    await expect(
      responseLossStore.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId,
        auditId,
        occurredAt,
      }),
    ).resolves.toEqual({ outcome: "PERSISTENCE_UNCONFIRMED" });
  });

  it("linearizes concurrent cancellations as one cancellation and one idempotent result", async () => {
    const input = creation("concurrent-cancellations", { content: "concurrent", embed: null });
    await store.create(input);
    const results = await Promise.all([
      store.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId: "first-canceller",
        auditId: "first-cancel-audit",
        occurredAt,
      }),
      store.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId: "second-canceller",
        auditId: "second-cancel-audit",
        occurredAt: new Date(occurredAt.getTime() + 1),
      }),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "ALREADY_CANCELLED",
      "CANCELLED",
    ]);
  });

  it("deterministically keeps cancellation authoritative when cancellation wins before claim", async () => {
    const input = creation("cancel-before-claim", {
      content: "cancel wins payload",
      embed: { title: "cancel wins title", color: 0 },
    });
    await store.create(input);
    const cancellationAt = new Date("2026-09-17T02:03:04.567Z");
    const actions = createScheduledActionStore(database.client);

    await expect(
      store.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId: "cancel-winner",
        auditId: "cancel-before-claim-audit",
        occurredAt: cancellationAt,
      }),
    ).resolves.toMatchObject({
      outcome: "CANCELLED",
      definition: { action: { status: "CANCELLED" } },
    });
    await expect(actions.claimExecution(input.scheduledActionId)).resolves.toMatchObject({
      transitioned: false,
      current: { status: "CANCELLED" },
    });
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "CANCELLED" },
      retryCount: 0,
      payload: input.payload,
      resultMessageId: null,
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(
          and(
            eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId),
            eq(scheduledMessageAudits.event, "CANCELLED"),
          ),
        ),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "cancel-before-claim-audit",
        guildId,
        channelId,
        actorType: "USER",
        actorId: "cancel-winner",
        executeAt,
        content: "cancel wins payload",
        embedTitle: "cancel wins title",
        embedDescription: null,
        embedColor: 0,
        embedImageUrl: null,
        occurredAt: cancellationAt,
        outcome: "SUCCESS",
        failureCode: null,
        resultMessageId: null,
      }),
    ]);
  });

  it("deterministically refuses cancellation when execution claim wins first", async () => {
    const input = creation("claim-before-cancel", {
      content: "claim wins payload",
      embed: null,
    });
    await store.create(input);

    await expect(store.claimExecution(input.scheduledActionId, 0)).resolves.toMatchObject({
      outcome: "COMMITTED",
      definition: { action: { status: "EXECUTING" } },
    });
    await expect(
      store.cancel({
        scheduledActionId: input.scheduledActionId,
        guildId,
        channelId,
        actorId: "late-canceller",
        auditId: "claim-before-cancel-audit",
        occurredAt,
      }),
    ).resolves.toEqual({ outcome: "EXECUTING" });
    await expect(store.find(input.scheduledActionId)).resolves.toMatchObject({
      action: { status: "EXECUTING" },
      retryCount: 0,
      payload: input.payload,
      resultMessageId: null,
    });
    await expect(
      database.client
        .select()
        .from(scheduledMessageAudits)
        .where(
          and(
            eq(scheduledMessageAudits.scheduledActionId, input.scheduledActionId),
            eq(scheduledMessageAudits.event, "CANCELLED"),
          ),
        ),
    ).resolves.toHaveLength(0);
  });

  it("linearizes cancellation against execution claim", async () => {
    const actions = createScheduledActionStore(database.client);
    for (const suffix of ["one", "two", "three", "four"]) {
      const input = creation(`cancel-claim-race-${suffix}`, { content: suffix, embed: null });
      await store.create(input);
      const [cancellation, claim] = await Promise.all([
        store.cancel({
          scheduledActionId: input.scheduledActionId,
          guildId,
          channelId,
          actorId,
          auditId: `cancel-claim-audit-${suffix}`,
          occurredAt,
        }),
        actions.claimExecution(input.scheduledActionId),
      ]);
      if (cancellation.outcome === "CANCELLED") {
        expect(claim.transitioned).toBe(false);
        expect(claim.current?.status).toBe("CANCELLED");
      } else {
        expect(cancellation).toEqual({ outcome: "EXECUTING" });
        expect(claim).toMatchObject({ transitioned: true, current: { status: "EXECUTING" } });
      }
    }
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
        (scheduled_action_id, creator_user_id, content, embed_title, embed_description, embed_color, embed_image_url)
      values
        (${payload.id}, ${actorId}, ${payload.content}, ${payload.title}, ${payload.description}, ${payload.color}, ${payload.imageUrl})
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

function finalizationResponseLossDatabase(
  transactionError: Error,
  afterCommit?: () => Promise<void>,
): DatabaseClient {
  const transaction = database.client.transaction.bind(database.client);
  return new Proxy(database.client, {
    get(target, property): unknown {
      if (property === "transaction") {
        return async (callback: never) => {
          await transaction(callback);
          await afterCommit?.();
          throw transactionError;
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(managedMessageAudits)
    .where(eq(managedMessageAudits.guildId, guildId));
  await database.client.delete(managedMessages).where(eq(managedMessages.guildId, guildId));
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

async function createMigrationSubsetThrough0012(): Promise<string> {
  return createMigrationSubset(12);
}

async function createMigrationSubset(maximumIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-scheduled-message-migrations-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
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

async function expectPhase8BCreatorBackfillFailure(
  mode: "missing" | "duplicate" | "mismatched",
): Promise<void> {
  const testConfig = loadTestDatabaseConfig();
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const schemaName = `weft_sm_bad_${suffix}`;
  const migrationsSchema = `weft_smg_bad_${suffix}`;
  const actionId = `upgrade-bad-${suffix}`;
  const migrationDirectory = await createMigrationSubsetThrough0012();
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
      application_name: "weft-scheduled-message-invalid-upgrade-test",
      options: `-c search_path=${schemaName}`,
    });
    const isolatedDatabase = drizzle(isolatedPool);
    await migrate(isolatedDatabase, { migrationsFolder: migrationDirectory, migrationsSchema });
    await database.client.insert(scheduledActions).values({
      id: actionId,
      guildId: "shadow-guild",
      actionType: "SEND_MESSAGE",
      targetId: "shadow-channel",
      status: "ACTIVE",
      executeAt,
    });
    await isolatedDatabase.execute(sql`
      insert into scheduled_actions (id, guild_id, action_type, target_id, status, execute_at)
      values (${actionId}, 'upgrade-guild', 'SEND_MESSAGE', 'upgrade-channel', 'ACTIVE', ${executeAt})
    `);
    await isolatedDatabase.execute(sql`
      insert into scheduled_message_states (scheduled_action_id, content)
      values (${actionId}, 'expected content')
    `);
    if (mode !== "missing") {
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_audits
          (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
           execute_at, content, occurred_at, outcome)
        values
          ('bad-audit-one', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CREATED', 'USER',
           'creator-id', ${executeAt}, ${mode === "mismatched" ? "different content" : "expected content"},
           ${occurredAt}, 'SUCCESS')
      `);
    }
    if (mode === "duplicate") {
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_audits
          (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
           execute_at, content, occurred_at, outcome)
        values
          ('bad-audit-two', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CREATED', 'USER',
           'creator-id', ${executeAt}, 'expected content', ${occurredAt}, 'SUCCESS')
      `);
    }
    await expect(
      migrate(isolatedDatabase, { migrationsFolder: "drizzle", migrationsSchema }),
    ).rejects.toThrow("exactly one matching CREATED audit");
  } finally {
    await isolatedPool?.end();
    await database.client.execute(sql`drop schema if exists ${sql.identifier(schemaName)} cascade`);
    await database.client.execute(
      sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
    );
    await database.client.delete(scheduledActions).where(eq(scheduledActions.id, actionId));
    await rm(migrationDirectory, { recursive: true, force: true });
  }
}
