import { InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { configCommandDefinition, handleConfigCommand } from "../../src/config-command.js";
import {
  DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
  DEFAULT_CLOSED_PREFIX,
  DEFAULT_GUILD_TIMEZONE,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
} from "../../src/guild-settings.js";
import type { GuildSettings, GuildSettingsStore } from "../../src/guild-settings.js";

const defaultSettings: GuildSettings = {
  guildId: "123456789012345678",
  timezone: DEFAULT_GUILD_TIMEZONE,
  closedPrefix: DEFAULT_CLOSED_PREFIX,
  autoCloseInactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
  autoCloseBotMessagesCountAsActivity: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("config command", () => {
  it("is guild-only and defaults to ManageGuild permission", () => {
    const definition = configCommandDefinition.toJSON();

    expect(definition.contexts).toEqual([InteractionContextType.Guild]);
    expect(definition.default_member_permissions).toBe(PermissionFlagsBits.ManageGuild.toString());
    expect(definition.options?.map((option) => option.name)).toEqual([
      "show",
      "timezone",
      "closed-prefix",
    ]);
  });

  it("rejects use outside a guild ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });

    await handleConfigCommand(interaction, createStore());

    expect(reply).toHaveBeenCalledWith(ephemeral("This command can only be used in a guild."));
  });

  it("checks ManageGuild at execution time", async () => {
    const { interaction, reply } = createInteraction({ hasManageGuild: false });

    await handleConfigCommand(interaction, createStore());

    expect(reply).toHaveBeenCalledWith(
      ephemeral("You need the Manage Server permission to use this command."),
    );
  });

  it("shows initialized settings ephemerally", async () => {
    const store = createStore();
    const { interaction, reply } = createInteraction({ subcommand: "show" });

    await handleConfigCommand(interaction, store);

    expect(store.getOrCreate).toHaveBeenCalledWith(defaultSettings.guildId);
    expect(reply).toHaveBeenCalledWith(ephemeral("Timezone: UTC\nClosed prefix: [CLOSED]"));
  });

  it("updates timezone and closed prefix", async () => {
    const store = createStore();
    const timezoneInteraction = createInteraction({
      subcommand: "timezone",
      value: "Asia/Tokyo",
    });
    const prefixInteraction = createInteraction({ subcommand: "closed-prefix", value: "[DONE]" });

    await handleConfigCommand(timezoneInteraction.interaction, store);
    await handleConfigCommand(prefixInteraction.interaction, store);

    expect(store.setTimezone).toHaveBeenCalledWith(defaultSettings.guildId, "Asia/Tokyo");
    expect(store.setClosedPrefix).toHaveBeenCalledWith(defaultSettings.guildId, "[DONE]");
    expect(timezoneInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Timezone set to Asia/Tokyo."),
    );
    expect(prefixInteraction.reply).toHaveBeenCalledWith(ephemeral("Closed prefix set to [DONE]."));
  });

  it("returns validation failures ephemerally", async () => {
    const timezoneStore = createStore({
      setTimezone: vi.fn(() => Promise.reject(new InvalidTimezoneError())),
    });
    const prefixStore = createStore({
      setClosedPrefix: vi.fn(() => Promise.reject(new InvalidClosedPrefixError())),
    });
    const timezoneInteraction = createInteraction({ subcommand: "timezone", value: "invalid" });
    const prefixInteraction = createInteraction({ subcommand: "closed-prefix", value: "" });

    await handleConfigCommand(timezoneInteraction.interaction, timezoneStore);
    await handleConfigCommand(prefixInteraction.interaction, prefixStore);

    expect(timezoneInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Timezone must be a valid IANA timezone"),
    );
    expect(prefixInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Closed prefix must be 1 to 20 characters and contain no control characters"),
    );
  });
});

function createStore(overrides: Partial<GuildSettingsStore> = {}): GuildSettingsStore {
  return {
    getOrCreate: vi.fn(() => Promise.resolve(defaultSettings)),
    setTimezone: vi.fn<GuildSettingsStore["setTimezone"]>((_guildId, timezone) =>
      Promise.resolve({ ...defaultSettings, timezone }),
    ),
    setClosedPrefix: vi.fn<GuildSettingsStore["setClosedPrefix"]>((_guildId, closedPrefix) =>
      Promise.resolve({ ...defaultSettings, closedPrefix }),
    ),
    setAutoCloseInactivitySeconds: vi.fn<GuildSettingsStore["setAutoCloseInactivitySeconds"]>(
      (_guildId, autoCloseInactivitySeconds) =>
        Promise.resolve({ ...defaultSettings, autoCloseInactivitySeconds }),
    ),
    setAutoCloseBotMessagesCountAsActivity: vi.fn<
      GuildSettingsStore["setAutoCloseBotMessagesCountAsActivity"]
    >((_guildId, autoCloseBotMessagesCountAsActivity) =>
      Promise.resolve({ ...defaultSettings, autoCloseBotMessagesCountAsActivity }),
    ),
    ...overrides,
  };
}

function createInteraction({
  inGuild = true,
  hasManageGuild = true,
  subcommand = "show",
  value = "",
}: {
  inGuild?: boolean;
  hasManageGuild?: boolean;
  subcommand?: string;
  value?: string;
} = {}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? defaultSettings.guildId : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => hasManageGuild },
    options: {
      getSubcommand: () => subcommand,
      getString: () => value,
    },
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
