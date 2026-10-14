import { createAuditNotificationDispatcher } from "../../src/audit-notification-dispatcher.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/database.js";
import {
  createAdministrativeFailureRecorder,
  exactAdministrativeFailureAudit,
  type AdministrativeFailureAudit,
  type AdministrativeFailureDescriptor,
} from "../../src/administrative-operation-failure-audit.js";
import { createAuditNotificationProjection } from "../../src/audit-notification-projection.js";
import { formatAuditNotification } from "../../src/audit-notification-format.js";

const descriptor: AdministrativeFailureDescriptor = {
  operationCode: "AUDIT_DESTINATION_SET",
  failureStage: "DISCORD_READ",
  failureReasonCode: "REQUIRED_RESOURCE_READ_FAILED",
  targetType: "CHANNEL",
  targetId: null,
};
function fixture(
  options: {
    responseLoss?: boolean;
    rejected?: boolean;
    readFailed?: boolean;
    mismatch?: (row: AdministrativeFailureAudit) => AdministrativeFailureAudit;
    publishThrow?: boolean;
    logThrow?: boolean;
  } = {},
) {
  let written: AdministrativeFailureAudit | undefined;
  const returning = vi.fn(() => {
    if (options.rejected) return Promise.reject(new Error("private write rejected"));
    if (options.responseLoss) return Promise.reject(new Error("private response lost"));
    return Promise.resolve(written ? [written] : []);
  });
  const insert = vi.fn(() => ({
    values: (row: AdministrativeFailureAudit) => {
      written = row;
      return { returning };
    },
  }));
  const select = vi.fn(() => ({
    from: () => ({
      where: () => ({
        limit: () => {
          if (options.readFailed) return Promise.reject(new Error("private read rejected"));
          if (options.rejected || written === undefined) return Promise.resolve([]);
          return Promise.resolve([options.mismatch ? options.mismatch(written) : written]);
        },
      }),
    }),
  }));
  const warn = vi.fn(() => {
    if (options.logThrow) throw new Error("logger unavailable");
  });
  const publish = vi.fn(() => {
    if (options.publishThrow) throw new Error("publisher unavailable");
  });
  const database = { insert, select } as unknown as DatabaseClient;
  return {
    recorder: createAdministrativeFailureRecorder(database, { warn }, { publish }),
    insert,
    select,
    publish,
    warn,
    row: () => written,
  };
}

describe("independent best-effort administrative failure persistence", () => {
  it.each([false, true])(
    "confirms INSERT or exact same-ID response loss (loss=%s) before publication",
    async (responseLoss) => {
      const f = fixture({ responseLoss });
      const operationId = randomUUID();
      await f.recorder.record({ operationId }, "guild", "actor", descriptor);
      expect(f.insert).toHaveBeenCalledOnce();
      expect(f.row()).toMatchObject({
        ...descriptor,
        operationId,
        guildId: "guild",
        actorUserId: "actor",
        outcome: "FAILURE",
      });
      expect(f.row()?.id).not.toBe(operationId);
      expect(f.publish).toHaveBeenCalledExactlyOnceWith({
        source: "ADMINISTRATIVE_OPERATION_FAILURE",
        auditId: f.row()?.id,
      });
      expect(f.select).toHaveBeenCalledTimes(responseLoss ? 1 : 0);
    },
  );
  it.each([
    "id",
    "operationId",
    "guildId",
    "actorUserId",
    "operationCode",
    "failureStage",
    "failureReasonCode",
    "targetType",
    "targetId",
    "outcome",
    "occurredAt",
  ] as const)("rejects an exact confirmation mismatch in %s", async (key) => {
    const f = fixture({
      responseLoss: true,
      mismatch: (row) => ({
        ...row,
        [key]: key === "occurredAt" ? new Date(row.occurredAt.getTime() + 1) : "mismatch",
      }),
    });
    await f.recorder.record({ operationId: randomUUID() }, "guild", "actor", descriptor);
    expect(f.publish).not.toHaveBeenCalled();
    expect(f.warn).toHaveBeenCalledExactlyOnceWith(
      { event: "administrative_failure_audit_unconfirmed" },
      "Administrative failure audit could not be confirmed",
    );
  });
  it.each([
    { rejected: true },
    { responseLoss: true, readFailed: true },
    { rejected: true, logThrow: true },
    { publishThrow: true },
  ])("isolates persistence and diagnostic errors %j", async (options) => {
    const f = fixture(options);
    await expect(
      f.recorder.record({ operationId: randomUUID() }, "guild", "actor", descriptor),
    ).resolves.toBeUndefined();
    expect(f.insert).toHaveBeenCalledOnce();
    if (options.rejected || options.readFailed) expect(f.publish).not.toHaveBeenCalled();
  });
  it("requires the explicit NULL shape rather than missing or fabricated targets", () => {
    const f = fixture();
    const row = {
      ...descriptor,
      id: randomUUID(),
      operationId: randomUUID(),
      guildId: "g",
      actorUserId: "a",
      outcome: "FAILURE",
      occurredAt: new Date(),
    } satisfies AdministrativeFailureAudit;
    expect(exactAdministrativeFailureAudit(row, row)).toBe(true);
    expect(exactAdministrativeFailureAudit({ ...row, targetId: "fabricated" }, row)).toBe(false);
    expect(f.insert).not.toHaveBeenCalled();
  });
  it("SELECTs no target, payload, URL or arbitrary value and explicitly omits injected target fields", async () => {
    const at = new Date("2030-01-01T00:00:00Z");
    const row = {
      guildId: "guild",
      actorUserId: "actor",
      event: "AUDIT_DESTINATION_SET",
      failureStage: "DISCORD_PREFLIGHT",
      failureCode: "BOT_PERMISSION_MISSING",
      outcome: "FAILURE",
      occurredAt: at,
    };
    const select = vi.fn((projection?: object) => {
      void projection;
      return { from: () => ({ where: () => ({ limit: () => Promise.resolve([row]) }) }) };
    });
    const projection = createAuditNotificationProjection({ select } as unknown as DatabaseClient);
    const record = await projection.load({
      source: "ADMINISTRATIVE_OPERATION_FAILURE",
      auditId: randomUUID(),
    });
    expect(Object.keys(select.mock.calls[0]?.[0] ?? {})).toEqual([
      "guildId",
      "actorUserId",
      "event",
      "failureStage",
      "failureCode",
      "outcome",
      "occurredAt",
    ]);
    expect(record).toMatchObject(row);
    if (!record) throw new Error("projection missing");
    const formatted = formatAuditNotification({
      ...record,
      targetId: "secret-target",
      targetType: "CHANNEL",
      channelId: "secret-channel",
      scheduledActionId: "secret-schedule",
      previousMode: "secret-value",
    });
    expect(formatted?.content).toContain("DISCORD_PREFLIGHT");
    expect(formatted?.content).not.toMatch(
      /secret|Target|Channel ID|Scheduled action ID|Previous mode/,
    );
    expect(formatted?.nonce).toBe(formatAuditNotification(record)?.nonce);
  });
});

describe("administrative notification shutdown ownership", () => {
  it("drains new-source projection and single-attempt delivery without replay", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const send = vi.fn((input: { content: string }) => {
      void input;
      return Promise.resolve("SENT" as const);
    });
    const dispatcher = createAuditNotificationDispatcher({
      projection: {
        load: async (reference) => {
          await pending;
          return {
            ...reference,
            guildId: "guild",
            actorType: "USER",
            actorUserId: "actor",
            event: "THREAD_UNTRACK",
            failureStage: "DATABASE_TRANSACTION",
            failureCode: "TRANSACTION_ROLLED_BACK",
            outcome: "FAILURE",
            occurredAt: new Date(),
          };
        },
      },
      readDestination: () => Promise.resolve("123456789"),
      discord: { send },
      logger: { warn: vi.fn() },
    });
    dispatcher.publish({ source: "ADMINISTRATIVE_OPERATION_FAILURE", auditId: randomUUID() });
    let settled = false;
    const draining = dispatcher.drain().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await draining;
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]?.[0].content).not.toContain("Target ID");
    await dispatcher.drain();
    expect(send).toHaveBeenCalledOnce();
  });
});
