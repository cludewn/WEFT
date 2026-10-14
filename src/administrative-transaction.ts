import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import type { DatabaseClient } from "./database.js";

export type AdministrativeTransactionEvidence =
  | { disposition: "START_FAILED"; callbackEntered: false; commitAttempted: false }
  | { disposition: "ROLLED_BACK"; callbackEntered: true; commitAttempted: false }
  | { disposition: "COMMIT_REJECTED"; callbackEntered: true; commitAttempted: true }
  | { disposition: "COMMITTED"; callbackEntered: true; commitAttempted: true }
  | { disposition: "UNCONFIRMED"; callbackEntered: boolean; commitAttempted: boolean };

/** Evidence belongs to one admitted administrative attempt, separately from its business result. */
export type AdministrativeAttempt = {
  operationId: string;
  transactionEvidence?: AdministrativeTransactionEvidence;
  normalGuard?: true;
};

export function administrativeGuard<T>(attempt: AdministrativeAttempt | undefined, result: T): T {
  if (attempt) attempt.normalGuard = true;
  return result;
}

const pools = new WeakMap<DatabaseClient, Pick<Pool, "connect">>();

export function bindAdministrativePool(
  database: DatabaseClient,
  pool: Pick<Pool, "connect">,
): void {
  pools.set(database, pool);
}

// These server ErrorResponse codes prove that COMMIT did not commit. Connection/statement
// completion unknown (08*, 40003), timeout, cancellation and opaque errors are deliberately absent.
const COMMIT_REJECTION_CODES = new Set(["40001", "40P01", "23503", "23505", "23514", "23P01"]);

function isCommitRejection(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    COMMIT_REJECTION_CODES.has(error.code) &&
    "severity" in error &&
    error.severity === "ERROR" &&
    "routine" in error &&
    typeof error.routine === "string"
  );
}

/** Only administrative store methods call this boundary. No worker or recovery transaction does. */
export async function administrativeTransaction<T>(
  database: DatabaseClient,
  attempt: AdministrativeAttempt | undefined,
  callback: (
    transaction: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  ) => Promise<T>,
): Promise<T> {
  const pool = pools.get(database);
  // Existing isolated store fakes and callers without an administrative identity keep their
  // original transaction contract. Promise rejection here provides no failure evidence.
  if (pool === undefined || attempt === undefined) return database.transaction(callback);
  let client: PoolClient | undefined;
  let callbackEntered = false;
  let commitAttempted = false;
  let reusable = false;
  try {
    client = await pool.connect();
    const begin = await client.query("BEGIN");
    if (begin.command !== "BEGIN") throw new Error("Administrative BEGIN acknowledgement missing");
    const transaction = drizzle(client) as unknown as Parameters<typeof callback>[0];
    callbackEntered = true;
    const result = await callback(transaction);
    // Set before calling public query, including synchronous throws. Never infer not-sent later.
    commitAttempted = true;
    const commit = await client.query("COMMIT");
    if (commit.command !== "COMMIT")
      throw new Error("Administrative COMMIT acknowledgement missing");
    reusable = true;
    attempt.transactionEvidence = {
      disposition: "COMMITTED",
      callbackEntered: true,
      commitAttempted: true,
    };
    return result;
  } catch (error) {
    let rollbackConfirmed = false;
    if (client !== undefined) {
      try {
        rollbackConfirmed = (await client.query("ROLLBACK")).command === "ROLLBACK";
      } catch {
        /* Unknown termination requires destroying the connection. */
      }
    }
    if (!callbackEntered) {
      // Callback never ran, so this attempt could not issue business queries or COMMIT.
      attempt.transactionEvidence = {
        disposition: "START_FAILED",
        callbackEntered: false,
        commitAttempted: false,
      };
      reusable = rollbackConfirmed;
    } else if (!commitAttempted && rollbackConfirmed) {
      attempt.transactionEvidence = {
        disposition: "ROLLED_BACK",
        callbackEntered: true,
        commitAttempted: false,
      };
      reusable = true;
    } else if (commitAttempted && isCommitRejection(error) && rollbackConfirmed) {
      attempt.transactionEvidence = {
        disposition: "COMMIT_REJECTED",
        callbackEntered: true,
        commitAttempted: true,
      };
      reusable = true;
    } else {
      attempt.transactionEvidence = {
        disposition: "UNCONFIRMED",
        callbackEntered,
        commitAttempted,
      };
    }
    throw error;
  } finally {
    client?.release(!reusable);
  }
}
