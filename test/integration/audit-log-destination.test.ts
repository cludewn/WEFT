import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import {
  auditLogDestinationAudits,
  createAuditLogDestinationStore,
  type DestinationChangeInput,
} from "../../src/audit-log-destination-persistence.js";
import { guildSettings } from "../../src/guild-settings.js";

const database = createDatabase(loadTestDatabaseConfig());
const store = createAuditLogDestinationStore(database.client);
const prefix = `audit-dest-${randomUUID()}`;
const guildIds: string[] = [];
const guild = () => {
  const id = `${prefix}-${guildIds.length}`;
  guildIds.push(id);
  return id;
};
const change = (
  guildId: string,
  newChannelId: string | null,
  actorUserId = "actor",
): DestinationChangeInput => ({
  guildId,
  actorUserId,
  newChannelId,
  auditId: randomUUID(),
  occurredAt: new Date(),
});

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  if (guildIds.length > 0) {
    await database.client
      .delete(auditLogDestinationAudits)
      .where(inArray(auditLogDestinationAudits.guildId, guildIds));
    await database.client.delete(guildSettings).where(inArray(guildSettings.guildId, guildIds));
  }
  await database.close();
});

describe("audit log destination persistence", () => {
  it("projects absent and new settings rows as disabled without inserting on read", async () => {
    const id = guild();
    await expect(store.read(id)).resolves.toBeNull();
    expect(
      await database.client.select().from(guildSettings).where(eq(guildSettings.guildId, id)),
    ).toEqual([]);
    await database.client.insert(guildSettings).values({ guildId: id });
    await expect(store.read(id)).resolves.toBeNull();
  });

  it("commits enable, change and disable with exact historical audits", async () => {
    const id = guild();
    const first = change(id, "A");
    const second = change(id, "B");
    const third = change(id, null);
    expect(await store.change(first)).toEqual({ outcome: "CHANGED", previousChannelId: null });
    expect(await store.change(second)).toEqual({ outcome: "CHANGED", previousChannelId: "A" });
    expect(await store.change(third)).toEqual({ outcome: "CHANGED", previousChannelId: "B" });
    const audits = await database.client
      .select()
      .from(auditLogDestinationAudits)
      .where(eq(auditLogDestinationAudits.guildId, id));
    expect(audits.map((row) => [row.previousChannelId, row.newChannelId])).toEqual([
      [null, "A"],
      ["A", "B"],
      ["B", null],
    ]);
    expect(audits.map((row) => row.outcome)).toEqual(["SUCCESS", "SUCCESS", "SUCCESS"]);
    const [settings] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(settings?.auditLogChannelId).toBeNull();
    expect(settings?.updatedAt).toEqual(third.occurredAt);
  });

  it("leaves exact set and disable no-ops completely unchanged", async () => {
    const id = guild();
    const first = change(id, "A");
    await store.change(first);
    const [before] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(await store.change(change(id, "A"))).toEqual({ outcome: "NO_CHANGE" });
    const [after] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toHaveLength(1);
    await store.change(change(id, null));
    const [disabled] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(await store.change(change(id, null))).toEqual({ outcome: "NO_CHANGE" });
    const [stillDisabled] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(stillDisabled?.updatedAt).toEqual(disabled?.updatedAt);
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toHaveLength(2);
  });

  it("does not create a row or audit when disabling an absent guild", async () => {
    const id = guild();
    expect(await store.change(change(id, null))).toEqual({ outcome: "NO_CHANGE" });
    expect(
      await database.client.select().from(guildSettings).where(eq(guildSettings.guildId, id)),
    ).toEqual([]);
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toEqual([]);
  });

  it("rolls back the settings update when the audit insert fails", async () => {
    const id = guild();
    const first = change(id, "A");
    await store.change(first);
    const [before] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    const collision = { ...change(id, "B"), auditId: first.auditId };
    expect(await store.change(collision)).toEqual({ outcome: "UNCONFIRMED" });
    const [after] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(after?.auditLogChannelId).toBe("A");
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  });

  it("serializes contended changes on an existing settings row", async () => {
    const id = guild();
    await store.change(change(id, "A"));
    const first = change(id, "B");
    const second = change(id, "C");
    const results = await forceOverlappingChanges(id, first, second);
    expect(results.map((result) => result.outcome)).toEqual(["CHANGED", "CHANGED"]);

    const audits = await database.client
      .select()
      .from(auditLogDestinationAudits)
      .where(inArray(auditLogDestinationAudits.id, [first.auditId, second.auditId]));
    expect(audits).toHaveLength(2);
    expect(audits.find((audit) => audit.id === first.auditId)).toMatchObject({
      previousChannelId: "A",
      newChannelId: "B",
    });
    expect(audits.find((audit) => audit.id === second.auditId)).toMatchObject({
      previousChannelId: "B",
      newChannelId: "C",
    });
    const [settings] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(settings?.auditLogChannelId).toBe("C");
  }, 30_000);

  it("serializes contended first-time sets from an absent settings row", async () => {
    const id = guild();
    expect(
      await database.client.select().from(guildSettings).where(eq(guildSettings.guildId, id)),
    ).toEqual([]);
    const first = change(id, "B");
    const second = change(id, "C");
    const results = await forceOverlappingChanges(id, first, second);
    expect(results.map((result) => result.outcome)).toEqual(["CHANGED", "CHANGED"]);

    const audits = await database.client
      .select()
      .from(auditLogDestinationAudits)
      .where(inArray(auditLogDestinationAudits.id, [first.auditId, second.auditId]));
    expect(audits).toHaveLength(2);
    expect(audits.find((audit) => audit.id === first.auditId)).toMatchObject({
      previousChannelId: null,
      newChannelId: "B",
    });
    expect(audits.find((audit) => audit.id === second.auditId)).toMatchObject({
      previousChannelId: "B",
      newChannelId: "C",
    });
    expect(audits.filter((audit) => audit.previousChannelId === null)).toHaveLength(1);
    const [settings] = await database.client
      .select()
      .from(guildSettings)
      .where(eq(guildSettings.guildId, id));
    expect(settings?.auditLogChannelId).toBe("C");
  }, 30_000);

  it("confirms a committed result by exact audit even after a later change", async () => {
    const id = guild();
    const input = change(id, "A");
    const ambiguous = Object.create(database.client) as DatabaseClient;
    ambiguous.transaction = async (...args: Parameters<DatabaseClient["transaction"]>) => {
      await database.client.transaction(...args);
      await store.change(change(id, "B"));
      throw new Error("response lost");
    };
    const ambiguousStore = createAuditLogDestinationStore(ambiguous);
    expect(await ambiguousStore.change(input)).toEqual({
      outcome: "CHANGED",
      previousChannelId: null,
    });
    // The confirmation lookup runs after B has already committed.
    expect(await store.read(id)).toBe("B");
    const [audit] = await database.client
      .select()
      .from(auditLogDestinationAudits)
      .where(eq(auditLogDestinationAudits.id, input.auditId));
    expect(audit).toMatchObject({
      previousChannelId: null,
      newChannelId: "A",
      actorUserId: "actor",
    });
  });

  it("reports unconfirmed when a no-op response is lost", async () => {
    const id = guild();
    await store.change(change(id, "A"));
    const ambiguous = Object.create(database.client) as DatabaseClient;
    ambiguous.transaction = async (...args: Parameters<DatabaseClient["transaction"]>) => {
      await database.client.transaction(...args);
      throw new Error("response lost");
    };
    expect(await createAuditLogDestinationStore(ambiguous).change(change(id, "A"))).toEqual({
      outcome: "UNCONFIRMED",
    });
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toHaveLength(1);
  });

  it("does not infer a missing request audit from matching current settings", async () => {
    const id = guild();
    await store.change(change(id, "A"));
    const attempted = change(id, "A");
    const ambiguous = Object.create(database.client) as DatabaseClient;
    ambiguous.transaction = () => Promise.reject(new Error("connection lost before a decision"));
    expect(await createAuditLogDestinationStore(ambiguous).change(attempted)).toEqual({
      outcome: "UNCONFIRMED",
    });
    expect(await store.read(id)).toBe("A");
  });

  it("turns a concurrent identical set into an exact no-op", async () => {
    const id = guild();
    const outcomes = await Promise.all([
      store.change(change(id, "A")),
      store.change(change(id, "A")),
    ]);
    expect(outcomes.map((result) => result.outcome).sort()).toEqual(["CHANGED", "NO_CHANGE"]);
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toHaveLength(1);
  });

  it("enforces transition, outcome and non-empty ID constraints", async () => {
    const id = guild();
    for (const [previous, next] of [
      [null, null],
      ["A", "A"],
      ["", "A"],
      ["A", ""],
    ] as const) {
      await expect(
        database.client.insert(auditLogDestinationAudits).values({
          id: randomUUID(),
          guildId: id,
          actorUserId: "actor",
          previousChannelId: previous,
          newChannelId: next,
          occurredAt: new Date(),
          outcome: "SUCCESS",
        }),
      ).rejects.toThrow();
    }
    await expect(
      database.client.insert(guildSettings).values({ guildId: id, auditLogChannelId: "" }),
    ).rejects.toThrow();
  });
});

/** The audit trigger pauses T1 after its settings row has been established, locked, and updated. */
async function forceOverlappingChanges(
  guildId: string,
  first: DestinationChangeInput,
  second: DestinationChangeInput,
) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const name = `audit_destination_barrier_${suffix}`;
  const firstName = `weft_audit_first_${suffix}`;
  const secondName = `weft_audit_second_${suffix}`;
  const config = loadTestDatabaseConfig();
  const poolOptions = {
    host: config.host,
    port: config.port,
    database: config.name,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: true } : false,
    max: 1,
  } as const;
  const firstPool = new Pool({ ...poolOptions, application_name: firstName });
  const secondPool = new Pool({ ...poolOptions, application_name: secondName });
  const controllerPool = new Pool({
    ...poolOptions,
    application_name: `weft_audit_controller_${suffix}`,
  });
  const firstStore = createAuditLogDestinationStore(
    drizzle(firstPool) as unknown as DatabaseClient,
  );
  const secondStore = createAuditLogDestinationStore(
    drizzle(secondPool) as unknown as DatabaseClient,
  );
  let controller: PoolClient | undefined;
  let barrierHeld = false;
  let firstOperation: ReturnType<typeof firstStore.change> | undefined;
  let secondOperation: ReturnType<typeof secondStore.change> | undefined;
  try {
    // Both identifiers and the guild ID are generated by this test, never supplied by a user.
    await database.client.execute(
      sql.raw(`
      create function "${name}"() returns trigger language plpgsql as $$
      begin
        perform pg_advisory_xact_lock(hashtext(new.guild_id));
        return new;
      end
      $$
    `),
    );
    await database.client.execute(
      sql.raw(`
      create trigger "${name}" before insert on audit_log_destination_audits
      for each row when (new.guild_id = '${guildId}') execute function "${name}"()
    `),
    );
    controller = await controllerPool.connect();
    await controller.query("begin");
    await controller.query("select pg_advisory_xact_lock(hashtext($1))", [guildId]);
    barrierHeld = true;
    const controllerPidResult = await controller.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    const controllerPid = controllerPidResult.rows[0]?.pid;
    if (controllerPid === undefined) throw new Error("Controller backend PID is unavailable");

    firstOperation = firstStore.change(first);
    const firstPid = await waitForBlocker(firstName, controllerPid);
    secondOperation = secondStore.change(second);
    await waitForBlocker(secondName, firstPid);

    await controller.query("commit");
    barrierHeld = false;
    return await Promise.all([firstOperation, secondOperation]);
  } finally {
    try {
      if (barrierHeld) await controller?.query("rollback");
    } finally {
      controller?.release();
      await Promise.allSettled(
        [firstOperation, secondOperation].filter((operation) => operation !== undefined),
      );
      try {
        await database.client.execute(
          sql.raw(`drop trigger if exists "${name}" on audit_log_destination_audits`),
        );
      } finally {
        try {
          await database.client.execute(sql.raw(`drop function if exists "${name}"()`));
        } finally {
          await Promise.all([firstPool.end(), secondPool.end(), controllerPool.end()]);
        }
      }
    }
  }
}

/** Returns this operation's backend PID only after PostgreSQL names the expected blocker. */
async function waitForBlocker(applicationName: string, blockerPid: number): Promise<number> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await database.client.execute(sql`
      select activity.pid
      from pg_stat_activity activity
      where activity.application_name = ${applicationName}
        and ${blockerPid} = any(pg_blocking_pids(activity.pid))
    `);
    const pid = result.rows[0]?.pid;
    if (typeof pid === "number") return pid;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `Expected PostgreSQL blocker relationship was not observed for ${applicationName}`,
  );
}
