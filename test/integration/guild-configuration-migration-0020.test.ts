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
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};
async function migrationSubset(maximum: number, schemaName: string) {
  const directory = await mkdtemp(join(tmpdir(), "weft-configuration-0020-"));
  await mkdir(join(directory, "meta"));
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
  const entries = journal.entries.filter((entry) => entry.idx <= maximum);
  await writeFile(join(directory, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
  // Historical FKs explicitly reference public. Remap only temporary test copies so clean
  // installation has no dependency on tables in the shared integration database's public schema.
  await Promise.all(
    entries.map(async (entry) => {
      const content = await readFile(join("drizzle", `${entry.tag}.sql`), "utf8");
      await writeFile(
        join(directory, `${entry.tag}.sql`),
        content.replaceAll('"public".', `"${schemaName}".`),
      );
    }),
  );
  return directory;
}

describe("append-only guild configuration migration 0020", () => {
  it.each(["upgrade", "clean"] as const)(
    "supports %s without backfill or authoritative state loss",
    async (mode) => {
      const config = loadTestDatabaseConfig();
      const admin = createDatabase(config);
      const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
      const schemaName = `weft_config20_${suffix}`,
        migrationsSchema = `weft_config20m_${suffix}`;
      const oldDirectory = await migrationSubset(19, schemaName),
        fullDirectory = await migrationSubset(20, schemaName);
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
          application_name: "weft-configuration-migration-test",
          options: `-c search_path=${schemaName}`,
        });
        const isolated = drizzle(pool);
        const tables = [
          "guild_settings",
          "auto_close_parent_channels",
          "auto_close_thread_exclusions",
          "auto_close_thread_activity",
          "auto_close_thread_retirements",
          "audit_log_destination_audits",
          "link_preview_audits",
        ];
        const snapshot = async () =>
          Promise.all(
            tables.map(
              async (table) =>
                (await isolated.execute(sql`select * from ${sql.identifier(table)}`)).rows,
            ),
          );
        let before: unknown[] | undefined;
        if (mode === "upgrade") {
          await migrate(isolated, { migrationsFolder: oldDirectory, migrationsSchema });
          await isolated.execute(
            sql`insert into guild_settings (guild_id, timezone, closed_prefix, auto_close_inactivity_seconds, auto_close_bot_messages_count_as_activity, audit_log_channel_id, link_preview_mode, created_at, updated_at) values ('guild', 'Asia/Tokyo', '[DONE]', 3600, true, 'destination', 'off', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')`,
          );
          await isolated.execute(
            sql`insert into auto_close_parent_channels (guild_id, parent_channel_id) values ('guild', 'parent')`,
          );
          await isolated.execute(
            sql`insert into auto_close_thread_exclusions (guild_id, thread_id) values ('guild', 'thread')`,
          );
          await isolated.execute(
            sql`insert into auto_close_thread_activity (guild_id, thread_id, parent_channel_id, last_activity_at) values ('guild', 'thread', 'parent', '2026-02-01T00:00:00Z')`,
          );
          await isolated.execute(
            sql`insert into auto_close_thread_retirements (guild_id, thread_id, last_activity_at) values ('guild', 'thread', '2026-01-01T00:00:00Z')`,
          );
          await isolated.execute(
            sql`insert into audit_log_destination_audits (id, guild_id, actor_user_id, previous_channel_id, new_channel_id, occurred_at, outcome) values ('destination-audit', 'guild', 'actor', null, 'destination', now(), 'SUCCESS')`,
          );
          await isolated.execute(
            sql`insert into link_preview_audits (id, guild_id, actor_user_id, previous_mode, new_mode, occurred_at, outcome) values ('preview-audit', 'guild', 'actor', 'hybrid', 'off', now(), 'SUCCESS')`,
          );
          before = await snapshot();
        }
        await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
        if (before) expect(await snapshot()).toEqual(before);
        else {
          await isolated.execute(sql`insert into guild_settings (guild_id) values ('fresh')`);
          expect(
            (
              await isolated.execute(
                sql`select timezone, closed_prefix, auto_close_inactivity_seconds, auto_close_bot_messages_count_as_activity, audit_log_channel_id, link_preview_mode from guild_settings where guild_id = 'fresh'`,
              )
            ).rows,
          ).toEqual([
            {
              timezone: "UTC",
              closed_prefix: "[CLOSED]",
              auto_close_inactivity_seconds: 604800,
              auto_close_bot_messages_count_as_activity: false,
              audit_log_channel_id: null,
              link_preview_mode: "hybrid",
            },
          ]);
        }
        expect(
          (await isolated.execute(sql`select * from guild_configuration_audits`)).rows,
        ).toEqual([]);
        const index = await isolated.execute(
          sql`select indexdef from pg_indexes where schemaname = ${schemaName} and indexname = 'guild_configuration_audits_retention_idx'`,
        );
        expect(index.rows[0]?.indexdef).toContain("(occurred_at, id)");
        const foreignKeys = await isolated.execute(
          sql`select constraint_name from information_schema.table_constraints where table_schema = ${schemaName} and table_name = 'guild_configuration_audits' and constraint_type = 'FOREIGN KEY'`,
        );
        expect(foreignKeys.rows).toEqual([]);
        await expect(
          isolated.execute(
            sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_boolean, new_boolean, occurred_at, outcome) values ('invalid', 'guild', 'actor', 'TRACK', 'THREAD_EXCLUSION', 'THREAD', 'thread', null, false, now(), 'SUCCESS')`,
          ),
        ).rejects.toThrow();
        await isolated.execute(
          sql`insert into guild_configuration_audits (id, guild_id, actor_user_id, action, setting_type, target_type, target_id, previous_boolean, new_boolean, occurred_at, outcome) values ('valid', 'guild', 'actor', 'REMOVE', 'AUTO_CLOSE_PARENT', 'PARENT_CHANNEL', 'parent', true, false, now(), 'SUCCESS')`,
        );
        await isolated.execute(
          sql`delete from auto_close_parent_channels where guild_id = 'guild'`,
        );
        await isolated.execute(sql`delete from guild_settings where guild_id = 'guild'`);
        expect(
          (await isolated.execute(sql`select id from guild_configuration_audits`)).rows,
        ).toEqual([{ id: "valid" }]);
        const migrationRows = (
          await isolated.execute(
            sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
          )
        ).rows;
        await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
        expect(
          (
            await isolated.execute(
              sql`select * from ${sql.identifier(migrationsSchema)}.__drizzle_migrations order by id`,
            )
          ).rows,
        ).toEqual(migrationRows);
      } finally {
        await pool?.end();
        await admin.client.execute(
          sql`drop schema if exists ${sql.identifier(schemaName)} cascade`,
        );
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
