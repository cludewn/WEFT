import { describe, expect, it, vi } from "vitest";
import { EmbedType } from "discord.js";
import type { Message } from "discord.js";

import type { ManagedMessageDiscord } from "../../src/managed-message-discord.js";
import { projectManagedMessagePayload } from "../../src/managed-message-discord.js";
import type { ManagedMessageStore } from "../../src/managed-message-persistence.js";
import {
  createManagedMessageService,
  generateManagedMessageNonce,
} from "../../src/managed-message.js";

describe("managed message operation identifiers", () => {
  it("generates a 22-character base64url nonce", () => {
    expect(generateManagedMessageNonce()).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("managed message send service", () => {
  it.each([undefined, 0, 1, 2, 4])(
    "persists text and a title-only embed with scan version %s without compensation",
    async (content_scan_version) => {
      const payload = { content: "Test", embed: { title: "Test Title" } };
      const fixture = createFixture({
        sendResult: {
          outcome: "SENT",
          message: {
            messageId: "message-id",
            guildId: input.guildId,
            channelId: input.channelId,
            createdAt,
            payload: projectManagedMessagePayload({
              content: payload.content,
              embeds: [
                {
                  data: { type: EmbedType.Rich, title: payload.embed.title, content_scan_version },
                },
              ],
            } as unknown as Message),
          },
        },
      });
      await expect(fixture.service.send({ ...input, payload })).resolves.toEqual({
        outcome: "SUCCESS",
        messageId: "message-id",
      });
      expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith(
        {
          auditId: "stable-audit-id",
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          creatorUserId: input.actorUserId,
          createdAt,
          payload,
        },
        expect.objectContaining({ operationId: "stable-audit-id" }),
      );
      expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(fixture.logger.warn).not.toHaveBeenCalled();
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
    },
  );

  it("classifies a missing projection without a supplied detailed reason conservatively", async () => {
    const fixture = createFixture({
      sendResult: {
        outcome: "SENT",
        message: {
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          createdAt,
          payload: undefined,
        },
      },
    });
    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "FAILURE",
      code: "PERSISTENCE_UNCONFIRMED_COMPENSATED",
    });
    expect(fixture.logger.warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "managed_message_send_confirmation_compensated",
        guildId: input.guildId,
        channelId: input.channelId,
        messageId: "message-id",
        failureCode: "RETURNED_PAYLOAD_MISMATCH",
        payloadFailureReason: "PROJECTION_FAILED",
      },
      "Managed message operation could not be confirmed",
    );
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
    expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
  });

  it.each(["", "combined image content"])(
    "confirms image-only or combined content %j with compatible metadata",
    async (content) => {
      const payload = { content, embed: { imageUrl: canonicalPayload.embed.imageUrl } };
      const fixture = createFixture({
        sendResult: {
          outcome: "SENT",
          message: {
            messageId: "message-id",
            guildId: input.guildId,
            channelId: input.channelId,
            createdAt,
            payload: projectManagedMessagePayload({
              content,
              embeds: [
                {
                  data: {
                    type: EmbedType.Rich,
                    content_scan_version: 0,
                    flags: 0,
                    image: { url: payload.embed.imageUrl, flags: 32, description: "" },
                  },
                },
              ],
            } as unknown as Message),
          },
        },
      });
      await expect(fixture.service.send({ ...input, payload })).resolves.toEqual({
        outcome: "SUCCESS",
        messageId: "message-id",
      });
      expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith(
        {
          auditId: "stable-audit-id",
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          creatorUserId: input.actorUserId,
          payload,
          createdAt,
        },
        expect.objectContaining({ operationId: "stable-audit-id" }),
      );
      expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
    },
  );

  it("confirms image flags: 0 through the real projector without false compensation", async () => {
    const payload = projectManagedMessagePayload({
      content: canonicalPayload.content,
      embeds: [
        {
          data: {
            type: EmbedType.Rich,
            content_scan_version: 0,
            title: canonicalPayload.embed.title,
            color: canonicalPayload.embed.color,
            image: { url: canonicalPayload.embed.imageUrl, flags: 0 },
          },
        },
      ],
    } as unknown as Message);
    const fixture = createFixture({
      sendResult: {
        outcome: "SENT",
        message: {
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          createdAt,
          payload,
        },
      },
    });
    const result = await fixture.service.send(input);
    expect.soft(payload).toEqual(canonicalPayload);
    expect.soft(fixture.store.create).toHaveBeenCalledExactlyOnceWith(
      {
        auditId: "stable-audit-id",
        messageId: "message-id",
        guildId: input.guildId,
        channelId: input.channelId,
        creatorUserId: input.actorUserId,
        payload: canonicalPayload,
        createdAt,
      },
      expect.objectContaining({ operationId: "stable-audit-id" }),
    );
    expect.soft(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
    expect.soft(fixture.store.confirmCreation).not.toHaveBeenCalled();
    expect.soft(fixture.logger.warn).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: "SUCCESS", messageId: "message-id" });
  });

  it("sends once with one nonce and persists the exact Discord result", async () => {
    const fixture = createFixture();

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "SUCCESS",
      messageId: "message-id",
    });

    expect(fixture.generateNonce).toHaveBeenCalledOnce();
    expect(fixture.discord.sendManagedMessage).toHaveBeenCalledExactlyOnceWith({
      guildId: input.guildId,
      channelId: input.channelId,
      actorUserId: input.actorUserId,
      payload: canonicalPayload,
      nonce: "stable-nonce",
    });
    expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith(
      {
        auditId: "stable-audit-id",
        messageId: "message-id",
        guildId: input.guildId,
        channelId: input.channelId,
        creatorUserId: input.actorUserId,
        payload: canonicalPayload,
        createdAt,
      },
      expect.objectContaining({ operationId: "stable-audit-id" }),
    );
    expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
    expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
  });

  it.each([
    [{ flags: 32, description: "", width: 100, height: 0 }, undefined, "MATCH", "SUCCESS"],
    [
      { flags: 0, proxy_url: "https://proxy.invalid/image.png" },
      new Error("response lost"),
      "MATCH",
      "SUCCESS",
    ],
    [{ flags: 32 }, new Error("response lost"), "MISSING", "UNCONFIRMED"],
    [{ flags: 0 }, new Error("response lost"), "CONFLICT", "UNCONFIRMED"],
  ] as const)(
    "preserves creation and exact confirmation with image metadata %#",
    async (metadata, createFailure, confirmation, outcome) => {
      const fixture = createFixture({
        sendResult: { outcome: "SENT", message: projectedSentMessage({ ...metadata }) },
        ...(createFailure === undefined ? {} : { createFailure }),
        confirmation,
      });
      await expect(fixture.service.send(input)).resolves.toMatchObject({ outcome });
      expect(fixture.store.create).toHaveBeenCalledExactlyOnceWith(
        {
          auditId: "stable-audit-id",
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          creatorUserId: input.actorUserId,
          createdAt,
          payload: canonicalPayload,
        },
        expect.objectContaining({ operationId: "stable-audit-id" }),
      );
      if (createFailure !== undefined) {
        expect(fixture.store.confirmCreation).toHaveBeenCalledExactlyOnceWith(
          fixture.store.create.mock.calls[0]?.[0],
        );
      } else expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
      expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledTimes(0);
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["different image", { url: "https://example.invalid/other.png", flags: 0 }, {}],
    ["meaningful alt text", { description: "alt", flags: 0 }, {}],
    ["different title", { flags: 32 }, { title: "manual title" }],
    ["different color", { flags: 0 }, { color: 1 }],
    ["different description", { flags: 0 }, { description: "manual description" }],
    ["unknown rich state", { flags: 0 }, { future_state: true }],
  ])("keeps %s conservative through the real projector", async (_label, metadata, richState) => {
    for (const deleteResult of [{ outcome: "DELETED" }, { outcome: "UNCONFIRMED" }] as const) {
      const fixture = createFixture({
        sendResult: { outcome: "SENT", message: projectedSentMessage(metadata, richState) },
        deleteResult,
      });
      await expect(fixture.service.send(input)).resolves.toEqual(
        deleteResult.outcome === "DELETED"
          ? { outcome: "FAILURE", code: "PERSISTENCE_UNCONFIRMED_COMPENSATED" }
          : { outcome: "PARTIAL_FAILURE", messageId: "message-id", deletionOutcome: "UNCONFIRMED" },
      );
      expect(fixture.store.create).not.toHaveBeenCalled();
      expect(fixture.store.confirmCreation).not.toHaveBeenCalled();
      expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
      expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
      expect(fixture.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          failureCode: "RETURNED_PAYLOAD_MISMATCH",
        }),
        expect.any(String),
      );
    }
  });

  it("keeps an unreadable creation confirmation and unconfirmed deletion partial with compatible metadata", async () => {
    const fixture = createFixture({
      sendResult: { outcome: "SENT", message: projectedSentMessage({ flags: 0 }) },
      createFailure: new Error("response lost"),
      confirmationFailure: new Error("read failed"),
      deleteResult: { outcome: "UNCONFIRMED" },
    });
    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "UNCONFIRMED",
      messageId: "message-id",
    });
    expect(fixture.store.create).toHaveBeenCalledOnce();
    expect(fixture.store.confirmCreation).toHaveBeenCalledOnce();
    expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
    expect(fixture.discord.deleteManagedMessage).not.toHaveBeenCalled();
    expect(fixture.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "managed_message_persistence_unconfirmed",
        failureCode: "READ_FAILED",
      }),
      expect.any(String),
    );
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
      guildId: input.guildId,
      channelId: input.channelId,
      actorUserId: input.actorUserId,
      payload: canonicalPayload,
      nonce: firstNonce,
    });
    expect(fixture.discord.sendManagedMessage).toHaveBeenNthCalledWith(2, {
      guildId: input.guildId,
      channelId: input.channelId,
      actorUserId: input.actorUserId,
      payload: canonicalPayload,
      nonce: secondNonce,
    });
    expect(fixture.store.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ auditId: "audit-a" }),
      expect.objectContaining({ operationId: "audit-a" }),
    );
    expect(fixture.store.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ auditId: "audit-b" }),
      expect.objectContaining({ operationId: "audit-b" }),
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
    const logs = JSON.stringify(fixture.logger.warn.mock.calls);
    expect(logs).not.toContain(input.payload.content);
    expect(logs).not.toContain("canonical title");
    expect(logs).not.toContain("https://example.invalid/image.png");
  });

  it.each(["MISSING", "CONFLICT"] as const)(
    "compensates once after %s confirmation",
    async (confirmation) => {
      const fixture = createFixture({
        createFailure: new Error("write failed"),
        confirmedRollback: true,
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
      confirmedRollback: true,
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
      confirmedRollback: true,
      confirmation: "MISSING",
      deleteResult: { outcome: "UNCONFIRMED" },
    });

    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: "message-id",
      deletionOutcome: "UNCONFIRMED",
    });
    expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
  });

  it("compensates a returned full-payload mismatch before persistence without resending", async () => {
    const fixture = createFixture({
      sendResult: {
        outcome: "SENT",
        message: {
          messageId: "message-id",
          guildId: input.guildId,
          channelId: input.channelId,
          createdAt,
          payload: { content: input.payload.content, embed: { title: "unexpected" } },
        },
      },
    });
    await expect(fixture.service.send(input)).resolves.toEqual({
      outcome: "FAILURE",
      code: "PERSISTENCE_UNCONFIRMED_COMPENSATED",
    });
    expect(fixture.store.create).not.toHaveBeenCalled();
    expect(fixture.discord.deleteManagedMessage).toHaveBeenCalledOnce();
    expect(fixture.discord.sendManagedMessage).toHaveBeenCalledOnce();
  });
});

const createdAt = new Date("2026-08-31T01:02:03.456Z");
const input = {
  guildId: "guild-id",
  channelId: "channel-id",
  actorUserId: "actor-id",
  payload: {
    content: "exact <@123> content",
    embed: {
      title: "  canonical title  ",
      color: "#00ff00",
      imageUrl: "https://example.invalid/image.png",
    },
  },
};
const canonicalPayload = {
  content: input.payload.content,
  embed: {
    title: "canonical title",
    color: 0x00ff00,
    imageUrl: "https://example.invalid/image.png",
  },
};

function projectedSentMessage(
  metadata: Record<string, unknown>,
  richState: Record<string, unknown> = {},
) {
  return {
    messageId: "message-id",
    guildId: input.guildId,
    channelId: input.channelId,
    createdAt,
    payload: projectManagedMessagePayload({
      content: canonicalPayload.content,
      embeds: [
        {
          data: {
            type: EmbedType.Rich,
            content_scan_version: 2,
            id: "101",
            title: canonicalPayload.embed.title,
            color: canonicalPayload.embed.color,
            image: { url: canonicalPayload.embed.imageUrl, ...metadata },
            ...richState,
          },
        },
      ],
    } as unknown as Message),
  };
}

function createFixture(
  overrides: {
    sendResult?: Awaited<ReturnType<ManagedMessageDiscord["sendManagedMessage"]>>;
    createFailure?: Error;
    confirmedRollback?: boolean;
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
    payload: canonicalPayload,
  };
  const sendManagedMessage = vi.fn(() =>
    Promise.resolve(overrides.sendResult ?? ({ outcome: "SENT", message: sentMessage } as const)),
  );
  const deleteManagedMessage = vi.fn(() =>
    Promise.resolve(overrides.deleteResult ?? ({ outcome: "DELETED" } as const)),
  );
  const editManagedMessage = vi.fn(() => Promise.resolve({ outcome: "UNCHANGED" } as const));
  const restoreManagedMessage = vi.fn(() => Promise.resolve({ outcome: "RESTORED" } as const));
  const create = vi.fn<ManagedMessageStore["create"]>((_input, attempt) => {
    if (attempt && overrides.confirmedRollback)
      attempt.transactionEvidence = {
        disposition: "ROLLED_BACK",
        callbackEntered: true,
        commitAttempted: false,
      };
    return overrides.createFailure === undefined
      ? Promise.resolve({} as never)
      : Promise.reject(overrides.createFailure);
  });
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
