import { describe, expect, it, vi } from "vitest";

import type { ManagedMessageDiscord } from "../../src/managed-message-discord.js";
import type { ManagedMessageStore } from "../../src/managed-message-persistence.js";
import {
  createManagedMessageService,
  generateManagedMessageNonce,
  validateManagedMessageContent,
} from "../../src/managed-message.js";

describe("managed message content", () => {
  it("preserves valid content exactly, including ordinary URLs and surrounding whitespace", () => {
    const content = "  See https://example.invalid/path  ";
    expect(validateManagedMessageContent(content)).toEqual({ ok: true, content });
  });

  it.each([undefined, 123, "", " \n\t "])("rejects empty input %j", (content) => {
    expect(validateManagedMessageContent(content)).toEqual({ ok: false, code: "EMPTY_CONTENT" });
  });

  it("counts Unicode code points consistently at the 2000-character boundary", () => {
    expect(validateManagedMessageContent("😀".repeat(2_000))).toMatchObject({ ok: true });
    expect(validateManagedMessageContent("😀".repeat(2_001))).toEqual({
      ok: false,
      code: "CONTENT_TOO_LONG",
    });
  });

  it("generates a 22-character base64url nonce", () => {
    expect(generateManagedMessageNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("managed message send service", () => {
  it("sends once with one nonce and persists the exact Discord result", async () => {
    const fixture = createFixture();

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "SUCCESS",
      messageId: "message-id",
    });

    expect(fixture.generateNonce).toHaveBeenCalledOnce();
    expect(fixture.discord.sendManagedMessage).toHaveBeenCalledExactlyOnceWith({
      ...input,
      nonce: "stable-nonce",
    });
    expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith({
      auditId: "stable-audit-id",
      messageId: "message-id",
      guildId: input.guildId,
      channelId: input.channelId,
      creatorUserId: input.actorUserId,
      content: input.content,
      createdAt,
    });
    expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
    expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
  });

  it("generates a distinct stable nonce for each send operation", async () => {
    const firstNonce = "AAAAAAAAAAAAAAAAAAAAAA";
    const secondNonce = "BBBBBBBBBBBBBBBBBBBBBB";
    const fixture = createFixture();
    fixture.generateNonce.mockReturnValueOnce(firstNonce).mockReturnValueOnce(secondNonce);
    fixture.generateAuditId.mockReturnValueOnce("audit-a").mockReturnValueOnce("audit-b");

    await expect(fixture.service.send(input)).resolves.toMatchObject({ outcome: "SUCCESS" });
    await expect(fixture.service.send(input)).resolves.toMatchObject({ outcome: "SUCCESS" });

    expect(firstNonce).not.toBe(secondNonce);
    expect(fixture.generateNonce).toHaveBeenCalledTimes(2);
    expect(fixture.discord.sendManagedMessage).toHaveBeenCalledTimes(2);
    expect(fixture.discord.sendManagedMessage).toHaveBeenNthCalledWith(1, {
      ...input,
      nonce: firstNonce,
    });
    expect(fixture.discord.sendManagedMessage).toHaveBeenNthCalledWith(2, {
      ...input,
      nonce: secondNonce,
    });
    expect(fixture.store.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ auditId: "audit-a" }),
    );
    expect(fixture.store.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ auditId: "audit-b" }),
    );
  });

  it.each(["SEND_REJECTED", "SEND_UNCONFIRMED"] as const)(
    "does not persist or resend after %s",
    async (code) => {
      const fixture = createFixture({
        sendResult: { outcome: "FAILURE", code },
      });

      await expect(fixture.service.send(input)).resolves.toEqual({ outcome: "FAILURE", code });
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(fixture.store.create).not.toHaveBeenCalled();
      expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
      expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
    },
  );

  it("accepts an exact MATCH after a rejected insert without retrying the write", async () => {
    const fixture = createFixture({
      createFailure: new Error("sensitive database detail"),
      confirmation: "MATCH",
    });

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "SUCCESS",
      messageId: "message-id",
    });
    expect(fixture.store.create).toHaveBeenCalledOnce();
    expect(fixture.store.confirmCreation).toHaveBeenCalledOnce();
    expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(input.content);
  });

  it.each(["MISSING", "CONFLICT"] as const)(
    "compensates once after %s confirmation",
    async (confirmation) => {
      const fixture = createFixture({
        createFailure: new Error("write failed"),
        confirmation,
      });

      await expect(fixture.service.send(input)).resolves.toEqual({
        outcome: "FAILURE",
        code: "PERSISTENCE_UNCONFIRMED_COMPENSATED",
      });
      expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
    },
  );

  it("compensates when the confirmation read rejects", async () => {
    const fixture = createFixture({
      createFailure: new Error("write failed"),
      confirmationFailure: new Error("sensitive read failure"),
    });

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "FAILURE",
      code: "PERSISTENCE_UNCONFIRMED_COMPENSATED",
    });
    expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain("sensitive read failure");
  });

  it("returns a bounded partial failure with the known message ID when deletion is unconfirmed", async () => {
    const fixture = createFixture({
      createFailure: new Error("write failed"),
      confirmation: "MISSING",
      deleteResult: { outcome: "UNCONFIRMED" },
    });

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: "message-id",
    });
    expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
  });
});

const createdAt = new Date("2026-08-31T01:02:03.456Z");
const input = {
  guildId: "guild-id",
  channelId: "channel-id",
  actorUserId: "actor-id",
  content: "exact <@123> content",
};

function createFixture(
  overrides: {
    sendResult?: Awaited<ReturnType<ManagedMessageDiscord["sendManagedMessage"]>>;
    createFailure?: Error;
    confirmation?: "MATCH" | "MISSING" | "CONFLICT";
    confirmationFailure?: Error;
    deleteResult?: Awaited<ReturnType<ManagedMessageDiscord["deleteManagedMessage"]>>;
  } = {},
) {
  const sentMessage = {
    messageId: "message-id",
    guildId: input.guildId,
    channelId: input.channelId,
    createdAt,
  };
  const sendManagedMessage = vi.fn(() =>
    Promise.resolve(overrides.sendResult ?? ({ outcome: "SENT", message: sentMessage } as const)),
  );
  const deleteManagedMessage = vi.fn(() =>
    Promise.resolve(overrides.deleteResult ?? ({ outcome: "DELETED" } as const)),
  );
  const editManagedMessage = vi.fn(() => Promise.resolve({ outcome: "UNCHANGED" } as const));
  const restoreManagedMessage = vi.fn(() => Promise.resolve({ outcome: "RESTORED" } as const));
  const create = vi.fn(() =>
    overrides.createFailure === undefined
      ? Promise.resolve({} as never)
      : Promise.reject(overrides.createFailure),
  );
  const confirmCreation = vi.fn(() =>
    overrides.confirmationFailure === undefined
      ? Promise.resolve(overrides.confirmation ?? "MATCH")
      : Promise.reject(overrides.confirmationFailure),
  );
  const find = vi.fn(() => Promise.resolve(undefined));
  const edit = vi.fn(() => Promise.resolve("NOT_TRANSITIONED" as const));
  const confirmEdit = vi.fn(() => Promise.resolve("MISSING" as const));
  const markDeleted = vi.fn(() => Promise.resolve("NOT_TRANSITIONED" as const));
  const confirmDeletion = vi.fn(() => Promise.resolve("MISSING" as const));
  const readCompensationSafety = vi.fn(() => Promise.resolve("UNSAFE" as const));
  const discord = {
    sendManagedMessage,
    deleteManagedMessage,
    editManagedMessage,
    restoreManagedMessage,
  } satisfies ManagedMessageDiscord;
  const store = {
    find,
    create,
    confirmCreation,
    edit,
    confirmEdit,
    markDeleted,
    confirmDeletion,
    readCompensationSafety,
  } satisfies ManagedMessageStore;
  const logger = { warn: vi.fn() };
  const generateNonce = vi.fn(() => "stable-nonce");
  const generateAuditId = vi.fn(() => "stable-audit-id");
  const service = createManagedMessageService({
    discord,
    store,
    logger,
    generateNonce,
    generateAuditId,
  });
  return { service, discord, store, logger, generateNonce, generateAuditId };
}
