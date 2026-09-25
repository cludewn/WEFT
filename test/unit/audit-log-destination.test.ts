import { ChannelType, PermissionFlagsBits } from "discord.js";
import type { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";

import { createAuditLogDestinationDiscord } from "../../src/audit-log-destination-discord.js";
import type { AuditLogDestinationStore } from "../../src/audit-log-destination-persistence.js";
import { createAuditLogDestinationService } from "../../src/audit-log-destination.js";

const guildId = "guild";
const channelId = "channel";

function fixture({
  type = ChannelType.GuildText,
  actualGuildId = guildId,
  view = true,
  send = true,
  fetchFails = false,
}: {
  type?: ChannelType;
  actualGuildId?: string;
  view?: boolean;
  send?: boolean;
  fetchFails?: boolean;
} = {}) {
  const fetchMember = vi.fn(() => Promise.resolve({ id: "bot" }));
  const permissionsFor = vi.fn(() => ({
    has: (required: bigint[]) =>
      required.every((permission) =>
        permission === PermissionFlagsBits.ViewChannel
          ? view
          : permission === PermissionFlagsBits.SendMessages
            ? send
            : false,
      ),
  }));
  const fetchChannel = vi.fn(() =>
    fetchFails
      ? Promise.reject(new Error("private Discord failure"))
      : Promise.resolve({
          type,
          guildId: actualGuildId,
          guild: { members: { fetch: fetchMember } },
          permissionsFor,
        }),
  );
  const client = {
    user: { id: "bot" },
    channels: { fetch: fetchChannel },
  } as unknown as Client;
  return {
    discord: createAuditLogDestinationDiscord(client),
    fetchChannel,
    fetchMember,
    permissionsFor,
  };
}

function store(): AuditLogDestinationStore {
  return {
    read: vi.fn(() => Promise.resolve(null)),
    change: vi.fn(() => Promise.resolve({ outcome: "CHANGED", previousChannelId: null } as const)),
  };
}

describe("audit log destination preflight", () => {
  it.each([ChannelType.GuildText, ChannelType.GuildAnnouncement])(
    "accepts supported channel type %s with only ViewChannel and SendMessages",
    async (type) => {
      const current = fixture({ type });
      await expect(current.discord.preflight(guildId, channelId)).resolves.toBe(true);
      expect(current.fetchChannel).toHaveBeenCalledWith(channelId, { force: true });
      expect(current.fetchMember).toHaveBeenCalledWith({ user: "bot", force: true });
      expect(current.permissionsFor).toHaveBeenCalledOnce();
    },
  );

  it.each([ChannelType.GuildForum, ChannelType.GuildVoice, ChannelType.PublicThread])(
    "rejects unsupported channel type %s",
    async (type) => {
      const current = fixture({ type });
      await expect(current.discord.preflight(guildId, channelId)).resolves.toBe(false);
      expect(current.fetchMember).not.toHaveBeenCalled();
    },
  );

  it("rejects wrong guild, missing bot permissions, and fetch failures", async () => {
    for (const options of [
      { actualGuildId: "other" },
      { view: false },
      { send: false },
      { fetchFails: true },
    ]) {
      await expect(fixture(options).discord.preflight(guildId, channelId)).resolves.toBe(false);
    }
  });
});

describe("audit log destination service", () => {
  it("reads without Discord and disables without Discord", async () => {
    const persistence = store();
    const discord = { preflight: vi.fn(() => Promise.resolve(true)) };
    const service = createAuditLogDestinationService(persistence, discord);
    await expect(service.show(guildId)).resolves.toBe(null);
    await expect(service.disable(guildId, "actor")).resolves.toMatchObject({ outcome: "CHANGED" });
    expect(discord.preflight).not.toHaveBeenCalled();
    expect(persistence.read).toHaveBeenCalledWith(guildId);
    expect(persistence.change).toHaveBeenCalledWith(
      expect.objectContaining({ newChannelId: null, actorUserId: "actor" }),
    );
  });

  it("preflights before persistence and rejects failure without a DB mutation", async () => {
    const persistence = store();
    const discord = { preflight: vi.fn(() => Promise.resolve(false)) };
    const service = createAuditLogDestinationService(persistence, discord);
    await expect(service.set(guildId, "actor", channelId)).resolves.toEqual({
      outcome: "VALIDATION_FAILED",
    });
    expect(discord.preflight).toHaveBeenCalledWith(guildId, channelId);
    expect(persistence.change).not.toHaveBeenCalled();
  });
});
