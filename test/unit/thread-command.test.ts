import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

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
    ]);
    expect(definition.options?.at(2)).toMatchObject({
      name: "close-after",
      options: [{ name: "after", required: true }],
    });
    expect(DEFAULT_INTERACTION_IO_TIMEOUT_MS).toBe(2_500);
  });

  it("rejects non-guild contexts ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });
    await handleThreadCommand(interaction, createLifecycle(), logger);
    expect(reply).toHaveBeenCalledWith(
      ephemeral("This command can only be used in a supported active thread."),
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
});

function createLifecycle(overrides: Partial<ThreadLifecycleService> = {}): ThreadLifecycleService {
  return {
    close: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    closeAsSystem: vi.fn(() => Promise.resolve({ outcome: "SUCCESS", changed: true } as const)),
    open: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    autoOpen: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    ...overrides,
  };
}

function createScheduledThreadClose(
  overrides: Partial<ScheduledThreadCloseCommandService> = {},
): ScheduledThreadCloseCommandService {
  return {
    schedule: vi.fn(() => Promise.resolve({ ok: false, code: "PERSISTENCE_FAILURE" } as const)),
    ...overrides,
  };
}

function handleThreadCommand(
  interaction: ChatInputCommandInteraction,
  lifecycle: ThreadLifecycleService,
  commandLogger: typeof logger,
  timeoutMs = DEFAULT_INTERACTION_IO_TIMEOUT_MS,
  scheduledThreadClose = createScheduledThreadClose(),
): Promise<void> {
  return handleThreadCommandWithDependencies(
    interaction,
    lifecycle,
    scheduledThreadClose,
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
