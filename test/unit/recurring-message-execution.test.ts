import { describe, expect, it, vi } from "vitest";
import { ChannelType, EmbedType } from "discord.js";
import type { Client } from "discord.js";
import { createScheduledMessageDiscord } from "../../src/messages/scheduled-message-discord.js";

import {
  createRecurringMessageExecutor,
  deriveRecurringOccurrenceNonce,
  type RecurringDelivery,
} from "../../src/messages/recurring-message-execution.js";
import type { RecurringMessageOccurrence } from "../../src/messages/recurring-message-persistence.js";
import type { RecurringRuntimeStore } from "../../src/messages/recurring-message-runtime-persistence.js";
import {
  decideRecurringRetry,
  RECURRING_RETRY_LIFETIME_MS,
} from "../../src/messages/recurring-message.js";

describe("recurring retry decision", () => {
  const first = new Date("2026-01-01T00:00:00.000Z");
  const deadline = first.getTime() + RECURRING_RETRY_LIFETIME_MS;

  it("allows a candidate wake exactly at the inclusive deadline", () => {
    expect(decideRecurringRetry(first, 2, new Date(deadline - 30_000))).toEqual({
      outcome: "RETRY",
      retryCount: 3,
      wakeAt: new Date(deadline),
    });
  });

  it("rejects a candidate wake one millisecond after the deadline without incrementing", () => {
    expect(decideRecurringRetry(first, 2, new Date(deadline - 29_999))).toEqual({
      outcome: "FAIL",
      failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
    });
  });

  it("gives the exhausted budget precedence over a late candidate wake", () => {
    expect(decideRecurringRetry(first, 3, new Date(deadline))).toEqual({
      outcome: "FAIL",
      failureCode: "CURRENT_STATE_CHECK_FAILED",
    });
  });

  it("gives an observed lifetime expiry precedence over budget exhaustion", () => {
    expect(decideRecurringRetry(first, 3, new Date(deadline + 1))).toEqual({
      outcome: "FAIL",
      failureCode: "PRE_SEND_RETRY_WINDOW_EXCEEDED",
    });
  });
});

describe("recurring occurrence nonce", () => {
  it("is stable, bounded and separated by occurrence", () => {
    const first = deriveRecurringOccurrenceNonce("occurrence-a");
    expect(first).toBe(deriveRecurringOccurrenceNonce("occurrence-a"));
    expect(first).not.toBe(deriveRecurringOccurrenceNonce("occurrence-b"));
    expect(first.length).toBeLessThanOrEqual(25);
  });
});

function executionFixture(imageUrl: string | null = null) {
  const scheduledFor = new Date("2026-01-01T09:00:00.000Z");
  const pending = {
    id: "occurrence",
    scheduledActionId: "series",
    status: "PENDING",
    scheduledFor,
    retryCount: 0,
    claimContent: null,
  } as RecurringMessageOccurrence;
  const claimed = {
    ...pending,
    status: "EXECUTING",
    claimContent: "hello",
    claimEmbedTitle: null,
    claimEmbedDescription: null,
    claimEmbedColor: null,
    claimEmbedImageUrl: imageUrl,
    firstAttemptedAt: scheduledFor,
    claimedAt: scheduledFor,
    claimedSeriesRevision: 0,
    claimedDefinitionRevision: 0,
  } as RecurringMessageOccurrence;
  const definition = {
    action: { id: "series", status: "ACTIVE", guildId: "guild", targetId: "channel" },
    state: {
      revision: 0,
      content: "hello",
      embedTitle: null,
      embedDescription: null,
      embedColor: null,
      embedImageUrl: imageUrl,
    },
    occurrence: pending,
  };
  const store = {
    load: vi.fn().mockResolvedValue(definition),
    resumeRetry: vi.fn().mockResolvedValue(claimed),
    recordPreSendFailure: vi.fn().mockResolvedValue({
      outcome: "RETRY_PENDING",
      retryCount: 1,
      wakeAt: new Date(scheduledFor.getTime() + 30_000),
    }),
    expireRetry: vi.fn().mockResolvedValue("NOT_COMMITTED"),
    terminalize: vi.fn().mockResolvedValue("COMMITTED"),
  };
  const claims = {
    claimInitial: vi.fn().mockResolvedValue({ outcome: "COMMITTED", occurrence: claimed }),
  };
  const target = { guildId: "guild", channelId: "channel", botUserId: "bot", token: {} };
  const discord = {
    preflight: vi.fn().mockResolvedValue({ outcome: "READY", target }),
    createMessage: vi.fn(),
    deleteMessage: vi.fn().mockResolvedValue({ outcome: "DELETED" }),
  };
  const delivery: RecurringDelivery = {
    kind: "recurring-message-occurrence",
    scheduledActionId: "series",
    occurrenceId: "occurrence",
    scheduledFor: scheduledFor.toISOString(),
    seriesRevision: 0,
    retryCount: 0,
  };
  const executor = createRecurringMessageExecutor({
    claims,
    store: store as unknown as RecurringRuntimeStore,
    discord,
    now: () => scheduledFor,
    generateId: vi
      .fn()
      .mockReturnValueOnce("terminal-audit")
      .mockReturnValueOnce("next-occurrence")
      .mockReturnValue("managed-audit"),
  });
  return {
    store,
    claims,
    discord,
    delivery,
    executor,
    target,
    scheduledFor,
    pending,
    claimed,
    definition,
  };
}

function concreteMessage(fixture: ReturnType<typeof executionFixture>) {
  return {
    guildId: "guild",
    channelId: "channel",
    messageId: "message",
    authorId: "bot",
    nonce: deriveRecurringOccurrenceNonce("occurrence"),
    createdAt: fixture.scheduledFor,
    payload: { content: "hello", embed: null },
  };
}

describe("recurring executor ownership and ambiguity", () => {
  it.each([0, 32])(
    "finalizes a claimed image through the real projector with flags %s",
    async (flags) => {
      const f = executionFixture(imageUrl);
      const boundary = connectImageDiscord(f, { flags });
      await expect(f.executor.execute(f.delivery)).resolves.toEqual({ outcome: "COMPLETED" });
      expect(boundary.send).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          content: "hello",
          nonce: deriveRecurringOccurrenceNonce("occurrence"),
          enforceNonce: true,
          allowedMentions: { parse: [] },
        }),
      );
      expect(f.store.terminalize).toHaveBeenCalledExactlyOnceWith({
        occurrenceId: "occurrence",
        auditId: "terminal-audit",
        nextOccurrenceId: "next-occurrence",
        occurredAt: f.scheduledFor,
        resultMessageId: "message",
        messageCreatedAt: f.scheduledFor,
        managedMessageAuditId: "managed-audit",
      });
      expect(f.claims.claimInitial).toHaveBeenCalledExactlyOnceWith({
        occurrenceId: "occurrence",
        expectedSeriesRevision: 0,
        claimedAt: f.scheduledFor,
      });
      expect(f.discord.createMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: { content: "hello", embed: { imageUrl } },
        }),
      );
      expect(boundary.deleteRequest).not.toHaveBeenCalled();
      expect(f.store.recordPreSendFailure).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["different URL", { url: "https://example.invalid/different.png", flags: 0 }, undefined],
    ["unsupported metadata", { flags: 33 }, undefined],
    ["wrong nonce", { flags: 32 }, "wrong-nonce"],
  ])(
    "rejects recurring image delivery %s through the shared boundary",
    async (_label, image, nonce) => {
      const f = executionFixture(imageUrl);
      const boundary = connectImageDiscord(f, image, nonce);
      await expect(f.executor.execute(f.delivery)).resolves.toEqual({
        outcome: "FAILED",
        code: "RETURNED_MESSAGE_MISMATCH",
      });
      expect(f.store.terminalize).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          failureCode: "RETURNED_MESSAGE_MISMATCH",
          resultMessageId: "message",
        }),
      );
      expect(f.store.terminalize.mock.calls[0]?.[0]).not.toHaveProperty("managedMessageAuditId");
      expect(f.store.recordPreSendFailure).not.toHaveBeenCalled();
      expect(boundary.send).toHaveBeenCalledOnce();
      expect(boundary.deleteRequest).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["unknown commit", "UNKNOWN", false, { outcome: "UNCONFIRMED" }, 0],
    [
      "uncommitted",
      "NOT_COMMITTED",
      false,
      { outcome: "FAILED", code: "FINALIZATION_FAILED_COMPENSATED" },
      1,
    ],
    [
      "unconfirmed deletion",
      "NOT_COMMITTED",
      true,
      { outcome: "FAILED", code: "FINALIZATION_FAILED_UNCOMPENSATED" },
      1,
    ],
  ] as const)(
    "preserves recurring image finalization: %s",
    async (_label, commit, deleteFails, expected, deletes) => {
      const f = executionFixture(imageUrl);
      const boundary = connectImageDiscord(f, { flags: 32 });
      f.store.terminalize.mockResolvedValueOnce(commit);
      if (deleteFails) boundary.deleteRequest.mockRejectedValue(new Error("response lost"));
      await expect(f.executor.execute(f.delivery)).resolves.toEqual(expected);
      expect(boundary.send).toHaveBeenCalledOnce();
      expect(boundary.deleteRequest).toHaveBeenCalledTimes(deletes);
      expect(f.store.recordPreSendFailure).not.toHaveBeenCalled();
      expect(f.store.terminalize).toHaveBeenCalledTimes(commit === "UNKNOWN" ? 1 : 2);
      if ("code" in expected)
        expect(f.store.terminalize).toHaveBeenLastCalledWith(
          expect.objectContaining({
            failureCode: expected.code,
            ...(deleteFails ? { resultMessageId: "message" } : {}),
          }),
        );
    },
  );

  it("limits ambiguous image sends to the existing one same-nonce replay", async () => {
    const f = executionFixture(imageUrl);
    const boundary = connectImageDiscord(f, { flags: 0 });
    boundary.send.mockRejectedValue(new Error("response lost"));
    await expect(f.executor.execute(f.delivery)).resolves.toEqual({
      outcome: "FAILED",
      code: "SEND_UNCONFIRMED",
    });
    expect(boundary.send).toHaveBeenCalledTimes(2);
    expect(boundary.send.mock.calls[0]).toEqual(boundary.send.mock.calls[1]);
    expect(boundary.deleteRequest).not.toHaveBeenCalled();
    expect(f.store.recordPreSendFailure).not.toHaveBeenCalled();
    expect(f.store.terminalize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ failureCode: "SEND_UNCONFIRMED" }),
    );
  });

  it.each([
    ["COMMITTED", { outcome: "FAILED", code: "PRE_SEND_RETRY_WINDOW_EXCEEDED" }],
    ["NOT_COMMITTED", { outcome: "SKIPPED" }],
    ["UNKNOWN", { outcome: "UNCONFIRMED" }],
  ] as const)(
    "uses guarded retry expiry result %s without general terminalization",
    async (result, expected) => {
      const fixture = executionFixture();
      fixture.store.expireRetry.mockResolvedValue(result);
      fixture.store.load.mockResolvedValue({
        ...fixture.definition,
        occurrence: { ...fixture.claimed, status: "RETRY_PENDING", retryCount: 1 },
      });
      const lateExecutor = createRecurringMessageExecutor({
        claims: fixture.claims,
        store: fixture.store as unknown as RecurringRuntimeStore,
        discord: fixture.discord,
        now: () => new Date(fixture.scheduledFor.getTime() + 15 * 60_000 + 1),
      });
      expect(await lateExecutor.execute({ ...fixture.delivery, retryCount: 1 })).toEqual(expected);
      expect(fixture.store.expireRetry).toHaveBeenCalledWith(
        expect.objectContaining({ occurrenceId: "occurrence", expectedRetryCount: 1 }),
      );
      expect(fixture.store.terminalize).not.toHaveBeenCalled();
      expect(fixture.discord.createMessage).not.toHaveBeenCalled();
    },
  );

  it("uses the immutable claim payload during retry preflight", async () => {
    const fixture = executionFixture();
    fixture.store.load.mockResolvedValue({
      ...fixture.definition,
      state: { ...fixture.definition.state, content: "edited" },
      occurrence: { ...fixture.claimed, status: "RETRY_PENDING", retryCount: 1 },
    });
    fixture.store.resumeRetry = vi.fn().mockResolvedValue({ ...fixture.claimed, retryCount: 1 });
    fixture.discord.createMessage.mockResolvedValue({ outcome: "REJECTED" });
    const result = await fixture.executor.execute({ ...fixture.delivery, retryCount: 1 });
    expect(result).toEqual({ outcome: "FAILED", code: "SEND_REJECTED" });
    expect(fixture.discord.preflight).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { content: "hello", embed: null } }),
    );
  });
  it("finalizes a direct concrete Create success", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage.mockResolvedValue({
      outcome: "CREATED",
      message: concreteMessage(fixture),
    });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({ outcome: "COMPLETED" });
    expect(fixture.discord.createMessage).toHaveBeenCalledOnce();
    expect(fixture.store.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({
        resultMessageId: "message",
      }),
    );
  });

  it("ignores stale series revision metadata when the occurrence is otherwise eligible", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage.mockResolvedValue({ outcome: "REJECTED" });
    expect(await fixture.executor.execute({ ...fixture.delivery, seriesRevision: 999 })).toEqual({
      outcome: "FAILED",
      code: "SEND_REJECTED",
    });
    expect(fixture.claims.claimInitial).toHaveBeenCalledOnce();
  });

  it("terminalizes a definite initial Create rejection", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage.mockResolvedValue({ outcome: "REJECTED" });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({
      outcome: "FAILED",
      code: "SEND_REJECTED",
    });
    expect(fixture.discord.createMessage).toHaveBeenCalledOnce();
  });

  it("finalizes an ambiguous initial Create when the same-nonce replay succeeds", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage
      .mockResolvedValueOnce({ outcome: "AMBIGUOUS" })
      .mockResolvedValueOnce({ outcome: "CREATED", message: concreteMessage(fixture) });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({ outcome: "COMPLETED" });
    expect(fixture.discord.createMessage).toHaveBeenCalledTimes(2);
  });

  it("terminalizes two ambiguous Create outcomes without a later retry", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage.mockResolvedValue({ outcome: "AMBIGUOUS" });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({
      outcome: "FAILED",
      code: "SEND_UNCONFIRMED",
    });
    expect(fixture.discord.createMessage).toHaveBeenCalledTimes(2);
    expect(fixture.store.recordPreSendFailure).not.toHaveBeenCalled();
  });

  it("compensates a concrete returned-message mismatch without resending", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage.mockResolvedValue({
      outcome: "CREATED",
      message: { ...concreteMessage(fixture), authorId: "other" },
    });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({
      outcome: "FAILED",
      code: "RETURNED_MESSAGE_MISMATCH",
    });
    expect(fixture.discord.deleteMessage).toHaveBeenCalledOnce();
    expect(fixture.discord.createMessage).toHaveBeenCalledOnce();
  });

  it.each(["DELETED", "UNCONFIRMED"] as const)(
    "records compensation result %s after proven non-commit",
    async (outcome) => {
      const fixture = executionFixture();
      fixture.discord.createMessage.mockResolvedValue({
        outcome: "CREATED",
        message: concreteMessage(fixture),
      });
      fixture.store.terminalize
        .mockResolvedValueOnce("NOT_COMMITTED")
        .mockResolvedValueOnce("COMMITTED");
      fixture.discord.deleteMessage.mockResolvedValue({ outcome });
      expect(await fixture.executor.execute(fixture.delivery)).toEqual({
        outcome: "FAILED",
        code:
          outcome === "DELETED"
            ? "FINALIZATION_FAILED_COMPENSATED"
            : "FINALIZATION_FAILED_UNCOMPENSATED",
      });
      expect(fixture.discord.deleteMessage).toHaveBeenCalledOnce();
    },
  );
  it("makes a claim loser perform no failure transition or Discord Create", async () => {
    const fixture = executionFixture();
    fixture.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });
    fixture.claims.claimInitial.mockResolvedValue({ outcome: "NOT_CLAIMED" });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({ outcome: "SKIPPED" });
    expect(fixture.store.terminalize).not.toHaveBeenCalled();
    expect(fixture.store.recordPreSendFailure).not.toHaveBeenCalled();
    expect(fixture.discord.createMessage).not.toHaveBeenCalled();
  });

  it("rejects a delivery whose occurrence has no recurring discriminator", async () => {
    const fixture = executionFixture();
    fixture.store.load.mockResolvedValue(undefined);
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({ outcome: "SKIPPED" });
    expect(fixture.discord.preflight).not.toHaveBeenCalled();
    expect(fixture.discord.createMessage).not.toHaveBeenCalled();
  });

  it("records a retryable preflight failure only after winning the claim", async () => {
    const fixture = executionFixture();
    fixture.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
      retryable: true,
    });
    expect(await fixture.executor.execute(fixture.delivery)).toMatchObject({
      outcome: "RETRY_PENDING",
      retryCount: 1,
    });
    expect(fixture.claims.claimInitial).toHaveBeenCalledOnce();
    expect(fixture.store.recordPreSendFailure).toHaveBeenCalledOnce();
    expect(fixture.discord.createMessage).not.toHaveBeenCalled();
  });

  it("records a terminal preflight failure only after winning the claim", async () => {
    const fixture = executionFixture();
    fixture.discord.preflight.mockResolvedValue({
      outcome: "FAILURE",
      code: "BOT_PERMISSION_MISSING",
      retryable: false,
    });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({
      outcome: "FAILED",
      code: "BOT_PERMISSION_MISSING",
    });
    expect(fixture.store.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "BOT_PERMISSION_MISSING" }),
    );
    expect(fixture.discord.createMessage).not.toHaveBeenCalled();
  });

  it("terminalizes ambiguous initial Create followed by replay rejection", async () => {
    const fixture = executionFixture();
    fixture.discord.createMessage
      .mockResolvedValueOnce({ outcome: "AMBIGUOUS" })
      .mockResolvedValueOnce({ outcome: "REJECTED" });
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({
      outcome: "FAILED",
      code: "SEND_UNCONFIRMED",
    });
    expect(fixture.discord.createMessage).toHaveBeenCalledTimes(2);
    expect(fixture.discord.createMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nonce: deriveRecurringOccurrenceNonce("occurrence") }),
    );
    expect(fixture.discord.createMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nonce: deriveRecurringOccurrenceNonce("occurrence") }),
    );
    expect(fixture.store.terminalize).toHaveBeenCalledWith(
      expect.objectContaining({ failureCode: "SEND_UNCONFIRMED" }),
    );
  });

  it("does not delete or resend when finalization confirmation is unknown", async () => {
    const fixture = executionFixture();
    const nonce = deriveRecurringOccurrenceNonce("occurrence");
    fixture.discord.createMessage.mockResolvedValue({
      outcome: "CREATED",
      message: {
        guildId: "guild",
        channelId: "channel",
        messageId: "message",
        authorId: "bot",
        nonce,
        createdAt: fixture.scheduledFor,
        payload: { content: "hello", embed: null },
      },
    });
    fixture.store.terminalize.mockResolvedValue("UNKNOWN");
    expect(await fixture.executor.execute(fixture.delivery)).toEqual({ outcome: "UNCONFIRMED" });
    expect(fixture.discord.createMessage).toHaveBeenCalledOnce();
    expect(fixture.discord.deleteMessage).not.toHaveBeenCalled();
  });
});

const imageUrl = "https://example.invalid/image.png";

function connectImageDiscord(
  f: ReturnType<typeof executionFixture>,
  image: Record<string, unknown>,
  nonce = deriveRecurringOccurrenceNonce("occurrence"),
) {
  const send = vi.fn().mockResolvedValue({
    id: "message",
    guildId: "guild",
    channelId: "channel",
    author: { id: "bot" },
    nonce,
    createdAt: f.scheduledFor,
    content: "hello",
    embeds: [
      {
        data: {
          type: EmbedType.Rich,
          content_scan_version: 2,
          id: "101",
          flags: 0,
          image: {
            url: imageUrl,
            description: "",
            proxy_url: "https://proxy.invalid/image.png",
            width: 100,
            height: 50,
            ...image,
          },
        },
      },
    ],
  });
  f.target.token = { type: ChannelType.GuildText, send };
  const deleteRequest = vi.fn().mockResolvedValue(undefined);
  const discord = createScheduledMessageDiscord({
    rest: { delete: deleteRequest },
  } as unknown as Client);
  f.discord.createMessage.mockImplementation(discord.createMessage);
  f.discord.deleteMessage.mockImplementation(discord.deleteMessage);
  return { send, deleteRequest };
}
