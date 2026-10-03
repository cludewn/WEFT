import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadTestDatabaseConfig } from "../../src/config.js";
import { createDatabase, type DatabaseClient } from "../../src/database.js";
import { createGuildSettingsStore, guildSettings } from "../../src/guild-settings.js";
import { createLinkPreviewStore, linkPreviewAudits } from "../../src/link-preview-persistence.js";
import type { LinkPreviewMode } from "../../src/link-preview.js";
import { createAuditNotificationProjection } from "../../src/audit-notification-projection.js";
import { publishLinkPreviewChanges } from "../../src/audit-notification-publication.js";
import { formatAuditNotification } from "../../src/audit-notification-format.js";

const database = createDatabase(loadTestDatabaseConfig());
const store = createLinkPreviewStore(database.client);
const ids: string[] = [];
const guild = () => {
  const id = randomUUID();
  ids.push(id);
  return id;
};
const change = (guildId: string, newMode: LinkPreviewMode) => ({
  guildId,
  newMode,
  actorUserId: "actor",
  auditId: randomUUID(),
  occurredAt: new Date(),
});
const rows = (guildId: string) =>
  database.client.select().from(guildSettings).where(eq(guildSettings.guildId, guildId));
const audits = (guildId: string) =>
  database.client.select().from(linkPreviewAudits).where(eq(linkPreviewAudits.guildId, guildId));
beforeAll(async () => {
  await migrate(database.client, { migrationsFolder: "drizzle" });
});
afterAll(async () => {
  if (ids.length) {
    await database.client.delete(linkPreviewAudits).where(inArray(linkPreviewAudits.guildId, ids));
    await database.client.delete(guildSettings).where(inArray(guildSettings.guildId, ids));
  }
  await database.close();
});
describe("link preview persistence", () => {
  it("projects missing rows without creation, defaults new rows and preserves getOrCreate conflicts", async () => {
    const id = guild();
    expect(await store.read(id)).toBe("hybrid");
    expect(await rows(id)).toEqual([]);
    const settings = createGuildSettingsStore(database.client);
    const [a, b] = await Promise.all([settings.getOrCreate(id), settings.getOrCreate(id)]);
    expect(a).toEqual(b);
    expect(a.linkPreviewMode).toBe("hybrid");
    await store.change(change(id, "off"));
    expect((await settings.getOrCreate(id)).linkPreviewMode).toBe("off");
  });
  it("persists guild isolation, reload and exact no-op timestamps/audit", async () => {
    const id = guild();
    const other = guild();
    const input = change(id, "button-only");
    expect(await store.change(input)).toEqual({ outcome: "CHANGED", previousMode: "hybrid" });
    const before = await rows(id);
    expect(await store.change(change(id, "button-only"))).toEqual({ outcome: "NO_CHANGE" });
    expect(await rows(id)).toEqual(before);
    expect(await audits(id)).toHaveLength(1);
    expect(await createLinkPreviewStore(database.client).read(id)).toBe("button-only");
    expect(await store.read(other)).toBe("hybrid");
  });
  it("serializes concurrent first-time and existing setters", async () => {
    const id = guild();
    const outcomes = await Promise.all([
      store.change(change(id, "off")),
      store.change(change(id, "off")),
    ]);
    expect(outcomes.map((r) => r.outcome).sort()).toEqual(["CHANGED", "NO_CHANGE"]);
    const inputs = [change(id, "button-only"), change(id, "public-only")];
    expect(
      (await Promise.all(inputs.map((input) => store.change(input)))).every(
        (r) => r.outcome === "CHANGED",
      ),
    ).toBe(true);
    const history = await audits(id);
    expect(history).toHaveLength(3);
    const transitions = history.filter((r) => r.newMode !== "off");
    expect(transitions.filter((r) => r.previousMode === "off")).toHaveLength(1);
    const final = await store.read(id);
    expect(transitions.some((r) => r.newMode === final && r.previousMode !== "off")).toBe(true);
  });
  it("rolls back mode and timestamp when audit insertion fails", async () => {
    const id = guild();
    const first = change(id, "off");
    await store.change(first);
    const before = await rows(id);
    expect(await store.change({ ...change(id, "public-only"), auditId: first.auditId })).toEqual({
      outcome: "UNCONFIRMED",
    });
    expect(await rows(id)).toEqual(before);
    expect(await audits(id)).toHaveLength(1);
  });
  it("confirms the exact audit after response loss even if a later setter has committed", async () => {
    const id = guild();
    const input = change(id, "off");
    const ambiguous = Object.create(database.client) as DatabaseClient;
    ambiguous.transaction = async (...args: Parameters<DatabaseClient["transaction"]>) => {
      await database.client.transaction(...args);
      await store.change(change(id, "public-only"));
      throw new Error("response lost");
    };
    expect(await createLinkPreviewStore(ambiguous).change(input)).toEqual({
      outcome: "CHANGED",
      previousMode: "hybrid",
    });
    expect(await store.read(id)).toBe("public-only");
  });
  it("enforces mode, transition, null and outcome constraints", async () => {
    const id = guild();
    await database.client.insert(guildSettings).values({ guildId: id });
    for (const mode of [null, "invalid"])
      await expect(
        database.client.execute(
          sql`update guild_settings set link_preview_mode = ${mode} where guild_id = ${id}`,
        ),
      ).rejects.toThrow();
    for (const [previous, next, outcome] of [
      ["hybrid", "hybrid", "SUCCESS"],
      ["invalid", "off", "SUCCESS"],
      ["hybrid", "invalid", "SUCCESS"],
      [null, "off", "SUCCESS"],
      ["hybrid", null, "SUCCESS"],
      ["hybrid", "off", "FAILURE"],
    ]) {
      await expect(
        database.client.execute(
          sql`insert into link_preview_audits (id, guild_id, actor_user_id, previous_mode, new_mode, occurred_at, outcome) values (${randomUUID()}, ${id}, 'actor', ${previous}, ${next}, now(), ${outcome})`,
        ),
      ).rejects.toThrow();
    }
  });
  it("publishes only committed changes and projects bounded mode metadata", async () => {
    const id = guild();
    const publish = vi.fn();
    const wrapped = publishLinkPreviewChanges(database.client, { publish }, store);
    const input = change(id, "off");
    await wrapped.change(input);
    await wrapped.change(change(id, "off"));
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      source: "LINK_PREVIEW",
      auditId: input.auditId,
    });
    const record = await createAuditNotificationProjection(database.client).load({
      source: "LINK_PREVIEW",
      auditId: input.auditId,
    });
    expect(record).toMatchObject({
      previousMode: "hybrid",
      newMode: "off",
      actorType: "USER",
      event: "MODE_CHANGED",
    });
    expect(formatAuditNotification(record!)?.content).toContain("New mode: `off`");
  });
});
