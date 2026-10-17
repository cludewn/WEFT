import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { type: string }>;
      checkConstraints: Record<string, { value: string }>;
      indexes: Record<string, { columns: { expression: string }[] }>;
      foreignKeys: Record<string, unknown>;
      uniqueConstraints: Record<string, { columns: string[] }>;
    }
  >;
};
type Journal = { entries: { idx: number; tag: string; when: number; breakpoints: boolean }[] };
describe("append-only administrative failure migration artifacts", () => {
  it("adds only the constrained UUID table and retention index after 0020", async () => {
    const before = JSON.parse(
      await readFile("drizzle/meta/0020_snapshot.json", "utf8"),
    ) as Snapshot;
    const after = JSON.parse(await readFile("drizzle/meta/0021_snapshot.json", "utf8")) as Snapshot;
    expect(after.prevId).toBe(before.id);
    for (const [name, table] of Object.entries(before.tables))
      expect(after.tables[name]).toEqual(table);
    expect(Object.keys(after.tables).filter((name) => !(name in before.tables))).toEqual([
      "public.administrative_operation_failure_audits",
    ]);
    const table = after.tables["public.administrative_operation_failure_audits"]!;
    expect(Object.keys(table.columns)).toHaveLength(11);
    expect(table.columns.id?.type).toBe("uuid");
    expect(table.columns.operation_id?.type).toBe("uuid");
    expect(table.foreignKeys).toEqual({});
    expect(Object.values(table.uniqueConstraints).map((value) => value.columns)).toEqual([
      ["operation_id"],
    ]);
    expect(
      Object.values(table.indexes).map((index) => index.columns.map((column) => column.expression)),
    ).toEqual([["occurred_at", "id"]]);
    expect(Object.keys(table.checkConstraints)).toHaveLength(4);
    expect(table.checkConstraints.administrative_failure_target_check?.value).toContain("is true");
    expect(table.checkConstraints.administrative_failure_stage_check?.value).toContain("is true");
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as Journal;
    expect(journal.entries[20]).toMatchObject({
      idx: 20,
      tag: "0020_mixed_thunderbird",
      when: 1791906263755,
    });
    expect(journal.entries[21]).toMatchObject({ idx: 21, breakpoints: true });
    expect(journal.entries).toHaveLength(24);
    expect(journal.entries[23]).toMatchObject({ idx: 23, tag: "0023_little_thunderbolt" });
    expect(journal.entries[22]).toMatchObject({ idx: 22, breakpoints: true });
    const migration = await readFile(`drizzle/${journal.entries[21]!.tag}.sql`, "utf8");
    expect(migration).not.toMatch(/ALTER|DROP|DELETE|UPDATE|INSERT|REFERENCES/i);
    expect(migration).toContain('UNIQUE("operation_id")');
    expect(migration).toContain('("occurred_at","id")');
  });
});
