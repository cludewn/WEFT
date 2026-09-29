import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig, type DatabaseConfig } from "../../src/config.js";

const testConfig = loadTestDatabaseConfig();
const admin = new Pool(poolOptions(testConfig));
const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
  version: string;
  dialect: string;
  entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
};

const reviewedPublicReferences = {
  "0012_lumpy_marten_broadcloak": [
    { fragment: 'REFERENCES "public"."scheduled_actions"("id")', count: 1 },
  ],
  "0016_sparkling_ego": [
    {
      fragment: 'REFERENCES "public"."recurring_message_schedules"("scheduled_action_id")',
      count: 2,
    },
    { fragment: 'REFERENCES "public"."recurring_message_occurrences"("id")', count: 1 },
    { fragment: 'REFERENCES "public"."scheduled_actions"("id")', count: 1 },
  ],
} as const;

afterAll(async () => {
  await admin.end();
});

describe("production migration history", () => {
  it("applies all committed migrations in an empty schema, then repeats as a no-op", async () => {
    await withIsolatedSchema(async (applicationSchema, migrationsSchema, database) => {
      const directory = await migrationCopy(applicationSchema);
      try {
        await migrate(database, { migrationsFolder: directory, migrationsSchema });
        expect(await ledgerCount(migrationsSchema)).toBe(journal.entries.length);
        expect(await tableExists(applicationSchema, "guild_settings")).toBe(true);
        await migrate(database, { migrationsFolder: directory, migrationsSchema });
        expect(await ledgerCount(migrationsSchema)).toBe(journal.entries.length);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });

  it("applies only pending migrations after an earlier committed subset", async () => {
    await withIsolatedSchema(async (applicationSchema, migrationsSchema, database) => {
      const beforeDirectory = await migrationCopy(applicationSchema, 10);
      try {
        const fullDirectory = await migrationCopy(applicationSchema);
        try {
          await migrate(database, { migrationsFolder: beforeDirectory, migrationsSchema });
          expect(await ledgerCount(migrationsSchema)).toBe(11);
          await migrate(database, { migrationsFolder: fullDirectory, migrationsSchema });
          expect(await ledgerCount(migrationsSchema)).toBe(journal.entries.length);
          expect(await tableExists(applicationSchema, "recurring_message_schedules")).toBe(true);
        } finally {
          await rm(fullDirectory, { recursive: true, force: true });
        }
      } finally {
        await rm(beforeDirectory, { recursive: true, force: true });
      }
    });
  });

  it("rolls back a conflicting first migration without a ledger row", async () => {
    await withIsolatedSchema(async (applicationSchema, migrationsSchema, database) => {
      const directory = await migrationCopy(applicationSchema);
      try {
        await admin.query(`create table "${applicationSchema}".guild_settings (conflict integer)`);
        await expect(
          migrate(database, { migrationsFolder: directory, migrationsSchema }),
        ).rejects.toThrow();
        expect(await ledgerCount(migrationsSchema)).toBe(0);
        expect(await tableExists(applicationSchema, "guild_settings")).toBe(true);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  });
});

describe("public schema adaptation guard", () => {
  it("rejects a public reference in an unreviewed migration tag", async () => {
    const source = await readFile("drizzle/0012_lumpy_marten_broadcloak.sql", "utf8");
    expect(() =>
      adaptReviewedPublicReferences("future_migration", source, "isolated_schema"),
    ).toThrow(/Unexpected public reference count/);
  });

  it("rejects an unreviewed reference target in a reviewed tag", async () => {
    const source = await readFile("drizzle/0012_lumpy_marten_broadcloak.sql", "utf8");
    const changed = source.replace(
      'REFERENCES "public"."scheduled_actions"("id")',
      'REFERENCES "public"."unexpected_table"("id")',
    );
    expect(() =>
      adaptReviewedPublicReferences("0012_lumpy_marten_broadcloak", changed, "isolated_schema"),
    ).toThrow(/Unexpected public reference target/);
  });

  it("rejects a changed occurrence count in a reviewed tag", async () => {
    const source = await readFile("drizzle/0012_lumpy_marten_broadcloak.sql", "utf8");
    const changed = `${source}\nREFERENCES "public"."scheduled_actions"("id")`;
    expect(() =>
      adaptReviewedPublicReferences("0012_lumpy_marten_broadcloak", changed, "isolated_schema"),
    ).toThrow(/Unexpected public reference count/);
  });
});

function poolOptions(config: DatabaseConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
  };
}

async function withIsolatedSchema(
  run: (
    applicationSchema: string,
    migrationsSchema: string,
    database: ReturnType<typeof drizzle>,
  ) => Promise<void>,
): Promise<void> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const applicationSchema = `weft_pm_${suffix}`;
  const migrationsSchema = `weft_pml_${suffix}`;
  let pool: Pool | undefined;
  let created = false;
  try {
    await admin.query(`create schema "${applicationSchema}"`);
    created = true;
    pool = new Pool({
      ...poolOptions(testConfig),
      options: `-c search_path=${applicationSchema}`,
    });
    await run(applicationSchema, migrationsSchema, drizzle(pool));
  } finally {
    try {
      await pool?.end();
    } finally {
      if (created) {
        try {
          await admin.query(`drop schema if exists "${migrationsSchema}" cascade`);
        } finally {
          await admin.query(`drop schema if exists "${applicationSchema}" cascade`);
        }
      }
    }
  }
}

async function ledgerCount(migrationsSchema: string): Promise<number> {
  const exists = await admin.query<{ name: string | null }>(
    "select to_regclass($1)::text as name",
    [`${migrationsSchema}.__drizzle_migrations`],
  );
  if (!exists.rows[0]?.name) return 0;
  const count = await admin.query<{ count: string }>(
    `select count(*)::text as count from "${migrationsSchema}".__drizzle_migrations`,
  );
  return Number(count.rows[0]?.count);
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const result = await admin.query<{ name: string | null }>(
    "select to_regclass($1)::text as name",
    [`${schema}.${table}`],
  );
  return Boolean(result.rows[0]?.name);
}

async function migrationCopy(applicationSchema: string, maximumIndex = Infinity): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "weft-production-migration-"));
  try {
    await mkdir(join(directory, "meta"));
    const entries = journal.entries.filter((entry) => entry.idx <= maximumIndex);
    await writeFile(
      join(directory, "meta", "_journal.json"),
      JSON.stringify({ ...journal, entries }),
    );
    for (const entry of entries) {
      const source = await readFile(join("drizzle", `${entry.tag}.sql`), "utf8");
      const isolated = adaptReviewedPublicReferences(entry.tag, source, applicationSchema);
      await writeFile(join(directory, `${entry.tag}.sql`), isolated);
    }
    return directory;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function adaptReviewedPublicReferences(
  tag: string,
  source: string,
  applicationSchema: string,
): string {
  // Only these reviewed foreign keys need a schema change in temporary test copies.
  const expected = reviewedPublicReferences[tag as keyof typeof reviewedPublicReferences] ?? [];
  const actualCount = source.match(/\bREFERENCES\s+(?:"public"|public)\s*\./gi)?.length ?? 0;
  const expectedCount = expected.reduce((total, reference) => total + reference.count, 0);
  if (actualCount !== expectedCount) {
    throw new Error(`Unexpected public reference count in ${tag}: ${actualCount}`);
  }

  let isolated = source;
  for (const reference of expected) {
    const count = source.split(reference.fragment).length - 1;
    if (count !== reference.count) {
      throw new Error(`Unexpected public reference target in ${tag}: ${reference.fragment}`);
    }
    isolated = isolated.replaceAll(
      reference.fragment,
      reference.fragment.replace('REFERENCES "public".', `REFERENCES "${applicationSchema}".`),
    );
  }
  if (/\bREFERENCES\s+(?:"public"|public)\s*\./i.test(isolated)) {
    throw new Error(`Unadapted public reference in ${tag}`);
  }
  return isolated;
}
