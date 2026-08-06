import { Client, Events, GatewayIntentBits } from "discord.js";

import type { Logger } from "pino";

import { handleCommand, type CommandDependencies } from "./commands.js";

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
  commandDependencies: CommandDependencies,
): Client {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

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
