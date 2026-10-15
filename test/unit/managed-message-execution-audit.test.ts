import { randomUUID } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { AuditNotificationPublisher } from "../../src/audit-notification-dispatcher.js";
import type { DatabaseClient } from "../../src/database.js";
import {
  createManagedMessageExecutionRecorder,
  exactManagedMessageExecutionAudit,
  managedMessageExecutionFailureAudits,
  type ManagedMessageExecutionAudit,
} from "../../src/managed-message-execution-audit.js";
import { newManagedMessageExecutionAttempt } from "../../src/managed-message-execution-evidence.js";
import {
  managedMessageAudits,
  type ManagedMessageAudit,
  type CreateManagedMessage,
} from "../../src/managed-message-persistence.js";
import { createAuditNotificationProjection } from "../../src/audit-notification-projection.js";
import { formatAuditNotification } from "../../src/audit-notification-format.js";

const at = new Date("2030-01-01T00:00:00.123Z");
const identity = { guildId: "guild", channelId: "hidden-channel", actorUserId: "actor" };
function attempt() {
  return {
    ...newManagedMessageExecutionAttempt("MANAGED_MESSAGE_SEND"),
    operationId: randomUUID(),
    eligible: true,
    failure: { stage: "DISCORD_PREFLIGHT" as const, reasonCode: "BOT_PERMISSION_MISSING" as const },
  };
}
function fixture(
  options: {
    loss?: boolean;
    reject?: boolean;
    readFailed?: boolean;
    historyFailed?: boolean;
    history?: ManagedMessageAudit[];
    mismatch?: boolean;
    publishThrow?: boolean;
    logThrow?: boolean;
  } = {},
) {
  let stored: unknown[] | undefined;
  const columns = Object.keys(getTableColumns(managedMessageExecutionFailureAudits));
  const query = vi.fn((request: { text: string; rowMode?: string }, values?: unknown[]) => {
    const command = request.text;
    if (command.startsWith('insert into "managed_message_execution_failure_audits"')) {
      expect(command).toContain("not exists");
      expect(command).not.toContain("on conflict");
      if (options.reject) throw new Error("private INSERT rejected");
      stored = values!.slice(0, columns.length);
      if (options.loss) throw new Error("private INSERT response lost");
      return Promise.resolve({ rows: [stored] });
    }
    if (command.includes('from "managed_message_audits"')) {
      if (options.historyFailed) throw new Error("private history read failed");
      return Promise.resolve({
        rows: (options.history ?? []).map((row) =>
          Object.keys(getTableColumns(managedMessageAudits)).map(
            (key) => row[key as keyof ManagedMessageAudit],
          ),
        ),
      });
    }
    if (options.readFailed) throw new Error("private exact read failed");
    const raw = stored && [...stored];
    if (raw && options.mismatch) raw[columns.indexOf("actorUserId")] = "different-actor";
    if (command.includes('from "managed_message_execution_failure_audits"'))
      return Promise.resolve({ rows: raw ? [raw] : [] });
    throw new Error("Unexpected test query");
  });
  const database = drizzle({ query } as unknown as Pool) as unknown as DatabaseClient;
  const publish = vi.fn<AuditNotificationPublisher["publish"]>(() => {
    if (options.publishThrow) throw new Error("private publish error");
  });
  const warn = vi.fn(() => {
    if (options.logThrow) throw new Error("private logger error");
  });
  const recorder = createManagedMessageExecutionRecorder(
    database,
    { warn },
    { publish },
    { now: () => at },
  );
  return { database, recorder, query, publish, warn, stored: () => stored };
}

describe("managed execution independent persistence", () => {
  it("copies only verified identity fields from a payload-bearing service input", async () => {
    const f = fixture();
    await f.recorder.record(attempt(), {
      ...identity,
      ...{ payload: { content: "private-sentinel" }, expectedRevision: 1 },
    });
    expect(f.publish).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.query.mock.calls)).not.toContain("private-sentinel");
  });
  it.each([false, true])(
    "confirms real Drizzle INSERT mapping or exact response-loss evidence (loss=%s)",
    async (loss) => {
      const f = fixture({ loss }),
        current = attempt();
      await f.recorder.record(current, identity);
      expect(f.query.mock.calls.filter(([r]) => r.text.startsWith("insert"))).toHaveLength(1);
      expect(f.publish).toHaveBeenCalledOnce();
      const id = f.publish.mock.calls[0]?.[0];
      expect(id).toMatchObject({ source: "MANAGED_MESSAGE_EXECUTION_FAILURE" });
      expect(f.stored()?.[0]).not.toBe(current.operationId);
      expect(f.stored()?.[1]).toBe(current.operationId);
      expect(f.warn).not.toHaveBeenCalled();
    },
  );
  it("deduplicates concurrent recorder admission for the same attempt", async () => {
    const f = fixture(),
      current = attempt();
    await Promise.all([f.recorder.record(current, identity), f.recorder.record(current, identity)]);
    expect(f.query.mock.calls.filter(([r]) => r.text.startsWith("insert"))).toHaveLength(1);
    expect(f.publish).toHaveBeenCalledOnce();
  });
  it.each([
    { reject: true },
    { loss: true, readFailed: true },
    { loss: true, mismatch: true },
    { historyFailed: true },
    { reject: true, logThrow: true },
  ])("fails closed without retries or raw diagnostics: %j", async (options) => {
    const f = fixture(options);
    await expect(f.recorder.record(attempt(), identity)).resolves.toBeUndefined();
    expect(f.publish).not.toHaveBeenCalled();
    expect(
      f.query.mock.calls.filter(([r]) => r.text.startsWith("insert")).length,
    ).toBeLessThanOrEqual(1);
    expect(JSON.stringify(f.warn.mock.calls)).not.toContain("private");
  });
  it("isolates notification publication failure", async () => {
    const f = fixture({ publishThrow: true });
    await expect(f.recorder.record(attempt(), identity)).resolves.toBeUndefined();
    expect(f.stored()).toBeDefined();
  });
  it("suppresses exact historical success and same-ID mismatches without requiring a current row", async () => {
    const current = attempt();
    const creation: CreateManagedMessage = {
      auditId: current.operationId,
      messageId: "message",
      guildId: identity.guildId,
      channelId: identity.channelId,
      creatorUserId: identity.actorUserId,
      payload: { content: "private payload", embed: null },
      createdAt: at,
    };
    const history: ManagedMessageAudit = {
      id: creation.auditId,
      messageId: creation.messageId,
      guildId: creation.guildId,
      channelId: creation.channelId,
      event: "CREATED",
      actorType: "USER",
      actorId: creation.creatorUserId,
      beforeContent: null,
      afterContent: creation.payload.content,
      beforeEmbedTitle: null,
      afterEmbedTitle: null,
      beforeEmbedDescription: null,
      afterEmbedDescription: null,
      beforeEmbedColor: null,
      afterEmbedColor: null,
      beforeEmbedImageUrl: null,
      afterEmbedImageUrl: null,
      beforeRevision: null,
      afterRevision: 1,
      beforeStatus: null,
      afterStatus: "ACTIVE",
      occurredAt: at,
      outcome: "SUCCESS",
    };
    for (const actorId of [history.actorId, "wrong-actor"]) {
      const f = fixture({ history: [{ ...history, actorId }] });
      const value = { ...current };
      await f.recorder.record(value, identity, { event: "CREATED", input: creation });
      expect(value.historicalSuccess).toBe(actorId === history.actorId ? "MATCH" : "MISMATCH");
      expect(f.query).toHaveBeenCalledOnce();
      expect(f.query.mock.calls[0]?.[0].text).not.toContain('join "managed_messages"');
      expect(f.stored()).toBeUndefined();
      expect(f.publish).not.toHaveBeenCalled();
    }
  });
  it("compares every durable field including explicit NULL and millisecond timestamps", async () => {
    const f = fixture();
    await f.recorder.record(attempt(), identity);
    const keys = Object.keys(getTableColumns(managedMessageExecutionFailureAudits));
    const row = Object.fromEntries(
      keys.map((key, i) => [key, f.stored()![i]]),
    ) as ManagedMessageExecutionAudit;
    row.occurredAt = at;
    expect(exactManagedMessageExecutionAudit(row, row)).toBe(true);
    for (const key of keys) {
      const wrong = {
        ...row,
        [key]: key === "occurredAt" ? new Date(at.getTime() + 1) : "different",
      };
      expect(exactManagedMessageExecutionAudit(wrong, row), key).toBe(false);
    }
  });
});

describe("managed execution notification privacy", () => {
  it("SELECTs only metadata and formats even injected target fields privately", async () => {
    const selected: string[][] = [];
    const metadata = {
      guildId: "guild",
      actorUserId: "actor",
      event: "MANAGED_MESSAGE_SEND",
      failureStage: "DATABASE_TRANSACTION",
      failureCode: "TRANSACTION_ROLLED_BACK",
      outcome: "PARTIAL",
      discordEvidence: "SEND_CONFIRMED",
      databaseEffect: "NOT_APPLIED",
      compensationEvidence: "REJECTED",
      occurredAt: at,
    };
    const database = {
      select(fields: object) {
        selected.push(Object.keys(fields));
        return { from: () => ({ where: () => ({ limit: () => Promise.resolve([metadata]) }) }) };
      },
    } as unknown as DatabaseClient;
    const record = await createAuditNotificationProjection(database).load({
      source: "MANAGED_MESSAGE_EXECUTION_FAILURE",
      auditId: randomUUID(),
    });
    expect(selected[0]).toEqual(Object.keys(metadata));
    const formatted = formatAuditNotification({
      ...record!,
      channelId: "hidden-channel",
      messageId: "hidden-message",
      targetId: "hidden-target",
      previousDestinationId: "hidden-destination",
      previousMode: "hidden-value",
    });
    expect(formatted?.content).toContain("PARTIAL");
    expect(formatted?.content).toContain("REJECTED");
    expect(formatted?.content).not.toMatch(/hidden|private|https?:|<@|@everyone/);
    expect(formatted?.nonce).toBe(formatAuditNotification(record!)?.nonce);
    expect(
      formatAuditNotification({ ...record!, compensationEvidence: "arbitrary-secret" }),
    ).toBeUndefined();
  });
});
