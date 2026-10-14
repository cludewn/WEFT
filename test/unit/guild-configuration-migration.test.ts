import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      foreignKeys: Record<string, unknown>;
      indexes: Record<string, { columns: { expression: string }[] }>;
    }
  >;
};
type Journal = {
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

describe("guild configuration migration artifacts", () => {
  it("adds only the new constrained table without changing prior schema snapshots", async () => {
    const before = JSON.parse(
      await readFile("drizzle/meta/0019_snapshot.json", "utf8"),
    ) as Snapshot;
    const after = JSON.parse(await readFile("drizzle/meta/0020_snapshot.json", "utf8")) as Snapshot;
    expect(after.prevId).toBe(before.id);
    for (const [key, table] of Object.entries(before.tables))
      expect(after.tables[key]).toEqual(table);
    expect(Object.keys(after.tables).filter((key) => !(key in before.tables))).toEqual([
      "public.guild_configuration_audits",
    ]);
    const added = after.tables["public.guild_configuration_audits"]!;
    expect(added.foreignKeys).toEqual({});
    expect(
      added.indexes.guild_configuration_audits_retention_idx!.columns.map(
        (column: { expression: string }) => column.expression,
      ),
    ).toEqual(["occurred_at", "id"]);
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
    expect(journal.entries[19]).toEqual({
      idx: 19,
      version: "7",
      when: 1790960743797,
      tag: "0019_wealthy_edwin_jarvis",
      breakpoints: true,
    });
    expect(journal.entries[20]).toMatchObject({ idx: 20, tag: "0020_mixed_thunderbird" });
    expect(journal.entries[20]!.when).toBeGreaterThan(journal.entries[19]!.when);
    const migration = await readFile("drizzle/0020_mixed_thunderbird.sql", "utf8");
    expect(migration).not.toMatch(/ALTER|DROP|DELETE|UPDATE|INSERT|REFERENCES/i);
    expect(migration).toContain("is true");
    expect(migration).toContain("U&'");
  });
});
