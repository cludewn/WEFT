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
import { scheduledActions } from "../../src/scheduled-action-persistence.js";

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

const database = createDatabase(loadTestDatabaseConfig());

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});

afterAll(async () => {
  await database.close();
});

describe("scheduled message migration 0015", () => {
  it("applies actual 0000 through 0014 then generated 0015 without changing history", async () => {
    const testConfig = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_sm_15_${suffix}`;
    const migrationsSchema = `weft_smg_15_${suffix}`;
    const actionId = `upgrade-0015-${suffix}`;
    const migrationDirectory = await createMigrationSubset(14);
    const upgradeMigrationDirectory = await createMigrationSubset(15);
    const executeAt = new Date("2031-02-03T04:05:06.789Z");
    const occurredAt = new Date("2026-09-18T01:02:03.456Z");
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
        application_name: "weft-scheduled-message-0015-upgrade-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolatedDatabase = drizzle(isolatedPool);
      await migrate(isolatedDatabase, { migrationsFolder: migrationDirectory, migrationsSchema });

      // Migration 0012 intentionally references the public scheduling envelope.
      await database.client.insert(scheduledActions).values({
        id: actionId,
        guildId: "shadow-guild",
        actionType: "SEND_MESSAGE",
        targetId: "shadow-channel",
        status: "ACTIVE",
        executeAt,
      });
      await isolatedDatabase.execute(sql`
        insert into scheduled_actions
          (id, guild_id, action_type, target_id, status, execute_at, created_at, updated_at)
        values
          (${actionId}, 'upgrade-guild', 'SEND_MESSAGE', 'upgrade-channel', 'ACTIVE',
           ${executeAt}, ${occurredAt}, ${occurredAt})
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_states
          (scheduled_action_id, creator_user_id, retry_count, content, embed_title,
           embed_description, embed_color, embed_image_url, result_message_id)
        values
          (${actionId}, 'original-creator', 2, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/history.png', null)
      `);
      await isolatedDatabase.execute(sql`
        insert into scheduled_message_audits
          (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
           execute_at, content, embed_title, embed_description, embed_color, embed_image_url,
           occurred_at, outcome, failure_code, result_message_id)
        values
          ('historical-created', ${actionId}, 'upgrade-guild', 'upgrade-channel', 'CREATED',
           'USER', 'original-creator', ${executeAt}, 'historical content', 'historical title',
           'historical description', 0, 'https://example.invalid/history.png', ${occurredAt},
           'SUCCESS', null, null)
      `);

      const [beforeState] = (
        await isolatedDatabase.execute(sql`
          select scheduled_action_id, creator_user_id, retry_count, content, embed_title,
                 embed_description, embed_color, embed_image_url, result_message_id
          from scheduled_message_states where scheduled_action_id = ${actionId}
        `)
      ).rows;
      const beforeAudits = (
        await isolatedDatabase.execute(sql`
          select * from scheduled_message_audits where scheduled_action_id = ${actionId}
          order by id
        `)
      ).rows;

      await migrate(isolatedDatabase, {
        migrationsFolder: upgradeMigrationDirectory,
        migrationsSchema,
      });

      const [afterState] = (
        await isolatedDatabase.execute(sql`
          select scheduled_action_id, creator_user_id, retry_count, content, embed_title,
                 embed_description, embed_color, embed_image_url, result_message_id, revision
          from scheduled_message_states where scheduled_action_id = ${actionId}
        `)
      ).rows;
      expect(afterState).toEqual({ ...beforeState, revision: 0 });
      await expect(
        isolatedDatabase.execute(sql`
          update scheduled_message_states set revision = -1
          where scheduled_action_id = ${actionId}
        `),
      ).rejects.toThrow();
      await expect(
        isolatedDatabase.execute(sql`
          select * from scheduled_message_audits where scheduled_action_id = ${actionId}
          order by id
        `),
      ).resolves.toMatchObject({ rows: beforeAudits });

      for (const event of ["EDITED", "RESCHEDULED"] as const) {
        await expect(
          insertModificationAudit(isolatedDatabase, {
            id: `valid-${event.toLowerCase()}`,
            actionId,
            event,
            executeAt,
            occurredAt,
            actorType: "USER",
            actorId: "administrator",
            outcome: "SUCCESS",
            failureCode: null,
            resultMessageId: null,
          }),
        ).resolves.toBeDefined();

        const invalidShapes = [
          ["SYSTEM", null, "SUCCESS", null, null],
          ["USER", null, "SUCCESS", null, null],
          ["USER", "administrator", "FAILURE", "CURRENT_STATE_CHECK_FAILED", null],
          ["USER", "administrator", "SUCCESS", "CURRENT_STATE_CHECK_FAILED", null],
          ["USER", "administrator", "SUCCESS", null, "message-id"],
        ] as const;
        for (const [index, shape] of invalidShapes.entries()) {
          await expect(
            insertModificationAudit(isolatedDatabase, {
              id: `invalid-${event.toLowerCase()}-${index}`,
              actionId,
              event,
              executeAt,
              occurredAt,
              actorType: shape[0],
              actorId: shape[1],
              outcome: shape[2],
              failureCode: shape[3],
              resultMessageId: shape[4],
            }),
          ).rejects.toThrow();
        }
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
});

function insertModificationAudit(
  isolatedDatabase: ReturnType<typeof drizzle>,
  input: {
    id: string;
    actionId: string;
    event: "EDITED" | "RESCHEDULED";
    executeAt: Date;
    occurredAt: Date;
    actorType: "USER" | "SYSTEM";
    actorId: string | null;
    outcome: "SUCCESS" | "FAILURE";
    failureCode: string | null;
    resultMessageId: string | null;
  },
) {
  return isolatedDatabase.execute(sql`
    insert into scheduled_message_audits
      (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
       execute_at, content, occurred_at, outcome, failure_code, result_message_id)
    values
      (${input.id}, ${input.actionId}, 'upgrade-guild', 'upgrade-channel', ${input.event},
       ${input.actorType}, ${input.actorId}, ${input.executeAt}, 'historical content',
       ${input.occurredAt}, ${input.outcome}, ${input.failureCode}, ${input.resultMessageId})
  `);
}

async function createMigrationSubset(maximumIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-scheduled-message-0015-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(
    await readFile("drizzle/meta/_journal.json", "utf8"),
  ) as MigrationJournal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
  await writeFile(
    join(metaDirectory, "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  await Promise.all(
    entries.map((entry) =>
      cp(join("drizzle", `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`)),
    ),
  );
  return directory;
}
