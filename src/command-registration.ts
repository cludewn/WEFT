import { REST, Routes } from "discord.js";

import { commandDefinitions } from "./commands.js";
import { ConfigurationError } from "./config.js";

export type CommandDeploymentTarget = { scope: "global" } | { scope: "guild"; guildId: string };

export function createCommandDeploymentRest(token: string): REST {
  return new REST({ version: "10", retries: 0 }).setToken(token);
}

export function selectDeploymentTarget(
  arguments_: readonly string[],
  guildId: string | undefined,
): CommandDeploymentTarget {
  if (arguments_.length === 1 && arguments_[0] === "--global") {
    return { scope: "global" };
  }

  if (arguments_.length > 0) {
    throw new Error("Usage: deploy-commands [--global]");
  }

  if (guildId === undefined) {
    throw new ConfigurationError(["DISCORD_GUILD_ID"]);
  }

  return { scope: "guild", guildId };
}

export async function registerCommands(
  rest: Pick<REST, "put">,
  applicationId: string,
  target: CommandDeploymentTarget,
): Promise<void> {
  const route =
    target.scope === "global"
      ? Routes.applicationCommands(applicationId)
      : Routes.applicationGuildCommands(applicationId, target.guildId);

  await rest.put(route, { body: commandDefinitions });
}
