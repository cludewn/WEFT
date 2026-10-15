import { getTableName, type SQL } from "drizzle-orm";
import { PgDialect, type AnyPgTable } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/database.js";
import { createGuildSettingsStore, type GuildSettings } from "../../src/guild/guild-settings.js";
import { createAutomaticClosePersistenceStore } from "../../src/threads/automatic-close-persistence.js";
import {
  automaticClosePolicyLockKey,
  configurationAudit,
  exactConfigurationAudit,
  type GuildConfigurationAudit,
} from "../../src/guild/guild-configuration-audit.js";
import { createAuditNotificationProjection } from "../../src/audit/audit-notification-projection.js";
import { formatAuditNotification } from "../../src/audit/audit-notification-format.js";

const at = new Date("2026-10-14T00:00:00.123Z");
const context = { auditId: "audit-1", actorUserId: "actor-1", occurredAt: at };
const initial: GuildSettings = {
  guildId: "guild-1",
  timezone: "UTC",
  closedPrefix: "[CLOSED]",
  auditLogChannelId: null,
  linkPreviewMode: "hybrid",
  autoCloseInactivitySeconds: 604800,
  autoCloseBotMessagesCountAsActivity: false,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

// A query-boundary fake verifies operation ownership and confirmation decisions. Real SQL,
// constraints, rollback and lock behavior are covered by the PostgreSQL integration suite.
function fixture(
  options: {
    loss?: boolean;
    auditFailure?: boolean;
    readFailure?: boolean;
    changed?: boolean;
    evidence?: (audit: GuildConfigurationAudit) => GuildConfigurationAudit | undefined;
    parentEnabled?: boolean;
    applied?: number;
  } = {},
) {
  const events: string[] = [];
  const statements: SQL[] = [];
  const updates: object[] = [];
  const inserted: GuildConfigurationAudit[] = [];
  const publish = vi.fn();
  let settings = { ...initial };
  const select = vi.fn((projection?: object) => {
    let table = "";
    const read = () => {
      events.push(`read:${table}`);
      if (table === "guild_configuration_audits") {
        if (options.readFailure) return Promise.reject(new Error("unreadable"));
        const last = inserted.at(-1);
        return Promise.resolve(
          last === undefined
            ? []
            : [options.evidence ? options.evidence(last) : last].filter(Boolean),
        );
      }
      if (table === "auto_close_parent_channels")
        return Promise.resolve(
          options.parentEnabled === false ? [] : [{ parentChannelId: "parent-1" }],
        );
      if (projection) throw new Error("Unexpected scalar projection");
      return Promise.resolve([{ ...settings }]);
    };
    return {
      from(t: AnyPgTable) {
        table = getTableName(t);
        return this;
      },
      where() {
        return this;
      },
      limit() {
        return this;
      },
      for(mode: string) {
        events.push(`lock:${mode}`);
        return read();
      },
      then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
        return read().then(resolve, reject);
      },
    };
  });
  const insert = (t: AnyPgTable) => ({
    values(row: object) {
      const name = getTableName(t);
      events.push(`insert:${name}`);
      const run = () => {
        if (name === "guild_configuration_audits") {
          if (options.auditFailure) return Promise.reject(new Error("audit rejected"));
          inserted.push(row as GuildConfigurationAudit);
        }
        return Promise.resolve();
      };
      return {
        onConflictDoNothing() {
          return this;
        },
        returning() {
          return Promise.resolve(options.changed === false ? [] : [{ guildId: initial.guildId }]);
        },
        then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
          return run().then(resolve, reject);
        },
      };
    },
  });
  const update = () => ({
    set(values: object) {
      updates.push(values);
      events.push("update:settings");
      settings = { ...settings, ...values };
      return { where: () => ({ returning: () => Promise.resolve([{ ...settings }]) }) };
    },
  });
  const tx = {
    select,
    insert,
    update,
    delete: (t: AnyPgTable) => ({
      where: () => ({
        returning: () => {
          events.push(`delete:${getTableName(t)}`);
          return Promise.resolve(options.changed === false ? [] : [{ guildId: initial.guildId }]);
        },
      }),
    }),
    execute: (statement: SQL) => {
      statements.push(statement);
      const query = new PgDialect().sqlToQuery(statement).sql;
      events.push(query.includes("pg_advisory") ? "lock:policy" : "baseline");
      return Promise.resolve({ rows: Array(options.applied ?? 2).fill({ thread_id: "thread" }) });
    },
  };
  const transaction = vi.fn(async (callback: (t: typeof tx) => Promise<unknown>) => {
    const result = await callback(tx);
    events.push("commit");
    if (options.loss) throw new Error("response lost");
    return result;
  });
  const database = { select, transaction } as unknown as DatabaseClient;
  return { database, select, events, statements, updates, inserted, publish, transaction };
}

describe("exact guild configuration evidence", () => {
  const expected = configurationAudit(context, "guild-1", {
    action: "SET",
    settingType: "TIMEZONE",
    targetType: "GUILD",
    targetId: "guild-1",
    previousText: "UTC",
    newText: "Asia/Tokyo",
  });
  it("matches the complete historical audit including explicit NULL shape", () => {
    expect(exactConfigurationAudit({ ...expected, occurredAt: new Date(at) }, expected)).toBe(true);
    expect(exactConfigurationAudit(undefined, expected)).toBe(false);
  });
  it.each(Object.keys(expected) as (keyof GuildConfigurationAudit)[])(
    "rejects differing %s",
    (key) => {
      const actual = {
        ...expected,
        [key]:
          key === "occurredAt"
            ? new Date(at.getTime() + 1)
            : expected[key] === null
              ? "unexpected"
              : "different",
      } as GuildConfigurationAudit;
      expect(exactConfigurationAudit(actual, expected)).toBe(false);
    },
  );
  it("keeps policy lock keys stable, domain separated and lossless for maximum snowflakes", () => {
    expect(automaticClosePolicyLockKey("18446744073709551615")).toMatch(/^-?\d+$/);
    expect(automaticClosePolicyLockKey("18446744073709551615")).toBe(
      automaticClosePolicyLockKey("18446744073709551615"),
    );
    expect(automaticClosePolicyLockKey("18446744073709551615")).not.toBe(
      automaticClosePolicyLockKey("18446744073709551614"),
    );
  });
});

describe("scalar configuration audit decisions", () => {
  it.each([
    [
      "setTimezone",
      " Asia/Tokyo ",
      "timezone",
      "TIMEZONE",
      "previousText",
      "newText",
      "Asia/Tokyo",
    ],
    [
      "setClosedPrefix",
      " [DONE] ",
      "closedPrefix",
      "CLOSED_PREFIX",
      "previousText",
      "newText",
      "[DONE]",
    ],
    [
      "setAutoCloseInactivitySeconds",
      3600,
      "autoCloseInactivitySeconds",
      "AUTO_CLOSE_INACTIVITY",
      "previousInteger",
      "newInteger",
      3600,
    ],
    [
      "setAutoCloseBotMessagesCountAsActivity",
      true,
      "autoCloseBotMessagesCountAsActivity",
      "AUTO_CLOSE_BOT_MESSAGES",
      "previousBoolean",
      "newBoolean",
      true,
    ],
  ] as const)(
    "locks and audits %s with only the target column updated",
    async (method, input, key, settingType, before, after, normalized) => {
      const f = fixture();
      const store = createGuildSettingsStore(f.database, { publish: f.publish });
      const result = await (
        store[method] as (
          g: string,
          v: typeof input,
          c: typeof context,
        ) => ReturnType<typeof store.setTimezone>
      )("guild-1", input, context);
      expect(result.outcome).toBe("CHANGED");
      expect(f.updates).toEqual([{ [key]: normalized, updatedAt: at }]);
      expect(f.inserted).toEqual([
        configurationAudit(context, "guild-1", {
          action: "SET",
          settingType,
          targetType: "GUILD",
          targetId: "guild-1",
          [before]: initial[key],
          [after]: normalized,
        }),
      ]);
      expect(f.events).toEqual([
        "insert:guild_settings",
        "lock:update",
        "read:guild_settings",
        "update:settings",
        "insert:guild_configuration_audits",
        "commit",
      ]);
      expect(f.publish).toHaveBeenCalledExactlyOnceWith({
        source: "GUILD_CONFIGURATION",
        auditId: context.auditId,
      });
    },
  );
  it.each([" utc ", "UTC"])(
    "does not update, timestamp or publish normalized timezone no-op %s",
    async (value) => {
      const f = fixture();
      const result = await createGuildSettingsStore(f.database, { publish: f.publish }).setTimezone(
        "guild-1",
        value,
        context,
      );
      expect(result).toEqual({ outcome: "NO_CHANGE", settings: initial });
      expect(f.updates).toEqual([]);
      expect(f.inserted).toEqual([]);
      expect(f.publish).not.toHaveBeenCalled();
    },
  );
  it("confirms an exact audit after response loss without replay", async () => {
    const f = fixture({ loss: true });
    expect(
      (
        await createGuildSettingsStore(f.database, { publish: f.publish }).setClosedPrefix(
          "guild-1",
          "[DONE]",
          context,
        )
      ).outcome,
    ).toBe("CHANGED");
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it.each([
    { auditFailure: true },
    { loss: true, readFailure: true },
    { loss: true, evidence: () => undefined },
    {
      loss: true,
      evidence: (audit: GuildConfigurationAudit) => ({ ...audit, previousText: "wrong" }),
    },
  ])("returns unknown without publication when proof is insufficient %#", async (options) => {
    const f = fixture(options);
    expect(
      await createGuildSettingsStore(f.database, { publish: f.publish }).setTimezone(
        "guild-1",
        "Asia/Tokyo",
        context,
      ),
    ).toEqual({ outcome: "UNCONFIRMED" });
    expect(f.transaction).toHaveBeenCalledOnce();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("never invents an audit for a no-op whose transaction response was lost", async () => {
    const f = fixture({ loss: true });
    expect(
      await createGuildSettingsStore(f.database, { publish: f.publish }).setTimezone(
        "guild-1",
        "UTC",
        context,
      ),
    ).toEqual({ outcome: "UNCONFIRMED" });
    expect(f.select).toHaveBeenCalledOnce();
    expect(f.inserted).toEqual([]);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("does not reverse a confirmed change if publication fails", async () => {
    const f = fixture();
    f.publish.mockImplementation(() => {
      throw new Error("notification failed");
    });
    expect(
      (
        await createGuildSettingsStore(f.database, { publish: f.publish }).setTimezone(
          "guild-1",
          "Asia/Tokyo",
          context,
        )
      ).outcome,
    ).toBe("CHANGED");
    expect(f.transaction).toHaveBeenCalledOnce();
  });
});

describe("parent and exclusion audit decisions", () => {
  const parent = {
    guildId: "guild-1",
    parentChannelId: "parent-1",
    enabledAt: at,
    activeThreadIds: ["2", "1", "2"],
    ...context,
  };
  const thread = {
    guildId: "guild-1",
    threadId: "thread-1",
    parentChannelId: "parent-1",
    trackedAt: at,
    ...context,
  };
  it.each([0, 3])(
    "audits new parent with %s baselines and establishes settings before policy lock",
    async (applied) => {
      const f = fixture({ applied });
      const result = await createAutomaticClosePersistenceStore(f.database, {
        publish: f.publish,
      }).enableParentChannelWithBaselines(parent);
      expect(result).toEqual({ outcome: "ENABLED", baselinesApplied: applied });
      expect(f.events).toEqual([
        "insert:guild_settings",
        "lock:policy",
        "insert:auto_close_parent_channels",
        "baseline",
        "insert:guild_configuration_audits",
        "commit",
      ]);
      expect(f.inserted[0]).toEqual(
        configurationAudit(context, "guild-1", {
          action: "ADD",
          settingType: "AUTO_CLOSE_PARENT",
          targetType: "PARENT_CHANNEL",
          targetId: "parent-1",
          previousBoolean: false,
          newBoolean: true,
        }),
      );
      const query = new PgDialect().sqlToQuery(f.statements[1]!);
      expect(query.sql).toContain('order by candidate.thread_id collate "C"');
      expect(query.params).toContainEqual(["2", "1"]);
      expect(f.publish).toHaveBeenCalledOnce();
    },
  );
  it("audits parent enable with zero candidates", async () => {
    const f = fixture();
    expect(
      await createAutomaticClosePersistenceStore(f.database).enableParentChannelWithBaselines({
        ...parent,
        activeThreadIds: [],
      }),
    ).toEqual({ outcome: "ENABLED", baselinesApplied: 0 });
    expect(f.inserted).toHaveLength(1);
    expect(f.events).not.toContain("baseline");
  });
  it.each([false, true])(
    "audits exclusion removal with enabled parent=%s",
    async (parentEnabled) => {
      const f = fixture({ parentEnabled });
      const result = await createAutomaticClosePersistenceStore(f.database, {
        publish: f.publish,
      }).trackThread(thread);
      expect(result).toEqual({ outcome: "CHANGED", exclusionRemoved: true, parentEnabled });
      expect(f.inserted[0]).toMatchObject({
        action: "TRACK",
        targetId: "thread-1",
        previousBoolean: true,
        newBoolean: false,
      });
      expect(f.events.includes("baseline")).toBe(parentEnabled);
      expect(f.publish).toHaveBeenCalledOnce();
    },
  );
  it("repairs a missing baseline without policy audit or notification", async () => {
    const f = fixture({ changed: false });
    const result = await createAutomaticClosePersistenceStore(f.database, {
      publish: f.publish,
    }).trackThread(thread);
    expect(result).toEqual({ outcome: "NO_CHANGE", exclusionRemoved: false, parentEnabled: true });
    expect(f.events).toContain("insert:auto_close_thread_activity");
    expect(f.inserted).toEqual([]);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["removeParentChannel", "addThreadExclusion"] as const)(
    "audits %s only after transaction confirmation",
    async (method) => {
      const f = fixture({ loss: true });
      const store = createAutomaticClosePersistenceStore(f.database, { publish: f.publish });
      expect(await store[method]("guild-1", "target-1", context)).toEqual({ outcome: "CHANGED" });
      expect(f.events[0]).toBe("lock:policy");
      expect(f.publish).toHaveBeenCalledOnce();
      expect(f.transaction).toHaveBeenCalledOnce();
      expect(f.inserted[0]).toMatchObject({
        action: method === "removeParentChannel" ? "REMOVE" : "UNTRACK",
        actorUserId: context.actorUserId,
        targetId: "target-1",
      });
    },
  );
  it.each(["parent", "track", "untrack", "remove"] as const)(
    "leaves %s response loss unconfirmed when its audit cannot be read",
    async (operation) => {
      const f = fixture({ loss: true, readFailure: true });
      const store = createAutomaticClosePersistenceStore(f.database, { publish: f.publish });
      const result =
        operation === "parent"
          ? await store.enableParentChannelWithBaselines(parent)
          : operation === "track"
            ? await store.trackThread(thread)
            : operation === "untrack"
              ? await store.addThreadExclusion("guild-1", "thread-1", context)
              : await store.removeParentChannel("guild-1", "parent-1", context);
      expect(result).toEqual({ outcome: "UNCONFIRMED" });
      expect(f.publish).not.toHaveBeenCalled();
      expect(f.transaction).toHaveBeenCalledOnce();
    },
  );
  it.each(["parent", "track", "untrack", "remove"] as const)(
    "does not invent evidence after %s no-op or repair response loss",
    async (operation) => {
      const f = fixture({ loss: true, changed: false });
      const store = createAutomaticClosePersistenceStore(f.database, { publish: f.publish });
      const result =
        operation === "parent"
          ? await store.enableParentChannelWithBaselines(parent)
          : operation === "track"
            ? await store.trackThread(thread)
            : operation === "untrack"
              ? await store.addThreadExclusion("guild-1", "thread-1", context)
              : await store.removeParentChannel("guild-1", "parent-1", context);
      expect(result).toEqual({ outcome: "UNCONFIRMED" });
      expect(f.inserted).toEqual([]);
      expect(f.publish).not.toHaveBeenCalled();
    },
  );
});

it("selects only bounded notification metadata, excluding every value column", async () => {
  const selected = vi.fn((fields: Record<string, unknown>) => {
    expect(Object.keys(fields)).toEqual([
      "guildId",
      "actorUserId",
      "event",
      "settingType",
      "targetType",
      "targetId",
      "outcome",
      "occurredAt",
    ]);
    return {
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                guildId: "guild-1",
                actorUserId: "actor-1",
                event: "SET",
                settingType: "CLOSED_PREFIX",
                targetType: "GUILD",
                targetId: "guild-1",
                outcome: "SUCCESS",
                occurredAt: at,
              },
            ]),
        }),
      }),
    };
  });
  const record = await createAuditNotificationProjection({
    select: selected,
  } as unknown as DatabaseClient).load({ source: "GUILD_CONFIGURATION", auditId: context.auditId });
  const notification = formatAuditNotification(record!);
  expect(notification?.content).toContain("Setting: `CLOSED_PREFIX`");
  expect(notification?.content).not.toContain("[CLOSED]");
  expect(notification?.content).not.toMatch(/previous|new text|before|after/i);
});

it("orders the other multi-row activity writer inside SQL after policy filtering", async () => {
  const execute = vi.fn((statement: SQL) => {
    expect(statement).toBeDefined();
    return Promise.resolve({ rows: [] });
  });
  const store = createAutomaticClosePersistenceStore({ execute } as unknown as DatabaseClient);
  await store.initializeMissingActivityBaselines({
    guildId: "guild-1",
    baselineAt: at,
    candidates: [
      { threadId: "2", parentChannelId: "parent-2" },
      { threadId: "1", parentChannelId: "parent-1" },
      { threadId: "2", parentChannelId: "ignored-duplicate" },
    ],
  });
  const query = new PgDialect().sqlToQuery(vi.mocked(execute).mock.calls[0]![0]);
  expect(query.sql).toContain('order by candidate.thread_id collate "C"');
  expect(query.sql).toContain("on conflict (guild_id, thread_id) do nothing");
  expect(query.params).toContainEqual(["2", "1"]);
  expect(query.params).toContainEqual(["parent-2", "parent-1"]);
});

it.each([
  ["setTimezone", "not/a-timezone"],
  ["setClosedPrefix", "bad\n"],
  ["setAutoCloseInactivitySeconds", 299],
] as const)(
  "preserves asynchronous %s validation rejection before database admission",
  async (method, value) => {
    const transaction = vi.fn();
    const publish = vi.fn();
    const store = createGuildSettingsStore({ transaction } as unknown as DatabaseClient, {
      publish,
    });
    const promise = (
      store[method] as (
        id: string,
        value: string | number,
        audit: typeof context,
      ) => ReturnType<typeof store.setTimezone>
    )("guild-1", value, context);
    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow();
    expect(transaction).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  },
);
