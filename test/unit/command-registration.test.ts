import { Routes } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import {
  createCommandDeploymentRest,
  registerCommands,
  selectDeploymentTarget,
} from "../../src/command-registration.js";
import { commandDefinitions } from "../../src/commands.js";
import { ConfigurationError } from "../../src/config.js";

describe("command deployment", () => {
  it("uses API v10 and disables automatic REST retries", () => {
    const rest = createCommandDeploymentRest("test-only-bot-token");

    expect(rest.options.version).toBe("10");
    expect(rest.options.retries).toBe(0);
  });

  it("selects guild deployment by default", () => {
    expect(selectDeploymentTarget([], "guild-id")).toEqual({
      scope: "guild",
      guildId: "guild-id",
    });
  });

  it("requires an explicit flag for global deployment", () => {
    expect(selectDeploymentTarget(["--global"], "guild-id")).toEqual({ scope: "global" });
  });

  it("requires a guild ID for the default deployment", () => {
    expect(() => selectDeploymentTarget([], undefined)).toThrowError(
      new ConfigurationError(["DISCORD_GUILD_ID"]),
    );
  });

  it("registers the shared definitions to a guild route", async () => {
    const put = vi.fn(() => Promise.resolve({}));

    await registerCommands({ put }, "application-id", {
      scope: "guild",
      guildId: "guild-id",
    });

    expect(put).toHaveBeenCalledWith(
      Routes.applicationGuildCommands("application-id", "guild-id"),
      {
        body: commandDefinitions,
      },
    );
  });

  it("registers globally only for the global target", async () => {
    const put = vi.fn(() => Promise.resolve({}));

    await registerCommands({ put }, "application-id", { scope: "global" });

    expect(put).toHaveBeenCalledWith(Routes.applicationCommands("application-id"), {
      body: commandDefinitions,
    });
  });
});
