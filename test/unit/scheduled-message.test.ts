import { describe, expect, it, vi } from "vitest";

import type { ScheduledAction } from "../../src/scheduled-action-persistence.js";
import {
  matchesScheduledMessageCreation,
  scheduledMessagePayloadFromColumns,
  scheduledMessagePayloadToColumns,
  type CreateScheduledMessage,
  type ScheduledMessageAudit,
  type ScheduledMessageState,
  type ScheduledMessageStore,
} from "../../src/scheduled-message-persistence.js";
import { createScheduledMessageService } from "../../src/scheduled-message.js";

const executeAt = new Date("2030-01-02T03:04:05.678Z");
const occurredAt = new Date("2026-09-16T01:02:03.456Z");

describe("scheduled message payload persistence mapping", () => {
  it.each([
    { content: "text only", embed: null },
    { content: "", embed: { title: "embed only" } },
    {
      content: "combined",
      embed: {
        title: "title",
        description: "description",
        color: 0,
        imageUrl: "https://example.invalid/image.png",
      },
    },
    { content: "nullable fields", embed: { description: "description", color: 0 } },
  ])("round-trips canonical payload %#", (payload) => {
    expect(scheduledMessagePayloadFromColumns(scheduledMessagePayloadToColumns(payload))).toEqual(
      payload,
    );
  });

  it("maps an absent embed to nullable columns without losing black color", () => {
    expect(scheduledMessagePayloadToColumns({ content: "text", embed: null })).toEqual({
      content: "text",
      embedTitle: null,
      embedDescription: null,
      embedColor: null,
      embedImageUrl: null,
    });
    expect(
      scheduledMessagePayloadToColumns({ content: "", embed: { title: "black", color: 0 } }),
    ).toMatchObject({ embedTitle: "black", embedColor: 0 });
  });
});

describe("scheduled message exact creation confirmation", () => {
  const expected: CreateScheduledMessage = {
    scheduledActionId: "scheduled-action-id",
    auditId: "audit-id",
    guildId: "guild-id",
    channelId: "channel-id",
    actorId: "actor-id",
    executeAt,
    payload: {
      content: "content",
      embed: {
        title: "title",
        description: "description",
        color: 0,
        imageUrl: "https://example.invalid/image.png",
      },
    },
    occurredAt,
  };
  const action: ScheduledAction = {
    id: expected.scheduledActionId,
    guildId: expected.guildId,
    actionType: "SEND_MESSAGE",
    targetId: expected.channelId,
    status: "ACTIVE",
    executeAt,
    createdAt: new Date("2026-09-16T01:02:04.000Z"),
    updatedAt: new Date("2026-09-16T01:02:05.000Z"),
  };
  const state: ScheduledMessageState = {
    scheduledActionId: expected.scheduledActionId,
    ...scheduledMessagePayloadToColumns(expected.payload),
    resultMessageId: null,
  };
  const audit: ScheduledMessageAudit = {
    id: expected.auditId,
    scheduledActionId: expected.scheduledActionId,
    guildId: expected.guildId,
    channelId: expected.channelId,
    event: "CREATED",
    actorType: "USER",
    actorId: expected.actorId,
    executeAt,
    ...scheduledMessagePayloadToColumns(expected.payload),
    occurredAt,
    outcome: "SUCCESS",
  };

  it("accepts only the exact action, state, and audit", () => {
    expect(matchesScheduledMessageCreation(action, state, audit, expected)).toBe(true);
    expect(matchesScheduledMessageCreation(action, undefined, audit, expected)).toBe(false);
    expect(matchesScheduledMessageCreation(action, state, undefined, expected)).toBe(false);
    expect(matchesScheduledMessageCreation(action, undefined, undefined, expected)).toBe(false);
  });

  it.each([
    ["wrong audit ID", action, state, { ...audit, id: "wrong-audit" }],
    ["wrong action ID", { ...action, id: "wrong-action" }, state, audit],
    ["wrong state action ID", action, { ...state, scheduledActionId: "wrong-action" }, audit],
    ["wrong audit action ID", action, state, { ...audit, scheduledActionId: "wrong-action" }],
    ["wrong guild", { ...action, guildId: "wrong-guild" }, state, audit],
    ["wrong audit guild", action, state, { ...audit, guildId: "wrong-guild" }],
    ["wrong channel", { ...action, targetId: "wrong-channel" }, state, audit],
    ["wrong audit channel", action, state, { ...audit, channelId: "wrong-channel" }],
    ["wrong action type", { ...action, actionType: "CLOSE_THREAD" }, state, audit],
    ["wrong status", { ...action, status: "EXECUTING" }, state, audit],
    ["wrong executeAt", { ...action, executeAt: new Date(executeAt.getTime() + 1) }, state, audit],
    [
      "wrong audit executeAt",
      action,
      state,
      { ...audit, executeAt: new Date(executeAt.getTime() + 1) },
    ],
    ["wrong content", action, { ...state, content: "wrong" }, audit],
    ["wrong embed title", action, { ...state, embedTitle: "wrong" }, audit],
    ["wrong embed description", action, { ...state, embedDescription: "wrong" }, audit],
    ["wrong embed color", action, { ...state, embedColor: 1 }, audit],
    ["wrong embed image URL", action, { ...state, embedImageUrl: "https://wrong.invalid/" }, audit],
    ["wrong audit content", action, state, { ...audit, content: "wrong" }],
    ["wrong audit embed title", action, state, { ...audit, embedTitle: "wrong" }],
    ["wrong audit embed description", action, state, { ...audit, embedDescription: "wrong" }],
    ["wrong audit embed color", action, state, { ...audit, embedColor: 1 }],
    [
      "wrong audit embed image URL",
      action,
      state,
      { ...audit, embedImageUrl: "https://wrong.invalid/" },
    ],
    ["result message already assigned", action, { ...state, resultMessageId: "message-id" }, audit],
    ["wrong actor", action, state, { ...audit, actorId: "wrong-actor" }],
    [
      "wrong occurredAt",
      action,
      state,
      { ...audit, occurredAt: new Date(occurredAt.getTime() + 1) },
    ],
    ["wrong event", action, state, { ...audit, event: "WRONG" }],
    ["wrong actor type", action, state, { ...audit, actorType: "SYSTEM" }],
    ["wrong outcome", action, state, { ...audit, outcome: "FAILURE" }],
  ] as const)("rejects %s", (_label, candidateAction, candidateState, candidateAudit) => {
    expect(
      matchesScheduledMessageCreation(
        candidateAction as ScheduledAction,
        candidateState as ScheduledMessageState,
        candidateAudit as ScheduledMessageAudit,
        expected,
      ),
    ).toBe(false);
  });
});

describe("scheduled message application operation", () => {
  it("validates through the canonical payload validator before persistence", async () => {
    const store = { create: vi.fn() };
    const generateId = vi.fn();
    const now = vi.fn();
    const service = createScheduledMessageService({ store, generateId, now });

    await expect(
      service.create({
        guildId: "guild-id",
        channelId: "channel-id",
        actorId: "actor-id",
        executeAt,
        payload: { content: "   ", embed: null },
      }),
    ).resolves.toEqual({ ok: false, code: "EMPTY_CONTENT" });
    expect(store.create).not.toHaveBeenCalled();
    expect(generateId).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it("generates stable identifiers and occurredAt once and passes normalized payload", async () => {
    const definition = {
      action: {
        id: "scheduled-action-id",
        guildId: "guild-id",
        actionType: "SEND_MESSAGE",
        targetId: "channel-id",
        status: "ACTIVE",
        executeAt,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      },
      payload: { content: "", embed: { title: "title", color: 0 } },
      resultMessageId: null,
    } satisfies Awaited<ReturnType<ScheduledMessageStore["create"]>>;
    const store = { create: vi.fn().mockResolvedValue(definition) };
    const generateId = vi
      .fn<() => string>()
      .mockReturnValueOnce("scheduled-action-id")
      .mockReturnValueOnce("audit-id");
    const now = vi.fn(() => occurredAt);
    const service = createScheduledMessageService({ store, generateId, now });

    await expect(
      service.create({
        guildId: "guild-id",
        channelId: "channel-id",
        actorId: "actor-id",
        executeAt,
        payload: { content: "", embed: { title: "  title  ", color: "000000" } },
      }),
    ).resolves.toEqual({ ok: true, definition });

    expect(generateId).toHaveBeenCalledTimes(2);
    expect(now).toHaveBeenCalledOnce();
    expect(store.create).toHaveBeenCalledWith({
      scheduledActionId: "scheduled-action-id",
      auditId: "audit-id",
      guildId: "guild-id",
      channelId: "channel-id",
      actorId: "actor-id",
      executeAt,
      payload: { content: "", embed: { title: "title", color: 0 } },
      occurredAt,
    });
  });
});
