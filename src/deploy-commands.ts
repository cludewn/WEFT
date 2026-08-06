import { REST } from "discord.js";
import pino from "pino";

import { registerCommands, selectDeploymentTarget } from "./command-registration.js";
import { ConfigurationError, loadDiscordConfig } from "./config.js";

async function main(): Promise<void> {
  const config = loadDiscordConfig();
  const target = selectDeploymentTarget(process.argv.slice(2), config.guildId);
  const logger = pino();
  const rest = new REST({ version: "10" }).setToken(config.token);

  await registerCommands(rest, config.applicationId, target);
  logger.info({ event: "commands_deployed", scope: target.scope }, "Discord commands deployed");
}

try {
  await main();
} catch (error) {
  const variables = error instanceof ConfigurationError ? error.variables : undefined;
  process.stderr.write(
    `${JSON.stringify({
      event: "command_deployment_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      ...(variables === undefined ? {} : { variables }),
    })}\n`,
  );
  process.exitCode = 1;
}
