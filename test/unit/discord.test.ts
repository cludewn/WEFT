import {
  ChannelType,
  Events,
  GatewayDispatchEvents,
  GatewayIntentBits,
  RESTEvents,
} from "discord.js";
import type {
  AnyThreadChannel,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  RateLimitData,
} from "discord.js";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  createDiscordClient,
  createDiscordRuntime,
  type DiscordDependencies,
  DiscordStartupAbortedError,
  type DiscordStartupClient,
  registerAutomaticCloseActivityHandlers,
  registerDiscordCommandHandler,
  registerManagedMessageModalHandler,
  startDiscordClient,
} from "../../src/discord.js";
import type { AutomaticCloseActivityService } from "../../src/automatic-close-activity.js";
import type { ThreadLifecycleService } from "../../src/thread-lifecycle.js";
import type { ManagedMessageService } from "../../src/managed-message.js";

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

  it("requests the Guilds and GuildMessages gateway intents without MessageContent", async () => {
    const client = createDiscordClient(createLogger(), discordDependencies);

    expect(client.options.intents.bitfield).toBe(
      GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
    );
    expect(client.options.intents.has(GatewayIntentBits.MessageContent)).toBe(false);
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

describe("managed message modal routing", () => {
  it("processes only owned managed-message send and edit modals", async () => {
    const logger = createLogger();
    const service = {
      send: vi.fn(() => Promise.resolve({ outcome: "SUCCESS", messageId: "message-id" } as const)),
      findForEdit: vi.fn(),
      edit: vi.fn(() =>
        Promise.resolve({
          outcome: "SUCCESS",
          messageId: "900000000000000001",
          revision: 2,
        } as const),
      ),
    } satisfies ManagedMessageService;
    const client = createDiscordClient(logger, discordDependencies);
    registerManagedMessageModalHandler(client, service, logger);
    const unrelated = createModal("other:modal");
    const managed = createModal("managed-message:send");
    const edit = createModal("managed-message:edit:900000000000000001:1");

    client.emit(Events.InteractionCreate, unrelated.interaction);
    client.emit(Events.InteractionCreate, managed.interaction);
    client.emit(Events.InteractionCreate, edit.interaction);

    await vi.waitFor(() => expect(service.send).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(service.edit).toHaveBeenCalledOnce());
    expect(unrelated.deferReply).not.toHaveBeenCalled();
    expect(managed.deferReply).toHaveBeenCalledOnce();
    expect(edit.deferReply).toHaveBeenCalledOnce();
    expect(logger.error).not.toHaveBeenCalled();
    await client.destroy();
  });

  it("logs a bounded handler failure without modal content", async () => {
    const logger = createLogger();
    const service = {
      send: vi.fn(() => Promise.reject(new Error("sensitive raw detail"))),
      findForEdit: vi.fn(),
      edit: vi.fn(),
    } satisfies ManagedMessageService;
    const client = createDiscordClient(logger, discordDependencies);
    registerManagedMessageModalHandler(client, service, logger);

    client.emit(
      Events.InteractionCreate,
      createModal("managed-message:send", "sensitive modal content").interaction,
    );

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain("sensitive");
    await client.destroy();
  });
});

describe("automatic close activity gateway handlers", () => {
  it("forwards a qualifying human message with Discord metadata only", async () => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.MessageCreate, createMessage({ authorIsBot: false }) as never);

    expect(fixture.activity.recordMessageActivity).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      threadId: "thread-id",
      parentChannelId: "parent-id",
      occurredAt: new Date("2030-01-01T00:00:00.000Z"),
      authorIsBot: false,
    });
    expect(fixture.activity.initializeThreadBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("forwards a bot message with the bot author flag", async () => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.MessageCreate, createMessage({ authorIsBot: true }) as never);

    expect(fixture.activity.recordMessageActivity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ authorIsBot: true }),
    );
    await fixture.client.destroy();
  });

  it.each([
    ["non-guild", createMessage({ inGuild: false })],
    ["system", createMessage({ system: true })],
    ["non-thread", createMessage({ isThread: false })],
    ["unsupported thread type", createMessage({ channelType: ChannelType.GuildText })],
    ["parentless thread", createMessage({ parentId: null })],
  ])("skips a %s message without calling the activity service", async (_label, message) => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.MessageCreate, message as never);

    expect(fixture.activity.recordMessageActivity).not.toHaveBeenCalled();
    expect(fixture.logger.debug).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("skips an unresolved message channel without any REST fallback", async () => {
    const fixture = await createActivityFixture();
    const fetchChannel = vi.spyOn(fixture.client.channels, "fetch");

    fixture.client.emit(Events.MessageCreate, createMessage({ channel: null }) as never);

    expect(fixture.activity.recordMessageActivity).not.toHaveBeenCalled();
    expect(fetchChannel).not.toHaveBeenCalled();
    expect(fixture.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ event: "automatic_close_message_channel_unresolved" }),
      expect.any(String),
    );
    await fixture.client.destroy();
  });

  it("does not log anything on the successful message path", async () => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.MessageCreate, createMessage({}) as never);
    await Promise.resolve();

    expect(fixture.logger.debug).not.toHaveBeenCalled();
    expect(fixture.logger.info).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("uses the thread creation timestamp for a newly created thread", async () => {
    const fixture = await createActivityFixture();

    fixture.client.emit(
      Events.ThreadCreate,
      createThread({ createdTimestamp: Date.parse("2030-02-02T00:00:00.000Z") }) as never,
      true,
    );

    expect(fixture.activity.initializeThreadBaseline).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      threadId: "thread-id",
      parentChannelId: "parent-id",
      baselineAt: new Date("2030-02-02T00:00:00.000Z"),
    });
    await fixture.client.destroy();
  });

  it.each([
    ["a null creation timestamp", createThread({ createdTimestamp: null }), true],
    ["an already existing thread", createThread({}), false],
  ])("uses the observation time for %s", async (_label, thread, newlyCreated) => {
    const fixture = await createActivityFixture();
    const before = Date.now();

    fixture.client.emit(Events.ThreadCreate, thread as never, newlyCreated);

    const [event] = vi.mocked(fixture.activity.initializeThreadBaseline).mock.calls[0]!;
    expect(event.baselineAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(event.baselineAt.getTime()).not.toBe(Date.parse("2020-01-01T00:00:00.000Z"));
    await fixture.client.destroy();
  });

  it.each([
    ["unsupported", createThread({ type: ChannelType.GuildText })],
    ["parentless", createThread({ parentId: null })],
  ])("skips a %s thread", async (_label, thread) => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.ThreadCreate, thread as never, true);

    expect(fixture.activity.initializeThreadBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("records one raw archived-to-active re-entry with exact current facts", async () => {
    const observedAt = new Date("2030-04-04T00:00:00.000Z");
    const fixture = await createActivityFixture(() => observedAt);
    cacheThread(fixture.client, { archived: true });

    fixture.client.emit(Events.Raw, createRawThreadUpdate({ archived: false }));

    expect(fixture.activity.recordThreadReentryBaseline).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      threadId: "thread-id",
      parentChannelId: "parent-id",
      reopenedAt: observedAt,
    });

    // The lifecycle listener remains high-level, but automatic-close re-entry has no second
    // ThreadUpdate listener that can record the same gateway observation again.
    fixture.client.emit(
      Events.ThreadUpdate,
      createThread({ archived: true }) as never,
      createThread({ archived: false, locked: true }) as never,
    );
    expect(fixture.activity.recordThreadReentryBaseline).toHaveBeenCalledOnce();
    await fixture.client.destroy();
  });

  it("records a raw active thread cache miss without requiring high-level ThreadUpdate", async () => {
    const observedAt = new Date("2030-05-05T00:00:00.000Z");
    const fixture = await createActivityFixture(() => observedAt);
    const fetchChannel = vi.spyOn(fixture.client.channels, "fetch");
    expect(fixture.client.channels.cache.has("thread-id")).toBe(false);

    fixture.client.emit(Events.Raw, createRawThreadUpdate({ archived: false }));

    expect(fixture.activity.recordThreadReentryBaseline).toHaveBeenCalledExactlyOnceWith({
      guildId: "guild-id",
      threadId: "thread-id",
      parentChannelId: "parent-id",
      reopenedAt: observedAt,
    });
    expect(fetchChannel).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("does not reset inactivity for a cached active-to-active raw update", async () => {
    const fixture = await createActivityFixture();
    cacheThread(fixture.client, { archived: false });

    fixture.client.emit(Events.Raw, createRawThreadUpdate({ archived: false }));

    expect(fixture.activity.recordThreadReentryBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("ignores an incoming archived raw thread update", async () => {
    const fixture = await createActivityFixture();
    cacheThread(fixture.client, { archived: false });

    fixture.client.emit(Events.Raw, createRawThreadUpdate({ archived: true }));

    expect(fixture.activity.recordThreadReentryBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it.each([
    ["unsupported type", createRawThreadUpdate({ type: ChannelType.GuildText })],
    ["null parent", createRawThreadUpdate({ parentId: null })],
    ["missing parent", createRawThreadUpdate({ omitParentId: true })],
  ])("ignores a raw thread update with %s", async (_label, packet) => {
    const fixture = await createActivityFixture();

    fixture.client.emit(Events.Raw, packet);

    expect(fixture.activity.recordThreadReentryBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it.each([
    ["undefined packet", undefined],
    ["non-thread dispatch", { t: GatewayDispatchEvents.MessageCreate, d: {} }],
    ["missing dispatch data", { t: GatewayDispatchEvents.ThreadUpdate }],
    [
      "missing metadata",
      {
        t: GatewayDispatchEvents.ThreadUpdate,
        d: {
          id: "thread-id",
          guild_id: "guild-id",
          parent_id: "parent-id",
          type: ChannelType.PublicThread,
        },
      },
    ],
  ])("ignores a malformed %s without throwing", async (_label, packet) => {
    const fixture = await createActivityFixture();

    expect(() => fixture.client.emit(Events.Raw, packet)).not.toThrow();

    expect(fixture.activity.recordThreadReentryBaseline).not.toHaveBeenCalled();
    await fixture.client.destroy();
  });

  it("records a qualifying locked raw thread re-entry", async () => {
    const fixture = await createActivityFixture();
    cacheThread(fixture.client, { archived: true });

    fixture.client.emit(Events.Raw, createRawThreadUpdate({ archived: false, locked: true }));

    expect(fixture.activity.recordThreadReentryBaseline).toHaveBeenCalledOnce();
    await fixture.client.destroy();
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
    automaticCloseMaintenance: {
      track: vi.fn(),
      untrack: vi.fn(),
      status: vi.fn(),
    },
    guildSettings: discordDependencies.guildSettings,
    managedMessages: {
      send: vi.fn(),
      findForEdit: vi.fn(),
      edit: vi.fn(),
    },
    scheduledThreadClose: { schedule: vi.fn(), cancel: vi.fn(), closeManually: vi.fn() },
    threadLifecycle: lifecycle,
    logger,
  });
}

function createModal(customId: string, content = "managed content") {
  const deferReply = vi.fn(() => Promise.resolve());
  const editReply = vi.fn(() => Promise.resolve());
  const interaction = {
    customId,
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: (customId: string) =>
        customId === "managed-message:content" ? content : "",
    },
    inGuild: () => true,
    guildId: "guild-id",
    channelId: "channel-id",
    user: { id: "actor-id" },
    deferReply,
    editReply,
  } as unknown as ModalSubmitInteraction;
  return { interaction, deferReply, editReply };
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

async function createActivityFixture(now?: () => Date): Promise<{
  client: ReturnType<typeof createDiscordClient>;
  activity: AutomaticCloseActivityService;
  logger: Logger;
}> {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  const client = createDiscordClient(logger, discordDependencies);
  const activity: AutomaticCloseActivityService = {
    recordMessageActivity: vi.fn(() => Promise.resolve()),
    initializeThreadBaseline: vi.fn(() => Promise.resolve()),
    recordThreadReentryBaseline: vi.fn(() => Promise.resolve()),
  };
  registerAutomaticCloseActivityHandlers(client, { activity, logger, ...(now ? { now } : {}) });
  return await Promise.resolve({ client, activity, logger });
}

function createMessage({
  inGuild = true,
  system = false,
  isThread = true,
  channelType = ChannelType.PublicThread,
  parentId = "parent-id",
  authorIsBot = false,
  channel,
}: {
  inGuild?: boolean;
  system?: boolean;
  isThread?: boolean;
  channelType?: ChannelType;
  parentId?: string | null;
  authorIsBot?: boolean;
  channel?: null;
} = {}) {
  return {
    inGuild: () => inGuild,
    system,
    guildId: inGuild ? "guild-id" : null,
    channelId: "thread-id",
    createdAt: new Date("2030-01-01T00:00:00.000Z"),
    author: { bot: authorIsBot },
    channel:
      channel === null
        ? null
        : { id: "thread-id", isThread: () => isThread, type: channelType, parentId },
  };
}

function createThread({
  type = ChannelType.PublicThread,
  parentId = "parent-id",
  createdTimestamp = Date.parse("2020-01-01T00:00:00.000Z"),
  archived = false,
  locked = false,
}: {
  type?: ChannelType;
  parentId?: string | null;
  createdTimestamp?: number | null;
  archived?: boolean;
  locked?: boolean;
} = {}) {
  return {
    id: "thread-id",
    guildId: "guild-id",
    type,
    parentId,
    createdTimestamp,
    archived,
    locked,
  };
}

function cacheThread(
  client: ReturnType<typeof createDiscordClient>,
  { archived }: { archived: boolean },
): void {
  client.channels.cache.set("thread-id", {
    id: "thread-id",
    guildId: "guild-id",
    type: ChannelType.PublicThread,
    archived,
    isThread: () => true,
  } as never);
}

function createRawThreadUpdate({
  type = ChannelType.PublicThread,
  parentId = "parent-id",
  archived = false,
  locked = false,
  omitParentId = false,
}: {
  type?: ChannelType;
  parentId?: string | null;
  archived?: boolean;
  locked?: boolean;
  omitParentId?: boolean;
} = {}) {
  return {
    op: 0,
    s: 1,
    t: GatewayDispatchEvents.ThreadUpdate,
    d: {
      id: "thread-id",
      guild_id: "guild-id",
      ...(!omitParentId ? { parent_id: parentId } : {}),
      type,
      thread_metadata: {
        archived,
        auto_archive_duration: 1_440,
        archive_timestamp: "2030-01-01T00:00:00.000Z",
        locked,
      },
    },
  };
}
