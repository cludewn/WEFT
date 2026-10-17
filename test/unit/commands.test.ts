import { InteractionContextType, PermissionFlagsBits } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { ChatInputCommandInteraction } from "discord.js";

import { commandDefinitions, handleCommand } from "../../src/commands.js";
import type { CommandDependencies } from "../../src/commands.js";

const dependencies = {
  guildSettings: {
    getOrCreate: vi.fn(),
    setTimezone: vi.fn(),
    setClosedPrefix: vi.fn(),
    disableClosedPrefix: vi.fn(),
  },
  scheduledThreadClose: {
    schedule: vi.fn(),
  },
  scheduledMessages: {
    create: vi.fn(),
    cancel: vi.fn(),
    status: vi.fn(),
  },
  threadLifecycle: {
    close: vi.fn(),
    open: vi.fn(),
    autoOpen: vi.fn(),
  },
  logger: { debug: vi.fn(), warn: vi.fn() },
} as unknown as CommandDependencies;

describe("Discord commands", () => {
  it("defines exactly config, thread, and message commands", () => {
    expect(commandDefinitions.map((command) => command.name)).toEqual([
      "config",
      "thread",
      "message",
    ]);
  });

  it("restricts every command to guild context while preserving human permission defaults", () => {
    const defaults = new Map([
      ["config", PermissionFlagsBits.ManageGuild.toString()],
      ["thread", PermissionFlagsBits.ManageThreads.toString()],
      ["message", PermissionFlagsBits.ManageMessages.toString()],
    ]);
    for (const command of commandDefinitions) {
      expect(command.contexts).toEqual([InteractionContextType.Guild]);
      expect(command.default_member_permissions ?? undefined).toBe(defaults.get(command.name));
    }
  });

  it("routes /message without changing existing command behavior", async () => {
    const showModal = vi.fn(() => Promise.resolve());
    const interaction = {
      commandName: "message",
      options: { getSubcommand: () => "send", getSubcommandGroup: () => null },
      inGuild: () => true,
      channel: { type: 0, isThread: () => false },
      memberPermissions: { has: () => true },
      showModal,
    } as unknown as ChatInputCommandInteraction;

    await expect(handleCommand(interaction, dependencies)).resolves.toBe(true);
    expect(showModal).toHaveBeenCalledOnce();
  });

  it.each(["ping", "unknown"])("reports /%s as unhandled without replying", async (commandName) => {
    const reply = vi.fn(() => Promise.resolve());
    const interaction = {
      commandName,
      reply,
    } as unknown as ChatInputCommandInteraction;

    await expect(handleCommand(interaction, dependencies)).resolves.toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});
