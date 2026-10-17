import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<
    string,
    {
      columns: Record<string, { type: string; notNull: boolean }>;
      checkConstraints: Record<string, { value: string }>;
      indexes: Record<string, { columns: { expression: string }[] }>;
      uniqueConstraints: Record<string, { columns: string[] }>;
      foreignKeys: Record<string, unknown>;
    }
  >;
};

describe("managed execution append-only migration artifacts", () => {
  it("adds only the focused failure/partial table after unmodified 0021", async () => {
    const previous = JSON.parse(
      await readFile("drizzle/meta/0021_snapshot.json", "utf8"),
    ) as Snapshot;
    const current = JSON.parse(
      await readFile("drizzle/meta/0022_snapshot.json", "utf8"),
    ) as Snapshot;
    expect(current.prevId).toBe(previous.id);
    for (const [name, table] of Object.entries(previous.tables))
      expect(current.tables[name], name).toEqual(table);
    expect(Object.keys(current.tables).filter((name) => !(name in previous.tables))).toEqual([
      "public.managed_message_execution_failure_audits",
    ]);
    const table = current.tables["public.managed_message_execution_failure_audits"]!;
    expect(Object.keys(table.columns)).toHaveLength(19);
    expect(table.columns.id?.type).toBe("uuid");
    expect(table.columns.operation_id).toMatchObject({ type: "uuid", notNull: true });
    expect(table.columns.message_id?.notNull).toBe(false);
    expect(table.columns.discord_effect_at?.notNull).toBe(false);
    expect(table.foreignKeys).toEqual({});
    expect(Object.values(table.uniqueConstraints).map((value) => value.columns)).toEqual([
      ["operation_id"],
    ]);
    expect(
      Object.values(table.indexes).map((value) => value.columns.map((column) => column.expression)),
    ).toEqual([["occurred_at", "id"]]);
    expect(Object.keys(table.checkConstraints)).toHaveLength(5);
    for (const name of ["identity", "database", "effect", "stage"])
      expect(table.checkConstraints[`managed_execution_${name}_check`]?.value).toContain("is true");
    expect(Object.keys(table.columns).join(" ")).not.toMatch(
      /content|embed|payload_json|error|url/,
    );
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
      entries: { idx: number; tag: string; when: number }[];
    };
    expect(journal.entries).toHaveLength(24);
    expect(journal.entries[23]).toMatchObject({ idx: 23, tag: "0023_little_thunderbolt" });
    expect(journal.entries[21]).toMatchObject({
      idx: 21,
      tag: "0021_parallel_revanche",
      when: 1791959140902,
    });
    expect(journal.entries[22]?.idx).toBe(22);
    const sql = await readFile(`drizzle/${journal.entries[22]!.tag}.sql`, "utf8");
    expect(sql).toContain('UNIQUE("operation_id")');
    expect(sql).toContain('("occurred_at","id")');
    expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE FROM|UPDATE|INSERT INTO|REFERENCES)\b/i);
  });
});
