import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import {
  createManagedMessageStore,
  managedMessageAudits,
  managedMessages,
} from "../../src/managed-message-persistence.js";

const guildId = "700000000000000043";
const channelId = "800000000000000043";
const creatorUserId = "900000000000000043";
const createdAt = new Date("2026-08-31T07:08:09.123Z");
const database = createDatabase(loadTestDatabaseConfig());
const store = createManagedMessageStore(database.client);

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

type AuditInsertShape = {
  id: string;
  messageId?: string;
  event: string;
  actorType: string;
  actorId: string | null;
  beforeContent: string | null;
  afterContent: string;
  beforeRevision: number | null;
  afterRevision: number;
  beforeStatus: string | null;
  afterStatus: string;
  occurredAt?: Date;
};

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await database.close();
});

describe("managed message persistence", () => {
  it("upgrades an actual pre-0010 managed-message row without fabricating history", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_mm_${suffix}`;
    const migrationsSchema = `weft_mg_${suffix}`;
    const migrationDirectory = await createMigrationSubsetThrough0009();
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
        application_name: "weft-managed-message-upgrade-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolatedDatabase = drizzle(isolatedPool, {
        schema: { managedMessageAudits, managedMessages },
      });

      await migrate(isolatedDatabase, {
        migrationsFolder: migrationDirectory,
        migrationsSchema,
      });

      const historicalMessageId = "999999999999999890";
      const historicalContent = "Phase 7A historical content";
      const historicalCreatedAt = new Date("2026-08-30T01:02:03.456Z");
      const historicalUpdatedAt = new Date("2026-08-30T04:05:06.789Z");
      await isolatedDatabase.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, status, created_at, updated_at)
        values
          (${historicalMessageId}, ${guildId}, ${channelId}, ${creatorUserId}, ${historicalContent}, 1, 'ACTIVE', ${historicalCreatedAt}, ${historicalUpdatedAt})
      `);
      await expect(
        isolatedDatabase.execute(sql`select 1 from managed_message_audits`),
      ).rejects.toThrow();

      await migrate(isolatedDatabase, {
        migrationsFolder: "drizzle",
        migrationsSchema,
      });

      const [upgraded] = await isolatedDatabase
        .select()
        .from(managedMessages)
        .where(eq(managedMessages.messageId, historicalMessageId));
      expect(upgraded).toEqual({
        messageId: historicalMessageId,
        guildId,
        channelId,
        creatorUserId,
        content: historicalContent,
        revision: 1,
        status: "ACTIVE",
        createdAt: historicalCreatedAt,
        updatedAt: historicalUpdatedAt,
      });
      await expect(
        isolatedDatabase
          .select()
          .from(managedMessageAudits)
          .where(eq(managedMessageAudits.messageId, historicalMessageId)),
      ).resolves.toHaveLength(0);

      const isolatedStore = createManagedMessageStore(
        isolatedDatabase as Parameters<typeof createManagedMessageStore>[0],
      );
      await expect(
        isolatedStore.edit({
          auditId: "historical-edit-audit",
          messageId: historicalMessageId,
          guildId,
          channelId,
          actorUserId: creatorUserId,
          expectedRevision: 1,
          previousContent: historicalContent,
          content: "Phase 7B edited historical content",
          occurredAt: new Date("2026-08-31T11:00:00.000Z"),
        }),
      ).resolves.toBe("TRANSITIONED");
    } finally {
      await isolatedPool?.end();
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
      );
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await rm(migrationDirectory, { recursive: true, force: true });
    }
  });

  it("stores all fields with database-owned initial state and timestamps", async () => {
    const input = creation("999999999999999901", "Plain text https://example.invalid/path");
    const row = await store.create(input);

    expect(row).toMatchObject({
      messageId: input.messageId,
      guildId: input.guildId,
      channelId: input.channelId,
      creatorUserId: input.creatorUserId,
      content: input.content,
      createdAt: input.createdAt,
      revision: 1,
      status: "ACTIVE",
    });
    expect(row.updatedAt).toBeInstanceOf(Date);
    expect(row.createdAt.getTime()).toBe(createdAt.getTime());
    expect(row.messageId).toBe("999999999999999901");
    const [audit] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, input.auditId));
    expect(audit).toMatchObject({
      messageId: input.messageId,
      event: "CREATED",
      actorType: "USER",
      actorId: creatorUserId,
      beforeContent: null,
      afterContent: input.content,
      beforeRevision: null,
      afterRevision: 1,
      beforeStatus: null,
      afterStatus: "ACTIVE",
      outcome: "SUCCESS",
    });
  });

  it("accepts the exact 2000-code-point boundary including Unicode", async () => {
    const content = "😀".repeat(2_000);
    await expect(store.create(creation("999999999999999902", content))).resolves.toMatchObject({
      content,
    });
  });

  it("rejects direct over-limit, revision zero, and invalid state", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, created_at)
        values (${"999999999999999903"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"x".repeat(2_001)}, ${createdAt})
      `),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, created_at)
        values (${"999999999999999904"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, 0, ${createdAt})
      `),
    ).rejects.toThrow();
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, status, created_at)
        values (${"999999999999999905"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, ${"UNKNOWN"}, ${createdAt})
      `),
    ).rejects.toThrow();
  });

  it("accepts revision one explicitly", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, created_at)
        values (${"999999999999999906"}, ${guildId}, ${channelId}, ${creatorUserId}, ${"content"}, 1, ${createdAt})
      `),
    ).resolves.toBeDefined();
  });

  it("enforces primary-key uniqueness without overwriting", async () => {
    const input = creation("999999999999999907", "original");
    await store.create(input);
    await expect(store.create({ ...input, content: "replacement" })).rejects.toThrow();
    const [row] = await database.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, input.messageId));
    expect(row?.content).toBe("original");
  });

  it("confirms exact creation, missing rows, and every mutable exact-state mismatch", async () => {
    const input = creation("999999999999999908", "exact content");
    await store.create(input);
    await expect(store.confirmCreation(input)).resolves.toBe("MATCH");
    await expect(
      store.confirmCreation({ ...input, messageId: "999999999999999999" }),
    ).resolves.toBe("MISSING");

    for (const mismatch of [
      { guildId: "different-guild" },
      { channelId: "different-channel" },
      { creatorUserId: "different-user" },
      { content: "different content" },
      { createdAt: new Date(createdAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmCreation({ ...input, ...mismatch })).resolves.toBe("CONFLICT");
    }

    await database.client
      .update(managedMessages)
      .set({ revision: 2 })
      .where(eq(managedMessages.messageId, input.messageId));
    await expect(store.confirmCreation(input)).resolves.toBe("CONFLICT");
  });

  it("rejects row-only creation confirmation and keeps an unaudited active row editable", async () => {
    const input = creation("999999999999999909", "historical content");
    await database.client.insert(managedMessages).values({
      messageId: input.messageId,
      guildId,
      channelId,
      creatorUserId,
      content: input.content,
      createdAt,
    });
    await expect(store.confirmCreation(input)).resolves.toBe("CONFLICT");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      status: "ACTIVE",
      revision: 1,
      content: input.content,
    });

    await expect(
      store.edit({
        auditId: "edit-historical",
        messageId: input.messageId,
        guildId,
        channelId,
        actorUserId: creatorUserId,
        expectedRevision: 1,
        previousContent: input.content,
        content: "historical edited",
        occurredAt: new Date("2026-08-31T10:00:00.000Z"),
      }),
    ).resolves.toBe("TRANSITIONED");
  });

  it("commits one conditional edit and its exact audit atomically", async () => {
    const input = creation("999999999999999910", "before");
    await store.create(input);
    const transition = {
      auditId: "edit-999999999999999910",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: "900000000000000099",
      expectedRevision: 1,
      previousContent: "before",
      content: "after",
      occurredAt: new Date("2026-08-31T10:01:02.345Z"),
    };

    await expect(store.edit(transition)).resolves.toBe("TRANSITIONED");
    await expect(store.confirmEdit(transition)).resolves.toBe("MATCH");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      content: "after",
      revision: 2,
      status: "ACTIVE",
    });
    const [audit] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, transition.auditId));
    expect(audit).toMatchObject({
      event: "EDITED",
      actorType: "USER",
      actorId: transition.actorUserId,
      beforeContent: "before",
      afterContent: "after",
      beforeRevision: 1,
      afterRevision: 2,
      beforeStatus: "ACTIVE",
      afterStatus: "ACTIVE",
    });

    const stale = { ...transition, auditId: "stale-edit", content: "stale overwrite" };
    await expect(store.edit(stale)).resolves.toBe("NOT_TRANSITIONED");
    await expect(
      database.client
        .select()
        .from(managedMessageAudits)
        .where(eq(managedMessageAudits.id, stale.auditId)),
    ).resolves.toHaveLength(0);
  });

  it("requires both exact managed state and the exact stable audit to confirm an edit", async () => {
    const exactInput = creation("999999999999999920", "exact edit before");
    await store.create(exactInput);
    const exactTransition = {
      auditId: "exact-edit-confirmation",
      messageId: exactInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousContent: exactInput.content,
      content: "exact edit after",
      occurredAt: new Date("2026-08-31T10:01:30.000Z"),
    };
    await store.edit(exactTransition);
    await expect(store.confirmEdit(exactTransition)).resolves.toBe("MATCH");
    await expect(
      store.confirmEdit({ ...exactTransition, auditId: "wrong-edit-audit-id" }),
    ).resolves.not.toBe("MATCH");
    for (const mismatch of [
      { actorUserId: "different-editor" },
      { previousContent: "different before content" },
      { occurredAt: new Date(exactTransition.occurredAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmEdit({ ...exactTransition, ...mismatch })).resolves.not.toBe(
        "MATCH",
      );
    }

    const rowOnlyInput = creation("999999999999999921", "row-only before");
    await store.create(rowOnlyInput);
    const rowOnlyTransition = {
      auditId: "missing-edit-audit",
      messageId: rowOnlyInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousContent: rowOnlyInput.content,
      content: "row-only after",
      occurredAt: new Date("2026-08-31T10:01:31.000Z"),
    };
    await database.client
      .update(managedMessages)
      .set({ content: rowOnlyTransition.content, revision: 2 })
      .where(eq(managedMessages.messageId, rowOnlyInput.messageId));
    await expect(store.confirmEdit(rowOnlyTransition)).resolves.not.toBe("MATCH");

    const auditOnlyInput = creation("999999999999999922", "audit-only before");
    await store.create(auditOnlyInput);
    const auditOnlyTransition = {
      auditId: "audit-only-edit",
      messageId: auditOnlyInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousContent: auditOnlyInput.content,
      content: "audit-only after",
      occurredAt: new Date("2026-08-31T10:01:32.000Z"),
    };
    await insertAuditShape({
      id: auditOnlyTransition.auditId,
      messageId: auditOnlyTransition.messageId,
      event: "EDITED",
      actorType: "USER",
      actorId: auditOnlyTransition.actorUserId,
      beforeContent: auditOnlyTransition.previousContent,
      afterContent: auditOnlyTransition.content,
      beforeRevision: 1,
      afterRevision: 2,
      beforeStatus: "ACTIVE",
      afterStatus: "ACTIVE",
      occurredAt: auditOnlyTransition.occurredAt,
    });
    await expect(store.confirmEdit(auditOnlyTransition)).resolves.not.toBe("MATCH");
  });

  it("rolls back an edit update when its audit insert fails", async () => {
    const input = creation("999999999999999911", "before rollback");
    await store.create(input);
    await expect(
      store.edit({
        auditId: input.auditId,
        messageId: input.messageId,
        guildId,
        channelId,
        actorUserId: creatorUserId,
        expectedRevision: 1,
        previousContent: input.content,
        content: "must roll back",
        occurredAt: new Date("2026-08-31T10:02:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      content: input.content,
      revision: 1,
    });
  });

  it("rolls back managed-message creation when its CREATED audit insert fails", async () => {
    const collision = {
      ...creation("999999999999999916", "collision owner"),
      auditId: "creation-rollback-collision",
    };
    await store.create(collision);
    const [auditBefore] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, collision.auditId));
    const attempted = {
      ...creation("999999999999999917", "must not be created"),
      auditId: collision.auditId,
    };

    await expect(store.create(attempted)).rejects.toThrow();

    await expect(store.find(attempted.messageId)).resolves.toBeUndefined();
    await expect(
      database.client
        .select()
        .from(managedMessageAudits)
        .where(eq(managedMessageAudits.messageId, attempted.messageId)),
    ).resolves.toHaveLength(0);
    const [auditAfter] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, collision.auditId));
    expect(auditAfter).toEqual(auditBefore);
  });

  it("rolls back deletion state when its DELETION_DETECTED audit insert fails", async () => {
    const input = {
      ...creation("999999999999999918", "deletion rollback content"),
      auditId: "deletion-rollback-collision",
    };
    await store.create(input);
    const before = await store.find(input.messageId);

    await expect(
      store.markDeleted({
        auditId: input.auditId,
        messageId: input.messageId,
        guildId,
        channelId,
        expectedRevision: 1,
        content: input.content,
        occurredAt: new Date("2026-08-31T10:02:30.000Z"),
      }),
    ).rejects.toThrow();

    await expect(store.find(input.messageId)).resolves.toEqual(before);
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    expect(audits.filter((audit) => audit.event === "DELETION_DETECTED")).toHaveLength(0);
    expect(audits.filter((audit) => audit.event === "CREATED")).toHaveLength(1);
  });

  it("permits exactly one concurrent expected-revision transition", async () => {
    const input = creation("999999999999999912", "concurrent before");
    await store.create(input);
    const common = {
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousContent: input.content,
      occurredAt: new Date("2026-08-31T10:03:00.000Z"),
    };
    const results = await Promise.all([
      store.edit({ ...common, auditId: "concurrent-a", content: "winner a" }),
      store.edit({ ...common, auditId: "concurrent-b", content: "winner b" }),
    ]);
    expect(results.sort()).toEqual(["NOT_TRANSITIONED", "TRANSITIONED"]);
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    expect(audits.filter((audit) => audit.event === "EDITED")).toHaveLength(1);
  });

  it("marks confirmed deletion once while preserving content and revision", async () => {
    const input = creation("999999999999999913", "preserved content");
    await store.create(input);
    const deletion = {
      auditId: "delete-999999999999999913",
      messageId: input.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      content: input.content,
      occurredAt: new Date("2026-08-31T10:04:00.000Z"),
    };
    await expect(store.markDeleted(deletion)).resolves.toBe("TRANSITIONED");
    await expect(store.confirmDeletion(deletion)).resolves.toBe("MATCH");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      status: "DELETED",
      content: input.content,
      revision: 1,
    });
    await expect(store.markDeleted({ ...deletion, auditId: "duplicate-delete" })).resolves.toBe(
      "NOT_TRANSITIONED",
    );
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    expect(audits.filter((audit) => audit.event === "DELETION_DETECTED")).toHaveLength(1);
  });

  it("requires both exact DELETED state and the exact stable audit to confirm deletion", async () => {
    const exactInput = creation("999999999999999923", "exact deletion content");
    await store.create(exactInput);
    const exactDeletion = {
      auditId: "exact-deletion-confirmation",
      messageId: exactInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      content: exactInput.content,
      occurredAt: new Date("2026-08-31T10:04:30.000Z"),
    };
    await store.markDeleted(exactDeletion);
    await expect(store.confirmDeletion(exactDeletion)).resolves.toBe("MATCH");
    await expect(
      store.confirmDeletion({ ...exactDeletion, auditId: "wrong-deletion-audit-id" }),
    ).resolves.not.toBe("MATCH");
    for (const mismatch of [
      { expectedRevision: 2 },
      { content: "different preserved content" },
      { occurredAt: new Date(exactDeletion.occurredAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmDeletion({ ...exactDeletion, ...mismatch })).resolves.not.toBe(
        "MATCH",
      );
    }

    const rowOnlyInput = creation("999999999999999924", "row-only deletion content");
    await store.create(rowOnlyInput);
    const rowOnlyDeletion = {
      auditId: "missing-deletion-audit",
      messageId: rowOnlyInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      content: rowOnlyInput.content,
      occurredAt: new Date("2026-08-31T10:04:31.000Z"),
    };
    await database.client
      .update(managedMessages)
      .set({ status: "DELETED" })
      .where(eq(managedMessages.messageId, rowOnlyInput.messageId));
    await expect(store.confirmDeletion(rowOnlyDeletion)).resolves.not.toBe("MATCH");

    const auditOnlyInput = creation("999999999999999925", "audit-only deletion content");
    await store.create(auditOnlyInput);
    const auditOnlyDeletion = {
      auditId: "audit-only-deletion",
      messageId: auditOnlyInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      content: auditOnlyInput.content,
      occurredAt: new Date("2026-08-31T10:04:32.000Z"),
    };
    await insertAuditShape({
      id: auditOnlyDeletion.auditId,
      messageId: auditOnlyDeletion.messageId,
      event: "DELETION_DETECTED",
      actorType: "SYSTEM",
      actorId: null,
      beforeContent: auditOnlyDeletion.content,
      afterContent: auditOnlyDeletion.content,
      beforeRevision: 1,
      afterRevision: 1,
      beforeStatus: "ACTIVE",
      afterStatus: "DELETED",
      occurredAt: auditOnlyDeletion.occurredAt,
    });
    await expect(store.confirmDeletion(auditOnlyDeletion)).resolves.not.toBe("MATCH");
  });

  it("allows compensation only for the exact old row with no intended audit", async () => {
    const input = creation("999999999999999914", "compensation old");
    await store.create(input);
    const transition = {
      auditId: "uncommitted-edit",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousContent: input.content,
      content: "compensation new",
      occurredAt: new Date("2026-08-31T10:05:00.000Z"),
    };
    await expect(store.readCompensationSafety(transition)).resolves.toBe("SAFE");
    await store.edit(transition);
    await expect(store.readCompensationSafety(transition)).resolves.toBe("UNSAFE");
  });

  it("accepts each valid managed-message audit event shape", async () => {
    const validCases: AuditInsertShape[] = [
      {
        id: "valid-created-shape",
        event: "CREATED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: null,
        afterContent: "created content",
        beforeRevision: null,
        afterRevision: 1,
        beforeStatus: null,
        afterStatus: "ACTIVE",
      },
      {
        id: "valid-edited-shape",
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "edited before",
        afterContent: "edited after",
        beforeRevision: 4,
        afterRevision: 5,
        beforeStatus: "ACTIVE",
        afterStatus: "ACTIVE",
      },
      {
        id: "valid-deletion-shape",
        event: "DELETION_DETECTED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: "deleted content",
        afterContent: "deleted content",
        beforeRevision: 7,
        afterRevision: 7,
        beforeStatus: "ACTIVE",
        afterStatus: "DELETED",
      },
    ];

    for (const shape of validCases) {
      await expect(insertAuditShape(shape)).resolves.toBeDefined();
    }
  });

  it.each([
    [
      "unsupported event",
      {
        event: "UNKNOWN",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: null,
        afterContent: "content",
        beforeRevision: null,
        afterRevision: 1,
        beforeStatus: null,
        afterStatus: "ACTIVE",
      },
    ],
    [
      "CREATED with a system actor",
      {
        event: "CREATED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: null,
        afterContent: "content",
        beforeRevision: null,
        afterRevision: 1,
        beforeStatus: null,
        afterStatus: "ACTIVE",
      },
    ],
    [
      "DELETION_DETECTED with a user actor",
      {
        event: "DELETION_DETECTED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "same",
        afterContent: "same",
        beforeRevision: 2,
        afterRevision: 2,
        beforeStatus: "ACTIVE",
        afterStatus: "DELETED",
      },
    ],
    [
      "EDITED with an unchanged revision",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "before",
        afterContent: "after",
        beforeRevision: 2,
        afterRevision: 2,
        beforeStatus: "ACTIVE",
        afterStatus: "ACTIVE",
      },
    ],
    [
      "EDITED with a revision jump",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "before",
        afterContent: "after",
        beforeRevision: 2,
        afterRevision: 4,
        beforeStatus: "ACTIVE",
        afterStatus: "ACTIVE",
      },
    ],
    [
      "EDITED from DELETED to DELETED",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "before",
        afterContent: "after",
        beforeRevision: 2,
        afterRevision: 3,
        beforeStatus: "DELETED",
        afterStatus: "DELETED",
      },
    ],
    [
      "EDITED from ACTIVE to DELETED",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "before",
        afterContent: "after",
        beforeRevision: 2,
        afterRevision: 3,
        beforeStatus: "ACTIVE",
        afterStatus: "DELETED",
      },
    ],
    [
      "EDITED without a content change",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "same",
        afterContent: "same",
        beforeRevision: 2,
        afterRevision: 3,
        beforeStatus: "ACTIVE",
        afterStatus: "ACTIVE",
      },
    ],
    [
      "DELETION_DETECTED with a revision change",
      {
        event: "DELETION_DETECTED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: "same",
        afterContent: "same",
        beforeRevision: 2,
        afterRevision: 3,
        beforeStatus: "ACTIVE",
        afterStatus: "DELETED",
      },
    ],
    [
      "DELETION_DETECTED without ACTIVE to DELETED",
      {
        event: "DELETION_DETECTED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: "same",
        afterContent: "same",
        beforeRevision: 2,
        afterRevision: 2,
        beforeStatus: "DELETED",
        afterStatus: "DELETED",
      },
    ],
    [
      "DELETION_DETECTED with a content change",
      {
        event: "DELETION_DETECTED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: "before",
        afterContent: "after",
        beforeRevision: 2,
        afterRevision: 2,
        beforeStatus: "ACTIVE",
        afterStatus: "DELETED",
      },
    ],
  ] satisfies Array<[string, Omit<AuditInsertShape, "id">]>)(
    "rejects invalid audit shape: %s",
    async (label, shape) => {
      await expect(
        insertAuditShape({ id: `invalid-${label.replaceAll(" ", "-")}`, ...shape }),
      ).rejects.toThrow();
    },
  );
});

function creation(messageId: string, content: string) {
  return {
    auditId: `audit-${messageId}`,
    messageId,
    guildId,
    channelId,
    creatorUserId,
    content,
    createdAt,
  };
}

async function createMigrationSubsetThrough0009(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-managed-message-migrations-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= 9);
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

async function insertAuditShape(shape: AuditInsertShape) {
  return database.client.execute(sql`
    insert into managed_message_audits
      (id, message_id, guild_id, channel_id, event, actor_type, actor_id,
       before_content, after_content, before_revision, after_revision,
       before_status, after_status, occurred_at, outcome)
    values
      (${shape.id}, ${shape.messageId ?? "999999999999999919"}, ${guildId}, ${channelId}, ${shape.event},
       ${shape.actorType}, ${shape.actorId}, ${shape.beforeContent}, ${shape.afterContent},
       ${shape.beforeRevision}, ${shape.afterRevision}, ${shape.beforeStatus},
       ${shape.afterStatus}, ${shape.occurredAt ?? createdAt}, 'SUCCESS')
  `);
}

async function cleanup(): Promise<void> {
  await database.client
    .delete(managedMessageAudits)
    .where(eq(managedMessageAudits.guildId, guildId));
  await database.client.delete(managedMessages).where(eq(managedMessages.guildId, guildId));
}
