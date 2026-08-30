import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import { createAutomaticCloseActivityService } from "../../src/automatic-close-activity.js";
import type { AutomaticClosePersistenceStore } from "../../src/automatic-close-persistence.js";

const messageEvent = {
  guildId: "guild-id",
  threadId: "thread-id",
  parentChannelId: "parent-id",
  occurredAt: new Date("2030-01-01T00:00:00.000Z"),
  authorIsBot: false,
};

const baselineEvent = {
  guildId: "guild-id",
  threadId: "thread-id",
  parentChannelId: "parent-id",
  baselineAt: new Date("2030-02-02T00:00:00.000Z"),
};

const reentryEvent = {
  guildId: "guild-id",
  threadId: "thread-id",
  parentChannelId: "parent-id",
  reopenedAt: new Date("2030-03-03T00:00:00.000Z"),
};

describe("automatic close activity service", () => {
  it("forwards message activity to the focused persistence operation", async () => {
    const fixture = createFixture();

    await fixture.service.recordMessageActivity(messageEvent);

    expect(fixture.persistence.recordQualifyingMessageActivity).toHaveBeenCalledExactlyOnceWith(
      messageEvent,
    );
    expect(fixture.persistence.initializeMissingActivityBaselines).not.toHaveBeenCalled();
  });

  it("does not log successful message activity", async () => {
    const fixture = createFixture();

    await fixture.service.recordMessageActivity(messageEvent);

    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });

  it("never rejects when message activity persistence fails", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.persistence.recordQualifyingMessageActivity).mockRejectedValueOnce(
      new RangeError("database unavailable"),
    );

    await expect(fixture.service.recordMessageActivity(messageEvent)).resolves.toBeUndefined();

    expect(fixture.logger.warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "automatic_close_message_activity_failed",
        guildId: "guild-id",
        threadId: "thread-id",
        parentChannelId: "parent-id",
        errorName: "RangeError",
      },
      expect.any(String),
    );
  });

  it("initializes a thread baseline through the missing-only batch operation", async () => {
    const fixture = createFixture();

    await fixture.service.initializeThreadBaseline(baselineEvent);

    expect(fixture.persistence.initializeMissingActivityBaselines).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      baselineAt: baselineEvent.baselineAt,
      candidates: [{ threadId: "thread-id", parentChannelId: "parent-id" }],
    });
    expect(fixture.persistence.recordQualifyingMessageActivity).not.toHaveBeenCalled();
  });

  it("never rejects when baseline initialization fails", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.persistence.initializeMissingActivityBaselines).mockRejectedValueOnce(
      new TypeError("database unavailable"),
    );

    await expect(fixture.service.initializeThreadBaseline(baselineEvent)).resolves.toBeUndefined();

    expect(fixture.logger.warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "automatic_close_thread_baseline_failed",
        guildId: "guild-id",
        threadId: "thread-id",
        parentChannelId: "parent-id",
        errorName: "TypeError",
      },
      expect.any(String),
    );
  });

  it("forwards thread re-entry without using either message activity path", async () => {
    const fixture = createFixture();

    await fixture.service.recordThreadReentryBaseline(reentryEvent);

    expect(fixture.persistence.recordThreadReentryBaseline).toHaveBeenCalledExactlyOnceWith(
      reentryEvent,
    );
    expect(fixture.persistence.recordQualifyingMessageActivity).not.toHaveBeenCalled();
    expect(fixture.persistence.initializeMissingActivityBaselines).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });

  it("contains re-entry persistence failure with bounded warning metadata", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.persistence.recordThreadReentryBaseline).mockRejectedValueOnce(
      new SyntaxError("sensitive database detail"),
    );

    await expect(
      fixture.service.recordThreadReentryBaseline(reentryEvent),
    ).resolves.toBeUndefined();

    expect(fixture.logger.warn).toHaveBeenCalledExactlyOnceWith(
      {
        event: "automatic_close_thread_reentry_failed",
        guildId: "guild-id",
        threadId: "thread-id",
        parentChannelId: "parent-id",
        errorName: "SyntaxError",
      },
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(fixture.logger.warn).mock.calls)).not.toContain(
      "sensitive database detail",
    );
  });
});

function createFixture() {
  const persistence = {
    recordQualifyingMessageActivity: vi.fn<
      AutomaticClosePersistenceStore["recordQualifyingMessageActivity"]
    >(() => Promise.resolve(true)),
    initializeMissingActivityBaselines: vi.fn<
      AutomaticClosePersistenceStore["initializeMissingActivityBaselines"]
    >(() => Promise.resolve(1)),
    recordThreadReentryBaseline: vi.fn<
      AutomaticClosePersistenceStore["recordThreadReentryBaseline"]
    >(() => Promise.resolve(true)),
  } satisfies Pick<
    AutomaticClosePersistenceStore,
    | "recordQualifyingMessageActivity"
    | "initializeMissingActivityBaselines"
    | "recordThreadReentryBaseline"
  >;
  const logger = { warn: vi.fn() } as unknown as Pick<Logger, "warn">;
  const service = createAutomaticCloseActivityService({ persistence, logger });

  return { service, persistence, logger };
}
