import { ChannelType, Events, GatewayIntentBits, RESTEvents } from "discord.js";
import type { AnyThreadChannel, ChatInputCommandInteraction, RateLimitData } from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscordClient,
  createDiscordRuntime,
  type DiscordDependencies,
  DiscordStartupAbortedError,
  type DiscordStartupClient,
  registerDiscordCommandHandler,
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
  return { debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

describe("Discord client", () => {
  it("returns the same lifecycle instance used by interactive Discord handlers", async () => {
    const lifecycle = {
      close: vi.fn(),
      closeAsSystem: vi.fn(),
      open: vi.fn(),
      autoOpen: vi.fn(),
    } as unknown as ThreadLifecycleService;

    const runtime = createDiscordRuntime(createLogger(), discordDependencies, lifecycle);

    expect(runtime.threadLifecycle).toBe(lifecycle);
    await runtime.client.destroy();
  });

  it("requests only the Guilds gateway intent", async () => {
    const client = createDiscordClient(createLogger(), discordDependencies);

    expect(client.options.intents.bitfield).toBe(GatewayIntentBits.Guilds);
    await client.destroy();
  });

  it("logs public REST rate-limit data without the request URL", async () => {
    const debug = vi.fn();
    const client = createDiscordClient(
      { debug, warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      discordDependencies,
    );
    const rateLimit = {
      global: false,
      hash: "bucket-hash",
      limit: 5,
      majorParameter: "thread-id",
      method: "PATCH",
      retryAfter: 1_000,
      route: "/channels/:id",
      scope: "shared",
      sublimitTimeout: 0,
      timeToReset: 1_000,
      url: "https://discord.com/api/v10/channels/thread-id",
    } satisfies RateLimitData;

    client.rest.emit(RESTEvents.RateLimited, rateLimit);

    expect(debug).toHaveBeenCalledWith(
      {
        event: "discord_rest_rate_limited",
        method: "PATCH",
        route: "/channels/:id",
        majorParameter: "thread-id",
        hash: "bucket-hash",
        limit: 5,
        retryAfter: 1_000,
        sublimitTimeout: 0,
        timeToReset: 1_000,
        scope: "shared",
        global: false,
      },
      "Discord REST rate limited",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(rateLimit.url);
    await client.destroy();
  });

  it("logs safe data from unexpected REST rate-limit debug output", async () => {
    const debug = vi.fn();
    const client = createDiscordClient(
      { debug, warn: vi.fn(), error: vi.fn() } as unknown as Logger,
      discordDependencies,
    );
    const requestUrl = "https://discord.com/api/v10/channels/thread-id";

    client.rest.emit(
      RESTEvents.Debug,
      [
        "[REST bucket-id] Encountered unexpected 429 rate limit",
        "  Global         : false",
        "  URL            : " + requestUrl,
        "  Retry After    : 600000ms",
        "  Sublimit       : 600000ms",
      ].join("\n"),
    );

    expect(debug).toHaveBeenCalledWith(
      {
        event: "discord_rest_rate_limit_debug",
        category: "unexpected_429",
        global: false,
        retryAfterMs: 600_000,
        sublimitTimeoutMs: 600_000,
      },
      "Discord REST rate-limit debug",
    );
    expect(JSON.stringify(debug.mock.calls)).not.toContain(requestUrl);
    await client.destroy();
  });

  it("logs only the event and command name for an unknown command", async () => {
    const warn = vi.fn();
    const error = vi.fn();
    const logger = { debug: vi.fn(), warn, error } as unknown as Logger;
    const client = createDiscordClient(logger, discordDependencies);
    registerTestCommandHandler(client, logger);
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
    const logger = { debug: vi.fn(), warn, error } as unknown as Logger;
    const client = createDiscordClient(logger, discordDependencies);
    registerTestCommandHandler(client, logger);
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
    const logger = { debug: vi.fn(), warn, error } as unknown as Logger;
    const client = createDiscordClient(logger, discordDependencies, lifecycle);
    registerTestCommandHandler(client, logger, lifecycle);
    const interaction = {
      commandName: "thread",
      isChatInputCommand: () => true,
      inGuild: () => true,
      guildId: "guild-id",
      channelId: "thread-id",
      deferred: false,
      replied: false,
      options: { getSubcommand: () => "close" },
      reply: vi.fn(() => Promise.reject(new Error("sensitive raw detail"))),
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

  it("does not log a pending automatic reconciliation as a failure", async () => {
    const error = vi.fn();
    const autoOpen = vi.fn(() => Promise.resolve({ ok: false, pending: true } as const));
    const lifecycle = {
      close: vi.fn(),
      open: vi.fn(),
      autoOpen,
    } as unknown as ThreadLifecycleService;
    const client = createDiscordClient(
      { debug: vi.fn(), warn: vi.fn(), error } as unknown as Logger,
      discordDependencies,
      lifecycle,
    );
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

    await vi.waitFor(() => expect(autoOpen).toHaveBeenCalledOnce());
    expect(error).not.toHaveBeenCalled();
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

function registerTestCommandHandler(
  client: ReturnType<typeof createDiscordClient>,
  logger: Logger,
  lifecycle = {
    close: vi.fn(),
    open: vi.fn(),
    autoOpen: vi.fn(),
  } as unknown as ThreadLifecycleService,
): void {
  registerDiscordCommandHandler(client, {
    automaticCloseConfiguration: {
      show: vi.fn(),
      setInactivitySeconds: vi.fn(),
      setBotMessagesCountAsActivity: vi.fn(),
      addParentChannel: vi.fn(),
      removeParentChannel: vi.fn(),
    },
    guildSettings: discordDependencies.guildSettings,
    scheduledThreadClose: { schedule: vi.fn(), cancel: vi.fn(), closeManually: vi.fn() },
    threadLifecycle: lifecycle,
    logger,
  });
}

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
