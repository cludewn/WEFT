import { readFileSync } from "node:fs";
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
      locale: "en-US",
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
      locale: "en-US",
      commandName,
      reply,
    } as unknown as ChatInputCommandInteraction;

    await expect(handleCommand(interaction, dependencies)).resolves.toBe(false);
    expect(reply).not.toHaveBeenCalled();
  });
});

type CommandTextNode = {
  name: string;
  description?: string | undefined;
  value?: string | number | undefined;
  name_localizations?: Record<string, string | null | undefined> | null | undefined;
  description_localizations?: Record<string, string | null | undefined> | null | undefined;
  options?: CommandTextNode[] | undefined;
  choices?: CommandTextNode[] | undefined;
};

it("uses the managed-message term for send/edit while keeping scheduled posts distinct", () => {
  const command: CommandTextNode | undefined = commandDefinitions.find(
    (definition) => definition.name === "message",
  );
  expect(command?.options?.find((option) => option.name === "send")).toMatchObject({
    description: "Send a managed message",
    description_localizations: { ja: "管理メッセージを送信します" },
  });
  expect(command?.options?.find((option) => option.name === "edit")).toMatchObject({
    description: "Edit a managed message",
    description_localizations: { ja: "管理メッセージを編集します" },
  });
  expect(command?.options?.find((option) => option.name === "schedule")).toMatchObject({
    description: "Manage scheduled posts",
    description_localizations: { ja: "予約投稿を管理します" },
  });
});

it("keeps command metadata within Discord field limits and the 8,000 character budget", () => {
  // Discord counts the longest default/localized variant of each field towards the budget.
  // https://docs.discord.com/developers/interactions/application-commands#slash-commands
  const localizedPaths: string[] = [];
  function localizedValues(
    values: Record<string, string | null | undefined> | null | undefined,
  ): string[] {
    return Object.values(values ?? {}).map((value) => {
      if (typeof value !== "string") throw new Error("Expected a nonempty localization");
      return value;
    });
  }
  function textLength(node: CommandTextNode, path: string, choice = false): number {
    const names = [node.name, ...localizedValues(node.name_localizations)];
    const descriptions = [
      node.description ?? "",
      ...localizedValues(node.description_localizations),
    ];
    for (const name of names) {
      expect(name.length).toBeGreaterThanOrEqual(1);
      expect(name.length).toBeLessThanOrEqual(choice ? 100 : 32);
    }
    for (const description of descriptions) {
      if (!choice) expect(description.length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(100);
    }
    if (!choice) {
      expect(node.name_localizations).toBeUndefined();
      expect(node.description_localizations?.ja).toEqual(expect.any(String));
    } else {
      expect(node.name_localizations?.ja).toEqual(expect.any(String));
    }
    if (typeof node.value === "string") expect(node.value.length).toBeLessThanOrEqual(100);
    if (node.description_localizations) {
      expect(Object.keys(node.description_localizations)).toEqual(["ja"]);
      localizedPaths.push(`${path}.description`);
    }
    if (node.name_localizations) {
      expect(Object.keys(node.name_localizations)).toEqual(["ja"]);
      localizedPaths.push(`${path}.name`);
    }
    expect(node.options?.length ?? 0).toBeLessThanOrEqual(25);
    expect(node.choices?.length ?? 0).toBeLessThanOrEqual(25);
    return (
      Math.max(...names.map((name) => name.length)) +
      Math.max(...descriptions.map((description) => description.length)) +
      (typeof node.value === "string" ? node.value.length : 0) +
      (node.options ?? []).reduce(
        (sum, option) => sum + textLength(option, `${path}/${option.name}`),
        0,
      ) +
      (node.choices ?? []).reduce(
        (sum, option) => sum + textLength(option, `${path}/${String(option.value)}`, true),
        0,
      )
    );
  }
  for (const command of commandDefinitions) {
    expect(textLength(command, command.name)).toBeLessThanOrEqual(8_000);
  }
  expect(localizedPaths.filter((path) => path.endsWith(".description"))).toHaveLength(67);
  expect(localizedPaths.filter((path) => path.endsWith(".name"))).toHaveLength(8);
});

it("preserves every English command default, identity, requirement and option order", () => {
  function stripLocalizations(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripLocalizations);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "name_localizations" && key !== "description_localizations")
          .map(([key, item]: [string, unknown]) => [key, stripLocalizations(item)]),
      );
    }
    return value;
  }
  const expected: unknown = JSON.parse(
    readFileSync(new URL("./command-defaults.json", import.meta.url), "utf8"),
  );
  expect(stripLocalizations(commandDefinitions)).toEqual(expected);
});
