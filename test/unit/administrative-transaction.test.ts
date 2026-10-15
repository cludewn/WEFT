import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/database.js";
import {
  administrativeGuard,
  administrativeTransaction,
  bindAdministrativePool,
  type AdministrativeAttempt,
} from "../../src/administrative-transaction.js";
import { confirmedAdministrativeDatabaseFailure } from "../../src/audit/administrative-operation-failure-audit.js";

function fixture(
  options: {
    acquire?: boolean;
    begin?: boolean;
    rollback?: boolean;
    commit?: Error;
    acknowledgement?: string;
  } = {},
) {
  const trace: string[] = [];
  const query = vi.fn((query: string | { text: string }) => {
    const text = typeof query === "string" ? query : query.text;
    trace.push(text);
    if (text === "BEGIN" && options.begin) return Promise.reject(new Error("begin response lost"));
    if (text === "ROLLBACK" && options.rollback)
      return Promise.reject(new Error("rollback response lost"));
    if (text === "COMMIT" && options.commit) return Promise.reject(options.commit);
    return Promise.resolve({
      command: text === "COMMIT" ? (options.acknowledgement ?? text) : text,
      rows: [],
      fields: [],
      rowCount: 0,
    });
  });
  const release = vi.fn();
  const connect = vi.fn(() => {
    if (options.acquire) return Promise.reject(new Error("connection unavailable"));
    return Promise.resolve({ query, release } as unknown as PoolClient);
  });
  const database = { transaction: vi.fn() } as unknown as DatabaseClient;
  bindAdministrativePool(database, { connect });
  const attempt: AdministrativeAttempt = { operationId: randomUUID() };
  return { database, attempt, trace, release, query };
}

const rejection = (fields: object) => Object.assign(new Error("fixed server rejection"), fields);

describe("scoped administrative transaction evidence", () => {
  it("uses one client for control and Drizzle business queries, then returns a confirmed commit", async () => {
    const f = fixture();
    const result = await administrativeTransaction(f.database, f.attempt, async (tx) => {
      await tx.execute(sql`select 1`);
      return { outcome: "CHANGED" };
    });
    expect(result).toEqual({ outcome: "CHANGED" });
    expect(f.trace).toEqual(["BEGIN", "select 1", "COMMIT"]);
    expect(f.attempt.transactionEvidence).toEqual({
      disposition: "COMMITTED",
      callbackEntered: true,
      commitAttempted: true,
    });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(confirmedAdministrativeDatabaseFailure(f.attempt)).toBeUndefined();
  });
  it.each(["acquire", "begin"] as const)(
    "observes %s failure without entering the callback",
    async (kind) => {
      const f = fixture({ [kind]: true });
      const callback = vi.fn(() => Promise.resolve("unused"));
      await expect(administrativeTransaction(f.database, f.attempt, callback)).rejects.toThrow();
      expect(callback).not.toHaveBeenCalled();
      expect(f.attempt.transactionEvidence?.disposition).toBe("START_FAILED");
      expect(f.trace).not.toContain("COMMIT");
      expect(confirmedAdministrativeDatabaseFailure(f.attempt)).toEqual({
        failureStage: "DATABASE_START",
        failureReasonCode: "TRANSACTION_START_FAILED",
      });
    },
  );
  it.each([false, true])(
    "requires the same connection's ROLLBACK acknowledgement (loss=%s)",
    async (rollback) => {
      const f = fixture({ rollback });
      await expect(
        administrativeTransaction(f.database, f.attempt, () => {
          return Promise.reject(new Error("business fault"));
        }),
      ).rejects.toThrow("business fault");
      expect(f.trace).toEqual(["BEGIN", "ROLLBACK"]);
      expect(f.attempt.transactionEvidence).toEqual({
        disposition: rollback ? "UNCONFIRMED" : "ROLLED_BACK",
        callbackEntered: true,
        commitAttempted: false,
      });
      expect(f.release).toHaveBeenCalledExactlyOnceWith(rollback);
      expect(confirmedAdministrativeDatabaseFailure(f.attempt)?.failureStage).toBe(
        rollback ? undefined : "DATABASE_TRANSACTION",
      );
    },
  );
  it.each([
    new Error("response lost"),
    rejection({ code: "08007", severity: "ERROR", routine: "unknown" }),
    rejection({ code: "40003", severity: "ERROR", routine: "unknown" }),
    rejection({ code: "57014", severity: "ERROR", routine: "cancel" }),
    rejection({ code: "40001" }),
  ])("never infers rollback after possible COMMIT from %j", async (commit) => {
    const f = fixture({ commit });
    await expect(
      administrativeTransaction(f.database, f.attempt, () => Promise.resolve("changed")),
    ).rejects.toBe(commit);
    expect(f.trace).toEqual(["BEGIN", "COMMIT", "ROLLBACK"]);
    expect(f.attempt.transactionEvidence).toEqual({
      disposition: "UNCONFIRMED",
      callbackEntered: true,
      commitAttempted: true,
    });
    expect(f.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(confirmedAdministrativeDatabaseFailure(f.attempt)).toBeUndefined();
  });
  it.each(["40001", "40P01", "23503", "23505", "23514", "23P01"])(
    "accepts bounded server COMMIT rejection %s with confirmed termination",
    async (code) => {
      const f = fixture({ commit: rejection({ code, severity: "ERROR", routine: "server" }) });
      await expect(
        administrativeTransaction(f.database, f.attempt, () => Promise.resolve("changed")),
      ).rejects.toBeDefined();
      expect(f.attempt.transactionEvidence?.disposition).toBe("COMMIT_REJECTED");
      expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    },
  );
  it("destroys connections with unconfirmed termination even for a server rejection", async () => {
    const f = fixture({
      commit: rejection({ code: "23503", severity: "ERROR", routine: "server" }),
      rollback: true,
    });
    await expect(
      administrativeTransaction(f.database, f.attempt, () => Promise.resolve("changed")),
    ).rejects.toBeDefined();
    expect(f.attempt.transactionEvidence?.disposition).toBe("UNCONFIRMED");
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it("does not accept a COMMIT that acknowledges ROLLBACK instead", async () => {
    const f = fixture({ acknowledgement: "ROLLBACK" });
    await expect(
      administrativeTransaction(f.database, f.attempt, () => Promise.resolve("changed")),
    ).rejects.toThrow();
    expect(confirmedAdministrativeDatabaseFailure(f.attempt)).toBeUndefined();
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it("excludes recognized no-ops, repairs and normal guards even if COMMIT rejects", async () => {
    const f = fixture({
      commit: rejection({ code: "40001", severity: "ERROR", routine: "server" }),
    });
    await expect(
      administrativeTransaction(f.database, f.attempt, () =>
        Promise.resolve(administrativeGuard(f.attempt, { outcome: "NO_CHANGE" })),
      ),
    ).rejects.toBeDefined();
    expect(f.attempt.transactionEvidence?.disposition).toBe("COMMIT_REJECTED");
    expect(confirmedAdministrativeDatabaseFailure(f.attempt)).toBeUndefined();
  });
  it("does not manufacture evidence from an unbound transaction Promise rejection", async () => {
    const transaction = vi.fn(() => {
      return Promise.reject(new Error("opaque"));
    });
    const database = { transaction } as unknown as DatabaseClient;
    const attempt: AdministrativeAttempt = { operationId: randomUUID() };
    await expect(
      administrativeTransaction(database, attempt, () => Promise.resolve("unused")),
    ).rejects.toThrow("opaque");
    expect(attempt.transactionEvidence).toBeUndefined();
  });
});
