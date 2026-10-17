import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseClient } from "../../src/database.js";
import { createScheduledMessageAdministrationStore } from "../../src/messages/scheduled-message-administration-persistence.js";
import { createScheduledMessageStore } from "../../src/messages/scheduled-message-persistence.js";

function fixture(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({
    scheduledActionId: String(index),
    status: "ACTIVE",
    executeAt: new Date("2030-01-01"),
    creatorUserId: "18446744073709551615",
    frequency: index % 2 === 0 ? null : "DAILY",
    weekdayMask: 127,
    localTime: "09:00",
    timezone: "UTC",
    currentOccurrenceStatus: "PENDING",
  }));
  const query = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn((offset: number) => Promise.resolve(rows.slice(offset, offset + 11))),
  };
  const database = {
    select: vi.fn((fields: Record<string, unknown>) => {
      void fields;
      return query;
    }),
  };
  return {
    rows,
    query,
    database,
    combined: createScheduledMessageAdministrationStore(database as unknown as DatabaseClient),
    fallback: createScheduledMessageStore(database as unknown as DatabaseClient),
  };
}
const dialect = new PgDialect();
describe.each(["combined", "fallback"] as const)("%s scheduled list bounded read", (kind) => {
  it.each([0, 1, 10, 11, 20, 21])(
    "returns ten rows with hasNext from the eleventh (%i records)",
    async (count) => {
      const f = fixture(count);
      const read = (offset: number) =>
        kind === "combined"
          ? f.combined.listCombined("guild", "channel", offset)
          : f.fallback.listNonterminal("guild", "channel", offset);
      for (let page = 1; page <= 4; page++) {
        const result = await read((page - 1) * 10);
        if (result.outcome !== "FOUND") throw new Error("Unexpected read failure");
        expect(result.schedules.map((r) => r.scheduledActionId)).toEqual(
          f.rows.slice((page - 1) * 10, page * 10).map((r) => r.scheduledActionId),
        );
        expect(result.hasNext).toBe(count > page * 10);
        expect(result.schedules.length).toBeLessThanOrEqual(10);
        expect(f.query.offset).toHaveBeenLastCalledWith((page - 1) * 10);
        expect(f.query.limit).toHaveBeenLastCalledWith(11);
      }
      if (kind === "combined") {
        const result = await read(0);
        if (result.outcome !== "FOUND") throw new Error("Unexpected failure");
        expect(result.schedules.map((r) => ("kind" in r ? r.kind : undefined))).toEqual(
          f.rows.slice(0, 10).map((r) => (r.frequency === null ? "ONE_TIME" : "RECURRING")),
        );
      }
    },
  );

  it("selects scoped metadata with stable ordering and no mutation or audit boundary", async () => {
    const f = fixture(1);
    if (kind === "combined") await f.combined.listCombined("guild", "channel", 0);
    else await f.fallback.listNonterminal("guild", "channel", 0);
    const fields = Object.keys(f.database.select.mock.calls[0]![0] ?? {});
    for (const key of ["scheduledActionId", "status", "executeAt", "creatorUserId"])
      expect(fields).toContain(key);
    for (const key of fields) expect(key).not.toMatch(/payload|content|embed/i);
    const where = dialect.sqlToQuery(f.query.where.mock.calls[0]![0] as SQL);
    expect(where.params).toEqual(
      expect.arrayContaining(["guild", "channel", "SEND_MESSAGE", "ACTIVE", "EXECUTING"]),
    );
    expect(where.sql).toContain('"guild_id"');
    expect(where.sql).toContain('"target_id"');
    const ordering = f.query.orderBy.mock.calls[0]!.map((sql: SQL) => dialect.sqlToQuery(sql).sql);
    expect(ordering).toEqual([
      '"scheduled_actions"."execute_at" asc',
      '"scheduled_actions"."id" asc',
    ]);
    if (kind === "combined") {
      const join = dialect.sqlToQuery(f.query.leftJoin.mock.calls[1]![1] as SQL);
      expect(join.params).toEqual(["PENDING", "EXECUTING", "RETRY_PENDING"]);
      expect(join.sql).toContain('"recurring_message_occurrences"."scheduled_action_id"');
      expect(f.query.leftJoin).toHaveBeenCalledTimes(2);
    } else expect(where.sql).toContain("not exists");
    // The fake exposes select alone: a mutation or audit call would fail this test.
    expect(f.database.select).toHaveBeenCalledOnce();
  });
});
