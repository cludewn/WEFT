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
async function subset(maximum: number, schema: string) {
  const directory = await mkdtemp(join(tmpdir(), "weft-failure21-"));
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximum);
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    const content = await readFile(join("drizzle", `${entry.tag}.sql`), "utf8");
    // Remap only isolated temporary test copies of historical explicit public FKs.
    await writeFile(
      join(directory, `${entry.tag}.sql`),
      content.replaceAll('"public".', `"${schema}".`),
    );
  }
  return directory;
}
describe("append-only administrative failure migration 0021", () => {
  it.each(["upgrade", "clean"] as const)(
    "supports %s, no backfill and repeat no-op while preserving existing history",
    async (mode) => {
      const config = loadTestDatabaseConfig(),
        admin = createDatabase(config);
      const suffix = randomUUID().replaceAll("-", ""),
        schema = `weft_failure21_${suffix}`,
        migrationsSchema = `weft_failure21m_${suffix}`;
      const oldDirectory = await subset(20, schema),
        fullDirectory = await subset(21, schema);
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
          application_name: "weft-failure-migration-test",
        });
        const isolated = drizzle(pool);
        const oldSnapshot = JSON.parse(
          await readFile("drizzle/meta/0020_snapshot.json", "utf8"),
        ) as { tables: Record<string, unknown> };
        const tables = Object.keys(oldSnapshot.tables).map((name) => name.replace(/^public\./, ""));
        const snapshot = async () =>
          Promise.all(
            tables.map(
              async (table) =>
                (await isolated.execute(sql`select * from ${sql.identifier(table)} order by 1`))
                  .rows,
            ),
          );
        let before: unknown[] | undefined;
        if (mode === "upgrade") {
          await migrate(isolated, { migrationsFolder: oldDirectory, migrationsSchema });
          await isolated.execute(
            sql`insert into guild_settings (guild_id, timezone, closed_prefix) values ('guild', 'Asia/Tokyo', '[DONE]')`,
          );
          await isolated.execute(
            sql`insert into auto_close_parent_channels (guild_id, parent_channel_id) values ('guild', 'parent')`,
          );
          await isolated.execute(
            sql`insert into guild_configuration_audits (id,guild_id,actor_user_id,action,setting_type,target_type,target_id,previous_text,new_text,occurred_at,outcome) values ('success','guild','actor','SET','TIMEZONE','GUILD','guild','UTC','Asia/Tokyo','2026-01-01T00:00:00Z','SUCCESS')`,
          );
          await isolated.execute(
            sql`insert into thread_audits (id,guild_id,thread_id,action,actor_type,actor_id,outcome,failure_code) values ('failure','guild','thread','CLOSE','USER','actor','FAILURE','DISCORD_FETCH_FAILED')`,
          );
          before = await snapshot();
        }
        await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
        if (before) expect(await snapshot()).toEqual(before);
        expect(
          (await isolated.execute(sql`select * from administrative_operation_failure_audits`)).rows,
        ).toEqual([]);
        const definitions = await isolated.execute(
          sql`select indexdef from pg_indexes where schemaname = ${schema} and tablename = 'administrative_operation_failure_audits'`,
        );
        expect(definitions.rows).toHaveLength(3);
        expect(
          definitions.rows.some((row) => String(row.indexdef).includes("(occurred_at, id)")),
        ).toBe(true);
        expect(
          definitions.rows.some(
            (row) =>
              String(row.indexdef).includes("UNIQUE") &&
              String(row.indexdef).includes("(operation_id)"),
          ),
        ).toBe(true);
        expect(
          (
            await isolated.execute(
              sql`select constraint_name from information_schema.table_constraints where table_schema = ${schema} and table_name = 'administrative_operation_failure_audits' and constraint_type = 'FOREIGN KEY'`,
            )
          ).rows,
        ).toEqual([]);
        const id = randomUUID(),
          operationId = randomUUID();
        await isolated.execute(
          sql`insert into administrative_operation_failure_audits (id,operation_id,guild_id,actor_user_id,operation_code,failure_stage,failure_reason_code,target_type,target_id,outcome,occurred_at) values (${id},${operationId},'guild','actor','GUILD_TIMEZONE_SET','DATABASE_TRANSACTION','TRANSACTION_ROLLED_BACK','GUILD','guild','FAILURE','2026-01-01T00:00:00Z')`,
        );
        await expect(
          isolated.execute(
            sql`insert into administrative_operation_failure_audits (id,operation_id,guild_id,actor_user_id,operation_code,failure_stage,failure_reason_code,target_type,target_id,outcome,occurred_at) values (${randomUUID()},${randomUUID()},'guild','actor','GUILD_TIMEZONE_SET','DATABASE_TRANSACTION','TRANSACTION_ROLLED_BACK','GUILD',null,'FAILURE','2026-01-01T00:00:00Z')`,
          ),
        ).rejects.toMatchObject({ cause: { code: "23514" } });
        const history = (
          await isolated.execute(sql`select * from administrative_operation_failure_audits`)
        ).rows;
        const migrationRows = (
          await isolated.execute(
            sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
          )
        ).rows;
        expect(migrationRows).toHaveLength(22);
        await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
        expect(
          (
            await isolated.execute(
              sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
            )
          ).rows,
        ).toEqual(migrationRows);
        expect(
          (await isolated.execute(sql`select * from administrative_operation_failure_audits`)).rows,
        ).toEqual(history);
        if (before) expect(await snapshot()).toEqual(before);
        else {
          await isolated.execute(sql`insert into guild_settings (guild_id) values ('clean')`);
          expect(
            (
              await isolated.execute(
                sql`select timezone, closed_prefix from guild_settings where guild_id = 'clean'`,
              )
            ).rows,
          ).toEqual([{ timezone: "UTC", closed_prefix: "[CLOSED]" }]);
        }
      } finally {
        await pool?.end();
        await admin.client.execute(sql`drop schema if exists ${sql.identifier(schema)} cascade`);
        await admin.client.execute(
          sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
        );
        await admin.close();
        await rm(oldDirectory, { recursive: true, force: true });
        await rm(fullDirectory, { recursive: true, force: true });
      }
    },
  );
});
