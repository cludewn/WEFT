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
    expect(unsupported.reply).toHaveBeenCalledWith(
      ephemeral("This command can only be used in a supported active thread."),
    );
    const { reply } = denied;
    expect(reply).toHaveBeenCalledWith(
      ephemeral("You need the Manage Threads permission to use this command."),
    );
  });

  it("routes close and open for the current thread only", async () => {
    const lifecycle = createLifecycle();
    const close = createInteraction({ subcommand: "close" });
    const open = createInteraction({ subcommand: "open" });

    await handleThreadCommand(close.interaction, lifecycle);
    await handleThreadCommand(open.interaction, lifecycle);

    expect(lifecycle.close).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(lifecycle.open).toHaveBeenCalledWith("guild-id", "thread-id", "actor-id");
    expect(close.reply).toHaveBeenCalledWith(ephemeral("Thread closed."));
    expect(open.reply).toHaveBeenCalledWith(ephemeral("Thread opened."));
  });

  it("returns safe lifecycle failures ephemerally", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "BOT_PERMISSION_MISSING" } as const)),
    });
    const { interaction, reply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle);

    expect(reply).toHaveBeenCalledWith(
      ephemeral("WEFT cannot manage this thread with its current permissions."),
    );
  });

  it("explains that locked threads must be unlocked manually", async () => {
    const lifecycle = createLifecycle({
      close: vi.fn(() => Promise.resolve({ ok: false, code: "THREAD_LOCKED" } as const)),
    });
    const { interaction, reply } = createInteraction();

    await handleThreadCommand(interaction, lifecycle);

    expect(reply).toHaveBeenCalledWith(
      ephemeral("A locked thread cannot be soft-closed. Unlock it manually before retrying."),
    );
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
}: {
  inGuild?: boolean;
  isThread?: boolean;
  subcommand?: string;
} = {}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? "guild-id" : null,
    channelId: inGuild ? "thread-id" : null,
    channel: isThread ? { isThread: () => true, type: ChannelType.PublicThread } : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => true },
    options: { getSubcommand: () => subcommand },
    user: { id: "actor-id" },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

function ephemeral(content: string) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}
