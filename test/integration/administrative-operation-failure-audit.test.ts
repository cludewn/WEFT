import { randomUUID } from "node:crypto";
import { ChannelType } from "discord.js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { QueryResult } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import {
  administrativeTransaction,
  bindAdministrativePool,
  type AdministrativeAttempt,
} from "../../src/administrative-transaction.js";
import {
  administrativeOperationFailureAudits as failuresTable,
  createAdministrativeFailureRecorder,
  type AdministrativeFailureAudit,
  type AdministrativeOperation,
} from "../../src/audit/administrative-operation-failure-audit.js";
import { createGuildConfigurationService } from "../../src/guild/guild-configuration.js";
import {
  createConfigurationAuditContext,
  guildConfigurationAudits,
} from "../../src/guild/guild-configuration-audit.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild/guild-settings.js";
import { createAutomaticClosePersistenceStore } from "../../src/threads/automatic-close-persistence.js";
import { createAutomaticCloseConfigurationService } from "../../src/threads/automatic-close-configuration.js";
import { createAutomaticCloseThreadMaintenanceService } from "../../src/threads/automatic-close-thread-maintenance.js";
import { createAuditLogDestinationStore } from "../../src/audit/audit-log-destination-persistence.js";
import { createAuditLogDestinationService } from "../../src/audit/audit-log-destination.js";
import { createLinkPreviewStore } from "../../src/link-previews/link-preview-persistence.js";
import { createLinkPreviewConfiguration } from "../../src/link-previews/link-preview-configuration.js";
import { createScheduledThreadCloseStore } from "../../src/threads/scheduled-thread-close-persistence.js";
import { createScheduledThreadCloseCommandService } from "../../src/threads/scheduled-thread-close-command.js";
import { createScheduledMessageStore } from "../../src/messages/scheduled-message-persistence.js";
import { createRecurringMessageStore } from "../../src/messages/recurring-message-persistence.js";
import { createScheduledMessageAdministrationStore } from "../../src/messages/scheduled-message-administration-persistence.js";
import { createScheduledMessageCommandService } from "../../src/messages/scheduled-message-command.js";
import { createAuditNotificationProjection } from "../../src/audit/audit-notification-projection.js";
import { formatAuditNotification } from "../../src/audit/audit-notification-format.js";
import { createAuditRetentionStore } from "../../src/audit/audit-retention-persistence.js";
import type { BulkThreadCloseHooks } from "../../src/threads/thread-lifecycle.js";

// This suite is run only by the maintainer's approved external integration workflow.
const config = loadTestDatabaseConfig();
const observer = createDatabase(config);
const pool = new Pool({
  host: config.host,
  port: config.port,
  database: config.name,
  user: config.user,
  password: config.password,
  ssl: config.ssl ? { rejectUnauthorized: true } : false,
  max: 4,
  application_name: "weft-administrative-evidence-test",
});
const guilds: string[] = [];
const at = new Date("2030-01-01T00:00:00.123Z"),
  actor = "222222222222222222",
  channel = "333333333333333333",
  thread = "444444444444444444";
const schema = `weft_admin_${randomUUID().replaceAll("-", "")}`;
const guild = () => {
  const id = randomUUID();
  guilds.push(id);
  return id;
};
const logger = { warn: vi.fn() };
const successTables = [
  "guild_configuration_audits",
  "audit_log_destination_audits",
  "link_preview_audits",
  "scheduled_thread_close_audits",
  "scheduled_message_audits",
  "recurring_message_audits",
];
const stateTables = [
  "guild_settings",
  "auto_close_parent_channels",
  "auto_close_thread_exclusions",
  "auto_close_thread_activity",
  "scheduled_actions",
  ...successTables,
];
async function state(guildId: string) {
  return Promise.all(
    stateTables.map(
      async (table) =>
        (
          await observer.client.execute(
            sql`select * from ${sql.identifier(table)} where guild_id = ${guildId} order by 1, 2`,
          )
        ).rows,
    ),
  );
}
async function failureRows(guildId: string) {
  return observer.client.select().from(failuresTable).where(eq(failuresTable.guildId, guildId));
}
beforeAll(async () => {
  await migrate(observer.client, { migrationsFolder: "drizzle" });
  await observer.client.execute(sql`create schema ${sql.identifier(schema)}`);
  await observer.client.execute(
    sql`create table ${sql.identifier(schema)}.parent (id integer primary key)`,
  );
  await observer.client.execute(
    sql`create table ${sql.identifier(schema)}.child (id integer references ${sql.identifier(schema)}.parent(id) deferrable initially deferred)`,
  );
});
afterAll(async () => {
  for (const table of [
    "administrative_operation_failure_audits",
    ...successTables,
    "auto_close_thread_activity",
    "auto_close_thread_retirements",
    "auto_close_thread_exclusions",
    "auto_close_parent_channels",
  ]) {
    await observer.client.execute(
      sql`delete from ${sql.identifier(table)} where guild_id = any(${sql.param(guilds)}::text[])`,
    );
  }
  for (const table of [
    "recurring_message_occurrences",
    "recurring_message_schedules",
    "scheduled_message_states",
  ])
    await observer.client.execute(
      sql`delete from ${sql.identifier(table)} where scheduled_action_id in (select id from scheduled_actions where guild_id = any(${sql.param(guilds)}::text[]))`,
    );
  await observer.client.execute(
    sql`delete from scheduled_actions where guild_id = any(${sql.param(guilds)}::text[])`,
  );
  await observer.client.delete(guildSettings).where(inArray(guildSettings.guildId, guilds));
  await observer.client.execute(sql`drop schema ${sql.identifier(schema)} cascade`);
  await pool.end();
  await observer.close();
});

type Mode =
  | "NORMAL"
  | "CALLBACK_FAULT"
  | "BEGIN_LOSS"
  | "ROLLBACK_LOSS"
  | "COMMIT_LOSS"
  | "COMMIT_REJECTION"
  | "CONFIRM_MISSING"
  | "CONFIRM_MISMATCH"
  | "CONFIRM_READ_FAILED"
  | "FAILURE_INSERT_LOSS"
  | "POST_COMMIT_READ_FAILED";
function controlledDatabase() {
  let mode: Mode = "NORMAL";
  let committedObserved = false;
  const trace: string[] = [];
  const originalPoolQuery = pool.query.bind(pool);
  const originalConnect = pool.connect.bind(pool);
  // Only public query/connect/release APIs are decorated. No Drizzle internals are patched.
  const controlled = new Proxy(pool, {
    get(target, key) {
      if (key === "connect")
        return async () => {
          const client = await originalConnect();
          const original = client.query.bind(client);
          return new Proxy(client, {
            get(c, property) {
              if (property === "release") return client.release.bind(client);
              if (property !== "query") return Reflect.get(c, property) as unknown;
              return async (...args: unknown[]) => {
                const command =
                  typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
                trace.push(command);
                if (
                  /insert into "(?:guild_configuration|audit_log_destination|link_preview|scheduled_thread_close|scheduled_message|recurring_message)_audits"/.test(
                    command,
                  ) &&
                  (mode === "CALLBACK_FAULT" || mode === "ROLLBACK_LOSS")
                )
                  throw new Error("Injected success audit rejection");
                if (command === "COMMIT" && mode === "COMMIT_REJECTION")
                  await client.query(`insert into "${schema}".child values (1)`);
                const result = (await Reflect.apply(original, client, args)) as QueryResult;
                if (command === "COMMIT" && result.command === "COMMIT") committedObserved = true;
                if (
                  (command === "BEGIN" && mode === "BEGIN_LOSS") ||
                  (command === "ROLLBACK" && mode === "ROLLBACK_LOSS") ||
                  (command === "COMMIT" &&
                    [
                      "COMMIT_LOSS",
                      "CONFIRM_MISSING",
                      "CONFIRM_MISMATCH",
                      "CONFIRM_READ_FAILED",
                    ].includes(mode))
                )
                  throw new Error("Injected control response loss");
                return result;
              };
            },
          });
        };
      if (key === "query")
        return async (...args: unknown[]) => {
          const command =
            typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
          const confirmation = /from "guild_configuration_audits"/.test(command);
          if (
            (confirmation && mode === "CONFIRM_READ_FAILED") ||
            (mode === "POST_COMMIT_READ_FAILED" &&
              committedObserved &&
              /inner join "recurring_message_schedules"/.test(command))
          )
            throw new Error("Injected confirmation read failure");
          const result = (await Reflect.apply(originalPoolQuery, pool, args)) as QueryResult;
          if (confirmation && mode === "CONFIRM_MISSING") return { ...result, rows: [] };
          if (confirmation && mode === "CONFIRM_MISMATCH")
            return {
              ...result,
              rows: result.rows.map((row: unknown[]) =>
                row.map((value, index) => (index === 2 ? "wrong-actor" : value)),
              ),
            };
          if (
            mode === "FAILURE_INSERT_LOSS" &&
            /insert into "administrative_operation_failure_audits"/.test(command)
          )
            throw new Error("Injected independent INSERT response loss");
          return result;
        };
      return Reflect.get(target, key) as unknown;
    },
  });
  const database = drizzle(controlled) as unknown as DatabaseClient;
  bindAdministrativePool(database, controlled);
  return {
    database,
    trace,
    setMode(next: Mode) {
      mode = next;
      trace.length = 0;
      committedObserved = false;
    },
  };
}
const operationTargets: Record<
  AdministrativeOperation,
  "GUILD" | "PARENT_CHANNEL" | "THREAD" | "CHANNEL" | "SCHEDULE"
> = {
  GUILD_TIMEZONE_SET: "GUILD",
  GUILD_CLOSED_PREFIX_SET: "GUILD",
  AUTO_CLOSE_INACTIVITY_SET: "GUILD",
  AUTO_CLOSE_BOT_MESSAGES_SET: "GUILD",
  AUTO_CLOSE_PARENT_ADD: "PARENT_CHANNEL",
  AUTO_CLOSE_PARENT_REMOVE: "PARENT_CHANNEL",
  AUDIT_DESTINATION_SET: "CHANNEL",
  AUDIT_DESTINATION_DISABLE: "GUILD",
  LINK_PREVIEW_MODE_SET: "GUILD",
  THREAD_TRACK: "THREAD",
  THREAD_UNTRACK: "THREAD",
  THREAD_CLOSE_AFTER_SET: "THREAD",
  THREAD_CANCEL_CLOSE: "THREAD",
  MANUAL_CLOSE_PREPARATION: "THREAD",
  BULK_CLOSE_PREPARATION: "THREAD",
  ONE_TIME_MESSAGE_CREATE: "CHANNEL",
  ONE_TIME_MESSAGE_CANCEL: "SCHEDULE",
  ONE_TIME_MESSAGE_EDIT: "SCHEDULE",
  ONE_TIME_MESSAGE_RESCHEDULE: "SCHEDULE",
  RECURRING_MESSAGE_CREATE: "CHANNEL",
  RECURRING_MESSAGE_CANCEL: "SCHEDULE",
  RECURRING_MESSAGE_PAYLOAD_EDIT: "SCHEDULE",
  RECURRING_MESSAGE_RECURRENCE_EDIT: "SCHEDULE",
};
const operations = Object.keys(operationTargets) as AdministrativeOperation[];
function auditRow(
  operationCode: AdministrativeOperation,
  guildId: string,
): AdministrativeFailureAudit {
  const targetType = operationTargets[operationCode];
  return {
    id: randomUUID(),
    operationId: randomUUID(),
    guildId,
    actorUserId: actor,
    operationCode,
    failureStage: "DATABASE_TRANSACTION",
    failureReasonCode: "TRANSACTION_ROLLED_BACK",
    targetType,
    targetId: targetType === "GUILD" ? guildId : targetType === "SCHEDULE" ? randomUUID() : channel,
    outcome: "FAILURE",
    occurredAt: at,
  };
}

describe("administrative failure constraints and independent persistence", () => {
  it.each(operations)(
    "accepts the fixed target and real transaction stage for %s",
    async (operation) => {
      const guildId = guild();
      const rows: AdministrativeFailureAudit[] = [
        auditRow(operation, guildId),
        {
          ...auditRow(operation, guildId),
          failureStage: "DATABASE_START",
          failureReasonCode: "TRANSACTION_START_FAILED",
        },
        {
          ...auditRow(operation, guildId),
          failureStage: "DATABASE_COMMIT",
          failureReasonCode: "COMMIT_REJECTED",
        },
      ];
      await observer.client.insert(failuresTable).values(rows);
      expect(await failureRows(guildId)).toHaveLength(3);
      expect(await failureRows(guildId)).toEqual(expect.arrayContaining(rows));
    },
  );
  it.each([
    "AUDIT_DESTINATION_SET",
    "THREAD_CLOSE_AFTER_SET",
    "ONE_TIME_MESSAGE_CREATE",
    "RECURRING_MESSAGE_CREATE",
  ] as const)("constrains actual Discord stages for %s", async (operation) => {
    for (const failure of [
      { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_PERMISSION_MISSING" },
      { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_CONTEXT_UNAVAILABLE" },
      { failureStage: "DISCORD_READ", failureReasonCode: "REQUIRED_RESOURCE_READ_FAILED" },
      { failureStage: "DISCORD_READ", failureReasonCode: "REQUIRED_RESOURCE_UNAVAILABLE" },
    ] as const) {
      const row = { ...auditRow(operation, guild()), ...failure };
      await observer.client.insert(failuresTable).values(row);
      expect(await failureRows(row.guildId)).toEqual([row]);
    }
  });
  it.each([
    "AUTO_CLOSE_PARENT_ADD",
    "ONE_TIME_MESSAGE_CREATE",
    "RECURRING_MESSAGE_CANCEL",
    "RECURRING_MESSAGE_PAYLOAD_EDIT",
  ] as const)("admits only actual outside-transaction DB read stage for %s", async (operation) => {
    const row = {
      ...auditRow(operation, guild()),
      failureStage: "DATABASE_READ" as const,
      failureReasonCode: "REQUIRED_STATE_READ_FAILED" as const,
    };
    await observer.client.insert(failuresTable).values(row);
    expect(await failureRows(row.guildId)).toEqual([row]);
  });
  it("admits parent enumeration failure without inventing baselines or resources", async () => {
    const row = {
      ...auditRow("AUTO_CLOSE_PARENT_ADD", guild()),
      failureStage: "DISCORD_ENUMERATION" as const,
      failureReasonCode: "ACTIVE_THREAD_ENUMERATION_FAILED" as const,
    };
    await observer.client.insert(failuresTable).values(row);
    expect(await failureRows(row.guildId)).toEqual([row]);
  });
  it.each([
    { operationCode: "UNKNOWN" },
    { targetId: null },
    { targetId: "" },
    { targetType: "CHANNEL" },
    { outcome: "PARTIAL" },
    { actorUserId: "" },
    { failureStage: "DISCORD_PREFLIGHT", failureReasonCode: "BOT_PERMISSION_MISSING" },
    { failureStage: "DATABASE_START", failureReasonCode: "TRANSACTION_ROLLED_BACK" },
    { failureStage: "DATABASE_READ", failureReasonCode: "REQUIRED_STATE_READ_FAILED" },
  ])("rejects invalid and UNKNOWN CHECK combinations %j", async (invalid) => {
    const row = {
      ...auditRow("GUILD_TIMEZONE_SET", guild()),
      ...invalid,
    } as AdministrativeFailureAudit;
    await expect(observer.client.insert(failuresTable).values(row)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
    expect(await failureRows(row.guildId)).toEqual([]);
  });
  it("permits NULL only for destination set and constrains schedule target UUIDs", async () => {
    const row = {
      ...auditRow("AUDIT_DESTINATION_SET", guild()),
      targetId: null,
      failureStage: "DISCORD_READ" as const,
      failureReasonCode: "REQUIRED_RESOURCE_READ_FAILED" as const,
    };
    await observer.client.insert(failuresTable).values(row);
    const invalid = { ...auditRow("ONE_TIME_MESSAGE_EDIT", guild()), targetId: "never-created" };
    await expect(observer.client.insert(failuresTable).values(invalid)).rejects.toMatchObject({
      cause: { code: "23514" },
    });
  });
  it("does not suppress PK or operation collisions, and never publishes mismatched historical evidence", async () => {
    const guildId = guild(),
      id = randomUUID(),
      operationId = randomUUID();
    const original = { ...auditRow("GUILD_TIMEZONE_SET", guildId), id, operationId };
    await observer.client.insert(failuresTable).values(original);
    await expect(
      observer.client.insert(failuresTable).values({ ...original, operationId: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    await expect(
      observer.client.insert(failuresTable).values({ ...original, id: randomUUID() }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    const publish = vi.fn();
    for (const auditId of [id, randomUUID()]) {
      const recorder = createAdministrativeFailureRecorder(
        observer.client,
        logger,
        { publish },
        { generateId: () => auditId, now: () => at },
      );
      await recorder.record({ operationId }, guildId, actor, {
        operationCode: "GUILD_CLOSED_PREFIX_SET",
        targetType: "GUILD",
        targetId: guildId,
        failureStage: "DATABASE_TRANSACTION",
        failureReasonCode: "TRANSACTION_ROLLED_BACK",
      });
    }
    expect(publish).not.toHaveBeenCalled();
    expect(await failureRows(guildId)).toEqual([original]);
  });
  it("confirms an independently committed failure INSERT after its response is lost", async () => {
    const f = controlledDatabase(),
      guildId = guild(),
      publish = vi.fn();
    f.setMode("FAILURE_INSERT_LOSS");
    const recorder = createAdministrativeFailureRecorder(f.database, logger, { publish });
    await recorder.record({ operationId: randomUUID() }, guildId, actor, {
      operationCode: "THREAD_UNTRACK",
      targetType: "THREAD",
      targetId: thread,
      failureStage: "DATABASE_TRANSACTION",
      failureReasonCode: "TRANSACTION_ROLLED_BACK",
    });
    const rows = await failureRows(guildId);
    expect(rows).toHaveLength(1);
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      source: "ADMINISTRATIVE_OPERATION_FAILURE",
      auditId: rows[0]?.id,
    });
  });
});

async function owners(operation: AdministrativeOperation) {
  const f = controlledDatabase(),
    guildId = guild();
  const settings = createGuildSettingsStore(f.database),
    policy = createAutomaticClosePersistenceStore(f.database),
    closes = createScheduledThreadCloseStore(f.database),
    oneTime = createScheduledMessageStore(f.database),
    recurring = createRecurringMessageStore(f.database);
  const recorder = createAdministrativeFailureRecorder(f.database, logger);
  await settings.getOrCreate(guildId);
  if (operation === "AUTO_CLOSE_PARENT_REMOVE")
    await policy.enableParentChannelWithBaselines({
      guildId,
      parentChannelId: channel,
      activeThreadIds: [],
      enabledAt: at,
      ...createConfigurationAuditContext(actor, at),
    });
  if (operation === "THREAD_TRACK")
    await policy.addThreadExclusion(guildId, thread, createConfigurationAuditContext(actor, at));
  const destinationStore = createAuditLogDestinationStore(f.database);
  if (operation === "AUDIT_DESTINATION_DISABLE")
    await destinationStore.change({
      guildId,
      actorUserId: actor,
      newChannelId: channel,
      auditId: randomUUID(),
      occurredAt: at,
    });
  if (
    ["THREAD_CANCEL_CLOSE", "MANUAL_CLOSE_PREPARATION", "BULK_CLOSE_PREPARATION"].includes(
      operation,
    )
  )
    await closes.createOrReplace({
      scheduledActionId: randomUUID(),
      auditId: randomUUID(),
      guildId,
      threadId: thread,
      actorId: actor,
      executeAt: at,
    });
  const scheduleId = randomUUID();
  if (operation.startsWith("ONE_TIME_MESSAGE_") && operation !== "ONE_TIME_MESSAGE_CREATE")
    await oneTime.create({
      scheduledActionId: scheduleId,
      auditId: randomUUID(),
      guildId,
      channelId: channel,
      actorId: actor,
      payload: { content: "before", embed: null },
      executeAt: new Date(at.getTime() + 3600000),
      occurredAt: at,
    });
  if (operation.startsWith("RECURRING_MESSAGE_") && operation !== "RECURRING_MESSAGE_CREATE")
    await recurring.create({
      scheduledActionId: scheduleId,
      occurrenceId: randomUUID(),
      auditId: randomUUID(),
      gapAuditIds: [],
      guildId,
      channelId: channel,
      actorId: actor,
      payload: { content: "before", embed: null },
      recurrence: { frequency: "DAILY", weekdayMask: 127, localTime: "09:00", timezone: "UTC" },
      effectiveAt: at,
    });
  const configService = createGuildConfigurationService(settings, recorder);
  const automatic = createAutomaticCloseConfigurationService({
    guildSettings: settings,
    schedules: policy,
    discord: { fetchActiveThreadSummaries: () => Promise.resolve([]) },
    logger,
    failures: recorder,
  });
  const maintenance = createAutomaticCloseThreadMaintenanceService({
    discord: {
      inspectThread: () => Promise.resolve({ parentChannelId: channel, actorCanManage: true }),
    },
    persistence: policy,
    scheduledActions: { findCurrentThreadClose: () => Promise.resolve(undefined) },
    logger,
    failures: recorder,
  });
  const destination = createAuditLogDestinationService(
    destinationStore,
    { preflight: () => Promise.resolve({ ok: true, targetId: channel }) },
    recorder,
  );
  const preview = createLinkPreviewConfiguration(createLinkPreviewStore(f.database), recorder);
  const close = createScheduledThreadCloseCommandService({
    discord: {
      fetchThread: () =>
        Promise.resolve({
          guildId,
          threadId: thread,
          type: ChannelType.PublicThread,
          name: "thread",
          archived: false,
          locked: false,
        }),
      actorCanManage: () => Promise.resolve(true),
      botCanManage: () => Promise.resolve(true),
    },
    schedules: closes,
    delivery: {
      enqueueScheduledThreadClose: () => Promise.resolve("ENQUEUED"),
      hasCreatedOrRetryDelivery: () => Promise.resolve(true),
    },
    threadLifecycle: {
      close: async (_g, _t, _a, prepare) => {
        await prepare?.();
        return { ok: true, changed: true };
      },
    },
    logger,
    failures: recorder,
    now: () => at,
  });
  const messages = createScheduledMessageCommandService({
    discord: {
      authorizeCreation: async (input) => {
        await input.afterActorAuthorized?.();
        return { outcome: "AUTHORIZED" };
      },
    },
    store: oneTime,
    recurring,
    administration: createScheduledMessageAdministrationStore(f.database),
    recurringWorker: { project: () => Promise.resolve("CURRENT") },
    delivery: {
      ensureScheduledMessageDelivery: () => Promise.resolve("CURRENT"),
      cancelScheduledMessageDeliveries: () =>
        Promise.resolve({
          outcome: "CONFIRMED",
          matchedDeliveryCount: 0,
        }),
    },
    guildSettings: settings,
    logger,
    failures: recorder,
    now: () => at,
  });
  const scope = { scheduledActionId: scheduleId, guildId, channelId: channel, actorUserId: actor },
    recurrenceInput = { frequency: "daily", time: "10:00", timezone: "UTC" };
  const calls: Record<AdministrativeOperation, () => Promise<unknown>> = {
    GUILD_TIMEZONE_SET: () =>
      configService.setTimezone(guildId, "Asia/Tokyo", createConfigurationAuditContext(actor, at)),
    GUILD_CLOSED_PREFIX_SET: () =>
      configService.setClosedPrefix(guildId, "[DONE]", createConfigurationAuditContext(actor, at)),
    AUTO_CLOSE_INACTIVITY_SET: () => automatic.setInactivitySeconds(guildId, 3600, actor),
    AUTO_CLOSE_BOT_MESSAGES_SET: () =>
      automatic.setBotMessagesCountAsActivity(guildId, true, actor),
    AUTO_CLOSE_PARENT_ADD: () => automatic.addParentChannel(guildId, channel, actor),
    AUTO_CLOSE_PARENT_REMOVE: () => automatic.removeParentChannel(guildId, channel, actor),
    AUDIT_DESTINATION_SET: () => destination.set(guildId, actor, channel),
    AUDIT_DESTINATION_DISABLE: () => destination.disable(guildId, actor),
    LINK_PREVIEW_MODE_SET: () => preview.set(guildId, actor, "off"),
    THREAD_TRACK: () => maintenance.track(guildId, thread, actor),
    THREAD_UNTRACK: () => maintenance.untrack(guildId, thread, actor),
    THREAD_CLOSE_AFTER_SET: () => close.schedule(guildId, thread, actor, "1h"),
    THREAD_CANCEL_CLOSE: () => close.cancel(guildId, thread, actor),
    MANUAL_CLOSE_PREPARATION: () => close.closeManually(guildId, thread, actor),
    BULK_CLOSE_PREPARATION: () =>
      close.closeManually(guildId, thread, actor, {} as BulkThreadCloseHooks),
    ONE_TIME_MESSAGE_CREATE: () =>
      messages.create({
        ...scope,
        schedule: { kind: "AFTER", durationMs: 3600000 },
        payload: { content: "message" },
      }),
    ONE_TIME_MESSAGE_CANCEL: () => messages.cancel(scope),
    ONE_TIME_MESSAGE_EDIT: () =>
      messages.edit({ ...scope, expectedRevision: 0, payload: { content: "after" } }),
    ONE_TIME_MESSAGE_RESCHEDULE: () =>
      messages.reschedule({ ...scope, schedule: { kind: "AFTER", durationMs: 7200000 } }),
    RECURRING_MESSAGE_CREATE: () =>
      messages.createRecurring({
        ...scope,
        recurrence: recurrenceInput,
        payload: { content: "message" },
      }),
    RECURRING_MESSAGE_CANCEL: () => messages.cancel(scope),
    RECURRING_MESSAGE_PAYLOAD_EDIT: () =>
      messages.edit({ ...scope, expectedRevision: 0, payload: { content: "after" } }),
    RECURRING_MESSAGE_RECURRENCE_EDIT: () =>
      messages.editRecurrence({ ...scope, recurrence: recurrenceInput }),
  };
  return { ...f, guildId, calls, settings, policy, configService, recurring, oneTime, scheduleId };
}

describe("real administrative transaction traces and operation owners", () => {
  it.each(operations)(
    "rolls back business state and atomically commits one independent failure for %s",
    async (operationCode) => {
      const f = await owners(operationCode),
        before = await state(f.guildId);
      f.setMode("CALLBACK_FAULT");
      await f.calls[operationCode]();
      expect(f.trace).toContain("BEGIN");
      expect(f.trace).toContain("ROLLBACK");
      expect(f.trace).not.toContain("COMMIT");
      expect(f.trace.some((command) => /insert into .*_audits/.test(command))).toBe(true);
      expect(await state(f.guildId)).toEqual(before);
      const rows = await failureRows(f.guildId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        operationCode,
        guildId: f.guildId,
        actorUserId: actor,
        failureStage: "DATABASE_TRANSACTION",
        failureReasonCode: "TRANSACTION_ROLLED_BACK",
        targetType: operationTargets[operationCode],
      });
      expect(rows[0]?.targetId).toBe(
        operationTargets[operationCode] === "GUILD"
          ? f.guildId
          : operationTargets[operationCode] === "THREAD"
            ? thread
            : operationTargets[operationCode] === "SCHEDULE"
              ? f.scheduleId
              : channel,
      );
    },
  );
  it.each(["BEGIN_LOSS", "ROLLBACK_LOSS", "COMMIT_REJECTION"] as const)(
    "observes public %s control commands and separate-connection state",
    async (mode) => {
      const f = await owners("GUILD_TIMEZONE_SET"),
        before = await state(f.guildId);
      f.setMode(mode);
      expect(await f.calls.GUILD_TIMEZONE_SET()).toEqual({ outcome: "UNCONFIRMED" });
      expect(f.trace).toContain("ROLLBACK");
      expect(f.trace.includes("COMMIT")).toBe(mode === "COMMIT_REJECTION");
      expect(await state(f.guildId)).toEqual(before);
      const rows = await failureRows(f.guildId);
      expect(rows).toHaveLength(mode === "ROLLBACK_LOSS" ? 0 : 1);
      if (rows.length)
        expect(rows[0]?.failureStage).toBe(
          mode === "BEGIN_LOSS" ? "DATABASE_START" : "DATABASE_COMMIT",
        );
    },
  );
  it.each(["COMMIT_LOSS", "CONFIRM_MISSING", "CONFIRM_MISMATCH", "CONFIRM_READ_FAILED"] as const)(
    "never converts possible COMMIT plus later ROLLBACK to FAILURE (%s)",
    async (mode) => {
      const f = await owners("GUILD_TIMEZONE_SET");
      f.setMode(mode);
      const result = await f.calls.GUILD_TIMEZONE_SET();
      expect(result).toMatchObject({ outcome: mode === "COMMIT_LOSS" ? "CHANGED" : "UNCONFIRMED" });
      expect(f.trace).toContain("COMMIT");
      expect(f.trace).toContain("ROLLBACK");
      expect(
        (await createGuildSettingsStore(observer.client).getOrCreate(f.guildId)).timezone,
      ).toBe("Asia/Tokyo");
      expect(
        await observer.client
          .select()
          .from(guildConfigurationAudits)
          .where(eq(guildConfigurationAudits.guildId, f.guildId)),
      ).toHaveLength(1);
      expect(await failureRows(f.guildId)).toEqual([]);
    },
  );
  it.each(["RECURRING_MESSAGE_PAYLOAD_EDIT", "RECURRING_MESSAGE_CANCEL"] as const)(
    "preserves committed %s after post-commit find fails",
    async (operation) => {
      const f = await owners(operation);
      f.setMode("POST_COMMIT_READ_FAILED");
      const result = await f.calls[operation]();
      expect(result).toMatchObject({
        outcome: operation === "RECURRING_MESSAGE_CANCEL" ? "CANCELLED" : "EDITED",
      });
      expect(await failureRows(f.guildId)).toEqual([]);
      expect(f.trace).toContain("COMMIT");
      const series = await createRecurringMessageStore(observer.client).find(f.scheduleId);
      expect(series?.revision).toBe(1);
      if (operation === "RECURRING_MESSAGE_CANCEL") expect(series?.action.status).toBe("CANCELLED");
      else expect(series?.payload.content).toBe("after");
    },
  );
  it("uses the same PoolClient for business queries and records direct rollback evidence", async () => {
    const f = controlledDatabase(),
      attempt: AdministrativeAttempt = { operationId: randomUUID() },
      guildId = guild();
    await expect(
      administrativeTransaction(f.database, attempt, async (tx) => {
        await tx.insert(guildSettings).values({ guildId });
        throw new Error("fixed fault");
      }),
    ).rejects.toThrow("fixed fault");
    expect(
      f.trace.map((command) =>
        command === "BEGIN" || command === "ROLLBACK" ? command : "BUSINESS",
      ),
    ).toEqual(["BEGIN", "BUSINESS", "ROLLBACK"]);
    expect(attempt.transactionEvidence).toEqual({
      disposition: "ROLLED_BACK",
      callbackEntered: true,
      commitAttempted: false,
    });
    expect(
      await observer.client.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)),
    ).toEqual([]);
  });
  it("retains scalar and policy serialization under concurrent admitted changes", async () => {
    const f = await owners("GUILD_TIMEZONE_SET");
    await Promise.all([
      f.calls.GUILD_TIMEZONE_SET(),
      f.configService.setTimezone(
        f.guildId,
        "Europe/London",
        createConfigurationAuditContext(actor, at),
      ),
    ]);
    const history = await observer.client
      .select()
      .from(guildConfigurationAudits)
      .where(eq(guildConfigurationAudits.guildId, f.guildId));
    expect(history).toHaveLength(2);
    expect(history.filter((row) => row.previousText === "UTC")).toHaveLength(1);
    await Promise.all([
      f.policy.addThreadExclusion(f.guildId, thread, {
        ...createConfigurationAuditContext(actor, at),
        administrativeAttempt: { operationId: randomUUID() },
      }),
      f.policy.addThreadExclusion(f.guildId, thread, {
        ...createConfigurationAuditContext(actor, at),
        administrativeAttempt: { operationId: randomUUID() },
      }),
    ]);
    const policies = await observer.client
      .select()
      .from(guildConfigurationAudits)
      .where(
        and(
          eq(guildConfigurationAudits.guildId, f.guildId),
          eq(guildConfigurationAudits.settingType, "THREAD_EXCLUSION"),
        ),
      );
    expect(policies).toHaveLength(1);
    expect(await failureRows(f.guildId)).toEqual([]);
  });
  it("serializes concurrent one-time revisions and preserves the execution claim boundary", async () => {
    const f = await owners("ONE_TIME_MESSAGE_EDIT");
    const mutation = (content: string) =>
      f.oneTime.edit({
        scheduledActionId: f.scheduleId,
        guildId: f.guildId,
        channelId: channel,
        actorId: actor,
        expectedRevision: 0,
        payload: { content, embed: null },
        auditId: randomUUID(),
        occurredAt: at,
        administrativeAttempt: { operationId: randomUUID() },
      });
    const results = await Promise.all([mutation("first"), mutation("second")]);
    expect(results.map((result) => result.outcome).sort()).toEqual(["CONFLICT", "EDITED"]);
    const action = await f.oneTime.find(f.scheduleId);
    if (!action) throw new Error("schedule unavailable");
    const [edit, claim] = await Promise.all([
      f.oneTime.edit({
        scheduledActionId: f.scheduleId,
        guildId: f.guildId,
        channelId: channel,
        actorId: actor,
        expectedRevision: 1,
        payload: { content: "third", embed: null },
        auditId: randomUUID(),
        occurredAt: at,
        administrativeAttempt: { operationId: randomUUID() },
      }),
      f.oneTime.claimExecution(f.scheduleId, 1),
    ]);
    if (edit.outcome === "EDITED") expect(claim.outcome).toBe("NOT_TRANSITIONED");
    else {
      expect(edit.outcome).toBe("EXECUTING");
      expect(claim.outcome).toBe("COMMITTED");
    }
    expect(await failureRows(f.guildId)).toEqual([]);
  });
  it("serializes recurring payload edits against the occurrence snapshot claim", async () => {
    const f = await owners("RECURRING_MESSAGE_PAYLOAD_EDIT");
    const series = await f.recurring.find(f.scheduleId);
    if (!series?.occurrence) throw new Error("occurrence unavailable");
    const [edit, claim] = await Promise.all([
      f.recurring.editPayload({
        scheduledActionId: f.scheduleId,
        actorId: actor,
        expectedRevision: 0,
        payload: { content: "after", embed: null },
        auditId: randomUUID(),
        occurredAt: at,
        administrativeAttempt: { operationId: randomUUID() },
      }),
      f.recurring.claimInitial({
        occurrenceId: series.occurrence.id,
        expectedSeriesRevision: 0,
        claimedAt: at,
      }),
    ]);
    expect(edit.outcome).toBe("COMMITTED");
    if (claim.outcome === "COMMITTED") expect(claim.occurrence.claimContent).toBe("before");
    else expect(claim.outcome).toBe("NOT_CLAIMED");
    expect(await failureRows(f.guildId)).toEqual([]);
  });
});

describe("administrative notification privacy and retention", () => {
  it("projects only fixed metadata, retains guild isolation, and omits target fields", async () => {
    const first = auditRow("THREAD_UNTRACK", guild()),
      second = auditRow("THREAD_UNTRACK", guild());
    await observer.client.insert(failuresTable).values([first, second]);
    expect(await failureRows(first.guildId)).toEqual([first]);
    const record = await createAuditNotificationProjection(observer.client).load({
      source: "ADMINISTRATIVE_OPERATION_FAILURE",
      auditId: first.id,
    });
    expect(record).toEqual({
      source: "ADMINISTRATIVE_OPERATION_FAILURE",
      auditId: first.id,
      guildId: first.guildId,
      actorType: "USER",
      actorUserId: actor,
      event: first.operationCode,
      failureStage: first.failureStage,
      failureCode: first.failureReasonCode,
      outcome: "FAILURE",
      occurredAt: at,
    });
    if (!record) throw new Error("projection missing");
    const content = formatAuditNotification(record)?.content;
    expect(content).not.toContain(first.targetId);
    expect(content).not.toMatch(/Target|Thread ID|Channel ID/);
  });
  it("deletes at most 500 strictly expired rows in timestamp/id order and preserves state and cutoff equality", async () => {
    const guildId = guild();
    // Raw execute leaves timestamps as strings; apply the existing timestamp column decoder.
    const [existing] = await observer.client
      .select({
        minimum: sql<Date | null>`min(${failuresTable.occurredAt})`.mapWith(
          failuresTable.occurredAt,
        ),
      })
      .from(failuresTable);
    const minimum = existing?.minimum;
    if (minimum != null && !Number.isFinite(minimum.getTime()))
      throw new Error("Invalid audit timestamp in test database");
    const cutoff = minimum ? new Date(minimum.getTime() - 1000) : new Date("1970-01-01T00:00:01Z");
    await createGuildSettingsStore(observer.client).getOrCreate(guildId);
    const rows = Array.from({ length: 502 }, (_, index) => ({
      ...auditRow("GUILD_TIMEZONE_SET", guildId),
      occurredAt: new Date(cutoff.getTime() - 1000 + index),
    }));
    const equal = { ...auditRow("GUILD_TIMEZONE_SET", guildId), occurredAt: cutoff };
    await observer.client.insert(failuresTable).values([...rows, equal]);
    const retention = createAuditRetentionStore(observer.client);
    expect(
      await retention.deleteExpiredBatch("administrative_operation_failure_audits", cutoff, 500),
    ).toBe(500);
    const remaining = await failureRows(guildId);
    expect(remaining.map((row) => row.id).sort()).toEqual(
      [...rows.slice(500).map((row) => row.id), equal.id].sort(),
    );
    expect(
      await retention.deleteExpiredBatch("administrative_operation_failure_audits", cutoff, 500),
    ).toBe(2);
    expect(await failureRows(guildId)).toEqual([equal]);
    expect((await createGuildSettingsStore(observer.client).getOrCreate(guildId)).timezone).toBe(
      "UTC",
    );
  });
});
