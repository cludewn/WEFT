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
  const directory = await mkdtemp(join(tmpdir(), "weft-prefix23-"));
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

describe("prefix-free migration 0023", () => {
  it.each(["upgrade", "clean"] as const)(
    "supports %s, preserves history, and repeats without changes",
    async (mode) => {
      const config = loadTestDatabaseConfig();
      const admin = createDatabase(config);
      const suffix = randomUUID().replaceAll("-", "");
      const schema = `weft_prefix23_${suffix}`;
      const migrationsSchema = `weft_prefix23m_${suffix}`;
      const previous = await migrationSubset(22, schema);
      const current = await migrationSubset(23, schema);
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
          application_name: "weft-prefix-migration-test",
        });
        const database = drizzle(pool);
        const oldSnapshot = JSON.parse(
          await readFile("drizzle/meta/0022_snapshot.json", "utf8"),
        ) as { tables: Record<string, unknown> };
        const tables = Object.keys(oldSnapshot.tables).map((name) => name.replace(/^public\./, ""));
        const snapshot = () =>
          Promise.all(
            tables.map(
              async (table) =>
                (await database.execute(sql`select * from ${sql.identifier(table)} order by 1, 2`))
                  .rows,
            ),
          );
        const history = async () =>
          (
            await database.execute(
              sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
            )
          ).rows;
        let before: unknown[] | undefined;
        let oldHistory: unknown[] | undefined;
        if (mode === "upgrade") {
          await migrate(database, { migrationsFolder: previous, migrationsSchema });
          await database.execute(
            sql`insert into guild_settings (guild_id, closed_prefix) values ('retained', '[DONE]')`,
          );
          await database.execute(
            sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('retained', 'thread', '[OLD]', 'CLOSED')`,
          );
          await database.execute(
            sql`insert into thread_audits (id, guild_id, thread_id, action, actor_type, outcome) values ('retained-close', 'retained', 'thread', 'CLOSE', 'SYSTEM', 'SUCCESS')`,
          );
          await database.execute(
            sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_text, new_text, occurred_at, outcome) values ('retained-config', 'retained', 'actor', 'SET', 'CLOSED_PREFIX', 'GUILD', 'retained', '[CLOSED]', '[DONE]', '2030-01-01T00:00:00Z', 'SUCCESS')`,
          );
          await expect(
            database.execute(
              sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('before', 'empty', '', 'CLOSED')`,
            ),
          ).rejects.toThrow();
          await expect(
            database.execute(
              sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_text, new_text, occurred_at, outcome) values ('before-empty', 'before', 'actor', 'SET', 'CLOSED_PREFIX', 'GUILD', 'before', '[CLOSED]', '', now(), 'SUCCESS')`,
            ),
          ).rejects.toThrow();
          before = await snapshot();
          oldHistory = await history();
          expect(oldHistory).toHaveLength(23);
        }
        await migrate(database, { migrationsFolder: current, migrationsSchema });
        if (before) expect(await snapshot()).toEqual(before);
        const migrations = await history();
        expect(migrations).toHaveLength(24);
        if (oldHistory) expect(migrations.slice(0, 23)).toEqual(oldHistory);
        await database.execute(sql`insert into guild_settings (guild_id) values ('default')`);
        expect(
          (
            await database.execute(
              sql`select closed_prefix from guild_settings where guild_id = 'default'`,
            )
          ).rows,
        ).toEqual([{ closed_prefix: "[CLOSED]" }]);
        for (const prefix of ["", "[DONE]"]) {
          await database.execute(
            sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('new', ${`thread-${prefix}`}, ${prefix}, 'CLOSED')`,
          );
        }
        await expect(
          database.execute(
            sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('invalid', 'null', null, 'CLOSED')`,
          ),
        ).rejects.toThrow();
        await expect(
          database.execute(
            sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('invalid', 'state', '', 'INVALID')`,
          ),
        ).rejects.toThrow();
        await expect(
          database.execute(
            sql`insert into managed_threads (guild_id, thread_id, applied_prefix, lifecycle_state) values ('new', 'thread-', '', 'OPEN')`,
          ),
        ).rejects.toThrow();
        for (const [previousText, newText] of [
          ["[DONE]", ""],
          ["", "[NEW]"],
        ]) {
          await database.execute(
            sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_text, new_text, occurred_at, outcome) values (${randomUUID()}, 'new', 'actor', 'SET', 'CLOSED_PREFIX', 'GUILD', 'new', ${previousText}, ${newText}, now(), 'SUCCESS')`,
          );
        }
        // Other setting rules, explicit NULL shape, distinct values, and control rejection remain.
        for (const [setting, previousText, newText] of [
          ["TIMEZONE", "UTC", ""],
          ["CLOSED_PREFIX", "", ""],
          ["CLOSED_PREFIX", null, ""],
          ["CLOSED_PREFIX", "", "x".repeat(21)],
          ["CLOSED_PREFIX", "bad\n", ""],
        ]) {
          await expect(
            database.execute(
              sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_text, new_text, occurred_at, outcome) values (${randomUUID()}, 'invalid', 'actor', 'SET', ${setting}, 'GUILD', 'invalid', ${previousText}, ${newText}, now(), 'SUCCESS')`,
            ),
          ).rejects.toThrow();
        }
        expect(
          (
            await database.execute(
              sql`select conname from pg_constraint where conrelid = 'managed_threads'::regclass and conname = 'managed_threads_applied_prefix_check'`,
            )
          ).rows,
        ).toEqual([]);
        const rows = await snapshot();
        await migrate(database, { migrationsFolder: current, migrationsSchema });
        expect(await snapshot()).toEqual(rows);
        expect(await history()).toEqual(migrations);
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
