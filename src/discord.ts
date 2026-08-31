import { Client, Events, GatewayDispatchEvents, GatewayIntentBits, RESTEvents } from "discord.js";

import type { Logger } from "pino";

import type { AutomaticCloseActivityService } from "./automatic-close-activity.js";
import { handleCommand, type CommandDependencies } from "./commands.js";
import {
  handleManagedMessageModalSubmit,
  MANAGED_MESSAGE_SEND_MODAL_ID,
} from "./message-command.js";
import type { ManagedMessageService } from "./managed-message.js";
import { createThreadLifecycleDiscord, isSupportedThreadType } from "./thread-discord.js";
import { createThreadLifecycleService, type ThreadLifecycleDiscord } from "./thread-lifecycle.js";
import type { GuildSettingsStore } from "./guild-settings.js";
import type { ManagedThreadStore, ThreadAuditStore } from "./thread-persistence.js";

export type DiscordDependencies = {
  guildSettings: GuildSettingsStore;
  managedThreads: ManagedThreadStore;
  audits: ThreadAuditStore;
};

export type DiscordStartupClient = {
  login: (token: string) => Promise<string>;
  once: (event: Events.ClientReady, listener: () => void) => unknown;
  off: (event: Events.ClientReady, listener: () => void) => unknown;
};

export type DiscordRuntime = {
  client: Client;
  threadDiscord: ThreadLifecycleDiscord;
  threadLifecycle: ReturnType<typeof createThreadLifecycleService>;
};

export class DiscordStartupAbortedError extends Error {
  constructor() {
    super("Discord startup was aborted");
    this.name = "DiscordStartupAbortedError";
  }
}

function parseRestRateLimitDebug(message: string):
  | {
      category: "unexpected_429";
      global: boolean;
      retryAfterMs: number;
      sublimitTimeoutMs: number;
    }
  | { category: "queue_wait"; waitMs: number }
  | undefined {
  if (message.includes("Encountered unexpected 429 rate limit")) {
    const global = /Global\s*:\s*(true|false)/.exec(message);
    const retryAfter = /Retry After\s*:\s*(\d+)ms/.exec(message);
    const sublimit = /Sublimit\s*:\s*(?:(\d+)ms|None)/.exec(message);

    if (global && retryAfter && sublimit) {
      return {
        category: "unexpected_429",
        global: global[1] === "true",
        retryAfterMs: Number(retryAfter[1]),
        sublimitTimeoutMs: sublimit[1] === undefined ? 0 : Number(sublimit[1]),
      };
    }

    return undefined;
  }

  const wait = /(?:Waiting|requests for) (\d+)ms/.exec(message);
  if (message.includes("rate limit") && wait) {
    return { category: "queue_wait", waitMs: Number(wait[1]) };
  }

  return undefined;
}

export function createDiscordRuntime(
  logger: Logger,
  dependencies: DiscordDependencies,
  threadLifecycleOverride?: ReturnType<typeof createThreadLifecycleService>,
): DiscordRuntime {
  const client = new Client({
    // GuildMessages delivers the message metadata automatic-close activity needs. Message content
    // is never read, so the privileged MessageContent intent stays disabled.
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });
  const threadDiscord = createThreadLifecycleDiscord(client);
  const threadLifecycle =
    threadLifecycleOverride ??
    createThreadLifecycleService({
      discord: threadDiscord,
      guildSettings: dependencies.guildSettings,
      managedThreads: dependencies.managedThreads,
      audits: dependencies.audits,
      logger,
    });

  client.rest.on(RESTEvents.RateLimited, (rateLimit) => {
    logger.debug(
      {
        event: "discord_rest_rate_limited",
        method: rateLimit.method,
        route: rateLimit.route,
        majorParameter: rateLimit.majorParameter,
        hash: rateLimit.hash,
        limit: rateLimit.limit,
        retryAfter: rateLimit.retryAfter,
        sublimitTimeout: rateLimit.sublimitTimeout,
        timeToReset: rateLimit.timeToReset,
        scope: rateLimit.scope,
        global: rateLimit.global,
      },
      "Discord REST rate limited",
    );
  });

  client.rest.on(RESTEvents.Debug, (message) => {
    const rateLimitDebug = parseRestRateLimitDebug(message);
    if (!rateLimitDebug) {
      return;
    }

    logger.debug(
      { event: "discord_rest_rate_limit_debug", ...rateLimitDebug },
      "Discord REST rate-limit debug",
    );
  });

  client.on(Events.ThreadUpdate, (oldThread, newThread) => {
    if (
      oldThread.archived !== true ||
      newThread.archived !== false ||
      newThread.locked === true ||
      !isSupportedThreadType(newThread.type)
    ) {
      return;
    }

    void threadLifecycle.autoOpen(newThread.guildId, newThread.id).then((result) => {
      if (!result.ok && !result.pending) {
        logger.error(
          {
            event: "automatic_thread_open_failed",
            guildId: newThread.guildId,
            threadId: newThread.id,
            failureCode: result.code,
          },
          "Automatic thread open reconciliation failed",
        );
      }
    });
  });

  return { client, threadDiscord, threadLifecycle };
}

export function registerDiscordCommandHandler(
  client: Client,
  dependencies: CommandDependencies,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    void handleCommand(interaction, dependencies)
      .then((handled) => {
        if (!handled) {
          dependencies.logger.warn(
            { event: "unknown_command", commandName: interaction.commandName },
            "Unknown Discord command received",
          );
        }
      })
      .catch((error: unknown) => {
        dependencies.logger.error(
          {
            event: "command_failed",
            commandName: interaction.commandName,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Discord command failed",
        );
      });
  });
}

export function registerManagedMessageModalHandler(
  client: Client,
  service: ManagedMessageService,
  logger: Pick<Logger, "error">,
): void {
  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isModalSubmit() || interaction.customId !== MANAGED_MESSAGE_SEND_MODAL_ID) {
      return;
    }

    void handleManagedMessageModalSubmit(interaction, service).catch((error: unknown) => {
      logger.error(
        {
          event: "managed_message_modal_failed",
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          errorName: error instanceof Error ? error.name : "UnknownError",
        },
        "Managed message modal handling failed",
      );
    });
  });
}

export type AutomaticCloseActivityDependencies = {
  activity: AutomaticCloseActivityService;
  logger: Pick<Logger, "debug">;
  now?: () => Date;
};

type ActiveRawThreadUpdate = {
  guildId: string;
  threadId: string;
  parentChannelId: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseActiveRawThreadUpdate(packet: unknown): ActiveRawThreadUpdate | undefined {
  if (!isRecord(packet) || packet.t !== GatewayDispatchEvents.ThreadUpdate || !isRecord(packet.d)) {
    return undefined;
  }

  const data = packet.d;
  if (
    typeof data.id !== "string" ||
    typeof data.guild_id !== "string" ||
    typeof data.parent_id !== "string" ||
    typeof data.type !== "number" ||
    !isSupportedThreadType(data.type) ||
    !isRecord(data.thread_metadata) ||
    data.thread_metadata.archived !== false
  ) {
    return undefined;
  }

  return {
    guildId: data.guild_id,
    threadId: data.id,
    parentChannelId: data.parent_id,
  };
}

export function registerAutomaticCloseActivityHandlers(
  client: Client,
  dependencies: AutomaticCloseActivityDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());

  client.on(Events.MessageCreate, (message) => {
    if (!message.inGuild() || message.system) {
      return;
    }

    // Cache-only resolution. An unresolved thread is skipped rather than fetched, so the
    // high-volume message path never performs a REST request.
    const channel = message.channel as typeof message.channel | null | undefined;
    if (channel === null || channel === undefined) {
      dependencies.logger.debug(
        {
          event: "automatic_close_message_channel_unresolved",
          guildId: message.guildId,
          channelId: message.channelId,
        },
        "Automatic close activity skipped an unresolved message channel",
      );
      return;
    }

    if (!channel.isThread() || !isSupportedThreadType(channel.type)) {
      return;
    }

    const parentChannelId = channel.parentId;
    if (parentChannelId === null) {
      return;
    }

    void dependencies.activity.recordMessageActivity({
      guildId: message.guildId,
      threadId: channel.id,
      parentChannelId,
      occurredAt: message.createdAt,
      authorIsBot: message.author.bot,
    });
  });

  client.on(Events.ThreadCreate, (thread, newlyCreated) => {
    if (!isSupportedThreadType(thread.type)) {
      return;
    }

    const parentChannelId = thread.parentId;
    if (parentChannelId === null) {
      return;
    }

    // A thread that only became observable now may have been created long ago, so its historical
    // creation time must not become the baseline.
    const createdTimestamp = thread.createdTimestamp;
    const baselineAt =
      newlyCreated && createdTimestamp !== null ? new Date(createdTimestamp) : now();

    void dependencies.activity.initializeThreadBaseline({
      guildId: thread.guildId,
      threadId: thread.id,
      parentChannelId,
      baselineAt,
    });
  });

  client.on(Events.Raw, (packet: unknown) => {
    const update = parseActiveRawThreadUpdate(packet);
    if (update === undefined) {
      return;
    }

    const cachedThread = client.channels.cache.get(update.threadId);
    if (cachedThread !== undefined) {
      if (
        !cachedThread.isThread() ||
        !isSupportedThreadType(cachedThread.type) ||
        cachedThread.guildId !== update.guildId ||
        cachedThread.archived !== true
      ) {
        return;
      }
    }

    // Discord does not synchronize archived threads up front and may deliver an unarchive update
    // while the thread is absent from cache. Treat that active cache miss conservatively as a new
    // inactivity baseline so WEFT cannot close the thread prematurely.
    const reopenedAt = now();

    // Locked threads still begin a new inactivity episode when Discord makes them active. The
    // lifecycle path independently decides whether a later close attempt can proceed.
    void dependencies.activity.recordThreadReentryBaseline({
      ...update,
      reopenedAt,
    });
  });
}

export function createDiscordClient(
  logger: Logger,
  dependencies: DiscordDependencies,
  threadLifecycleOverride?: ReturnType<typeof createThreadLifecycleService>,
): Client {
  return createDiscordRuntime(logger, dependencies, threadLifecycleOverride).client;
}

export function startDiscordClient(
  client: DiscordStartupClient,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      client.off(Events.ClientReady, handleReady);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleReady = (): void => {
      cleanup();
      resolve();
    };
    const handleAbort = (): void => {
      cleanup();
      reject(new DiscordStartupAbortedError());
    };

    client.once(Events.ClientReady, handleReady);
    signal.addEventListener("abort", handleAbort, { once: true });

    if (signal.aborted) {
      handleAbort();
      return;
    }

    void client.login(token).catch((error: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error("Discord login failed"));
    });
  });
}
