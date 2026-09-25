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

describe("audit log destination migration 0017", () => {
  it("upgrades pre-existing guild settings without changing prior values", async () => {
    const config = loadTestDatabaseConfig();
    const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
    const schemaName = `weft_ad_17_${suffix}`;
    const migrationsSchema = `weft_adm_17_${suffix}`;
    const beforeDirectory = await migrationSubset(16);
    const fullDirectory = await migrationSubset(17);
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
        application_name: "weft-audit-destination-migration-test",
        options: `-c search_path=${schemaName}`,
      });
      const isolated = drizzle(pool);
      await migrate(isolated, { migrationsFolder: beforeDirectory, migrationsSchema });
      await isolated.execute(sql`
        insert into guild_settings
          (guild_id, timezone, closed_prefix, auto_close_inactivity_seconds,
           auto_close_bot_messages_count_as_activity)
        values ('existing-guild', 'Asia/Tokyo', '[DONE]', 3600, true)
      `);
      const before = (
        await isolated.execute(sql`select * from guild_settings where guild_id = 'existing-guild'`)
      ).rows[0];
      await migrate(isolated, { migrationsFolder: fullDirectory, migrationsSchema });
      const after = (
        await isolated.execute(sql`select * from guild_settings where guild_id = 'existing-guild'`)
      ).rows[0];
      expect(after).toMatchObject({ ...before, audit_log_channel_id: null });
      const index = await isolated.execute(sql`
        select indexdef from pg_indexes
        where schemaname = ${schemaName}
          and indexname = 'audit_log_destination_audits_retention_idx'
      `);
      expect(index.rows[0]?.indexdef).toContain("(occurred_at, id)");
      await expect(
        isolated.execute(sql`
        insert into audit_log_destination_audits
          (id, guild_id, actor_user_id, occurred_at, outcome)
        values ('invalid', 'existing-guild', 'actor', now(), 'SUCCESS')
      `),
      ).rejects.toThrow();
      await expect(
        isolated.execute(sql`
        update guild_settings set audit_log_channel_id = '' where guild_id = 'existing-guild'
      `),
      ).rejects.toThrow();
    } finally {
      await pool?.end();
      await admin.client.execute(sql`drop schema if exists ${sql.identifier(schemaName)} cascade`);
      await admin.client.execute(
        sql`drop schema if exists ${sql.identifier(migrationsSchema)} cascade`,
      );
      await admin.close();
      await rm(beforeDirectory, { recursive: true, force: true });
      await rm(fullDirectory, { recursive: true, force: true });
    }
  });
});

async function migrationSubset(maximumIndex: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-audit-destination-0017-"));
  const metaDirectory = join(directory, "meta");
  await mkdir(metaDirectory);
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
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
