import { describe, expect, it, vi } from "vitest";

import {
  createAutomaticCloseThreadMaintenanceService,
  type AutomaticCloseThreadMaintenanceDiscord,
} from "../../src/automatic-close-thread-maintenance.js";
import type { AutomaticClosePersistenceStore } from "../../src/automatic-close-persistence.js";
import type { ScheduledActionStore } from "../../src/scheduled-action-persistence.js";

const guildId = "guild-id";
const threadId = "thread-id";
const actorId = "actor-id";
const parentChannelId = "parent-id";

describe("automatic close thread maintenance service", () => {
  it("validates supported context and current ManageThreads permission", async () => {
    const denied = createFixture({ actorCanManage: false });
    await expect(denied.service.track(guildId, threadId, actorId)).resolves.toEqual({
      ok: false,
      code: "USER_MISSING_PERMISSION",
    });
    expect(denied.persistence.trackThread).not.toHaveBeenCalled();

    const unsupported = createFixture({ inspection: undefined });
    await expect(unsupported.service.untrack(guildId, threadId, actorId)).resolves.toEqual({
      ok: false,
      code: "UNSUPPORTED_CONTEXT",
    });
    expect(unsupported.persistence.addThreadExclusion).not.toHaveBeenCalled();
  });

  it("maps Discord validation failures and logs only safe fields", async () => {
    const secret = "database-url-with-password";
    const fixture = createFixture({ inspectError: new Error(secret) });

    await expect(fixture.service.status(guildId, threadId, actorId)).resolves.toEqual({
      ok: false,
      code: "CONTEXT_VALIDATION_FAILURE",
    });

    expect(fixture.logger.warn).toHaveBeenCalledWith(
      {
        event: "automatic_close_thread_maintenance_failed",
        operation: "STATUS",
        guildId,
        threadId,
        failureCode: "CONTEXT_VALIDATION_FAILURE",
        errorName: "Error",
      },
      "Automatic close thread maintenance failed",
    );
    expect(JSON.stringify(fixture.logger.warn.mock.calls)).not.toContain(secret);
  });

  it("captures trackedAt only after Discord validation", async () => {
    const order: string[] = [];
    const trackedAt = new Date("2030-01-02T03:04:05.000Z");
    const fixture = createFixture({
      inspectThread: vi.fn(() => {
        order.push("discord");
        return Promise.resolve({ parentChannelId, actorCanManage: true });
      }),
      now: () => {
        order.push("now");
        return trackedAt;
      },
      trackThread: vi.fn(() => {
        order.push("persistence");
        return Promise.resolve({ exclusionRemoved: true, parentEnabled: true });
      }),
    });

    await fixture.service.track(guildId, threadId, actorId);

    expect(order).toEqual(["discord", "now", "persistence"]);
    expect(fixture.persistence.trackThread).toHaveBeenCalledWith({
      guildId,
      threadId,
      parentChannelId,
      trackedAt,
    });
  });

  it.each([
    [true, true, "TRACKED"],
    [true, false, "TRACKED"],
    [false, true, "ALREADY_TRACKED"],
    [false, false, "ALREADY_TRACKED"],
  ] as const)(
    "maps track persistence (removed=%s, parent=%s)",
    async (exclusionRemoved, parentEnabled, outcome) => {
      const fixture = createFixture({
        trackThread: vi.fn(() => Promise.resolve({ exclusionRemoved, parentEnabled })),
      });

      await expect(fixture.service.track(guildId, threadId, actorId)).resolves.toEqual({
        ok: true,
        outcome,
        parentEnabled,
      });
      expect(fixture.scheduledActions.findCurrentThreadClose).not.toHaveBeenCalled();
    },
  );

  it.each([
    [true, "EXCLUDED"],
    [false, "ALREADY_EXCLUDED"],
  ] as const)("maps untrack persistence (%s)", async (changed, outcome) => {
    const fixture = createFixture({
      addThreadExclusion: vi.fn(() => Promise.resolve(changed)),
    });

    await expect(fixture.service.untrack(guildId, threadId, actorId)).resolves.toEqual({
      ok: true,
      outcome,
    });
    expect(fixture.persistence.addThreadExclusion).toHaveBeenCalledWith(guildId, threadId);
    expect(fixture.scheduledActions.findCurrentThreadClose).not.toHaveBeenCalled();
  });

  it.each(["track", "untrack", "status"] as const)(
    "maps %s persistence failures without exposing the error",
    async (operation) => {
      const secret = `secret-${operation}`;
      const fixture = createFixture({
        trackThread: vi.fn(() => Promise.reject(new Error(secret))),
        addThreadExclusion: vi.fn(() => Promise.reject(new Error(secret))),
        findThreadStatus: vi.fn(() => Promise.reject(new Error(secret))),
      });

      await expect(fixture.service[operation](guildId, threadId, actorId)).resolves.toEqual({
        ok: false,
        code: "PERSISTENCE_FAILURE",
      });
      const logged = JSON.stringify(fixture.logger.warn.mock.calls);
      expect(logged).toContain(`"operation":"${operation.toUpperCase()}"`);
      expect(logged).toContain(`"parentChannelId":"${parentChannelId}"`);
      expect(logged).not.toContain(secret);
      expect(logged).not.toContain("stack");
    },
  );

  it.each([
    [true, false, true],
    [true, true, false],
    [false, false, false],
    [false, true, false],
  ] as const)(
    "composes effective status (parent=%s, excluded=%s)",
    async (parentEnabled, excluded, effectiveEnabled) => {
      const lastActivityAt = new Date("2030-02-03T04:05:06.000Z");
      const scheduledClose = {
        status: "ACTIVE" as const,
        executeAt: new Date("2030-02-04T04:05:06.000Z"),
      };
      const fixture = createFixture({
        findThreadStatus: vi.fn(() =>
          Promise.resolve({
            parentEnabled,
            excluded,
            inactivitySeconds: 604_800,
            lastActivityAt,
          }),
        ),
        findCurrentThreadClose: vi.fn(() => Promise.resolve(scheduledClose)),
      });

      await expect(fixture.service.status(guildId, threadId, actorId)).resolves.toEqual({
        ok: true,
        status: {
          parentEnabled,
          excluded,
          effectiveEnabled,
          inactivitySeconds: 604_800,
          lastActivityAt,
          scheduledClose,
        },
      });
      expect(fixture.persistence.findThreadStatus).toHaveBeenCalledWith(
        guildId,
        threadId,
        parentChannelId,
      );
      expect(fixture.scheduledActions.findCurrentThreadClose).toHaveBeenCalledWith(
        guildId,
        threadId,
      );
    },
  );
});

type FixtureOptions = {
  inspection?: { parentChannelId: string; actorCanManage: boolean } | undefined;
  actorCanManage?: boolean;
  inspectError?: Error;
  inspectThread?: AutomaticCloseThreadMaintenanceDiscord["inspectThread"];
  now?: () => Date;
  trackThread?: AutomaticClosePersistenceStore["trackThread"];
  addThreadExclusion?: AutomaticClosePersistenceStore["addThreadExclusion"];
  findThreadStatus?: AutomaticClosePersistenceStore["findThreadStatus"];
  findCurrentThreadClose?: ScheduledActionStore["findCurrentThreadClose"];
};

function createFixture(options: FixtureOptions = {}) {
  const inspectThread =
    options.inspectThread ??
    vi.fn(() => {
      if (options.inspectError !== undefined) return Promise.reject(options.inspectError);
      if (Object.hasOwn(options, "inspection")) return Promise.resolve(options.inspection);
      return Promise.resolve({
        parentChannelId,
        actorCanManage: options.actorCanManage ?? true,
      });
    });
  const persistence = {
    trackThread:
      options.trackThread ??
      vi.fn(() => Promise.resolve({ exclusionRemoved: true, parentEnabled: true })),
    addThreadExclusion: options.addThreadExclusion ?? vi.fn(() => Promise.resolve(true)),
    findThreadStatus:
      options.findThreadStatus ??
      vi.fn(() =>
        Promise.resolve({
          parentEnabled: true,
          excluded: false,
          inactivitySeconds: 604_800,
          lastActivityAt: null,
        }),
      ),
  };
  const scheduledActions = {
    findCurrentThreadClose:
      options.findCurrentThreadClose ?? vi.fn(() => Promise.resolve(undefined)),
  };
  const logger = { warn: vi.fn() };
  const service = createAutomaticCloseThreadMaintenanceService({
    discord: { inspectThread },
    persistence,
    scheduledActions,
    logger,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { service, persistence, scheduledActions, logger };
}
