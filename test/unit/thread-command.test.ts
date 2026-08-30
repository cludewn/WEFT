import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import type { AutomaticCloseThreadMaintenanceService } from "../../src/automatic-close-thread-maintenance.js";
import { OperationTimeoutError } from "../../src/operation-timeout.js";
import type { ScheduledThreadCloseCommandService } from "../../src/scheduled-thread-close-command.js";
import {
  DEFAULT_INTERACTION_IO_TIMEOUT_MS,
  handleThreadCommand as handleThreadCommandWithDependencies,
  threadCommandDefinition,
} from "../../src/thread-command.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

const logger = { debug: vi.fn(), warn: vi.fn() };

describe("thread command", () => {
  it("defines guild-only thread subcommands with ManageThreads permission", () => {
    const definition = threadCommandDefinition.toJSON();

    expect(definition.contexts).toEqual([InteractionContextType.Guild]);
    expect(definition.default_member_permissions).toBe(
      PermissionFlagsBits.ManageThreads.toString(),
    );
    expect(definition.options?.map((option) => option.name)).toEqual([
      "close",
      "open",
      "close-after",
      "cancel-close",
      "track",
      "untrack",
      "status",
    ]);
    expect(definition.options?.at(2)).toMatchObject({
      name: "close-after",
      options: [{ name: "after", required: true }],
    });
    expect(definition.options?.at(3)).toMatchObject({ name: "cancel-close", options: [] });
    expect(definition.options?.slice(4)).toEqual([
      expect.objectContaining({ name: "track", options: [] }),
      expect.objectContaining({ name: "untrack", options: [] }),
      expect.objectContaining({ name: "status", options: [] }),
    ]);
    expect(DEFAULT_INTERACTION_IO_TIMEOUT_MS).toBe(2_500);
  });

  it("rejects non-guild contexts ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });
    await handleThreadCommand(interaction, createLifecycle(), logger);
    expect(reply).toHaveBeenCalledWith(
      ephemeral("This command can only be used in a supported active thread."),
    );
  });

  it("does not describe maintenance commands as requiring an active thread", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false, subcommand: "status" });
    await handleThreadCommand(interaction, createLifecycle(), logger);
    expect(reply).toHaveBeenCalledWith(
      ephemeral("This command can only be used in a supported thread."),
    );
  });

  it("returns runtime context and ManageThreads failures from the lifecycle", async () => {
    const unsupported = createInteraction({ isThread: false });
    const denied = createInteraction();
    await handleThreadCommand(
      unsupported.interaction,
      createLifecycle({
        close: vi.fn(() => Promise.resolve({ ok: false, code: "UNSUPPORTED_CONTEXT" } as const)),
      }),
      logger,
    );
    await handleThreadCommand(
      denied.interaction,
      createLifecycle({
        close: vi.fn(() =>
          Promise.resolve({ ok: false, code: "ACTOR_PERMISSION_MISSING" } as const),
        ),
      }),
      logger,
    );
    expect(unsupported.editReply).toHaveBeenCalledWith(
      edited("This command can only be used in a supported active thread."),
    );
    expect(denied.editReply).toHaveBeenCalledWith(
      edited("You need the Manage Threads permission to use this command."),
    );
  });

  it("replies ephemerally before lifecycle work and edits the initial response", async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle({
      close: vi.fn(() => {
        order.push("lifecycle");
        return Promise.resolve({ ok: true, changed: true } as const);
      }),
    });
    const close = createInteraction({
      reply: vi.fn(() => {
        order.push("reply");
        return Promise.resolve();
      }),
    });

    await handleThreadCommand(close.interaction, lifecycle, logger);

    expect(order).toEqual(["reply", "lifecycle"]);
    expect(close.reply).toHaveBeenCalledWith(ephemeral("Closing thread…"));
    expect(close.deferReply).not.toHaveBeenCalled();
    expect(close.editReply).toHaveBeenCalledWith(edited("Thread closed."));
  });

  it("routes close and open for the current thread only", async () => {
    const lifecycle = createLifecycle();
    const close = createInteraction({ subcommand: "close" });
    const open = createInteraction({ subcommand: "open" });

    await handleThreadCommand(close.interaction, lifecycle, logger);
    await handleThreadCommand(open.interaction, lifecycle, logger);

    expect(lifecycle.close).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(lifecycle.open).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(close.reply).toHaveBeenCalledWith(ephemeral("Closing thread…"));
    expect(open.reply).toHaveBeenCalledWith(ephemeral("Opening thread…"));
    expect(close.editReply).toHaveBeenCalledWith(edited("Thread closed."));
    expect(open.editReply).toHaveBeenCalledWith(edited("Thread opened."));
  });

  it("edits the initial response with unchanged close and open results", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: true, changed: false } as const)),
      open: vi.fn(() => Promise.resolve({ ok: true, changed: false } as const)),
    });
    const close = createInteraction({ subcommand: "close" });
    const open = createInteraction({ subcommand: "open" });

    await handleThreadCommand(close.interaction, lifecycle, logger);
    await handleThreadCommand(open.interaction, lifecycle, logger);

    expect(close.editReply).toHaveBeenCalledWith(edited("Thread is already closed."));
    expect(open.editReply).toHaveBeenCalledWith(edited("Thread is already opened."));
  });

  it("returns safe lifecycle failures ephemerally", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "BOT_PERMISSION_MISSING" } as const)),
    });
    const { interaction, editReply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle, logger);

    expect(editReply).toHaveBeenCalledWith(
      edited("WEFT cannot manage this thread with its current permissions."),
    );
  });

  it("explains that locked threads must be unlocked manually", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "THREAD_LOCKED" } as const)),
    });
    const { interaction, editReply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle, logger);

    expect(editReply).toHaveBeenCalledWith(
      edited("A locked thread cannot be soft-closed. Unlock it manually before retrying."),
    );
  });

  it("does not start lifecycle work when the initial reply fails", async () => {
    const lifecycle = createLifecycle();
    const failure = new Error("opaque failure");
    const { interaction, editReply } = createInteraction({
      reply: vi.fn(() => Promise.reject(failure)),
    });

    await expect(handleThreadCommand(interaction, lifecycle, logger)).rejects.toBe(failure);

    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("does not start lifecycle work when the initial reply times out", async () => {
    const lifecycle = createLifecycle();
    const { interaction, editReply } = createInteraction({
      reply: vi.fn(() => new Promise(() => undefined)),
    });

    await expect(handleThreadCommand(interaction, lifecycle, logger, 5)).rejects.toBeInstanceOf(
      OperationTimeoutError,
    );

    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        boundary: "initial_response",
        failureCode: "INTERACTION_INITIAL_RESPONSE_TIMEOUT",
      }),
      "Thread interaction boundary failed",
    );
  });

  it("warns the user when a lifecycle write outcome is unknown", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() =>
        Promise.resolve({ ok: false, code: "STATE_WRITE_OUTCOME_UNKNOWN" } as const),
      ),
    });
    const { interaction, editReply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle, logger);

    expect(editReply).toHaveBeenCalledWith(
      edited(
        "WEFT could not confirm the final outcome. Check the current thread state before retrying.",
      ),
    );
  });

  it("reports pending close and open mutations without encouraging retries", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, pending: true } as const)),
      open: vi.fn(() => Promise.resolve({ ok: false, pending: true } as const)),
    });
    const close = createInteraction({ subcommand: "close" });
    const open = createInteraction({ subcommand: "open" });

    await handleThreadCommand(close.interaction, lifecycle, logger);
    await handleThreadCommand(open.interaction, lifecycle, logger);

    const pendingMessage =
      "Discord is still processing this thread update. This can happen when Discord rate-limits thread name changes, and completion may take several minutes.";
    expect(close.editReply).toHaveBeenCalledWith(edited(pendingMessage));
    expect(open.editReply).toHaveBeenCalledWith(edited(pendingMessage));
    expect(pendingMessage).not.toContain("retry");
    expect(pendingMessage).not.toContain("Discord is rate-limiting this thread name change");
  });

  it("routes close-after and reports created and replacement times", async () => {
    const executeAt = new Date("2030-01-02T03:04:00.000Z");
    const scheduledThreadClose = createScheduledThreadClose({
      schedule: vi
        .fn<ScheduledThreadCloseCommandService["schedule"]>()
        .mockResolvedValueOnce({
          ok: true,
          outcome: "CREATED",
          action: createScheduledAction(executeAt),
        })
        .mockResolvedValueOnce({
          ok: true,
          outcome: "REPLACED",
          action: createScheduledAction(executeAt),
        }),
    });
    const created = createInteraction({ subcommand: "close-after", after: "30m" });
    const replaced = createInteraction({ subcommand: "close-after", after: "2h" });

    await handleThreadCommand(
      created.interaction,
      createLifecycle(),
      logger,
      undefined,
      scheduledThreadClose,
    );
    await handleThreadCommand(
      replaced.interaction,
      createLifecycle(),
      logger,
      undefined,
      scheduledThreadClose,
    );

    expect(scheduledThreadClose.schedule).toHaveBeenNthCalledWith(
      1,
      "guild-id",
      "thread-id",
      "actor-id",
      "30m",
    );
    expect(scheduledThreadClose.schedule).toHaveBeenNthCalledWith(
      2,
      "guild-id",
      "thread-id",
      "actor-id",
      "2h",
    );
    expect(created.editReply).toHaveBeenCalledWith(
      edited("Thread close scheduled for <t:1893553440:F> (<t:1893553440:R>)."),
    );
    expect(replaced.editReply).toHaveBeenCalledWith(
      edited(
        "Scheduled thread close replaced. New close time: <t:1893553440:F> (<t:1893553440:R>).",
      ),
    );
  });

  it("reports an unconfirmed saved delivery without telling the user to retry", async () => {
    const executeAt = new Date("2030-01-02T03:04:00.000Z");
    const scheduledThreadClose = createScheduledThreadClose({
      schedule: vi.fn(() =>
        Promise.resolve({
          ok: true,
          outcome: "SAVED_DELIVERY_PENDING",
          savedAs: "CREATED",
          action: createScheduledAction(executeAt),
        } as const),
      ),
    });
    const fixture = createInteraction({ subcommand: "close-after" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      scheduledThreadClose,
    );

    expect(fixture.editReply).toHaveBeenCalledWith(
      edited(
        "The scheduled close for <t:1893553440:F> (<t:1893553440:R>) was saved, but WEFT could not confirm its delivery yet. WEFT will reconcile it automatically.",
      ),
    );
    expect(JSON.stringify(fixture.editReply.mock.calls)).not.toContain("retry");
  });

  it.each([
    [
      { ok: true, outcome: "CANCELLED", action: createScheduledAction(new Date()) } as const,
      "Scheduled thread close cancelled.",
    ],
    [
      { ok: true, outcome: "NOT_SCHEDULED" } as const,
      "No scheduled close is active for this thread.",
    ],
    [
      { ok: false, code: "EXECUTION_IN_PROGRESS" } as const,
      "The scheduled close is already executing and can no longer be cancelled.",
    ],
    [
      { ok: false, code: "USER_MISSING_PERMISSION" } as const,
      "You need the Manage Threads permission to use this command.",
    ],
    [
      { ok: false, code: "UNSUPPORTED_CONTEXT" } as const,
      "This command can only be used in a supported thread.",
    ],
    [
      { ok: false, code: "CONTEXT_VALIDATION_FAILURE" } as const,
      "WEFT could not verify the current thread or your permissions. Please try again later.",
    ],
    [
      { ok: false, code: "PERSISTENCE_FAILURE" } as const,
      "WEFT could not cancel the scheduled close. Please try again later.",
    ],
  ])("routes cancel-close result %# ephemerally", async (result, message) => {
    const scheduledThreadClose = createScheduledThreadClose({
      cancel: vi.fn(() => Promise.resolve(result)),
    });
    const fixture = createInteraction({ subcommand: "cancel-close" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      scheduledThreadClose,
    );

    expect(scheduledThreadClose.cancel).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(fixture.reply).toHaveBeenCalledWith(ephemeral("Cancelling scheduled thread close…"));
    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it.each([
    [
      { outcome: "EXECUTION_IN_PROGRESS" } as const,
      "A scheduled close is already executing for this thread. The manual close was not started.",
    ],
    [
      { outcome: "PERSISTENCE_FAILURE" } as const,
      "WEFT could not confirm cancellation of the scheduled close, so the thread was not changed.",
    ],
  ])("maps manual close preparation result %#", async (result, message) => {
    const scheduledThreadClose = createScheduledThreadClose({
      closeManually: vi.fn(() => Promise.resolve(result)),
    });
    const fixture = createInteraction({ subcommand: "close" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      scheduledThreadClose,
    );

    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it("acknowledges before a delayed lifecycle result", async () => {
    let resolveLifecycle: ((result: { ok: true; changed: true }) => void) | undefined;
    const lifecycleResult = new Promise<{ ok: true; changed: true }>((resolve) => {
      resolveLifecycle = resolve;
    });
    const lifecycle = createLifecycle({ close: vi.fn(() => lifecycleResult) });
    const fixture = createInteraction();

    const handling = handleThreadCommand(fixture.interaction, lifecycle, logger);
    await vi.waitFor(() => {
      expect(fixture.reply).toHaveBeenCalledWith(ephemeral("Closing thread…"));
      expect(lifecycle.close).toHaveBeenCalledOnce();
    });
    expect(fixture.editReply).not.toHaveBeenCalled();

    resolveLifecycle?.({ ok: true, changed: true });
    await handling;
    expect(fixture.editReply).toHaveBeenCalledWith(edited("Thread closed."));
  });

  it("does not acknowledge twice when the interaction is already deferred or replied", async () => {
    for (const state of [{ deferred: true }, { replied: true }]) {
      const fixture = createInteraction(state);

      await handleThreadCommand(fixture.interaction, createLifecycle(), logger);

      expect(fixture.deferReply).not.toHaveBeenCalled();
      expect(fixture.reply).not.toHaveBeenCalled();
      expect(fixture.editReply).toHaveBeenNthCalledWith(1, edited("Closing thread…"));
      expect(fixture.editReply).toHaveBeenNthCalledWith(2, edited("Thread closed."));
    }
  });

  it("classifies a timed-out final edit as unknown and consumes its delayed success", async () => {
    let completeEdit: (() => void) | undefined;
    const fixture = createInteraction({
      editReply: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            completeEdit = resolve;
          }),
      ),
    });

    await expect(
      handleThreadCommand(fixture.interaction, createLifecycle(), logger, 5),
    ).rejects.toBeInstanceOf(OperationTimeoutError);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "thread_interaction_boundary_failed",
        guildId: "guild-id",
        threadId: "thread-id",
        operation: "CLOSE",
        boundary: "final_response",
        failureCode: "INTERACTION_FINAL_RESPONSE_OUTCOME_UNKNOWN",
      }),
      "Thread interaction boundary failed",
    );
    const loggedFields: unknown = logger.warn.mock.calls.at(-1)?.[0];
    expect(loggedFields).toHaveProperty("durationMs", expect.any(Number));

    completeEdit?.();
    await vi.waitFor(() => expect(fixture.editReply).toHaveBeenCalledOnce());
  });

  it.each([
    [
      { ok: true, outcome: "TRACKED", parentEnabled: true } as const,
      "Thread is now tracked for automatic close.",
    ],
    [
      { ok: true, outcome: "TRACKED", parentEnabled: false } as const,
      "Thread is tracked, but automatic close is disabled because this parent channel is not configured.",
    ],
    [
      { ok: true, outcome: "ALREADY_TRACKED", parentEnabled: true } as const,
      "Thread is already tracked for automatic close.",
    ],
    [
      { ok: true, outcome: "ALREADY_TRACKED", parentEnabled: false } as const,
      "Thread is already individually included, but automatic close is disabled because this parent channel is not configured.",
    ],
  ])("routes track result %#", async (result, message) => {
    const maintenance = createMaintenance({ track: vi.fn(() => Promise.resolve(result)) });
    const fixture = createInteraction({ subcommand: "track" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(maintenance.track).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(fixture.reply).toHaveBeenCalledWith(ephemeral("Tracking thread…"));
    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it.each([
    [{ ok: true, outcome: "EXCLUDED" } as const, "Thread excluded from automatic close."],
    [
      { ok: true, outcome: "ALREADY_EXCLUDED" } as const,
      "Thread is already excluded from automatic close.",
    ],
  ])("routes untrack result %#", async (result, message) => {
    const maintenance = createMaintenance({ untrack: vi.fn(() => Promise.resolve(result)) });
    const fixture = createInteraction({ subcommand: "untrack" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(maintenance.untrack).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(fixture.reply).toHaveBeenCalledWith(ephemeral("Excluding thread from automatic close…"));
    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it.each([
    [
      {
        parentEnabled: true,
        excluded: false,
        effectiveEnabled: true,
        inactivitySeconds: 604_800,
        lastActivityAt: new Date("2030-01-02T03:04:00.000Z"),
        scheduledClose: {
          status: "ACTIVE" as const,
          executeAt: new Date("2030-01-03T03:04:00.000Z"),
        },
      },
      "Automatic close: enabled\nParent policy: enabled\nThread exclusion: none\nInactivity: 7d\nLast activity: <t:1893553440:F> (<t:1893553440:R>)\nScheduled close: <t:1893639840:F> (<t:1893639840:R>)",
    ],
    [
      {
        parentEnabled: false,
        excluded: false,
        effectiveEnabled: false,
        inactivitySeconds: 3_600,
        lastActivityAt: null,
        scheduledClose: { status: "EXECUTING" as const, executeAt: new Date(0) },
      },
      "Automatic close: disabled\nParent policy: disabled\nThread exclusion: none\nInactivity: 1h\nLast activity: not recorded\nScheduled close: executing",
    ],
    [
      {
        parentEnabled: true,
        excluded: true,
        effectiveEnabled: false,
        inactivitySeconds: 300,
        lastActivityAt: null,
        scheduledClose: undefined,
      },
      "Automatic close: disabled\nParent policy: enabled\nThread exclusion: excluded\nInactivity: 5m\nLast activity: not recorded\nScheduled close: none",
    ],
  ])("formats status result %# as plain text", async (status, message) => {
    const maintenance = createMaintenance({
      status: vi.fn(() => Promise.resolve({ ok: true as const, status })),
    });
    const fixture = createInteraction({ subcommand: "status" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(fixture.reply).toHaveBeenCalledWith(ephemeral("Loading thread status…"));
    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it.each([
    ["UNSUPPORTED_CONTEXT", "This command can only be used in a supported thread."],
    ["USER_MISSING_PERMISSION", "You need the Manage Threads permission to use this command."],
    [
      "CONTEXT_VALIDATION_FAILURE",
      "WEFT could not verify the current thread or your permissions. Please try again later.",
    ],
    [
      "PERSISTENCE_FAILURE",
      "WEFT could not update automatic close tracking. Please try again later.",
    ],
  ] as const)("maps maintenance failure %s", async (code, message) => {
    const maintenance = createMaintenance({
      track: vi.fn(() => Promise.resolve({ ok: false as const, code })),
    });
    const fixture = createInteraction({ subcommand: "track" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(fixture.editReply).toHaveBeenCalledWith(edited(message));
  });

  it("uses a focused retryable status persistence failure", async () => {
    const maintenance = createMaintenance({
      status: vi.fn(() => Promise.resolve({ ok: false, code: "PERSISTENCE_FAILURE" } as const)),
    });
    const fixture = createInteraction({ subcommand: "status" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(fixture.editReply).toHaveBeenCalledWith(
      edited("WEFT could not load this thread's status. Please try again later."),
    );
  });

  it("uses a retryable untrack persistence failure", async () => {
    const maintenance = createMaintenance({
      untrack: vi.fn(() => Promise.resolve({ ok: false, code: "PERSISTENCE_FAILURE" } as const)),
    });
    const fixture = createInteraction({ subcommand: "untrack" });

    await handleThreadCommand(
      fixture.interaction,
      createLifecycle(),
      logger,
      undefined,
      undefined,
      maintenance,
    );

    expect(fixture.editReply).toHaveBeenCalledWith(
      edited("WEFT could not update automatic close tracking. Please try again later."),
    );
  });
});

function createLifecycle(overrides: Partial<ThreadLifecycleService> = {}): ThreadLifecycleService {
  return {
    close: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    closeAsSystem: vi.fn(() => Promise.resolve({ outcome: "SUCCESS", changed: true } as const)),
    autoCloseAsSystem: vi.fn(() => Promise.resolve({ outcome: "SUCCESS", changed: true } as const)),
    open: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    autoOpen: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    ...overrides,
  };
}

function createScheduledThreadClose(
  overrides: Partial<ScheduledThreadCloseCommandService> = {},
  lifecycle = createLifecycle(),
): ScheduledThreadCloseCommandService {
  return {
    schedule: vi.fn(() => Promise.resolve({ ok: false, code: "PERSISTENCE_FAILURE" } as const)),
    cancel: vi.fn(() => Promise.resolve({ ok: true, outcome: "NOT_SCHEDULED" } as const)),
    closeManually: vi.fn<ScheduledThreadCloseCommandService["closeManually"]>(
      async (guildId, threadId, actorId) => ({
        outcome: "LIFECYCLE" as const,
        result: await lifecycle.close(guildId, threadId, actorId),
      }),
    ),
    ...overrides,
  };
}

function createMaintenance(
  overrides: Partial<AutomaticCloseThreadMaintenanceService> = {},
): AutomaticCloseThreadMaintenanceService {
  return {
    track: vi.fn(() =>
      Promise.resolve({ ok: true, outcome: "TRACKED", parentEnabled: true } as const),
    ),
    untrack: vi.fn(() => Promise.resolve({ ok: true, outcome: "EXCLUDED" } as const)),
    status: vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: {
          parentEnabled: true,
          excluded: false,
          effectiveEnabled: true,
          inactivitySeconds: 604_800,
          lastActivityAt: null,
          scheduledClose: undefined,
        },
      } as const),
    ),
    ...overrides,
  };
}

function handleThreadCommand(
  interaction: ChatInputCommandInteraction,
  lifecycle: ThreadLifecycleService,
  commandLogger: typeof logger,
  timeoutMs = DEFAULT_INTERACTION_IO_TIMEOUT_MS,
  scheduledThreadClose?: ScheduledThreadCloseCommandService,
  automaticCloseMaintenance?: AutomaticCloseThreadMaintenanceService,
): Promise<void> {
  return handleThreadCommandWithDependencies(
    interaction,
    lifecycle,
    scheduledThreadClose ?? createScheduledThreadClose({}, lifecycle),
    automaticCloseMaintenance ?? createMaintenance(),
    commandLogger,
    timeoutMs,
  );
}

function createScheduledAction(executeAt: Date) {
  return {
    id: "scheduled-action-id",
    guildId: "guild-id",
    actionType: "CLOSE_THREAD" as const,
    targetId: "thread-id",
    status: "ACTIVE" as const,
    executeAt,
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    updatedAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

function createInteraction({
  inGuild = true,
  isThread = true,
  subcommand = "close",
  after = "30m",
  deferred = false,
  replied = false,
  reply: replyOverride,
  deferReply: deferReplyOverride,
  editReply: editReplyOverride,
}: {
  inGuild?: boolean;
  isThread?: boolean;
  subcommand?: string;
  after?: string;
  deferred?: boolean;
  replied?: boolean;
  reply?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  deferReply?: ReturnType<typeof vi.fn<() => Promise<void>>>;
  editReply?: ReturnType<typeof vi.fn>;
} = {}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn<() => Promise<void>>>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const reply = replyOverride ?? vi.fn(() => Promise.resolve());
  const deferReply = deferReplyOverride ?? vi.fn(() => Promise.resolve());
  const editReply = editReplyOverride ?? vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? "guild-id" : null,
    channelId: inGuild ? "thread-id" : null,
    channel: isThread ? { isThread: () => true, type: ChannelType.PublicThread } : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => true },
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string) => (name === "after" ? after : null),
    },
    user: { id: "actor-id" },
    deferred,
    replied,
    deferReply,
    editReply,
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply, deferReply, editReply };
}

function edited(content: string) {
  return {
    content,
    allowedMentions: { parse: [] },
  };
}

function ephemeral(content: string) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}
