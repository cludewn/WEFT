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
  type CreateManagedMessage,
  type DeleteManagedMessage,
  type EditManagedMessage,
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
  beforeEmbedTitle?: string | null;
  afterEmbedTitle?: string | null;
  beforeEmbedDescription?: string | null;
  afterEmbedDescription?: string | null;
  beforeEmbedColor?: number | null;
  afterEmbedColor?: number | null;
  beforeEmbedImageUrl?: string | null;
  afterEmbedImageUrl?: string | null;
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
  it("upgrades representative actual 0010 rows and audits through migration 0011", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_mm_${suffix}`;
    const migrationsSchema = `weft_mg_${suffix}`;
    const migrationDirectory = await createMigrationSubsetThrough0010();
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

      const activeMessageId = "999999999999999890";
      const editedMessageId = "999999999999999891";
      const deletedMessageId = "999999999999999892";
      const historicalCreatedAt = new Date("2026-08-30T01:02:03.456Z");
      const historicalUpdatedAt = new Date("2026-08-30T04:05:06.789Z");
      await isolatedDatabase.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, revision, status, created_at, updated_at)
        values
          (${activeMessageId}, ${guildId}, ${channelId}, ${creatorUserId}, 'active content', 1, 'ACTIVE', ${historicalCreatedAt}, ${historicalUpdatedAt}),
          (${editedMessageId}, ${guildId}, ${channelId}, ${creatorUserId}, 'edited after', 2, 'ACTIVE', ${historicalCreatedAt}, ${historicalUpdatedAt}),
          (${deletedMessageId}, ${guildId}, ${channelId}, ${creatorUserId}, 'deleted content', 1, 'DELETED', ${historicalCreatedAt}, ${historicalUpdatedAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into managed_message_audits
          (id, message_id, guild_id, channel_id, event, actor_type, actor_id,
           before_content, after_content, before_revision, after_revision,
           before_status, after_status, occurred_at, outcome)
        values
          ('upgrade-created-active', ${activeMessageId}, ${guildId}, ${channelId}, 'CREATED', 'USER', ${creatorUserId},
           null, 'active content', null, 1, null, 'ACTIVE', ${historicalCreatedAt}, 'SUCCESS'),
          ('upgrade-created-edited', ${editedMessageId}, ${guildId}, ${channelId}, 'CREATED', 'USER', ${creatorUserId},
           null, 'edited before', null, 1, null, 'ACTIVE', ${historicalCreatedAt}, 'SUCCESS'),
          ('upgrade-edited', ${editedMessageId}, ${guildId}, ${channelId}, 'EDITED', 'USER', ${creatorUserId},
           'edited before', 'edited after', 1, 2, 'ACTIVE', 'ACTIVE', ${historicalUpdatedAt}, 'SUCCESS'),
          ('upgrade-created-deleted', ${deletedMessageId}, ${guildId}, ${channelId}, 'CREATED', 'USER', ${creatorUserId},
           null, 'deleted content', null, 1, null, 'ACTIVE', ${historicalCreatedAt}, 'SUCCESS'),
          ('upgrade-deleted', ${deletedMessageId}, ${guildId}, ${channelId}, 'DELETION_DETECTED', 'SYSTEM', null,
           'deleted content', 'deleted content', 1, 1, 'ACTIVE', 'DELETED', ${historicalUpdatedAt}, 'SUCCESS')
      `);

      await migrate(isolatedDatabase, {
        migrationsFolder: "drizzle",
        migrationsSchema,
      });

      const upgraded = await isolatedDatabase
        .select()
        .from(managedMessages)
        .orderBy(managedMessages.messageId);
      expect(upgraded).toHaveLength(3);
      expect(
        upgraded.map((row) => ({
          messageId: row.messageId,
          content: row.content,
          revision: row.revision,
          status: row.status,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          embed: [row.embedTitle, row.embedDescription, row.embedColor, row.embedImageUrl],
        })),
      ).toEqual([
        {
          messageId: activeMessageId,
          content: "active content",
          revision: 1,
          status: "ACTIVE",
          createdAt: historicalCreatedAt,
          updatedAt: historicalUpdatedAt,
          embed: [null, null, null, null],
        },
        {
          messageId: editedMessageId,
          content: "edited after",
          revision: 2,
          status: "ACTIVE",
          createdAt: historicalCreatedAt,
          updatedAt: historicalUpdatedAt,
          embed: [null, null, null, null],
        },
        {
          messageId: deletedMessageId,
          content: "deleted content",
          revision: 1,
          status: "DELETED",
          createdAt: historicalCreatedAt,
          updatedAt: historicalUpdatedAt,
          embed: [null, null, null, null],
        },
      ]);
      const upgradedAudits = await isolatedDatabase.select().from(managedMessageAudits);
      expect(upgradedAudits).toHaveLength(5);
      expect(
        upgradedAudits.every((audit) =>
          [
            audit.beforeEmbedTitle,
            audit.afterEmbedTitle,
            audit.beforeEmbedDescription,
            audit.afterEmbedDescription,
            audit.beforeEmbedColor,
            audit.afterEmbedColor,
            audit.beforeEmbedImageUrl,
            audit.afterEmbedImageUrl,
          ].every((value) => value === null),
        ),
      ).toBe(true);

      const isolatedStore = createManagedMessageStore(
        isolatedDatabase as Parameters<typeof createManagedMessageStore>[0],
      );
      await expect(
        isolatedStore.edit({
          auditId: "upgrade-embed-edit",
          messageId: activeMessageId,
          guildId,
          channelId,
          actorUserId: creatorUserId,
          expectedRevision: 1,
          previousPayload: { content: "active content", embed: null },
          payload: { content: "", embed: { title: "Phase 7C embed", color: 0 } },
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
      payload: input.payload,
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
      afterContent: input.payload.content,
      beforeRevision: null,
      afterRevision: 1,
      beforeStatus: null,
      afterStatus: "ACTIVE",
      outcome: "SUCCESS",
    });
  });

  it("stores embed-only and combined canonical payloads with complete CREATED audits", async () => {
    const embedOnly = creationPayload("999999999999999870", {
      content: "",
      embed: {
        title: "Embed title",
        description: "Embed description",
        color: 0,
        imageUrl: "https://example.invalid/image.png",
      },
    });
    const combined = creationPayload("999999999999999871", {
      content: "combined content",
      embed: { imageUrl: "https://example.invalid/combined.png" },
    });
    await expect(store.create(embedOnly)).resolves.toMatchObject({ payload: embedOnly.payload });
    await expect(store.create(combined)).resolves.toMatchObject({ payload: combined.payload });

    const [row] = await database.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, embedOnly.messageId));
    expect(row).toMatchObject({
      content: "",
      embedTitle: "Embed title",
      embedDescription: "Embed description",
      embedColor: 0,
      embedImageUrl: "https://example.invalid/image.png",
    });
    const [audit] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, embedOnly.auditId));
    expect(audit).toMatchObject({
      beforeContent: null,
      beforeEmbedTitle: null,
      afterContent: "",
      afterEmbedTitle: "Embed title",
      afterEmbedDescription: "Embed description",
      afterEmbedColor: 0,
      afterEmbedImageUrl: "https://example.invalid/image.png",
    });
  });

  it("edits only embed state as one revision and includes full before/after audit payloads", async () => {
    const input = creationPayload("999999999999999872", {
      content: "same content",
      embed: { title: "Before", color: 0x112233 },
    });
    await store.create(input);
    const transition = {
      auditId: "embed-only-edit-audit",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: input.payload,
      payload: { content: "same content", embed: { title: "After" } },
      occurredAt: new Date("2026-08-31T10:00:30.000Z"),
    };
    await expect(store.edit(transition)).resolves.toBe("TRANSITIONED");
    await expect(store.confirmEdit(transition)).resolves.toBe("MATCH");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      revision: 2,
      payload: transition.payload,
    });
    const [audit] = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.id, transition.auditId));
    expect(audit).toMatchObject({
      beforeContent: "same content",
      afterContent: "same content",
      beforeEmbedTitle: "Before",
      afterEmbedTitle: "After",
      beforeEmbedColor: 0x112233,
      afterEmbedColor: null,
    });
  });

  it("rejects empty, color-only, and out-of-bound direct persisted payloads", async () => {
    const directInsert = (
      messageId: string,
      content: string,
      title: string | null,
      color: number | null,
    ) =>
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, embed_title, embed_color, created_at)
        values (${messageId}, ${guildId}, ${channelId}, ${creatorUserId}, ${content}, ${title}, ${color}, ${createdAt})
      `);
    await expect(directInsert("999999999999999873", "", null, null)).rejects.toThrow();
    await expect(directInsert("999999999999999874", "text", null, 0)).rejects.toThrow();
    await expect(directInsert("999999999999999875", "", "x".repeat(257), null)).rejects.toThrow();
    await expect(directInsert("999999999999999876", "", "visible", 0)).resolves.toBeDefined();
  });

  it("keeps PostgreSQL character bounds as defense-in-depth rather than UTF-16 emulation", async () => {
    await expect(
      database.client.execute(sql`
        insert into managed_messages
          (message_id, guild_id, channel_id, creator_user_id, content, embed_title, created_at)
        values (${"999999999999999878"}, ${guildId}, ${channelId}, ${creatorUserId}, '', ${"😀".repeat(256)}, ${createdAt})
      `),
    ).resolves.toBeDefined();
  });

  it("includes every embed field in exact confirmation and compensation safety", async () => {
    const input = creationPayload("999999999999999877", {
      content: "content",
      embed: { title: "Exact", color: 0, imageUrl: "https://example.invalid/exact.png" },
    });
    await store.create(input);
    await expect(store.confirmCreation(input)).resolves.toBe("MATCH");
    await expect(
      store.confirmCreation({
        ...input,
        payload: { ...input.payload, embed: { ...input.payload.embed, color: 1 } },
      }),
    ).resolves.toBe("CONFLICT");

    const transition = {
      auditId: "embed-compensation-safety",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: input.payload,
      payload: { content: "content", embed: { title: "New" } },
      occurredAt: new Date("2026-08-31T10:00:31.000Z"),
    };
    await expect(store.readCompensationSafety(transition)).resolves.toBe("SAFE");
    await expect(
      store.readCompensationSafety({
        ...transition,
        previousPayload: { ...input.payload, embed: { ...input.payload.embed, color: 1 } },
      }),
    ).resolves.toBe("UNSAFE");
  });

  it("accepts the exact 2000-code-point boundary including Unicode", async () => {
    const content = "😀".repeat(2_000);
    await expect(store.create(creation("999999999999999902", content))).resolves.toMatchObject({
      payload: { content, embed: null },
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
    await expect(
      store.create({ ...input, payload: { content: "replacement", embed: null } }),
    ).rejects.toThrow();
    const [row] = await database.client
      .select()
      .from(managedMessages)
      .where(eq(managedMessages.messageId, input.messageId));
    expect(row?.content).toBe("original");
  });

  it("confirms exact creation, missing rows, and every mutable exact-state mismatch", async () => {
    const input = creationPayload("999999999999999908", {
      content: "exact content",
      embed: {
        title: "Exact creation title",
        description: "Exact creation description",
        color: 0x123456,
        imageUrl: "https://example.invalid/exact-creation.png",
      },
    });
    await store.create(input);
    await expect(store.confirmCreation(input)).resolves.toBe("MATCH");
    await expect(
      store.confirmCreation({ ...input, messageId: "999999999999999999" }),
    ).resolves.toBe("MISSING");

    for (const mismatch of [
      { auditId: "different-creation-audit" },
      { guildId: "different-guild" },
      { channelId: "different-channel" },
      { creatorUserId: "different-user" },
      { payload: { ...input.payload, content: "different content" } },
      {
        payload: {
          ...input.payload,
          embed: { ...input.payload.embed, title: "Different creation title" },
        },
      },
      {
        payload: {
          ...input.payload,
          embed: { ...input.payload.embed, description: "Different creation description" },
        },
      },
      {
        payload: { ...input.payload, embed: { ...input.payload.embed, color: 0x654321 } },
      },
      {
        payload: {
          ...input.payload,
          embed: {
            ...input.payload.embed,
            imageUrl: "https://example.invalid/different-creation.png",
          },
        },
      },
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
      content: input.payload.content,
      createdAt,
    });
    await expect(store.confirmCreation(input)).resolves.toBe("CONFLICT");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      status: "ACTIVE",
      revision: 1,
      payload: input.payload,
    });

    await expect(
      store.edit({
        auditId: "edit-historical",
        messageId: input.messageId,
        guildId,
        channelId,
        actorUserId: creatorUserId,
        expectedRevision: 1,
        previousPayload: input.payload,
        payload: { content: "historical edited", embed: null },
        occurredAt: new Date("2026-08-31T10:00:00.000Z"),
      }),
    ).resolves.toBe("TRANSITIONED");
  });

  it("commits one conditional edit and its exact audit atomically", async () => {
    const input = creation("999999999999999910", "before");
    await store.create(input);
    const transition: EditManagedMessage = {
      auditId: "edit-999999999999999910",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: "900000000000000099",
      expectedRevision: 1,
      previousPayload: input.payload,
      payload: { content: "after", embed: null },
      occurredAt: new Date("2026-08-31T10:01:02.345Z"),
    };

    await expect(store.edit(transition)).resolves.toBe("TRANSITIONED");
    await expect(store.confirmEdit(transition)).resolves.toBe("MATCH");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      payload: { content: "after", embed: null },
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

    const stale = {
      ...transition,
      auditId: "stale-edit",
      payload: { content: "stale overwrite", embed: null },
    };
    await expect(store.edit(stale)).resolves.toBe("NOT_TRANSITIONED");
    await expect(
      database.client
        .select()
        .from(managedMessageAudits)
        .where(eq(managedMessageAudits.id, stale.auditId)),
    ).resolves.toHaveLength(0);
  });

  it("requires both exact managed state and the exact stable audit to confirm an edit", async () => {
    const exactInput = creationPayload("999999999999999920", {
      content: "exact edit before",
      embed: {
        title: "Previous title",
        description: "Previous description",
        color: 0x102030,
        imageUrl: "https://example.invalid/previous.png",
      },
    });
    await store.create(exactInput);
    const exactTransition: EditManagedMessage = {
      auditId: "exact-edit-confirmation",
      messageId: exactInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: exactInput.payload,
      payload: {
        content: "exact edit after",
        embed: {
          title: "After title",
          description: "After description",
          color: 0x405060,
          imageUrl: "https://example.invalid/after.png",
        },
      },
      occurredAt: new Date("2026-08-31T10:01:30.000Z"),
    };
    await store.edit(exactTransition);
    await expect(store.confirmEdit(exactTransition)).resolves.toBe("MATCH");
    await expect(
      store.confirmEdit({ ...exactTransition, auditId: "wrong-edit-audit-id" }),
    ).resolves.not.toBe("MATCH");
    for (const mismatch of [
      { actorUserId: "different-editor" },
      { expectedRevision: 2 },
      {
        previousPayload: {
          ...exactTransition.previousPayload,
          content: "different before content",
        },
      },
      { payload: { ...exactTransition.payload, content: "different after content" } },
      {
        previousPayload: {
          ...exactTransition.previousPayload,
          embed: { ...exactTransition.previousPayload.embed, title: "Different previous title" },
        },
      },
      {
        previousPayload: {
          ...exactTransition.previousPayload,
          embed: {
            ...exactTransition.previousPayload.embed,
            description: "Different previous description",
          },
        },
      },
      {
        previousPayload: {
          ...exactTransition.previousPayload,
          embed: { ...exactTransition.previousPayload.embed, color: 0x010203 },
        },
      },
      {
        previousPayload: {
          ...exactTransition.previousPayload,
          embed: {
            ...exactTransition.previousPayload.embed,
            imageUrl: "https://example.invalid/different-previous.png",
          },
        },
      },
      {
        payload: {
          ...exactTransition.payload,
          embed: { ...exactTransition.payload.embed, title: "Different after title" },
        },
      },
      {
        payload: {
          ...exactTransition.payload,
          embed: {
            ...exactTransition.payload.embed,
            description: "Different after description",
          },
        },
      },
      {
        payload: {
          ...exactTransition.payload,
          embed: { ...exactTransition.payload.embed, color: 0x070809 },
        },
      },
      {
        payload: {
          ...exactTransition.payload,
          embed: {
            ...exactTransition.payload.embed,
            imageUrl: "https://example.invalid/different-after.png",
          },
        },
      },
      { occurredAt: new Date(exactTransition.occurredAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmEdit({ ...exactTransition, ...mismatch })).resolves.not.toBe(
        "MATCH",
      );
    }

    const rowOnlyInput = creation("999999999999999921", "row-only before");
    await store.create(rowOnlyInput);
    const rowOnlyTransition: EditManagedMessage = {
      auditId: "missing-edit-audit",
      messageId: rowOnlyInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: rowOnlyInput.payload,
      payload: { content: "row-only after", embed: null },
      occurredAt: new Date("2026-08-31T10:01:31.000Z"),
    };
    await database.client
      .update(managedMessages)
      .set({ content: rowOnlyTransition.payload.content, revision: 2 })
      .where(eq(managedMessages.messageId, rowOnlyInput.messageId));
    await expect(store.confirmEdit(rowOnlyTransition)).resolves.not.toBe("MATCH");

    const auditOnlyInput = creation("999999999999999922", "audit-only before");
    await store.create(auditOnlyInput);
    const auditOnlyTransition: EditManagedMessage = {
      auditId: "audit-only-edit",
      messageId: auditOnlyInput.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: auditOnlyInput.payload,
      payload: { content: "audit-only after", embed: null },
      occurredAt: new Date("2026-08-31T10:01:32.000Z"),
    };
    await insertAuditShape({
      id: auditOnlyTransition.auditId,
      messageId: auditOnlyTransition.messageId,
      event: "EDITED",
      actorType: "USER",
      actorId: auditOnlyTransition.actorUserId,
      beforeContent: auditOnlyTransition.previousPayload.content,
      afterContent: auditOnlyTransition.payload.content,
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
        previousPayload: input.payload,
        payload: { content: "must roll back", embed: null },
        occurredAt: new Date("2026-08-31T10:02:00.000Z"),
      }),
    ).rejects.toThrow();
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      payload: input.payload,
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
        payload: input.payload,
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
      previousPayload: input.payload,
      occurredAt: new Date("2026-08-31T10:03:00.000Z"),
    };
    const results = await Promise.all([
      store.edit({
        ...common,
        auditId: "concurrent-a",
        payload: { content: "winner a", embed: null },
      }),
      store.edit({
        ...common,
        auditId: "concurrent-b",
        payload: { content: "winner b", embed: null },
      }),
    ]);
    expect(results.sort()).toEqual(["NOT_TRANSITIONED", "TRANSITIONED"]);
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    expect(audits.filter((audit) => audit.event === "EDITED")).toHaveLength(1);
  });

  it("permits only one same-revision transition with competing embed title and color", async () => {
    const input = creationPayload("999999999999999926", {
      content: "same content",
      embed: { title: "Initial", color: 0x010101 },
    });
    await store.create(input);
    const common = {
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: input.payload,
      occurredAt: new Date("2026-08-31T10:03:01.000Z"),
    };
    const competingPayloads = [
      { content: "same content", embed: { title: "Winner A", color: 0xaaaaaa } },
      { content: "same content", embed: { title: "Winner B", color: 0xbbbbbb } },
    ];

    const results = await Promise.all([
      store.edit({ ...common, auditId: "embed-concurrent-a", payload: competingPayloads[0]! }),
      store.edit({ ...common, auditId: "embed-concurrent-b", payload: competingPayloads[1]! }),
    ]);

    expect(results.sort()).toEqual(["NOT_TRANSITIONED", "TRANSITIONED"]);
    const final = await store.find(input.messageId);
    expect(competingPayloads).toContainEqual(final?.payload);
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    expect(audits.filter((audit) => audit.event === "EDITED")).toHaveLength(1);
  });

  it("marks confirmed deletion once while preserving the complete payload and revision", async () => {
    const input = creationPayload("999999999999999913", {
      content: "preserved content",
      embed: { title: "Preserved embed", color: 0 },
    });
    await store.create(input);
    const deletion = {
      auditId: "delete-999999999999999913",
      messageId: input.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      payload: input.payload,
      occurredAt: new Date("2026-08-31T10:04:00.000Z"),
    };
    await expect(store.markDeleted(deletion)).resolves.toBe("TRANSITIONED");
    await expect(store.confirmDeletion(deletion)).resolves.toBe("MATCH");
    await expect(
      store.confirmDeletion({
        ...deletion,
        payload: {
          content: "preserved content",
          embed: { title: "Preserved embed", color: 1 },
        },
      }),
    ).resolves.toBe("CONFLICT");
    await expect(store.find(input.messageId)).resolves.toMatchObject({
      status: "DELETED",
      payload: input.payload,
      revision: 1,
    });
    await expect(store.markDeleted({ ...deletion, auditId: "duplicate-delete" })).resolves.toBe(
      "NOT_TRANSITIONED",
    );
    const audits = await database.client
      .select()
      .from(managedMessageAudits)
      .where(eq(managedMessageAudits.messageId, input.messageId));
    const deletionAudits = audits.filter((audit) => audit.event === "DELETION_DETECTED");
    expect(deletionAudits).toHaveLength(1);
    expect(deletionAudits[0]).toMatchObject({
      beforeEmbedTitle: "Preserved embed",
      afterEmbedTitle: "Preserved embed",
      beforeEmbedColor: 0,
      afterEmbedColor: 0,
    });
  });

  it("requires both exact DELETED state and the exact stable audit to confirm deletion", async () => {
    const exactInput = creationPayload("999999999999999923", {
      content: "exact deletion content",
      embed: {
        title: "Deleted title",
        description: "Deleted description",
        color: 0x123456,
        imageUrl: "https://example.invalid/deleted.png",
      },
    });
    await store.create(exactInput);
    const exactDeletion: DeleteManagedMessage = {
      auditId: "exact-deletion-confirmation",
      messageId: exactInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      payload: exactInput.payload,
      occurredAt: new Date("2026-08-31T10:04:30.000Z"),
    };
    await store.markDeleted(exactDeletion);
    await expect(store.confirmDeletion(exactDeletion)).resolves.toBe("MATCH");
    await expect(
      store.confirmDeletion({ ...exactDeletion, auditId: "wrong-deletion-audit-id" }),
    ).resolves.not.toBe("MATCH");
    for (const mismatch of [
      { expectedRevision: 2 },
      { payload: { ...exactDeletion.payload, content: "different preserved content" } },
      {
        payload: {
          ...exactDeletion.payload,
          embed: { ...exactDeletion.payload.embed, title: "Different deleted title" },
        },
      },
      {
        payload: {
          ...exactDeletion.payload,
          embed: {
            ...exactDeletion.payload.embed,
            description: "Different deleted description",
          },
        },
      },
      {
        payload: {
          ...exactDeletion.payload,
          embed: { ...exactDeletion.payload.embed, color: 0x654321 },
        },
      },
      {
        payload: {
          ...exactDeletion.payload,
          embed: {
            ...exactDeletion.payload.embed,
            imageUrl: "https://example.invalid/different-deleted.png",
          },
        },
      },
      { occurredAt: new Date(exactDeletion.occurredAt.getTime() + 1_000) },
    ]) {
      await expect(store.confirmDeletion({ ...exactDeletion, ...mismatch })).resolves.not.toBe(
        "MATCH",
      );
    }

    const rowOnlyInput = creation("999999999999999924", "row-only deletion content");
    await store.create(rowOnlyInput);
    const rowOnlyDeletion: DeleteManagedMessage = {
      auditId: "missing-deletion-audit",
      messageId: rowOnlyInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      payload: rowOnlyInput.payload,
      occurredAt: new Date("2026-08-31T10:04:31.000Z"),
    };
    await database.client
      .update(managedMessages)
      .set({ status: "DELETED" })
      .where(eq(managedMessages.messageId, rowOnlyInput.messageId));
    await expect(store.confirmDeletion(rowOnlyDeletion)).resolves.not.toBe("MATCH");

    const auditOnlyInput = creation("999999999999999925", "audit-only deletion content");
    await store.create(auditOnlyInput);
    const auditOnlyDeletion: DeleteManagedMessage = {
      auditId: "audit-only-deletion",
      messageId: auditOnlyInput.messageId,
      guildId,
      channelId,
      expectedRevision: 1,
      payload: auditOnlyInput.payload,
      occurredAt: new Date("2026-08-31T10:04:32.000Z"),
    };
    await insertAuditShape({
      id: auditOnlyDeletion.auditId,
      messageId: auditOnlyDeletion.messageId,
      event: "DELETION_DETECTED",
      actorType: "SYSTEM",
      actorId: null,
      beforeContent: auditOnlyDeletion.payload.content,
      afterContent: auditOnlyDeletion.payload.content,
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
    const transition: EditManagedMessage = {
      auditId: "uncommitted-edit",
      messageId: input.messageId,
      guildId,
      channelId,
      actorUserId: creatorUserId,
      expectedRevision: 1,
      previousPayload: input.payload,
      payload: { content: "compensation new", embed: null },
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
        id: "valid-nullable-embed-difference",
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "same content",
        afterContent: "same content",
        beforeEmbedTitle: null,
        afterEmbedTitle: "Added embed",
        beforeRevision: 5,
        afterRevision: 6,
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
      "EDITED with equal nullable embed state",
      {
        event: "EDITED",
        actorType: "USER",
        actorId: creatorUserId,
        beforeContent: "same",
        afterContent: "same",
        beforeEmbedTitle: "same embed",
        afterEmbedTitle: "same embed",
        beforeEmbedColor: null,
        afterEmbedColor: null,
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
    [
      "DELETION_DETECTED with a nullable embed difference",
      {
        event: "DELETION_DETECTED",
        actorType: "SYSTEM",
        actorId: null,
        beforeContent: "same",
        afterContent: "same",
        beforeEmbedTitle: null,
        afterEmbedTitle: "unexpected embed",
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

function creation(messageId: string, content: string): CreateManagedMessage {
  return {
    auditId: `audit-${messageId}`,
    messageId,
    guildId,
    channelId,
    creatorUserId,
    payload: { content, embed: null },
    createdAt,
  };
}

function creationPayload(
  messageId: string,
  payload: CreateManagedMessage["payload"],
): CreateManagedMessage {
  return {
    auditId: `audit-${messageId}`,
    messageId,
    guildId,
    channelId,
    creatorUserId,
    payload,
    createdAt,
  };
}

async function createMigrationSubsetThrough0010(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-managed-message-migrations-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= 10);
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
       before_content, after_content,
       before_embed_title, after_embed_title,
       before_embed_description, after_embed_description,
       before_embed_color, after_embed_color,
       before_embed_image_url, after_embed_image_url,
       before_revision, after_revision,
       before_status, after_status, occurred_at, outcome)
    values
      (${shape.id}, ${shape.messageId ?? "999999999999999919"}, ${guildId}, ${channelId}, ${shape.event},
       ${shape.actorType}, ${shape.actorId}, ${shape.beforeContent}, ${shape.afterContent},
       ${shape.beforeEmbedTitle ?? null}, ${shape.afterEmbedTitle ?? null},
       ${shape.beforeEmbedDescription ?? null}, ${shape.afterEmbedDescription ?? null},
       ${shape.beforeEmbedColor ?? null}, ${shape.afterEmbedColor ?? null},
       ${shape.beforeEmbedImageUrl ?? null}, ${shape.afterEmbedImageUrl ?? null},
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
