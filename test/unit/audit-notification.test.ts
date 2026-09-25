import { ChannelType, HTTPError, PermissionFlagsBits } from "discord.js";
import type { Client } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createAuditNotificationDiscord } from "../../src/audit-notification-discord.js";
import { createAuditNotificationDispatcher } from "../../src/audit-notification-dispatcher.js";
import {
  formatAuditNotification,
  type AuditNotificationRecord,
  type AuditReference,
} from "../../src/audit-notification-format.js";
import { createAuditNotificationProjection } from "../../src/audit-notification-projection.js";
import type { DatabaseClient } from "../../src/database.js";

const auditId = "11111111-1111-4111-8111-111111111111";
const guildId = "100000000000000001";
const actorId = "100000000000000002";
const reference: AuditReference = { source: "THREAD", auditId };
const record: AuditNotificationRecord = {
  ...reference,
  guildId,
  event: "CLOSE",
  outcome: "SUCCESS",
  actorType: "USER",
  actorUserId: actorId,
  threadId: "100000000000000003",
  occurredAt: new Date("2030-01-01T00:00:00.000Z"),
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("audit notification format", () => {
  it("renders bounded metadata with inert IDs and a source-separated stable nonce", () => {
    const first = formatAuditNotification(record)!;
    expect(first.content).toContain(`Audit ID: \`${auditId}\``);
    expect(first.content).toContain("Actor ID: `100000000000000002`");
    expect(first.content).not.toMatch(/<@|@everyone|@here/);
    expect(first.content.length).toBeLessThan(2000);
    expect(formatAuditNotification(record)?.nonce).toBe(first.nonce);
    expect(formatAuditNotification({ ...record, source: "MANAGED_MESSAGE" })?.nonce).not.toBe(
      first.nonce,
    );
  });

  const examples: {
    source: AuditReference["source"];
    value: AuditNotificationRecord;
    lines: string[];
  }[] = [
    {
      source: "THREAD",
      value: record,
      lines: [
        "Source: `THREAD`",
        "Event: `CLOSE`",
        "Outcome: `SUCCESS`",
        "Actor: `USER`",
        `Actor ID: \`${actorId}\``,
        "Thread ID: `100000000000000003`",
      ],
    },
    {
      source: "SCHEDULED_THREAD_CLOSE",
      value: {
        source: "SCHEDULED_THREAD_CLOSE",
        auditId,
        guildId,
        event: "EXECUTION_FAILED",
        outcome: "FAILURE",
        actorType: "SYSTEM",
        threadId: "100000000000000003",
        scheduledActionId: "action-close",
        failureCode: "BOT_PERMISSION_MISSING",
        occurredAt: record.occurredAt,
      },
      lines: [
        "Source: `SCHEDULED_THREAD_CLOSE`",
        "Event: `EXECUTION_FAILED`",
        "Outcome: `FAILURE`",
        "Actor: `SYSTEM`",
        "Thread ID: `100000000000000003`",
        "Scheduled action ID: `action-close`",
        "Failure code: `BOT_PERMISSION_MISSING`",
      ],
    },
    {
      source: "MANAGED_MESSAGE",
      value: {
        source: "MANAGED_MESSAGE",
        auditId,
        guildId,
        event: "CREATED",
        outcome: "SUCCESS",
        actorType: "USER",
        actorUserId: actorId,
        channelId: "100000000000000004",
        messageId: "100000000000000005",
        occurredAt: record.occurredAt,
      },
      lines: [
        "Source: `MANAGED_MESSAGE`",
        "Event: `CREATED`",
        "Outcome: `SUCCESS`",
        "Actor: `USER`",
        `Actor ID: \`${actorId}\``,
        "Channel ID: `100000000000000004`",
        "Message ID: `100000000000000005`",
      ],
    },
    {
      source: "SCHEDULED_MESSAGE",
      value: {
        source: "SCHEDULED_MESSAGE",
        auditId,
        guildId,
        event: "EXECUTION_RETRY",
        outcome: "FAILURE",
        actorType: "SYSTEM",
        channelId: "100000000000000004",
        scheduledActionId: "action-message",
        failureCode: "CURRENT_STATE_CHECK_FAILED",
        occurredAt: record.occurredAt,
      },
      lines: [
        "Source: `SCHEDULED_MESSAGE`",
        "Event: `EXECUTION_RETRY`",
        "Outcome: `FAILURE`",
        "Actor: `SYSTEM`",
        "Channel ID: `100000000000000004`",
        "Scheduled action ID: `action-message`",
        "Failure code: `CURRENT_STATE_CHECK_FAILED`",
      ],
    },
    {
      source: "RECURRING_MESSAGE",
      value: {
        source: "RECURRING_MESSAGE",
        auditId,
        guildId,
        event: "DST_GAP_SKIPPED",
        outcome: "SKIPPED",
        actorType: "SYSTEM",
        channelId: "100000000000000004",
        scheduledActionId: "action-recurring",
        skipReason: "DST_GAP",
        occurredAt: record.occurredAt,
      },
      lines: [
        "Source: `RECURRING_MESSAGE`",
        "Event: `DST_GAP_SKIPPED`",
        "Outcome: `SKIPPED`",
        "Actor: `SYSTEM`",
        "Channel ID: `100000000000000004`",
        "Scheduled action ID: `action-recurring`",
        "Skip reason: `DST_GAP`",
      ],
    },
    {
      source: "AUDIT_LOG_DESTINATION",
      value: {
        source: "AUDIT_LOG_DESTINATION",
        auditId,
        guildId,
        event: "CHANGE",
        outcome: "SUCCESS",
        actorType: "USER",
        actorUserId: actorId,
        previousDestinationId: "100000000000000006",
        newDestinationId: "100000000000000007",
        occurredAt: record.occurredAt,
      },
      lines: [
        "Source: `AUDIT_LOG_DESTINATION`",
        "Event: `CHANGE`",
        "Outcome: `SUCCESS`",
        "Actor: `USER`",
        `Actor ID: \`${actorId}\``,
        "Previous destination ID: `100000000000000006`",
        "New destination ID: `100000000000000007`",
      ],
    },
  ];

  it.each(examples)("renders exact plain text for $source", ({ value, lines }) => {
    const formatted = formatAuditNotification(value);
    expect(formatted?.content).toBe(
      [
        "WEFT audit",
        ...lines,
        `Audit ID: \`${auditId}\``,
        "Occurred at: `2030-01-01T00:00:00.000Z`",
      ].join("\n"),
    );
  });

  it.each(["bad`id", "bad\nvalue", "<@123>", "x".repeat(65), "bad\u0000value"])(
    "rejects malformed metadata %s",
    (value) => {
      expect(formatAuditNotification({ ...record, threadId: value })).toBeUndefined();
    },
  );

  it("formats system failure and skipped metadata without payload fields", () => {
    const system = {
      ...record,
      actorType: "SYSTEM" as const,
      outcome: "FAILURE",
      failureCode: "SEND_REJECTED",
    };
    delete system.actorUserId;
    const withPayload = { ...system, afterContent: "PRIVATE_PAYLOAD" };
    const formatted = formatAuditNotification(withPayload);
    expect(formatted?.content).toContain("Failure code: `SEND_REJECTED`");
    expect(formatted?.content).not.toContain("PRIVATE_PAYLOAD");
    expect(
      formatAuditNotification({ ...system, outcome: "SKIPPED", skipReason: "DST_GAP" })?.content,
    ).toContain("Skip reason: `DST_GAP`");
  });

  it("does not accept an invalid actor shape or timestamp", () => {
    const withoutActor = { ...record };
    delete withoutActor.actorUserId;
    expect(formatAuditNotification(withoutActor)).toBeUndefined();
    expect(
      formatAuditNotification({ ...record, occurredAt: new Date(Number.NaN) }),
    ).toBeUndefined();
  });
});

describe("audit notification projection", () => {
  const samples = [
    {
      source: "THREAD",
      row: {
        guildId,
        threadId: "3",
        event: "CLOSE",
        outcome: "SUCCESS",
        actorType: "USER",
        actorId,
        failureCode: null,
        occurredAt: record.occurredAt,
      },
      excluded: [] as string[],
    },
    {
      source: "SCHEDULED_THREAD_CLOSE",
      row: {
        guildId,
        threadId: "3",
        scheduledActionId: "4",
        event: "EXECUTION_FAILED",
        outcome: "FAILURE",
        actorType: "SYSTEM",
        actorId: null,
        failureCode: "BOT_PERMISSION_MISSING",
        occurredAt: record.occurredAt,
      },
      excluded: [] as string[],
    },
    {
      source: "MANAGED_MESSAGE",
      row: {
        guildId,
        channelId: "5",
        messageId: "6",
        event: "EDITED",
        outcome: "SUCCESS",
        actorType: "USER",
        actorId,
        occurredAt: record.occurredAt,
      },
      excluded: [
        "beforeContent",
        "afterContent",
        "beforeEmbedTitle",
        "afterEmbedDescription",
        "afterEmbedImageUrl",
      ],
    },
    {
      source: "SCHEDULED_MESSAGE",
      row: {
        guildId,
        channelId: "5",
        scheduledActionId: "4",
        messageId: null,
        event: "EXECUTION_RETRY",
        outcome: "FAILURE",
        actorType: "SYSTEM",
        actorId: null,
        failureCode: "CURRENT_STATE_CHECK_FAILED",
        occurredAt: record.occurredAt,
      },
      excluded: ["content", "embedTitle", "embedDescription", "embedColor", "embedImageUrl"],
    },
    {
      source: "RECURRING_MESSAGE",
      row: {
        guildId,
        channelId: "5",
        scheduledActionId: "4",
        occurrenceId: null,
        messageId: null,
        event: "DST_GAP_SKIPPED",
        outcome: "SKIPPED",
        actorType: "SYSTEM",
        actorId: null,
        failureCode: null,
        auditSkipReason: "DST_GAP",
        occurrenceSkipReason: null,
        occurredAt: record.occurredAt,
      },
      excluded: [
        "beforeContent",
        "afterContent",
        "beforeEmbedTitle",
        "afterEmbedDescription",
        "beforeTimezone",
        "afterTimezone",
      ],
    },
    {
      source: "AUDIT_LOG_DESTINATION",
      row: {
        guildId,
        actorUserId: actorId,
        previousChannelId: "5",
        newChannelId: "6",
        outcome: "SUCCESS",
        occurredAt: record.occurredAt,
      },
      excluded: [] as string[],
    },
  ] as const;

  it.each(samples)(
    "loads $source by exact ID with only safe selected fields",
    async ({ source, row, excluded }) => {
      let selected: Record<string, unknown> | undefined;
      let selectedId: unknown;
      const database = {
        select(fields: Record<string, unknown>) {
          selected = fields;
          return {
            from() {
              return this;
            },
            where(id: unknown) {
              selectedId = id;
              return this;
            },
            limit: () => Promise.resolve([row]),
          };
        },
      } as unknown as DatabaseClient;
      const result = await createAuditNotificationProjection(database).load({ source, auditId });
      expect(selectedId).toBeDefined();
      expect(result).toMatchObject({ source, auditId, guildId, outcome: row.outcome });
      for (const field of excluded) {
        expect(selected).not.toHaveProperty(field);
        expect(result).not.toHaveProperty(field);
      }
    },
  );

  it.each(["THREAD", "SCHEDULED_THREAD_CLOSE", "SCHEDULED_MESSAGE", "RECURRING_MESSAGE"] as const)(
    "rejects an unknown %s failure code before delivery",
    async (source) => {
      const sample = samples.find((item) => item.source === source);
      if (sample === undefined) throw new Error("Missing projection sample");
      const invalidRow = {
        ...sample.row,
        ...(source === "THREAD" ? { outcome: "FAILURE" } : {}),
        ...(source === "RECURRING_MESSAGE"
          ? {
              event: "OCCURRENCE_FAILED",
              outcome: "FAILURE",
              occurrenceId: "7",
              auditSkipReason: null,
              occurrenceSkipReason: null,
            }
          : {}),
        failureCode: "UNKNOWN_FAILURE_123",
      };
      const database = {
        select: () => ({
          from() {
            return this;
          },
          where() {
            return this;
          },
          limit: () => Promise.resolve([invalidRow]),
        }),
      } as unknown as DatabaseClient;
      const projection = createAuditNotificationProjection(database);
      const invalidReference = { source, auditId };
      await expect(projection.load(invalidReference)).rejects.toMatchObject({
        classification: "INVALID_FAILURE_CODE",
      });

      const warn = vi.fn();
      const readDestination = vi.fn();
      const send = vi.fn();
      const dispatcher = createAuditNotificationDispatcher({
        projection,
        readDestination,
        discord: { send },
        logger: { warn },
      });
      dispatcher.publish(invalidReference);
      await dispatcher.drain();
      expect(readDestination).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          event: "audit_notification_delivery",
          source,
          auditId,
          outcome: "INVALID_FAILURE_CODE",
        },
        "Audit notification was not delivered",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain("UNKNOWN_FAILURE_123");
    },
  );

  it("returns no projection when the exact audit is absent", async () => {
    const database = {
      select: () => ({
        from() {
          return this;
        },
        where() {
          return this;
        },
        limit: () => Promise.resolve([]),
      }),
    } as unknown as DatabaseClient;
    await expect(
      createAuditNotificationProjection(database).load(reference),
    ).resolves.toBeUndefined();
  });

  it.each([
    [null, "6", "ENABLE"],
    ["5", "6", "CHANGE"],
    ["5", null, "DISABLE"],
  ])("derives destination event from %s to %s", async (previous, next, event) => {
    const database = {
      select: () => ({
        from() {
          return this;
        },
        where() {
          return this;
        },
        limit: () =>
          Promise.resolve([
            {
              guildId,
              actorUserId: actorId,
              previousChannelId: previous,
              newChannelId: next,
              outcome: "SUCCESS",
              occurredAt: record.occurredAt,
            },
          ]),
      }),
    } as unknown as DatabaseClient;
    const result = await createAuditNotificationProjection(database).load({
      source: "AUDIT_LOG_DESTINATION",
      auditId,
    });
    expect(result?.event).toBe(event);
  });
});

describe("audit notification Discord boundary", () => {
  function fixture(
    options: {
      type?: ChannelType;
      guild?: string;
      view?: boolean;
      send?: boolean;
      fetchFails?: boolean;
      memberFails?: boolean;
      sendFails?: boolean;
    } = {},
  ) {
    const send = vi.fn(
      options.sendFails
        ? () => Promise.reject(new Error("ambiguous"))
        : () => Promise.resolve({ id: "sent" }),
    );
    const fetchMember = vi.fn(
      options.memberFails
        ? () => Promise.reject(new Error("member read"))
        : () => Promise.resolve({ id: "bot" }),
    );
    const permissionsFor = vi.fn(() => ({
      has: (permissions: bigint[]) =>
        permissions.every((permission) =>
          permission === PermissionFlagsBits.ViewChannel
            ? options.view !== false
            : permission === PermissionFlagsBits.SendMessages
              ? options.send !== false
              : false,
        ),
    }));
    const fetchChannel = vi.fn(
      options.fetchFails
        ? () => Promise.reject(new Error("channel read"))
        : () =>
            Promise.resolve({
              type: options.type ?? ChannelType.GuildText,
              guildId: options.guild ?? guildId,
              guild: { members: { fetch: fetchMember } },
              permissionsFor,
              send,
            }),
    );
    const client = { user: { id: "bot" }, channels: { fetch: fetchChannel } } as unknown as Client;
    return { boundary: createAuditNotificationDiscord(client), fetchChannel, fetchMember, send };
  }
  const input = { guildId, destinationId: "7", content: "WEFT audit", nonce: "wa_stable" };

  it.each([ChannelType.GuildText, ChannelType.GuildAnnouncement])(
    "force-fetches supported channel type %s and sends plain text with nonce and mention suppression",
    async (type) => {
      const current = fixture({ type });
      await expect(current.boundary.send(input)).resolves.toBe("SENT");
      expect(current.fetchChannel).toHaveBeenCalledWith("7", { force: true });
      expect(current.fetchMember).toHaveBeenCalledWith({ user: "bot", force: true });
      expect(current.send).toHaveBeenCalledWith({
        content: "WEFT audit",
        allowedMentions: { parse: [] },
        nonce: "wa_stable",
        enforceNonce: true,
      });
    },
  );

  it.each([{ type: ChannelType.GuildForum }, { guild: "other" }, { view: false }, { send: false }])(
    "skips invalid current destination %#",
    async (options) => {
      const current = fixture(options);
      await expect(current.boundary.send(input)).resolves.toBe("INVALID_DESTINATION");
      expect(current.send).not.toHaveBeenCalled();
    },
  );

  it("classifies a confirmed Discord rejection without retry", async () => {
    const current = fixture();
    current.send.mockImplementation(() =>
      Promise.reject(
        new HTTPError(403, "Forbidden", "POST", "https://discord.invalid", {
          body: undefined,
          files: undefined,
        }),
      ),
    );
    await expect(current.boundary.send(input)).resolves.toBe("REJECTED");
    expect(current.send).toHaveBeenCalledOnce();
  });

  it("classifies preflight failures and ambiguous send without retry", async () => {
    await expect(fixture({ fetchFails: true }).boundary.send(input)).resolves.toBe(
      "PREFLIGHT_FAILED",
    );
    await expect(fixture({ memberFails: true }).boundary.send(input)).resolves.toBe(
      "PREFLIGHT_FAILED",
    );
    const current = fixture({ sendFails: true });
    await expect(current.boundary.send(input)).resolves.toBe("UNCONFIRMED");
    expect(current.send).toHaveBeenCalledOnce();
  });
});

describe("audit notification dispatcher", () => {
  it("returns before delivery, drains tasks accepted during drain, and isolates errors", async () => {
    const first = deferred<"SENT">();
    const second = deferred<"SENT">();
    const send = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const logger = { warn: vi.fn() } as unknown as Logger;
    const dispatcher = createAuditNotificationDispatcher({
      projection: { load: vi.fn(() => Promise.resolve(record)) },
      readDestination: vi.fn(() => Promise.resolve("100000000000000007")),
      discord: { send },
      logger,
    });
    dispatcher.publish(reference);
    const draining = dispatcher.drain();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    dispatcher.publish({ ...reference, auditId: "22222222-2222-4222-8222-222222222222" });
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    let done = false;
    void draining.then(() => {
      done = true;
    });
    first.resolve("SENT");
    await Promise.resolve();
    expect(done).toBe(false);
    second.resolve("SENT");
    await draining;
    expect(done).toBe(true);
    await dispatcher.drain();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("skips a malformed current destination without sending or logging its value", async () => {
    const warn = vi.fn();
    const send = vi.fn();
    const dispatcher = createAuditNotificationDispatcher({
      projection: { load: vi.fn(() => Promise.resolve(record)) },
      readDestination: vi.fn(() => Promise.resolve("bad\nprivate")),
      discord: { send },
      logger: { warn },
    });
    dispatcher.publish(reference);
    await dispatcher.drain();
    expect(send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("bad\nprivate");
  });

  it("silently skips disabled destination and consumes projection, read, and send failures", async () => {
    const warn = vi.fn();
    const logger = { warn } as unknown as Logger;
    const readDestination = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("private"))
      .mockResolvedValue("100000000000000007");
    const projection = {
      load: vi
        .fn()
        .mockResolvedValueOnce(record)
        .mockResolvedValueOnce(record)
        .mockResolvedValueOnce(record)
        .mockResolvedValueOnce(undefined),
    };
    const discord = { send: vi.fn(() => Promise.reject(new Error("private"))) };
    const dispatcher = createAuditNotificationDispatcher({
      projection,
      readDestination,
      discord,
      logger,
    });
    for (let index = 0; index < 4; index += 1) dispatcher.publish(reference);
    await dispatcher.drain();
    expect(discord.send).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });
});
