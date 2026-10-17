import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, { checkConstraints: Record<string, { name: string; value: string }> }>;
};

describe("prefix-free migration artifacts", () => {
  it("connects 0023 to 0022 and changes only the two approved CHECKs", async () => {
    const before = JSON.parse(
      await readFile("drizzle/meta/0022_snapshot.json", "utf8"),
    ) as Snapshot;
    const after = JSON.parse(await readFile("drizzle/meta/0023_snapshot.json", "utf8")) as Snapshot;
    expect(after.prevId).toBe(before.id);
    const expected = structuredClone(before.tables);
    delete expected["public.managed_threads"]!.checkConstraints
      .managed_threads_applied_prefix_check;
    const transition =
      expected["public.guild_configuration_audits"]!.checkConstraints
        .guild_configuration_audits_transition_check!;
    expect(transition.value.match(/between 1 and 20/g)).toHaveLength(2);
    transition.value = transition.value.replaceAll("between 1 and 20", "between 0 and 20");
    expect(after.tables).toEqual(expected);

    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
      entries: { idx: number; tag: string; when: number; version: string; breakpoints: boolean }[];
    };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 23,
      version: "7",
      tag: "0023_little_thunderbolt",
      breakpoints: true,
    });
    expect(journal.entries.at(-1)!.when).toBeGreaterThan(journal.entries[22]!.when);
    const migration = await readFile("drizzle/0023_little_thunderbolt.sql", "utf8");
    const statements = migration.split("--> statement-breakpoint");
    expect(statements).toHaveLength(3);
    expect(statements[0]!.trim()).toBe(
      'ALTER TABLE "guild_configuration_audits" DROP CONSTRAINT "guild_configuration_audits_transition_check";',
    );
    expect(statements[1]!.trim()).toBe(
      'ALTER TABLE "managed_threads" DROP CONSTRAINT "managed_threads_applied_prefix_check";',
    );
    expect(statements[2]!.trim()).toBe(
      `ALTER TABLE "guild_configuration_audits" ADD CONSTRAINT "guild_configuration_audits_transition_check" CHECK (${transition.value});`,
    );
    expect(migration).not.toMatch(/UPDATE|INSERT|DELETE|BACKFILL|ALTER COLUMN|CREATE TABLE/i);
  });
});
