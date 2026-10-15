import { sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_RETENTION_SOURCES,
  createAuditRetentionStore,
} from "../../src/audit/audit-retention-persistence.js";
import type { DatabaseClient } from "../../src/database.js";
import { administrativeOperationFailureAudits } from "../../src/audit/administrative-operation-failure-audit.js";

const cutoff = new Date("2030-04-01T00:00:00.000Z");

describe("audit retention SQL boundary", () => {
  it.each([
    { raw: "2030-01-01 00:00:00.123+00", instant: "2030-01-01T00:00:00.123Z" },
    { raw: "2030-01-01 09:00:00.123456+09", instant: "2030-01-01T00:00:00.123Z" },
    { raw: null, instant: null },
  ])(
    "explicitly decodes aggregate timestamp strings and empty history: %j",
    async ({ raw, instant }) => {
      const query = vi.fn(
        (config: {
          rowMode?: string;
          types: { getTypeParser: (oid: number) => (value: string) => unknown };
        }) => {
          const value = raw === null ? null : config.types.getTypeParser(1184)(raw);
          return Promise.resolve({
            rows: config.rowMode === "array" ? [[value]] : [{ minimum: value }],
          });
        },
      );
      // Exercise installed Drizzle parsing and mapping with the public query boundary, without a DB.
      const database = drizzle({ query } as unknown as Pool);
      const unconverted = await database.execute<{ minimum: string | null }>(
        sql`select min(occurred_at) as minimum from administrative_operation_failure_audits`,
      );
      expect(unconverted.rows[0]?.minimum).toBe(raw);
      const [converted] = await database
        .select({
          minimum:
            sql<Date | null>`min(${administrativeOperationFailureAudits.occurredAt})`.mapWith(
              administrativeOperationFailureAudits.occurredAt,
            ),
        })
        .from(administrativeOperationFailureAudits);
      expect(converted?.minimum).toEqual(instant === null ? null : new Date(instant));
      if (instant !== null) expect(converted?.minimum?.getTime()).toBe(Date.parse(instant));
    },
  );

  it.each(AUDIT_RETENTION_SOURCES)(
    "compiles one parameterized bounded delete for %s",
    async (source) => {
      const execute = vi.fn((statement: SQL) => {
        expect(statement).toBeDefined();
        return Promise.resolve({ rows: [{ id: "deleted" }] });
      });
      const store = createAuditRetentionStore({ execute } as unknown as DatabaseClient);
      expect(await store.deleteExpiredBatch(source, cutoff, 3)).toBe(1);
      const statement = execute.mock.calls[0]?.[0];
      if (statement === undefined) throw new Error("SQL statement was not issued");
      const compiled = new PgDialect().sqlToQuery(statement);
      expect(compiled.sql).toContain(`delete from "${source}"`);
      expect(compiled.sql).toContain("order by");
      expect(compiled.sql).toContain(" asc, ");
      expect(compiled.sql).toContain(" asc");
      expect(compiled.sql).toContain("returning");
      expect(compiled.sql).not.toMatch(/content|embed|image_url/);
      expect(compiled.params).toEqual([cutoff, 3]);
      expect(compiled.sql).toContain("< $1");
      expect(compiled.sql).toContain("limit $2");
    },
  );

  it("rejects invalid input before querying", async () => {
    const execute = vi.fn(() => Promise.resolve({ rows: [] }));
    const store = createAuditRetentionStore({ execute } as unknown as DatabaseClient);
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(store.deleteExpiredBatch("thread_audits", cutoff, limit)).rejects.toThrow(
        RangeError,
      );
    }
    await expect(store.deleteExpiredBatch("thread_audits", new Date(NaN), 1)).rejects.toThrow(
      RangeError,
    );
    expect(execute).not.toHaveBeenCalled();
  });
});
