import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  AUDIT_RETENTION_SOURCES,
  createAuditRetentionStore,
} from "../../src/audit-retention-persistence.js";
import type { DatabaseClient } from "../../src/database.js";

const cutoff = new Date("2030-04-01T00:00:00.000Z");

describe("audit retention SQL boundary", () => {
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
