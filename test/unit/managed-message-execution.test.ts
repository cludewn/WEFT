import { randomUUID } from "node:crypto";
import {
  ChannelType,
  DiscordAPIError,
  HTTPError,
  PermissionsBitField,
  PermissionFlagsBits as P,
} from "discord.js";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { createManagedMessageDiscord } from "../../src/managed-message-discord.js";
import { createManagedMessageService } from "../../src/managed-message.js";
import type { ManagedMessage, ManagedMessageStore } from "../../src/managed-message-persistence.js";
import { classifyManagedMessageExecution } from "../../src/managed-message-execution-evidence.js";
import type { ManagedMessageExecutionRecorder } from "../../src/managed-message-execution-audit.js";

const guildId = "111111111111111111",
  channelId = "222222222222222222",
  messageId = "333333333333333333";
const input = {
  guildId,
  channelId,
  actorUserId: "444444444444444444",
  payload: { content: "new", embed: null },
};
const editInput = { ...input, messageId, expectedRevision: 1 };
const at = new Date("2030-01-01T00:00:00.123Z");
const rejection = () =>
  new HTTPError(403, "Forbidden", "PATCH", "https://discord.invalid", {
    body: undefined,
    files: undefined,
  });
const unknownMessage = () =>
  new DiscordAPIError(
    { code: 10008, message: "Unknown Message" },
    10008,
    404,
    "GET",
    "https://discord.invalid",
    { body: undefined, files: undefined },
  );
type Fault = "NONE" | "ROLLBACK" | "COMMIT_LOSS" | "ZERO";

function fixture(
  options: {
    actorDenied?: boolean;
    memberReadFailed?: boolean;
    channelReadFailed?: boolean;
    botDenied?: boolean;
    sendLoss?: boolean;
    sendRejected?: boolean;
    projection?: "MISSING" | "MISMATCH" | "THROW";
    editLoss?: "NEW" | "OLD" | "UNKNOWN";
    editRejected?: boolean;
    deleted?: boolean;
    db?: Fault;
    deleteOutcome?: "DELETED" | "ALREADY_ABSENT" | "REJECTED" | "UNCONFIRMED";
    restore?: "RESTORED" | "GUARD" | "READ_FAILED" | "REJECTED" | "LOSS";
    safetyReadFailed?: boolean;
    dbGuard?: boolean;
  } = {},
) {
  let remote = "old",
    exists = true,
    timestamp: Date | null = null,
    mutationCount = 0;
  let restoring = false;
  const patch = vi.fn((payload: { content: string | null }) => {
    mutationCount++;
    if (restoring && options.restore === "REJECTED") throw rejection();
    if (!restoring && options.editRejected) throw rejection();
    if (!restoring && options.editLoss === "OLD") throw new Error("lost edit");
    remote = payload.content ?? "";
    timestamp = new Date(at.getTime() + mutationCount * 1000);
    if (restoring && options.restore === "LOSS")
      throw new Error("lost restore response after effect");
    if (!restoring && options.editLoss) throw new Error("lost edit response after effect");
    return Promise.resolve(message());
  });
  const message = () => ({
    id: messageId,
    guildId,
    channelId,
    author: { id: "bot" },
    createdAt: at,
    content: remote,
    embeds: [],
    editedAt: timestamp,
    editable: true,
    edit: patch,
  });
  const fetchMessage = vi.fn(() => {
    if (options.deleted || !exists) throw unknownMessage();
    if (restoring && options.restore === "READ_FAILED") throw new Error("private read failure");
    if (!restoring && options.editLoss === "UNKNOWN" && mutationCount > 0)
      throw new Error("unavailable readback");
    return Promise.resolve({
      ...message(),
      content: restoring && options.restore === "GUARD" ? "newer external state" : remote,
    });
  });
  const send = vi.fn(() => {
    remote = options.projection === "MISMATCH" ? "different" : input.payload.content;
    if (options.sendRejected) {
      exists = false;
      throw rejection();
    }
    if (options.sendLoss) throw new Error("lost send response after creation");
    const response = message();
    if (options.projection === "MISSING")
      response.embeds = [{ data: { type: "unsupported" } }] as never;
    if (options.projection === "THROW")
      Object.defineProperty(response, "embeds", {
        get() {
          throw new Error("private projection error");
        },
      });
    return Promise.resolve(response);
  });
  const members = vi.fn(({ user }: { user: string }) => {
    if (options.memberReadFailed) throw new Error("member read failed");
    return Promise.resolve({ id: user });
  });
  const channel = {
    type: ChannelType.GuildText,
    guildId,
    isThread: () => false,
    send,
    guild: { members: { fetch: members } },
    messages: { fetch: fetchMessage },
    permissionsFor: (member: { id: string }) =>
      new PermissionsBitField(
        member.id === "bot"
          ? options.botDenied
            ? []
            : [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks]
          : options.actorDenied
            ? []
            : [P.ManageMessages],
      ),
  };
  const fetchChannel = vi.fn(() => {
    if (options.channelReadFailed) throw new Error("channel read failed");
    return Promise.resolve(channel);
  });
  const deleteMessage = vi.fn(() => {
    if (options.deleteOutcome === "ALREADY_ABSENT") {
      exists = false;
      throw unknownMessage();
    }
    if (options.deleteOutcome === "REJECTED") throw rejection();
    exists = false;
    if (options.deleteOutcome === "UNCONFIRMED")
      throw new Error("lost delete response after effect");
    return Promise.resolve();
  });
  const discord = createManagedMessageDiscord({
    user: { id: "bot" },
    channels: { fetch: fetchChannel },
    rest: { delete: deleteMessage },
  } as unknown as Client);
  const actualRestore = discord.restoreManagedMessage;
  discord.restoreManagedMessage = vi.fn(async (...args: Parameters<typeof actualRestore>) => {
    restoring = true;
    try {
      return await actualRestore(...args);
    } finally {
      restoring = false;
    }
  });
  const row: ManagedMessage = {
    messageId,
    guildId,
    channelId,
    creatorUserId: "creator",
    payload: { content: "old", embed: null },
    revision: 1,
    status: "ACTIVE",
    createdAt: at,
    updatedAt: at,
  };
  function databaseFailure(attempt: Parameters<ManagedMessageStore["edit"]>[1]) {
    if (options.db === "ZERO") {
      if (attempt) {
        attempt.databaseTransition = "NOT_TRANSITIONED";
        attempt.transactionEvidence = {
          disposition: "COMMITTED",
          callbackEntered: true,
          commitAttempted: true,
        };
      }
      return "NOT_TRANSITIONED" as const;
    }
    if (options.db === "ROLLBACK" || options.db === "COMMIT_LOSS") {
      if (attempt)
        attempt.transactionEvidence =
          options.db === "ROLLBACK"
            ? { disposition: "ROLLED_BACK", callbackEntered: true, commitAttempted: false }
            : { disposition: "UNCONFIRMED", callbackEntered: true, commitAttempted: true };
      throw new Error("database fault");
    }
    return "TRANSITIONED" as const;
  }
  const store: ManagedMessageStore = {
    find: vi.fn<ManagedMessageStore["find"]>(() => Promise.resolve(row)),
    create: vi.fn<ManagedMessageStore["create"]>((creation, attempt) => {
      databaseFailure(attempt);
      return Promise.resolve({ ...row, ...creation, revision: 1 });
    }),
    confirmCreation: vi.fn<ManagedMessageStore["confirmCreation"]>().mockResolvedValue("MISSING"),
    edit: vi.fn<ManagedMessageStore["edit"]>((_transition, attempt) =>
      Promise.resolve(databaseFailure(attempt)),
    ),
    confirmEdit: vi.fn<ManagedMessageStore["confirmEdit"]>().mockResolvedValue("MISSING"),
    markDeleted: vi.fn<ManagedMessageStore["markDeleted"]>((_transition, attempt) =>
      Promise.resolve(databaseFailure(attempt)),
    ),
    confirmDeletion: vi.fn<ManagedMessageStore["confirmDeletion"]>().mockResolvedValue("MISSING"),
    readCompensationSafety: vi.fn<ManagedMessageStore["readCompensationSafety"]>(() => {
      if (options.safetyReadFailed) throw new Error("private DB safety read failed");
      return Promise.resolve(options.dbGuard ? "UNSAFE" : "SAFE");
    }),
  };
  const record = vi.fn<ManagedMessageExecutionRecorder["record"]>(() => Promise.resolve());
  const service = createManagedMessageService({
    discord,
    store,
    failures: { record },
    logger: { warn: vi.fn() },
    generateAuditId: randomUUID,
  });
  return {
    service,
    record,
    store,
    discord,
    patch,
    send,
    fetchMessage,
    fetchChannel,
    deleteMessage,
    state: () => ({ remote, exists }),
    evidence: () => record.mock.calls[0]?.[0],
    classified: () => {
      const value = record.mock.calls[0]?.[0];
      return value && classifyManagedMessageExecution(value);
    },
  };
}

describe("managed execution owner uses production Discord evidence", () => {
  it("does not replace Bot preflight with an audit identity generation failure", async () => {
    const f = fixture({ botDenied: true });
    const service = createManagedMessageService({
      discord: f.discord,
      store: f.store,
      failures: { record: f.record },
      logger: { warn: vi.fn() },
      generateAuditId: () => {
        throw new Error("audit identity unavailable");
      },
    });
    expect(await service.send(input)).toEqual({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each([{ actorDenied: true }, { memberReadFailed: true }, { channelReadFailed: true }])(
    "excludes authorization not established: %j",
    async (options) => {
      const f = fixture(options);
      await f.service.send(input);
      await f.service.edit(editInput);
      expect(f.record).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.patch).not.toHaveBeenCalled();
    },
  );
  it.each(["send", "edit"] as const)(
    "records authorized Bot preflight failure for %s",
    async (method) => {
      const f = fixture({ botDenied: true });
      await f.service[method](editInput);
      expect(f.classified()).toMatchObject({
        outcome: "FAILURE",
        reasonCode: "BOT_PERMISSION_MISSING",
      });
      expect(f.evidence()?.eligible).toBe(true);
      expect(f.record).toHaveBeenCalledOnce();
      expect(f.send).not.toHaveBeenCalled();
      expect(f.patch).not.toHaveBeenCalled();
    },
  );
  it("does not audit malformed input, ordinary revision conflict or a fresh coherent no-op", async () => {
    const f = fixture();
    await f.service.send({ ...input, payload: { content: "", embed: null } });
    await f.service.edit({ ...editInput, expectedRevision: 2 });
    expect(
      await f.service.edit({ ...editInput, payload: { content: "old", embed: null } }),
    ).toEqual({ outcome: "UNCHANGED" });
    expect(f.fetchMessage).toHaveBeenCalledOnce();
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
  it.each(["send", "edit"] as const)(
    "records confirmed mutation rejection for %s",
    async (method) => {
      const f = fixture({ sendRejected: true, editRejected: true });
      await f.service[method](editInput);
      expect(f.classified()).toMatchObject({ outcome: "FAILURE", discordEvidence: "REJECTED" });
    },
  );
  it("send response loss leaves a remote effect without fabricating an audit or resend", async () => {
    const f = fixture({ sendLoss: true });
    expect(await f.service.send(input)).toMatchObject({ code: "SEND_UNCONFIRMED" });
    expect(f.state().exists).toBe(true);
    expect(f.record).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.deleteMessage).not.toHaveBeenCalled();
    expect(f.store.create).not.toHaveBeenCalled();
  });
  it("records a required message read failure only after fresh actor authorization", async () => {
    const f = fixture();
    f.fetchMessage.mockRejectedValueOnce(new Error("private read unavailable"));
    expect(await f.service.edit(editInput)).toMatchObject({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
    expect(f.classified()).toMatchObject({
      outcome: "FAILURE",
      stage: "DISCORD_READ",
      reasonCode: "REQUIRED_RESOURCE_READ_FAILED",
    });
    expect(f.patch).not.toHaveBeenCalled();
    expect(f.store.edit).not.toHaveBeenCalled();
  });
  it.each(["DELETED", "ALREADY_ABSENT", "REJECTED", "UNCONFIRMED"] as const)(
    "uses #107 delete disposition %s after proven rollback",
    async (deleteOutcome) => {
      const f = fixture({ db: "ROLLBACK", deleteOutcome });
      const result = await f.service.send(input);
      expect(result.outcome).toBe(
        ["DELETED", "ALREADY_ABSENT"].includes(deleteOutcome) ? "FAILURE" : "PARTIAL_FAILURE",
      );
      expect(f.classified()?.outcome).toBe(
        deleteOutcome === "UNCONFIRMED"
          ? undefined
          : deleteOutcome === "REJECTED"
            ? "PARTIAL"
            : "FAILURE",
      );
      expect(f.send).toHaveBeenCalledOnce();
      expect(f.deleteMessage).toHaveBeenCalledOnce();
      expect(f.store.create).toHaveBeenCalledOnce();
      if (deleteOutcome === "UNCONFIRMED") expect(f.state().exists).toBe(false);
    },
  );
  it("#107 ambiguous COMMIT never deletes or emits a confirmed audit", async () => {
    const f = fixture({ db: "COMMIT_LOSS" });
    expect(await f.service.send(input)).toEqual({ outcome: "UNCONFIRMED", messageId });
    expect(f.record).not.toHaveBeenCalled();
    expect(f.deleteMessage).not.toHaveBeenCalled();
  });
  it.each(["MISSING", "MISMATCH", "THROW"] as const)(
    "preserves verified send identity across projection %s",
    async (projection) => {
      const f = fixture({ projection, deleteOutcome: "REJECTED" });
      await f.service.send(input);
      expect(f.classified()).toMatchObject({
        outcome: "PARTIAL",
        discordEvidence: "SEND_CONFIRMED",
        databaseEffect: "NOT_ATTEMPTED",
      });
      expect(f.evidence()?.messageId).toBe(messageId);
      expect(f.store.create).not.toHaveBeenCalled();
      expect(f.deleteMessage).toHaveBeenCalledTimes(projection === "THROW" ? 0 : 1);
    },
  );
  it.each(["NEW", "OLD", "UNKNOWN"] as const)(
    "uses existing one-read edit reconciliation for %s",
    async (editLoss) => {
      const f = fixture({ editLoss });
      await f.service.edit(editInput);
      expect(f.patch).toHaveBeenCalledOnce();
      expect(f.fetchMessage).toHaveBeenCalledTimes(2);
      expect(f.classified()?.outcome).toBe(editLoss === "OLD" ? "FAILURE" : undefined);
      expect(f.store.edit).toHaveBeenCalledTimes(editLoss === "NEW" ? 1 : 0);
    },
  );
  it.each(["RESTORED", "GUARD", "READ_FAILED", "REJECTED", "LOSS"] as const)(
    "classifies restoration %s without extra PATCH",
    async (restore) => {
      const f = fixture({ db: "ROLLBACK", restore });
      const result = await f.service.edit(editInput);
      expect(result.outcome).toBe(restore === "RESTORED" ? "FAILURE" : "PARTIAL_FAILURE");
      expect(f.classified()?.outcome).toBe(
        restore === "RESTORED" ? "FAILURE" : restore === "LOSS" ? undefined : "PARTIAL",
      );
      expect(f.patch).toHaveBeenCalledTimes(["GUARD", "READ_FAILED"].includes(restore) ? 1 : 2);
      if (restore === "LOSS") expect(f.state().remote).toBe("old");
    },
  );
  it.each([{ dbGuard: true }, { safetyReadFailed: true }, { db: "ZERO" as const, dbGuard: true }])(
    "retains proven edit effects when restoration is not attempted: %j",
    async (change) => {
      const f = fixture({ db: "ROLLBACK", ...change });
      expect(await f.service.edit(editInput)).toMatchObject({
        outcome: "PARTIAL_FAILURE",
        kind: "EDIT",
      });
      expect(f.classified()?.outcome).toBe("PARTIAL");
      expect(f.patch).toHaveBeenCalledOnce();
      expect(f.discord.restoreManagedMessage).not.toHaveBeenCalled();
    },
  );
  it("keeps deletion-detection finalization separate from an edit effect", async () => {
    const f = fixture({ deleted: true, db: "ROLLBACK" });
    expect(await f.service.edit(editInput)).toMatchObject({ kind: "DELETION_DETECTION" });
    expect(f.classified()).toMatchObject({
      outcome: "FAILURE",
      stage: "DELETION_FINALIZATION",
      discordEvidence: "DELETION_OBSERVED",
    });
    expect(f.record.mock.calls[0]?.[2]?.event).toBe("DELETION_DETECTED");
    expect(f.record.mock.calls[0]?.[2]?.input.auditId).not.toBe(f.evidence()?.operationId);
    expect(f.patch).not.toHaveBeenCalled();
  });
  it("awaits audit persistence but releases the same-message business FIFO first", async () => {
    const f = fixture({ db: "ROLLBACK" });
    let release!: () => void;
    f.record.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    let settled = false;
    const first = f.service.edit(editInput).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(f.record).toHaveBeenCalledOnce());
    const second = await f.service.edit({
      ...editInput,
      payload: { content: "second", embed: null },
    });
    expect(second.outcome).toBe("FAILURE");
    expect(settled).toBe(false);
    expect(f.patch).toHaveBeenCalledTimes(4);
    expect(f.record.mock.calls[0]?.[0].operationId).not.toBe(
      f.record.mock.calls[1]?.[0].operationId,
    );
    release();
    await first;
  });
  it("preserves business results and compensation counts when recorder rejects", async () => {
    const f = fixture({ db: "ROLLBACK" });
    f.record.mockRejectedValueOnce(new Error("audit unavailable"));
    expect(await f.service.send(input)).toMatchObject({ outcome: "FAILURE" });
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.deleteMessage).toHaveBeenCalledOnce();
  });
});
