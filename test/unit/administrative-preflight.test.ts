import { ChannelType, DiscordAPIError } from "discord.js";
import type { Client } from "discord.js";
import { describe, expect, it } from "vitest";
import { createThreadLifecycleDiscord } from "../../src/thread-discord.js";
import { createAuditLogDestinationDiscord } from "../../src/audit-log-destination-discord.js";

function apiError(code: number, status: number) {
  return new DiscordAPIError(
    { code, message: "private API details" },
    code,
    status,
    "GET",
    "https://discord.invalid",
    { body: undefined, files: undefined },
  );
}
function threadFixture(
  options: {
    botAbsent?: boolean;
    parentAbsent?: boolean;
    parentMismatch?: boolean;
    permission?: boolean;
    error?: Error;
  } = {},
) {
  const parent = { id: "parent" };
  const guild = {
    members: {
      fetch: () => (options.error ? Promise.reject(options.error) : Promise.resolve({ id: "bot" })),
    },
    channels: {
      fetch: (id: string) =>
        Promise.resolve(id === "thread" ? thread : options.parentAbsent ? null : parent),
    },
  };
  const thread = {
    id: "thread",
    guildId: "guild",
    type: ChannelType.PublicThread,
    parentId: "parent",
    parent: options.parentMismatch ? { id: "parent" } : parent,
    guild,
    isThread: () => true,
    permissionsFor: () => ({ has: () => options.permission !== false }),
  };
  return createThreadLifecycleDiscord({
    user: options.botAbsent ? null : { id: "bot" },
    guilds: { fetch: () => Promise.resolve(guild) },
  } as unknown as Client);
}
describe("administrative preflight preserves business responses separately from evidence", () => {
  it.each([
    [{ botAbsent: true }, "BOT_MISSING_PERMISSION", "DISCORD_PREFLIGHT", "BOT_CONTEXT_UNAVAILABLE"],
    [
      { permission: false },
      "BOT_MISSING_PERMISSION",
      "DISCORD_PREFLIGHT",
      "BOT_PERMISSION_MISSING",
    ],
    [
      { parentMismatch: true },
      "BOT_MISSING_PERMISSION",
      "DISCORD_READ",
      "REQUIRED_RESOURCE_READ_FAILED",
    ],
    [
      { parentAbsent: true },
      "BOT_MISSING_PERMISSION",
      "DISCORD_READ",
      "REQUIRED_RESOURCE_UNAVAILABLE",
    ],
    [
      { error: apiError(10007, 404) },
      "CONTEXT_VALIDATION_FAILURE",
      "DISCORD_READ",
      "REQUIRED_RESOURCE_UNAVAILABLE",
    ],
    [
      { error: apiError(50013, 403) },
      "CONTEXT_VALIDATION_FAILURE",
      "DISCORD_PREFLIGHT",
      "BOT_PERMISSION_MISSING",
    ],
    [
      { error: new Error("private transport") },
      "CONTEXT_VALIDATION_FAILURE",
      "DISCORD_READ",
      "REQUIRED_RESOURCE_READ_FAILED",
    ],
  ] as const)(
    "retains %s result %s while exposing stage %s",
    async (options, code, failureStage, failureReasonCode) => {
      const discord = threadFixture(options);
      if (!discord.administrativeBotPreflight) throw new Error("preflight missing");
      expect(await discord.administrativeBotPreflight("guild", "thread")).toEqual({
        ok: false,
        code,
        failure: { failureStage, failureReasonCode },
      });
      if (code === "BOT_MISSING_PERMISSION")
        await expect(discord.botCanManage("guild", "thread")).resolves.toBe(false);
      else await expect(discord.botCanManage("guild", "thread")).rejects.toBeDefined();
    },
  );
  it.each([
    [10007, 404, "DISCORD_READ", "REQUIRED_RESOURCE_UNAVAILABLE"],
    [50013, 403, "DISCORD_PREFLIGHT", "BOT_PERMISSION_MISSING"],
    [10007, 503, "DISCORD_READ", "REQUIRED_RESOURCE_READ_FAILED"],
  ] as const)(
    "classifies authorized destination bot read %s/%s after target confirmation",
    async (code, status, failureStage, failureReasonCode) => {
      const discord = createAuditLogDestinationDiscord({
        user: { id: "bot" },
        channels: {
          fetch: () =>
            Promise.resolve({
              id: "destination",
              type: ChannelType.GuildText,
              guildId: "guild",
              guild: { members: { fetch: () => Promise.reject(apiError(code, status)) } },
            }),
        },
      } as unknown as Client);
      expect(await discord.preflight("guild", "destination")).toEqual({
        ok: false,
        targetId: "destination",
        failure: { failureStage, failureReasonCode },
      });
    },
  );
});
