import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import { handleThreadCommand, threadCommandDefinition } from "../../src/thread-command.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

describe("thread command", () => {
  it("defines guild-only close and open subcommands with ManageThreads permission", () => {
    const definition = threadCommandDefinition.toJSON();

    expect(definition.contexts).toEqual([InteractionContextType.Guild]);
    expect(definition.default_member_permissions).toBe(
      PermissionFlagsBits.ManageThreads.toString(),
    );
    expect(definition.options?.map((option) => option.name)).toEqual(["close", "open"]);
  });

  it("rejects non-guild contexts ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });
    await handleThreadCommand(interaction, createLifecycle());
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
    );
    await handleThreadCommand(
      denied.interaction,
      createLifecycle({
        close: vi.fn(() =>
          Promise.resolve({ ok: false, code: "ACTOR_PERMISSION_MISSING" } as const),
        ),
      }),
    );
    expect(unsupported.editReply).toHaveBeenCalledWith(
      edited("This command can only be used in a supported active thread."),
    );
    expect(denied.editReply).toHaveBeenCalledWith(
      edited("You need the Manage Threads permission to use this command."),
    );
  });

  it("defers ephemerally before lifecycle work and edits the deferred success reply", async () => {
    const order: string[] = [];
    const lifecycle = createLifecycle({
      close: vi.fn(() => {
        order.push("lifecycle");
        return Promise.resolve({ ok: true, changed: true } as const);
      }),
    });
    const close = createInteraction({
      deferReply: vi.fn(() => {
        order.push("defer");
        return Promise.resolve();
      }),
    });

    await handleThreadCommand(close.interaction, lifecycle);

    expect(order).toEqual(["defer", "lifecycle"]);
    expect(close.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(close.editReply).toHaveBeenCalledWith(edited("Thread closed."));
    expect(close.reply).not.toHaveBeenCalled();
  });

  it("routes close and open for the current thread only", async () => {
    const lifecycle = createLifecycle();
    const close = createInteraction({ subcommand: "close" });
    const open = createInteraction({ subcommand: "open" });

    await handleThreadCommand(close.interaction, lifecycle);
    await handleThreadCommand(open.interaction, lifecycle);

    expect(lifecycle.close).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(lifecycle.open).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(close.editReply).toHaveBeenCalledWith(edited("Thread closed."));
    expect(open.editReply).toHaveBeenCalledWith(edited("Thread opened."));
  });

  it("returns safe lifecycle failures ephemerally", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "BOT_PERMISSION_MISSING" } as const)),
    });
    const { interaction, editReply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle);

    expect(editReply).toHaveBeenCalledWith(
      edited("WEFT cannot manage this thread with its current permissions."),
    );
  });

  it("explains that locked threads must be unlocked manually", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "THREAD_LOCKED" } as const)),
    });
    const { interaction, editReply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle);

    expect(editReply).toHaveBeenCalledWith(
      edited("A locked thread cannot be soft-closed. Unlock it manually before retrying."),
    );
  });

  it("does not start lifecycle work when deferReply fails", async () => {
    const lifecycle = createLifecycle();
    const failure = new Error("opaque failure");
    const { interaction, editReply } = createInteraction({
      deferReply: vi.fn(() => Promise.reject(failure)),
    });

    await expect(handleThreadCommand(interaction, lifecycle)).rejects.toBe(failure);

    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(editReply).not.toHaveBeenCalled();
  });

  it("acknowledges before a delayed lifecycle result", async () => {
    let resolveLifecycle: ((result: { ok: true; changed: true }) => void) | undefined;
    const lifecycleResult = new Promise<{ ok: true; changed: true }>((resolve) => {
      resolveLifecycle = resolve;
    });
    const lifecycle = createLifecycle({ close: vi.fn(() => lifecycleResult) });
    const fixture = createInteraction();

    const handling = handleThreadCommand(fixture.interaction, lifecycle);
    await vi.waitFor(() => {
      expect(fixture.deferReply).toHaveBeenCalledOnce();
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

      await handleThreadCommand(fixture.interaction, createLifecycle());

      expect(fixture.deferReply).not.toHaveBeenCalled();
      expect(fixture.reply).not.toHaveBeenCalled();
      expect(fixture.editReply).toHaveBeenCalledWith(edited("Thread closed."));
    }
  });
});

function createLifecycle(overrides: Partial<ThreadLifecycleService> = {}): ThreadLifecycleService {
  return {
    close: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    open: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    autoOpen: vi.fn(() => Promise.resolve({ ok: true, changed: true } as const)),
    ...overrides,
  };
}

function createInteraction({
  inGuild = true,
  isThread = true,
  subcommand = "close",
  deferred = false,
  replied = false,
  deferReply: deferReplyOverride,
}: {
  inGuild?: boolean;
  isThread?: boolean;
  subcommand?: string;
  deferred?: boolean;
  replied?: boolean;
  deferReply?: ReturnType<typeof vi.fn<() => Promise<void>>>;
} = {}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  deferReply: ReturnType<typeof vi.fn<() => Promise<void>>>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const deferReply = deferReplyOverride ?? vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? "guild-id" : null,
    channelId: inGuild ? "thread-id" : null,
    channel: isThread ? { isThread: () => true, type: ChannelType.PublicThread } : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => true },
    options: { getSubcommand: () => subcommand },
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
