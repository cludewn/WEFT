import { describe, expect, it, vi } from "vitest";

import type { ManagedMessageDiscord } from "../../src/managed-message-discord.js";
import type { ManagedMessage, ManagedMessageStore } from "../../src/managed-message-persistence.js";
import { createManagedMessageService } from "../../src/managed-message.js";

const editedAt = new Date("2026-08-31T08:09:10.000Z");
const baseInput = {
  guildId: "700000000000000001",
  channelId: "800000000000000001",
  messageId: "900000000000000001",
  actorUserId: "600000000000000001",
  expectedRevision: 1,
  payload: { content: "new content", embed: { title: "new embed", color: 0 } },
};
const oldPayload = { content: "old content", embed: { title: "old embed" } } as const;

describe("managed message edit service", () => {
  it("rejects a stale revision before any Discord inspection", async () => {
    const fixture = createFixture({ row: managedRow({ revision: 2 }) });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "CONFLICT",
    });
    expect(fixture.discord.editManagedMessage).not.toHaveBeenCalled();
  });

  it("inspects Discord before returning UNCHANGED and performs no persistence write", async () => {
    const fixture = createFixture({ editResult: { outcome: "UNCHANGED" } });

    await expect(fixture.service.edit({ ...baseInput, payload: oldPayload })).resolves.toEqual({
      outcome: "UNCHANGED",
    });
    expect(fixture.discord.editManagedMessage).toHaveBeenCalledExactlyOnceWith({
      guildId: baseInput.guildId,
      channelId: baseInput.channelId,
      messageId: baseInput.messageId,
      actorUserId: baseInput.actorUserId,
      payload: oldPayload,
      previousPayload: oldPayload,
    });
    expect(fixture.store.edit).not.toHaveBeenCalled();
    expect(fixture.store.markDeleted).not.toHaveBeenCalled();
  });

  it("returns state mismatch without changing Discord or PostgreSQL managed state", async () => {
    const fixture = createFixture({
      editResult: { outcome: "FAILURE", code: "STATE_MISMATCH" },
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "STATE_MISMATCH",
    });
    expect(fixture.store.edit).not.toHaveBeenCalled();
    expect(fixture.store.markDeleted).not.toHaveBeenCalled();
  });

  it("persists one revision transition and EDITED audit intent after Discord confirms the edit", async () => {
    const fixture = createFixture();

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "SUCCESS",
      messageId: baseInput.messageId,
      revision: 2,
    });
    expect(fixture.store.edit).toHaveBeenCalledExactlyOnceWith({
      auditId: "audit-id",
      messageId: baseInput.messageId,
      guildId: baseInput.guildId,
      channelId: baseInput.channelId,
      actorUserId: baseInput.actorUserId,
      expectedRevision: 1,
      previousPayload: oldPayload,
      payload: baseInput.payload,
      occurredAt: editedAt,
    });
    expect(fixture.store.confirmEdit).not.toHaveBeenCalled();
  });

  it("gives confirmed deletion precedence over an apparent no-op and persists detection once", async () => {
    const fixture = createFixture({ editResult: { outcome: "DELETED" } });

    await expect(fixture.service.edit({ ...baseInput, payload: oldPayload })).resolves.toEqual({
      outcome: "DELETED",
    });
    expect(fixture.store.markDeleted).toHaveBeenCalledExactlyOnceWith({
      auditId: "audit-id",
      messageId: baseInput.messageId,
      guildId: baseInput.guildId,
      channelId: baseInput.channelId,
      expectedRevision: 1,
      payload: oldPayload,
      occurredAt: new Date("2026-08-31T09:10:11.000Z"),
    });
    expect(fixture.store.edit).not.toHaveBeenCalled();
  });

  it("accepts exact deletion confirmation after ambiguous persistence without retrying", async () => {
    const fixture = createFixture({
      editResult: { outcome: "DELETED" },
      deletionFailure: new Error("ambiguous deletion transaction"),
      deletionConfirmation: "MATCH",
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({ outcome: "DELETED" });
    expect(fixture.store.markDeleted).toHaveBeenCalledOnce();
    expect(fixture.store.confirmDeletion).toHaveBeenCalledOnce();
    expect(fixture.store.confirmDeletion.mock.calls[0]?.[0]).toBe(
      fixture.store.markDeleted.mock.calls[0]?.[0],
    );
    expect(fixture.generateAuditId).toHaveBeenCalledOnce();
  });

  it("does not claim deletion persistence after ambiguous persistence and non-match", async () => {
    const fixture = createFixture({
      editResult: { outcome: "DELETED" },
      deletionFailure: new Error("ambiguous deletion transaction"),
      deletionConfirmation: "CONFLICT",
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: baseInput.messageId,
      kind: "DELETION_DETECTION",
    });
    expect(fixture.store.markDeleted).toHaveBeenCalledOnce();
    expect(fixture.store.confirmDeletion).toHaveBeenCalledOnce();
    expect(fixture.store.confirmDeletion.mock.calls[0]?.[0]).toBe(
      fixture.store.markDeleted.mock.calls[0]?.[0],
    );
    expect(fixture.generateAuditId).toHaveBeenCalledOnce();
  });

  it("keeps deletion persistence bounded when exact confirmation read fails", async () => {
    const fixture = createFixture({
      editResult: { outcome: "DELETED" },
      deletionFailure: new Error("ambiguous deletion transaction"),
      deletionConfirmationFailure: new Error("sensitive confirmation detail"),
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: baseInput.messageId,
      kind: "DELETION_DETECTION",
    });
    expect(fixture.store.markDeleted).toHaveBeenCalledOnce();
    expect(fixture.store.confirmDeletion).toHaveBeenCalledOnce();
    expect(fixture.generateAuditId).toHaveBeenCalledOnce();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(
      "sensitive confirmation detail",
    );
  });

  it("accepts exact row-and-audit confirmation after an ambiguous edit finalization", async () => {
    const fixture = createFixture({
      editFailure: new Error("sensitive database detail"),
      editConfirmation: "MATCH",
    });

    await expect(fixture.service.edit(baseInput)).resolves.toMatchObject({ outcome: "SUCCESS" });
    expect(fixture.store.edit).toHaveBeenCalledOnce();
    expect(fixture.store.confirmEdit).toHaveBeenCalledOnce();
    expect(fixture.discord.restoreManagedMessage).not.toHaveBeenCalled();
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(baseInput.payload.content);
  });

  it("restores once only when database and Discord compensation preconditions are exact", async () => {
    const fixture = createFixture({
      editTransition: "NOT_TRANSITIONED",
      editConfirmation: "MISSING",
      compensationSafety: "SAFE",
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "FAILURE",
      code: "PERSISTENCE_UNCONFIRMED_COMPENSATED",
    });
    expect(fixture.discord.restoreManagedMessage).toHaveBeenCalledExactlyOnceWith({
      guildId: baseInput.guildId,
      channelId: baseInput.channelId,
      messageId: baseInput.messageId,
      expectedPayload: baseInput.payload,
      expectedEditedAt: editedAt,
      restorePayload: oldPayload,
    });
  });

  it("does not restore when the database safety read is not exact", async () => {
    const fixture = createFixture({
      editTransition: "NOT_TRANSITIONED",
      editConfirmation: "CONFLICT",
      compensationSafety: "UNSAFE",
    });

    await expect(fixture.service.edit(baseInput)).resolves.toEqual({
      outcome: "PARTIAL_FAILURE",
      messageId: baseInput.messageId,
      kind: "EDIT",
    });
    expect(fixture.discord.restoreManagedMessage).not.toHaveBeenCalled();
  });

  it("serializes same-message edits through finalization and rejects the stale follower", async () => {
    let settleFirst!: () => void;
    const firstDiscord = new Promise<{ outcome: "EDITED"; editedAt: Date }>((resolve) => {
      settleFirst = () => resolve({ outcome: "EDITED", editedAt });
    });
    const fixture = createFixture();
    vi.mocked(fixture.store.find)
      .mockResolvedValueOnce(managedRow())
      .mockResolvedValueOnce(
        managedRow({ revision: 2, payload: { content: "first", embed: null } }),
      );
    vi.mocked(fixture.discord.editManagedMessage).mockImplementationOnce(() => firstDiscord);

    const first = fixture.service.edit({
      ...baseInput,
      payload: { content: "first", embed: null },
    });
    const second = fixture.service.edit({
      ...baseInput,
      payload: { content: "second", embed: null },
    });
    await vi.waitFor(() => expect(fixture.discord.editManagedMessage).toHaveBeenCalledOnce());
    expect(fixture.store.find).toHaveBeenCalledOnce();

    settleFirst();
    await expect(first).resolves.toMatchObject({ outcome: "SUCCESS" });
    await expect(second).resolves.toEqual({ outcome: "FAILURE", code: "CONFLICT" });
    expect(fixture.discord.editManagedMessage).toHaveBeenCalledOnce();
  });

  it("serializes same-revision edits with competing embed title and color", async () => {
    let settleFirst!: () => void;
    const firstDiscord = new Promise<{ outcome: "EDITED"; editedAt: Date }>((resolve) => {
      settleFirst = () => resolve({ outcome: "EDITED", editedAt });
    });
    const firstPayload = {
      content: "same content",
      embed: { title: "Winner A", color: 0xaaaaaa },
    };
    const secondPayload = {
      content: "same content",
      embed: { title: "Winner B", color: 0xbbbbbb },
    };
    const fixture = createFixture();
    vi.mocked(fixture.store.find)
      .mockResolvedValueOnce(managedRow())
      .mockResolvedValueOnce(managedRow({ revision: 2, payload: firstPayload }));
    vi.mocked(fixture.discord.editManagedMessage).mockImplementationOnce(() => firstDiscord);

    const first = fixture.service.edit({ ...baseInput, payload: firstPayload });
    const second = fixture.service.edit({ ...baseInput, payload: secondPayload });
    await vi.waitFor(() => expect(fixture.discord.editManagedMessage).toHaveBeenCalledOnce());

    settleFirst();
    await expect(first).resolves.toMatchObject({ outcome: "SUCCESS" });
    await expect(second).resolves.toEqual({ outcome: "FAILURE", code: "CONFLICT" });
    expect(fixture.discord.editManagedMessage).toHaveBeenCalledOnce();
  });

  it("releases the same-message FIFO after a failed operation", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.discord.editManagedMessage)
      .mockRejectedValueOnce(new Error("unexpected boundary rejection"))
      .mockResolvedValueOnce({ outcome: "UNCHANGED" });

    const first = fixture.service.edit(baseInput);
    const second = fixture.service.edit({ ...baseInput, payload: oldPayload });
    await expect(first).resolves.toEqual({
      outcome: "FAILURE",
      code: "CURRENT_STATE_CHECK_FAILED",
    });
    await expect(second).resolves.toEqual({ outcome: "UNCHANGED" });
    expect(fixture.discord.editManagedMessage).toHaveBeenCalledTimes(2);
  });

  it("allows different message IDs to progress independently", async () => {
    let settleFirst!: () => void;
    const firstDiscord = new Promise<{ outcome: "EDITED"; editedAt: Date }>((resolve) => {
      settleFirst = () => resolve({ outcome: "EDITED", editedAt });
    });
    const fixture = createFixture();
    vi.mocked(fixture.store.find).mockImplementation((messageId) =>
      Promise.resolve(managedRow({ messageId })),
    );
    vi.mocked(fixture.discord.editManagedMessage)
      .mockImplementationOnce(() => firstDiscord)
      .mockResolvedValueOnce({ outcome: "UNCHANGED" });

    const first = fixture.service.edit(baseInput);
    const second = fixture.service.edit({
      ...baseInput,
      messageId: "900000000000000002",
      payload: oldPayload,
    });
    await vi.waitFor(() => expect(fixture.discord.editManagedMessage).toHaveBeenCalledTimes(2));
    await expect(second).resolves.toEqual({ outcome: "UNCHANGED" });
    settleFirst();
    await expect(first).resolves.toMatchObject({ outcome: "SUCCESS" });
  });
});

function managedRow(overrides: Partial<ManagedMessage> = {}): ManagedMessage {
  return {
    messageId: baseInput.messageId,
    guildId: baseInput.guildId,
    channelId: baseInput.channelId,
    creatorUserId: "500000000000000001",
    payload: oldPayload,
    revision: 1,
    status: "ACTIVE",
    createdAt: new Date("2026-08-31T01:02:03.000Z"),
    updatedAt: new Date("2026-08-31T01:02:03.000Z"),
    ...overrides,
  };
}

function createFixture(
  overrides: {
    row?: ManagedMessage;
    editResult?: Awaited<ReturnType<ManagedMessageDiscord["editManagedMessage"]>>;
    editTransition?: "TRANSITIONED" | "NOT_TRANSITIONED";
    editFailure?: Error;
    editConfirmation?: "MATCH" | "MISSING" | "CONFLICT";
    compensationSafety?: "SAFE" | "UNSAFE";
    deletionFailure?: Error;
    deletionConfirmation?: "MATCH" | "MISSING" | "CONFLICT";
    deletionConfirmationFailure?: Error;
  } = {},
) {
  const editManagedMessage = vi.fn(() =>
    Promise.resolve(overrides.editResult ?? ({ outcome: "EDITED", editedAt } as const)),
  );
  const restoreManagedMessage = vi.fn(() => Promise.resolve({ outcome: "RESTORED" } as const));
  const discord = {
    sendManagedMessage: vi.fn(),
    deleteManagedMessage: vi.fn(),
    editManagedMessage,
    restoreManagedMessage,
  } satisfies ManagedMessageDiscord;
  const edit = vi.fn(() =>
    overrides.editFailure === undefined
      ? Promise.resolve(overrides.editTransition ?? "TRANSITIONED")
      : Promise.reject(overrides.editFailure),
  );
  const markDeleted = vi.fn<ManagedMessageStore["markDeleted"]>(() =>
    overrides.deletionFailure === undefined
      ? Promise.resolve("TRANSITIONED" as const)
      : Promise.reject(overrides.deletionFailure),
  );
  const confirmDeletion = vi.fn<ManagedMessageStore["confirmDeletion"]>(() =>
    overrides.deletionConfirmationFailure === undefined
      ? Promise.resolve(overrides.deletionConfirmation ?? "MISSING")
      : Promise.reject(overrides.deletionConfirmationFailure),
  );
  const store = {
    find: vi.fn((messageId: string) => {
      void messageId;
      return Promise.resolve(overrides.row ?? managedRow());
    }),
    create: vi.fn(),
    confirmCreation: vi.fn(),
    edit,
    confirmEdit: vi.fn(() => Promise.resolve(overrides.editConfirmation ?? "MISSING")),
    markDeleted,
    confirmDeletion,
    readCompensationSafety: vi.fn(() => Promise.resolve(overrides.compensationSafety ?? "UNSAFE")),
  } satisfies ManagedMessageStore;
  const logger = { warn: vi.fn() };
  const generateAuditId = vi.fn(() => "audit-id");
  const service = createManagedMessageService({
    discord,
    store,
    logger,
    generateAuditId,
    now: () => new Date("2026-08-31T09:10:11.000Z"),
  });
  return { service, discord, store, logger, generateAuditId };
}
