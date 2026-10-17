import { createLinkPreviewConfiguration } from "../../src/link-previews/link-preview-configuration.js";
import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits } from "discord.js";
import type { ChatInputCommandInteraction, InteractionEditReplyOptions } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import type { AuditLogDestinationService } from "../../src/audit/audit-log-destination.js";

import type { AutomaticCloseConfigurationService } from "../../src/threads/automatic-close-configuration.js";
import {
  AUTO_CLOSE_PARENT_DISPLAY_LIMIT,
  configCommandDefinition,
  handleConfigCommand,
} from "../../src/guild/config-command.js";
import {
  DEFAULT_AUTO_CLOSE_INACTIVITY_SECONDS,
  DEFAULT_CLOSED_PREFIX,
  DEFAULT_GUILD_TIMEZONE,
  InvalidClosedPrefixError,
  InvalidTimezoneError,
} from "../../src/guild/guild-settings.js";
import type { GuildSettings, GuildSettingsStore } from "../../src/guild/guild-settings.js";
import { createGuildSettingsStore, validateTimezone } from "../../src/guild/guild-settings.js";
import type { DatabaseClient } from "../../src/database.js";

const defaultSettings: GuildSettings = {
  guildId: "123456789012345678",
  timezone: DEFAULT_GUILD_TIMEZONE,
  closedPrefix: DEFAULT_CLOSED_PREFIX,
  auditLogChannelId: null,
  linkPreviewMode: "hybrid",
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
      "link-preview",
      "audit-log",
      "auto-close",
    ]);
  });

  it("rejects use outside a guild ephemerally", async () => {
    const { interaction, reply } = createInteraction({ inGuild: false });

    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(reply).toHaveBeenCalledWith(ephemeral("This command can only be used in a guild."));
  });

  it("checks ManageGuild at execution time", async () => {
    const { interaction, reply } = createInteraction({ hasManageGuild: false });

    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(reply).toHaveBeenCalledWith(
      ephemeral("You need the Manage Server permission to use this command."),
    );
  });

  it("shows initialized settings ephemerally", async () => {
    const store = createStore();
    const { interaction, editReply } = createInteraction({ subcommand: "show" });

    await handleConfigCommand(
      interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(store.getOrCreate).toHaveBeenCalledWith(defaultSettings.guildId);
    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Timezone: UTC\nClosed prefix: [CLOSED]\nDiscord audit notifications: disabled; database auditing and retention remain enabled\nAutomatic close: disabled (no enabled parent channels); guild-wide inactivity threshold: 7d\nLink preview mode: Automatic public previews + optional buttons",
      ),
    );
  });

  it("includes a configured audit destination in top-level show", async () => {
    const settings = { ...defaultSettings, auditLogChannelId: "stored-channel" };
    const store = createStore({ getOrCreate: vi.fn(() => Promise.resolve(settings)) });
    const { interaction, editReply } = createInteraction({ subcommand: "show" });
    await handleConfigCommand(
      interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );
    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Timezone: UTC\nClosed prefix: [CLOSED]\nDiscord audit notifications: <#stored-channel>; database auditing and retention remain enabled\nAutomatic close: disabled (no enabled parent channels); guild-wide inactivity threshold: 7d\nLink preview mode: Automatic public previews + optional buttons",
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

    await handleConfigCommand(
      timezoneInteraction.interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );
    await handleConfigCommand(
      prefixInteraction.interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(store.setTimezone).toHaveBeenCalledWith(
      defaultSettings.guildId,
      "Asia/Tokyo",
      expect.objectContaining({
        actorUserId: "actor",
        auditId: expect.any(String) as string,
        occurredAt: expect.any(Date) as Date,
      }),
    );
    expect(store.setClosedPrefix).toHaveBeenCalledWith(
      defaultSettings.guildId,
      "[DONE]",
      expect.objectContaining({
        actorUserId: "actor",
        auditId: expect.any(String) as string,
        occurredAt: expect.any(Date) as Date,
      }),
    );
    expect(timezoneInteraction.editReply).toHaveBeenCalledWith({
      content: "Timezone set to Asia/Tokyo.",
      allowedMentions: { parse: [] },
    });
    expect(prefixInteraction.editReply).toHaveBeenCalledWith({
      content: "Closed prefix set to [DONE].",
      allowedMentions: { parse: [] },
    });
  });

  it.each(["Asia/Tokyo", "America/New_York", "UTC"])(
    "accepts supported timezone %s through config validation",
    async (value) => {
      const store = createStore({
        setTimezone: vi.fn<GuildSettingsStore["setTimezone"]>((_guildId, timezone) =>
          Promise.resolve({
            outcome: "CHANGED" as const,
            settings: { ...defaultSettings, timezone: validateTimezone(timezone) },
          }),
        ),
      });
      const { interaction, editReply, deferReply } = createInteraction({
        subcommand: "timezone",
        value,
      });
      await handleConfigCommand(
        interaction,
        store,
        createAutomaticClose(),
        createAuditDestination(),
        createPreviewConfig(),
      );
      expect(store.setTimezone).toHaveBeenCalledWith(
        defaultSettings.guildId,
        value,
        expect.objectContaining({ actorUserId: "actor" }),
      );
      expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(editReply).toHaveBeenCalledOnce();
      expect(editReply).toHaveBeenCalledWith({
        content: `Timezone set to ${value.replaceAll("_", "\\_")}.`,
        allowedMentions: { parse: [] },
      });
    },
  );

  it.each(["JST", "+09:00", "not/a-timezone"])(
    "rejects unsupported timezone %s before database access",
    async (value) => {
      const database = { insert: vi.fn(), select: vi.fn(), update: vi.fn() };
      const store = createGuildSettingsStore(database as unknown as DatabaseClient);
      const { interaction, reply } = createInteraction({ subcommand: "timezone", value });
      await handleConfigCommand(
        interaction,
        store,
        createAutomaticClose(),
        createAuditDestination(),
        createPreviewConfig(),
      );
      expect(reply).toHaveBeenCalledOnce();
      expect(reply).toHaveBeenCalledWith(
        ephemeral("Timezone must be a named IANA timezone, e.g. Asia/Tokyo, or UTC"),
      );
      expect(database.insert).not.toHaveBeenCalled();
      expect(database.select).not.toHaveBeenCalled();
      expect(database.update).not.toHaveBeenCalled();
    },
  );

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
      createAuditDestination(),
      createPreviewConfig(),
    );
    await handleConfigCommand(
      prefixInteraction.interaction,
      prefixStore,
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(timezoneInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Timezone must be a named IANA timezone, e.g. Asia/Tokyo, or UTC"),
    );
    expect(prefixInteraction.reply).toHaveBeenCalledWith(
      ephemeral("Closed prefix must be 1 to 20 characters and contain no control characters"),
    );
  });
});

describe("Discord audit notification configuration command", () => {
  it("restricts set to text and announcement channels", () => {
    const group = configCommandDefinition
      .toJSON()
      .options?.find((option) => option.name === "audit-log") as
      { options?: { name: string; options?: { channel_types?: number[] }[] }[] } | undefined;
    expect(group?.options?.map((option) => option.name)).toEqual(["show", "set", "disable"]);
    expect(group?.options?.[1]?.options?.[0]?.channel_types).toEqual([
      ChannelType.GuildText,
      ChannelType.GuildAnnouncement,
    ]);
  });

  it("shows the stored ID without calling the mutating settings store", async () => {
    const store = createStore();
    const destination = createAuditDestination();
    destination.show = vi.fn(() => Promise.resolve("stale-id"));
    const { interaction, editReply } = createInteraction({
      group: "audit-log",
      subcommand: "show",
    });
    await handleConfigCommand(
      interaction,
      store,
      createAutomaticClose(),
      destination,
      createPreviewConfig(),
    );
    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Discord audit notifications: <#stale-id>; database auditing and retention remain enabled",
      ),
    );
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(destination.show).toHaveBeenCalledWith(defaultSettings.guildId);
  });

  it("reports disabled for an absent settings row", async () => {
    const { interaction, editReply } = createInteraction({
      group: "audit-log",
      subcommand: "show",
    });
    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      createAuditDestination(),
      createPreviewConfig(),
    );
    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Discord audit notifications: disabled; database auditing and retention remain enabled",
      ),
    );
  });

  it("replies once with a bounded ephemeral error when the read fails", async () => {
    const destination = createAuditDestination();
    const failure = new Error("private database details must stay hidden");
    destination.show = vi.fn(() => Promise.reject(failure));
    const { interaction, editReply } = createInteraction({
      group: "audit-log",
      subcommand: "show",
    });
    await expect(
      handleConfigCommand(
        interaction,
        createStore(),
        createAutomaticClose(),
        destination,
        createPreviewConfig(),
      ),
    ).rejects.toBe(failure);
    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith(
      edited(
        "WEFT could not load the Discord audit notification configuration. Please try again later.",
      ),
    );
    expect(JSON.stringify(editReply.mock.calls)).not.toContain("private database details");
  });

  it("does not retry the response when the error reply fails", async () => {
    const destination = createAuditDestination();
    const failure = new Error("private database details must stay hidden");
    destination.show = vi.fn(() => Promise.reject(failure));
    const { interaction, editReply } = createInteraction({
      group: "audit-log",
      subcommand: "show",
    });
    editReply.mockImplementation(() => {
      throw new Error("Discord reply failed");
    });
    await expect(
      handleConfigCommand(
        interaction,
        createStore(),
        createAutomaticClose(),
        destination,
        createPreviewConfig(),
      ),
    ).rejects.toBe(failure);
    expect(editReply).toHaveBeenCalledOnce();
  });

  it.each([
    [
      { outcome: "CHANGED", previousChannelId: null },
      "Discord audit notification destination set to <#target>.",
    ],
    [{ outcome: "NO_CHANGE" }, "Discord audit notification destination is already <#target>."],
    [
      { outcome: "UNCONFIRMED" },
      "WEFT could not confirm the Discord audit notification configuration result. Check the setting before trying again.",
    ],
    [
      { outcome: "VALIDATION_FAILED" },
      "WEFT cannot use that channel as a Discord audit notification destination. Check its type and WEFT's View Channel and Send Messages permissions.",
    ],
  ] as const)("maps set result %# to one bounded ephemeral response", async (result, expected) => {
    const destination = createAuditDestination();
    destination.set = vi.fn(() => Promise.resolve(result));
    const { interaction, editReply, deferReply } = createInteraction({
      group: "audit-log",
      subcommand: "set",
      channel: { id: "target", type: ChannelType.GuildText },
    });
    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      destination,
      createPreviewConfig(),
    );
    expect(destination.set).toHaveBeenCalledWith(defaultSettings.guildId, "actor", "target");
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledOnce();
    expect(editReply).toHaveBeenCalledWith({ content: expected, allowedMentions: { parse: [] } });
  });

  it.each([
    [
      { outcome: "CHANGED", previousChannelId: "old" },
      "Discord audit notifications disabled. Database auditing and retention remain enabled.",
    ],
    [
      { outcome: "NO_CHANGE" },
      "Discord audit notifications already disabled (unchanged). Database auditing and retention remain enabled.",
    ],
    [
      { outcome: "UNCONFIRMED" },
      "WEFT could not confirm the Discord audit notification configuration result. Check the setting before trying again.",
    ],
  ] as const)(
    "maps disable result %# to one bounded ephemeral response",
    async (result, expected) => {
      const destination = createAuditDestination();
      destination.disable = vi.fn(() => Promise.resolve(result));
      const { interaction, editReply, deferReply } = createInteraction({
        group: "audit-log",
        subcommand: "disable",
      });
      await handleConfigCommand(
        interaction,
        createStore(),
        createAutomaticClose(),
        destination,
        createPreviewConfig(),
      );
      expect(destination.disable).toHaveBeenCalledWith(defaultSettings.guildId, "actor");
      expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(editReply).toHaveBeenCalledOnce();
      expect(editReply).toHaveBeenCalledWith({ content: expected, allowedMentions: { parse: [] } });
    },
  );

  it("sets using only the option ID and reports an unconfirmed result", async () => {
    const destination = createAuditDestination();
    destination.set = vi.fn(() => Promise.resolve({ outcome: "UNCONFIRMED" } as const));
    const { interaction, editReply, deferReply } = createInteraction({
      group: "audit-log",
      subcommand: "set",
      channel: { id: "target", type: ChannelType.GuildText },
    });
    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      destination,
      createPreviewConfig(),
    );
    expect(destination.set).toHaveBeenCalledWith(defaultSettings.guildId, "actor", "target");
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(editReply).toHaveBeenCalledWith({
      content:
        "WEFT could not confirm the Discord audit notification configuration result. Check the setting before trying again.",
      allowedMentions: { parse: [] },
    });
  });

  it("disables without using the channel option", async () => {
    const destination = createAuditDestination();
    destination.disable = vi.fn(() => Promise.resolve({ outcome: "NO_CHANGE" } as const));
    const { interaction, editReply } = createInteraction({
      group: "audit-log",
      subcommand: "disable",
    });
    await handleConfigCommand(
      interaction,
      createStore(),
      createAutomaticClose(),
      destination,
      createPreviewConfig(),
    );
    expect(destination.disable).toHaveBeenCalledWith(defaultSettings.guildId, "actor");
    expect(editReply).toHaveBeenCalledWith({
      content:
        "Discord audit notifications already disabled (unchanged). Database auditing and retention remain enabled.",
      allowedMentions: { parse: [] },
    });
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
    const { interaction, editReply } = createInteraction({
      group: "auto-close",
      subcommand: "show",
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Guild-wide inactivity threshold: 12h (shared by all enabled parents)\nBot messages count as activity: yes\nEnabled parent channels (2): <#111> <#222>\nIndividual thread exclusions apply. The threshold determines eligibility; closing occurs on a later sweep after state and permission checks.",
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
    const { interaction, editReply } = createInteraction({
      group: "auto-close",
      subcommand: "show",
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    const content = (editReply.mock.calls[0]?.[0] as { content: string }).content;
    expect(content).toContain(`Enabled parent channels (30):`);
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
    const { interaction, editReply } = createInteraction({ subcommand: "show" });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(editReply).toHaveBeenCalledWith(
      edited(
        "Timezone: UTC\nClosed prefix: [CLOSED]\nDiscord audit notifications: disabled; database auditing and retention remain enabled\nAutomatic close: guild-wide inactivity threshold 7d, 1 enabled parent channel, bot messages counted; individual thread exclusions apply\nLink preview mode: Automatic public previews + optional buttons",
      ),
    );
  });

  it("stores a parsed inactivity duration", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, editReply } = createInteraction({
      group: "auto-close",
      subcommand: "inactivity",
      value: "12h",
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(automaticClose.setInactivitySeconds).toHaveBeenCalledWith(
      defaultSettings.guildId,
      43_200,
      "actor",
    );
    expect(editReply).toHaveBeenCalledWith({
      content: "Guild-wide automatic-close inactivity threshold set to 12h.",
      allowedMentions: { parse: [] },
    });
  });

  it("rejects malformed and out-of-range inactivity input without persisting", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "inactivity",
      value: "1m",
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

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

    await handleConfigCommand(
      enabled.interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(automaticClose.setBotMessagesCountAsActivity).toHaveBeenCalledWith(
      defaultSettings.guildId,
      true,
      "actor",
    );
    expect(enabled.editReply).toHaveBeenCalledWith({
      content: "Bot messages now count as thread activity.",
      allowedMentions: { parse: [] },
    });
  });

  it("rejects an unsupported parent channel type before touching persistence", async () => {
    const automaticClose = createAutomaticClose();
    const { interaction, reply } = createInteraction({
      group: "auto-close",
      subcommand: "add-parent",
      channel: { id: "999", type: ChannelType.GuildVoice },
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

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

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

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
    const { interaction, editReply } = createInteraction({
      group: "auto-close",
      subcommand: "remove-parent",
      channel: { id: "555", type: ChannelType.GuildText },
    });

    await handleConfigCommand(
      interaction,
      createStore(),
      automaticClose,
      createAuditDestination(),
      createPreviewConfig(),
    );

    expect(automaticClose.removeParentChannel).toHaveBeenCalledWith(
      defaultSettings.guildId,
      "555",
      "actor",
    );
    expect(editReply).toHaveBeenCalledWith({
      content: "Automatic close is not enabled for <#555>. (unchanged)",
      allowedMentions: { parse: [] },
    });
  });
});

function createStore(overrides: Partial<GuildSettingsStore> = {}): GuildSettingsStore {
  return {
    getOrCreate: vi.fn(() => Promise.resolve(defaultSettings)),
    setTimezone: vi.fn<GuildSettingsStore["setTimezone"]>((_guildId, timezone) =>
      Promise.resolve({ outcome: "CHANGED" as const, settings: { ...defaultSettings, timezone } }),
    ),
    setClosedPrefix: vi.fn<GuildSettingsStore["setClosedPrefix"]>((_guildId, closedPrefix) =>
      Promise.resolve({
        outcome: "CHANGED" as const,
        settings: { ...defaultSettings, closedPrefix },
      }),
    ),
    setAutoCloseInactivitySeconds: vi.fn<GuildSettingsStore["setAutoCloseInactivitySeconds"]>(
      (_guildId, autoCloseInactivitySeconds) =>
        Promise.resolve({
          outcome: "CHANGED" as const,
          settings: { ...defaultSettings, autoCloseInactivitySeconds },
        }),
    ),
    setAutoCloseBotMessagesCountAsActivity: vi.fn<
      GuildSettingsStore["setAutoCloseBotMessagesCountAsActivity"]
    >((_guildId, autoCloseBotMessagesCountAsActivity) =>
      Promise.resolve({
        outcome: "CHANGED" as const,
        settings: { ...defaultSettings, autoCloseBotMessagesCountAsActivity },
      }),
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
  deferReply: ReturnType<typeof vi.fn>;
} {
  const reply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const deferReply = vi.fn(() => Promise.resolve());
  const interaction = {
    guildId: inGuild ? defaultSettings.guildId : null,
    inGuild: () => inGuild,
    memberPermissions: { has: () => hasManageGuild },
    user: { id: "actor" },
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => subcommand,
      getString: () => value,
      getBoolean: () => booleanValue,
      getChannel: () => channel,
    },
    reply,
    editReply,
    deferReply,
  } as unknown as ChatInputCommandInteraction;

  return { interaction, reply, editReply, deferReply };
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
        Promise.resolve({
          outcome: "CHANGED" as const,
          settings: { ...defaultSettings, autoCloseInactivitySeconds },
        }),
    ),
    setBotMessagesCountAsActivity: vi.fn<
      AutomaticCloseConfigurationService["setBotMessagesCountAsActivity"]
    >((_guildId, autoCloseBotMessagesCountAsActivity) =>
      Promise.resolve({
        outcome: "CHANGED" as const,
        settings: { ...defaultSettings, autoCloseBotMessagesCountAsActivity },
      }),
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

function createAuditDestination(): AuditLogDestinationService {
  return { show: vi.fn(() => Promise.resolve(null)), set: vi.fn(), disable: vi.fn() };
}

function createPreviewConfig() {
  return {
    show: vi.fn(() => Promise.resolve("hybrid" as const)),
    set: vi.fn(() => Promise.resolve({ outcome: "NO_CHANGE" as const })),
  };
}

describe("link preview configuration commands", () => {
  it.each([{ inGuild: false }, { hasManageGuild: false }])(
    "rejects unauthorized calls before storage",
    async (patch) => {
      const service = createPreviewConfig();
      const f = createInteraction({ group: "link-preview", ...patch });
      await handleConfigCommand(
        f.interaction,
        createStore(),
        createAutomaticClose(),
        createAuditDestination(),
        service,
      );
      expect(service.show).not.toHaveBeenCalled();
      expect(service.set).not.toHaveBeenCalled();
      expect(f.reply).toHaveBeenCalled();
    },
  );
  it("shows without creating settings and rejects invalid input before persistence", async () => {
    const store = createStore();
    const read = vi.fn(() => Promise.resolve("hybrid" as const));
    const change = vi.fn();
    const service = createLinkPreviewConfiguration({ read, change });
    const f = createInteraction({ group: "link-preview" });
    await handleConfigCommand(
      f.interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      service,
    );
    expect(store.getOrCreate).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledOnce();
    expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(f.editReply).toHaveBeenCalledWith({
      content: "Link preview mode: Automatic public previews + optional buttons",
      allowedMentions: { parse: [] },
    });
    const invalid = createInteraction({
      group: "link-preview",
      subcommand: "mode",
      value: "invalid",
    });
    await handleConfigCommand(
      invalid.interaction,
      store,
      createAutomaticClose(),
      createAuditDestination(),
      service,
    );
    expect(change).not.toHaveBeenCalled();
  });
  it.each([
    ["hybrid", "Automatic public previews + optional buttons"],
    ["public-only", "Automatic public previews only"],
    ["button-only", "Preview buttons only"],
    ["off", "Off"],
  ])("sets %s with a stable audit input", async (mode, label) => {
    const change = vi.fn(() => Promise.resolve({ outcome: "NO_CHANGE" as const }));
    const service = createLinkPreviewConfiguration({
      read: () => Promise.resolve("hybrid"),
      change,
    });
    const f = createInteraction({ group: "link-preview", subcommand: "mode", value: mode });
    await handleConfigCommand(
      f.interaction,
      createStore(),
      createAutomaticClose(),
      createAuditDestination(),
      service,
    );
    expect(change.mock.calls[0]).toMatchObject([
      { guildId: defaultSettings.guildId, actorUserId: "actor", newMode: mode },
    ]);
    expect(f.editReply).toHaveBeenCalledWith({
      content: `Link preview mode: ${label} (unchanged)`,
      allowedMentions: { parse: [] },
    });
  });
});

describe("configuration acknowledgement and unknown results", () => {
  it.each([
    [null, "timezone", "Asia/Tokyo", "setTimezone"],
    [null, "closed-prefix", "[DONE]", "setClosedPrefix"],
    ["auto-close", "inactivity", "12h", "setInactivitySeconds"],
    ["auto-close", "bot-messages", "", "setBotMessagesCountAsActivity"],
    ["auto-close", "add-parent", "", "addParentChannel"],
    ["auto-close", "remove-parent", "", "removeParentChannel"],
  ] as const)(
    "shows %s/%s UNCONFIRMED as unknown after ephemeral acknowledgement",
    async (group, subcommand, value, method) => {
      const store = createStore();
      const automatic = createAutomaticClose();
      const target =
        method === "setTimezone" || method === "setClosedPrefix"
          ? store[method]
          : automatic[method];
      vi.mocked(target).mockResolvedValueOnce({ outcome: "UNCONFIRMED" });
      const f = createInteraction({
        group,
        subcommand,
        value,
        channel: { id: "555", type: ChannelType.GuildText },
      });
      await handleConfigCommand(
        f.interaction,
        store,
        automatic,
        createAuditDestination(),
        createPreviewConfig(),
      );
      if (subcommand === "add-parent")
        expect(f.reply).toHaveBeenCalledWith(
          ephemeral("Enabling automatic close for this channel..."),
        );
      else expect(f.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
      expect(f.editReply).toHaveBeenCalledWith({
        content:
          "WEFT could not confirm the configuration change. Check the setting before trying again.",
        allowedMentions: { parse: [] },
      });
      expect(target).toHaveBeenCalledOnce();
    },
  );
  it.each(["timezone", "closed-prefix"] as const)(
    "shows normalized %s no-op as unchanged",
    async (subcommand) => {
      const store = createStore();
      vi.mocked(
        subcommand === "timezone" ? store.setTimezone : store.setClosedPrefix,
      ).mockResolvedValueOnce({ outcome: "NO_CHANGE", settings: defaultSettings });
      const f = createInteraction({
        subcommand,
        value: subcommand === "timezone" ? " utc " : " [CLOSED] ",
      });
      await handleConfigCommand(
        f.interaction,
        store,
        createAutomaticClose(),
        createAuditDestination(),
        createPreviewConfig(),
      );
      expect(f.editReply.mock.calls[0]![0]).toEqual({
        content: `${subcommand === "timezone" ? "Timezone set to UTC." : "Closed prefix set to [CLOSED]."} (unchanged)`,
        allowedMentions: { parse: [] },
      });
    },
  );
  it.each([
    [null, "timezone", "Asia/Tokyo", "setTimezone"],
    [null, "closed-prefix", "[DONE]", "setClosedPrefix"],
    ["auto-close", "inactivity", "12h", "setInactivitySeconds"],
    ["auto-close", "bot-messages", "", "setBotMessagesCountAsActivity"],
    ["auto-close", "add-parent", "", "addParentChannel"],
    ["auto-close", "remove-parent", "", "removeParentChannel"],
  ] as const)(
    "does not replay %s/%s after final Discord response loss",
    async (group, subcommand, value, method) => {
      const store = createStore();
      const automatic = createAutomaticClose();
      const f = createInteraction({
        group,
        subcommand,
        value,
        channel: { id: "555", type: ChannelType.GuildText },
      });
      f.editReply.mockRejectedValueOnce(new Error("Discord response lost"));
      await expect(
        handleConfigCommand(
          f.interaction,
          store,
          automatic,
          createAuditDestination(),
          createPreviewConfig(),
        ),
      ).rejects.toThrow("Discord response lost");
      const target =
        method === "setTimezone" || method === "setClosedPrefix"
          ? store[method]
          : automatic[method];
      expect(target).toHaveBeenCalledOnce();
      expect(f.editReply).toHaveBeenCalledOnce();
    },
  );
});

function edited(content: string) {
  return { content, allowedMentions: { parse: [] } };
}

function controlled<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushReadMicrotasks() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("configuration read acknowledgement and ownership", () => {
  for (const group of [null, "auto-close", "audit-log"]) {
    function fixture() {
      const f = createInteraction({ group, subcommand: "show" });
      const store = createStore();
      const automatic = createAutomaticClose();
      const audit = createAuditDestination();
      const read = vi.mocked(
        group === null ? store.getOrCreate : group === "auto-close" ? automatic.show : audit.show,
      );
      const run = () =>
        handleConfigCommand(f.interaction, store, automatic, audit, createPreviewConfig());
      return { ...f, store, automatic, audit, read, run };
    }

    it(`waits for the ephemeral defer before any ${group ?? "config"} show read`, async () => {
      const f = fixture();
      const ack = controlled<void>();
      f.deferReply.mockReturnValueOnce(ack.promise);
      const operation = f.run();
      await flushReadMicrotasks();
      expect(f.deferReply).toHaveBeenCalledExactlyOnceWith({ flags: MessageFlags.Ephemeral });
      expect(f.store.getOrCreate).not.toHaveBeenCalled();
      expect(f.automatic.show).not.toHaveBeenCalled();
      expect(f.audit.show).not.toHaveBeenCalled();
      ack.resolve();
      await operation;
      expect(f.read).toHaveBeenCalledExactlyOnceWith(defaultSettings.guildId);
      expect(f.editReply).toHaveBeenCalledOnce();
      expect(f.editReply.mock.calls[0]![0]).toMatchObject({ allowedMentions: { parse: [] } });
      expect(f.reply).not.toHaveBeenCalled();
    });

    it(`does not read or re-acknowledge ${group ?? "config"} show after defer rejection`, async () => {
      const f = fixture();
      const error = new Error("ack response lost");
      f.deferReply.mockRejectedValueOnce(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.store.getOrCreate).not.toHaveBeenCalled();
      expect(f.automatic.show).not.toHaveBeenCalled();
      expect(f.audit.show).not.toHaveBeenCalled();
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.editReply).not.toHaveBeenCalled();
      expect(f.deferReply).toHaveBeenCalledOnce();
    });

    it(`reports ${group ?? "config"} show unavailability and preserves the DB error over response failure`, async () => {
      const f = fixture();
      const error = new Error("private DB error");
      f.read.mockRejectedValueOnce(error);
      f.editReply.mockRejectedValueOnce(new Error("edit lost"));
      await expect(f.run()).rejects.toBe(error);
      expect(f.editReply).toHaveBeenCalledExactlyOnceWith(
        edited(
          group === "audit-log"
            ? "WEFT could not load the Discord audit notification configuration. Please try again later."
            : group === "auto-close"
              ? "WEFT could not load the automatic close configuration. Please try again later."
              : "WEFT could not load the configuration. Please try again later.",
        ),
      );
      expect(f.reply).not.toHaveBeenCalled();
      expect(f.read).toHaveBeenCalledOnce();
    });

    it(`does not classify successful ${group ?? "config"} show delivery loss as a DB failure or replay`, async () => {
      const f = fixture();
      const error = new Error("edit response lost");
      f.editReply.mockRejectedValueOnce(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.read).toHaveBeenCalledOnce();
      expect(f.editReply).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.editReply.mock.calls)).not.toContain("could not load");
      expect(f.reply).not.toHaveBeenCalled();
    });
  }

  it.each(["settings", "automatic"])(
    "owns the sibling after %s rejects first and preserves that rejection",
    async (first) => {
      const f = createInteraction();
      const settings = controlled<GuildSettings>();
      const automatic =
        controlled<Awaited<ReturnType<AutomaticCloseConfigurationService["show"]>>>();
      const store = createStore({ getOrCreate: vi.fn(() => settings.promise) });
      const service = createAutomaticClose({ show: vi.fn(() => automatic.promise) });
      const error = new Error("first failure");
      let done = false;
      const operation = handleConfigCommand(
        f.interaction,
        store,
        service,
        createAuditDestination(),
        createPreviewConfig(),
      ).catch((reason: unknown) => {
        done = true;
        return reason;
      });
      await flushReadMicrotasks();
      if (first === "settings") settings.reject(error);
      else automatic.reject(error);
      await flushReadMicrotasks();
      expect(done).toBe(false);
      expect(f.editReply).not.toHaveBeenCalled();
      if (first === "settings") automatic.reject(new Error("late sibling"));
      else settings.reject(new Error("late sibling"));
      expect(await operation).toBe(error);
      expect(store.getOrCreate).toHaveBeenCalledOnce();
      expect(service.show).toHaveBeenCalledOnce();
      expect(f.editReply).toHaveBeenCalledOnce();
    },
  );
});

it("keeps preview choice values while exposing understandable labels and timezone guidance", () => {
  const definition = configCommandDefinition.toJSON();
  const preview = definition.options?.find((option) => option.name === "link-preview");
  if (!preview || !("options" in preview)) throw new Error("Expected link-preview group");
  const mode = preview.options?.find((option) => option.name === "mode");
  if (!mode || !("options" in mode)) throw new Error("Expected mode subcommand");
  expect(mode.options?.[0]).toMatchObject({
    name: "value",
    choices: [
      { name: "Automatic public previews + optional buttons", value: "hybrid" },
      { name: "Automatic public previews only", value: "public-only" },
      { name: "Preview buttons only", value: "button-only" },
      { name: "Off", value: "off" },
    ],
  });
  const timezone = definition.options?.find((option) => option.name === "timezone");
  if (!timezone || !("options" in timezone)) throw new Error("Expected timezone subcommand");
  expect(timezone.options?.[0]?.description).toContain("Asia/Tokyo or UTC");
});

it("escapes untrusted configuration metadata without changing persisted values", async () => {
  const prefix = "**Done** [`x`](url)";
  const store = createStore({
    getOrCreate: vi.fn(() => Promise.resolve({ ...defaultSettings, closedPrefix: prefix })),
  });
  const f = createInteraction({ subcommand: "show" });
  await handleConfigCommand(
    f.interaction,
    store,
    createAutomaticClose(),
    createAuditDestination(),
    createPreviewConfig(),
  );
  const response = f.editReply.mock.calls[0]![0] as InteractionEditReplyOptions;
  expect(response.content).toContain("Closed prefix: \\*\\*Done\\*\\* \\[\\`x\\`](url)");
  expect(response.content).not.toContain(prefix);
  expect(response.allowedMentions).toEqual({ parse: [] });
  expect(store.setClosedPrefix).not.toHaveBeenCalled();
});
