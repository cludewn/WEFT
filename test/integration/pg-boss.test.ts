import { sql } from "drizzle-orm";
import type { Logger } from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase } from "../../src/database.js";
import { createPgBossRuntime, type PgBossRuntime } from "../../src/pg-boss.js";

const config = loadTestDatabaseConfig();
const database = createDatabase(config);
const runtimes: PgBossRuntime[] = [];
const logger = { info: () => undefined, error: () => undefined } as unknown as Logger;

beforeAll(async () => {
  await dropPgBossSchema();
});

afterAll(async () => {
  for (const runtime of runtimes.toReversed()) {
    await runtime.stop();
  }
  await dropPgBossSchema();
  await database.close();
});

describe("pg-boss runtime", () => {
  it("initializes a clean schema, closes its pool, and starts again safely", async () => {
    const first = createPgBossRuntime(config, logger);
    runtimes.push(first);
    await first.start();

    const installed = await database.client.execute<{ schemaName: string | null }>(sql`
      select to_regnamespace('pgboss')::text as "schemaName"
    `);
    expect(installed.rows[0]?.schemaName).toBe("pgboss");

    await first.stop();
    await expectPgBossConnections(0);

    const second = createPgBossRuntime(config, logger);
    runtimes.push(second);
    await second.start();
    await second.stop();

    await expectPgBossConnections(0);
  });
});

async function expectPgBossConnections(expected: number): Promise<void> {
  const result = await database.client.execute<{ connectionCount: number }>(sql`
    select count(*)::integer as "connectionCount"
    from pg_stat_activity
    where datname = current_database()
      and application_name = 'weft-pg-boss'
  `);
  expect(result.rows[0]?.connectionCount).toBe(expected);
}

async function dropPgBossSchema(): Promise<void> {
  await database.client.execute(sql`drop schema if exists pgboss cascade`);
}
