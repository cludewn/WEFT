import { describe, expect, it, vi } from "vitest";

import { createAutomaticCloseExecutor } from "../../src/automatic-close-execution.js";
import type {
  AutomaticCloseCandidate,
  AutomaticClosePersistenceStore,
} from "../../src/automatic-close-persistence.js";
import type { ScheduledActionStore } from "../../src/scheduled-action-persistence.js";
import type { AutomaticCloseExecutionDiscord } from "../../src/thread-discord.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

const candidate: AutomaticCloseCandidate = {
  guildId: "guild-id",
  threadId: "thread-id",
  parentChannelId: "parent-id",
  lastActivityAt: new Date("2030-01-01T00:00:00.000Z"),
};
const revalidatedAt = new Date("2030-01-08T00:00:00.000Z");

describe("automatic close execution", () => {
  it("revalidates the exact episode with a newly captured timestamp before lifecycle", async () => {
    const fixture = createFixture();

    await expect(fixture.executor.execute(candidate)).resolves.toEqual({
      outcome: "SUCCESS",
      changed: true,
    });

    expect(fixture.persistence.isCandidateEpisodeEligible).toHaveBeenCalledExactlyOnceWith({
      ...candidate,
      revalidatedAt,
    });
    expect(fixture.scheduledActions.findCurrentThreadClose).toHaveBeenCalledExactlyOnceWith(
      "guild-id",
      "thread-id",
    );
    expect(fixture.threadLifecycle.autoCloseAsSystem).toHaveBeenCalledExactlyOnceWith(
      "guild-id",
      "thread-id",
      "automatic-close-audit-id",
    );
    expect(fixture.persistence.retireActivityEpisode).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      threadId: "thread-id",
      lastActivityAt: candidate.lastActivityAt,
    });
    expect(
      vi.mocked(fixture.persistence.isCandidateEpisodeEligible).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fixture.scheduledActions.findCurrentThreadClose).mock.invocationCallOrder[0]!,
    );
    expect(
      vi.mocked(fixture.scheduledActions.findCurrentThreadClose).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fixture.threadLifecycle.autoCloseAsSystem).mock.invocationCallOrder[0]!,
    );
  });

  it("skips a stale or policy-ineligible episode without retirement or lifecycle", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.persistence.isCandidateEpisodeEligible).mockResolvedValueOnce(false);

    await expect(fixture.executor.execute(candidate)).resolves.toEqual({
      outcome: "SKIPPED",
      reason: "NOT_CURRENTLY_ELIGIBLE",
    });
    expect(fixture.scheduledActions.findCurrentThreadClose).not.toHaveBeenCalled();
    expect(fixture.threadLifecycle.autoCloseAsSystem).not.toHaveBeenCalled();
    expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
  });

  it.each(["ACTIVE", "EXECUTING"] as const)(
    "gives a current %s explicit close precedence without mutating it",
    async (status) => {
      const fixture = createFixture();
      vi.mocked(fixture.scheduledActions.findCurrentThreadClose).mockResolvedValueOnce({
        status,
        executeAt: new Date("2030-01-09T00:00:00.000Z"),
      });

      await expect(fixture.executor.execute(candidate)).resolves.toEqual({
        outcome: "SKIPPED",
        reason: "EXPLICIT_SCHEDULED_CLOSE",
      });
      expect(fixture.threadLifecycle.autoCloseAsSystem).not.toHaveBeenCalled();
      expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
    },
  );

  it.each([
    [
      "already archived",
      { outcome: "AVAILABLE", parentChannelId: "parent-id", archived: true },
      "ALREADY_ARCHIVED",
    ],
    ["confirmed unavailable", { outcome: "UNAVAILABLE" }, "RESOURCE_UNAVAILABLE"],
    [
      "parent mismatch",
      { outcome: "AVAILABLE", parentChannelId: "other-parent", archived: false },
      "PARENT_MISMATCH",
    ],
  ] as const)("retires an %s episode without lifecycle", async (_label, inspection, reason) => {
    const fixture = createFixture();
    vi.mocked(fixture.discord.inspectThread).mockResolvedValueOnce(inspection);

    await expect(fixture.executor.execute(candidate)).resolves.toEqual({
      outcome: "SKIPPED",
      reason,
    });
    expect(fixture.persistence.retireActivityEpisode).toHaveBeenCalledOnce();
    expect(fixture.persistence.isCandidateEpisodeEligible).not.toHaveBeenCalled();
    expect(fixture.threadLifecycle.autoCloseAsSystem).not.toHaveBeenCalled();
  });

  it("keeps transient inspection failure retryable and unretired", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.discord.inspectThread).mockRejectedValueOnce(new Error("sensitive"));

    await expect(fixture.executor.execute(candidate)).resolves.toEqual({
      outcome: "RETRYABLE_FAILURE",
      code: "DISCORD_INSPECTION_FAILED",
    });
    expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
  });

  it.each([
    ["candidate revalidation", "CANDIDATE_REVALIDATION_FAILED"],
    ["scheduled close read", "SCHEDULED_CLOSE_READ_FAILED"],
  ] as const)("bounds a %s rejection", async (boundary, code) => {
    const fixture = createFixture();
    if (boundary === "candidate revalidation") {
      vi.mocked(fixture.persistence.isCandidateEpisodeEligible).mockRejectedValueOnce(
        new TypeError("sensitive"),
      );
    } else {
      vi.mocked(fixture.scheduledActions.findCurrentThreadClose).mockRejectedValueOnce(
        new RangeError("sensitive"),
      );
    }

    const result = await fixture.executor.execute(candidate);
    expect(result).toEqual({ outcome: "RETRYABLE_FAILURE", code });
    expect(JSON.stringify(result)).not.toContain("sensitive");
    expect(fixture.threadLifecycle.autoCloseAsSystem).not.toHaveBeenCalled();
    expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
  });

  it.each([
    ["RETRYABLE_FAILURE", "DISCORD_FETCH_FAILED", "RETRYABLE_FAILURE"],
    ["PERMANENT_FAILURE", "THREAD_LOCKED", "ATTEMPT_FAILURE"],
  ] as const)("does not retire a lifecycle %s", async (lifecycleOutcome, code, expectedOutcome) => {
    const fixture = createFixture();
    vi.mocked(fixture.threadLifecycle.autoCloseAsSystem).mockResolvedValueOnce({
      outcome: lifecycleOutcome,
      code,
    });

    await expect(fixture.executor.execute(candidate)).resolves.toEqual({
      outcome: expectedOutcome,
      code,
    });
    expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
  });

  it("bounds an unexpected lifecycle rejection and leaves the episode unretired", async () => {
    const fixture = createFixture();
    vi.mocked(fixture.threadLifecycle.autoCloseAsSystem).mockRejectedValueOnce(
      new Error("sensitive lifecycle detail"),
    );

    const result = await fixture.executor.execute(candidate);
    expect(result).toEqual({
      outcome: "RETRYABLE_FAILURE",
      code: "THREAD_LIFECYCLE_UNEXPECTED_FAILURE",
    });
    expect(JSON.stringify(result)).not.toContain("sensitive lifecycle detail");
    expect(fixture.persistence.retireActivityEpisode).not.toHaveBeenCalled();
  });

  it.each(["after success", "after archived", "after unavailable", "after parent mismatch"])(
    "returns retryable finalization failure %s",
    async (scenario) => {
      const fixture = createFixture();
      if (scenario === "after archived") {
        vi.mocked(fixture.discord.inspectThread).mockResolvedValueOnce({
          outcome: "AVAILABLE",
          parentChannelId: "parent-id",
          archived: true,
        });
      } else if (scenario === "after unavailable") {
        vi.mocked(fixture.discord.inspectThread).mockResolvedValueOnce({ outcome: "UNAVAILABLE" });
      } else if (scenario === "after parent mismatch") {
        vi.mocked(fixture.discord.inspectThread).mockResolvedValueOnce({
          outcome: "AVAILABLE",
          parentChannelId: "other-parent",
          archived: false,
        });
      }
      vi.mocked(fixture.persistence.retireActivityEpisode).mockRejectedValueOnce(
        new Error("sensitive persistence detail"),
      );

      const result = await fixture.executor.execute(candidate);
      expect(result).toEqual({
        outcome: "RETRYABLE_FAILURE",
        code: "RETIREMENT_WRITE_FAILED",
      });
      expect(JSON.stringify(result)).not.toContain("sensitive persistence detail");
    },
  );
});

function createFixture() {
  const discord: AutomaticCloseExecutionDiscord = {
    inspectThread: vi.fn<AutomaticCloseExecutionDiscord["inspectThread"]>(() =>
      Promise.resolve({ outcome: "AVAILABLE", parentChannelId: "parent-id", archived: false }),
    ),
  };
  const persistence = {
    isCandidateEpisodeEligible: vi.fn<AutomaticClosePersistenceStore["isCandidateEpisodeEligible"]>(
      () => Promise.resolve(true),
    ),
    retireActivityEpisode: vi.fn<AutomaticClosePersistenceStore["retireActivityEpisode"]>(() =>
      Promise.resolve(),
    ),
  } satisfies Pick<
    AutomaticClosePersistenceStore,
    "isCandidateEpisodeEligible" | "retireActivityEpisode"
  >;
  const scheduledActions = {
    findCurrentThreadClose: vi.fn<ScheduledActionStore["findCurrentThreadClose"]>(() =>
      Promise.resolve(undefined),
    ),
  } satisfies Pick<ScheduledActionStore, "findCurrentThreadClose">;
  const threadLifecycle = {
    autoCloseAsSystem: vi.fn<ThreadLifecycleService["autoCloseAsSystem"]>(() =>
      Promise.resolve({ outcome: "SUCCESS", changed: true }),
    ),
  } satisfies Pick<ThreadLifecycleService, "autoCloseAsSystem">;
  const executor = createAutomaticCloseExecutor({
    discord,
    persistence,
    scheduledActions,
    threadLifecycle,
    now: () => revalidatedAt,
    createAuditId: () => "automatic-close-audit-id",
  });

  return { executor, discord, persistence, scheduledActions, threadLifecycle };
}
