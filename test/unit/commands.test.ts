import { MessageFlags } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import { commandDefinitions, handleCommand } from "../../src/commands.js";
import type { CommandDependencies } from "../../src/commands.js";

const dependencies = {
  guildSettings: {
    getOrCreate: vi.fn(),
    setTimezone: vi.fn(),
    setClosedPrefix: vi.fn(),
  },
  scheduledThreadClose: {
    schedule: vi.fn(),
  },
  threadLifecycle: {
    close: vi.fn(),
    open: vi.fn(),
    autoOpen: vi.fn(),
  },
  logger: { debug: vi.fn(), warn: vi.fn() },
} as unknown as CommandDependencies;

describe("Discord commands", () => {
  it("shares the ping command definition", () => {
    expect(commandDefinitions).toHaveLength(3);
    expect(commandDefinitions[0]?.name).toBe("ping");
    expect(commandDefinitions[0]?.description).toBe("Check whether WEFT is responding");
  });

  it("replies to ping ephemerally", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const interaction = { commandName: "ping", reply } as unknown as ChatInputCommandInteraction;

    await expect(handleCommand(interaction, dependencies)).resolves.toBe(true);

    expect(reply).toHaveBeenCalledWith({ content: "Pong!", flags: MessageFlags.Ephemeral });
  });

  it("reports an unknown command as unhandled without replying", async () => {
    const reply = vi.fn(() => Promise.resolve());
    const interaction = {
      commandName: "unknown",
      reply,
    } as unknown as ChatInputCommandInteraction;

    await expect(handleCommand(interaction, dependencies)).resolves.toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});
