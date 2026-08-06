import { Client, Events, GatewayIntentBits } from "discord.js";

import type { Logger } from "pino";

import { handleCommand, type CommandDependencies } from "./commands.js";
import { createThreadLifecycleDiscord, isSupportedThreadType } from "./thread-discord.js";
import { createThreadLifecycleService } from "./thread-lifecycle.js";
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

export class DiscordStartupAbortedError extends Error {
  constructor() {
    super("Discord startup was aborted");
    this.name = "DiscordStartupAbortedError";
  }
}

export function createDiscordClient(
  logger: Logger,
  dependencies: DiscordDependencies,
  threadLifecycleOverride?: ReturnType<typeof createThreadLifecycleService>,
): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const threadLifecycle =
    threadLifecycleOverride ??
    createThreadLifecycleService({
      discord: createThreadLifecycleDiscord(client),
      guildSettings: dependencies.guildSettings,
      managedThreads: dependencies.managedThreads,
      audits: dependencies.audits,
      logger,
    });
  const commandDependencies: CommandDependencies = {
    guildSettings: dependencies.guildSettings,
    threadLifecycle,
    logger,
  };

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    void handleCommand(interaction, commandDependencies)
      .then((handled) => {
        if (!handled) {
          logger.warn(
            { event: "unknown_command", commandName: interaction.commandName },
            "Unknown Discord command received",
          );
        }
      })
      .catch((error: unknown) => {
        logger.error(
          {
            event: "command_failed",
            commandName: interaction.commandName,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "Discord command failed",
        );
      });
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
      if (!result.ok) {
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

  return client;
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
