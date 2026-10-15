import {
  createAutomaticClosePersistenceStore as createPolicyStore,
  type EnableAutoCloseParentChannel,
  type TrackAutomaticCloseThread,
} from "../../src/threads/automatic-close-persistence.js";
import { createGuildSettingsStore as createSettingsStore } from "../../src/guild/guild-settings.js";
import { createConfigurationAuditContext } from "../../src/guild/guild-configuration-audit.js";
import type { DatabaseClient } from "../../src/database.js";

// Existing scheduling/activity fixtures need the original setup shape. Every mutation still
// traverses the audited production path; unknown setup results fail the fixture immediately.
export function createGuildSettingsStore(database: DatabaseClient) {
  const store = createSettingsStore(database);
  const unwrap = async (result: ReturnType<typeof store.setTimezone>) => {
    const value = await result;
    if (value.outcome === "UNCONFIRMED") throw new Error("Fixture settings were not confirmed");
    return value.settings;
  };
  return {
    getOrCreate: store.getOrCreate,
    setTimezone: (guildId: string, value: string) =>
      unwrap(store.setTimezone(guildId, value, createConfigurationAuditContext("fixture-actor"))),
    setClosedPrefix: (guildId: string, value: string) =>
      unwrap(
        store.setClosedPrefix(guildId, value, createConfigurationAuditContext("fixture-actor")),
      ),
    setAutoCloseInactivitySeconds: (guildId: string, value: number) =>
      unwrap(
        store.setAutoCloseInactivitySeconds(
          guildId,
          value,
          createConfigurationAuditContext("fixture-actor"),
        ),
      ),
    setAutoCloseBotMessagesCountAsActivity: (guildId: string, value: boolean) =>
      unwrap(
        store.setAutoCloseBotMessagesCountAsActivity(
          guildId,
          value,
          createConfigurationAuditContext("fixture-actor"),
        ),
      ),
  };
}

export function createAutomaticClosePersistenceStore(database: DatabaseClient) {
  const store = createPolicyStore(database);
  const context = () => createConfigurationAuditContext("fixture-actor");
  const changed = async (result: ReturnType<typeof store.removeParentChannel>) => {
    const value = await result;
    if (value.outcome === "UNCONFIRMED") throw new Error("Fixture policy was not confirmed");
    return value.outcome === "CHANGED";
  };
  const track = async (
    input: Omit<TrackAutomaticCloseThread, "actorUserId" | "auditId" | "occurredAt">,
  ) => {
    const result = await store.trackThread({ ...input, ...context() });
    if (result.outcome === "UNCONFIRMED") throw new Error("Fixture tracking was not confirmed");
    return { exclusionRemoved: result.exclusionRemoved, parentEnabled: result.parentEnabled };
  };
  return {
    ...store,
    async enableParentChannelWithBaselines(
      input: Omit<EnableAutoCloseParentChannel, "actorUserId" | "auditId" | "occurredAt">,
    ) {
      const result = await store.enableParentChannelWithBaselines({ ...input, ...context() });
      if (result.outcome === "UNCONFIRMED") throw new Error("Fixture parent was not confirmed");
      return result;
    },
    async addParentChannel(guildId: string, parentChannelId: string) {
      const result = await store.enableParentChannelWithBaselines({
        guildId,
        parentChannelId,
        enabledAt: new Date(),
        activeThreadIds: [],
        ...context(),
      });
      if (result.outcome === "UNCONFIRMED") throw new Error("Fixture parent was not confirmed");
      return result.outcome === "ENABLED";
    },
    removeParentChannel: (guildId: string, parentChannelId: string) =>
      changed(store.removeParentChannel(guildId, parentChannelId, context())),
    addThreadExclusion: (guildId: string, threadId: string) =>
      changed(store.addThreadExclusion(guildId, threadId, context())),
    async removeThreadExclusion(guildId: string, threadId: string) {
      const result = await track({
        guildId,
        threadId,
        parentChannelId: "fixture-disabled-parent",
        trackedAt: new Date(),
      });
      return result.exclusionRemoved;
    },
    trackThread: track,
  };
}
