import { ChannelType, Events, GatewayIntentBits } from "discord.js";
import type { AnyThreadChannel, ChatInputCommandInteraction } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscordClient,
  type DiscordDependencies,
  DiscordStartupAbortedError,
  type DiscordStartupClient,
  startDiscordClient,
} from "../../src/discord.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";

const discordDependencies = {
  guildSettings: {
    getOrCreate: vi.fn(),
    setTimezone: vi.fn(),
    setClosedPrefix: vi.fn(),
  },
  managedThreads: {
    find: vi.fn(),
    saveClosed: vi.fn(),
    markOpen: vi.fn(),
  },
  audits: { record: vi.fn() },
} as unknown as DiscordDependencies;

function createLogger(): Logger {
  return { error: vi.fn() } as unknown as Logger;
}

describe("Discord client", () => {
  it("requests only the Guilds gateway intent", async () => {
    const client = createDiscordClient(createLogger(), discordDependencies);

    expect(client.options.intents.bitfield).toBe(GatewayIntentBits.Guilds);
    await client.destroy();
  });

  it("logs only the event and command name for an unknown command", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const client = createDiscordClient({ warn, error } as unknown as Logger, discordDependencies);
    const reply = vi.fn();
    const interaction = {
      commandName: "unknown",
      isChatInputCommand: () => true,
      reply,
    } as unknown as ChatInputCommandInteraction;

    client.emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith(
        { event: "unknown_command", commandName: "unknown" },
        "Unknown Discord command received",
      );
    });
    expect(error).not.toHaveBeenCalled();
    expect(reply).not.toHaveBeenCalled();
    await client.destroy();
  });

  it("handles reply failures without logging interaction content", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const client = createDiscordClient({ warn, error } as unknown as Logger, discordDependencies);
    const reply = vi.fn(() => Promise.reject(new Error("reply failed")));
    const interaction = {
      commandName: "ping",
      isChatInputCommand: () => true,
      reply,
    } as unknown as ChatInputCommandInteraction;

    client.emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        { event: "command_failed", commandName: "ping", errorName: "Error" },
        "Discord command failed",
      );
    });
    expect(warn).not.toHaveBeenCalled();
    await client.destroy();
  });

  it("logs a thread handler exception without raw error details", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const lifecycle = {
      close: vi.fn(),
      open: vi.fn(),
      autoOpen: vi.fn(),
    } as unknown as ThreadLifecycleService;
    const client = createDiscordClient(
      { warn, error } as unknown as Logger,
      discordDependencies,
      lifecycle,
    );
    const interaction = {
      commandName: "thread",
      isChatInputCommand: () => true,
      inGuild: () => true,
      guildId: "guild-id",
      channelId: "thread-id",
      deferred: false,
      replied: false,
      deferReply: vi.fn(() => Promise.reject(new Error("sensitive raw detail"))),
    } as unknown as ChatInputCommandInteraction;

    client.emit(Events.InteractionCreate, interaction);

    await vi.waitFor(() => {
      expect(error).toHaveBeenCalledWith(
        { event: "command_failed", commandName: "thread", errorName: "Error" },
        "Discord command failed",
      );
    });
    expect(lifecycle.close).not.toHaveBeenCalled();
    expect(JSON.stringify(error.mock.calls)).not.toContain("sensitive raw detail");
    await client.destroy();
  });

  it("reconciles only unlocked archived-to-active thread updates", async () => {
    const autoOpen = vi.fn(() => Promise.resolve({ ok: true, changed: true } as const));
    const lifecycle = {
      close: vi.fn(),
      open: vi.fn(),
      autoOpen,
    } as unknown as ThreadLifecycleService;
    const client = createDiscordClient(createLogger(), discordDependencies, lifecycle);
    const activeThread = {
      id: "thread-id",
      guildId: "guild-id",
      type: ChannelType.PublicThread,
      archived: false,
      locked: false,
    } as unknown as AnyThreadChannel;

    client.emit(
      Events.ThreadUpdate,
      { ...activeThread, archived: true } as unknown as AnyThreadChannel,
      activeThread,
    );
    client.emit(
      Events.ThreadUpdate,
      { ...activeThread, archived: false } as unknown as AnyThreadChannel,
      activeThread,
    );
    client.emit(
      Events.ThreadUpdate,
      { ...activeThread, archived: true } as unknown as AnyThreadChannel,
      { ...activeThread, locked: true } as unknown as AnyThreadChannel,
    );

    await vi.waitFor(() => {
      expect(autoOpen).toHaveBeenCalledOnce();
    });
    expect(autoOpen).toHaveBeenCalledWith("guild-id", "thread-id");
    await client.destroy();
  });

  it("does not finish startup until the client is ready", async () => {
    const startupClient = createStartupClient(() => Promise.resolve("opaque-token"));
    const abortController = new AbortController();

    let completed = false;
    const startup = startDiscordClient(
      startupClient.client,
      "opaque-token",
      abortController.signal,
    ).then(() => {
      completed = true;
    });
    await Promise.resolve();

    expect(completed).toBe(false);
    expect(startupClient.login).toHaveBeenCalledWith("opaque-token");

    startupClient.emitReady();
    await startup;
    expect(completed).toBe(true);
    expect(startupClient.off).toHaveBeenCalledOnce();
  });

  it("removes the ready listener when login fails", async () => {
    const failure = new Error("login failed");
    const startupClient = createStartupClient(() => Promise.reject(failure));

    await expect(
      startDiscordClient(startupClient.client, "opaque-token", new AbortController().signal),
    ).rejects.toBe(failure);

    expect(startupClient.hasReadyListener()).toBe(false);
    expect(startupClient.off).toHaveBeenCalledOnce();
  });

  it("aborts ready waiting during shutdown and removes the listener", async () => {
    const startupClient = createStartupClient(() => new Promise<string>(() => undefined));
    const abortController = new AbortController();
    const startup = startDiscordClient(
      startupClient.client,
      "opaque-token",
      abortController.signal,
    );

    abortController.abort();

    await expect(startup).rejects.toBeInstanceOf(DiscordStartupAbortedError);
    expect(startupClient.hasReadyListener()).toBe(false);
    expect(startupClient.off).toHaveBeenCalledOnce();
  });
});

function createStartupClient(loginImplementation: () => Promise<string>): {
  client: DiscordStartupClient;
  emitReady: () => void;
  hasReadyListener: () => boolean;
  login: ReturnType<typeof vi.fn<() => Promise<string>>>;
  off: ReturnType<typeof vi.fn<DiscordStartupClient["off"]>>;
} {
  let readyListener: (() => void) | undefined;
  const login = vi.fn(loginImplementation);
  const once = vi.fn<DiscordStartupClient["once"]>((event, listener) => {
    expect(event).toBe(Events.ClientReady);
    readyListener = listener;
  });
  const off = vi.fn<DiscordStartupClient["off"]>((event, listener) => {
    expect(event).toBe(Events.ClientReady);
    if (readyListener === listener) {
      readyListener = undefined;
    }
  });

  return {
    client: { login, once, off },
    emitReady: () => readyListener?.(),
    hasReadyListener: () => readyListener !== undefined,
    login,
    off,
  };
}
