import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AutomaticCloseConfigurationService } from "../../src/automatic-close-configuration.js";
import {
  AUTO_CLOSE_PARENT_DISPLAY_LIMIT,
  configCommandDefinition,
  handleConfigCommand,
} from "../../src/config-command.js";
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
      "auto-close",
    ]);
  });

  it("rejects use outside a guild ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });

    await handleConfigCommand(interaction, createStore(), createAutomaticClose());

    expect(reply).toHaveBeenCalledWith(ephemeral("This command can only be used in a guild."));
  });

  it("checks ManageGuild at execution time", async () => {
    const { interaction, reply } = createInteraction({ hasManageGuild: false });

    await handleConfigCommand(interaction, createStore(), createAutomaticClose());

    expect(reply).toHaveBeenCalledWith(
      ephemeral("You need the Manage Server permission to use this command."),
    );
  });

  it("shows initialized settings ephemerally", async () => {
    const store = createStore();
    const { interaction, reply } = createInteraction({ subcommand: "show" });

    await handleConfigCommand(interaction, store, createAutomaticClose());

    expect(store.getOrCreate).toHaveBeenCalledWith(defaultSettings.guildId);
    expect(reply).toHaveBeenCalledWith(
      ephemeral(
        "Timezone: UTC\nClosed prefix: [CLOSED]\nAutomatic close: disabled (no parent channels)",
      ),
    );
  });

  it("updates timezone and closed prefix", async () => {
    const store = createStore();
    const timezoneInteraction = createInteraction({
      subcommand: "timezone",
      value: "Asia/Tokyo",
    });
    const prefixInteraction = createInteraction({ subcommand: "closed-prefix", value: "[DONE]" });

    await handleConfigCommand(timezoneInteraction.interaction, store, createAutomaticClose());
    await handleConfigCommand(prefixInteraction.interaction, store, createAutomaticClose());

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

    await handleConfigCommand(
      timezoneInteraction.interaction,
      timezoneStore,
      createAutomaticClose(),
    );
    await handleConfigCommand(prefixInteraction.interaction, prefixStore, createAutomaticClose());

    expect(timezoneInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Timezone must be a valid IANA timezone"),
    );
    expect(prefixInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Closed prefix must be 1 to 20 characters and contain no control characters"),
    );
  });
});

describe("automatic close configuration command", () => {
  it("exposes the approved automatic close subcommand group", () => {
    const definition = configCommandDefinition.toJSON();
    const group = definition.options?.find((option) => option.name === "auto-close");

    expect(group?.type).toBe(2);
    expect(
      (group as { options?: { name: string }[] } | undefined)?.options?.map(
        (option) => option.name,
      ),
    ).toEqual(["show", "inactivity", "bot-messages", "add-parent", "remove-parent"]);
  });

  it("restricts the add-parent channel option to supported parent types", () => {
    const definition = configCommandDefinition.toJSON();
    const group = definition.options?.find((option) => option.name === "auto-close") as
      { options?: { name: string; options?: { channel_types?: number[] }[] }[] } | undefined;
    const addParent = group?.options?.find((option) => option.name === "add-parent");

    expect(addParent?.options?.[0]?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
      ChannelType.GuildForum,
    ]);
  });

  it("shows automatic close details with channel mentions", async () => {
    const automaticClose = createAutomaticClose({
      show: vi.fn(() =>
        Promise.resolve({
          inactivitySeconds: 43_200,
          botMessagesCountAsActivity: true,
          parentChannelIds: ["111", "222"],
        }),
      ),
    });
    const { interaction, reply } = createInteraction({ group: "auto-close", subcommand: "show" });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(reply).toHaveBeenCalledWith(
      ephemeral(
        "Inactivity: 12h\nBot messages count as activity: yes\nParent channels (2): <#111> <#222>",
      ),
    );
  });

  it("limits the displayed parent channels and reports the remainder", async () => {
    const parentChannelIds = Array.from({ length: 30 }, (_, index) => `channel-${index}`);
    const automaticClose = createAutomaticClose({
      show: vi.fn(() =>
        Promise.resolve({
          inactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
          botMessagesCountAsActivity: false,
          parentChannelIds,
        }),
      ),
    });
    const { interaction, reply } = createInteraction({ group: "auto-close", subcommand: "show" });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    const content = (reply.mock.calls[0]?.[0] as { content: string }).content;
    expect(content).toContain(`Parent channels (30):`);
    expect(content).toContain("... and 5 more");
    expect(content.match(/<#/g)).toHaveLength(AUTO_CLOSE_PARENT_DISPLAY_LIMIT);
    expect(content.length).toBeLessThan(2_000);
  });

  it("summarizes automatic close inside /config show once parents exist", async () => {
    const automaticClose = createAutomaticClose({
      show: vi.fn(() =>
        Promise.resolve({
          inactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
          botMessagesCountAsActivity: true,
          parentChannelIds: ["111"],
        }),
      ),
    });
    const { interaction, reply } = createInteraction({ subcommand: "show" });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(reply).toHaveBeenCalledWith(
      ephemeral(
        "Timezone: UTC\nClosed prefix: [CLOSED]\nAutomatic close: 7d inactivity, 1 parent channel, bot messages counted",
      ),
    );
  });

  it("stores a parsed inactivity duration", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "inactivity",
      value: "12h",
    });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(automaticClose.setInactivitySeconds).toHaveBeenCalledWith(
      defaultSettings.guildId,
      43_200,
    );
    expect(reply).toHaveBeenCalledWith(ephemeral("Automatic close inactivity set to 12h."));
  });

  it("rejects malformed and out-of-range inactivity input without persisting", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "inactivity",
      value: "1m",
    });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(automaticClose.setInactivitySeconds).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      ephemeral("Use one duration from 5 minutes through 365 days, such as 30m, 12h, or 7d."),
    );
  });

  it("configures the bot-message activity policy", async () => {
    const automaticClose = createAutomaticClose();
    const enabled = createInteraction({
      group: "auto-close",
      subcommand: "bot-messages",
      booleanValue: true,
    });

    await handleConfigCommand(enabled.interaction, createStore(), automaticClose);

    expect(automaticClose.setBotMessagesCountAsActivity).toHaveBeenCalledWith(
      defaultSettings.guildId,
      true,
    );
    expect(enabled.reply).toHaveBeenCalledWith(
      ephemeral("Bot messages now count as thread activity."),
    );
  });

  it("rejects an unsupported parent channel type before touching persistence", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "add-parent",
      channel: { id: "999", type: ChannelType.GuildVoice },
    });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(automaticClose.addParentChannel).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(
      ephemeral("Automatic close supports text, announcement, and forum channels as parents only."),
    );
  });

  it.each([
    [
      { outcome: "ENABLED", baselinesApplied: 2 } as const,
      "Automatic close enabled for <#777>. 2 active threads received a new inactivity baseline.",
    ],
    [
      { outcome: "ENABLED", baselinesApplied: 0 } as const,
      "Automatic close enabled for <#777>. No active threads needed a new inactivity baseline.",
    ],
    [{ outcome: "ALREADY_ENABLED" } as const, "Automatic close is already enabled for <#777>."],
    [
      { outcome: "ENUMERATION_FAILED" } as const,
      "WEFT could not read this server's active threads, so the channel was not enabled. Please try again later.",
    ],
  ])("reports the add-parent outcome %#", async (outcome, expected) => {
    const automaticClose = createAutomaticClose({
      addParentChannel: vi.fn<AutomaticCloseConfigurationService["addParentChannel"]>(() =>
        Promise.resolve(outcome),
      ),
    });
    const { interaction, reply, editReply } = createInteraction({
      group: "auto-close",
      subcommand: "add-parent",
      channel: { id: "777", type: ChannelType.GuildForum },
    });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(reply).toHaveBeenCalledWith(ephemeral("Enabling automatic close for this channel..."));
    expect(editReply).toHaveBeenCalledWith({
      content: expected,
      allowedMentions: { parse: [] },
    });
  });

  it("removes a parent channel idempotently", async () => {
    const automaticClose = createAutomaticClose({
      removeParentChannel: vi.fn<AutomaticCloseConfigurationService["removeParentChannel"]>(() =>
        Promise.resolve({ outcome: "NOT_CONFIGURED" }),
      ),
    });
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "remove-parent",
      channel: { id: "555", type: ChannelType.GuildText },
    });

    await handleConfigCommand(interaction, createStore(), automaticClose);

    expect(automaticClose.removeParentChannel).toHaveBeenCalledWith(defaultSettings.guildId, "555");
    expect(reply).toHaveBeenCalledWith(ephemeral("Automatic close is not enabled for <#555>."));
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
  group = null,
  subcommand = "show",
  value = "",
  booleanValue = false,
  channel = null,
}: {
  inGuild?: boolean;
  hasManageGuild?: boolean;
  group?: string | null;
  subcommand?: string;
  value?: string;
  booleanValue?: boolean;
  channel?: { id: string; type: ChannelType } | null;
} = {}): {
  interaction: ChatInputCommandInteraction;
  reply: ReturnType<typeof vi.fn>;
  editReply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? defaultSettings.guildId : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => hasManageGuild },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => subcommand,
      getString: () => value,
      getBoolean: () => booleanValue,
      getChannel: () => channel,
    },
    reply,
    editReply,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, reply, editReply };
}

function createAutomaticClose(
  overrides: Partial<AutomaticCloseConfigurationService> = {},
): AutomaticCloseConfigurationService {
  return {
    show: vi.fn(() =>
      Promise.resolve({
        inactivitySeconds: DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
        botMessagesCountAsActivity: false,
        parentChannelIds: [],
      }),
    ),
    setInactivitySeconds: vi.fn<AutomaticCloseConfigurationService["setInactivitySeconds"]>(
      (_guildId, autoCloseInactivitySeconds) =>
        Promise.resolve({ ...defaultSettings, autoCloseInactivitySeconds }),
    ),
    setBotMessagesCountAsActivity: vi.fn<
      AutomaticCloseConfigurationService["setBotMessagesCountAsActivity"]
    >((_guildId, autoCloseBotMessagesCountAsActivity) =>
      Promise.resolve({ ...defaultSettings, autoCloseBotMessagesCountAsActivity }),
    ),
    addParentChannel: vi.fn<AutomaticCloseConfigurationService["addParentChannel"]>(() =>
      Promise.resolve({ outcome: "ENABLED", baselinesApplied: 2 }),
    ),
    removeParentChannel: vi.fn<AutomaticCloseConfigurationService["removeParentChannel"]>(() =>
      Promise.resolve({ outcome: "REMOVED" }),
    ),
    ...overrides,
  };
}

function ephemeral(content: string) {
  return {
    content,
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}
