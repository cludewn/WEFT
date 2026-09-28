import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

const expected = new Map([
  ["thread_audits_retention_idx", ["thread_audits", "(created_at, id)"]],
  [
    "scheduled_thread_close_audits_retention_idx",
    ["scheduled_thread_close_audits", "(created_at, id)"],
  ],
  ["managed_message_audits_retention_idx", ["managed_message_audits", "(occurred_at, id)"]],
  ["scheduled_message_audits_retention_idx", ["scheduled_message_audits", "(occurred_at, id)"]],
  ["recurring_message_audits_retention_idx", ["recurring_message_audits", "(occurred_at, id)"]],
  [
    "audit_log_destination_audits_retention_idx",
    ["audit_log_destination_audits", "(occurred_at, id)"],
  ],
]);

describe("audit retention migration 0018", () => {
  it.each(["existing data", "fresh schema"])(
    "applies all migrations with indexes and preserves %s",
    async (mode) => {
      const config = loadTestDatabaseConfig();
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const schemaName = `weft_ar_18_${suffix}`;
      const migrationsSchema = `weft_arm_18_${suffix}`;
      const beforeDirectory = await migrationSubset(17);
      const fullDirectory = await migrationSubset(18);
      const admin = createDatabase(config);
      let pool: Pool | undefined;
      try {
        await admin.client.execute(sql`create schema ${sql.identifier(schemaName)}`);
        pool = new Pool({
          host: config.host,
          port: config.port,
          database: config.name,
          user: config.user,
          password: config.password,
          ssl: config.ssl ? { rejectUnauthorized: true } : false,
          application_name: "weft-audit-retention-migration-test",
          options: `-c search_path=${schemaName}`,
        });
        const isolated = drizzle(pool);
        let threadBefore: unknown[] = [];
        let destinationBefore: unknown[] = [];
        if (mode === "existing data") {
          await migrate(isolated, { migrationsFolder: beforeDirectory, migrationsSchema });
          await isolated.execute(sql`
          insert into thread_audits
            (id, guild_id, thread_id, action, actor_type, actor_id, outcome, created_at)
          values ('retained-thread', 'guild', 'thread', 'CLOSE', 'USER', 'actor', 'SUCCESS',
            '2020-01-01T00:00:00Z')
        `);
          await isolated.execute(sql`
          insert into audit_log_destination_audits
            (id, guild_id, actor_user_id, new_channel_id, occurred_at, outcome)
          values ('retained-destination', 'guild', 'actor', 'channel',
            '2020-01-01T00:00:00Z', 'SUCCESS')
        `);
          threadBefore = (await isolated.execute(sql`select * from thread_audits`)).rows;
          destinationBefore = (
            await isolated.execute(sql`select * from audit_log_destination_audits`)
          ).rows;
        }
        await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
        const indexes = await isolated.execute<{
          indexname: string;
          tablename: string;
          indexdef: string;
          indisvalid: boolean;
          indisunique: boolean;
          partial: boolean;
        }>(sql`
          select pi.indexname, pi.tablename, pi.indexdef, ix.indisvalid, ix.indisunique,
            ix.indpred is not null as partial
          from pg_indexes pi
          join pg_namespace ns on ns.nspname = pi.schemaname
          join pg_class idx on idx.relname = pi.indexname and idx.relnamespace = ns.oid
          join pg_index ix on ix.indexrelid = idx.oid
          where pi.schemaname = ${schemaName} and pi.indexname like '%_retention_idx'
        `);
        expect(indexes.rows).toHaveLength(6);
        for (const [name, [table, columns]] of expected) {
          const index = indexes.rows.find((row) => row.indexname === name);
          expect(index).toMatchObject({
            tablename: table,
            indisvalid: true,
            indisunique: false,
            partial: false,
          });
          expect(index?.indexdef).toContain(`USING btree ${columns}`);
        }
        expect((await isolated.execute(sql`select * from thread_audits`)).rows).toEqual(
          threadBefore,
        );
        expect(
          (await isolated.execute(sql`select * from audit_log_destination_audits`)).rows,
        ).toEqual(destinationBefore);
      } finally {
        await pool?.end();
        await admin.client.execute(
          sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
        );
        await admin.client.execute(
          sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
        );
        await admin.close();
        await rm(beforeDirectory, { recursive: true, force: true });
        await rm(fullDirectory, { recursive: true, force: true });
      }
    },
  );
});

async function migrationSubset(maximumIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-audit-retention-0018-"));
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
  await writeFile(
    join(directory, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  await Promise.all(
    entries.map((entry) =>
      cp(join("drizzle", `${entry.tag}.sql`), join(directory, `${entry.tag}.sql`)),
    ),
  );
  return directory;
}
