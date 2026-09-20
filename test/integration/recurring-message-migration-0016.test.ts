import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { recurringMessageSchedules } from "../../src/recurring-message-persistence.js";
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

describe("recurring message migration 0016", () => {
  it("upgrades actual 0000 through 0015 without changing one-time history", async () => {
    const config = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_rm_16_${suffix}`;
    const migrationsSchema = `weft_rmg_16_${suffix}`;
    const beforeDirectory = await createMigrationSubset(15);
    const through0016Directory = await createMigrationSubset(16);
    const actionIds = ["ACTIVE", "EXECUTING", "CANCELLED", "COMPLETED", "FAILED"].map(
      (status) => `rm16-${status.toLowerCase()}-${suffix}`,
    );
    let isolatedPool: Pool | undefined;

    try {
      await database.client.execute(sql`create schema ${sql.identifier(schemaName)}`);
      isolatedPool = new Pool({
        host: config.host,
        port: config.port,
        database: config.name,
        user: config.user,
        password: config.password,
        ssl: config.ssl ? { rejectUnauthorized: true } : false,
        application_name: "weft-recurring-0016-upgrade-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolated = drizzle(isolatedPool);
      await migrate(isolated, { migrationsFolder: beforeDirectory, migrationsSchema });

      for (const [index, status] of [
        "ACTIVE",
        "EXECUTING",
        "CANCELLED",
        "COMPLETED",
        "FAILED",
      ].entries()) {
        const id = actionIds[index]!;
        const executeAt = new Date(`203${index}-01-01T00:00:00.000Z`);
        await database.client.insert(scheduledActions).values({
          id,
          guildId: "shadow-guild",
          actionType: "SEND_MESSAGE",
          targetId: `shadow-${index}`,
          status: "ACTIVE",
          executeAt,
        });
        await isolated.execute(sql`
          insert into scheduled_actions
            (id, guild_id, action_type, target_id, status, execute_at, created_at, updated_at)
          values (${id}, 'upgrade-guild', 'SEND_MESSAGE', ${`channel-${index}`}, ${status},
            ${executeAt}, ${new Date("2026-09-18T01:00:00.000Z")},
            ${new Date("2026-09-18T02:00:00.000Z")})
        `);
        await isolated.execute(sql`
          insert into scheduled_message_states
            (scheduled_action_id, creator_user_id, retry_count, revision, content,
             result_message_id)
          values (${id}, 'creator', 0, ${index}, 'historical payload',
            ${status === "COMPLETED" ? `message-${index}` : null})
        `);
        await isolated.execute(sql`
          insert into scheduled_message_audits
            (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
             execute_at, content, occurred_at, outcome, failure_code, result_message_id)
          values (${`created-${index}`}, ${id}, 'upgrade-guild', ${`channel-${index}`},
            'CREATED', 'USER', 'creator', ${executeAt}, 'historical payload',
            ${new Date("2026-09-18T01:00:00.000Z")}, 'SUCCESS', null, null)
        `);
      }

      const beforeActions = (
        await isolated.execute(sql`select * from scheduled_actions order by id`)
      ).rows;
      const beforeStates = (
        await isolated.execute(
          sql`select * from scheduled_message_states order by scheduled_action_id`,
        )
      ).rows;
      const beforeAudits = (
        await isolated.execute(sql`select * from scheduled_message_audits order by id`)
      ).rows;

      await migrate(isolated, {
        migrationsFolder: through0016Directory,
        migrationsSchema,
      });

      expect(
        (await isolated.execute(sql`select * from scheduled_actions order by id`)).rows,
      ).toEqual(beforeActions);
      expect(
        (
          await isolated.execute(
            sql`select * from scheduled_message_states order by scheduled_action_id`,
          )
        ).rows,
      ).toEqual(beforeStates);
      expect(
        (await isolated.execute(sql`select * from scheduled_message_audits order by id`)).rows,
      ).toEqual(beforeAudits);
      await expect(
        isolated.execute(sql`select * from recurring_message_schedules`),
      ).resolves.toMatchObject({
        rows: [],
      });
      const oneTimeRows = (
        await isolated.execute(sql`
          select action.id from scheduled_actions action
          where action.action_type = 'SEND_MESSAGE'
            and not exists (
              select 1 from recurring_message_schedules recurring
              where recurring.scheduled_action_id = action.id
            )
          order by action.id
        `)
      ).rows;
      expect(oneTimeRows).toHaveLength(5);

      const recurringId = actionIds[0]!;
      await database.client.insert(recurringMessageSchedules).values({
        scheduledActionId: recurringId,
        timezone: "UTC",
        frequency: "DAILY",
        weekdayMask: 127,
        localTime: "09:00",
        definitionRevision: 0,
        effectiveAt: new Date("2026-09-18T03:00:00.000Z"),
      });
      await isolated.execute(sql`
        insert into recurring_message_schedules
          (scheduled_action_id, timezone, frequency, weekday_mask, local_time,
           definition_revision, effective_at)
        values (${recurringId}, 'UTC', 'DAILY', 127, '09:00', 0,
          ${new Date("2026-09-18T03:00:00.000Z")})
      `);
      expect(
        (
          await isolated.execute(sql`
            select action.id from scheduled_actions action
            where action.status in ('ACTIVE', 'EXECUTING')
              and not exists (
                select 1 from recurring_message_schedules recurring
                where recurring.scheduled_action_id = action.id
              )
          `)
        ).rows.map((row) => row.id),
      ).not.toContain(recurringId);

      await isolated.execute(sql`
        insert into recurring_message_occurrences
          (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
           intended_local_time, scheduled_for, status, retry_count)
        values ('valid-occurrence', ${recurringId}, 0, '2030-01-01', '09:00',
          ${new Date("2030-01-01T09:00:00.000Z")}, 'PENDING', 0)
      `);
      await expect(
        isolated.execute(sql`
          insert into recurring_message_occurrences
            (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
             intended_local_time, scheduled_for, status, retry_count)
          values ('duplicate-nonterminal', ${recurringId}, 0, '2030-01-02', '09:00',
            ${new Date("2030-01-02T09:00:00.000Z")}, 'PENDING', 0)
        `),
      ).rejects.toThrow();
      await isolated.execute(sql`
        update recurring_message_occurrences
        set status = 'SKIPPED', skip_reason = 'SERIES_CANCELLED',
            terminal_at = ${new Date("2030-01-01T10:00:00.000Z")}
        where id = 'valid-occurrence'
      `);
      await expect(
        isolated.execute(sql`
          insert into recurring_message_occurrences
            (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
             intended_local_time, scheduled_for, status, retry_count, skip_reason, terminal_at)
          values ('duplicate-materialization', ${recurringId}, 0, '2030-01-01', '09:00',
            ${new Date("2030-01-01T09:00:00.000Z")}, 'SKIPPED', 0,
            'MISSED_GRACE_EXCEEDED', ${new Date("2030-01-01T10:00:00.000Z")})
        `),
      ).rejects.toThrow();
      await expect(
        isolated.execute(sql`
          insert into recurring_message_occurrences
            (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
             intended_local_time, scheduled_for, status, retry_count)
          values ('invalid-executing-shape', ${recurringId}, 0, '2030-01-02', '09:00',
            ${new Date("2030-01-02T09:00:00.000Z")}, 'EXECUTING', 0)
        `),
      ).rejects.toThrow();
      await expect(
        isolated.execute(sql`
          insert into recurring_message_occurrences
            (id, scheduled_action_id, materialized_definition_revision, intended_local_date,
             intended_local_time, scheduled_for, status, retry_count)
          values ('one-time-child', ${actionIds[1]!}, 0, '2030-01-02', '09:00',
            ${new Date("2030-01-02T09:00:00.000Z")}, 'PENDING', 0)
        `),
      ).rejects.toThrow();
      await expect(
        isolated.execute(sql`
          insert into recurring_message_audits
            (id, scheduled_action_id, guild_id, channel_id, event, actor_type, actor_id,
             occurred_at, outcome)
          values ('invalid-audit', ${recurringId}, 'upgrade-guild', 'channel-0',
            'SERIES_CREATED', 'SYSTEM', null, ${new Date()}, 'FAILURE')
        `),
      ).rejects.toThrow();
    } finally {
      await isolatedPool?.end();
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
      );
      await database.client.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await database.client
        .delete(recurringMessageSchedules)
        .where(inArray(recurringMessageSchedules.scheduledActionId, actionIds));
      await database.client.delete(scheduledActions).where(inArray(scheduledActions.id, actionIds));
      await rm(beforeDirectory, { recursive: true, force: true });
      await rm(through0016Directory, { recursive: true, force: true });
    }
  });
});

async function createMigrationSubset(maximumIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-recurring-message-0016-"));
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
