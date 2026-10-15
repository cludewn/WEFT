import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  bindAdministrativePool,
  type AdministrativeAttempt,
} from "../../src/administrative-transaction.js";
import type { DatabaseClient } from "../../src/database.js";
import type { ManagedMessageDiscord } from "../../src/messages/managed-message-discord.js";
import { createManagedMessageStore } from "../../src/messages/managed-message-persistence.js";
import { createManagedMessageService } from "../../src/messages/managed-message.js";
import { publishManagedMessageAudits } from "../../src/audit/audit-notification-publication.js";

const input = {
  guildId: "guild",
  channelId: "channel",
  actorUserId: "actor",
  payload: { content: "private content", embed: null },
};
const at = new Date("2030-01-01T00:00:00.123Z");
const message = {
  guildId: input.guildId,
  channelId: input.channelId,
  messageId: "message",
  createdAt: at,
  payload: input.payload,
};
type Fault = "NONE" | "BEGIN" | "AUDIT" | "COMMIT_REJECTION" | "COMMIT_LOSS" | "ROLLBACK_LOSS";

function fixture(
  fault: Fault,
  confirmation: "MATCH" | "MISSING" | "CONFLICT" | "READ_FAILED" = "MISSING",
  deletionOutcome: "DELETED" | "ALREADY_ABSENT" | "REJECTED" | "UNCONFIRMED" = "DELETED",
) {
  const trace: string[] = [];
  const release = vi.fn();
  const query = vi.fn((request: string | { text: string }) => {
    const command = typeof request === "string" ? request : request.text;
    trace.push(command);
    if (command === "BEGIN" && fault === "BEGIN") throw new Error("begin loss");
    if (
      command.startsWith('insert into "managed_message_audits"') &&
      ["AUDIT", "ROLLBACK_LOSS"].includes(fault)
    )
      throw new Error("audit rejection");
    if (command === "ROLLBACK" && fault === "ROLLBACK_LOSS") throw new Error("rollback loss");
    if (command === "COMMIT" && fault === "COMMIT_LOSS") throw new Error("response loss");
    if (command === "COMMIT" && fault === "COMMIT_REJECTION")
      throw Object.assign(new Error("server rejection"), {
        code: "23503",
        severity: "ERROR",
        routine: "server",
      });
    return Promise.resolve({
      command,
      rows: command.startsWith('insert into "managed_messages"')
        ? [
            [
              "message",
              "guild",
              "channel",
              "actor",
              input.payload.content,
              null,
              null,
              null,
              null,
              1,
              "ACTIVE",
              at.toISOString(),
              at.toISOString(),
            ],
          ]
        : [],
      fields: [],
      rowCount: 1,
    });
  });
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(() => Promise.resolve(client));
  const database = drizzle({ connect } as never) as unknown as DatabaseClient;
  bindAdministrativePool(database, { connect });
  const actual = createManagedMessageStore(database);
  let attempt: AdministrativeAttempt | undefined;
  const create = vi.fn<typeof actual.create>((creation, evidence) => {
    attempt = evidence;
    return actual.create(creation, evidence);
  });
  const confirmCreation = vi.fn(() =>
    confirmation === "READ_FAILED"
      ? Promise.reject(new Error("private read failure"))
      : Promise.resolve(confirmation),
  );
  const discord = {
    sendManagedMessage: vi
      .fn<ManagedMessageDiscord["sendManagedMessage"]>()
      .mockResolvedValue({ outcome: "SENT", message }),
    deleteManagedMessage: vi
      .fn<ManagedMessageDiscord["deleteManagedMessage"]>()
      .mockResolvedValue({ outcome: deletionOutcome }),
    editManagedMessage: vi.fn<ManagedMessageDiscord["editManagedMessage"]>(),
    restoreManagedMessage: vi.fn<ManagedMessageDiscord["restoreManagedMessage"]>(),
  };
  const logger = { warn: vi.fn() };
  const store = { ...actual, create, confirmCreation };
  const service = createManagedMessageService({
    discord,
    store,
    logger,
    generateNonce: () => "stable-nonce",
    generateAuditId: () => "stable-audit",
  });
  return {
    service,
    store,
    discord,
    logger,
    trace,
    release,
    query,
    database,
    attempt: () => attempt,
  };
}

describe("managed send uses observed transaction evidence", () => {
  it.each([
    ["NONE", "COMMITTED", true, true, 0, "SUCCESS"],
    ["BEGIN", "START_FAILED", false, false, 1, "FAILURE"],
    ["AUDIT", "ROLLED_BACK", true, false, 1, "FAILURE"],
    ["COMMIT_REJECTION", "COMMIT_REJECTED", true, true, 1, "FAILURE"],
    ["COMMIT_LOSS", "UNCONFIRMED", true, true, 0, "UNCONFIRMED"],
    ["ROLLBACK_LOSS", "UNCONFIRMED", true, false, 0, "UNCONFIRMED"],
  ] as const)(
    "%s yields %s with observed mutation counts",
    async (fault, disposition, callbackEntered, commitAttempted, deletes, outcome) => {
      const f = fixture(fault);
      expect(await f.service.send(input)).toMatchObject({ outcome });
      expect(f.attempt()?.transactionEvidence).toEqual({
        disposition,
        callbackEntered,
        commitAttempted,
      });
      expect(f.trace.filter((command) => command === "BEGIN")).toHaveLength(1);
      expect(f.trace.filter((command) => command === "COMMIT")).toHaveLength(
        commitAttempted ? 1 : 0,
      );
      expect(f.trace.filter((command) => command === "ROLLBACK")).toHaveLength(
        fault === "NONE" ? 0 : 1,
      );
      expect(
        f.trace.filter((command) => command.startsWith('insert into "managed_messages"')),
      ).toHaveLength(callbackEntered ? 1 : 0);
      expect(
        f.trace.filter((command) => command.startsWith('insert into "managed_message_audits"')),
      ).toHaveLength(callbackEntered ? 1 : 0);
      expect(f.discord.deleteManagedMessage).toHaveBeenCalledTimes(deletes);
      if (deletes) expect(f.discord.deleteManagedMessage).toHaveBeenCalledExactlyOnceWith(message);
      expect(f.discord.sendManagedMessage).toHaveBeenCalledExactlyOnceWith({
        ...input,
        nonce: "stable-nonce",
      });
      expect(f.store.create).toHaveBeenCalledOnce();
      expect(f.release).toHaveBeenCalledExactlyOnceWith(disposition === "UNCONFIRMED");
    },
  );

  it.each(["MATCH", "MISSING", "CONFLICT", "READ_FAILED"] as const)(
    "ambiguous commit with %s never deletes or repeats mutations",
    async (confirmation) => {
      const f = fixture("COMMIT_LOSS", confirmation);
      expect(await f.service.send(input)).toEqual({
        outcome: confirmation === "MATCH" ? "SUCCESS" : "UNCONFIRMED",
        messageId: message.messageId,
      });
      expect(f.attempt()?.transactionEvidence).toEqual({
        disposition: "UNCONFIRMED",
        callbackEntered: true,
        commitAttempted: true,
      });
      expect(f.store.confirmCreation).toHaveBeenCalledExactlyOnceWith(
        f.store.create.mock.calls[0]?.[0],
      );
      expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(f.store.create).toHaveBeenCalledOnce();
      expect(f.trace.filter((command) => command === "COMMIT")).toHaveLength(1);
      expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain("private");
    },
  );

  it.each(["DELETED", "ALREADY_ABSENT", "REJECTED", "UNCONFIRMED"] as const)(
    "confirmed noncommit with delete %s remains distinct",
    async (deletionOutcome) => {
      const f = fixture("AUDIT", "READ_FAILED", deletionOutcome);
      expect(await f.service.send(input)).toEqual(
        deletionOutcome === "DELETED" || deletionOutcome === "ALREADY_ABSENT"
          ? {
              outcome: "FAILURE",
              code:
                deletionOutcome === "DELETED"
                  ? "PERSISTENCE_UNCONFIRMED_COMPENSATED"
                  : "PERSISTENCE_UNCONFIRMED_ALREADY_ABSENT",
            }
          : { outcome: "PARTIAL_FAILURE", messageId: message.messageId, deletionOutcome },
      );
      expect(f.attempt()?.transactionEvidence?.disposition).toBe("ROLLED_BACK");
      expect(f.trace.filter((command) => command === "ROLLBACK")).toHaveLength(1);
      expect(f.discord.deleteManagedMessage).toHaveBeenCalledExactlyOnceWith(message);
      expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(f.store.create).toHaveBeenCalledOnce();
    },
  );

  it("a rejected delete Promise stays unknown", async () => {
    const f = fixture("AUDIT");
    f.discord.deleteManagedMessage.mockRejectedValueOnce(new Error("lost delete response"));
    expect(await f.service.send(input)).toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: message.messageId,
      deletionOutcome: "UNCONFIRMED",
    });
    expect(f.attempt()?.transactionEvidence?.disposition).toBe("ROLLED_BACK");
    expect(f.discord.deleteManagedMessage).toHaveBeenCalledOnce();
  });

  it("notification wrapper forwards evidence and publishes confirmed success", async () => {
    const f = fixture("NONE");
    const rows = Promise.resolve([{ id: "stable-audit" }]);
    const database = {
      select: () => ({ from: () => ({ where: () => rows }) }),
    } as unknown as DatabaseClient;
    const publisher = { publish: vi.fn() };
    const store = publishManagedMessageAudits(database, publisher, f.store);
    const service = createManagedMessageService({
      discord: f.discord,
      store,
      logger: f.logger,
      generateAuditId: () => "stable-audit",
    });
    expect(await service.send(input)).toEqual({ outcome: "SUCCESS", messageId: message.messageId });
    expect(f.attempt()?.transactionEvidence?.disposition).toBe("COMMITTED");
    expect(publisher.publish).toHaveBeenCalledExactlyOnceWith({
      source: "MANAGED_MESSAGE",
      auditId: "stable-audit",
    });
    expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
  });

  it("retains operation and connection ownership while COMMIT is unresolved", async () => {
    const f = fixture("NONE");
    const original = f.query.getMockImplementation()!;
    let releaseCommit!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    f.query.mockImplementation((request) => {
      if (request === "COMMIT") return gate.then(() => original(request));
      return original(request);
    });
    let settled = false;
    const operation = f.service.send(input).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(f.store.create).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(f.release).not.toHaveBeenCalled();
    expect(f.store.confirmCreation).not.toHaveBeenCalled();
    expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
    releaseCommit();
    expect(await operation).toEqual({ outcome: "SUCCESS", messageId: message.messageId });
    expect(f.attempt()?.transactionEvidence?.disposition).toBe("COMMITTED");
    expect(f.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(f.discord.sendManagedMessage).toHaveBeenCalledOnce();
  });

  it("acknowledged commit remains success even if a later boundary rejects", async () => {
    const f = fixture("NONE");
    f.release.mockImplementationOnce(() => {
      throw new Error("release response failure");
    });
    expect(await f.service.send(input)).toEqual({
      outcome: "SUCCESS",
      messageId: message.messageId,
    });
    expect(f.attempt()?.transactionEvidence?.disposition).toBe("COMMITTED");
    expect(f.discord.deleteManagedMessage).not.toHaveBeenCalled();
    expect(f.store.confirmCreation).not.toHaveBeenCalled();
  });
});
