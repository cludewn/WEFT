import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

async function migrationSubset(maximum: number, schema: string) {
  const directory = await mkdtemp(join(tmpdir(), "weft-managed22-"));
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximum);
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    const original = await readFile(join("drizzle", `${entry.tag}.sql`), "utf8");
    // Historical artifacts stay untouched; only temporary isolated copies remap explicit public FKs.
    await writeFile(
      join(directory, `${entry.tag}.sql`),
      original.replaceAll('"public".', `"${schema}".`),
    );
  }
  return directory;
}

describe("managed execution migration 0022", () => {
  it.each(["upgrade", "clean"] as const)(
    "supports %s and repeated migration without rewriting history",
    async (mode) => {
      const config = loadTestDatabaseConfig(),
        admin = createDatabase(config);
      const suffix = randomUUID().replaceAll("-", ""),
        schema = `weft_managed22_${suffix}`,
        migrationsSchema = `weft_managed22m_${suffix}`;
      const previous = await migrationSubset(21, schema),
        current = await migrationSubset(22, schema);
      let pool: Pool | undefined;
      try {
        await admin.client.execute(sql`create schema ${sql.identifier(schema)}`);
        pool = new Pool({
          host: config.host,
          port: config.port,
          database: config.name,
          user: config.user,
          password: config.password,
          ssl: config.ssl ? { rejectUnauthorized: true } : false,
          options: `-c search_path=${schema}`,
          application_name: "weft-managed-migration-test",
        });
        const database = drizzle(pool);
        const oldSnapshot = JSON.parse(
          await readFile("drizzle/meta/0021_snapshot.json", "utf8"),
        ) as { tables: Record<string, unknown> };
        const tables = Object.keys(oldSnapshot.tables).map((name) => name.replace(/^public\./, ""));
        const snapshot = () =>
          Promise.all(
            tables.map(
              async (table) =>
                (await database.execute(sql`select * from ${sql.identifier(table)} order by 1`))
                  .rows,
            ),
          );
        let before: unknown[] | undefined;
        let oldMigrations: unknown[] | undefined;
        if (mode === "upgrade") {
          await migrate(database, { migrationsFolder: previous, migrationsSchema });
          await database.execute(sql`insert into managed_messages
          (message_id,guild_id,channel_id,creator_user_id,content,embed_title,embed_color,revision,status,created_at)
          values ('managed','guild','channel','creator','retained payload','Retained title',12,1,'ACTIVE','2030-01-01T00:00:00Z')`);
          await database.execute(sql`insert into managed_message_audits
          (id,message_id,guild_id,channel_id,event,actor_type,actor_id,after_content,after_embed_title,after_embed_color,after_revision,after_status,occurred_at,outcome)
          values ('created','managed','guild','channel','CREATED','USER','creator','retained payload','Retained title',12,1,'ACTIVE','2030-01-01T00:00:00Z','SUCCESS')`);
          await database.execute(sql`insert into administrative_operation_failure_audits
          (id,operation_id,guild_id,actor_user_id,operation_code,failure_stage,failure_reason_code,target_type,target_id,outcome,occurred_at)
          values (${randomUUID()},${randomUUID()},'guild','actor','THREAD_TRACK','DATABASE_START','TRANSACTION_START_FAILED','THREAD','thread','FAILURE','2030-01-01T00:00:00Z')`);
          before = await snapshot();
          oldMigrations = (
            await database.execute(
              sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
            )
          ).rows;
          expect(oldMigrations).toHaveLength(22);
        }
        await migrate(database, { migrationsFolder: current, migrationsSchema });
        if (before) expect(await snapshot()).toEqual(before);
        expect(
          (await database.execute(sql`select * from managed_message_execution_failure_audits`))
            .rows,
        ).toEqual([]);
        const history = (
          await database.execute(
            sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
          )
        ).rows;
        expect(history).toHaveLength(23);
        if (oldMigrations) expect(history.slice(0, 22)).toEqual(oldMigrations);
        const definitions = await database.execute(
          sql`select indexdef from pg_indexes where schemaname = ${schema} and tablename = 'managed_message_execution_failure_audits'`,
        );
        expect(definitions.rows).toHaveLength(3);
        expect(
          definitions.rows.some((row) => String(row.indexdef).includes("(occurred_at, id)")),
        ).toBe(true);
        expect(
          (
            await database.execute(sql`select constraint_name from information_schema.table_constraints
        where table_schema = ${schema} and table_name = 'managed_message_execution_failure_audits' and constraint_type = 'FOREIGN KEY'`)
          ).rows,
        ).toEqual([]);
        const id = randomUUID(),
          operationId = randomUUID();
        await database.execute(sql`insert into managed_message_execution_failure_audits
        (id,operation_id,success_audit_id,guild_id,channel_id,actor_user_id,operation_code,stage,reason_code,outcome,
        discord_evidence,payload_evidence,transaction_evidence,database_effect,compensation_type,compensation_evidence,occurred_at)
        values (${id},${operationId},${operationId},'guild','channel','actor','MANAGED_MESSAGE_SEND','DISCORD_PREFLIGHT',
        'BOT_PERMISSION_MISSING','FAILURE','NOT_ATTEMPTED','NOT_CHECKED','NOT_ATTEMPTED','NOT_ATTEMPTED','NONE','NOT_REQUIRED','2030-01-01T00:00:00Z')`);
        const rows = (
          await database.execute(sql`select * from managed_message_execution_failure_audits`)
        ).rows;
        await migrate(database, { migrationsFolder: current, migrationsSchema });
        expect(
          (await database.execute(sql`select * from managed_message_execution_failure_audits`))
            .rows,
        ).toEqual(rows);
        expect(
          (
            await database.execute(
              sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
            )
          ).rows,
        ).toEqual(history);
        if (before) expect(await snapshot()).toEqual(before);
      } finally {
        await pool?.end();
        await admin.client.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`);
        await admin.client.execute(
          sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
        );
        await admin.close();
        await rm(previous, { recursive: true, force: true });
        await rm(current, { recursive: true, force: true });
      }
    },
  );
});
