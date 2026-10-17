import type { AuditNotificationPublisher } from "../../src/audit/audit-notification-dispatcher.js";
import { ChannelType, type ChatInputCommandInteraction } from "discord.js";
import { handleConfigCommand } from "../../src/guild/config-command.js";
import { handleThreadCommand } from "../../src/threads/thread-command.js";
import { createAutomaticCloseConfigurationService } from "../../src/threads/automatic-close-configuration.js";
import { createAutomaticCloseThreadMaintenanceService } from "../../src/threads/automatic-close-thread-maintenance.js";
import type { ThreadLifecycleService } from "../../src/threads/thread-lifecycle.js";
import type { ScheduledThreadCloseCommandService } from "../../src/threads/scheduled-thread-close-command.js";
import { randomUUID } from "node:crypto";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild/guild-settings.js";
import {
  autoCloseParentChannels,
  autoCloseThreadActivity,
  autoCloseThreadExclusions,
  createAutomaticClosePersistenceStore,
} from "../../src/threads/automatic-close-persistence.js";
import {
  automaticClosePolicyLockKey,
  configurationAudit,
  createConfigurationAuditContext,
  guildConfigurationAudits,
  type GuildConfigurationAudit,
  type GuildConfigurationAuditContext,
} from "../../src/guild/guild-configuration-audit.js";
import {
  createAuditLogDestinationStore,
  auditLogDestinationAudits,
} from "../../src/audit/audit-log-destination-persistence.js";
import {
  createLinkPreviewStore,
  linkPreviewAudits,
} from "../../src/link-previews/link-preview-persistence.js";
import { createAuditNotificationProjection } from "../../src/audit/audit-notification-projection.js";
import { createAuditRetentionStore } from "../../src/audit/audit-retention-persistence.js";
import { formatAuditNotification } from "../../src/audit/audit-notification-format.js";

const config = loadTestDatabaseConfig();
const database = createDatabase(config);
const controllerPool = new Pool({
  host: config.host,
  port: config.port,
  database: config.name,
  user: config.user,
  password: config.password,
  ssl: config.ssl ? { rejectUnauthorized: true } : false,
  max: 1,
  application_name: "weft-configuration-audit-test-controller",
});
const settings = createGuildSettingsStore(database.client);
const policy = createAutomaticClosePersistenceStore(database.client);
const ids: string[] = [];
const guild = () => {
  const id = randomUUID();
  ids.push(id);
  return id;
};
const context = (actor = "actor") => createConfigurationAuditContext(actor);
const parentInput = (guildId: string, activeThreadIds: string[] = [], audit = context()) => ({
  guildId,
  parentChannelId: "parent",
  activeThreadIds,
  enabledAt: audit.occurredAt,
  ...audit,
});
const trackInput = (guildId: string, audit = context()) => ({
  guildId,
  threadId: "thread",
  parentChannelId: "parent",
  trackedAt: audit.occurredAt,
  ...audit,
});
const history = (guildId: string) =>
  database.client
    .select()
    .from(guildConfigurationAudits)
    .where(eq(guildConfigurationAudits.guildId, guildId));
const state = async (guildId: string) => ({
  settings: await database.client
    .select()
    .from(guildSettings)
    .where(eq(guildSettings.guildId, guildId)),
  parents: await database.client
    .select()
    .from(autoCloseParentChannels)
    .where(eq(autoCloseParentChannels.guildId, guildId)),
  exclusions: await database.client
    .select()
    .from(autoCloseThreadExclusions)
    .where(eq(autoCloseThreadExclusions.guildId, guildId)),
  activity: await database.client
    .select()
    .from(autoCloseThreadActivity)
    .where(eq(autoCloseThreadActivity.guildId, guildId))
    .orderBy(asc(autoCloseThreadActivity.threadId)),
});

beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  if (ids.length) {
    for (const table of [
      guildConfigurationAudits,
      auditLogDestinationAudits,
      linkPreviewAudits,
      autoCloseParentChannels,
      autoCloseThreadExclusions,
      autoCloseThreadActivity,
      guildSettings,
    ])
      await database.client.delete(table).where(inArray(table.guildId, ids));
  }
  await controllerPool.end();
  await database.close();
});

function lostResponse(afterCommit?: () => Promise<unknown>): DatabaseClient {
  const ambiguous = Object.create(database.client) as DatabaseClient;
  ambiguous.transaction = async (...args: Parameters<DatabaseClient["transaction"]>) => {
    await database.client.transaction(...args);
    await afterCommit?.();
    throw new Error("transaction response lost");
  };
  return ambiguous;
}

// Each observed operation uses its own transaction connection. The controller holds a real
// PostgreSQL lock, and tests observe pg_blocking_pids before allowing the competing operations.
function observed<T>(run: (client: DatabaseClient) => Promise<T>) {
  let started!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    started = resolve;
  });
  const client = Object.create(database.client) as DatabaseClient;
  client.transaction = async (callback, options) =>
    database.client.transaction(async (tx) => {
      const response = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      started(response.rows[0]!.pid);
      return callback(tx);
    }, options);
  const promise = run(client);
  void promise.catch(() => undefined);
  return { promise, pid };
}
async function blocked(controller: PoolClient, pid: Promise<number>) {
  const value = await pid;
  await vi.waitFor(
    async () => {
      const result = await controller.query<{ blocking: number[] }>(
        "select pg_blocking_pids($1) as blocking",
        [value],
      );
      expect(result.rows[0]!.blocking.length).toBeGreaterThan(0);
    },
    { timeout: 5000, interval: 10 },
  );
}
async function hold(
  guildId: string,
  kind: "settings" | "policy",
  test: (controller: PoolClient, release: () => Promise<void>) => Promise<void>,
) {
  const controller = await controllerPool.connect();
  let released = false;
  const release = async () => {
    if (!released) {
      await controller.query("commit");
      released = true;
    }
  };
  try {
    await controller.query("begin");
    if (kind === "policy")
      await controller.query("select pg_advisory_xact_lock($1::bigint)", [
        automaticClosePolicyLockKey(guildId),
      ]);
    else
      await controller.query("select guild_id from guild_settings where guild_id = $1 for update", [
        guildId,
      ]);
    await test(controller, release);
  } finally {
    if (!released) await controller.query("rollback");
    controller.release();
  }
}

const scalarCases = [
  {
    method: "setTimezone",
    value: " Asia/Tokyo ",
    settingType: "TIMEZONE",
    before: "UTC",
    after: "Asia/Tokyo",
    pair: "text",
    noOp: "asia/tokyo",
  },
  {
    method: "setClosedPrefix",
    value: " [DONE] ",
    settingType: "CLOSED_PREFIX",
    before: "[CLOSED]",
    after: "[DONE]",
    pair: "text",
    noOp: " [DONE] ",
  },
  {
    method: "setAutoCloseInactivitySeconds",
    value: 3600,
    settingType: "AUTO_CLOSE_INACTIVITY",
    before: 604800,
    after: 3600,
    pair: "integer",
    noOp: 3600,
  },
  {
    method: "setAutoCloseBotMessagesCountAsActivity",
    value: true,
    settingType: "AUTO_CLOSE_BOT_MESSAGES",
    before: false,
    after: true,
    pair: "boolean",
    noOp: true,
  },
] as const;
type ScalarMethod = (typeof scalarCases)[number]["method"];
const scalar = (
  client: DatabaseClient,
  method: ScalarMethod,
  id: string,
  value: string | number | boolean,
  audit: GuildConfigurationAuditContext,
) => {
  const store = createGuildSettingsStore(client);
  return (
    store[method] as (
      g: string,
      v: typeof value,
      a: GuildConfigurationAuditContext,
    ) => ReturnType<typeof store.setTimezone>
  )(id, value, audit);
};

describe("guild configuration success audits", () => {
  it.each(scalarCases)(
    "persists exact $settingType and normalized no-op without timestamp churn",
    async (test) => {
      const id = guild();
      const audit = context("scalar-actor");
      expect((await scalar(database.client, test.method, id, test.value, audit)).outcome).toBe(
        "CHANGED",
      );
      const values =
        test.pair === "text"
          ? { previousText: test.before as string, newText: test.after as string }
          : test.pair === "integer"
            ? { previousInteger: test.before as number, newInteger: test.after as number }
            : { previousBoolean: test.before as boolean, newBoolean: test.after as boolean };
      expect(await history(id)).toEqual([
        configurationAudit(audit, id, {
          action: "SET",
          settingType: test.settingType,
          targetType: "GUILD",
          targetId: id,
          ...values,
        }),
      ]);
      const before = await state(id);
      expect((await scalar(database.client, test.method, id, test.noOp, context())).outcome).toBe(
        "NO_CHANGE",
      );
      expect(await state(id)).toEqual(before);
      expect(await history(id)).toHaveLength(1);
      const other = guild();
      expect(await history(other)).toEqual([]);
      expect((await state(other)).settings).toEqual([]);
    },
  );
  it("records add/remove and untrack/track transitions with exact actor and target", async () => {
    const id = guild();
    const add = parentInput(id);
    const untrack = context("untrack-actor");
    const track = trackInput(id, context("track-actor"));
    const remove = context("remove-actor");
    expect(await policy.enableParentChannelWithBaselines(add)).toEqual({
      outcome: "ENABLED",
      baselinesApplied: 0,
    });
    expect(await policy.addThreadExclusion(id, "thread", untrack)).toEqual({ outcome: "CHANGED" });
    expect(await policy.trackThread(track)).toEqual({
      outcome: "CHANGED",
      exclusionRemoved: true,
      parentEnabled: true,
    });
    expect(await policy.removeParentChannel(id, "parent", remove)).toEqual({ outcome: "CHANGED" });
    expect(await history(id)).toEqual(
      expect.arrayContaining([
        configurationAudit(add, id, {
          action: "ADD",
          settingType: "AUTO_CLOSE_PARENT",
          targetType: "PARENT_CHANNEL",
          targetId: "parent",
          previousBoolean: false,
          newBoolean: true,
        }),
        configurationAudit(untrack, id, {
          action: "UNTRACK",
          settingType: "THREAD_EXCLUSION",
          targetType: "THREAD",
          targetId: "thread",
          previousBoolean: false,
          newBoolean: true,
        }),
        configurationAudit(track, id, {
          action: "TRACK",
          settingType: "THREAD_EXCLUSION",
          targetType: "THREAD",
          targetId: "thread",
          previousBoolean: true,
          newBoolean: false,
        }),
        configurationAudit(remove, id, {
          action: "REMOVE",
          settingType: "AUTO_CLOSE_PARENT",
          targetType: "PARENT_CHANNEL",
          targetId: "parent",
          previousBoolean: true,
          newBoolean: false,
        }),
      ]),
    );
    expect(await history(id)).toHaveLength(4);
    expect((await state(id)).activity[0]?.lastActivityAt).toEqual(track.trackedAt);
  });
  it("keeps parent re-add/remove and repeated untrack no-ops out of history", async () => {
    const id = guild();
    await policy.enableParentChannelWithBaselines(parentInput(id));
    const before = await state(id);
    expect(await policy.enableParentChannelWithBaselines(parentInput(id, ["new-thread"]))).toEqual({
      outcome: "ALREADY_ENABLED",
    });
    expect(await state(id)).toEqual(before);
    await policy.removeParentChannel(id, "parent", context());
    expect(await policy.removeParentChannel(id, "parent", context())).toEqual({
      outcome: "NO_CHANGE",
    });
    await policy.addThreadExclusion(id, "thread", context());
    const excluded = await state(id);
    expect(await policy.addThreadExclusion(id, "thread", context())).toEqual({
      outcome: "NO_CHANGE",
    });
    expect(await state(id)).toEqual(excluded);
    expect(await history(id)).toHaveLength(3);
  });
  it("deduplicates baselines, excludes opted-out threads and preserves equal/newer activity exactly", async () => {
    const id = guild();
    const enableAt = new Date("2030-01-02T00:00:00Z");
    const older = new Date(enableAt.getTime() - 1),
      newer = new Date(enableAt.getTime() + 1);
    await database.client.insert(autoCloseThreadActivity).values([
      { guildId: id, threadId: "old", parentChannelId: "old-parent", lastActivityAt: older },
      { guildId: id, threadId: "equal", parentChannelId: "old-parent", lastActivityAt: enableAt },
      { guildId: id, threadId: "newer", parentChannelId: "old-parent", lastActivityAt: newer },
    ]);
    await policy.addThreadExclusion(id, "excluded", context());
    const before = (await state(id)).activity;
    const input = {
      ...parentInput(id, ["newer", "missing", "old", "equal", "missing", "excluded"]),
      enabledAt: enableAt,
    };
    expect(await policy.enableParentChannelWithBaselines(input)).toEqual({
      outcome: "ENABLED",
      baselinesApplied: 2,
    });
    const after = (await state(id)).activity;
    for (const name of ["equal", "newer"])
      expect(after.find((r) => r.threadId === name)).toEqual(
        before.find((r) => r.threadId === name),
      );
    for (const name of ["old", "missing"])
      expect(after.find((r) => r.threadId === name)).toMatchObject({
        parentChannelId: "parent",
        lastActivityAt: enableAt,
      });
    expect(after.find((r) => r.threadId === "excluded")).toBeUndefined();
    expect((await history(id)).filter((r) => r.action === "ADD")).toHaveLength(1);
    await policy.removeParentChannel(id, "parent", context());
    expect((await state(id)).activity).toEqual(after);
  });
  it("keeps repeated-track missing-only repair separate from policy changes", async () => {
    const id = guild();
    await policy.enableParentChannelWithBaselines(parentInput(id));
    const input = trackInput(id);
    expect(await policy.trackThread(input)).toEqual({
      outcome: "NO_CHANGE",
      exclusionRemoved: false,
      parentEnabled: true,
    });
    const repaired = await state(id);
    expect(repaired.activity[0]?.lastActivityAt).toEqual(input.trackedAt);
    expect((await policy.trackThread(trackInput(id))).outcome).toBe("NO_CHANGE");
    expect(await state(id)).toEqual(repaired);
    expect(await history(id)).toHaveLength(1);
    const disabled = guild();
    await policy.addThreadExclusion(disabled, "thread", context());
    expect(await policy.trackThread(trackInput(disabled))).toEqual({
      outcome: "CHANGED",
      exclusionRemoved: true,
      parentEnabled: false,
    });
    expect((await state(disabled)).activity).toEqual([]);
    expect(await history(disabled)).toHaveLength(2);
  });
  it.each(["older", "equal", "newer"] as const)(
    "applies track floor safely to %s activity",
    async (age) => {
      const id = guild();
      await policy.enableParentChannelWithBaselines(parentInput(id));
      const input = trackInput(id);
      const last = new Date(
        input.trackedAt.getTime() + (age === "older" ? -1 : age === "newer" ? 1 : 0),
      );
      await database.client.insert(autoCloseThreadActivity).values({
        guildId: id,
        threadId: "thread",
        parentChannelId: "old-parent",
        lastActivityAt: last,
      });
      await policy.addThreadExclusion(id, "thread", context());
      const before = await state(id);
      await policy.trackThread(input);
      const after = await state(id);
      if (age === "older")
        expect(after.activity[0]).toMatchObject({
          parentChannelId: "parent",
          lastActivityAt: input.trackedAt,
        });
      else expect(after.activity).toEqual(before.activity);
    },
  );
});

describe("atomic rollback and historical confirmation", () => {
  it.each(scalarCases)(
    "rolls back $settingType and updated_at if audit insert fails",
    async (test) => {
      const id = guild();
      await settings.getOrCreate(id);
      const seed = context();
      await settings.setClosedPrefix(id, "[SEED]", seed);
      const before = await state(id);
      expect(
        await scalar(database.client, test.method, id, test.value, {
          ...context(),
          auditId: seed.auditId,
        }),
      ).toEqual({ outcome: "UNCONFIRMED" });
      expect(await state(id)).toEqual(before);
      expect(await history(id)).toHaveLength(1);
    },
  );
  it.each(["parent-add", "parent-remove", "track", "untrack"] as const)(
    "rolls back all %s effects if audit insert fails",
    async (operation) => {
      const id = guild();
      const seed = context();
      await settings.setClosedPrefix(id, "[SEED]", seed);
      if (operation === "parent-remove" || operation === "track")
        await policy.enableParentChannelWithBaselines(parentInput(id));
      if (operation === "track") await policy.addThreadExclusion(id, "thread", context());
      const before = await state(id);
      const audit = { ...context(), auditId: seed.auditId };
      const result =
        operation === "parent-add"
          ? await policy.enableParentChannelWithBaselines(parentInput(id, ["thread"], audit))
          : operation === "parent-remove"
            ? await policy.removeParentChannel(id, "parent", audit)
            : operation === "track"
              ? await policy.trackThread(trackInput(id, audit))
              : await policy.addThreadExclusion(id, "thread", audit);
      expect(result).toEqual({ outcome: "UNCONFIRMED" });
      expect(await state(id)).toEqual(before);
    },
  );
  it("rolls back first settings establishment with parent and baseline when actor is invalid", async () => {
    const id = guild();
    expect(
      await policy.enableParentChannelWithBaselines(parentInput(id, ["thread"], context(""))),
    ).toEqual({ outcome: "UNCONFIRMED" });
    expect(await state(id)).toEqual({ settings: [], parents: [], exclusions: [], activity: [] });
    expect(await history(id)).toEqual([]);
  });
  it.each(scalarCases)(
    "confirms $settingType response loss after a later setting change",
    async (test) => {
      const id = guild();
      const audit = context();
      const result = await scalar(
        lostResponse(async () => {
          await settings.setClosedPrefix(id, "[LATER]", context());
        }),
        test.method,
        id,
        test.value,
        audit,
      );
      expect(result.outcome).toBe("CHANGED");
      expect((await history(id)).some((r) => r.id === audit.auditId)).toBe(true);
      expect((await state(id)).settings[0]?.closedPrefix).toBe("[LATER]");
    },
  );
  it.each(["parent-add", "parent-remove", "track", "untrack"] as const)(
    "confirms exact %s transaction after response loss",
    async (operation) => {
      const id = guild();
      if (operation === "parent-remove" || operation === "track")
        await policy.enableParentChannelWithBaselines(parentInput(id));
      if (operation === "track") await policy.addThreadExclusion(id, "thread", context());
      const store = createAutomaticClosePersistenceStore(
        lostResponse(async () => {
          if (operation === "parent-add") await policy.removeParentChannel(id, "parent", context());
          else if (operation === "parent-remove")
            await policy.enableParentChannelWithBaselines(parentInput(id));
          else if (operation === "track") await policy.addThreadExclusion(id, "thread", context());
          else await policy.trackThread(trackInput(id));
        }),
      );
      const result =
        operation === "parent-add"
          ? await store.enableParentChannelWithBaselines(parentInput(id, ["thread"]))
          : operation === "parent-remove"
            ? await store.removeParentChannel(id, "parent", context())
            : operation === "track"
              ? await store.trackThread(trackInput(id))
              : await store.addThreadExclusion(id, "thread", context());
      expect(result.outcome).toBe(operation === "parent-add" ? "ENABLED" : "CHANGED");
    },
  );
  it.each(["scalar", "parent", "track", "untrack", "remove"] as const)(
    "returns UNCONFIRMED for lost %s no-op/baseline-only repair",
    async (operation) => {
      const id = guild();
      await policy.enableParentChannelWithBaselines(parentInput(id));
      if (operation === "untrack") await policy.addThreadExclusion(id, "thread", context());
      const original = await history(id);
      const ambiguous = lostResponse();
      const store = createAutomaticClosePersistenceStore(ambiguous);
      const result =
        operation === "scalar"
          ? await createGuildSettingsStore(ambiguous).setTimezone(id, "UTC", context())
          : operation === "parent"
            ? await store.enableParentChannelWithBaselines(parentInput(id))
            : operation === "track"
              ? await store.trackThread(trackInput(id))
              : operation === "untrack"
                ? await store.addThreadExclusion(id, "thread", context())
                : await store.removeParentChannel(id, "absent", context());
      expect(result).toEqual({ outcome: "UNCONFIRMED" });
      expect(await history(id)).toEqual(original);
      if (operation === "track") expect((await state(id)).activity).toHaveLength(1);
    },
  );
  it.each(["missing", "actor", "time", "before", "null-shape", "read-failure"] as const)(
    "rejects %s evidence despite matching current configuration",
    async (kind) => {
      const id = guild();
      const audit = context();
      const ambiguous = lostResponse(async () => {
        if (kind === "missing")
          await database.client
            .delete(guildConfigurationAudits)
            .where(eq(guildConfigurationAudits.id, audit.auditId));
        if (kind === "actor")
          await database.client
            .update(guildConfigurationAudits)
            .set({ actorUserId: "other" })
            .where(eq(guildConfigurationAudits.id, audit.auditId));
        if (kind === "time")
          await database.client
            .update(guildConfigurationAudits)
            .set({ occurredAt: new Date(audit.occurredAt.getTime() + 1) })
            .where(eq(guildConfigurationAudits.id, audit.auditId));
        if (kind === "before")
          await database.client
            .update(guildConfigurationAudits)
            .set({ previousText: "Europe/Paris" })
            .where(eq(guildConfigurationAudits.id, audit.auditId));
      });
      // Malformed NULL evidence is injected only at the read boundary; PostgreSQL constraints stay enabled.
      if (kind === "null-shape" || kind === "read-failure")
        ambiguous.select = (() => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                if (kind === "read-failure") throw new Error("evidence read unavailable");
                const [row] = await database.client
                  .select()
                  .from(guildConfigurationAudits)
                  .where(eq(guildConfigurationAudits.id, audit.auditId));
                return [{ ...row, previousInteger: 1 }];
              },
            }),
          }),
        })) as unknown as DatabaseClient["select"];
      expect(
        await createGuildSettingsStore(ambiguous).setTimezone(id, "Asia/Tokyo", audit),
      ).toEqual({ outcome: "UNCONFIRMED" });
      expect((await state(id)).settings[0]?.timezone).toBe("Asia/Tokyo");
    },
  );
});

describe("observed PostgreSQL serialization", () => {
  it("serializes conflicting scalar transitions under the settings row lock", async () => {
    const id = guild();
    await settings.getOrCreate(id);
    await hold(id, "settings", async (controller, release) => {
      const a = observed((client) =>
        createGuildSettingsStore(client).setTimezone(id, "Asia/Tokyo", context("first")),
      );
      await blocked(controller, a.pid);
      const b = observed((client) =>
        createGuildSettingsStore(client).setTimezone(id, "Europe/Paris", context("second")),
      );
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).toBe("CHANGED");
      expect((await b.promise).outcome).toBe("CHANGED");
    });
    const audits = await history(id);
    expect(audits.find((r) => r.actorUserId === "first")).toMatchObject({
      previousText: "UTC",
      newText: "Asia/Tokyo",
    });
    expect(audits.find((r) => r.actorUserId === "second")).toMatchObject({
      previousText: "Asia/Tokyo",
      newText: "Europe/Paris",
    });
  });
  it("makes concurrent identical scalar setters one change and one no-op", async () => {
    const id = guild();
    await settings.getOrCreate(id);
    await hold(id, "settings", async (controller, release) => {
      const a = observed((client) =>
        createGuildSettingsStore(client).setClosedPrefix(id, "[DONE]", context()),
      );
      await blocked(controller, a.pid);
      const b = observed((client) =>
        createGuildSettingsStore(client).setClosedPrefix(id, " [DONE] ", context()),
      );
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).toBe("CHANGED");
      expect((await b.promise).outcome).toBe("NO_CHANGE");
    });
    expect(await history(id)).toHaveLength(1);
  });
  it("preserves unrelated scalar, destination and preview columns under contention", async () => {
    const id = guild();
    await settings.getOrCreate(id);
    await hold(id, "settings", async (controller, release) => {
      const operations = [
        observed((client) =>
          createGuildSettingsStore(client).setTimezone(id, "Asia/Tokyo", context()),
        ),
        observed((client) =>
          createGuildSettingsStore(client).setClosedPrefix(id, "[DONE]", context()),
        ),
        observed((client) =>
          createGuildSettingsStore(client).setAutoCloseInactivitySeconds(id, 3600, context()),
        ),
        observed((client) =>
          createGuildSettingsStore(client).setAutoCloseBotMessagesCountAsActivity(
            id,
            true,
            context(),
          ),
        ),
        observed((client) =>
          createAuditLogDestinationStore(client).change({
            guildId: id,
            newChannelId: "destination",
            ...context(),
          }),
        ),
        observed((client) =>
          createLinkPreviewStore(client).change({ guildId: id, newMode: "off", ...context() }),
        ),
      ];
      for (const operation of operations) await blocked(controller, operation.pid);
      await release();
      for (const operation of operations) expect((await operation.promise).outcome).toBe("CHANGED");
    });
    expect((await state(id)).settings[0]).toMatchObject({
      timezone: "Asia/Tokyo",
      closedPrefix: "[DONE]",
      autoCloseInactivitySeconds: 3600,
      autoCloseBotMessagesCountAsActivity: true,
      auditLogChannelId: "destination",
      linkPreviewMode: "off",
    });
    expect(await history(id)).toHaveLength(4);
    expect(
      await database.client
        .select()
        .from(auditLogDestinationAudits)
        .where(eq(auditLogDestinationAudits.guildId, id)),
    ).toHaveLength(1);
    expect(
      await database.client
        .select()
        .from(linkPreviewAudits)
        .where(eq(linkPreviewAudits.guildId, id)),
    ).toHaveLength(1);
  });
  it("serializes add/remove for a previously absent parent", async () => {
    const id = guild();
    await settings.getOrCreate(id);
    await hold(id, "policy", async (controller, release) => {
      const a = observed((client) =>
        createAutomaticClosePersistenceStore(client).enableParentChannelWithBaselines(
          parentInput(id, ["thread"]),
        ),
      );
      await blocked(controller, a.pid);
      const b = observed((client) =>
        createAutomaticClosePersistenceStore(client).removeParentChannel(id, "parent", context()),
      );
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).toBe("ENABLED");
      expect((await b.promise).outcome).toBe("CHANGED");
    });
    expect((await state(id)).parents).toEqual([]);
    expect((await state(id)).activity).toHaveLength(1);
    expect((await history(id)).map((r) => r.action).sort()).toEqual(["ADD", "REMOVE"]);
  });
  it("serializes duplicate first parent additions without duplicate baseline or audit", async () => {
    const id = guild();
    await hold(id, "policy", async (controller, release) => {
      const a = observed((client) =>
        createAutomaticClosePersistenceStore(client).enableParentChannelWithBaselines(
          parentInput(id, ["thread"]),
        ),
      );
      await blocked(controller, a.pid);
      const b = observed((client) =>
        createAutomaticClosePersistenceStore(client).enableParentChannelWithBaselines(
          parentInput(id, ["thread", "extra"]),
        ),
      );
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).toBe("ENABLED");
      expect((await b.promise).outcome).toBe("ALREADY_ENABLED");
    });
    expect((await state(id)).activity).toHaveLength(1);
    expect(await history(id)).toHaveLength(1);
  });
  it.each([
    "parent-before-untrack",
    "untrack-before-parent",
    "track-before-parent",
    "parent-before-track",
  ] as const)("preserves policy and baselines for %s", async (order) => {
    const id = guild();
    await settings.getOrCreate(id);
    if (order.includes("track") && !order.includes("untrack"))
      await policy.addThreadExclusion(id, "thread", context());
    await hold(id, "policy", async (controller, release) => {
      const add = (client: DatabaseClient) =>
        createAutomaticClosePersistenceStore(client).enableParentChannelWithBaselines(
          parentInput(id, ["thread"]),
        );
      const change = (client: DatabaseClient) =>
        order.includes("untrack")
          ? createAutomaticClosePersistenceStore(client).addThreadExclusion(id, "thread", context())
          : createAutomaticClosePersistenceStore(client).trackThread(trackInput(id));
      const a = observed<{ outcome: string }>(order.startsWith("parent") ? add : change);
      await blocked(controller, a.pid);
      const b = observed<{ outcome: string }>(order.startsWith("parent") ? change : add);
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).not.toBe("UNCONFIRMED");
      expect((await b.promise).outcome).not.toBe("UNCONFIRMED");
    });
    const result = await state(id);
    expect(result.parents).toHaveLength(1);
    expect(result.exclusions).toHaveLength(order.includes("untrack") ? 1 : 0);
    expect(result.activity).toHaveLength(order === "untrack-before-parent" ? 0 : 1);
    expect((await history(id)).filter((r) => r.action === "ADD")).toHaveLength(1);
  });
  it.each(["track-first", "untrack-first"] as const)(
    "serializes missing exclusion changes for the same thread (%s)",
    async (order) => {
      const id = guild();
      await policy.enableParentChannelWithBaselines(parentInput(id));
      await hold(id, "policy", async (controller, release) => {
        const track = (client: DatabaseClient) =>
          createAutomaticClosePersistenceStore(client).trackThread(trackInput(id));
        const untrack = (client: DatabaseClient) =>
          createAutomaticClosePersistenceStore(client).addThreadExclusion(id, "thread", context());
        const a = observed(order === "track-first" ? track : untrack);
        await blocked(controller, a.pid);
        const b = observed(order === "track-first" ? untrack : track);
        await blocked(controller, b.pid);
        await release();
        expect((await a.promise).outcome).toBe(order === "track-first" ? "NO_CHANGE" : "CHANGED");
        expect((await b.promise).outcome).toBe("CHANGED");
      });
      expect((await state(id)).exclusions).toHaveLength(order === "track-first" ? 1 : 0);
      expect((await state(id)).activity).toHaveLength(1);
      expect((await history(id)).filter((r) => r.settingType === "THREAD_EXCLUSION")).toHaveLength(
        order === "track-first" ? 1 : 2,
      );
    },
  );
  it("keeps a different guild independent while one guild policy is locked", async () => {
    const id = guild(),
      other = guild();
    await settings.getOrCreate(id);
    await hold(id, "policy", async (controller, release) => {
      const waiting = observed((client) =>
        createAutomaticClosePersistenceStore(client).addThreadExclusion(id, "thread", context()),
      );
      await blocked(controller, waiting.pid);
      const independent = await policy.enableParentChannelWithBaselines(
        parentInput(other, ["thread"]),
      );
      expect(independent.outcome).toBe("ENABLED");
      expect((await state(id)).exclusions).toEqual([]);
      await release();
      expect((await waiting.promise).outcome).toBe("CHANGED");
    });
    expect((await state(other)).exclusions).toEqual([]);
    expect((await state(other)).activity).toHaveLength(1);
  });
  it("orders competing parent and missing-baseline batches in SQL to avoid reverse activity lock order", async () => {
    const id = guild();
    await policy.enableParentChannelWithBaselines(parentInput(id));
    const controller = await controllerPool.connect();
    let a: ReturnType<typeof observed> | undefined,
      b: { promise: Promise<number>; pid: Promise<number> } | undefined;
    try {
      await controller.query("begin");
      await controller.query(
        "insert into auto_close_thread_activity (guild_id, thread_id, parent_channel_id, last_activity_at) values ($1, 'a', 'parent', $2)",
        [id, new Date(0)],
      );
      a = observed((client) =>
        createAutomaticClosePersistenceStore(client).enableParentChannelWithBaselines({
          ...parentInput(id, ["z", "a"]),
          parentChannelId: "second-parent",
        }),
      );
      await blocked(controller, a.pid);
      b = observed((client) =>
        client.transaction((tx) =>
          createAutomaticClosePersistenceStore(
            tx as unknown as DatabaseClient,
          ).initializeMissingActivityBaselines({
            guildId: id,
            baselineAt: new Date(),
            candidates: [
              { threadId: "a", parentChannelId: "parent" },
              { threadId: "z", parentChannelId: "parent" },
            ],
          }),
        ),
      );
      await blocked(controller, b.pid);
      await controller.query("commit");
      expect(((await a.promise) as { outcome: string }).outcome).toBe("ENABLED");
      await b.promise;
      expect((await state(id)).activity).toHaveLength(2);
      expect((await history(id)).filter((r) => r.action === "ADD")).toHaveLength(2);
    } finally {
      await controller.query("rollback");
      controller.release();
      await Promise.allSettled([a?.promise, b?.promise]);
    }
  });
});

// Every valid branch is exercised against deliberate UNKNOWN, wrong value-pair, same-value,
// target and action mutations. PostgreSQL constraints remain enabled throughout these tests.
describe("typed audit database constraints", () => {
  const transitions = [
    {
      action: "SET",
      settingType: "TIMEZONE",
      targetType: "GUILD",
      targetId: "guild",
      previousText: "UTC",
      newText: "Asia/Tokyo",
    },
    {
      action: "SET",
      settingType: "CLOSED_PREFIX",
      targetType: "GUILD",
      targetId: "guild",
      previousText: "[CLOSED]",
      newText: "[DONE]",
    },
    {
      action: "SET",
      settingType: "AUTO_CLOSE_INACTIVITY",
      targetType: "GUILD",
      targetId: "guild",
      previousInteger: 604800,
      newInteger: 3600,
    },
    {
      action: "SET",
      settingType: "AUTO_CLOSE_BOT_MESSAGES",
      targetType: "GUILD",
      targetId: "guild",
      previousBoolean: false,
      newBoolean: true,
    },
    {
      action: "ADD",
      settingType: "AUTO_CLOSE_PARENT",
      targetType: "PARENT_CHANNEL",
      targetId: "parent",
      previousBoolean: false,
      newBoolean: true,
    },
    {
      action: "REMOVE",
      settingType: "AUTO_CLOSE_PARENT",
      targetType: "PARENT_CHANNEL",
      targetId: "parent",
      previousBoolean: true,
      newBoolean: false,
    },
    {
      action: "TRACK",
      settingType: "THREAD_EXCLUSION",
      targetType: "THREAD",
      targetId: "thread",
      previousBoolean: true,
      newBoolean: false,
    },
    {
      action: "UNTRACK",
      settingType: "THREAD_EXCLUSION",
      targetType: "THREAD",
      targetId: "thread",
      previousBoolean: false,
      newBoolean: true,
    },
  ] as const;
  it.each(transitions)(
    "enforces $settingType / $action shape even for NULL UNKNOWN",
    async (transition) => {
      const id = guild();
      const row = configurationAudit(context(), id, {
        ...transition,
        targetId: transition.targetType === "GUILD" ? id : transition.targetId,
      });
      await database.client.insert(guildConfigurationAudits).values(row);
      const used =
        transition.settingType === "TIMEZONE" || transition.settingType === "CLOSED_PREFIX"
          ? ["previousText", "newText"]
          : transition.settingType === "AUTO_CLOSE_INACTIVITY"
            ? ["previousInteger", "newInteger"]
            : ["previousBoolean", "newBoolean"];
      const unused = [
        "previousText",
        "newText",
        "previousInteger",
        "newInteger",
        "previousBoolean",
        "newBoolean",
      ].filter((key) => !used.includes(key));
      const invalid: object[] = [
        { action: "INVALID" },
        { settingType: "INVALID" },
        { targetType: "INVALID" },
        { outcome: "FAILURE" },
        { actorUserId: "" },
        { targetId: "" },
        ...used.map((key) => ({ [key]: null })),
        { [used[1]!]: row[used[0]! as keyof GuildConfigurationAudit] },
        ...unused.map((key) => ({
          [key]: key.includes("Text") ? "unused" : key.includes("Integer") ? 1 : true,
        })),
      ];
      if (transition.targetType === "GUILD") invalid.push({ targetId: "different-guild" });
      if (transition.settingType === "AUTO_CLOSE_INACTIVITY")
        invalid.push({ previousInteger: 299 }, { newInteger: 31536001 });
      if (transition.settingType === "CLOSED_PREFIX")
        invalid.push(
          { newText: "x".repeat(21) },
          { newText: "control\n" },
          { previousText: "\u0085" },
        );
      for (const bad of invalid)
        await expect(
          database.client
            .insert(guildConfigurationAudits)
            .values({ ...row, id: randomUUID(), ...bad }),
        ).rejects.toThrow();
      expect(await history(id)).toHaveLength(1);
    },
  );
});

describe("notification and retention integration", () => {
  it("publishes confirmed changes only, preserving commits when notification fails", async () => {
    const id = guild();
    const publish = vi.fn<AuditNotificationPublisher["publish"]>();
    const s = createGuildSettingsStore(database.client, { publish });
    const p = createAutomaticClosePersistenceStore(database.client, { publish });
    await s.setClosedPrefix(id, "[PRIVATE]", context());
    await s.setClosedPrefix(id, " [PRIVATE] ", context());
    await p.enableParentChannelWithBaselines(parentInput(id));
    await p.trackThread(trackInput(id));
    const audit = context();
    await p.addThreadExclusion(id, "thread", audit);
    await p.addThreadExclusion(id, "thread", context());
    await p.removeParentChannel(id, "parent", { ...context(), auditId: audit.auditId });
    expect(publish).toHaveBeenCalledTimes(3);
    publish.mockImplementation(() => {
      throw new Error("notification rejected");
    });
    expect((await s.setTimezone(id, "Asia/Tokyo", context())).outcome).toBe("CHANGED");
    expect((await state(id)).settings[0]?.timezone).toBe("Asia/Tokyo");
    expect(await history(id)).toHaveLength(4);
    const record = await createAuditNotificationProjection(database.client).load(
      publish.mock.calls[0]![0],
    );
    expect(record).toMatchObject({
      source: "GUILD_CONFIGURATION",
      actorType: "USER",
      settingType: "CLOSED_PREFIX",
      targetType: "GUILD",
      targetId: id,
    });
    expect(Object.keys(record!)).not.toContain("previousText");
    expect(Object.keys(record!)).not.toContain("newText");
    const output = formatAuditNotification(record!);
    expect(output?.content).not.toContain("PRIVATE");
    expect(output?.content).not.toContain("[CLOSED]");
  });
  it("deletes bounded timestamp/id ordered history strictly before cutoff and preserves policy state", async () => {
    const id = guild();
    await policy.enableParentChannelWithBaselines(parentInput(id, ["thread"]));
    await policy.addThreadExclusion(id, "thread", context());
    const before = await state(id);
    // Place fixtures before all existing history so this global retention store cannot delete
    // another test's rows even on a database containing interrupted test runs.
    const [earliest] = await database.client
      .select({ at: guildConfigurationAudits.occurredAt })
      .from(guildConfigurationAudits)
      .orderBy(asc(guildConfigurationAudits.occurredAt))
      .limit(1);
    const cutoff = new Date(Math.min(Date.parse("2000-01-01"), earliest!.at.getTime() - 1));
    const old = new Date(cutoff.getTime() - 1);
    const rows = Array.from({ length: 502 }, (_, n) =>
      configurationAudit(
        { ...context(), auditId: `${id}-${String(n).padStart(4, "0")}`, occurredAt: old },
        id,
        {
          action: "SET",
          settingType: "TIMEZONE",
          targetType: "GUILD",
          targetId: id,
          previousText: "UTC",
          newText: "Asia/Tokyo",
        },
      ),
    );
    const equal = configurationAudit({ ...context(), occurredAt: cutoff }, id, {
      action: "SET",
      settingType: "TIMEZONE",
      targetType: "GUILD",
      targetId: id,
      previousText: "UTC",
      newText: "Asia/Tokyo",
    });
    await database.client.insert(guildConfigurationAudits).values([...rows, equal]);
    const retention = createAuditRetentionStore(database.client);
    expect(await retention.deleteExpiredBatch("guild_configuration_audits", cutoff, 500)).toBe(500);
    const remaining = await history(id);
    expect(
      remaining
        .filter((r) => r.occurredAt.getTime() === old.getTime())
        .map((r) => r.id)
        .sort(),
    ).toEqual(rows.slice(500).map((r) => r.id));
    expect(await retention.deleteExpiredBatch("guild_configuration_audits", cutoff, 500)).toBe(2);
    expect(await retention.deleteExpiredBatch("guild_configuration_audits", cutoff, 500)).toBe(0);
    expect((await history(id)).some((r) => r.id === equal.id)).toBe(true);
    expect(await state(id)).toEqual(before);
  });
});

describe("committed history survives Discord interaction failure", () => {
  it.each([
    [null, "timezone", "Asia/Tokyo", "TIMEZONE"],
    ["closed-prefix", "set", "[DONE]", "CLOSED_PREFIX"],
    ["closed-prefix", "disable", "", "CLOSED_PREFIX"],
    ["auto-close", "inactivity", "12h", "AUTO_CLOSE_INACTIVITY"],
    ["auto-close", "bot-messages", "", "AUTO_CLOSE_BOT_MESSAGES"],
    ["auto-close", "add-parent", "", "AUTO_CLOSE_PARENT"],
    ["auto-close", "remove-parent", "", "AUTO_CLOSE_PARENT"],
  ] as const)(
    "retains %s/%s commit and audit when editReply rejects",
    async (group, subcommand, value, settingType) => {
      const id = guild();
      if (subcommand === "remove-parent")
        await policy.enableParentChannelWithBaselines(parentInput(id));
      const configuration = createAutomaticCloseConfigurationService({
        guildSettings: settings,
        schedules: policy,
        discord: { fetchActiveThreadSummaries: () => Promise.resolve([]) },
        logger: { warn: vi.fn() },
      });
      const interaction = {
        guildId: id,
        inGuild: () => true,
        memberPermissions: { has: () => true },
        user: { id: "command-actor" },
        options: {
          getSubcommandGroup: () => group,
          getSubcommand: () => subcommand,
          getString: () => value,
          getBoolean: () => true,
          getChannel: () => ({ id: "parent", type: ChannelType.GuildText }),
        },
        deferReply: () => Promise.resolve(),
        reply: () => Promise.resolve(),
        editReply: () => Promise.reject(new Error("Discord response lost")),
      } as unknown as ChatInputCommandInteraction;
      await expect(
        handleConfigCommand(
          interaction,
          settings,
          configuration,
          { show: vi.fn(), set: vi.fn(), disable: vi.fn() },
          { show: vi.fn(), set: vi.fn() },
        ),
      ).rejects.toThrow("Discord response lost");
      const audits = (await history(id)).filter((row) => row.actorUserId === "command-actor");
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ settingType, outcome: "SUCCESS" });
      if (subcommand === "remove-parent") expect((await state(id)).parents).toEqual([]);
      if (subcommand === "add-parent") expect((await state(id)).parents).toHaveLength(1);
    },
  );
  it.each(["track", "untrack"] as const)(
    "retains %s policy and audit after Discord response loss",
    async (operation) => {
      const id = guild();
      if (operation === "track") await policy.addThreadExclusion(id, "thread", context());
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const maintenance = createAutomaticCloseThreadMaintenanceService({
        persistence: policy,
        discord: {
          inspectThread: () => Promise.resolve({ parentChannelId: "parent", actorCanManage: true }),
        },
        scheduledActions: { findCurrentThreadClose: vi.fn() },
        logger,
      });
      const interaction = {
        guildId: id,
        channelId: "thread",
        inGuild: () => true,
        channel: { isThread: () => true, type: ChannelType.PublicThread },
        memberPermissions: { has: () => true },
        user: { id: "command-actor" },
        options: { getSubcommand: () => operation },
        deferred: false,
        replied: false,
        reply: () => Promise.resolve(),
        editReply: () => Promise.reject(new Error("Discord response lost")),
      } as unknown as ChatInputCommandInteraction;
      await expect(
        handleThreadCommand(
          interaction,
          {} as ThreadLifecycleService,
          {} as ScheduledThreadCloseCommandService,
          maintenance,
          logger,
        ),
      ).rejects.toThrow("Discord response lost");
      expect((await history(id)).filter((row) => row.actorUserId === "command-actor")).toHaveLength(
        1,
      );
      expect((await state(id)).exclusions).toHaveLength(operation === "track" ? 0 : 1);
    },
  );
});

it("observes serialization of concurrent first-time scalar establishment", async () => {
  const id = guild();
  const suffix = randomUUID().replaceAll("-", "");
  const functionName = `weft_config_first_${suffix}`,
    triggerName = `weft_config_trigger_${suffix}`;
  const lockKey = automaticClosePolicyLockKey(id);
  // UUIDs and decimal keys are generated here, never supplied by a user. The AFTER INSERT
  // barrier holds the first new row uncommitted so another connection must wait on its insertion.
  await database.client.execute(
    sql.raw(
      `create function ${functionName}() returns trigger language plpgsql as $barrier$ begin if new.guild_id = '${id}' then perform pg_advisory_xact_lock(${lockKey}::bigint); end if; return new; end; $barrier$`,
    ),
  );
  const running: { promise: Promise<unknown> }[] = [];
  try {
    await database.client.execute(
      sql.raw(
        `create trigger ${triggerName} after insert on guild_settings for each row execute function ${functionName}()`,
      ),
    );
    await hold(id, "policy", async (controller, release) => {
      const a = observed((client) =>
        createGuildSettingsStore(client).setTimezone(id, "Asia/Tokyo", context()),
      );
      running.push(a);
      await blocked(controller, a.pid);
      const b = observed((client) =>
        createGuildSettingsStore(client).setTimezone(id, "asia/tokyo", context()),
      );
      running.push(b);
      await blocked(controller, b.pid);
      await release();
      expect((await a.promise).outcome).toBe("CHANGED");
      expect((await b.promise).outcome).toBe("NO_CHANGE");
    });
    expect(await history(id)).toHaveLength(1);
    expect((await state(id)).settings).toHaveLength(1);
  } finally {
    await Promise.allSettled(running.map((operation) => operation.promise));
    await database.client.execute(
      sql.raw(`drop trigger if exists ${triggerName} on guild_settings`),
    );
    await database.client.execute(sql.raw(`drop function ${functionName}()`));
  }
});

describe("disabled closed-prefix persistence and evidence", () => {
  it("commits prefix -> empty -> prefix with exact audits and a silent empty -> empty no-op", async () => {
    const id = guild();
    const publish = vi.fn<AuditNotificationPublisher["publish"]>();
    const store = createGuildSettingsStore(database.client, { publish });
    const disable = context();
    expect(await store.disableClosedPrefix(id, disable)).toMatchObject({
      outcome: "CHANGED",
      settings: { closedPrefix: "" },
    });
    expect(await history(id)).toEqual([
      configurationAudit(disable, id, {
        action: "SET",
        settingType: "CLOSED_PREFIX",
        targetType: "GUILD",
        targetId: id,
        previousText: "[CLOSED]",
        newText: "",
      }),
    ]);
    const before = await state(id);
    const audits = await history(id);
    expect(await store.disableClosedPrefix(id, context())).toMatchObject({ outcome: "NO_CHANGE" });
    expect(await state(id)).toEqual(before);
    expect(await history(id)).toEqual(audits);
    expect(publish).toHaveBeenCalledOnce();
    const enable = context();
    expect(await store.setClosedPrefix(id, "[DONE]", enable)).toMatchObject({ outcome: "CHANGED" });
    expect(await history(id)).toContainEqual(
      configurationAudit(enable, id, {
        action: "SET",
        settingType: "CLOSED_PREFIX",
        targetType: "GUILD",
        targetId: id,
        previousText: "",
        newText: "[DONE]",
      }),
    );
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("confirms a lost disable commit using exact historical audit after a later change", async () => {
    const id = guild();
    const audit = context();
    const result = await createGuildSettingsStore(
      lostResponse(async () => {
        await settings.setClosedPrefix(id, "[LATER]", context());
      }),
    ).disableClosedPrefix(id, audit);
    expect(result).toMatchObject({ outcome: "CHANGED", settings: { closedPrefix: "" } });
    expect((await state(id)).settings[0]?.closedPrefix).toBe("[LATER]");
    expect(await history(id)).toContainEqual(
      configurationAudit(audit, id, {
        action: "SET",
        settingType: "CLOSED_PREFIX",
        targetType: "GUILD",
        targetId: id,
        previousText: "[CLOSED]",
        newText: "",
      }),
    );
  });

  it("does not confirm response loss from matching configuration when the exact audit is absent", async () => {
    const id = guild();
    const audit = context();
    const result = await createGuildSettingsStore(
      lostResponse(async () => {
        await database.client
          .delete(guildConfigurationAudits)
          .where(eq(guildConfigurationAudits.id, audit.auditId));
      }),
    ).disableClosedPrefix(id, audit);
    expect(result).toEqual({ outcome: "UNCONFIRMED" });
    expect((await state(id)).settings[0]?.closedPrefix).toBe("");
    expect(await history(id)).toEqual([]);
  });

  it("rolls back disabling and timestamp updates together if the audit insert fails", async () => {
    const id = guild();
    const seed = context();
    await settings.setClosedPrefix(id, "[SEED]", seed);
    const before = await state(id);
    const audits = await history(id);
    expect(await settings.disableClosedPrefix(id, seed)).toEqual({ outcome: "UNCONFIRMED" });
    expect(await state(id)).toEqual(before);
    expect(await history(id)).toEqual(audits);
  });

  it.each([
    { previousText: null, newText: "" },
    { previousText: "", newText: null },
    { previousText: "", newText: "" },
    { previousText: "x".repeat(21), newText: "" },
    { previousText: "", newText: "😀".repeat(21) },
    { previousText: "bad\n", newText: "" },
    { previousText: "", newText: "bad\u0085" },
    { previousText: "[DONE]", newText: "", newInteger: 1 },
  ])("rejects invalid empty-prefix audit shape %j", async (values) => {
    const id = guild();
    await expect(
      database.client.insert(guildConfigurationAudits).values(
        configurationAudit(context(), id, {
          action: "SET",
          settingType: "CLOSED_PREFIX",
          targetType: "GUILD",
          targetId: id,
          ...values,
        }),
      ),
    ).rejects.toThrow();
  });
});
